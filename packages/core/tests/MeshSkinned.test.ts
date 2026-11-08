// The skinned mesh fixtures (#285; fixtures/BUILDING.md section 20): a Mesh
// with bone weights over five bones, bindposes, two blend shapes, tangents,
// Color32 colours, UV0 and UV1 and 32-bit indices, plain and compressed, from
// 2019.4, 2020.3, 6000.3 and 6000.6. `read()`'s skin is checked against
// UnityPy MeshHelper's (`skins` in goldens.json and modern-goldens.json) and,
// where c37af7d reads the file (formats 21 and 22), against AssetStudio's
// executed `m_Skin` (`skin` in assetstudio-export-goldens.json); the blend
// shapes against UnityPy's type-tree dump.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture, type Golden } from "../../../fixtures/helpers.js";
import { readMesh, type MeshData } from "../src/classes/Mesh.js";
import { load } from "../src/env.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import { typedTwin } from "./class-readers.js";

const f = Math.fround;
const json = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8")) as T;

/** UnityPy MeshHelper's skin of one Mesh (make-goldens.py, `skin_golden`). */
interface SkinGolden {
  source: "m_VertexData" | "m_CompressedMesh";
  boneWeights: string[][];
  boneIndices: number[][];
  derivedWeights?: { vertex: number; storedWeights: number[] }[];
  oracleNote?: string;
}
/** A fixture golden, with the `skins` of its SerializedFiles. */
type WithSkins = Golden & {
  serialized: Record<string, NonNullable<Golden["serialized"]>[string] & {
    skins?: Record<string, SkinGolden>;
  }>;
};
/** AssetStudio's export entry of one Mesh, with its executed `m_Skin`. */
interface ExportEntry {
  class: string;
  skin?: { boneWeights: string[][]; boneIndices: number[][] };
}

const modern = json<{ fixtures: Record<string, WithSkins> }>("modern-goldens.json").fixtures;
const exports = json<{
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
}>("assetstudio-export-goldens.json").fixtures;

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1"];
/** The format-21/22 bundles, in goldens.json. */
const SKINNED = fixtureNames().filter((name) => /\/mesh-skinned(-compressed)?$/.test(name));
/** The 6000.6 (format 23) bundles, typed only, in modern-goldens.json. */
const MODERN = Object.keys(modern).filter((name) => /\/mesh-skinned(-compressed)?$/.test(name));

/** The oracle golden of a fixture: its typed twin's, in whichever file holds it. */
const goldenOf = (name: string): WithSkins =>
  modern[typedTwin(name)] ?? (golden(typedTwin(name)) as WithSkins);

/** The one Mesh of a fixture: its reader, `read()` and where the golden has it. */
function meshOf(name: string): { reader: ObjectReader; mesh: MeshData; file: string; pathId: string } {
  const env = load([{ name, data: loadFixture(name) }]);
  const meshes = env.objects.filter((o) => o.type === ClassID.Mesh);
  assert.equal(meshes.length, 1, name);
  const reader = meshes[0]!;
  return { reader, mesh: reader.read<MeshData>(), file: reader.fileName, pathId: String(reader.pathId) };
}

/** A float as the goldens write it (plan §5): its float32 bits, big-endian hex. */
function f32(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return `f32:${view.getUint32(0).toString(16).padStart(8, "0")}`;
}

/** `value` normalized as the golden dump `expected` is: floats where it has `f32:`. */
function normalize(value: unknown, expected: unknown): unknown {
  if (typeof value === "number" && typeof expected === "string" && expected.startsWith("f32:")) {
    return f32(value);
  }
  if (Array.isArray(value)) {
    assert.ok(Array.isArray(expected));
    return value.map((item, i) => normalize(item, expected[i]));
  }
  if (value !== null && typeof value === "object") {
    const fields = expected as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item, fields[key])]),
    );
  }
  return value;
}

