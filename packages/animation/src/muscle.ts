// Ported from AssetStudio.Utility/YAML/MuscleHelper.cs (MIT, © Perfare / RazTools / Razviar)

/** Upstream `LimbType.ToBoneType`: LeftFoot, RightFoot, LeftHand, RightHand. */
const LIMB_BONES = ["LeftFoot", "RightFoot", "LeftHand", "RightHand"];

/** Upstream `MuscleType.ToAttributeString`, by value. */
const MUSCLES = [
  "Spine Front-Back",
  "Spine Left-Right",
  "Spine Twist Left-Right",
  "Chest Front-Back",
  "Chest Left-Right",
  "Chest Twist Left-Right",
  "UpperChest Front-Back",
  "UpperChest Left-Right",
  "UpperChest Twist Left-Right",
  "Neck Nod Down-Up",
  "Neck Tilt Left-Right",
  "Neck Turn Left-Right",
  "Head Nod Down-Up",
  "Head Tilt Left-Right",
  "Head Turn Left-Right",
  "Left Eye Down-Up",
  "Left Eye In-Out",
  "Right Eye Down-Up",
  "Right Eye In-Out",
  "Jaw Close",
  "Jaw Left-Right",
  "Left Upper Leg Front-Back",
  "Left Upper Leg In-Out",
  "Left Upper Leg Twist In-Out",
  "Left Lower Leg Stretch",
  "Left Lower Leg Twist In-Out",
  "Left Foot Up-Down",
  "Left Foot Twist In-Out",
  "Left Toes Up-Down",
  "Right Upper Leg Front-Back",
  "Right Upper Leg In-Out",
  "Right Upper Leg Twist In-Out",
  "Right Lower Leg Stretch",
  "Right Lower Leg Twist In-Out",
  "Right Foot Up-Down",
  "Right Foot Twist In-Out",
  "Right Toes Up-Down",
  "Left Shoulder Down-Up",
  "Left Shoulder Front-Back",
  "Left Arm Down-Up",
  "Left Arm Front-Back",
  "Left Arm Twist In-Out",
  "Left Forearm Stretch",
  "Left Forearm Twist In-Out",
  "Left Hand Down-Up",
  "Left Hand In-Out",
  "Right Shoulder Down-Up",
  "Right Shoulder Front-Back",
  "Right Arm Down-Up",
  "Right Arm Front-Back",
  "Right Arm Twist In-Out",
  "Right Forearm Stretch",
  "Right Forearm Twist In-Out",
  "Right Hand Down-Up",
  "Right Hand In-Out",
];

/** Upstream `ArmType.ToBoneType`. */
const ARM_BONES = ["LeftHand", "RightHand"];
/** Upstream `FingerType`. */
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
/** Upstream `FingerDoFType.ToAttributeString`. */
const FINGER_DOFS = ["1 Stretched", "Spread", "2 Stretched", "3 Stretched"];
/** Upstream `TDoFBoneType.ToBoneType`, by value. */
const TDOF_BONES = [
  "Spine",
  "Chest",
  "UpperChest",
  "Neck",
  "Head",
  "LeftUpperLeg",
  "LeftLowerLeg",
  "LeftFoot",
  "LeftToes",
  "RightUpperLeg",
  "RightLowerLeg",
  "RightFoot",
  "RightToes",
  "LeftShoulder",
  "LeftUpperArm",
  "LeftLowerArm",
  "LeftHand",
  "RightShoulder",
  "RightUpperArm",
  "RightLowerArm",
  "RightHand",
];

const TRANSFORM_POSTFIX = ["T.x", "T.y", "T.z", "Q.x", "Q.y", "Q.z", "Q.w"];
const TDOF_POSTFIX = ["TDOF.x", "TDOF.y", "TDOF.z"];

// Upstream `HumanoidMuscleType`'s ranges.
const ROOT = 7;
const LIMBS = ROOT + 7;
const MUSCLES_START = LIMBS + LIMB_BONES.length * 7;
const FINGERS_START = MUSCLES_START + MUSCLES.length;
const TDOF_START = FINGERS_START + ARM_BONES.length * FINGERS.length * FINGER_DOFS.length;
const LAST = TDOF_START + TDOF_BONES.length * 3;

/**
 * The attribute a humanoid muscle curve has in AssetStudio's `.anim`
 * (upstream `GenericBinding.GetHumanoidMuscle().ToAttributeString()`):
 * `RootT.y`, `LeftHandQ.w`, `Spine Front-Back`, `LeftHand.Index.Spread`,
 * `ChestTDOF.x`.
 *
 * Upstream first remaps the value for Unity before 5.6 (`MuscleType.Update`,
 * `TDoFBoneType.Update`) and before 2017.3; with the 2019 floor every
 * remapping is the identity, and is left out. `BoneType` is the 5.6 and later
 * list, with `UpperChest`, as upstream's `ToAttributeString` names it.
 *
 * @param attribute the binding's `attribute`
 * @throws {Error} for a value past the last muscle (200), as upstream throws
 *   `ArgumentException`
 */
export function muscleName(attribute: number): string {
  const m = attribute;
  if (m < ROOT) return "Motion" + TRANSFORM_POSTFIX[m % 7];
  if (m < LIMBS) return "Root" + TRANSFORM_POSTFIX[(m - ROOT) % 7];
  if (m < MUSCLES_START) {
    const delta = m - LIMBS;
    return LIMB_BONES[Math.floor(delta / 7)]! + TRANSFORM_POSTFIX[delta % 7];
  }
  if (m < FINGERS_START) return MUSCLES[m - MUSCLES_START]!;
  if (m < TDOF_START) {
    const armSize = FINGERS.length * FINGER_DOFS.length;
    let delta = m - FINGERS_START;
    const arm = ARM_BONES[Math.floor(delta / armSize)]!;
    delta %= armSize;
    const finger = FINGERS[Math.floor(delta / FINGER_DOFS.length)]!;
    return `${arm}.${finger}.${FINGER_DOFS[delta % FINGER_DOFS.length]}`;
  }
  if (m < LAST) {
    const delta = m - TDOF_START;
    return TDOF_BONES[Math.floor(delta / 3)]! + TDOF_POSTFIX[delta % 3];
  }
  throw new Error(`humanoid muscle ${attribute} is past the last one (${LAST - 1})`);
}
