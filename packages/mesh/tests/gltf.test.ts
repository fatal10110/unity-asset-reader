// meshToGltf (#240). Nothing upstream writes glTF (AssetStudio exports FBX),
// so there is no golden: the Khronos glTF validator checks the structure, and
// the geometry is compared with meshToObj's (#239), which is AssetStudio's
// OBJ byte for byte. The .glb is read back here with a reader written from the
// glTF 2.0 spec, not from the writer. The fixture meshes are one triangle
// each, so most of the format is exercised on meshes built here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ClassID,
  CorruptError,
  GfxPrimitiveType,
  load,
  UnsupportedError,
  type MeshData,
  type SubMesh,
} from "unity-asset-reader";
import * as gltfValidator from "gltf-validator";

import { loadFixture } from "../../../fixtures/helpers.js";
import { meshToGltf, meshToObj } from "../src/index.js";

// --- the validator ------------------------------------------------------------------

/** The part of the validator's report the tests read (it ships no types). */
interface Report {
  issues: {
    numErrors: number;
    numWarnings: number;
    messages: { code: string; message: string; severity: number; pointer?: string }[];
  };
}
const validator = gltfValidator as unknown as {
  validateBytes(data: Uint8Array, options: object): Promise<Report>;
};

/** Validate a .glb; fail with the validator's messages on any error or warning. */
async function assertValid(glb: Uint8Array): Promise<void> {
  const report = await validator.validateBytes(glb, {
    format: "glb",
    writeTimestamp: false,
    maxIssues: 0,
  });
  const { numErrors, numWarnings, messages } = report.issues;
  assert.deepEqual(
    { numErrors, numWarnings },
    { numErrors: 0, numWarnings: 0 },
    JSON.stringify(messages, null, 2),
  );
}

// --- reading the .glb back (glTF 2.0 spec: GLB container, accessors) ------------------

