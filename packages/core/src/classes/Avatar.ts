// Ported from AssetStudio/Classes/Avatar.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader, Quaternion, Vector3, XForm } from "../serialized/ObjectReader.js";
import {
  animationLayoutVersion,
  readBool,
  readFloat3,
  readFloat4,
  readFloats,
  readInts as readIntArray,
  readUInts as readUIntArray,
  readXForm,
  type OffsetPtr,
} from "./animation.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { assumingLayout, endOfObject, readArray, type Vector4 } from "./Sprite.js";
import { readStringField } from "./strings.js";

/** A bone's place in a {@link Skeleton} (Unity's `Node`). */
export interface SkeletonNode {
  /** The parent's index in the skeleton; -1 for the root. */
  m_ParentId: number;
  /** The bone's index in `m_AxesArray`; -1 for none. */
  m_AxesId: number;
}

/** A bone's rotation limits (Unity's `Limit`). */
export interface Limit {
  m_Min: Vector3;
  m_Max: Vector3;
}

/** A bone's rotation frame and limits (Unity's `Axes`). */
export interface Axes {
  m_PreQ: Vector4;
  m_PostQ: Vector4;
  m_Sgn: Vector3;
  m_Limit: Limit;
  m_Length: number;
  m_Type: number;
}

/** A bone hierarchy (Unity's `Skeleton`). */
export interface Skeleton {
  m_Node: SkeletonNode[];
  /** Each bone's path hash, as `m_TOS` keys it. */
  m_ID: number[];
  m_AxesArray: Axes[];
}

/** One transform per bone of a {@link Skeleton} (Unity's `SkeletonPose`). */
export interface SkeletonPose {
  m_X: XForm[];
}

/** The finger bones of a hand (Unity's `Hand`). */
export interface Hand {
  /** One skeleton index per finger bone; -1 for a bone the avatar lacks. */
  m_HandBoneIndex: number[];
}

/** The humanoid part of an {@link AvatarConstant} (Unity's `Human`). */
export interface Human {
  m_RootX: XForm;
  m_Skeleton: OffsetPtr<Skeleton>;
  m_SkeletonPose: OffsetPtr<SkeletonPose>;
  m_LeftHand: OffsetPtr<Hand>;
  m_RightHand: OffsetPtr<Hand>;
  /** One skeleton index per human bone; -1 for a bone the avatar lacks. */
  m_HumanBoneIndex: number[];
  m_HumanBoneMass: number[];
  m_Scale: number;
  m_ArmTwist: number;
  m_ForeArmTwist: number;
  m_UpperLegTwist: number;
  m_LegTwist: number;
  m_ArmStretch: number;
  m_LegStretch: number;
  m_FeetSpacing: number;
  m_HasLeftHand: boolean;
  m_HasRightHand: boolean;
  m_HasTDoF: boolean;
}

/** The runtime form of an avatar (Unity's `AvatarConstant`). */
export interface AvatarConstant {
  m_AvatarSkeleton: OffsetPtr<Skeleton>;
  m_AvatarSkeletonPose: OffsetPtr<SkeletonPose>;
  m_DefaultPose: OffsetPtr<SkeletonPose>;
  m_SkeletonNameIDArray: number[];
  m_Human: OffsetPtr<Human>;
  m_HumanSkeletonIndexArray: number[];
  m_HumanSkeletonReverseIndexArray: number[];
  m_RootMotionBoneIndex: number;
  m_RootMotionBoneX: XForm;
  m_RootMotionSkeleton: OffsetPtr<Skeleton>;
  m_RootMotionSkeletonPose: OffsetPtr<SkeletonPose>;
  m_RootMotionSkeletonIndexArray: number[];
}

/** A human bone's muscle limits in a {@link HumanDescription} (Unity's `SkeletonBoneLimit`). */
export interface SkeletonBoneLimit {
  m_Min: Vector3;
  m_Max: Vector3;
  m_Value: Vector3;
  m_Length: number;
  /** Whether the bone has limits of its own rather than Unity's defaults. */
  m_Modified: boolean;
}

/** A transform mapped to a human bone (Unity's `HumanBone`). */
export interface HumanBone {
  /** The transform's name. */
  m_BoneName: string;
  /** The human bone, by Unity's name (`"Hips"`, `"Left Thumb Proximal"`, ...). */
  m_HumanName: string;
  m_Limit: SkeletonBoneLimit;
}

