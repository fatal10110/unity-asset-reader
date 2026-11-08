// RectTransform (#315): the hardcoded reader against readTypeTree() on the
// ui-animation fixtures (fixtures/BUILDING.md section 26), typed and not, and
// on objects laid out from Unity's own player type trees at every version TPK
// records (`fixtures/tpk-trees.json`, UnityPy's TPK data, R12), with the
// children filled.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import type { GameObject } from "../src/classes/GameObject.js";
import { readRectTransform, type RectTransform } from "../src/classes/RectTransform.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { typedTwin } from "./class-readers.js";
import { readerOf, versionRefusal, withTail, type Template } from "./media.js";
import { filled, serializedOf, TPK, tpkReader, treeAt, versionOf } from "./tpk-layouts.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
/** Every ui-animation bundle: typed and not, per editor (6000.6.4f1's in modern-goldens.json). */
const FIXTURES = EDITORS.flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map((kind) => `editor/${editor}/ui-animation/${kind}/ui-animation`),
);

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

/** The children's anchors as the editor script sets them (BUILDING.md section 26). */
const ANCHORS: Record<string, number[]> = {
  // anchorMin, anchorMax, anchoredPosition, sizeDelta, pivot
  Panel: [0.25, 0.25, 0.75, 0.75, 10, 20, -40, -30, 0.5, 0.25],
  Button: [0, 0.25, 0, 0.25, 8, -4, 100, 30, 0.5, 0.5],
  Label: [0, 0, 1, 1, 0, 2, -16, -8, 0, 1],
};

for (const name of FIXTURES) {
  const typed = !name.includes("/lz4-notypetree/");

  test(`${name}: every RectTransform reads as readTypeTree()`, () => {
    const env = loadName(name);
    const twin = typed ? env : loadName(typedTwin(name));
    const { sf, bytes } = serializedOf(name);
    const objects = env.objects.filter((o) => o.type === ClassID.RectTransform);
    assert.equal(objects.length, 4);
    for (const reader of objects) {
      const where = `RectTransform ${reader.pathId}`;
      const data = readRectTransform(reader);
      assert.equal(reader.position, reader.byteSize, `${where}: byteSize not consumed exactly`);
      // obj.read() dispatches to the same reader.
      assert.deepStrictEqual(reader.read(), data, where);
      const twinTree = twin.objects.find((o) => o.pathId === reader.pathId)!.readTypeTree();
      if (typed) {
        // Every field, in Unity's order.
        assert.deepEqual(Object.keys(data), Object.keys(twinTree), where);
      } else {
        // The same bytes through Unity's own tree of the version (TPK).
        const from: Template = { sf, info: sf.objects.find((o) => o.pathId === reader.pathId)! };
        const version = { unity: reader.version, text: reader.unityVersion };
        const nodes = treeAt(ClassID.RectTransform, reader.version);
        const tree = tpkReader(from, bytes(reader.pathId), nodes, version).readTypeTree();
        assert.deepStrictEqual(data, tree, `${where} (TPK tree)`);
      }
      assert.deepStrictEqual(data, twinTree, where);
    }
  });

  test(`${name}: the children hold the anchors the editor script set`, () => {
    const env = loadName(name);
    const seen: string[] = [];
    for (const reader of env.objects.filter((o) => o.type === ClassID.RectTransform)) {
      const data = reader.read<RectTransform>();
      const go = env.resolve(data.m_GameObject, reader);
      assert.ok(go.status === "found" && go.object.type === ClassID.GameObject);
      const goName = go.object.read<GameObject>().m_Name;
      seen.push(goName);
      const want = ANCHORS[goName];
      if (!want) continue;
      const got = [data.m_AnchorMin, data.m_AnchorMax, data.m_AnchoredPosition, data.m_SizeDelta,
        data.m_Pivot].flatMap((v) => [v.x, v.y]);
      assert.deepEqual(got, want, goName);
    }
    assert.deepEqual(seen.sort(), ["Button", "Label", "Panel", "ui"]);
  });
}

