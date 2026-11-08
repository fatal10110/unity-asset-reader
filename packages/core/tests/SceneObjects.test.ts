// GameObject, Transform, MeshFilter, MeshRenderer and SkinnedMeshRenderer
// (#305): the hardcoded readers against readTypeTree() on every object of the
// scene fixtures (fixtures/BUILDING.md section 24) and of every other fixture
// holding one, typed and not, and on objects laid out from Unity's own player
// type trees at every version TPK records (`fixtures/tpk-trees.json`,
// UnityPy's TPK data, R12), with every array filled.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { readGameObject } from "../src/classes/GameObject.js";
import { readMeshFilter } from "../src/classes/MeshFilter.js";
import { readMeshRenderer, readSkinnedMeshRenderer } from "../src/classes/Renderer.js";
import { readTransform } from "../src/classes/Transform.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { fixturesWith, typedTwin } from "./class-readers.js";
import { readerOf, versionRefusal, withTail, type Template } from "./media.js";
import { filled, serializedOf, TPK, tpkReader, treeAt, versionOf } from "./tpk-layouts.js";

type Reader = (reader: ObjectReader) => object;

/** The five classes, by class id, with their readers. */
const READERS = new Map<number, [string, Reader]>([
  [ClassID.GameObject, ["GameObject", readGameObject]],
  [ClassID.Transform, ["Transform", readTransform]],
  [ClassID.MeshFilter, ["MeshFilter", readMeshFilter]],
  [ClassID.MeshRenderer, ["MeshRenderer", readMeshRenderer]],
  [ClassID.SkinnedMeshRenderer, ["SkinnedMeshRenderer", readSkinnedMeshRenderer]],
]);

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
/** Every scene bundle: typed and not, per editor (6000.6.4f1's in modern-goldens.json). */
const SCENE = EDITORS.flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map((kind) => `editor/${editor}/scene/${kind}/scene`),
);

/**
 * Per scene bundle (fixtures/BUILDING.md section 24): the `scene` prefab's
 * ten GameObjects and the `humanoid` prefab's 22, one renderer of each kind.
 */
const SCENE_COUNTS = new Map<number, number>([
  [ClassID.GameObject, 32],
  [ClassID.Transform, 32],
  [ClassID.MeshFilter, 1],
  [ClassID.MeshRenderer, 1],
  [ClassID.SkinnedMeshRenderer, 1],
]);

/**
 * Every fixture holding one of the classes: those of goldens.json, by their
 * golden object tables, and the 6000.6 bundles of modern-goldens.json.
 */
const FIXTURES = [
  ...new Set([
    ...[...READERS.keys()].flatMap(fixturesWith),
    ...SCENE,
    "editor/6000.6.4f1/animator/lz4/animator",
    "editor/6000.6.4f1/animator/lz4-notypetree/animator",
    "editor/6000.6.4f1/legacy-animation/lz4/legacy-animation",
    "editor/6000.6.4f1/legacy-animation/lz4-notypetree/legacy-animation",
    "editor/6000.6.4f1/ui-animation/lz4/ui-animation",
    "editor/6000.6.4f1/ui-animation/lz4-notypetree/ui-animation",
  ]),
].sort();

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

test("the scene, animator, legacy-animation, ui-animation and humanoid bundles are the fixtures that hold the five classes", () => {
  // The animator bundles (#303) hold GameObjects and Transforms too, the
  // legacy-animation ones (#314) a SkinnedMeshRenderer as well, and so do the
  // humanoid oracle's (#318), those of goldens.json (6000.6's is not listed above);
  // the ui-animation ones (#315) GameObjects only (their Transforms are RectTransforms).
  const others = FIXTURES.filter((name) => !SCENE.includes(name));
  const animator = EDITORS.flatMap((e) =>
    ["animator", "legacy-animation", "ui-animation"].flatMap((set) =>
      ["lz4", "lz4-notypetree"].map((kind) => `editor/${e}/${set}/${kind}/${set}`),
    ),
  );
  const humanoid = EDITORS.filter((e) => e !== "6000.6.4f1").map(
    (e) => `editor/${e}/humanoid/lz4/humanoid`,
  );
  assert.deepEqual(others, [...animator, ...humanoid].sort());
});