interface Gltf {
  asset: { version: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: { name: string; mesh: number }[];
  meshes: {
    name: string;
    primitives: { attributes: Record<string, number>; indices: number; mode?: number }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[];
  buffers: { byteLength: number; uri?: string }[];
}

/** The JSON and binary chunks of a .glb, checking its header and chunk layout. */
function readGlb(bytes: Uint8Array): { json: Gltf; bin: DataView; jsonBytes: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, "magic glTF");
  assert.equal(view.getUint32(4, true), 2, "container version 2");
  assert.equal(view.getUint32(8, true), bytes.length, "length in the header");
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, "first chunk JSON");
  assert.equal(jsonLength % 4, 0, "JSON chunk 4-aligned");
  const jsonBytes = bytes.subarray(20, 20 + jsonLength);
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  assert.equal(view.getUint32(binAt + 4, true), 0x004e4942, "second chunk BIN");
  assert.equal(binAt + 8 + binLength, bytes.length, "BIN chunk runs to the end");
  const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as Gltf;
  assert.equal(json.buffers[0]!.byteLength, binLength);
  return {
    json,
    bin: new DataView(bytes.buffer, bytes.byteOffset + binAt + 8, binLength),
    jsonBytes,
  };
}

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Every component of an accessor, as numbers. */
function accessor(doc: { json: Gltf; bin: DataView }, index: number): number[] {
  const a = doc.json.accessors[index]!;
  const bufferView = doc.json.bufferViews[a.bufferView]!;
  const start = (bufferView.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const size = { 5126: 4, 5125: 4, 5123: 2 }[a.componentType]!;
  const out: number[] = [];
  for (let i = 0; i < a.count * WIDTH[a.type]!; i++) {
    const at = start + i * size;
    if (a.componentType === 5126) out.push(doc.bin.getFloat32(at, true));
    else if (a.componentType === 5125) out.push(doc.bin.getUint32(at, true));
    else out.push(doc.bin.getUint16(at, true));
  }
  return out;
}

/** A primitive attribute's components, or `undefined` when it has none. */
function attribute(doc: { json: Gltf; bin: DataView }, key: string): number[] | undefined {
  const index = doc.json.meshes[0]!.primitives[0]!.attributes[key];
  return index === undefined ? undefined : accessor(doc, index);
}

/** float32 bit patterns, so -0 and 0 differ and no rounding hides a difference. */
function bits(values: number[]): number[] {
  return Array.from(new Uint32Array(Float32Array.from(values).buffer));
}

// --- reading the OBJ back -------------------------------------------------------------

interface Obj {
  v: number[];
  vt: number[];
  vn: number[];
  /** Per `g <name>_<i>` group, its faces' vertices, 0-based, in file order. */
  groups: number[][];
}

/** The vertices and faces of meshToObj's text. */
function readObj(text: string): Obj {
  const obj: Obj = { v: [], vt: [], vn: [], groups: [] };
  const lines = text.split("\r\n").slice(1, -1); // the mesh's `g` line, the final empty one
  for (const line of lines) {
    const [kind, ...rest] = line.split(" ");
    if (kind === "v" || kind === "vt" || kind === "vn") {
      // The OBJ writes the shortest text that reads back as the float32.
      obj[kind].push(...rest.map((r) => Math.fround(Number(r))));
    } else if (kind === "g") obj.groups.push([]);
    else if (kind === "f") obj.groups.at(-1)!.push(...rest.map((r) => Number(r.split("/")[0]) - 1));
    else assert.fail(`unexpected OBJ line ${line}`);
  }
  return obj;
}

/**
 * The glTF holds what the OBJ holds: positions and normals bit for bit (both
 * negate x), UV u as is and v as `1 - v` (glTF's origin is top left), and per
 * submesh with faces, the OBJ's faces as the primitive's indices (both reverse
 * the winding). With `normals: false`, the OBJ has normals the glTF left out.
 */
function assertSameAsObj(mesh: MeshData, { normals = true } = {}): void {
  const doc = readGlb(meshToGltf(mesh));
  const obj = readObj(meshToObj(mesh));
  assert.deepEqual(bits(attribute(doc, "POSITION")!), bits(obj.v), "positions");
  if (normals) {
    assert.deepEqual(bits(attribute(doc, "NORMAL") ?? []), bits(obj.vn), "normals");
  } else {
    assert.equal(attribute(doc, "NORMAL"), undefined, "NORMAL left out");
    assert.ok(obj.vn.length > 0, "the OBJ has normals");
  }
  const uv = attribute(doc, "TEXCOORD_0") ?? [];
  const objUv = obj.vt.map((value, i) => (i % 2 === 1 ? Math.fround(1 - value) : value));
  assert.deepEqual(bits(uv), bits(objUv), "UV0, v flipped");
  const primitives = doc.json.meshes[0]!.primitives;
  assert.deepEqual(
    primitives.map((p) => accessor(doc, p.indices)),
    obj.groups.filter((faces) => faces.length > 0),
    "indices",
  );
}

// --- fixtures -------------------------------------------------------------------------

interface ExportEntry {
  class: string;
}
const GOLDENS = new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url);
const goldens = JSON.parse(readFileSync(GOLDENS, "utf8")) as {
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
};

/** Every fixture Mesh: fixture, file, path ID. */
const MESHES = Object.entries(goldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Mesh")
      .map(([pathId]) => ({ fixture, file, pathId: BigInt(pathId) })),
  ),
);

/** The fixture Mesh as `obj.read()` decodes it. */
function readMesh(fixture: string, file: string, pathId: bigint): MeshData {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const reader = env.objects.find((o) => o.fileName === file && o.pathId === pathId);
  assert.ok(reader, `${fixture}: no object ${pathId} in ${file}`);
  assert.equal(reader.type, ClassID.Mesh);
  return reader.read<MeshData>();
}

test("there are 12 fixture Meshes", () => {
  assert.equal(MESHES.length, 12);
});