// --- hand-built layouts at every TPK version ---------------------------------------------

const TEMPLATE: Template = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/ui-animation/lz4/ui-animation");
  return { sf, info: sf.objects.find((o) => o.classId === ClassID.RectTransform)! };
})();

test("TPK has a RectTransform tree at every key from 2019.1 to 6000.6, all one layout", () => {
  // The later keys change only node flags, never a field: the reader has no gate.
  assert.deepEqual(Object.keys(TPK[String(ClassID.RectTransform)]!), [
    "2018.3.0b1",
    "2021.2.0a15",
    "2022.3.5f1",
    "2023.1.0a1",
    "2023.1.4f1",
    "2023.2.0a6",
    "2023.2.0a19",
    "6000.6.0a5",
  ]);
});

for (const [key, nodes] of Object.entries(TPK[String(ClassID.RectTransform)]!)) {
  test(`TPK RectTransform ${key}: a filled object reads the same through Unity's type tree`, () => {
    const reader = tpkReader(TEMPLATE, filled(nodes), nodes, versionOf(key));
    const tree = reader.readTypeTree() as object;
    assert.equal(reader.position, reader.byteSize);
    const data = readRectTransform(reader);
    assert.equal(reader.position, reader.byteSize);
    assert.equal(data.m_Children.length, 2);
    assert.deepEqual(Object.keys(data), Object.keys(tree));
    assert.deepStrictEqual(data, tree);
  });
}

// --- refusals --------------------------------------------------------------------------

function fixtureObject(): { from: Template; bytes: Uint8Array } {
  const { sf, bytes } = serializedOf("editor/2019.4.41f2/ui-animation/lz4/ui-animation");
  const info = sf.objects.find((o) => o.classId === ClassID.RectTransform)!;
  return { from: { sf, info }, bytes: bytes(info.pathId) };
}

test("RectTransform: older than 2019.1, unknown outside 2019's formats, or an editor file is refused", () => {
  const { from, bytes } = fixtureObject();
  const older = readerOf(from, bytes, { unity: [2018, 4, 36, 1] });
  assert.throws(() => readRectTransform(older), versionRefusal("2018.4.36"));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
  assert.throws(
    () => readRectTransform(readerOf(from, bytes, { ...stripped, format: 22 })),
    versionRefusal("0.0.0"),
  );
  const editor = readerOf(from, bytes, { unity: [2019, 4, 41, 2], platform: BuildTarget.NoTarget });
  assert.throws(
    () => readRectTransform(editor),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
  );
});

test("RectTransform: an unknown version in format 21 reads as 2019; a misfit is refused", () => {
  const { from, bytes } = fixtureObject();
  const known = readRectTransform(readerOf(from, bytes, { unity: [2019, 4, 41, 2] }));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0", format: 21 };
  assert.deepStrictEqual(readRectTransform(readerOf(from, bytes, stripped)), known);
  // A field too many is not 2019's layout, which the file cannot tell from corruption.
  assert.throws(
    () => readRectTransform(readerOf(from, withTail(bytes, 0, 0, 0, 0), stripped)),
    versionRefusal("0.0.0"),
  );
});

test("RectTransform: a truncated object, a child count past the end or bytes left over are corrupt", () => {
  const { from, bytes } = fixtureObject();
  const unity: UnityVersion = [2019, 4, 41, 2];
  assert.throws(
    () => readRectTransform(readerOf(from, bytes.slice(0, bytes.length - 4), { unity })),
    CorruptError,
  );
  assert.throws(
    () => readRectTransform(readerOf(from, withTail(bytes, 0, 0, 0, 0), { unity })),
    CorruptError,
  );
  // m_Children's count after m_GameObject (12), the rotation (16), position and scale (12 each).
  const huge = bytes.slice();
  new DataView(huge.buffer).setInt32(52, 1000, true);
  assert.throws(() => readRectTransform(readerOf(from, huge, { unity })), CorruptError);
});
