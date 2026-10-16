// Mesh (#235): the hardcoded reader against readTypeTree() on the 12 fixture
// Mesh objects and on hand-built layouts at every version gate of Unity's
// type trees, read through those trees themselves (`fixtures/tpk-trees.json`,
// UnityPy's TPK data), and the decoding of upstream's `ProcessData` on
// hand-built meshes, whose expected values are worked out here from
// AssetStudio's formulas. The decoded vertices and indices are checked against
// AssetStudio itself through the OBJ goldens of #239.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { golden, loadFixture, type GoldenNode } from "../../../fixtures/helpers.js";
import { toMeshFields } from "../src/classes/fields.js";
import { readMesh, type Mesh, type MeshData } from "../src/classes/Mesh.js";
import { atLeast } from "../src/classes/version.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import type { TypeTreeNode } from "../src/serialized/TypeTree.js";
import { fixturesWith, objectBytes, typedTwin } from "./class-readers.js";
import { build, readerOf, template, versionRefusal, withTail, type Writer } from "./media.js";

const f = Math.fround;
const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);
/** The one Mesh of an env. */
const meshOf = (env: Env): ObjectReader => env.objects.find((o) => o.type === ClassID.Mesh)!;

/** The type tree's value with `m_StreamData.offset` a number, as the reader gives it. */
function withNumberOffset(tree: Record<string, unknown>): Record<string, unknown> {
  const stream = tree.m_StreamData as { offset: bigint | number } | undefined;
  if (!stream) return tree;
  return { ...tree, m_StreamData: { ...stream, offset: Number(stream.offset) } };
}

// --- the 12 fixture Meshes ------------------------------------------------------------

const FIXTURES = fixturesWith(ClassID.Mesh);

test("the fixtures hold 12 Meshes: 2019.4, 2020.3 and 6000.3, typed and not", () => {
  const count = FIXTURES.flatMap((name) =>
    Object.values(golden(name).objects).flatMap((objs) =>
      objs.filter((o) => o.classId === ClassID.Mesh),
    ),
  ).length;
  assert.equal(count, 12);
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    assert.ok(FIXTURES.includes(`editor/${editor}/lz4/main`), editor);
    assert.ok(FIXTURES.includes(`editor/${editor}/lz4-notypetree/main`), editor);
  }
});

for (const name of FIXTURES) {
  test(`${name}: readMesh() equals readTypeTree() of the same object`, () => {
    // A build without type trees holds the same object, under the same path
    // id, as its typed twin.
    const twin = loadName(typedTwin(name));
    const meshes = loadName(name).objects.filter((o) => o.type === ClassID.Mesh);
    assert.equal(meshes.length, 1);
    for (const reader of meshes) {
      const mesh = readMesh(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      const typed = twin.objects.find((o) => o.pathId === reader.pathId)!;
      const tree = typed.readTypeTree() as Record<string, unknown>;
      // From 2020.1 the type tree reads the offset as UInt64, a bigint (D9).
      const offset = (tree.m_StreamData as { offset: unknown }).offset;
      assert.equal(typeof offset, atLeast(reader.version, 2020, 1) ? "bigint" : "number");
      const expected = withNumberOffset(tree);
      // Every field, in Unity's order.
      assert.deepEqual(Object.keys(mesh), Object.keys(expected));
      assert.deepStrictEqual(mesh, expected);
    }
  });

  test(`${name}: read() decodes the one triangle the fixture project builds`, () => {
    for (const reader of loadName(name).objects.filter((o) => o.type === ClassID.Mesh)) {
      const { geometry: data, ...rest } = reader.read<MeshData>();
      // The hardcoded reader's fields, then the decoded ones.
      const fields = readMesh(reader);
      assert.deepEqual(Object.keys(rest), Object.keys(fields));
      assert.deepStrictEqual(rest, fields);
      assert.deepEqual(Object.keys(data), ["vertexCount", "vertices", "uv", "indices"]);
      // fixtures/BUILDING.md: vertices zero, up, right; triangles 0, 1, 2.
      assert.equal(fields.m_Name, "tri");
      assert.equal(data.vertexCount, 3);
      assert.deepStrictEqual(data.vertices, Float32Array.of(0, 0, 0, 0, 1, 0, 1, 0, 0));
      assert.deepStrictEqual(data.indices, [Uint32Array.of(0, 1, 2)]);
      assert.deepStrictEqual(data.uv, new Array(8).fill(undefined));
    }
  });
}

// --- hand-built layouts at every version gate (TPK) -------------------------------------

/** One vertex channel of the input: `[stream, offset, format, dimension]`. */
type Channel = [number, number, number, number];
/** A vertex stream of the input before 5.0: `[channelMask, offset, stride]`. */
type Stream = [number, number, number];
/** A packed vector of the input: its items, or the bytes as they are. */
interface Packed {
  bits: number;
  items: number[];
  range?: number;
  start?: number;
  /** `m_NumItems` as written; the item count by default. */
  numItems?: number;
  /** `m_Data` as written; the items packed by default. */
  data?: Uint8Array;
}

/** What a hand-built mesh holds; everything not given is empty. */
interface MeshInput {
  /** Fill the fields the decoding ignores (blend shapes, bones, LOD), to test the layout. */
  rich?: boolean;
  /** Before 3.5: `m_Use16BitIndices`, 1 by default. */
  use16?: number;
  /** `[firstByte, indexCount, topology]`; before 4.0 the topology is `isTriStrip`. */
  subMeshes?: { firstByte: number; indexCount: number; topology: number }[];
  /** Before 2018.2: `m_Skin`, `[weights, bone indices]` per vertex. */
  skin?: [number[], number[]][];
  /** Unity 3.4's vertex arrays; `colors` are `RGBA32` words. */
  legacy?: {
    vertices?: number[][];
    uv?: number[][];
    uv1?: number[][];
    tangents?: number[][];
    normals?: number[][];
    colors?: number[];
  };
  indexFormat?: number;
  indexBuffer?: Uint8Array;
  vertexCount?: number;
  channels?: Channel[];
  /** Before 5.0: the streams (3.5: four of them). */
  streams?: Stream[];
  vertexData?: Uint8Array;
  compressed?: { [field: string]: Packed | undefined };
  uvInfo?: number;
  streamData?: { offset: number; size: number; path: string };
}

/** `items` packed `bits` wide, least significant bit first, as Unity packs them. */
function pack(items: number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((items.length * bits) / 8));
  items.forEach((item, i) => {
    for (let b = 0; b < bits; b++) {
      const at = i * bits + b;
      if ((item >>> b) & 1) out[at >> 3]! |= 1 << (at & 7);
    }
  });
  return out;
}

/**
 * A Mesh as Unity's player type tree for `unity` lays it out (TPK: 3.4.0,
 * 3.5.0, 4.0.0, 4.1.0, 4.3.0, 5.0.0, 5.6.0, 2017.3.0b1, 2018.1.0b2,
 * 2018.2.0b1, 2018.3.0b1, 2019.1.0a10, 2020.1.0a19, 2022.1.0a15, 6000.2.0a8
 * and 6000.6.0a5 change it), and the object `readMesh` must return for it.
 * `buildType` decides 2017.3's `m_IndexFormat` (see `readMesh`).
 */