for (const { fixture, file, pathId } of MESHES) {
  test(`${fixture} Mesh ${pathId}: the glTF validator accepts its .glb`, async () => {
    await assertValid(meshToGltf(readMesh(fixture, file, pathId)));
  });

  test(`${fixture} Mesh ${pathId}: its vertices and indices are the OBJ's`, () => {
    assertSameAsObj(readMesh(fixture, file, pathId));
  });
}

// --- meshes built here ----------------------------------------------------------------

/** One fixture mesh to build on (its name is "tri"). */
const BASE = (() => {
  const fixture = "editor/2020.3.30f1/lz4/main";
  const { file, pathId } = MESHES.find((m) => m.fixture === fixture)!;
  return readMesh(fixture, file, pathId);
})();
const subMesh = (topology: number, indexCount: number): SubMesh => ({
  ...BASE.m_SubMeshes[0]!,
  topology,
  indexCount,
});

const S = Math.SQRT1_2;
/**
 * Four vertices with every attribute meshToGltf writes, and three submeshes:
 * a triangle, an empty one, and a quad (as `obj.read()` gives one: two
 * triangles). Normals and tangents are unit length, tangent w is ±1.
 */
const FULL: MeshData = {
  ...BASE,
  m_Name: "full",
  vertexCount: 4,
  vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0.5, -0.25, 1, 2),
  normals: Float32Array.of(0, 0, -1, 0, 0, -1, S, 0, -S, -S, S, 0),
  tangents: Float32Array.of(1, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0, 1, S, 0, S, -1),
  colors: Float32Array.of(1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 0, 0.25, 0.5, 0.75, 1),
  uv: [Float32Array.of(0, 0, 1, 0, 1, 1, 0.1, 0.9), undefined, undefined],
  m_IndexFormat: 0,
  m_SubMeshes: [
    subMesh(GfxPrimitiveType.Triangles, 3),
    subMesh(GfxPrimitiveType.Triangles, 0),
    subMesh(GfxPrimitiveType.Quads, 4),
  ],
  indices: [Uint32Array.of(0, 1, 2), new Uint32Array(0), Uint32Array.of(0, 1, 2, 0, 2, 3)],
};

test("a mesh with normals, tangents, colours, UV0 and submeshes passes the validator", async () => {
  await assertValid(meshToGltf(FULL));
});

test("its vertices and indices are the OBJ's", () => {
  assertSameAsObj(FULL);
});

test("one scene, one node and one mesh, named after the Mesh; a primitive per submesh", () => {
  const { json } = readGlb(meshToGltf(FULL));
  assert.equal(json.asset.version, "2.0");
  assert.deepEqual(json.scenes, [{ nodes: [0] }]);
  assert.equal(json.scene, 0);
  assert.deepEqual(json.nodes, [{ name: "full", mesh: 0 }]);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0]!.name, "full");
  // The empty submesh has no primitive; the others are triangle lists (mode 4, the default).
  const primitives = json.meshes[0]!.primitives;
  assert.equal(primitives.length, 2);
  for (const p of primitives) {
    assert.equal(p.mode, undefined);
    assert.deepEqual(Object.keys(p.attributes), [
      "POSITION",
      "NORMAL",
      "TANGENT",
      "TEXCOORD_0",
      "COLOR_0",
    ]);
  }
  assert.deepEqual(primitives[0]!.attributes, primitives[1]!.attributes, "shared vertices");
  assert.equal(json.buffers.length, 1);
  assert.equal(json.buffers[0]!.uri, undefined, "the buffer is the GLB's own BIN chunk");
});