for (const name of FIXTURES) {
  const typed = !name.includes("/lz4-notypetree/");

  test(`${name}: every GameObject, Transform and renderer reads as readTypeTree()`, () => {
    const env = loadName(name);
    const twin = typed ? env : loadName(typedTwin(name));
    const { sf, bytes } = serializedOf(name);
    for (const [classId, [owner, read]] of READERS) {
      const objects = env.objects.filter((o) => o.type === classId);
      if (SCENE.includes(name)) assert.equal(objects.length, SCENE_COUNTS.get(classId), owner);
      const info = sf.objects.find((o) => o.classId === classId);
      for (const reader of objects) {
        const where = `${owner} ${reader.pathId}`;
        const data = read(reader);
        assert.equal(reader.position, reader.byteSize, `${where}: byteSize not consumed exactly`);
        // obj.read() dispatches to the same reader.
        assert.deepStrictEqual(reader.read(), data, where);
        const twinTree = twin.objects.find((o) => o.pathId === reader.pathId)!.readTypeTree();
        if (typed) {
          // Every field, in Unity's order.
          assert.deepEqual(Object.keys(data), Object.keys(twinTree), where);
          assert.deepStrictEqual(data, twinTree, where);
          continue;
        }
        // The same bytes through Unity's own tree of the version (TPK), and the typed twin.
        const version = { unity: reader.version, text: reader.unityVersion };
        const from: Template = { sf, info: info! };
        const tree = tpkReader(from, bytes(reader.pathId), treeAt(classId, reader.version), version);
        assert.deepStrictEqual(data, tree.readTypeTree(), `${where} (TPK tree)`);
        assert.deepStrictEqual(data, twinTree, `${where} (typed twin)`);
      }
    }
  });
}

test("the scene fixtures hold what the editor script made", () => {
  for (const editor of EDITORS) {
    const env = loadName(`editor/${editor}/scene/lz4-notypetree/scene`);
    const of = <T>(classId: number, read: (r: ObjectReader) => T): T[] =>
      env.objects.filter((o) => o.type === classId).map(read);
    const objects = of(ClassID.GameObject, readGameObject);
    const byName = (name: string) => objects.find((g) => g.m_Name === name)!;
    // "Prop": layer 4, the Player tag (6), a Transform, a MeshFilter and a MeshRenderer.
    const prop = byName("Prop");
    assert.deepEqual([prop.m_Layer, prop.m_Tag, prop.m_Component.length], [4, 6, 3], editor);
    assert.equal(byName("Hidden").m_IsActive, false, editor);
    assert.equal(objects.filter((g) => !g.m_IsActive).length, 1, editor);
    // The roots: "scene" with its Animator, "humanoid" with its own.
    assert.equal(byName("scene").m_Component.length, 2, editor);

    const transforms = of(ClassID.Transform, readTransform);
    const roots = transforms.filter((t) => t.m_Father.m_PathID === 0n);
    assert.equal(roots.length, 2, editor);
    // Prop's Transform, its first component: rotated, scaled, Hidden its child.
    const propTransform = transforms.find(
      (_, i) => env.objects.filter((o) => o.type === ClassID.Transform)[i]!.pathId ===
        prop.m_Component[0]!.component.m_PathID,
    )!;
    assert.deepEqual(propTransform.m_LocalScale, { x: 2, y: 0.5, z: 1 }, editor);
    assert.deepEqual(propTransform.m_LocalPosition, { x: 2, y: 0, z: 0 }, editor);
    assert.equal(propTransform.m_Children.length, 1, `${editor}: Hidden under Prop`);

    const [skin] = of(ClassID.SkinnedMeshRenderer, readSkinnedMeshRenderer);
    assert.deepEqual(skin!.m_BlendShapeWeights, [25, 60], editor);
    assert.equal(skin!.m_Bones.length, 5, editor);
    assert.deepEqual(skin!.m_RootBone, skin!.m_Bones[0], editor);
    assert.deepEqual(
      [skin!.m_Quality, skin!.m_UpdateWhenOffscreen, skin!.m_CastShadows, skin!.m_SortingOrder],
      [2, true, 2, 3],
      editor,
    );
    assert.deepEqual(skin!.m_AABB.m_Extent, { x: 0.75, y: 1.5, z: 0.625 }, editor);
    // The material is in a bundle of its own: an external pointer.
    assert.equal(skin!.m_Materials.length, 1, editor);
    assert.equal(skin!.m_Materials[0]!.m_FileID, 1, editor);

    const [renderer] = of(ClassID.MeshRenderer, readMeshRenderer);
    assert.equal(renderer!.m_Materials.length, 2, editor);
    assert.equal(renderer!.m_SortingOrder, -2, editor);
    assert.equal("m_EnlightenVertexStream" in renderer!, editor !== "2019.4.41f2", editor);
    const [filter] = of(ClassID.MeshFilter, readMeshFilter);
    assert.deepEqual(filter!.m_Mesh, skin!.m_Mesh, `${editor}: one mesh`);
  }
});