function meshLayout(w: Writer, unity: UnityVersion, input: MeshInput = {}, buildType = "f"): Mesh {
  const v = (major: number, minor: number) => atLeast(unity, major, minor);
  let n = 0;
  const float = () => w.f32(0.5 + n++);
  const v2 = () => ({ x: float(), y: float() });
  const v3 = () => ({ x: float(), y: float(), z: float() });
  const v4 = () => ({ x: float(), y: float(), z: float(), w: float() });
  const aabb = () => ({ m_Center: v3(), m_Extent: v3() });
  const matrix = () =>
    Object.fromEntries(
      [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => [`e${r}${c}`, float()])),
    );
  const byteVector = (data: Uint8Array) => w.pad(w.bytes(data));
  const rich = input.rich ?? false;
  const some = <T>(...items: T[]): T[] => (rich ? items : []);
  const xyz = (keys: string, values: number[]) =>
    Object.fromEntries([...keys].map((k, i) => [k, w.f32(values[i]!)]));
  const shapeVertex = (signed: boolean) => ({
    vertex: v3(),
    normal: v3(),
    tangent: v3(),
    index: signed ? w.i32(-n++) : w.u32(n++),
  });
  const skin = () =>
    w.array(input.skin ?? (rich ? [[[0.25, 0.75, 0, 0], [1, 2, 0, 0]]] : []), ([wt, bones]) => ({
      ...Object.fromEntries(wt.map((x, i) => [`weight[${i}]`, w.f32(x)])),
      ...Object.fromEntries(bones.map((x, i) => [`boneIndex[${i}]`, w.i32(x)])),
    }));

  const out: Record<string, unknown> = {};
  out.m_Name = w.str("mesh");
  if (!v(3, 5)) out.m_Use16BitIndices = w.i32(input.use16 ?? 1);
  const subMeshes = input.subMeshes ?? some({ firstByte: 0, indexCount: 0, topology: 0 });
  out.m_SubMeshes = w.array(subMeshes, (s) => {
    const sub: Record<string, unknown> = {
      firstByte: w.u32(s.firstByte),
      indexCount: w.u32(s.indexCount),
    };
    if (!v(4, 0)) {
      sub.isTriStrip = w.u32(s.topology);
      sub.triangleCount = w.u32(n++);
    } else {
      sub.topology = w.i32(s.topology);
    }
    if (v(2017, 3)) sub.baseVertex = w.u32(n++);
    sub.firstVertex = w.u32(n++);
    sub.vertexCount = w.u32(n++);
    sub.localAABB = aabb();
    return sub;
  });
  if (v(4, 3)) {
    out.m_Shapes = {
      vertices: w.array(some(1, 2), () => shapeVertex(false)),
      shapes: w.array(some(true, false), (normals) =>
        w.pad({
          firstVertex: w.u32(n++),
          vertexCount: w.u32(n++),
          hasNormals: w.bool(normals),
          hasTangents: w.bool(!normals),
        }),
      ),
      channels: w.array(some("smile", "blink"), (name) => ({
        name: w.str(name),
        nameHash: w.u32(n++),
        frameIndex: w.i32(-n++),
        frameCount: w.i32(n++),
      })),
      fullWeights: w.array(some(0.25, 0.75), (x) => w.f32(x)),
    };
  } else if (v(4, 1)) {
    out.m_Shapes = w.pad(
      w.array(some("smile", "blink"), (name) => ({
        name: w.str(name),
        firstVertex: w.u32(n++),
        vertexCount: w.u32(n++),
        aabbMinDelta: v3(),
        aabbMaxDelta: v3(),
        hasNormals: w.bool(true),
        hasTangents: w.bool(false),
      })),
    );
    out.m_ShapeVertices = w.array(some(1), () => shapeVertex(true));
  }
  if (v(4, 3)) {
    out.m_BindPose = w.array(some(1), matrix);
    out.m_BoneNameHashes = w.array(some(0xdeadbeef, 7), (x) => w.u32(x));
    out.m_RootBoneNameHash = w.u32(rich ? 0x8000_0001 : 0);
  }
  if (v(2019, 1)) {
    out.m_BonesAABB = w.array(some(1), () => ({ m_Min: v3(), m_Max: v3() }));
    out.m_VariableBoneCountWeights = { m_Data: w.array(some(1, 2, 3), (x) => w.u32(x)) };
  }
  const compression = input.compressed ? 2 : 0;
  out.m_MeshCompression = w.u8(compression);
  if (v(4, 0)) {
    if (!v(5, 0)) out.m_StreamCompression = w.u8(1);
    out.m_IsReadable = w.bool(true);
    out.m_KeepVertices = w.bool(false);
    out.m_KeepIndices = w.bool(true);
  }
  w.align();
  const [major, minor, patch] = unity;
  if (
    v(2017, 4) ||
    (major === 2017 && minor === 3 && (compression === 0 || (patch === 1 && buildType === "p")))
  ) {
    out.m_IndexFormat = w.i32(input.indexFormat ?? 0);
  }
  // Odd lengths, so a missing align shows.
  out.m_IndexBuffer = byteVector(
    input.indexBuffer ?? (rich ? Uint8Array.of(1, 0, 2) : new Uint8Array()),
  );
  const legacy = input.legacy ?? (rich ? { vertices: [[1, 2, 3]], uv: [[0.5, 0.25]] } : {});
  if (!v(3, 5)) {
    out.m_Vertices = w.array(legacy.vertices ?? [], (x) => xyz("xyz", x));
    out.m_Skin = skin();
    out.m_BindPose = w.array(some(1), matrix);
    out.m_UV = w.array(legacy.uv ?? [], (x) => xyz("xy", x));
    out.m_UV1 = w.array(legacy.uv1 ?? [], (x) => xyz("xy", x));
    out.m_Tangents = w.array(legacy.tangents ?? [], (x) => xyz("xyzw", x));
    out.m_Normals = w.pad(w.array(legacy.normals ?? [], (x) => xyz("xyz", x)));
  } else {
    if (!v(2018, 2)) out.m_Skin = skin();
    if (!v(4, 3)) out.m_BindPose = w.array(some(1), matrix);
    const data: Record<string, unknown> = {};
    if (!v(2018, 1)) data.m_CurrentChannels = v(5, 6) ? w.i32(-1) : w.u32(0x8000_0003);
    data.m_VertexCount = w.u32(input.vertexCount ?? 0);
    const channels = input.channels ?? (rich ? [[0, 0, 0, 3] as Channel] : []);
    if (v(4, 0)) {
      data.m_Channels = w.array(channels, ([stream, offset, format, dimension]) => ({
        stream: w.u8(stream),
        offset: w.u8(offset),
        format: w.u8(format),
        dimension: w.u8(dimension),
      }));
    }
    const streams = input.streams ?? (rich ? [[1, 0, 12] as Stream] : []);
    if (!v(4, 0)) {
      for (let i = 0; i < 4; i++) {
        const [channelMask, offset, stride] = streams[i] ?? [0, 0, 0];
        data[`m_Streams[${i}]`] = {
          channelMask: w.u32(channelMask),
          offset: w.u32(offset),
          stride: w.u32(stride),
          align: w.u32(0),
        };
      }
    } else if (!v(5, 0)) {
      data.m_Streams = w.array(streams, ([channelMask, offset, stride]) => ({
        channelMask: w.u32(channelMask),
        offset: w.u32(offset),
        stride: w.u8(stride),
        dividerOp: w.u8(0),
        frequency: w.u16(0),
      }));
    }
    data.m_DataSize = byteVector(
      input.vertexData ?? (rich ? Uint8Array.of(9, 8, 7) : new Uint8Array()),
    );
    out.m_VertexData = data;
  }
  const compressed = input.compressed ?? {};
  const packed = (field: string, withRange: boolean) => {
    const vector: Packed = compressed[field] ?? { bits: 0, items: [] };
    const out: Record<string, unknown> = {
      m_NumItems: w.u32(vector.numItems ?? vector.items.length),
    };
    if (withRange) {
      out.m_Range = w.f32(vector.range ?? 1);
      out.m_Start = w.f32(vector.start ?? 0);
    }
    out.m_Data = byteVector(vector.data ?? pack(vector.items, vector.bits));
    out.m_BitSize = w.pad(w.u8(vector.bits));
    return out;
  };
  const cm: Record<string, unknown> = {
    m_Vertices: packed("m_Vertices", true),
    m_UV: packed("m_UV", true),
  };
  if (!v(5, 0)) cm.m_BindPoses = packed("m_BindPoses", true);
  cm.m_Normals = packed("m_Normals", true);
  cm.m_Tangents = packed("m_Tangents", true);
  cm.m_Weights = packed("m_Weights", false);
  cm.m_NormalSigns = packed("m_NormalSigns", false);
  cm.m_TangentSigns = packed("m_TangentSigns", false);
  if (v(5, 0)) cm.m_FloatColors = packed("m_FloatColors", true);
  cm.m_BoneIndices = packed("m_BoneIndices", false);
  cm.m_Triangles = packed("m_Triangles", false);
  if (v(5, 0)) cm.m_UVInfo = w.u32(input.uvInfo ?? 0);
  else if (v(3, 5)) cm.m_Colors = packed("m_Colors", false);
  out.m_CompressedMesh = cm;
  out.m_LocalAABB = aabb();
  if (!v(3, 5)) {
    out.m_Colors = w.array(legacy.colors ?? [], (rgba) => ({ rgba: w.u32(rgba) }));
    out.m_CollisionTriangles = w.array(some(0, 1, 2), (x) => w.u32(x));
    out.m_CollisionVertexCount = w.i32(rich ? 3 : 0);
  }
  if (!v(6000, 6)) out.m_MeshUsageFlags = w.i32(-n++);
  if (v(2022, 1)) out.m_CookingOptions = w.i32(30);
  if (v(6000, 6)) {
    out.m_PreBakeConvexCollisionMesh = w.bool(true);
    out.m_PreBakeTriangleCollisionMesh = w.pad(w.bool(false));
  }
  if (v(5, 0)) {
    out.m_BakedConvexCollisionMesh = byteVector(rich ? Uint8Array.of(1, 2, 3) : new Uint8Array());
    out.m_BakedTriangleCollisionMesh = byteVector(rich ? Uint8Array.of(4) : new Uint8Array());
  }
  if (v(2018, 2)) {
    out["m_MeshMetrics[0]"] = float();
    out["m_MeshMetrics[1]"] = float();
  }
  if (v(2018, 3)) {
    w.align();
    const stream = input.streamData ?? { offset: 0, size: 0, path: "" };
    out.m_StreamData = {
      offset: v(2020, 1) ? w.u64n(stream.offset) : w.u32(stream.offset),
      size: w.u32(stream.size),
      path: w.str(stream.path),
    };
  }
  if (v(6000, 2)) {
    out.m_MeshLodInfo = {
      m_LodSelectionCurve: { m_LodSlope: float(), m_LodBias: float() },
      m_NumLevels: w.i32(2),
      m_SubMeshes: w.array(some([[0, 3], [3, 0]], []), (levels) => ({
        m_Levels: w.array(levels, ([start, count]) => ({
          m_IndexStart: w.u32(start!),
          m_IndexCount: w.u32(count!),
        })),
      })),
    };
  }
  return out as unknown as Mesh;
}

