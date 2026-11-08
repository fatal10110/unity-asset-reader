// The humanoid oracle's golden (#318): Unity's HumanPoseHandler.SetHumanPose
// results, recorded by scripts/make-humanoid-goldens.py (plan section 5,
// revision 2026-11-08d). Checks its shape and that it was made from the
// committed bundles and the authored clip values of fixtures/BUILDING.md.
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

const golden = JSON.parse(
  readFileSync(new URL("../../fixtures/humanoid-unity-goldens.json", import.meta.url), "utf8"),
) as {
  _generator: string;
  _tolerance: { localRotation: number; localPosition: number };
  muscleNames: string[];
  editors: Record<string, { clips: Record<string, Clip> }>;
};

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const BONES = [
  "humanoid", "Hips", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes", "RightUpperLeg",
  "RightLowerLeg", "RightFoot", "RightToes", "Spine", "Chest", "Neck", "Head", "LeftShoulder",
  "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightShoulder", "RightUpperArm", "RightLowerArm",
  "RightHand",
];
/** BUILDING.md section 27: the `pose` clip's muscle `i` at key `k`. */
const poseValue = (i: number, k: number) => ((i % 2 === 0 ? 1 : -1) * (((i * 5 + k * 3) % 13) + 1)) / 16;

const clips = () =>
  EDITORS.flatMap((editor) =>
    Object.entries(golden.editors[editor]!.clips).map(([name, clip]) => ({ editor, name, clip })),
  );

test("the golden holds both humanoid clips for every fixture editor, at keys and midpoints", () => {
  assert.equal(golden._generator, "scripts/make-humanoid-goldens.py");
  assert.deepEqual(Object.keys(golden.editors), EDITORS);
  assert.equal(golden.muscleNames.length, 95);
  assert.ok(golden.muscleNames.includes("Left Arm Twist In-Out"));
  assert.ok(golden._tolerance.localRotation > 0 && golden._tolerance.localPosition > 0);
  for (const { editor, name, clip } of clips()) {
    const at = `${editor} ${name}`;
    assert.deepEqual(Object.keys(golden.editors[editor]!.clips), ["pose", "muscle"], at);
    assert.deepEqual(clip.bones, BONES, at);
    assert.deepEqual(clip.keys, [0, 0.5, 1], at);
    assert.deepEqual(
      clip.samples.map((s) => [s.time, s.key]),
      [[0, true], [0.25, false], [0.5, true], [0.75, false], [1, true]],
      at,
    );
    for (const s of clip.samples) {
      assert.equal(s.muscles.length, 95, at);
      assert.equal(s.bodyPosition.length, 3, at);
      assert.equal(s.bodyRotation.length, 4, at);
      assert.equal(s.localPosition.length, BONES.length, at);
      assert.equal(s.localRotation.length, BONES.length, at);
      for (const p of s.localPosition) assert.equal(p.length, 3, at);
      for (const q of s.localRotation) {
        assert.equal(q.length, 4, at);
        assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5, `${at} t=${s.time}: not a unit quaternion`);
      }
    }
  }
});

test("the golden was made from the committed typed bundles", () => {
  for (const { editor, name, clip } of clips()) {
    const want = name === "pose" ? "humanoid/lz4/humanoid" : "scene/lz4/scene";
    assert.equal(clip.bundle, `editor/${editor}/${want}`);
    const bytes = readFileSync(new URL(`../../fixtures/bundles/${clip.bundle}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), clip.sha256, clip.bundle);
  }
});

test("the pose clip drives every muscle with non-zero values; its inputs are the authored keys", () => {
  for (const { editor, name, clip } of clips()) {
    if (name !== "pose") continue;
    assert.deepEqual(clip.driven, [...Array(95).keys()], editor);
    for (const s of clip.samples) {
      assert.ok(s.muscles.every((m) => m !== 0), `${editor} t=${s.time}: a muscle is 0`);
      assert.ok(s.bodyPosition.every((v) => v !== 0), `${editor} t=${s.time}: RootT has a 0`);
      if (!s.key) continue;
      const k = clip.keys.indexOf(s.time);
      assert.deepEqual(s.muscles, s.muscles.map((_, i) => poseValue(i, k)), `${editor} t=${s.time}`);
    }
  }
});

test("the muscle clip feeds its three muscles and RootT.y, the rest at rest", () => {
  for (const { editor, name, clip } of clips()) {
    if (name !== "muscle") continue;
    const driven = ["Spine Front-Back", "Left Arm Down-Up", "Right Forearm Stretch"];
    assert.deepEqual(clip.driven, driven.map((m) => golden.muscleNames.indexOf(m)), editor);
    const s = clip.samples[0]!;
    assert.deepEqual(clip.driven.map((i) => s.muscles[i]), [0, 0.25, 1], editor);
    assert.deepEqual(s.bodyPosition, [0, 1, 0], editor);
    assert.deepEqual(s.bodyRotation, [0, 0, 0, 1], editor);
  }
});

test("the poses move the bones: Unity's conversion ran, not an identity", () => {
  for (const { editor, name, clip } of clips()) {
    const first = clip.samples[0]!.localRotation;
    const moved = clip.samples.slice(1).some((s) =>
      s.localRotation.some((q, b) => q.some((c, j) => Math.abs(c - first[b]![j]!) > 1e-3)),
    );
    assert.ok(moved, `${editor} ${name}: no bone moved between samples`);
  }
});
