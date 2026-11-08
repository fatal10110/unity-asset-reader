// AnimationClip (#302): the hardcoded reader against readTypeTree() on every
// clip of the animation fixtures (fixtures/BUILDING.md section 23) and of the
// animator fixtures (section 22), typed and not, and on objects laid out from
// Unity's own player type trees at every version TPK records
// (`fixtures/tpk-trees.json`, UnityPy's TPK data, R12), with every array filled.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { readAnimationClip, type AnimationClip } from "../src/classes/AnimationClip.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { typedTwin } from "./class-readers.js";
import { readerOf, versionRefusal, withTail, type Template } from "./media.js";
import { filled, serializedOf, TPK, tpkReader, treeAt, versionOf } from "./tpk-layouts.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const KINDS = ["lz4", "lz4-notypetree"];

/**
 * Every bundle holding clips, with its clip count: the animation bundles' six
 * (section 23) and the animator bundles' eight (section 22), typed and not,
 * per editor (6000.6.4f1's in modern-goldens.json).
 */
const FIXTURES = new Map<string, number>(
  EDITORS.flatMap((editor) =>
    KINDS.flatMap((kind): [string, number][] => [
      [`editor/${editor}/animation/${kind}/animation`, 6],
      [`editor/${editor}/animator/${kind}/animator`, 8],
    ]),
  ),
);

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

const CLIP = ClassID.AnimationClip;

for (const [name, count] of FIXTURES) {
  const typed = !name.includes("/lz4-notypetree/");

  test(`${name}: every AnimationClip reads as readTypeTree()`, () => {
    const env = loadName(name);
    const twin = typed ? env : loadName(typedTwin(name));
    const { sf, bytes } = serializedOf(name);
    const objects = env.objects.filter((o) => o.type === CLIP);
    assert.equal(objects.length, count, "AnimationClip count");
    const from: Template = { sf, info: sf.objects.find((o) => o.classId === CLIP)! };
    for (const reader of objects) {
      const where = `AnimationClip ${reader.pathId}`;
      const data = readAnimationClip(reader);
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
      // The same bytes through Unity's own tree of the version (TPK), and the
      // typed twin's values.
      const version = { unity: reader.version, text: reader.unityVersion };
      const tree = tpkReader(from, bytes(reader.pathId), treeAt(CLIP, reader.version), version);
      assert.deepStrictEqual(data, tree.readTypeTree(), `${where} (TPK tree)`);
      assert.deepStrictEqual(data, twinTree, `${where} (typed twin)`);
    }
  });
}

/** The animation bundle's clips of `editor`, by name. */
function clipsOf(editor: string): Map<string, AnimationClip> {
  const env = loadName(`editor/${editor}/animation/lz4/animation`);
  const clips = env.objects.filter((o) => o.type === CLIP).map(readAnimationClip);
  return new Map(clips.map((clip) => [clip.m_Name, clip]));
}

const LEGACY_ARRAYS = [
  "m_RotationCurves",
  "m_EulerCurves",
  "m_PositionCurves",
  "m_ScaleCurves",
  "m_FloatCurves",
  "m_PPtrCurves",
] as const;