/** The 2020.3 fixture Mesh, as the file and entry hand-built ones claim to come from. */
const FROM_2020 = template("editor/2020.3.30f1/lz4/main", ClassID.Mesh);
const U2020: UnityVersion = [2020, 3, 30, 1];

/**
 * A hand-built Mesh, its reader as Unity `unity` (build type `buildType`) wrote
 * it, and what `readMesh` must return.
 */
function handBuilt(
  input: MeshInput,
  unity: UnityVersion = U2020,
  buildType = "f",
): { bytes: Uint8Array; expected: Mesh; reader: ObjectReader } {
  const { bytes, expected } = build((w) => meshLayout(w, unity, input, buildType));
  const from = { ...FROM_2020, sf: { ...FROM_2020.sf, buildType } };
  return { bytes, expected, reader: readerOf(from, bytes, { unity }) };
}

const LAYOUTS: UnityVersion[] = [
  [3, 4, 0, 1],
  [3, 5, 7, 1],
  [4, 0, 0, 1],
  [4, 1, 0, 1],
  [4, 2, 2, 1],
  [4, 3, 0, 1],
  [4, 7, 2, 1],
  [5, 0, 0, 1],
  [5, 3, 5, 1],
  [5, 5, 0, 1],
  [5, 6, 7, 1],
  [2017, 1, 0, 1],
  [2017, 2, 0, 1],
  [2017, 3, 0, 1],
  [2017, 4, 40, 1],
  [2018, 1, 0, 1],
  [2018, 2, 0, 1],
  [2018, 3, 0, 1],
  [2018, 4, 36, 1],
  [2019, 1, 0, 1],
  [2019, 4, 41, 2],
  [2020, 1, 0, 1],
  [2020, 3, 30, 1],
  [2022, 1, 0, 1],
  [6000, 2, 0, 1],
  [6000, 3, 25, 1],
  [6000, 6, 0, 1],
  [6000, 7, 0, 1],
];

for (const unity of LAYOUTS) {
  test(`Mesh, Unity ${unity.join(".")}: the player layout of Unity's type tree`, () => {
    const { expected, reader } = handBuilt({ rich: true }, unity);
    const mesh = readMesh(reader);
    assert.deepEqual(Object.keys(mesh), Object.keys(expected));
    assert.deepStrictEqual(mesh, expected);
    assert.equal(reader.remaining, 0);
  });
}

/** The fixture editors whose real type trees check the hand-built layouts. */
const TYPE_TREES: { name: string; unity: UnityVersion }[] = [
  { name: "editor/2019.4.41f2/lz4/main", unity: [2019, 4, 41, 2] },
  { name: "editor/2020.3.30f1/lz4/main", unity: [2020, 3, 30, 1] },
  { name: "editor/6000.3.25f1/lz4/main", unity: [6000, 3, 25, 1] },
];

test("each version gate: a layout read as its neighbour's is refused", () => {
  const pairs: [UnityVersion, UnityVersion][] = [
    [[3, 4, 0, 1], [3, 5, 0, 1]],
    [[3, 5, 7, 1], [4, 0, 0, 1]],
    [[4, 0, 0, 1], [4, 1, 0, 1]],
    [[4, 2, 2, 1], [4, 3, 0, 1]],
    [[4, 7, 2, 1], [5, 0, 0, 1]],
    [[2017, 2, 0, 1], [2017, 3, 0, 1]],
    [[2017, 4, 40, 1], [2018, 1, 0, 1]],
    [[2018, 1, 0, 1], [2018, 2, 0, 1]],
    [[2018, 2, 0, 1], [2018, 3, 0, 1]],
    [[2018, 4, 36, 1], [2019, 1, 0, 1]],
    [[2019, 4, 41, 2], [2020, 1, 0, 1]],
    [[2020, 3, 30, 1], [2022, 1, 0, 1]],
    [[2022, 1, 0, 1], [6000, 2, 0, 1]],
  ];
  // Some gates change no byte count, so only the version tells them apart:
  // 5.6 signs m_CurrentChannels, 6000.6 swaps m_MeshUsageFlags for two bools
  // and their padding.
  for (const [before, after] of pairs) {
    for (const [wrote, read] of [
      [before, after],
      [after, before],
    ] as const) {
      const { bytes } = build((w) => meshLayout(w, wrote, { rich: true }));
      assert.throws(
        () => readMesh(readerOf(FROM_2020, bytes, { unity: read })),
        CorruptError,
        `${wrote.join(".")} read as ${read.join(".")}`,
      );
    }
  }
});

// --- refusals ---------------------------------------------------------------------------

test("before Unity 3.4, which has no type tree data: UnsupportedError(Unity version)", () => {
  const { bytes } = build((w) => meshLayout(w, [3, 4, 0, 1], { rich: true }));
  for (const unity of [
    [3, 3, 0, 1],
    [2, 6, 1, 1],
  ] as UnityVersion[]) {
    const text = unity.slice(0, 3).join(".");
    const reader = readerOf(FROM_2020, bytes, { unity });
    assert.throws(
      () => readMesh(reader),
      (err: unknown) =>
        versionRefusal(text)(err) &&
        (err as Error).message.includes(`object ${reader.pathId}`) &&
        (err as Error).message.includes("before Unity 3.4"),
    );
  }
});

test('Unity "0.0.0" in formats 18 to 21: read as 2019, the one layout they allow', () => {
  const { bytes, expected } = build((w) => meshLayout(w, [2019, 4, 41, 2], { rich: true }));
  for (const format of [18, 19, 20, 21]) {
    const reader = readerOf(FROM_2020, bytes, { unity: [0, 0, 0, 0], text: "0.0.0", format });
    assert.deepStrictEqual(readMesh(reader), expected, `format ${format}`);
    assert.equal(reader.remaining, 0);
  }
});

test('Unity "0.0.0" elsewhere, or not in 2019\'s layout: UnsupportedError(Unity version)', () => {
  const { bytes } = build((w) => meshLayout(w, [2019, 4, 41, 2], { rich: true }));
  for (const format of [17, 22, 23]) {
    const reader = readerOf(FROM_2020, bytes, { unity: [0, 0, 0, 0], text: "0.0.0", format });
    assert.throws(() => readMesh(reader), versionRefusal("0.0.0"), `format ${format}`);
  }
  // 2020.1's wider offset does not fit 2019's layout: refused, not "corrupt".
  const v2020 = build((w) => meshLayout(w, U2020, { rich: true })).bytes;
  const reader = readerOf(FROM_2020, v2020, { unity: [0, 0, 0, 0], text: "0.0.0", format: 21 });
  assert.throws(
    () => readMesh(reader),
    (err: unknown) =>
      versionRefusal("0.0.0")(err) &&
      /does not fit 2019's Mesh layout/.test((err as Error).message),
  );
});

