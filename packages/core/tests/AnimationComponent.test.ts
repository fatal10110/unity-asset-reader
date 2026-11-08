// The legacy Animation component (#314): the hardcoded reader against
// readTypeTree() on the legacy-animation fixtures (fixtures/BUILDING.md section
// 25), typed and not, and on objects laid out from Unity's own player type
// trees at every version TPK records (`fixtures/tpk-trees.json`, UnityPy's TPK
// data, R12), with the clip list filled.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import type { AnimationClip } from "../src/classes/AnimationClip.js";
import { readAnimation, type Animation } from "../src/classes/AnimationComponent.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { typedTwin } from "./class-readers.js";
import { readerOf, versionRefusal, withTail, type Template } from "./media.js";
import { filled, serializedOf, TPK, tpkReader, treeAt, versionOf } from "./tpk-layouts.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
/** Every legacy-animation bundle: typed and not, per editor (6000.6.4f1's in modern-goldens.json). */
const FIXTURES = EDITORS.flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map(
    (kind) => `editor/${editor}/legacy-animation/${kind}/legacy-animation`,
  ),
);

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

for (const name of FIXTURES) {
  const typed = !name.includes("/lz4-notypetree/");

  test(`${name}: the Animation reads as readTypeTree()`, () => {
    const env = loadName(name);
    const twin = typed ? env : loadName(typedTwin(name));
    const { sf, bytes } = serializedOf(name);
    const objects = env.objects.filter((o) => o.type === ClassID.Animation);
    assert.equal(objects.length, 1);
    const reader = objects[0]!;
    const data = readAnimation(reader);
    assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
    // obj.read() dispatches to the same reader.
    assert.deepStrictEqual(reader.read(), data);
    const twinTree = twin.objects.find((o) => o.pathId === reader.pathId)!.readTypeTree();
    if (typed) {
      // Every field, in Unity's order.
      assert.deepEqual(Object.keys(data), Object.keys(twinTree));
    } else {
      // The same bytes through Unity's own tree of the version (TPK).
      const from: Template = { sf, info: sf.objects.find((o) => o.pathId === reader.pathId)! };
      const version = { unity: reader.version, text: reader.unityVersion };
      const nodes = treeAt(ClassID.Animation, reader.version);
      const tree = tpkReader(from, bytes(reader.pathId), nodes, version).readTypeTree();
      assert.deepStrictEqual(data, tree, "TPK tree");
    }
    assert.deepStrictEqual(data, twinTree);
  });

  test(`${name}: the Animation lists the Mecanim clip "walk", every field set`, () => {
    const env = loadName(name);
    const reader = env.objects.find((o) => o.type === ClassID.Animation)!;
    const data = reader.read<Animation>();
    const clipName = (ptr: Animation["m_Animation"]): string => {
      const found = env.resolve(ptr, reader);
      assert.equal(found.status, "found");
      if (found.status !== "found") return "";
      assert.equal(found.object.type, ClassID.AnimationClip);
      return found.object.read<AnimationClip>().m_Name;
    };
    assert.equal(clipName(data.m_Animation), "walk");
    assert.deepEqual(data.m_Animations.map(clipName), ["walk"]);
    const walk = env.resolve(data.m_Animation, reader);
    assert.ok(walk.status === "found");
    assert.equal(walk.object.read<AnimationClip>().m_Legacy, false);
    const go = env.resolve(data.m_GameObject, reader);
    assert.ok(go.status === "found" && go.object.type === ClassID.GameObject);
    assert.equal(data.m_Enabled, 1);
    assert.equal(data.m_WrapMode, 4); // WrapMode.PingPong
    assert.equal(data.m_PlayAutomatically, false);
    assert.equal(data.m_AnimatePhysics, true);
    assert.equal(data.m_CullingType, 1); // AnimationCullingType.BasedOnRenderers
    // 2023.1+: m_UpdateMode, which the 6000.x builds set to 1.
    assert.equal(data.m_UpdateMode, name.includes("/6000.") ? 1 : undefined);
  });
}

// --- hand-built layouts at every TPK version ---------------------------------------------

const TEMPLATE: Template = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/legacy-animation/lz4/legacy-animation");
  return { sf, info: sf.objects.find((o) => o.classId === ClassID.Animation)! };
})();