test("the fixtures fill the streamed, dense and constant parts, the bindings and the events", () => {
  for (const editor of EDITORS) {
    const clips = clipsOf(editor);
    assert.deepEqual(
      [...clips.keys()].sort(),
      ["constant", "dense", "dense60", "legacy", "mecanim", "mixed"],
      editor,
    );
    const parts = (n: string) => {
      const { m_StreamedClip, m_DenseClip, m_ConstantClip } = clips.get(n)!.m_MuscleClip.m_Clip.data;
      return [m_StreamedClip.curveCount, m_DenseClip.m_CurveCount, m_ConstantClip.data.length];
    };
    // Streamed: sparse keys; dense: a key every frame without high-quality
    // curves; constant: flat curves; mixed: all three.
    const sixThousand = editor.startsWith("6000.");
    // 6000.x counts the sprite swap apart, as its one discrete curve.
    assert.deepEqual(parts("mecanim"), [sixThousand ? 18 : 19, 0, 0], editor);
    assert.deepEqual(parts("dense"), [0, 3, 0], editor);
    assert.deepEqual(parts("dense60"), [0, 4, 0], editor);
    assert.deepEqual(parts("constant"), [0, 0, 4], editor);
    assert.deepEqual(parts("mixed"), [3, 3, 1], editor);
    const dense = clips.get("dense")!.m_MuscleClip.m_Clip.data.m_DenseClip;
    assert.equal(dense.m_SampleArray.length, dense.m_CurveCount * dense.m_FrameCount, editor);
    const streamed = clips.get("mecanim")!.m_MuscleClip.m_Clip.data.m_StreamedClip;
    assert.ok(streamed.data.length > 0, editor);
    assert.equal(streamed.discreteCurveCount, sixThousand ? 1 : undefined, editor);

    // The legacy clip keeps every curve kind in the curve arrays, its muscle
    // clip empty; the Mecanim clips empty the curve arrays and keep the events.
    const legacy = clips.get("legacy")!;
    assert.equal(legacy.m_Legacy, true);
    for (const key of LEGACY_ARRAYS) assert.ok(legacy[key].length > 0, `${editor} ${key}`);
    assert.equal(legacy.m_MuscleClipSize, 0, editor);
    assert.equal(legacy.m_ClipBindingConstant.genericBindings.length, 0, editor);
    assert.equal(legacy.m_Events.length, 2, editor);
    const mecanim = clips.get("mecanim")!;
    assert.equal(mecanim.m_Legacy, false);
    for (const key of LEGACY_ARRAYS) assert.equal(mecanim[key].length, 0, `${editor} ${key}`);
    assert.deepEqual(
      mecanim.m_Events.map((e) => [e.functionName, e.data, e.intParameter]),
      [
        ["Step", "left", 3],
        ["Swap", "", 0],
      ],
    );
    assert.notEqual(mecanim.m_Events[1]!.objectReferenceParameter.m_PathID, 0n, editor);
    // Its bindings: transforms, the colour, the script field, the sprite swap.
    const { genericBindings, pptrCurveMapping } = mecanim.m_ClipBindingConstant;
    assert.equal(genericBindings.length, 8, editor);
    assert.equal(genericBindings.filter((b) => b.isPPtrCurve === 1).length, 1, editor);
    assert.ok(genericBindings.some((b) => b.script.m_PathID !== 0n), "the script binding");
    assert.equal(pptrCurveMapping.length, 3, editor);
    assert.equal(mecanim.m_HasGenericRootTransform, true, editor);
    // The clip settings set from the editor script.
    const muscle = mecanim.m_MuscleClip;
    assert.equal(muscle.m_LoopTime && muscle.m_HeightFromFeet && muscle.m_Mirror, true, editor);
    assert.equal(muscle.m_CycleOffset, 0.25, editor);
  }
});

test("the version-gated fields: 2022.x ones in 6000.x, metaData in 6000.6 only", () => {
  for (const editor of EDITORS) {
    const mecanim = clipsOf(editor).get("mecanim")!;
    const legacy = clipsOf(editor).get("legacy")!;
    const binding = mecanim.m_ClipBindingConstant.genericBindings[0]!;
    const sixThousand = editor.startsWith("6000.");
    assert.equal("isIntCurve" in binding, sixThousand, editor);
    assert.equal("isSerializeReferenceCurve" in binding, sixThousand, editor);
    assert.equal("metaData" in binding, editor === "6000.6.4f1", editor);
    assert.equal("flags" in legacy.m_FloatCurves[0]!, sixThousand, editor);
    assert.equal("flags" in legacy.m_PPtrCurves[0]!, sixThousand, editor);
  }
});

/** The arrays no fixture clip fills, at any depth (the TPK layouts below fill them). */
const ALWAYS_EMPTY = [
  ".m_CompressedRotationCurves",
  ".m_MuscleClip.m_ValueArrayReferencePose",
];

test("the fixtures fill every array but those the TPK layouts below fill instead", () => {
  const empty = new Set<string>();
  const full = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      (value.length ? full : empty).add(path);
      for (const item of value) walk(item, path);
    } else if (value && typeof value === "object" && !("m_FileID" in value)) {
      if (ArrayBuffer.isView(value)) return;
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  for (const name of FIXTURES.keys()) {
    if (!name.includes("/lz4/")) continue;
    for (const reader of loadName(name).objects.filter((o) => o.type === CLIP)) {
      walk(readAnimationClip(reader), "");
    }
  }
  const never = [...empty].filter((p) => !full.has(p));
  assert.deepStrictEqual(never.sort(), [...ALWAYS_EMPTY].sort());
});

// --- hand-built layouts at every TPK version ---------------------------------------------

/** A fixture clip's file and type entry, for a hand-built object. */
const TEMPLATE: Template = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/animation/lz4/animation");
  return { sf, info: sf.objects.find((o) => o.classId === CLIP)! };
})();

/**
 * TPK's tree of the 2023.3 alphas, without the split curve count: the gate
 * compares release numbers only (the ponytail in `readAnimationClip`), so the
 * reader reads it as 2023.3's layout, of the same size.
 */
const PRE_RELEASES = new Set(["2023.3.0a3"]);

