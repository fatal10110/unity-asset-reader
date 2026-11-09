// Humanoid poses to bone rotations. Not a port: AssetStudio and UnityPy have no
// muscle-to-bone conversion, and no permissively licensed one exists. Derived
// from the Avatar's own data (`m_Avatar.m_Human`) and Unity's public
// documentation, and checked against the poses the Unity editor makes from the
// same inputs (fixtures/humanoid-unity-goldens.json, by
// scripts/make-humanoid-goldens.py).
//
// Public sources:
// - Muscle definitions: https://docs.unity3d.com/Manual/MuscleDefinitions.html
// - HumanPose: https://docs.unity3d.com/ScriptReference/HumanPose.html
// - HumanTrait: https://docs.unity3d.com/ScriptReference/HumanTrait.html
// - HumanTrait.MuscleFromBone: https://docs.unity3d.com/ScriptReference/HumanTrait.MuscleFromBone.html
// - HumanTrait.GetMuscleDefaultMax: https://docs.unity3d.com/ScriptReference/HumanTrait.GetMuscleDefaultMax.html
// - HumanLimit (min, max, center): https://docs.unity3d.com/ScriptReference/HumanLimit.html
// - HumanDescription (upperArmTwist, foreArmTwist, upperLegTwist, legTwist):
//   https://docs.unity3d.com/ScriptReference/HumanDescription.html

import type { Avatar, Axes, Human } from "unity-asset-reader";

/** A quaternion as x, y, z, w. */
export type Quat = [number, number, number, number];
/** A vector as x, y, z. */
export type Vec3 = [number, number, number];

/** Hamilton product `a * b`: `b` applied first. */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The conjugate: the inverse of a unit quaternion. */
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** `q` scaled to unit length. */
export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** `v` rotated by the unit quaternion `q`. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}

const quat = (q: { x: number; y: number; z: number; w: number }): Quat => [q.x, q.y, q.z, q.w];
const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A muscle value as an angle on one axis of a bone, in radians. A muscle spans
 * its limit around the limit's centre (HumanLimit): 0 is the centre, which
 * the Avatar folds into the bone's `m_PreQ`, 1 is `max` and -1 is `min`, each
 * side scaled on its own.
 *
 * @param value the muscle value, usually in [-1, 1]
 * @param min the axis' lower limit (`Axes.m_Limit.m_Min`), radians, at most 0
 * @param max the axis' upper limit (`Axes.m_Limit.m_Max`), radians, at least 0
 */
export function muscleAngle(value: number, min: number, max: number): number {
  return value >= 0 ? value * max : -value * min;
}

/**
 * The rotation of a bone's three axis angles, in radians: Unity's muscle axes
 * are swing-twist, not Euler angles. The X angle twists the bone about its
 * own axis first; the Y and Z angles then swing it about the axis
 * `(0, tan(y/2), tan(z/2))` of the YZ plane. Each enters as the tangent of its
 * half angle, so a single axis rotates by exactly its angle.
 */
export function swingTwist(x: number, y: number, z: number): Quat {
  const tx = Math.tan(x / 2);
  const ty = Math.tan(y / 2);
  const tz = Math.tan(z / 2);
  // The swing (0, ty, tz, 1) times the twist (tx, 0, 0, 1), normalized.
  return qnorm([tx, ty + tx * tz, tz - tx * ty, 1]);
}

/**
 * A bone's local rotation, in its parent's space, for its axis angles before
 * the axes' signs: `m_PreQ * swingTwist(m_Sgn * angles) * conj(m_PostQ)`.
 * `m_PreQ` holds the parent-side frame and the limits' centre, `m_PostQ` the
 * bone's own frame, whose X axis points along the bone.
 */
export function axesRotation(axes: Axes, angles: Vec3): Quat {
  const s = axes.m_Sgn;
  const r = swingTwist(s.x * angles[0], s.y * angles[1], s.z * angles[2]);
  return qnorm(qmul(qmul(quat(axes.m_PreQ), r), qconj(quat(axes.m_PostQ))));
}

/** The number of human bones `m_HumanBoneIndex` and `m_HumanBoneMass` list. */
const BONES = 25;
const HIPS = 0;
const LEFT_UPPER_LEG = 1;
const RIGHT_UPPER_LEG = 2;
const CHEST = 8;
const UPPER_CHEST = 9;
const LEFT_UPPER_ARM = 14;
const RIGHT_UPPER_ARM = 15;