test("an editor file (NoTarget) is refused: it holds editor-only fields", () => {
  const { bytes } = handBuilt({ rich: true });
  const reader = readerOf(FROM_2020, bytes, { unity: U2020, platform: BuildTarget.NoTarget });
  assert.throws(
    () => readMesh(reader),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

// --- truncated, oversized and garbled objects -----------------------------------------

for (const { name, unity } of TYPE_TREES) {
  test(`${name}: every cut through the Mesh throws CorruptError`, () => {
    const from = objectBytes(name, ClassID.Mesh);
    readMesh(readerOf(from, from.bytes, { unity }));
    // The last 3 bytes may be only padding; every shorter cut loses data.
    for (let cut = 0; cut <= from.bytes.length - 4; cut++) {
      const reader = readerOf(from, from.bytes.subarray(0, cut), { unity });
      assert.throws(() => readMesh(reader), CorruptError, `cut at ${cut}`);
    }
  });
}

test("bytes left after the last field throw CorruptError", () => {
  const { bytes } = handBuilt({ rich: true });
  const reader = readerOf(FROM_2020, withTail(bytes, 0, 0, 0, 0), { unity: U2020 });
  assert.throws(
    () => readMesh(reader),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message.includes(`Mesh ${reader.pathId} ends at ${bytes.length} of its`),
  );
});

test("a negative or oversized count throws CorruptError naming the field", () => {
  // The fixture-shaped mesh: m_Name "mesh" (8 bytes), then the submesh count.
  const { bytes } = handBuilt({});
  for (const count of [-1, 0x7fff_ffff]) {
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(8, count, true);
    assert.throws(
      () => readMesh(readerOf(FROM_2020, copy, { unity: U2020 })),
      (err: unknown) =>
        err instanceof CorruptError && /Mesh -?\d+ m_SubMeshes count/.test(err.message),
    );
  }
});

test("2020.1+: an m_StreamData.offset of 2^53 or above throws CorruptError", () => {
  const ok = handBuilt({ streamData: { offset: 2 ** 53 - 1, size: 4, path: "a.resS" } });
  assert.equal(readMesh(ok.reader).m_StreamData.offset, 2 ** 53 - 1);
  const { bytes } = ok;
  // The object ends with the offset (8), the size (4) and the path (4 + 8).
  new DataView(bytes.buffer).setBigUint64(bytes.length - 24, 2n ** 53n, true);
  assert.throws(
    () => readMesh(readerOf(FROM_2020, bytes, { unity: U2020 })),
    /Mesh -?\d+ m_StreamData offset 9007199254740992 is not a byte offset/,
  );
});

// --- decoding: vertex streams -----------------------------------------------------------

/**
 * Little-endian bytes from `[kind, value]` pairs: `f32`, `u32`, `f16` (raw
 * bits), `u16`, `i16`, `u8`, `i8`.
 */
function bytesOf(...values: [string, number][]): Uint8Array {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  for (const [kind, value] of values) {
    if (kind === "f32") view.setFloat32(0, value, true);
    else if (kind === "u16" || kind === "f16") view.setUint16(0, value, true);
    else if (kind === "i16") view.setInt16(0, value, true);
    else if (kind === "u8") view.setUint8(0, value);
    else if (kind === "i8") view.setInt8(0, value);
    else if (kind === "u32") view.setUint32(0, value, true);
    else assert.fail(kind);
    const size = { f32: 4, u32: 4, f16: 2, u16: 2, i16: 2, u8: 1, i8: 1 }[kind]!;
    out.push(...new Uint8Array(view.buffer, 0, size));
  }
  return Uint8Array.from(out);
}

/** `count` zero bytes. */
const zeros = (count: number): [string, number][] => new Array(count).fill(["u8", 0]);

/**
 * Two vertices in three streams, a channel in each of the 2019+ formats the
 * decoding converts, and the 2018+ channel numbering: 0 position, 1 normal,
 * 2 tangent, 3 colour, 4-11 UV0-7, 12 bone weights, 13 bone indices.
 */
const STREAMS: MeshInput = {
  vertexCount: 2,
  channels: [
    // Stream 0, stride 26: Float x3 (dimension byte 0x23: only the low 4 bits
    // count), Float16 x3, SNorm16 x4.
    [0, 0, 0, 0x23],
    [0, 12, 1, 3],
    [0, 18, 5, 4],
    // Stream 1 at 64 (52 aligned to 16), stride 11: UNorm8 x4, SNorm8 x2,
    // UNorm16 x2, nothing for UV2, UInt8 x1 for UV3.
    [1, 0, 2, 4],
    [1, 4, 3, 2],
    [1, 6, 4, 2],
    [0, 0, 0, 0],
    [1, 10, 6, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    // Stream 2 at 96 (86 aligned), stride 12: Float x2 weights, UInt16 x2 indices.
    [2, 0, 0, 2],
    [2, 8, 8, 2],
  ],
  vertexData: bytesOf(
    // Stream 0, vertex 0, then vertex 1.
    ["f32", 1.5], ["f32", -2], ["f32", 3.25],
    ["f16", 0x3c00], ["f16", 0xc000], ["f16", 0x3800],
    ["i16", 32767], ["i16", -32768], ["i16", 0], ["i16", 16384],
    ["f32", 4], ["f32", 5], ["f32", 6],
    ["f16", 0x0001], ["f16", 0x8000], ["f16", 0x7c00],
    ["i16", -16384], ["i16", 1], ["i16", -1], ["i16", -32767],
    ...zeros(12),
    // Stream 1.
    ["u8", 255], ["u8", 0], ["u8", 128], ["u8", 51], ["i8", 127], ["i8", -128],
    ["u16", 65535], ["u16", 0], ["u8", 200],
    ["u8", 1], ["u8", 2], ["u8", 3], ["u8", 4], ["i8", -64], ["i8", 64],
    ["u16", 32768], ["u16", 1], ["u8", 201],
    ...zeros(10),
    // Stream 2.
    ["f32", 0.75], ["f32", 0.25], ["u16", 3], ["u16", 65535],
    ["f32", 1], ["f32", 0], ["u16", 0], ["u16", 7],
  ),
  indexBuffer: bytesOf(["u16", 0], ["u16", 1], ["u16", 1]),
  subMeshes: [{ firstByte: 0, indexCount: 3, topology: 0 }],
};

test("vertex streams: every format converted as upstream's MeshHelper does", () => {
  const { reader } = handBuilt(STREAMS);
  assert.equal(STREAMS.vertexData!.length, 120);
  const data = reader.read<MeshData>().geometry;
  assert.equal(data.vertexCount, 2);
  assert.deepStrictEqual(data.vertices, Float32Array.of(1.5, -2, 3.25, 4, 5, 6));
  // Float16: exact, subnormals, signed zero and infinity included.
  assert.deepStrictEqual(data.normals, Float32Array.of(1, -2, 0.5, 2 ** -24, -0, Infinity));
  // SNorm16: x / 32767 in float32, clamped to -1.
  assert.deepStrictEqual(
    data.tangents,
    Float32Array.of(1, -1, 0, f(16384 / 32767), f(-16384 / 32767), f(1 / 32767), f(-1 / 32767), -1),
  );
  // UNorm8: x / 255.
  assert.deepStrictEqual(
    data.colors,
    Float32Array.from([255, 0, 128, 51, 1, 2, 3, 4], (x) => f(x / 255)),
  );
  // SNorm8 for UV0, UNorm16 for UV1; UV3 is in an integer format, so absent as upstream's null.
  assert.deepStrictEqual(data.uv[0], Float32Array.of(1, -1, f(-64 / 127), f(64 / 127)));
  assert.deepStrictEqual(data.uv[1], Float32Array.of(1, 0, f(32768 / 65535), f(1 / 65535)));
  assert.deepStrictEqual(data.uv.slice(2), new Array(6).fill(undefined));
  // Upstream reads UInt16 bone indices as Int16: 65535 is -1.
  assert.deepStrictEqual(data.skin, [
    { weight: [0.75, 0.25, 0, 0], boneIndex: [3, -1, 0, 0] },
    { weight: [1, 0, 0, 0], boneIndex: [0, 7, 0, 0] },
  ]);
  assert.deepStrictEqual(data.indices, [Uint32Array.of(0, 1, 1)]);
  // The type tree's dimension byte is kept as the file holds it.
  assert.equal(readMesh(reader).m_VertexData!.m_Channels![0]!.dimension, 0x23);
});

/** STREAMS with channel `chn` replaced. */
function streamsWith(chn: number, channel: Channel): MeshInput {
  const channels = STREAMS.channels!.map((c, i) => (i === chn ? channel : c));
  return { ...STREAMS, channels };
}

test("vertex streams: data shorter than the channels need throws CorruptError", () => {
  for (const cut of [1, 24]) {
    const input = { ...STREAMS, vertexData: STREAMS.vertexData!.subarray(0, 120 - cut) };
    assert.throws(
      () => handBuilt(input).reader.read(),
      (err: unknown) =>
        err instanceof CorruptError &&
        /Mesh -?\d+ channel 1[23]: 2 vertices of stride 12 from byte \d+ run/.test(err.message),
    );
  }
});

test("vertex streams: a format Unity does not define throws UnsupportedError", () => {
  const { reader } = handBuilt(streamsWith(4, [1, 4, 12, 2]));
  assert.throws(
    () => reader.read(),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "vertex format" && err.found === 12,
  );
  // A channel of dimension 0 is not read, whatever its format.
  const unused = handBuilt(streamsWith(6, [1, 0, 99, 0])).reader.read<MeshData>().geometry;
  assert.equal(unused.uv[2], undefined);
});

test("bone weights in an integer format, indices in a float one, or more than 4: refused", () => {
  const cases: [number, Channel, string, number][] = [
    [12, [2, 0, 6, 2], "vertex format", 6],
    [13, [2, 8, 0, 1], "vertex format", 0],
    // In stream 1, where the data has room for five.
    [13, [1, 10, 6, 5], "bones per vertex", 5],
  ];
  for (const [chn, channel, kind, found] of cases) {
    assert.throws(
      () => handBuilt(streamsWith(chn, channel)).reader.read(),
      (err: unknown) => err instanceof UnsupportedError && err.kind === kind && err.found === found,
      `channel ${chn}`,
    );
  }
});

// --- decoding: indices ------------------------------------------------------------------

/** The triangles of one submesh over `indices` of the given width. */
function trianglesOf(
  indices: number[],
  subMesh: { firstByte: number; indexCount: number; topology: number },
  wide = false,
): Uint32Array {
  const indexBuffer = bytesOf(...indices.map((i): [string, number] => [wide ? "u32" : "u16", i]));
  const { reader } = handBuilt({ indexFormat: wide ? 1 : 0, indexBuffer, subMeshes: [subMesh] });
  const [triangles, ...more] = reader.read<MeshData>().geometry.indices;
  assert.equal(more.length, 0);
  return triangles!;
}

test("indices: 16 and 32 bits, from the submesh's first byte", () => {
  const list = [9, 9, 4, 5, 6, 70000, 8, 9];
  assert.deepStrictEqual(
    trianglesOf([9, 4, 5, 6, 7], { firstByte: 2, indexCount: 3, topology: 0 }),
    Uint32Array.of(4, 5, 6),
  );
  assert.deepStrictEqual(
    trianglesOf(list, { firstByte: 20, indexCount: 3, topology: 0 }, true),
    Uint32Array.of(70000, 8, 9),
  );
  // Several submeshes, each its own triangles.
  const { reader } = handBuilt({
    indexBuffer: bytesOf(...[0, 1, 2, 2, 1, 3].map((i): [string, number] => ["u16", i])),
    subMeshes: [
      { firstByte: 0, indexCount: 3, topology: 0 },
      { firstByte: 6, indexCount: 3, topology: 0 },
    ],
  });
  assert.deepStrictEqual(reader.read<MeshData>().geometry.indices, [
    Uint32Array.of(0, 1, 2),
    Uint32Array.of(2, 1, 3),
  ]);
});

test("indices: strips lose their degenerate triangles and alternate winding; quads split", () => {
  assert.deepStrictEqual(
    trianglesOf([0, 1, 2, 2, 3, 4, 5], { firstByte: 0, indexCount: 7, topology: 1 }),
    Uint32Array.of(0, 1, 2, 3, 2, 4, 3, 4, 5),
  );
  // Fewer than 3 indices make no triangle.
  assert.deepStrictEqual(
    trianglesOf([0, 1], { firstByte: 0, indexCount: 2, topology: 1 }),
    new Uint32Array(0),
  );
  assert.deepStrictEqual(
    trianglesOf([7, 0, 1, 2, 3, 4, 5, 6, 8], { firstByte: 2, indexCount: 8, topology: 2 }),
    Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 8),
  );
});

test("indices: lines and points throw UnsupportedError, as upstream", () => {
  for (const topology of [3, 4, 5, 6, -1]) {
    assert.throws(
      () => trianglesOf([0, 1, 2], { firstByte: 0, indexCount: 2, topology }),
      (err: unknown) =>
        err instanceof UnsupportedError && err.kind === "mesh topology" && err.found === topology,
    );
  }
});

test("indices: a submesh past the index buffer throws CorruptError", () => {
  for (const subMesh of [
    { firstByte: 2, indexCount: 3, topology: 0 },
    { firstByte: 0, indexCount: 4, topology: 0 },
    { firstByte: 0, indexCount: 4, topology: 1 },
    { firstByte: 0, indexCount: 4, topology: 2 },
  ]) {
    assert.throws(
      () => trianglesOf([0, 1, 2], subMesh),
      /Mesh -?\d+ submesh 0: indices \d+ to \d+ run past the 3 of the index buffer/,
    );
  }
});

// --- decoding: the compressed mesh ------------------------------------------------------

/**
 * Two vertices in packed vectors whose ranges make every step exact: with
 * `range` 2^bits - 1, upstream's divisor `(1 / range) * (2^bits - 1)` rounds
 * to 1 in float32, so an item is `x + start`.
 */
const COMPRESSED: MeshInput = {
  compressed: {
    // 3 bits: 18 bits over three bytes.
    m_Vertices: { bits: 3, range: 7, start: -1, items: [0, 7, 5, 1, 3, 6] },
    // UV0, then UV1: 4 per vertex, so both are there.
    m_UV: { bits: 2, range: 3, items: [0, 1, 2, 3, 3, 2, 1, 0] },
    // (0, 0): z = 1, negated by its 0 sign; (1, 1): z^2 < 0, so normalized.
    m_Normals: { bits: 1, items: [0, 0, 1, 1] },
    m_NormalSigns: { bits: 1, items: [0, 1] },
    // (0, 0) with signs z +, w -; (1, 0): z = 0, negated to -0, w +.
    m_Tangents: { bits: 1, items: [0, 0, 1, 0] },
    m_TangentSigns: { bits: 1, items: [1, 0, 0, 1] },
    m_FloatColors: { bits: 2, range: 3, items: [3, 0, 1, 2, 2, 2, 2, 3] },
    // Vertex 0: 31 (whole); vertex 1: 10 + 10 + 5, the fourth 6 / 31.
    m_Weights: { bits: 5, items: [31, 10, 10, 5] },
    m_BoneIndices: { bits: 4, items: [2, 1, 3, 4, 15] },
    m_Triangles: { bits: 2, items: [0, 1, 2, 2, 1, 0] },
  },
  // Not read: the packed triangles replace the index buffer.
  indexBuffer: bytesOf(["u16", 9], ["u16", 9], ["u16", 9]),
  subMeshes: [
    { firstByte: 0, indexCount: 3, topology: 0 },
    { firstByte: 6, indexCount: 3, topology: 0 },
  ],
};

test("compressed mesh: every packed vector unpacked as upstream's DecompressCompressedMesh", () => {
  const data = handBuilt(COMPRESSED).reader.read<MeshData>().geometry;
  assert.equal(data.vertexCount, 2);
  assert.deepStrictEqual(data.vertices, Float32Array.of(-1, 6, 4, 0, 2, 5));
  assert.deepStrictEqual(data.uv[0], Float32Array.of(0, 1, 2, 3));
  assert.deepStrictEqual(data.uv[1], Float32Array.of(3, 2, 1, 0));
  const inverse = f(1 / f(Math.sqrt(2)));
  assert.deepStrictEqual(data.normals, Float32Array.of(0, 0, -1, inverse, inverse, 0));
  assert.deepStrictEqual(data.tangents, Float32Array.of(0, 0, 1, -1, 1, 0, -0, 1));
  assert.deepStrictEqual(data.colors, Float32Array.of(3, 0, 1, 2, 2, 2, 2, 3));
  assert.deepStrictEqual(data.skin, [
    { weight: [1, 0, 0, 0], boneIndex: [2, 0, 0, 0] },
    { weight: [f(10 / 31), f(10 / 31), f(5 / 31), f(6 / 31)], boneIndex: [1, 3, 4, 15] },
  ]);
  assert.deepStrictEqual(data.indices, [Uint32Array.of(0, 1, 2), Uint32Array.of(2, 1, 0)]);
});

test("compressed mesh: m_UVInfo lays out the UV channels and their dimensions", () => {
  // UV0 of dimension 1 (bits 0b100), UV2 of dimension 3 (0b110, the third nibble).
  const input: MeshInput = {
    compressed: {
      m_Vertices: { bits: 1, items: [0, 0, 0, 1, 1, 1] },
      m_UV: { bits: 3, range: 7, items: [1, 2, 3, 4, 5, 6, 7, 0] },
    },
    uvInfo: 0x604,
  };
  const data = handBuilt(input).reader.read<MeshData>().geometry;
  assert.deepStrictEqual(data.uv[0], Float32Array.of(1, 2));
  assert.deepStrictEqual(data.uv[2], Float32Array.of(3, 4, 5, 6, 7, 0));
  for (const uv of [1, 3, 4, 5, 6, 7]) assert.equal(data.uv[uv], undefined, `uv ${uv}`);
  // Without m_UVInfo, UV1 only when there are 4 items per vertex.
  const short = {
    compressed: { ...input.compressed, m_UV: { bits: 2, range: 3, items: [1, 2, 3, 0, 1] } },
  };
  const plain = handBuilt(short).reader.read<MeshData>().geometry;
  assert.deepStrictEqual(plain.uv[0], Float32Array.of(1, 2, 3, 0));
  assert.equal(plain.uv[1], undefined);
});

test("compressed mesh: a general range, in float32 as upstream's float arithmetic", () => {
  const range = 0.3;
  const start = -0.1;
  const items = [0, 1, 512, 1023, 77, 900];
  const input = { compressed: { m_Vertices: { bits: 10, range, start, items } } };
  const scale = f(1 / f(range));
  const divisor = f(scale * 1023);
  const expected = Float32Array.from(items, (x) => f(f(x / divisor) + f(start)));
  assert.deepStrictEqual(handBuilt(input).reader.read<MeshData>().geometry.vertices, expected);
});

test("compressed mesh: normals and tangents in float32, as upstream's float arithmetic", () => {
  // 10 bits over [-1, 1]: z from 1 - x^2 - y^2 rounds at every step in
  // float32, and for many inputs (the first here) differs from the float64 result.
  const items = [350, 650, 512, 100, 1000, 900, 0, 1023];
  const input: MeshInput = {
    compressed: {
      m_Normals: { bits: 10, range: 2, start: -1, items },
      m_NormalSigns: { bits: 1, items: [1, 0, 1, 1] },
      m_Tangents: { bits: 10, range: 2, start: -1, items },
      m_TangentSigns: { bits: 1, items: [1, 1, 0, 0, 1, 0, 0, 1] },
    },
  };
  const data = handBuilt(input).reader.read<MeshData>().geometry;
  const divisor = f(f(1 / 2) * 1023);
  const unpacked = items.map((x) => f(f(x / divisor) + -1));
  const normal = (i: number, sign: number): number[] => {
    let x = unpacked[i * 2]!;
    let y = unpacked[i * 2 + 1]!;
    const zsqr = f(f(1 - f(x * x)) - f(y * y));
    let z = 0;
    if (zsqr >= 0) z = f(Math.sqrt(zsqr));
    else {
      // Vector3.Normalize of (x, y, 0), above kEpsilon.
      const inverse = f(1 / f(Math.sqrt(f(f(x * x) + f(y * y)))));
      x = f(x * inverse);
      y = f(y * inverse);
    }
    return [x, y, sign === 0 ? -z : z];
  };
  // Two of the four go through Normalize: (0.95, 0.76) and (-1, 1).
  assert.equal(unpacked.filter((_, i) => i % 2 === 0).length, 4);
  assert.deepStrictEqual(
    data.normals,
    Float32Array.from([1, 0, 1, 1].flatMap((sign, i) => normal(i, sign))),
  );
  const signs = [1, 1, 0, 0, 1, 0, 0, 1];
  assert.deepStrictEqual(
    data.tangents,
    Float32Array.from(
      [0, 1, 2, 3].flatMap((i) => [...normal(i, signs[i * 2]!), signs[i * 2 + 1]! > 0 ? 1 : -1]),
    ),
  );
  // The float64 arithmetic would not give the first.
  const x = unpacked[0]!;
  const y = unpacked[1]!;
  assert.notEqual(data.normals![2], f(Math.sqrt(1 - x * x - y * y)));
});

test("compressed mesh: packed data short of its items, or too few signs: CorruptError", () => {
  const broken: [string, Packed][] = [
    ["m_Vertices", { bits: 3, items: [], numItems: 6, data: Uint8Array.of(0, 0) }],
    ["m_Triangles", { bits: 2, items: [], numItems: 6, data: Uint8Array.of(0) }],
    ["m_NormalSigns", { bits: 1, items: [0] }],
    ["m_TangentSigns", { bits: 1, items: [1, 0, 0] }],
    ["m_BoneIndices", { bits: 4, items: [2, 1, 3, 4] }],
    ["m_Weights", { bits: 5, items: [31, 31, 31] }],
  ];
  for (const [field, vector] of broken) {
    const input = { ...COMPRESSED, compressed: { ...COMPRESSED.compressed, [field]: vector } };
    assert.throws(
      () => handBuilt(input).reader.read(),
      (err: unknown) =>
        err instanceof CorruptError && /Mesh -?\d+ m_CompressedMesh/.test(err.message),
      field,
    );
  }
});

// --- m_StreamData: the vertices in a .resS ----------------------------------------------

/**
 * The 2020.3 fixture's CAB with its Mesh rewritten to keep its vertices in
 * `CAB-mesh.resS` at offset 16: the same 444 bytes (the 36 bytes of vertex
 * data become the path), so the file's object table still holds.
 */
function streamedFixture(vertexCount = 3): {
  cab: { path: string; data: Uint8Array };
  resS: Uint8Array;
} {
  const name = "editor/2020.3.30f1/lz4/main";
  const node = loadName(name).files.find((f) => Boolean(golden(name).serialized?.[f.path]))!;
  const { info } = template(name, ClassID.Mesh);
  const fixture = readMesh(loadName(name).objects.find((o) => o.type === ClassID.Mesh)!);
  const vertices = fixture.m_VertexData.m_DataSize;
  const input = (path: string): MeshInput => ({
    vertexCount,
    channels: fixture.m_VertexData.m_Channels.map((c): Channel => [
      c.stream,
      c.offset,
      c.format,
      c.dimension,
    ]),
    indexBuffer: fixture.m_IndexBuffer,
    subMeshes: [{ firstByte: 0, indexCount: 3, topology: 0 }],
    streamData: { offset: 16, size: vertices.length, path },
  });
  const short = build((w) => meshLayout(w, U2020, input("archive:/CAB-mesh/CAB-mesh.resS")));
  const path = `archive:/CAB-mesh${"x".repeat(info.byteSize - short.bytes.length)}/CAB-mesh.resS`;
  const { bytes } = build((w) => meshLayout(w, U2020, input(path)));
  assert.equal(bytes.length, info.byteSize);
  const data = node.data.slice();
  data.set(bytes, info.byteStart);
  const resS = new Uint8Array(16 + vertices.length + 8);
  resS.set(vertices, 16);
  return { cab: { path: node.path, data }, resS };
}

test("m_StreamData: the vertex data is read from the .resS it names", () => {
  const { cab, resS } = streamedFixture();
  const env = load([
    { name: cab.path, data: cab.data },
    { name: "CAB-mesh.resS", data: resS },
  ]);
  const { geometry: mesh, m_VertexData } = meshOf(env).read<MeshData>();
  assert.equal(m_VertexData!.m_DataSize.length, 0);
  assert.deepStrictEqual(mesh.vertices, Float32Array.of(0, 0, 0, 0, 1, 0, 1, 0, 0));
  assert.deepStrictEqual(mesh.indices, [Uint32Array.of(0, 1, 2)]);
});

test("m_StreamData: a .resS not loaded throws ResourceNotFoundError, unless no vertices", () => {
  const { cab } = streamedFixture();
  const obj = meshOf(load([{ name: cab.path, data: cab.data }]));
  const { path } = readMesh(obj).m_StreamData;
  assert.ok(path.endsWith("CAB-mesh.resS"));
  assert.throws(
    () => obj.read(),
    (err: unknown) =>
      err instanceof ResourceNotFoundError && err.path === path && err.fileName === "CAB-mesh.resS",
  );
  // A reader not built by load() has no files to look in.
  const { bytes } = handBuilt({ vertexCount: 1, streamData: { offset: 0, size: 12, path } });
  assert.throws(() => readerOf(FROM_2020, bytes, { unity: U2020 }).read(), ResourceNotFoundError);
  // Upstream reads the resource only for a mesh with vertices.
  const empty = streamedFixture(0).cab;
  const none = meshOf(load([{ name: empty.path, data: empty.data }]));
  assert.equal(none.read<MeshData>().geometry.vertexCount, 0);
});

// --- the hand-built layouts through Unity's own type trees ----------------------------

for (const { name, unity } of TYPE_TREES) {
  test(`${name}: a hand-built Mesh reads the same through Unity's own type tree`, () => {
    const from = template(name, ClassID.Mesh);
    for (const input of [{ rich: true }, COMPRESSED, STREAMS]) {
      const { bytes } = build((w) => meshLayout(w, unity, input));
      const reader = readerOf(from, bytes, { unity });
      assert.ok(reader.serializedType?.nodes?.length, "no type tree");
      const tree = withNumberOffset(reader.readTypeTree() as Record<string, unknown>);
      const mesh = readMesh(reader);
      assert.deepEqual(Object.keys(mesh), Object.keys(tree));
      assert.deepStrictEqual(mesh, tree);
    }
  });
}

/** `fixtures/tpk-trees.json`: Unity's player type trees from UnityPy's TPK data (R12). */
const TPK = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/tpk-trees.json", import.meta.url), "utf8"),
  ) as { classes: Record<string, Record<string, GoldenNode[]>> }
).classes[String(ClassID.Mesh)]!;

/** A TPK tree as the nodes a SerializedFile's type would hold. */
const typeTreeNodes = (nodes: GoldenNode[]): TypeTreeNode[] =>
  nodes.map(([level, type, name, byteSize, metaFlag], index) => ({
    level,
    type,
    name,
    byteSize,
    metaFlag,
    index,
    typeFlags: 0,
    version: 1,
    typeStrOffset: 0,
    nameStrOffset: 0,
    refTypeHash: 0n,
  }));

/** Packed vectors in every slot a version may have, including 3.5 to 4.x's colours. */
const PACKED_ALL: MeshInput = {
  rich: true,
  compressed: {
    m_Vertices: { bits: 3, range: 7, items: [1, 2, 3] },
    m_UV: { bits: 2, range: 3, items: [1, 2] },
    m_BindPoses: { bits: 1, items: new Array(16).fill(1) },
    m_Normals: { bits: 1, items: [1, 0] },
    m_NormalSigns: { bits: 1, items: [1] },
    m_FloatColors: { bits: 2, range: 3, items: [3, 2, 1, 0] },
    m_Colors: { bits: 32, items: [0x01020304] },
    m_Triangles: { bits: 2, items: [0, 0, 0] },
  },
};

test("TPK has a Mesh tree at every gate this reader knows, from 3.4 to 6000.6", () => {
  assert.deepEqual(Object.keys(TPK), [
    "3.4.0",
    "3.5.0",
    "3.5.1",
    "4.0.0",
    "4.1.0",
    "4.3.0",
    "5.0.0",
    "5.3.5",
    "5.5.0",
    "5.6.0",
    "2017.1b1",
    "2017.3b1",
    "2018.1b2",
    "2018.2b1",
    "2018.3b1",
    "2019.1a10",
    "2020.1a19",
    "2022.1a15",
    "6000.2a8",
    "6000.6a5",
  ]);
});

for (const [key, nodes] of Object.entries(TPK)) {
  test(`TPK ${key}: a hand-built Mesh reads the same through Unity's type tree`, () => {
    const [, major, minor, patch = "0"] = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(key)!;
    // 2017.3: a compressed mesh has m_IndexFormat from 2017.3.1p1 (see readMesh).
    const is2017_3 = key.startsWith("2017.3");
    const unity: UnityVersion = [+major!, +minor!, is2017_3 ? 1 : +patch, 1];
    const buildType = is2017_3 ? "p" : "f";
    const serializedType = { ...FROM_2020.info.serializedType!, nodes: typeTreeNodes(nodes) };
    const from = {
      sf: { ...FROM_2020.sf, buildType },
      info: { ...FROM_2020.info, serializedType },
    };
    for (const input of [{ rich: true }, PACKED_ALL]) {
      const { bytes } = build((w) => meshLayout(w, unity, input, buildType));
      const reader = readerOf(from, bytes, { unity });
      const tree = withNumberOffset(reader.readTypeTree() as Record<string, unknown>);
      const mesh = readMesh(reader);
      assert.deepEqual(Object.keys(mesh), Object.keys(tree));
      assert.deepStrictEqual(mesh, tree);
    }
  });
}

test("2017.3: m_IndexFormat as upstream gates it, by mesh compression and patch release", () => {
  const compressed = { compressed: { m_Vertices: { bits: 1, items: [0, 0, 0] } } };
  const has = (input: MeshInput, unity: UnityVersion, buildType: string) =>
    "m_IndexFormat" in readMesh(handBuilt(input, unity, buildType).reader);
  assert.equal(has({}, [2017, 3, 0, 3], "f"), true);
  assert.equal(has(compressed, [2017, 3, 0, 3], "f"), false);
  assert.equal(has(compressed, [2017, 3, 1, 1], "f"), false);
  assert.equal(has(compressed, [2017, 3, 1, 2], "p"), true);
  assert.equal(has(compressed, [2017, 4, 0, 1], "f"), true);
  assert.equal(has(compressed, [2017, 2, 0, 1], "f"), false);
});

// --- decoding before 2019 ---------------------------------------------------------------

/** An `UnsupportedError("vertex format")` naming `format`. */
const formatRefusal = (err: unknown, format: number): boolean =>
  err instanceof UnsupportedError && err.kind === "vertex format" && err.found === format;

test("3.4: the vertex arrays, colours by byte, m_Use16BitIndices 0, an isTriStrip submesh", () => {
  const input: MeshInput = {
    use16: 0,
    legacy: {
      vertices: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      uv: [[0.5, 0.25]],
      uv1: [[0.75, 1]],
      tangents: [[1, 0, 0, -1]],
      normals: [[0, 0, 1]],
      colors: [0x80ff0040],
    },
    skin: [[[0.5, 0.5, 0, 0], [1, 2, 0, 0]]],
    indexBuffer: bytesOf(["u32", 70000], ["u32", 1], ["u32", 2], ["u32", 0]),
    subMeshes: [{ firstByte: 0, indexCount: 4, topology: 1 }],
  };
  const geometry = handBuilt(input, [3, 4, 0, 1]).reader.read<MeshData>().geometry;
  assert.equal(geometry.vertexCount, 3);
  assert.deepStrictEqual(geometry.vertices, Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9));
  assert.deepStrictEqual(geometry.uv[0], Float32Array.of(0.5, 0.25));
  assert.deepStrictEqual(geometry.uv[1], Float32Array.of(0.75, 1));
  assert.deepStrictEqual(geometry.tangents, Float32Array.of(1, 0, 0, -1));
  assert.deepStrictEqual(geometry.normals, Float32Array.of(0, 0, 1));
  // The word's bytes in file order (little-endian): 0x40, 0x00, 0xff, 0x80.
  assert.deepStrictEqual(geometry.colors, Float32Array.of(f(64 / 255), 0, 1, f(128 / 255)));
  assert.deepStrictEqual(geometry.skin, [{ weight: [0.5, 0.5, 0, 0], boneIndex: [1, 2, 0, 0] }]);
  // 32-bit indices; before 4.0 isTriStrip makes a strip: (70000, 1, 2), then (2, 1, 0) flipped.
  assert.deepStrictEqual(geometry.indices, [Uint32Array.of(70000, 1, 2, 2, 1, 0)]);
  // Any value but 0 is a strip before 4.0, where 4.0 would read 2 as quads.
  const two = { ...input, subMeshes: [{ firstByte: 0, indexCount: 4, topology: 2 }] };
  assert.deepStrictEqual(
    handBuilt(two, [3, 4, 0, 1]).reader.read<MeshData>().geometry.indices,
    geometry.indices,
  );
});