test("the 6000.3 and 6000.6 renderers have every later field; 2019.4's none of them", () => {
  const later = [
    "m_StaticShadowCaster",
    "m_RayTracingAccelStructBuildFlagsOverride",
    "m_RayTracingAccelStructBuildFlags",
    "m_SmallMeshCulling",
    "m_ForceMeshLod",
    "m_MeshLodSelectionBias",
    "m_MaskInteraction",
  ];
  for (const editor of EDITORS) {
    const env = loadName(`editor/${editor}/scene/lz4/scene`);
    const renderers = [
      ...env.objects.filter((o) => o.type === ClassID.MeshRenderer).map(readMeshRenderer),
      ...env.objects
        .filter((o) => o.type === ClassID.SkinnedMeshRenderer)
        .map(readSkinnedMeshRenderer),
    ];
    for (const r of renderers) {
      const has = later.filter((key) => key in r);
      assert.deepEqual(has, editor.startsWith("6000.") ? later : [], editor);
      assert.equal("m_RayTracingMode" in r, true, editor);
      assert.equal("m_RayTraceProcedural" in r, editor !== "2019.4.41f2", editor);
    }
  }
});

// --- hand-built layouts at every TPK version ---------------------------------------------

/** A fixture object of each class, for its file and type entry. */
const TEMPLATE = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/scene/lz4/scene");
  return (classId: number): Template => ({
    sf,
    info: sf.objects.find((o) => o.classId === classId)!,
  });
})();

/**
 * TPK's MeshRenderer tree of 2020.1.0a7, without `m_RayTraceProcedural`: the
 * gates compare release numbers only (the ponytail in
 * `readSkinnedMeshRenderer`), so the reader reads it as 2020.1's layout.
 */
const PRE_RELEASES = new Set([`${ClassID.MeshRenderer} 2020.1.0a7`]);

test("TPK has a tree at every gate the readers know, from 2019.1 to 6000.6", () => {
  const keys = (id: number) => Object.keys(TPK[String(id)]!);
  assert.deepEqual(keys(ClassID.GameObject), ["2018.4.26f1", "6000.6.0a5"]);
  assert.deepEqual(keys(ClassID.MeshFilter), ["2018.3.0b1", "6000.6.0a5"]);
  // Flags only after 2018.3: one layout.
  assert.equal(keys(ClassID.Transform)[0], "2018.3.0b1");
  const renderer = [
    "2018.3.0b1",
    "2019.2.0a6",
    "2019.3.0a6", // m_RayTracingMode
    "2020.1.0a19", // m_RayTraceProcedural
    "2020.2.0a13",
    "2021.1.0a2", // m_StaticShadowCaster
    "2023.2.0a13", // m_RayTracingAccelStructBuildFlags*
    "2023.3.0a16", // m_SmallMeshCulling
    "6000.2.0a8", // m_ForceMeshLod, m_MeshLodSelectionBias
    "6000.3.0a5", // m_MaskInteraction
    "6000.3.0b7",
    "6000.4.0a2",
    "6000.4.0a4",
    "6000.6.0a5",
  ];
  assert.deepEqual(keys(ClassID.SkinnedMeshRenderer), renderer);
  // m_EnlightenVertexStream, from 2020.1.0a7.
  assert.deepEqual(keys(ClassID.MeshRenderer), [
    ...renderer.slice(0, 3),
    "2020.1.0a7",
    ...renderer.slice(3),
  ]);
});