/**
 * Each human bone's muscles by axis (x, y, z), as `HumanTrait.MuscleFromBone`
 * pairs them; -1 where the bone has no muscle on that axis. Indexed by the
 * human bone order of `m_HumanBoneIndex`: Hips, LeftUpperLeg, RightUpperLeg,
 * LeftLowerLeg, RightLowerLeg, LeftFoot, RightFoot, Spine, Chest, UpperChest,
 * Neck, Head, LeftShoulder, RightShoulder, LeftUpperArm, RightUpperArm,
 * LeftLowerArm, RightLowerArm, LeftHand, RightHand, LeftToes, RightToes,
 * LeftEye, RightEye, Jaw. Muscles by their index in `HumanTrait.MuscleName`
 * (muscle.ts). An avatar's limits agree: an axis with a muscle has a limit,
 * the others have none.
 */
export const BONE_MUSCLES: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1], // Hips: moved by the body position and rotation
  [23, 22, 21], // LeftUpperLeg: twist, in-out, front-back
  [31, 30, 29], // RightUpperLeg
  [25, -1, 24], // LeftLowerLeg: twist, stretch
  [33, -1, 32], // RightLowerLeg
  [-1, 27, 26], // LeftFoot: twist, up-down
  [-1, 35, 34], // RightFoot
  [2, 1, 0], // Spine: twist, left-right, front-back
  [5, 4, 3], // Chest
  [8, 7, 6], // UpperChest
  [11, 10, 9], // Neck: turn, tilt, nod
  [14, 13, 12], // Head
  [-1, 38, 37], // LeftShoulder: front-back, down-up
  [-1, 47, 46], // RightShoulder
  [41, 40, 39], // LeftUpperArm: twist, front-back, down-up
  [50, 49, 48], // RightUpperArm
  [43, -1, 42], // LeftLowerArm: twist, stretch
  [52, -1, 51], // RightLowerArm
  [-1, 45, 44], // LeftHand: in-out, down-up
  [-1, 54, 53], // RightHand
  [-1, -1, 28], // LeftToes: up-down
  [-1, -1, 36], // RightToes
  [-1, 16, 15], // LeftEye: in-out, down-up
  [-1, 18, 17], // RightEye
  [-1, 20, 19], // Jaw: left-right, close
];

/**
 * The twist splits (HumanDescription's upperArmTwist, foreArmTwist,
 * upperLegTwist, legTwist): a bone keeps the `Human` field's share of its
 * twist and passes the rest to the child, which turns by it about the bone's
 * axis. As [bone, child, field], by human bone.
 */
const TWISTS: readonly [number, number, keyof Human][] = [
  [14, 16, "m_ArmTwist"],
  [15, 17, "m_ArmTwist"],
  [16, 18, "m_ForeArmTwist"],
  [17, 19, "m_ForeArmTwist"],
  [1, 3, "m_UpperLegTwist"],
  [2, 4, "m_UpperLegTwist"],
  [3, 5, "m_LegTwist"],
  [4, 6, "m_LegTwist"],
];

/**
 * The range of the UpperChest muscles, in radians, for an avatar without an
 * UpperChest bone: Unity's default, +-20 degrees
 * (`HumanTrait.GetMuscleDefaultMin`/`GetMuscleDefaultMax` of muscles 6-8).
 * Such an avatar has no axes, so no limits, for the bone; Unity then turns
 * the Chest by the UpperChest muscles too, over this range.
 */
const UPPER_CHEST_RANGE = (20 * Math.PI) / 180;

/** A pose as `HumanPoseHandler.SetHumanPose` takes it (HumanPose), without the body position. */
export interface HumanPose {
  /** The 95 muscle values, in `HumanTrait.MuscleName` order. */
  muscles: ArrayLike<number>;
  /** The body's rotation (`bodyRotation`, the clip's `RootQ`). */
  bodyRotation: Quat;
}

/**
 * Each human skeleton node's local rotation for a pose, in its human
 * skeleton parent's space (`m_Human.m_Skeleton`, `m_SkeletonPose`): the
 * muscles turned into angles on each bone's axes, the twists split, and the
 * Hips turned so that the body has the pose's `bodyRotation`. Nodes no muscle
 * moves keep their skeleton pose rotation.
 *
 * - Muscles: {@link muscleAngle} on the bone's `m_Limit`, then
 *   {@link axesRotation}.
 * - Twists: see `TWISTS`.
 * - UpperChest muscles of an avatar without an UpperChest add to the Chest's
 *   angles, over `UPPER_CHEST_RANGE`.
 * - Hips: the body's rotation is the frame whose up runs from the middle of
 *   the upper legs to the middle of the upper arms and whose right runs from
 *   the left upper leg and arm to the right ones (Unity's T-pose body frame
 *   `m_RootX` is the identity by it). It is measured with the Hips at the
 *   identity, and the Hips turned by `bodyRotation` times its inverse.
 *
 * The Hips position (`bodyPosition`, the body's centre of mass) is not
 * converted: no centre of mass definition met the tolerance (#319).
 *
 * @param avatar the Avatar, with a human description (`m_Human`)
 * @param pose the muscles and body rotation
 * @returns one rotation per node of `m_Human.m_Skeleton`, Unity space
 */