test("x of positions, normals and tangents is negated; tangent w too; UV v is 1 - v", () => {
  const doc = readGlb(meshToGltf(FULL));
  const types = Object.fromEntries(
    Object.entries(doc.json.meshes[0]!.primitives[0]!.attributes).map(([key, index]) => {
      const a = doc.json.accessors[index]!;
      return [key, `${a.type} ${a.componentType} ${a.count}`];
    }),
  );
  assert.deepEqual(types, {
    POSITION: "VEC3 5126 4",
    NORMAL: "VEC3 5126 4",
    TANGENT: "VEC4 5126 4",
    TEXCOORD_0: "VEC2 5126 4",
    COLOR_0: "VEC4 5126 4",
  });
  const f = (values: number[]) => bits(values);
  assert.deepEqual(f(attribute(doc, "POSITION")!), f([-0, 0, 0, -1, 0, 0, -1, 1, 0.5, 0.25, 1, 2]));
  assert.deepEqual(f(attribute(doc, "NORMAL")!), f([-0, 0, -1, -0, 0, -1, -S, 0, -S, S, S, 0]));
  assert.deepEqual(
    f(attribute(doc, "TANGENT")!),
    f([-1, 0, 0, -1, -1, 0, 0, 1, -0, 1, 0, -1, -S, 0, S, 1]),
  );
  const flipped = Math.fround(1 - Math.fround(0.9));
  assert.deepEqual(f(attribute(doc, "TEXCOORD_0")!), f([0, 1, 1, 1, 1, 0, 0.1, flipped]));
  assert.deepEqual(f(attribute(doc, "COLOR_0")!), f(Array.from(FULL.colors!)));
});

test("POSITION carries its bounds", () => {
  const { json } = readGlb(meshToGltf(FULL));
  const position = json.accessors[json.meshes[0]!.primitives[0]!.attributes.POSITION!]!;
  assert.deepEqual(position.min, [-1, 0, 0]);
  assert.deepEqual(position.max, [0.25, 1, 2]);
});

test("each triangle's winding is reversed; 16-bit indices stay 16-bit", () => {
  const doc = readGlb(meshToGltf(FULL));
  const [first, quad] = doc.json.meshes[0]!.primitives.map((p) => p.indices);
  assert.equal(doc.json.accessors[first!]!.componentType, 5123);
  assert.deepEqual(accessor(doc, first!), [2, 1, 0]);
  assert.deepEqual(accessor(doc, quad!), [2, 1, 0, 3, 2, 0]);
  for (const view of doc.json.bufferViews) {
    assert.equal(view.byteOffset! % 4, 0, "every buffer view 4-aligned");
  }
  assert.deepEqual(
    doc.json.bufferViews.map((view) => view.target),
    [34962, 34962, 34962, 34962, 34962, 34963, 34963],
  );
});

test("32-bit indices stay 32-bit, and pass the validator", async () => {
  const mesh = { ...FULL, m_IndexFormat: 1 };
  const glb = meshToGltf(mesh);
  await assertValid(glb);
  const doc = readGlb(glb);
  for (const p of doc.json.meshes[0]!.primitives) {
    assert.equal(doc.json.accessors[p.indices]!.componentType, 5125);
  }
  assertSameAsObj(mesh);
});

/** A 16-bit mesh of `count` distinct vertices and one triangle (0, 1, `last`). */
function wideMesh(count: number, last: number): MeshData {
  const vertices = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) vertices.set([v % 256, Math.floor(v / 256), v % 3], v * 3);
  return {
    ...BASE,
    vertexCount: count,
    vertices,
    m_IndexFormat: 0,
    m_SubMeshes: [subMesh(GfxPrimitiveType.Triangles, 3)],
    indices: [Uint32Array.of(0, 1, last)],
  };
}

for (const [what, count, last] of [
  ["65535, glTF's primitive restart value,", 65536, 65535],
  ["70000, past 16 bits (a hand-built MeshData),", 70001, 70000],
] as const) {
  test(`16-bit indices with ${what} are written 32-bit`, async () => {
    const mesh = wideMesh(count, last);
    const glb = meshToGltf(mesh);
    await assertValid(glb);
    const doc = readGlb(glb);
    const indices = doc.json.meshes[0]!.primitives[0]!.indices;
    assert.equal(doc.json.accessors[indices]!.componentType, 5125);
    assert.deepEqual(accessor(doc, indices), [last, 1, 0]);
    assertSameAsObj(mesh);
  });
}