/** A transform of the model in its reference pose (Unity's `SkeletonBone`). */
export interface SkeletonBone {
  m_Name: string;
  m_ParentName: string;
  m_Position: Vector3;
  m_Rotation: Quaternion;
  m_Scale: Vector3;
}

/** How the avatar was built: Unity's `HumanDescription`, as the avatar keeps it. */
export interface HumanDescription {
  m_Human: HumanBone[];
  m_Skeleton: SkeletonBone[];
  m_ArmTwist: number;
  m_ForeArmTwist: number;
  m_UpperLegTwist: number;
  m_LegTwist: number;
  m_ArmStretch: number;
  m_LegStretch: number;
  m_FeetSpacing: number;
  m_GlobalScale: number;
  m_RootMotionBoneName: string;
  m_HasTranslationDoF: boolean;
  m_HasExtraRoot: boolean;
  m_SkeletonHasParents: boolean;
}

/**
 * The fields of an `Avatar`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object, map entries as `[first, second]` arrays as it gives
 * them.
 */
export interface Avatar extends NamedObject {
  /** The byte size of the runtime avatar blob. */
  m_AvatarSize: number;
  m_Avatar: AvatarConstant;
  /** Path hash to transform path, for every bone. */
  m_TOS: [number, string][];
  m_HumanDescription: HumanDescription;
}

/**
 * Read an `Avatar` from the object's first byte: every field Unity's own
 * player type trees give, which are the same in every Unity version from
 * 2019.1 to 6000.6 (as UnityPy's TPK data records them), in their order. The
 * object must end exactly there.
 *
 * Upstream reads `m_AvatarSize`, `m_Avatar` and `m_TOS`, and stops: it notes
 * `m_HumanDescription` (2019 and later) without reading it. This reads it as
 * TPK lays it out, `m_GlobalScale` included. Upstream's gates are all before
 * 2019.1; its `Handle` and `Collider` structs belong to those older layouts.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields after
 *   `m_Name` do not fit 2019's layout. Of kind `"build target"` for an editor
 *   file (`BuildTarget.NoTarget`)
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field, with the version known; with it unknown, only inside `m_Name`
 */
export function readAvatar(reader: ObjectReader): Avatar {
  animationLayoutVersion(reader, "Avatar");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Avatar> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "Avatar", () => {
    out.m_AvatarSize = reader.readUInt32();
    out.m_Avatar = readAvatarConstant(reader);
    out.m_TOS = readTOS(reader, "Avatar");
    out.m_HumanDescription = readHumanDescription(reader);
    endOfObject(reader, "Avatar");
  });
  // Every required field was set above.
  return out as Avatar;
}

/**
 * A `map<unsigned int, string>` path table (`m_TOS`). Internal: shared with
 * `AnimatorController.ts`.
 */
export function readTOS(reader: ObjectReader, owner: string): [number, string][] {
  return readArray(reader, owner, "m_TOS", (r) => [
    r.readUInt32(),
    readStringField(r, owner, "m_TOS"),
  ]);
}

const OWNER = "Avatar";

function readAvatarConstant(reader: ObjectReader): AvatarConstant {
  return {
    m_AvatarSkeleton: { data: readSkeleton(reader) },
    m_AvatarSkeletonPose: { data: readSkeletonPose(reader) },
    m_DefaultPose: { data: readSkeletonPose(reader) },
    m_SkeletonNameIDArray: readUInts(reader, "m_SkeletonNameIDArray"),
    m_Human: { data: readHuman(reader) },
    m_HumanSkeletonIndexArray: readInts(reader, "m_HumanSkeletonIndexArray"),
    m_HumanSkeletonReverseIndexArray: readInts(reader, "m_HumanSkeletonReverseIndexArray"),
    m_RootMotionBoneIndex: reader.readInt32(),
    m_RootMotionBoneX: readXForm(reader),
    m_RootMotionSkeleton: { data: readSkeleton(reader) },
    m_RootMotionSkeletonPose: { data: readSkeletonPose(reader) },
    m_RootMotionSkeletonIndexArray: readInts(reader, "m_RootMotionSkeletonIndexArray"),
  };
}