test("TPK has a tree at every AnimationClip gate, from 2019.1 to 6000.6", () => {
  assert.deepEqual(Object.keys(TPK[String(CLIP)]!), [
    "2018.3.0b1",
    "2022.1.0a12", // GenericBinding isIntCurve
    "2022.2.0a13", // curve flags, isSerializeReferenceCurve
    "2022.3.19f1", // the split curve count
    "2023.1.0a1", // not split
    "2023.2.8f1", // split
    "2023.3.0a3", // not split
    "2023.3.0b1", // split
    "6000.5.0a7", // GenericBinding metaData
    "6000.5.0a9",
    "6000.6.0a5",
  ]);
});

for (const [key, nodes] of Object.entries(TPK[String(CLIP)]!)) {
  test(`TPK AnimationClip ${key}: a filled object reads the same through Unity's type tree`, () => {
    const reader = tpkReader(TEMPLATE, filled(nodes), nodes, versionOf(key));
    const tree = reader.readTypeTree() as object;
    assert.equal(reader.position, reader.byteSize);
    const data = readAnimationClip(reader);
    assert.equal(reader.position, reader.byteSize);
    if (PRE_RELEASES.has(key)) {
      // The same 4 bytes, as two UInt16s.
      assert.notDeepStrictEqual(data, tree);
      assert.ok("discreteCurveCount" in data.m_MuscleClip.m_Clip.data.m_StreamedClip);
      return;
    }
    assert.deepEqual(Object.keys(data), Object.keys(tree));
    assert.deepStrictEqual(data, tree);
  });
}

test("the AnimationClip gates between TPK's: 2022.3.18, 2023.1, 2023.2.7, 6000.0, 6000.4", () => {
  for (const [text, from] of [
    ["2021.3.45f1", "2018.3.0b1"],
    ["2022.3.18f1", "2022.2.0a13"],
    ["2022.3.62f1", "2022.3.19f1"],
    ["2023.1.20f1", "2023.1.0a1"],
    ["2023.2.7f1", "2023.1.0a1"],
    ["2023.2.20f1", "2023.2.8f1"],
    ["6000.0.58f1", "2023.3.0b1"],
    ["6000.4.0f1", "2023.3.0b1"],
    ["6000.5.0f1", "6000.5.0a9"],
  ] as const) {
    const nodes = TPK[String(CLIP)]![from]!;
    const reader = tpkReader(TEMPLATE, filled(nodes), nodes, versionOf(text));
    const tree = reader.readTypeTree();
    assert.deepStrictEqual(readAnimationClip(reader), tree, text);
  }
});

// --- refusals --------------------------------------------------------------------------

/** A fixture clip: its file, entry and bytes. */
function fixtureClip(): { from: Template; bytes: Uint8Array } {
  const { sf, bytes } = serializedOf("editor/2019.4.41f2/animation/lz4/animation");
  const info = sf.objects.find((o) => o.classId === CLIP)!;
  return { from: { sf, info }, bytes: bytes(info.pathId) };
}

test("AnimationClip: older than 2019.1, unknown outside 2019's formats, or an editor file is refused", () => {
  const { from, bytes } = fixtureClip();
  const older = readerOf(from, bytes, { unity: [2018, 4, 36, 1] });
  assert.throws(() => readAnimationClip(older), versionRefusal("2018.4.36"));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
  assert.throws(
    () => readAnimationClip(readerOf(from, bytes, { ...stripped, format: 22 })),
    versionRefusal("0.0.0"),
  );
  const editor = readerOf(from, bytes, { unity: [2019, 4, 41, 2], platform: BuildTarget.NoTarget });
  assert.throws(
    () => readAnimationClip(editor),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
  );
});

test("AnimationClip: an unknown version in format 21 reads as 2019; a misfit is refused", () => {
  const { from, bytes } = fixtureClip();
  const known = readAnimationClip(readerOf(from, bytes, { unity: [2019, 4, 41, 2] }));
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0", format: 21 };
  assert.deepStrictEqual(readAnimationClip(readerOf(from, bytes, stripped)), known);
  // A byte too many is not 2019's layout, which the file cannot tell from corruption.
  assert.throws(
    () => readAnimationClip(readerOf(from, withTail(bytes, 0, 0, 0, 0), stripped)),
    versionRefusal("0.0.0"),
  );
});

test("AnimationClip: a truncated object or bytes left over are corrupt", () => {
  const { from, bytes } = fixtureClip();
  const unity: UnityVersion = [2019, 4, 41, 2];
  assert.throws(
    () => readAnimationClip(readerOf(from, bytes.slice(0, bytes.length - 4), { unity })),
    CorruptError,
  );
  assert.throws(
    () => readAnimationClip(readerOf(from, withTail(bytes, 0, 0, 0, 0), { unity })),
    CorruptError,
  );
});
