// meshToObj (#239) against AssetStudio's own OBJ export: the golden of each
// fixture Mesh is the size and sha256 of the file AssetStudio c37af7d's
// `Exporter.ExportMesh` wrote for it (fixtures/assetstudio-export-goldens.json,
// #233, R12). The other tests take a fixture mesh and change what upstream's
// export branches on; their expected text is worked out here from
// `ExportMesh`.

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

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { meshToObj } from "../src/index.js";

interface ExportEntry {
  class: string;
  obj?: { size: number; sha256: string };
  exportError?: string;
  /** AssetStudio's OBJ of a Mesh with a submesh baseVertex, no golden (#257). */
  objWithoutBaseVertex?: { size: number; sha256: string };
}

const GOLDENS = new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url);
const goldens = JSON.parse(readFileSync(GOLDENS, "utf8")) as { fixtures: Record<string, Record<string, Record<string, ExportEntry>>> };

/** Every fixture Mesh: fixture, file, path ID, export entry. */
const ALL = Object.entries(goldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Mesh")
      .map(([pathId, entry]) => ({ fixture, file, pathId: BigInt(pathId), entry })),
  ),
);
/** Every Mesh with an OBJ golden. */
const MESHES = ALL.filter(({ entry }) => entry.obj).map((m) => ({ ...m, obj: m.entry.obj! }));