test("TPK has an Animation tree at every gate the reader knows, from 2019.1 to 6000.6", () => {
  assert.deepEqual(Object.keys(TPK[String(ClassID.Animation)]!), [
    "2018.3.0b1",
    "2020.2.0a13", // the same fields (an array flag)
    "2023.1.0a5", // m_UpdateMode
    "6000.6.0a5", // the same fields (pointer flags)
  ]);
});

for (const [key, nodes] of Object.entries(TPK[String(ClassID.Animation)]!)) {
  test(`TPK Animation ${key}: a filled object reads the same through Unity's type tree`, () => {
    const reader = tpkReader(TEMPLATE, filled(nodes), nodes, versionOf(key));
    const tree = reader.readTypeTree() as object;
    assert.equal(reader.position, reader.byteSize);
    const data = readAnimation(reader);
    assert.equal(reader.position, reader.byteSize);
    assert.equal(data.m_Animations.length, 2);
    assert.deepEqual(Object.keys(data), Object.keys(tree));
    assert.deepStrictEqual(data, tree);
  });
}

test("the Animation gate between TPK's: 2022.3 has no m_UpdateMode, 2023.1 has it", () => {
  for (const [text, from, update] of [
    ["2022.3.62f1", "2020.2.0a13", false],
    ["2023.1.0f1", "2023.1.0a5", true],
  ] as const) {
    const nodes = TPK[String(ClassID.Animation)]![from]!;
    const reader = tpkReader(TEMPLATE, filled(nodes), nodes, versionOf(text));
    const tree = reader.readTypeTree();
    const data = readAnimation(reader);
    assert.deepStrictEqual(data, tree, text);
    assert.equal("m_UpdateMode" in data, update, text);
  }
});

// --- refusals --------------------------------------------------------------------------

function fixtureObject(): { from: Template; bytes: Uint8Array } {
  const { sf, bytes } = serializedOf("editor/2019.4.41f2/legacy-animation/lz4/legacy-animation");
  const info = sf.objects.find((o) => o.classId === ClassID.Animation)!;
  return { from: { sf, info }, bytes: bytes(info.pathId) };
}

test("Animation: older than 2019.1, unknown outside 2019's formats, or an editor file is refused", () => {
  const { from, bytes } = fixtureObject();
  const older = readerOf(from, bytes, { unity: [2018, 4, 36, 1] });
  assert.throws(() => readAnimation(older), versionRefusal("2018.4.36"));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
  assert.throws(
    () => readAnimation(readerOf(from, bytes, { ...stripped, format: 22 })),
    versionRefusal("0.0.0"),
  );
  const editor = readerOf(from, bytes, { unity: [2019, 4, 41, 2], platform: BuildTarget.NoTarget });
  assert.throws(
    () => readAnimation(editor),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
  );
});

test("Animation: an unknown version in format 21 reads as 2019; a misfit is refused", () => {
  const { from, bytes } = fixtureObject();
  const known = readAnimation(readerOf(from, bytes, { unity: [2019, 4, 41, 2] }));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0", format: 21 };
  assert.deepStrictEqual(readAnimation(readerOf(from, bytes, stripped)), known);
  // A field too many is not 2019's layout, which the file cannot tell from corruption.
  assert.throws(
    () => readAnimation(readerOf(from, withTail(bytes, 0, 0, 0, 0), stripped)),
    versionRefusal("0.0.0"),
  );
});

test("Animation: a truncated object, a clip count past the end or bytes left over are corrupt", () => {
  const { from, bytes } = fixtureObject();
  const unity: UnityVersion = [2019, 4, 41, 2];
  assert.throws(
    () => readAnimation(readerOf(from, bytes.slice(0, bytes.length - 4), { unity })),
    CorruptError,
  );
  assert.throws(
    () => readAnimation(readerOf(from, withTail(bytes, 0, 0, 0, 0), { unity })),
    CorruptError,
  );
  // m_Animations' count after m_GameObject (12), m_Enabled (4) and m_Animation (12).
  const huge = bytes.slice();
  new DataView(huge.buffer).setInt32(28, 1000, true);
  assert.throws(() => readAnimation(readerOf(from, huge, { unity })), CorruptError);
});