test("the skinned mesh bundles: 2019.4, 2020.3 and 6000.3 typed and not, 6000.6 typed", () => {
  const want = EDITORS.flatMap((editor) =>
    ["lz4-notypetree/mesh-skinned", "lz4/mesh-skinned", "lz4/mesh-skinned-compressed"]
      // 2020.3.30f1 saves a Mesh with bone weights uncompressed whatever
      // SetMeshCompression says (fixtures/BUILDING.md section 20).
      .filter((bundle) => editor !== "2020.3.30f1" || !bundle.endsWith("-compressed"))
      .map((bundle) => `editor/${editor}/mesh/${bundle}`),
  );
  assert.deepEqual([...SKINNED].sort(), want.sort());
  assert.deepEqual([...MODERN].sort(), [
    "editor/6000.6.4f1/mesh/lz4/mesh-skinned",
    "editor/6000.6.4f1/mesh/lz4/mesh-skinned-compressed",
  ]);
});

// fixtures/BUILDING.md section 20, BuildSkinnedMeshes.cs: the source values, as float32.
const VERTICES = Float32Array.of(
  ...[0, 0, 0, 1, 0, 0.125, 0, 1, -0.25, 1, 1, 0.5],
  ...[0, 2, 0.75, 1, 2, -0.5, 0.25, 3, 0, 1.5, 3, 0.375],
);
const NORMALS = Float32Array.of(
  ...[0, 0, -1, 0.6, 0, -0.8, 0, 0.6, -0.8, 0, 1, 0],
  ...[-0.8, 0, -0.6, 1, 0, 0, 0, -0.8, -0.6, 0, 0, 1],
);
const TANGENTS = Float32Array.of(
  ...[1, 0, 0, 1, 0.8, 0, 0.6, 1, 1, 0, 0, -1, 0, 0, 1, 1],
  ...[0.6, 0, -0.8, -1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, -1],
);
const UV0 = Float32Array.of(0, 0, 1, 0, 0, 0.25, 1, 0.25, 0, 0.5, 1, 0.5, 0.125, 0.75, 0.875, 1);
const UV1 = Float32Array.of(
  ...[0.5, 0.5, 0.75, 0.5, 0.5, 0.625, 0.75, 0.625],
  ...[0.5, 0.75, 0.75, 0.75, 0.5, 0.875, 0.75, 1],
);
const COLORS32 = [
  ...[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 128],
  ...[0, 255, 255, 64, 255, 0, 255, 0, 12, 34, 56, 78, 200, 150, 100, 50],
];
const TRIANGLES = Uint32Array.of(0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5, 5, 6, 7);

