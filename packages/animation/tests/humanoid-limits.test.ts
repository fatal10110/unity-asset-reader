// The humanoid conversion's steps (#319) on their own: a muscle on its limit,
// the swing-twist axes, the twist split, the muscle index and the sampling.
// Expected values follow from the definitions; the end-to-end check against
// Unity is humanoid-pose.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Animator, Avatar, Axes, Env } from "unity-asset-reader";
import {
  axesRotation,
  humanRotations,
  muscleAngle,
  qmul,
  sampleHumanoid,
  swingTwist,
  type Quat,
} from "../src/humanoid.js";
import { muscleIndex, muscleName } from "../src/muscle.js";
import { fixtureEnv } from "./helpers.js";

const close = (a: readonly number[], b: readonly number[], what: string, eps = 1e-9) => {
  const sign = a.reduce((s, c, i) => s + c * b[i]!, 0) < 0 ? -1 : 1;
  a.forEach((c, i) => assert.ok(Math.abs(c - sign * b[i]!) <= eps, `${what}: [${a}] vs [${b}]`));
};

/** The humanoid Avatar of the 2019.4 humanoid fixture. */
function avatarOf(env: Env): Avatar {
  for (const o of env.objects) {
    if (o.type !== 95) continue;
    const ptr = env.resolve(o.read<Animator>().m_Avatar, o);
    if (ptr.status === "found") return ptr.object.read<Avatar>();
  }
  throw new Error("no Animator with an Avatar");
}
const avatar = avatarOf(fixtureEnv("editor/2019.4.41f2/humanoid/lz4/humanoid"));
const human = avatar.m_Avatar.m_Human.data;
const nodeOf = (bone: number) => human.m_HumanBoneIndex[bone]!;
const axesOf = (bone: number): Axes =>
  human.m_Skeleton.data.m_AxesArray[human.m_Skeleton.data.m_Node[nodeOf(bone)]!.m_AxesId]!;

test("a muscle scales its limit's max when positive and its min when negative", () => {
  assert.equal(muscleAngle(0, -0.5, 1.2), 0);
  assert.equal(muscleAngle(1, -0.5, 1.2), 1.2);
  assert.equal(muscleAngle(0.5, -0.5, 1.2), 0.6);
  assert.equal(muscleAngle(-1, -0.5, 1.2), -0.5);
  assert.equal(muscleAngle(-0.5, -0.5, 1.2), -0.25);
});

test("swing-twist: one axis rotates by its angle about it; twist comes before swing", () => {
  const about = (axis: number[], a: number): Quat => [
    axis[0]! * Math.sin(a / 2), axis[1]! * Math.sin(a / 2), axis[2]! * Math.sin(a / 2), Math.cos(a / 2),
  ];
  close(swingTwist(0.7, 0, 0), about([1, 0, 0], 0.7), "x");
  close(swingTwist(0, -0.4, 0), about([0, 1, 0], -0.4), "y");
  close(swingTwist(0, 0, 1.1), about([0, 0, 1], 1.1), "z");
  // The swing about (0, tan(y/2), tan(z/2)) after the twist.
  const [ty, tz] = [Math.tan(0.3 / 2), Math.tan(0.5 / 2)];
  const n = Math.hypot(ty, tz);
  const swing = about([0, ty / n, tz / n], 2 * Math.atan(n));
  close(swingTwist(0.2, 0.3, 0.5), qmul(swing, about([1, 0, 0], 0.2)), "xyz");
});

test("a muscle at 0 is the limit's centre: the bone at m_PreQ * conj(m_PostQ)", () => {
  const axes = axesOf(14);
  const zero = Array<number>(95).fill(0);
  const r = humanRotations(avatar, { muscles: zero, bodyRotation: [0, 0, 0, 1] });
  close(r[nodeOf(14)]!, axesRotation(axes, [0, 0, 0]), "LeftUpperArm");
});

test("the upper arm keeps its twist share (m_ArmTwist) and the forearm takes the rest", () => {
  assert.equal(human.m_ArmTwist, 0.5);
  const muscles = Array<number>(95).fill(0);
  muscles[41] = 1; // Left Arm Twist In-Out
  const r = humanRotations(avatar, { muscles, bodyRotation: [0, 0, 0, 1] });
  const axes = axesOf(14);
  const full = muscleAngle(1, axes.m_Limit.m_Min.x, axes.m_Limit.m_Max.x);
  assert.ok(full !== 0);
  close(r[nodeOf(14)]!, axesRotation(axes, [human.m_ArmTwist * full, 0, 0]), "upper arm", 1e-7);
  // Together the two turn as the unsplit twist with the forearm at rest.
  const rest = axesRotation(axesOf(16), [0, 0, 0]);
  close(qmul(r[nodeOf(14)]!, r[nodeOf(16)]!), qmul(axesRotation(axes, [full, 0, 0]), rest), "arm", 1e-7);
});

test("muscleIndex is muscleName's inverse over the 95 muscles", () => {
  assert.equal(muscleIndex("Spine Front-Back"), 0);
  assert.equal(muscleIndex("Right Hand In-Out"), 54);
  assert.equal(muscleIndex("LeftHand.Thumb.1 Stretched"), 55);
  assert.equal(muscleIndex("RightHand.Little.3 Stretched"), 94);
  for (const other of ["RootT.x", "RootQ.w", "MotionT.y", "LeftFootT.x", "ChestTDOF.x", "m_IsActive"]) {
    assert.equal(muscleIndex(other), -1, other);
  }
  assert.equal(muscleName(7 + 7 + 28 + 41), "Left Arm Twist In-Out");
});

test("sampling: the clip's rate plus every key, one hemisphere, the curves' end held", () => {
  const key = (time: number, value: number) => ({ time, value, inSlope: 0, outSlope: 0 });
  const curves = [
    { path: "", attribute: "Spine Front-Back", classId: 95, keyframes: [key(0, 0), key(0.31, 1)] },
    // Half a turn about y and back: the samples must not flip sign.
    { path: "", attribute: "RootQ.y", classId: 95, keyframes: [key(0, 0), key(0.5, 1), key(1, 0)] },
    { path: "", attribute: "RootQ.w", classId: 95, keyframes: [key(0, 1), key(0.5, 0), key(1, -1)] },
    { path: "", attribute: "RootT.y", classId: 95, keyframes: [key(0, 1), key(2, 1)] },
  ];
  const sampled = sampleHumanoid(avatar, curves, 4)!;
  assert.deepEqual(sampled.times, [0, 0.25, Math.fround(0.31), 0.5, 0.75, 1]);
  assert.equal(sampled.bones.length, human.m_HumanBoneIndex.filter((n) => n >= 0).length);
  for (const { rotations } of sampled.bones) {
    for (let i = 1; i < rotations.length; i++) {
      const dot = rotations[i]!.reduce((s, c, d) => s + c * rotations[i - 1]![d]!, 0);
      assert.ok(dot >= 0, `sample ${i} flips hemisphere`);
    }
  }
  assert.equal(sampleHumanoid(avatar, [curves[3]!], 4), undefined, "RootT alone poses nothing");
  assert.equal(sampleHumanoid(avatar, [{ ...curves[0]!, path: "Hips" }], 4), undefined, "not on the Animator");
});