/** The fixture Mesh as `obj.read()` decodes it. */
function readMesh(fixture: string, file: string, pathId: bigint): MeshData {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const reader = env.objects.find((o) => o.fileName === file && o.pathId === pathId);
  assert.ok(reader, `${fixture}: no object ${pathId} in ${file}`);
  assert.equal(reader.type, ClassID.Mesh);
  return reader.read<MeshData>();
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

test("the export goldens have an OBJ for 21 of the 27 fixture Meshes", () => {
  // Each main bundle's triangle, detail and compressed (fixtures/BUILDING.md
  // section 20); the six basevertex meshes have none (#257).
  assert.equal(ALL.length, 27);
  assert.equal(MESHES.length, 21);
  const without = ALL.filter(({ entry }) => !entry.obj);
  assert.equal(without.length, 6);
  for (const { entry } of without) {
    assert.match(entry.exportError!, /^not exported: ExportMesh leaves out the submesh's baseVertex 3/);
  }
});

for (const { fixture, file, pathId, obj } of MESHES) {
  test(`${fixture} Mesh ${pathId}: meshToObj is byte-identical to AssetStudio's OBJ`, () => {
    const bytes = encode(meshToObj(readMesh(fixture, file, pathId)));
    assert.equal(bytes.length, obj.size);
    assert.equal(sha256(bytes), obj.sha256);
  });
}

test("detail's OBJ golden has vt, vn, scientific and fractional floats, two groups (#253)", () => {
  const detail = MESHES.filter(({ fixture, file, pathId }) => {
    return readMesh(fixture, file, pathId).m_Name === "detail";
  });
  assert.equal(detail.length, 6);
  for (const { fixture, file, pathId } of detail) {
    // Byte for byte AssetStudio's OBJ, by the test above.
    const text = meshToObj(readMesh(fixture, file, pathId));
    const lines = text.split("\r\n");
    assert.equal(lines.filter((l) => l.startsWith("vt ")).length, 8, fixture);
    assert.equal(lines.filter((l) => l.startsWith("vn ")).length, 8, fixture);
    assert.match(text, /^v \S+ [0-9.]+E\+\d+ /m, fixture);
    assert.match(text, /^v \S+ [0-9.]+E-\d+ /m, fixture);
    assert.match(text, /^v \S+ 0\.5 0\.25\r$/m, fixture);
    assert.deepEqual(
      lines.filter((l) => l.startsWith("g detail_")),
      ["g detail_0", "g detail_1"],
      fixture,
    );
  }
});

/** The fixture Meshes with a submesh baseVertex (#257): no OBJ golden. */
const OFFSET = ALL.filter(({ entry }) => entry.objWithoutBaseVertex);

test("basevertex's OBJ draws its triangle on vertices 3 to 5 (#257)", () => {
  assert.equal(OFFSET.length, 6);
  for (const { fixture, file, pathId } of OFFSET) {
    const text = meshToObj(readMesh(fixture, file, pathId));
    // 1-based, the winding reversed: indices 3, 4, 5.
    assert.deepEqual(
      text.split("\r\n").filter((l) => l.startsWith("f ")),
      ["f 6/6/6 5/5/5 4/4/4"],
      fixture,
    );
  }
});

test("AssetStudio's OBJ of basevertex differs from meshToObj's by the baseVertex alone", () => {
  // ExportMesh writes the indices without the offset, so its faces use
  // vertices 0 to 2: the same text as the mesh with its offset taken off.
  for (const { fixture, file, pathId, entry } of OFFSET) {
    const mesh = readMesh(fixture, file, pathId);
    const indices = mesh.indices.map((triangles, i) =>
      triangles.map((index) => index - mesh.m_SubMeshes[i]!.baseVertex!),
    );
    const bytes = encode(meshToObj({ ...mesh, indices }));
    assert.equal(bytes.length, entry.objWithoutBaseVertex!.size, fixture);
    assert.equal(sha256(bytes), entry.objWithoutBaseVertex!.sha256, fixture);
  }
});

/** One fixture mesh to change. */
const BASE = (() => {
  const fixture = "editor/2020.3.30f1/lz4/main";
  const { file, pathId } = MESHES.find((m) => m.fixture === fixture)!;
  return readMesh(fixture, file, pathId);
})();
const lines = (text: string): string[] => {
  assert.ok(text.endsWith("\r\n"), "the last line ends with \\r\\n");
  return text.slice(0, -2).split("\r\n");
};
const subMesh = (topology: number, indexCount: number): SubMesh => ({
  ...BASE.m_SubMeshes[0]!,
  topology,
  indexCount,
});

test("the fixture mesh is one triangle with positions only", () => {
  assert.equal(BASE.vertexCount, 3);
  assert.equal(BASE.normals, undefined);
  assert.equal(BASE.uv[0], undefined);
  assert.deepEqual(lines(meshToObj(BASE)).map((line) => line.split(" ")[0]), [
    "g", "v", "v", "v", "g", "f",
  ]);
});

test("positions and normals have x negated, UV0 gives vt, faces reverse their winding", () => {
  const text = meshToObj({
    ...BASE,
    m_Name: "quad",
    vertexCount: 2,
    vertices: Float32Array.of(0, 1, -2.5, 1e-5, 0.1, 3),
    uv: [Float32Array.of(0.25, 0.75, 1, 0)],
    normals: Float32Array.of(-1, 0, 0, 0.5, 0.5, -0),
    m_SubMeshes: [subMesh(GfxPrimitiveType.Triangles, 3)],
    indices: [Uint32Array.of(0, 1, 2)],
  });
  assert.deepEqual(lines(text), [
    "g quad",
    "v -0 1 -2.5",
    "v -1E-05 0.1 3",
    "vt 0.25 0.75",
    "vt 1 0",
    "vn 1 0 0",
    "vn -0.5 0.5 -0",
    "g quad_0",
    "f 3/3/3 2/2/2 1/1/1",
  ]);
});

test("4 floats per position and 3 per UV are stepped over; normals keep the UV's step", () => {
  const text = meshToObj({
    ...BASE,
    vertexCount: 2,
    vertices: Float32Array.of(1, 2, 3, 9, 4, 5, 6, 9),
    uv: [Float32Array.of(1, 2, 9, 3, 4, 9)],
    // Neither 3 nor 4 per vertex: upstream keeps the UV's 3.
    normals: Float32Array.of(1, 2, 3, 4, 5, 6, 7),
    m_SubMeshes: [],
    indices: [],
  });
  assert.deepEqual(lines(text), [
    "g tri",
    "v -1 2 3",
    "v -4 5 6",
    "vt 1 2",
    "vt 3 4",
    "vn -1 2 3",
    "vn -4 5 6",
  ]);
});

test("every NaN in the text becomes 0, in the name too", () => {
  const text = meshToObj({
    ...BASE,
    m_Name: "NaNo",
    vertexCount: 1,
    vertices: Float32Array.of(NaN, 1, Infinity),
    m_SubMeshes: [],
    indices: [],
  });
  assert.deepEqual(lines(text), ["g 0o", "v 0 1 ∞"]);
});

test("each submesh takes indexCount / 3 faces of all submeshes' triangles in turn", () => {
  const text = meshToObj({
    ...BASE,
    m_SubMeshes: [
      // 4 indices: 2 triangles decoded, 1 face taken; the next submesh starts at the 2nd.
      subMesh(GfxPrimitiveType.Triangles, 4),
      // A strip takes the triangles it kept: 1 here.
      subMesh(GfxPrimitiveType.TriangleStrip, 5),
      // Quads take indexCount / 2 * 3 indices: 2 faces for 4.
      subMesh(GfxPrimitiveType.Quads, 4),
    ],
    indices: [
      Uint32Array.of(0, 1, 2, 2, 1, 0),
      Uint32Array.of(1, 2, 0),
      Uint32Array.of(0, 0, 1, 0, 1, 2),
    ],
  });
  assert.deepEqual(lines(text).slice(4), [
    "g tri_0",
    "f 3/3/3 2/2/2 1/1/1",
    "g tri_1",
    "f 1/1/1 2/2/2 3/3/3",
    "g tri_2",
    "f 1/1/1 3/3/3 2/2/2",
    "f 2/2/2 1/1/1 1/1/1",
  ]);
});

test("a mesh without vertices or positions has no OBJ (UnsupportedError)", () => {
  for (const mesh of [
    { ...BASE, vertexCount: 0 },
    { ...BASE, vertices: undefined },
    { ...BASE, vertices: new Float32Array(0) },
  ]) {
    assert.throws(() => meshToObj(mesh), (error: unknown) =>
      error instanceof UnsupportedError && error.message.includes('Mesh "tri"'));
  }
});

test("an attribute too short for the vertex count is refused, not written as garbage", () => {
  const cases: [MeshData, string][] = [
    [{ ...BASE, vertices: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8) }, "position"],
    [{ ...BASE, uv: [Float32Array.of(1, 2, 3, 4, 5)] }, "UV0"],
    [{ ...BASE, normals: Float32Array.of(1, 2, 3, 4, 5) }, "normal"],
  ];
  for (const [mesh, what] of cases) {
    assert.throws(() => meshToObj(mesh), (error: unknown) =>
      error instanceof UnsupportedError && error.kind === `${what} layout`);
  }
});

test("index counts past the decoded triangles are refused (CorruptError)", () => {
  const mesh = { ...BASE, m_SubMeshes: [subMesh(GfxPrimitiveType.Triangles, 6)] };
  assert.throws(() => meshToObj(mesh), (error: unknown) =>
    error instanceof CorruptError && error.message.includes("submesh 0: faces 0 to 2"));
});