test("3.5: four streams whose masks place the channels; packed colours and bind poses", () => {
  const input: MeshInput = {
    vertexCount: 2,
    // Stream 0: position, normal, UV0 (mask 0b1011), stride 32; stream 1: colour.
    streams: [
      [0b1011, 0, 32],
      [0b0100, 64, 4],
    ],
    vertexData: bytesOf(
      ...[1, 2, 3, 0, 0, 1, 0.5, 0.25, 4, 5, 6, 0, 1, 0, 0.75, 1].map(
        (x): [string, number] => ["f32", x],
      ),
      ["u8", 255], ["u8", 0], ["u8", 51], ["u8", 102],
      ["u8", 0], ["u8", 255], ["u8", 0], ["u8", 255],
    ),
    skin: [
      [[1, 0, 0, 0], [3, 0, 0, 0]],
      [[0.25, 0.75, 0, 0], [1, 2, 0, 0]],
    ],
    compressed: {
      // 16 floats a pose, each 0 or 1.
      m_BindPoses: { bits: 1, items: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    },
  };
  const geometry = handBuilt(input, [3, 5, 7, 1]).reader.read<MeshData>().geometry;
  assert.equal(geometry.vertexCount, 2);
  assert.deepStrictEqual(geometry.vertices, Float32Array.of(1, 2, 3, 4, 5, 6));
  assert.deepStrictEqual(geometry.normals, Float32Array.of(0, 0, 1, 0, 1, 0));
  assert.deepStrictEqual(geometry.uv[0], Float32Array.of(0.5, 0.25, 0.75, 1));
  assert.deepStrictEqual(
    geometry.colors,
    Float32Array.from([255, 0, 51, 102, 0, 255, 0, 255], (x) => f(x / 255)),
  );
  assert.deepStrictEqual(geometry.skin, [
    { weight: [1, 0, 0, 0], boneIndex: [3, 0, 0, 0] },
    { weight: [0.25, 0.75, 0, 0], boneIndex: [1, 2, 0, 0] },
  ]);
  const identity = Object.fromEntries(
    [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => [`e${r}${c}`, r === c ? 1 : 0])),
  );
  assert.deepStrictEqual(geometry.bindPoses, [identity]);

  // Packed colours replace the streams': a quarter of m_BitSize per channel.
  const packed = {
    ...input,
    compressed: {
      m_Colors: {
        bits: 32,
        items: [],
        numItems: 2,
        data: Uint8Array.of(255, 0, 51, 102, 1, 2, 3, 4),
      },
    },
  };
  assert.deepStrictEqual(
    handBuilt(packed, [3, 5, 7, 1]).reader.read<MeshData>().geometry.colors,
    Float32Array.from([255, 0, 51, 102, 1, 2, 3, 4], (x) => f(x / 255)),
  );
});