function readSkeleton(reader: ObjectReader): Skeleton {
  return {
    m_Node: readArray(reader, OWNER, "m_Node", (r) => ({
      m_ParentId: r.readInt32(),
      m_AxesId: r.readInt32(),
    })),
    m_ID: readUInts(reader, "m_ID"),
    m_AxesArray: readArray(reader, OWNER, "m_AxesArray", (r) => ({
      m_PreQ: readFloat4(r),
      m_PostQ: readFloat4(r),
      m_Sgn: readFloat3(r),
      m_Limit: { m_Min: readFloat3(r), m_Max: readFloat3(r) },
      m_Length: r.readFloat32(),
      m_Type: r.readUInt32(),
    })),
  };
}

function readSkeletonPose(reader: ObjectReader): SkeletonPose {
  return { m_X: readArray(reader, OWNER, "m_X", readXForm) };
}

function readHuman(reader: ObjectReader): Human {
  const human: Human = {
    m_RootX: readXForm(reader),
    m_Skeleton: { data: readSkeleton(reader) },
    m_SkeletonPose: { data: readSkeletonPose(reader) },
    m_LeftHand: { data: { m_HandBoneIndex: readInts(reader, "m_HandBoneIndex") } },
    m_RightHand: { data: { m_HandBoneIndex: readInts(reader, "m_HandBoneIndex") } },
    m_HumanBoneIndex: readInts(reader, "m_HumanBoneIndex"),
    m_HumanBoneMass: readFloats(reader, OWNER, "m_HumanBoneMass"),
    m_Scale: reader.readFloat32(),
    m_ArmTwist: reader.readFloat32(),
    m_ForeArmTwist: reader.readFloat32(),
    m_UpperLegTwist: reader.readFloat32(),
    m_LegTwist: reader.readFloat32(),
    m_ArmStretch: reader.readFloat32(),
    m_LegStretch: reader.readFloat32(),
    m_FeetSpacing: reader.readFloat32(),
    m_HasLeftHand: readBool(reader),
    m_HasRightHand: readBool(reader),
    m_HasTDoF: readBool(reader),
  };
  reader.align();
  return human;
}

/** `m_HumanDescription`: not read by upstream; TPK's layout, the same from 2019.1 to 6000.6. */
function readHumanDescription(reader: ObjectReader): HumanDescription {
  const m_Human = readArray(reader, OWNER, "m_Human", (r) => {
    const bone: HumanBone = {
      m_BoneName: readStringField(r, OWNER, "m_BoneName"),
      m_HumanName: readStringField(r, OWNER, "m_HumanName"),
      m_Limit: {
        m_Min: readFloat3(r),
        m_Max: readFloat3(r),
        m_Value: readFloat3(r),
        m_Length: r.readFloat32(),
        m_Modified: readBool(r),
      },
    };
    r.align();
    return bone;
  });
  const m_Skeleton = readArray(reader, OWNER, "m_Skeleton", (r) => ({
    m_Name: readStringField(r, OWNER, "m_Name"),
    m_ParentName: readStringField(r, OWNER, "m_ParentName"),
    m_Position: readFloat3(r),
    m_Rotation: readFloat4(r),
    m_Scale: readFloat3(r),
  }));
  const description: HumanDescription = {
    m_Human,
    m_Skeleton,
    m_ArmTwist: reader.readFloat32(),
    m_ForeArmTwist: reader.readFloat32(),
    m_UpperLegTwist: reader.readFloat32(),
    m_LegTwist: reader.readFloat32(),
    m_ArmStretch: reader.readFloat32(),
    m_LegStretch: reader.readFloat32(),
    m_FeetSpacing: reader.readFloat32(),
    m_GlobalScale: reader.readFloat32(),
    m_RootMotionBoneName: readStringField(reader, OWNER, "m_RootMotionBoneName"),
    m_HasTranslationDoF: readBool(reader),
    m_HasExtraRoot: readBool(reader),
    m_SkeletonHasParents: readBool(reader),
  };
  reader.align();
  return description;
}

function readInts(reader: ObjectReader, what: string): number[] {
  return readIntArray(reader, OWNER, what);
}

function readUInts(reader: ObjectReader, what: string): number[] {
  return readUIntArray(reader, OWNER, what);
}