for (const [classId, [owner, read]] of READERS) {
  for (const [key, nodes] of Object.entries(TPK[String(classId)]!)) {
    test(`TPK ${owner} ${key}: a filled object reads the same through Unity's type tree`, () => {
      const version = versionOf(key);
      const reader = tpkReader(TEMPLATE(classId), filled(nodes), nodes, version);
      const tree = reader.readTypeTree() as object;
      assert.equal(reader.position, reader.byteSize);
      let same: boolean;
      try {
        const data = read(reader);
        assert.equal(reader.position, reader.byteSize);
        assert.deepEqual(Object.keys(data), Object.keys(tree));
        assert.deepStrictEqual(data, tree);
        same = true;
      } catch (error) {
        if (!PRE_RELEASES.has(`${classId} ${key}`)) throw error;
        same = false;
      }
      assert.equal(same, !PRE_RELEASES.has(`${classId} ${key}`), "a listed pre-release reads");
    });
  }
}

// --- refusals --------------------------------------------------------------------------

/** One fixture object of each class: its file, entry and bytes. */
function fixtureObject(classId: number): { from: Template; bytes: Uint8Array } {
  const { sf, bytes } = serializedOf("editor/2019.4.41f2/scene/lz4/scene");
  const info = sf.objects.find((o) => o.classId === classId)!;
  return { from: { sf, info }, bytes: bytes(info.pathId) };
}

for (const [classId, [owner, read]] of READERS) {
  test(`${owner}: older than 2019.1, unknown outside 2019's formats, or an editor file is refused`, () => {
    const { from, bytes } = fixtureObject(classId);
    const older = readerOf(from, bytes, { unity: [2018, 4, 36, 1] });
    assert.throws(() => read(older), versionRefusal("2018.4.36"));
    const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
    assert.throws(
      () => read(readerOf(from, bytes, { ...stripped, format: 22 })),
      versionRefusal("0.0.0"),
    );
    const editor = readerOf(from, bytes, {
      unity: [2019, 4, 41, 2],
      platform: BuildTarget.NoTarget,
    });
    assert.throws(
      () => read(editor),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
    );
  });

  test(`${owner}: an unknown version in format 21 reads as 2019; a misfit is refused`, () => {
    const { from, bytes } = fixtureObject(classId);
    const known = read(readerOf(from, bytes, { unity: [2019, 4, 41, 2] }));
    const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0", format: 21 };
    assert.deepStrictEqual(read(readerOf(from, bytes, stripped)), known);
    // Bytes too many are not 2019's layout, which the file cannot tell from corruption.
    assert.throws(
      () => read(readerOf(from, withTail(bytes, 0, 0, 0, 0), stripped)),
      versionRefusal("0.0.0"),
    );
  });

  test(`${owner}: a truncated object or bytes left over are corrupt`, () => {
    const { from, bytes } = fixtureObject(classId);
    const unity: UnityVersion = [2019, 4, 41, 2];
    assert.throws(
      () => read(readerOf(from, bytes.slice(0, bytes.length - 4), { unity })),
      CorruptError,
    );
    assert.throws(() => read(readerOf(from, withTail(bytes, 0, 0, 0, 0), { unity })), CorruptError);
  });
}