test("4.x: the stream table, pre-2017 formats and channel numbering, a 3-wide Color", () => {
  const input: MeshInput = {
    vertexCount: 1,
    // 0 position (Float), 2 colour (Color, dimension 3 read as 4), 3 UV0 (Byte:
    // an integer format, so absent), 5 tangent (Float16, before 5.0).
    channels: [
      [0, 0, 0, 3],
      [0, 0, 0, 0],
      [0, 12, 2, 3],
      [0, 16, 3, 2],
      [0, 0, 0, 0],
      [0, 18, 1, 4],
    ],
    streams: [[0b101101, 0, 26]],
    vertexData: bytesOf(
      ["f32", 1], ["f32", 2], ["f32", 3],
      ["u8", 255], ["u8", 0], ["u8", 0], ["u8", 255],
      ["u8", 7], ["u8", 8],
      ["f16", 0x3c00], ["f16", 0], ["f16", 0], ["f16", 0xbc00],
    ),
  };
  const geometry = handBuilt(input, [4, 7, 2, 1]).reader.read<MeshData>().geometry;
  assert.deepStrictEqual(geometry.vertices, Float32Array.of(1, 2, 3));
  assert.deepStrictEqual(geometry.colors, Float32Array.of(1, 0, 0, 1));
  assert.equal(geometry.uv[0], undefined);
  assert.deepStrictEqual(geometry.tangents, Float32Array.of(1, 0, 0, -1));
  // A format VertexChannelFormat does not have.
  const channels = input.channels!.map((c, i): Channel => (i === 3 ? [0, 16, 5, 2] : c));
  assert.throws(
    () => handBuilt({ ...input, channels }, [4, 7, 2, 1]).reader.read(),
    (err: unknown) => formatRefusal(err, 5),
  );
});