export function humanRotations(avatar: Avatar, pose: HumanPose): Quat[] {
  const human = avatar.m_Avatar.m_Human.data;
  const skeleton = human.m_Skeleton.data;
  const index = human.m_HumanBoneIndex;
  const poseX = human.m_SkeletonPose.data.m_X;
  const rotations: Quat[] = skeleton.m_Node.map((_, i) => quat(poseX[i]!.q));
  const axesOf = (bone: number): Axes | undefined => {
    const node = index[bone] ?? -1;
    const axesId = node < 0 ? -1 : skeleton.m_Node[node]!.m_AxesId;
    return axesId < 0 ? undefined : skeleton.m_AxesArray[axesId];
  };
  const muscle = (m: number) => pose.muscles[m] ?? 0;

  const twist: number[] = [];
  for (let bone = 0; bone < BONES; bone++) {
    const muscles = BONE_MUSCLES[bone]!;
    const axes = axesOf(bone);
    if (!axes || muscles.every((m) => m < 0)) continue;
    const min = vec(axes.m_Limit.m_Min);
    const max = vec(axes.m_Limit.m_Max);
    const angles = muscles.map((m, d) => (m < 0 ? 0 : muscleAngle(muscle(m), min[d]!, max[d]!)));
    if (bone === CHEST && (index[UPPER_CHEST] ?? -1) < 0) {
      BONE_MUSCLES[UPPER_CHEST]!.forEach((m, d) => {
        angles[d]! += muscleAngle(muscle(m), -UPPER_CHEST_RANGE, UPPER_CHEST_RANGE);
      });
    }
    twist[bone] = axes.m_Sgn.x * angles[0]!;
    rotations[index[bone]!] = axesRotation(axes, angles as Vec3);
  }

  for (const [bone, child, field] of TWISTS) {
    const node = index[bone] ?? -1;
    const childNode = index[child] ?? -1;
    const axes = axesOf(bone);
    if (node < 0 || childNode < 0 || !axes || !twist[bone]) continue;
    const moved = (1 - (human[field] as number)) * twist[bone]!;
    const post = quat(axes.m_PostQ);
    const r = qmul(qmul(post, [Math.sin(moved / 2), 0, 0, Math.cos(moved / 2)]), qconj(post));
    rotations[node] = qnorm(qmul(rotations[node]!, qconj(r)));
    rotations[childNode] = qnorm(qmul(r, rotations[childNode]!));
  }

  const hips = index[HIPS] ?? -1;
  if (hips >= 0) {
    rotations[hips] = [0, 0, 0, 1];
    const body = bodyFrame(avatar, hipsSpace(avatar, rotations));
    rotations[hips] = qnorm(qmul(qnorm(pose.bodyRotation), qconj(body)));
  }
  return rotations;
}

/** Each human skeleton node's position relative to the Hips, at the given local rotations. */
function hipsSpace(avatar: Avatar, local: Quat[]): (Vec3 | undefined)[] {
  const human = avatar.m_Avatar.m_Human.data;
  const hips = human.m_HumanBoneIndex[HIPS]!;
  const t: (Vec3 | undefined)[] = [];
  const q: Quat[] = [];
  human.m_Skeleton.data.m_Node.forEach((node, i) => {
    if (i === hips) {
      t[i] = [0, 0, 0];
      q[i] = [0, 0, 0, 1];
      return;
    }
    const parent = node.m_ParentId;
    if (parent < 0 || !t[parent]) return;
    t[i] = add(t[parent]!, qrot(q[parent]!, vec(human.m_SkeletonPose.data.m_X[i]!.t)));
    q[i] = qmul(q[parent]!, local[i]!);
  });
  return t;
}

/** The body frame of node positions: see {@link humanRotations}. */
function bodyFrame(avatar: Avatar, t: (Vec3 | undefined)[]): Quat {
  const index = avatar.m_Avatar.m_Human.data.m_HumanBoneIndex;
  const at = (bone: number): Vec3 => t[index[bone] ?? -1] ?? [0, 0, 0];
  const legs = add(at(LEFT_UPPER_LEG), at(RIGHT_UPPER_LEG));
  const arms = add(at(LEFT_UPPER_ARM), at(RIGHT_UPPER_ARM));
  const up = unit(sub(arms, legs));
  const across = add(
    sub(at(RIGHT_UPPER_LEG), at(LEFT_UPPER_LEG)),
    sub(at(RIGHT_UPPER_ARM), at(LEFT_UPPER_ARM)),
  );
  const front = unit(cross(unit(across), up));
  return basisQuat(cross(up, front), up, front);
}

/** The rotation whose matrix has the orthonormal columns `x`, `y`, `z`. */
export function basisQuat(x: Vec3, y: Vec3, z: Vec3): Quat {
  const tr = x[0] + y[1] + z[2];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    return [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    return [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
}