for (const name of [...SKINNED, ...MODERN]) {
  const compressed = name.endsWith("-compressed");

  test(`${name}: the asset as BuildSkinnedMeshes.cs made it`, () => {
    const { mesh } = meshOf(name);
    assert.equal(mesh.m_Name, compressed ? "skinned-compressed" : "skinned");
    assert.equal(mesh.m_IndexFormat, 1, "32-bit indices");
    assert.deepStrictEqual(mesh.indices, [TRIANGLES]);
    assert.equal(mesh.vertexCount, 8);
    assert.equal(mesh.m_BindPose.length, 5);
    assert.ok(mesh.tangents && mesh.colors && mesh.uv[0] && mesh.uv[1], "every channel kept");
    if (compressed) {
      // Mesh compression moved the vertices, the skin, both UV channels,
      // tangents and colours into m_CompressedMesh.
      assert.equal(mesh.m_VertexData.m_VertexCount, 0);
      assert.ok(mesh.m_CompressedMesh.m_Weights.m_NumItems > 0);
      assert.ok(mesh.m_CompressedMesh.m_BoneIndices.m_NumItems > 0);
      assert.ok(mesh.m_CompressedMesh.m_Tangents.m_NumItems > 0);
      assert.ok(mesh.m_CompressedMesh.m_UVInfo !== 0, "UV0 and UV1 described in m_UVInfo");
      return;
    }
    // Float32Array equality compares each element with Object.is.
    assert.deepStrictEqual(mesh.vertices, VERTICES);
    assert.deepStrictEqual(mesh.normals, NORMALS);
    assert.deepStrictEqual(mesh.tangents, TANGENTS);
    assert.deepStrictEqual(mesh.uv.slice(0, 2), [UV0, UV1]);
    assert.deepStrictEqual(mesh.colors, Float32Array.from(COLORS32, (c) => f(c / 255)));
  });

  test(`${name}: read()'s skin is UnityPy MeshHelper's, but for its derived fourth weights`, () => {
    const { mesh, file, pathId } = meshOf(name);
    const want = goldenOf(name).serialized[file]!.skins?.[pathId];
    assert.ok(want, `no skin golden for ${file} ${pathId}`);
    assert.equal(want.source, compressed ? "m_CompressedMesh" : "m_VertexData");
    const skin = mesh.skin!;
    assert.equal(skin.length, want.boneWeights.length);
    // The vertices with 1, 2, 3 and 4 influences of the source.
    assert.deepEqual(
      want.boneIndices.map((bones, v) => bones.filter((_, j) => want.boneWeights[v]![j] !== f32(0)).length),
      [1, 2, 2, 3, 3, 4, 4, 4],
    );
    const derived = new Map((want.derivedWeights ?? []).map((d) => [d.vertex, d.storedWeights]));
    if (compressed) assert.ok(derived.size > 0, "a 4-influence vertex with its fourth weight derived");
    else assert.equal(want.derivedWeights, undefined);
    skin.forEach((at, v) => {
      assert.deepEqual(at.boneIndex, want.boneIndices[v], `vertex ${v} bones`);
      const stored = derived.get(v);
      const weights = at.weight.map(f32);
      if (!stored) {
        assert.deepEqual(weights, want.boneWeights[v], `vertex ${v} weights`);
        return;
      }
      // plan §6, the oracle is wrong: UnityPy derives 1 - sum, with sum in
      // 31sts; AssetStudio (Mesh.cs, DecompressCompressedMesh) (31 - sum) / 31.
      const sum = stored.reduce((a, b) => a + b, 0);
      assert.match(want.oracleNote ?? "", /Verdict: AssetStudio/);
      assert.equal(want.boneWeights[v]![3], f32(1 - sum), `vertex ${v}: UnityPy's value`);
      assert.deepEqual(weights.slice(0, 3), want.boneWeights[v]!.slice(0, 3), `vertex ${v} weights`);
      assert.equal(at.weight[3], f((31 - sum) / 31), `vertex ${v}: the derived weight`);
    });
  });

  if (!MODERN.includes(name)) {
    test(`${name}: read()'s skin is AssetStudio's executed m_Skin`, () => {
      const { mesh, file, pathId } = meshOf(name);
      const want = exports[name]?.[file]?.[pathId]?.skin;
      assert.ok(want, `no AssetStudio skin for ${file} ${pathId}`);
      assert.deepEqual(mesh.skin!.map((at) => at.weight.map(f32)), want.boneWeights);
      assert.deepEqual(mesh.skin!.map((at) => at.boneIndex), want.boneIndices);
    });
  }

  if (name.includes("/lz4-notypetree/")) continue;

  test(`${name}: m_Shapes is UnityPy's type-tree dump, two shapes of 2 and 3 frames`, () => {
    const { reader, mesh, file, pathId } = meshOf(name);
    const dump = goldenOf(name).serialized[file]!.typetrees[pathId]!.value as Record<string, unknown>;
    assert.deepEqual(normalize(mesh.m_Shapes, dump.m_Shapes), dump.m_Shapes);
    assert.deepEqual(
      mesh.m_Shapes.channels.map((c) => [c.name, c.frameCount]),
      [["smile", 2], ["blink", 3]],
    );
    // Each frame moves four vertices, with normal and tangent deltas.
    assert.equal(mesh.m_Shapes.shapes.length, 5);
    for (const shape of mesh.m_Shapes.shapes) {
      assert.equal(shape.vertexCount, 4);
      assert.ok(shape.hasNormals && shape.hasTangents);
    }
    // And the whole Mesh is readTypeTree()'s, field by field.
    const tree = reader.readTypeTree() as Record<string, unknown>;
    const stream = tree.m_StreamData as { offset: bigint | number };
    const expected = { ...tree, m_StreamData: { ...stream, offset: Number(stream.offset) } };
    assert.deepStrictEqual(readMesh(reader), expected);
  });
}