test("2017 to 2018.1: VertexFormat2017 and channel 5 as UV2, 7 as the tangent", () => {
  const input: MeshInput = {
    vertexCount: 1,
    // 0 position (Float), 5 UV2 (SNorm8: 4 in 2017's numbering), 7 tangent (Float).
    channels: [
      [0, 0, 0, 3],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 12, 4, 2],
      [0, 0, 0, 0],
      [0, 14, 0, 4],
    ],
    vertexData: bytesOf(
      ["f32", 1], ["f32", 2], ["f32", 3],
      ["i8", 127], ["i8", -127],
      ["f32", 0], ["f32", 1], ["f32", 0], ["f32", -1],
    ),
  };
  const geometry = handBuilt(input, [2017, 4, 40, 1]).reader.read<MeshData>().geometry;
  assert.deepStrictEqual(geometry.vertices, Float32Array.of(1, 2, 3));
  assert.deepStrictEqual(geometry.uv[2], Float32Array.of(1, -1));
  assert.deepStrictEqual(geometry.tangents, Float32Array.of(0, 1, 0, -1));
  // 13 is past VertexFormat2017.
  const channels = input.channels!.map((c, i): Channel => (i === 5 ? [0, 12, 13, 2] : c));
  assert.throws(
    () => handBuilt({ ...input, channels }, [2017, 4, 40, 1]).reader.read(),
    (err: unknown) => formatRefusal(err, 13),
  );
});