test("4 floats per position and normal, 3 per UV and colour: glTF takes its part", async () => {
  const mesh: MeshData = {
    ...BASE,
    vertexCount: 3,
    vertices: Float32Array.of(1, 2, 3, 9, 4, 5, 6, 9, 7, 8, 0, 9),
    normals: Float32Array.of(1, 0, 0, 9, 0, 1, 0, 9, 0, 0, 1, 9),
    uv: [Float32Array.of(0.5, 0.25, 9, 0, 1, 9, 1, 0, 9)],
    colors: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
  };
  const glb = meshToGltf(mesh);
  await assertValid(glb);
  const doc = readGlb(glb);
  assert.deepEqual(attribute(doc, "POSITION"), [-1, 2, 3, -4, 5, 6, -7, 8, 0]);
  assert.deepEqual(attribute(doc, "NORMAL"), [-1, 0, 0, -0, 1, 0, -0, 0, 1]);
  assert.deepEqual(attribute(doc, "TEXCOORD_0"), [0.5, 0.75, 0, 0, 1, 1]);
  const color = doc.json.meshes[0]!.primitives[0]!.attributes.COLOR_0!;
  assert.equal(doc.json.accessors[color]!.type, "VEC3");
  assert.deepEqual(attribute(doc, "COLOR_0"), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assertSameAsObj(mesh);
});

test("the GLB: JSON chunk padded with spaces, a name in UTF-8", () => {
  const { json, jsonBytes } = readGlb(meshToGltf({ ...FULL, m_Name: "メッシュ \"1\"" }));
  assert.equal(json.meshes[0]!.name, "メッシュ \"1\"");
  assert.equal(json.nodes[0]!.name, "メッシュ \"1\"");
  const text = new TextDecoder().decode(jsonBytes);
  assert.equal(text, JSON.stringify(json) + " ".repeat(text.length - JSON.stringify(json).length));
});

// --- values glTF forbids: the attribute left out --------------------------------------

/** FULL with vertex 1's value of one attribute replaced. */
function withVertex(key: "normals" | "tangents" | "colors", values: number[]): MeshData {
  const data = FULL[key]!.slice();
  data.set(values, data.length / FULL.vertexCount); // vertex 1 starts one stride in
  return { ...FULL, [key]: data };
}

/** The attribute semantics of the .glb's primitives, after validating it. */
async function writtenAttributes(mesh: MeshData): Promise<string[]> {
  const glb = meshToGltf(mesh);
  await assertValid(glb);
  const primitives = readGlb(glb).json.meshes[0]!.primitives;
  for (const p of primitives) assert.deepEqual(p.attributes, primitives[0]!.attributes);
  return Object.keys(primitives[0]!.attributes);
}

test("a zero or non-unit normal leaves NORMAL out, and TANGENT with it", async () => {
  // The validator's tolerance is 0.00674 on the length.
  for (const normal of [[0, 0, 0], [0, 0, 0.993], [0, 0, 1.007], [0.5, 0.5, 0]]) {
    const mesh = withVertex("normals", normal);
    const written = await writtenAttributes(mesh);
    assert.deepEqual(written, ["POSITION", "TEXCOORD_0", "COLOR_0"], `${normal}`);
    assertSameAsObj(mesh, { normals: false });
  }
});

test("a normal within 0.00674 of unit length is kept as it is", async () => {
  for (const normal of [[0, 0, 0.994], [0, 0, -1.006]]) {
    const mesh = withVertex("normals", normal);
    assert.deepEqual(
      await writtenAttributes(mesh),
      ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "COLOR_0"],
      `${normal}`,
    );
    assertSameAsObj(mesh);
  }
});

test("a tangent of w 0, of zero or non-unit xyz leaves TANGENT out", async () => {
  for (const tangent of [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1], [0.5, 0, 0, 1], [1, 0, 0, 2]]) {
    const mesh = withVertex("tangents", tangent);
    assert.deepEqual(
      await writtenAttributes(mesh),
      ["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0"],
      `${tangent}`,
    );
    assertSameAsObj(mesh);
  }
});

