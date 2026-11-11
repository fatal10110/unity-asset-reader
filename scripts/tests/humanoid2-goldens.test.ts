// The second humanoid golden (#325): Unity's HumanPoseHandler.SetHumanPose
// results for the second rigs, recorded by scripts/make-humanoid-goldens.py
// (plan section 5) in fixtures/humanoid2-unity-goldens.json. Checks its shape
// and that it was made from the committed bundles and the authored clip values
// of fixtures/BUILDING.md section 31.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface Sample {
  time: number;
  key: boolean;
  muscles: number[];
  bodyPosition: number[];
  bodyRotation: number[];
  localPosition: number[][];
  localRotation: number[][];
}

interface Clip {
  bundle: string;
  sha256: string;
  bones: string[];
  driven: number[];
  keys: number[];
  samples: Sample[];
}

interface Golden {
  _generator: string;
  _comparison: string;
  muscleNames: string[];
  editors: Record<string, { clips: Record<string, Clip> }>;
}

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url), "utf8")) as Golden;
const golden = read("humanoid2-unity-goldens.json");
const first = read("humanoid-unity-goldens.json");

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const fingers = (side: string) =>
  ["Thumb", "Index", "Middle", "Ring", "Little"].flatMap((f) =>
    ["Proximal", "Intermediate", "Distal"].map((p) => `${side}${f}${p}`),
  );
const arm = (side: string) => [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`];
const leg = (side: string) => [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, `${side}Toes`];
/** The transforms of each clip's prefab, in GetComponentsInChildren order (BUILDING.md section 31). */
const BONES: Record<string, string[]> = {
  pose2: [
    "humanoid2", "Armature", "Hips", "Spine", "SpineMid", "Chest", "UpperChest", "Neck", "Head",
    "Jaw", "LeftEye", "RightEye", ...arm("Left"), ...fingers("Left"), ...arm("Right"),
    ...fingers("Right"), ...leg("Left"), ...leg("Right"),
  ],
  upperchest: [
    "humanoid3", "Hips", ...leg("Left"), ...leg("Right"), "Spine", "Chest", "Neck", "Head",
    ...arm("Left"), ...arm("Right"),
  ],
};
/** BUILDING.md sections 28 and 31: muscle `i` at key `k`. */
const poseValue = (i: number, k: number) => ((i % 2 === 0 ? 1 : -1) * (((i * 5 + k * 3) % 13) + 1)) / 16;

const clips = () =>
  EDITORS.flatMap((editor) =>
    Object.entries(golden.editors[editor]!.clips).map(([name, clip]) => ({ editor, name, clip })),
  );

test("the second golden holds pose2 and upperchest for every fixture editor, at keys and midpoints", () => {
  assert.equal(golden._generator, "scripts/make-humanoid-goldens.py");
  assert.equal(golden._comparison, first._comparison);
  assert.deepEqual(golden.muscleNames, first.muscleNames);
  assert.deepEqual(Object.keys(golden.editors), EDITORS);
  for (const { editor, name, clip } of clips()) {
    const at = `${editor} ${name}`;
    assert.deepEqual(Object.keys(golden.editors[editor]!.clips), ["pose2", "upperchest"], at);
    const bones = BONES[name]!;
    assert.deepEqual(clip.bones, bones, at);
    assert.deepEqual(clip.keys, [0, 0.5, 1], at);
    assert.deepEqual(
      clip.samples.map((s) => [s.time, s.key]),
      [[0, true], [0.25, false], [0.5, true], [0.75, false], [1, true]],
      at,
    );
    for (const s of clip.samples) {
      assert.equal(s.muscles.length, 95, at);
      assert.equal(s.localPosition.length, bones.length, at);
      assert.equal(s.localRotation.length, bones.length, at);
      for (const q of s.localRotation) {
        assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5, `${at} t=${s.time}: not a unit quaternion`);
      }
    }
  }
});

test("the second golden was made from the committed typed bundles", () => {
  for (const { editor, clip } of clips()) {
    assert.equal(clip.bundle, `editor/${editor}/humanoid2/lz4/humanoid2`);
    const bytes = readFileSync(new URL(`../../fixtures/bundles/${clip.bundle}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), clip.sha256, clip.bundle);
  }
});

test("pose2 and upperchest feed their authored keys; upperchest only the UpperChest muscles", () => {
  for (const { editor, name, clip } of clips()) {
    const driven = name === "pose2" ? [...Array(95).keys()] : [6, 7, 8];
    assert.deepEqual(clip.driven, driven, `${editor} ${name}`);
    if (name === "upperchest") {
      assert.deepEqual(
        driven.map((i) => golden.muscleNames[i]),
        ["UpperChest Front-Back", "UpperChest Left-Right", "UpperChest Twist Left-Right"],
      );
    }
    for (const s of clip.samples) {
      const at = `${editor} ${name} t=${s.time}`;
      assert.ok(driven.every((i) => s.muscles[i] !== 0), `${at}: a driven muscle is 0`);
      assert.ok(s.muscles.every((m, i) => m === 0 || driven.includes(i)), `${at}: an undriven muscle moved`);
      if (name === "upperchest") {
        assert.deepEqual(s.bodyPosition, [0, 0, 0], at);
        assert.deepEqual(s.bodyRotation, [0, 0, 0, 1], at);
      }
      if (!s.key) continue;
      const k = clip.keys.indexOf(s.time);
      assert.deepEqual(driven.map((i) => s.muscles[i]), driven.map((i) => poseValue(i, k)), at);
    }
  }
});

test("the second rigs' poses move the bones: Unity's conversion ran, not an identity", () => {
  for (const { editor, name, clip } of clips()) {
    const start = clip.samples[0]!.localRotation;
    const moved = clip.samples.slice(1).some((s) =>
      s.localRotation.some((q, b) => q.some((c, j) => Math.abs(c - start[b]![j]!) > 1e-3)),
    );
    assert.ok(moved, `${editor} ${name}: no bone moved between samples`);
  }
});