test("2018.1: bone channels write into m_Skin, or a new skin when it is empty", () => {
  const channels: Channel[] = [
    ...new Array<Channel>(12).fill([0, 0, 0, 0]),
    [0, 0, 0, 1],
    [0, 4, 10, 1],
  ];
  const vertexData = bytesOf(["f32", 0.5], ["u32", 9]);
  const skin: MeshInput["skin"] = [[[0, 0.25, 0, 0], [0, 4, 0, 0]]];
  const input: MeshInput = { vertexCount: 1, channels, vertexData, skin };
  const read = (skin?: MeshInput["skin"]) =>
    handBuilt({ ...input, skin }, [2018, 1, 0, 1]).reader.read<MeshData>().geometry.skin;
  // The channels' first weight and index over m_Skin's.
  assert.deepStrictEqual(read(skin), [{ weight: [0.5, 0.25, 0, 0], boneIndex: [9, 4, 0, 0] }]);
  assert.deepStrictEqual(read([]), [{ weight: [0.5, 0, 0, 0], boneIndex: [9, 0, 0, 0] }]);
});

test("asset.data before 2019: Unity's arrays by their names, the decoded ones in geometry", () => {
  const v3_4 = handBuilt({ rich: true }, [3, 4, 0, 1]).reader.read<MeshData>();
  const fields3_4 = toMeshFields(v3_4);
  assert.equal(fields3_4.geometry, v3_4.geometry);
  assert.equal(fields3_4.use16BitIndices, 1);
  assert.equal(fields3_4.vertices, v3_4.m_Vertices);
  assert.equal(fields3_4.uv1, v3_4.m_UV1);
  assert.equal(fields3_4.colors, v3_4.m_Colors);
  assert.deepStrictEqual(fields3_4.geometry.vertices, Float32Array.of(1, 2, 3));

  const v3_5 = handBuilt({ rich: true }, [3, 5, 7, 1]).reader.read<MeshData>();
  const vertexData = toMeshFields(v3_5).vertexData!;
  assert.deepEqual(Object.keys(vertexData), [
    "currentChannels",
    "vertexCount",
    "streams[0]",
    "streams[1]",
    "streams[2]",
    "streams[3]",
    "data",
  ]);
  assert.equal(vertexData["streams[0]"], v3_5.m_VertexData!["m_Streams[0]"]);

  const v4_1 = handBuilt({ rich: true }, [4, 1, 0, 1]).reader.read<MeshData>();
  const fields4_1 = toMeshFields(v4_1);
  assert.equal(fields4_1.shapes, v4_1.m_Shapes);
  assert.equal(fields4_1.shapeVertices, v4_1.m_ShapeVertices);
  assert.equal(fields4_1.streamCompression, 1);
});