test("tangents without normals are left out", async () => {
  const mesh = { ...FULL, normals: undefined };
  assert.deepEqual(await writtenAttributes(mesh), ["POSITION", "TEXCOORD_0", "COLOR_0"]);
  assertSameAsObj(mesh);
});

test("a colour component outside 0 to 1 leaves COLOR_0 out", async () => {
  for (const color of [[2, 0, 0, 1], [0, -0.5, 0, 1], [0, 0, 0, 1.001]]) {
    const mesh = withVertex("colors", color);
    assert.deepEqual(
      await writtenAttributes(mesh),
      ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0"],
      `${color}`,
    );
    assertSameAsObj(mesh);
  }
});

// --- refused meshes -------------------------------------------------------------------

/** `fn` throws `type` whose message contains `text`. */
function assertThrows(
  fn: () => unknown,
  type: new (...args: never[]) => Error,
  text: string,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof type, `${String(error)} is not a ${type.name}`);
    assert.ok(error.message.includes(text), `"${error.message}" lacks "${text}"`);
    return true;
  });
}

test("a mesh without vertices, positions or triangles has no glTF (UnsupportedError)", () => {
  assertThrows(() => meshToGltf({ ...FULL, vertexCount: 0 }), UnsupportedError, "0 vertices");
  assertThrows(
    () => meshToGltf({ ...FULL, vertices: undefined }),
    UnsupportedError,
    "no positions",
  );
  assertThrows(
    () => meshToGltf({ ...FULL, vertices: new Float32Array(0) }),
    UnsupportedError,
    "no positions",
  );
  assertThrows(
    () => meshToGltf({ ...FULL, indices: [new Uint32Array(0)] }),
    UnsupportedError,
    'no triangles (Mesh "full"',
  );
});

test("an attribute of a size glTF cannot take is refused, not written as garbage", () => {
  const cases: [Partial<MeshData>, string][] = [
    [{ vertices: new Float32Array(4 * 5) }, "position"],
    [{ vertices: new Float32Array(4 * 3 - 1) }, "position"],
    [{ normals: new Float32Array(4 * 2) }, "normal"],
    [{ tangents: new Float32Array(4 * 3) }, "tangent"],
    [{ uv: [new Float32Array(4)] }, "UV0"],
    [{ colors: new Float32Array(4 * 2) }, "color"],
  ];
  for (const [change, what] of cases) {
    assert.throws(() => meshToGltf({ ...FULL, ...change }), (error: unknown) =>
      error instanceof UnsupportedError && error.kind === `${what} layout`);
  }
});

test("NaN and infinite values are refused: glTF holds finite floats only", () => {
  const normals = FULL.normals!.slice();
  normals[4] = NaN;
  assert.throws(() => meshToGltf({ ...FULL, normals }), (error: unknown) =>
    error instanceof UnsupportedError && error.kind === "normal value" && error.found === "NaN" &&
    error.message.includes("vertex 1"));
  const vertices = FULL.vertices!.slice();
  vertices[0] = -Infinity;
  assert.throws(() => meshToGltf({ ...FULL, vertices }), (error: unknown) =>
    error instanceof UnsupportedError && error.kind === "position value" &&
    error.found === "-Infinity");
});

test("an index past the vertices, or a partial triangle, is refused (CorruptError)", () => {
  assertThrows(
    () => meshToGltf({ ...FULL, indices: [Uint32Array.of(0, 1, 4)] }),
    CorruptError,
    'Mesh "full" submesh 0: index 2 is 4, past the 4 vertices',
  );
  assertThrows(
    () => meshToGltf({ ...FULL, indices: [Uint32Array.of(0, 1, 2), Uint32Array.of(0, 1)] }),
    CorruptError,
    "submesh 1: 2 indices are not whole triangles",
  );
});
