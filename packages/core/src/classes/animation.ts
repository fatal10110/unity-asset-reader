// Ported from AssetStudio/Classes/AnimationClip.cs (MIT, © Perfare / RazTools / Razviar)

// The structs the animation class readers share (#303, #302): Unity's
// `OffsetPtr`, `ValueConstant` and `ValueArrayConstant`, and the humanoid pose
// structs `HumanGoal`, `HandPose` and `HumanPose`. Unity 2019.1 and later
// only (plan revision 2026-10-16), where none of them depends on the version:
// their trees are the same in every Unity player type tree from 2019.1 to
// 6000.6 (UnityPy's TPK data). Each shape is what `readTypeTree()` gives for
// the same bytes: Unity's field names, `float3` as `Vector3`, `float4` as
// `Vector4`, `xform` as `XForm`.

import { UnsupportedError } from "../errors.js";
import type { ObjectReader, Quaternion, Vector3, XForm } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { layoutVersion, readArray, readVector4, type Vector4 } from "./Sprite.js";
import { atLeast } from "./version.js";

/**
 * Unity's `OffsetPtr`: a struct holding one other struct, by value, under
 * the key `data`. The runtime blob points to it with an offset; the
 * serialized object stores it in place.
 */
export interface OffsetPtr<T> {
  data: T;
}

/** One value of a `ValueArray` (Unity's `ValueConstant`). */
export interface ValueConstant {
  /** The CRC32 of the parameter's name. */
  m_ID: number;
  /** The value's type (Unity's `ValueType`): 1 float, 3 int, 4 bool, 9 trigger, ... */
  m_Type: number;
  /** The value's index in the `ValueArray` array of its type. */
  m_Index: number;
}

/** The parameters of a controller (Unity's `ValueArrayConstant`). */
export interface ValueArrayConstant {
  m_ValueArray: ValueConstant[];
}

/** An IK goal of a {@link HumanPose} (Unity's `HumanGoal`). */
export interface HumanGoal {
  m_X: XForm;
  m_WeightT: number;
  m_WeightR: number;
  m_HintT: Vector3;
  m_HintWeightT: number;
}

/** A hand of a {@link HumanPose} (Unity's `HandPose`). */
export interface HandPose {
  m_GrabX: XForm;
  /** One float per finger degree of freedom. */
  m_DoFArray: number[];
  m_Override: number;
  m_CloseOpen: number;
  m_InOut: number;
  m_Grab: number;
}

/** A humanoid pose: root, look-at, IK goals, hands and muscles (Unity's `HumanPose`). */
export interface HumanPose {
  m_RootX: XForm;
  m_LookAtPosition: Vector3;
  m_LookAtWeight: Vector4;
  m_GoalArray: HumanGoal[];
  m_LeftHandPose: HandPose;
  m_RightHandPose: HandPose;
  /** One float per muscle. */
  m_DoFArray: number[];
  /** One translation per translation degree of freedom. */
  m_TDoFArray: Vector3[];
}

/**
 * Read a `float3` (or `Vector3f`): three floats. Unlike
 * `ObjectReader.readVector3`, which reads four before Unity 5.4, this reads
 * three for any version, so a version-stripped (`[0, 0, 0, 0]`) 2019 object
 * reads too.
 */
export function readFloat3(reader: ObjectReader): Vector3 {
  return { x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32() };
}

/** Read a `float4` (or `Quaternionf`): four floats. */
export function readFloat4(reader: ObjectReader): Vector4 & Quaternion {
  return readVector4(reader);
}

/**
 * Read an `xform`: a `float3` translation, a `float4` rotation and a `float3`
 * scale, as {@link readFloat3} reads them for any version (unlike
 * `ObjectReader.readXForm`).
 */
export function readXForm(reader: ObjectReader): XForm {
  return { t: readFloat3(reader), q: readFloat4(reader), s: readFloat3(reader) };
}

/**
 * Read a `ValueArrayConstant`: an `Int32` count, then that many
 * `ValueConstant`s (`m_ID`, `m_Type`, `m_Index`; Unity 5.5 dropped
 * upstream's `m_TypeID`).
 *
 * @param reader left just past the struct
 * @param owner the class being read, for the error message
 * @throws {CorruptError} when the count is negative or runs past the object's end
 */
export function readValueArrayConstant(reader: ObjectReader, owner: string): ValueArrayConstant {
  return {
    m_ValueArray: readArray(reader, owner, "m_ValueArray", (r) => ({
      m_ID: r.readUInt32(),
      m_Type: r.readUInt32(),
      m_Index: r.readUInt32(),
    })),
  };
}

/**
 * Read a `HumanPose`, as upstream's `HumanPose` constructor does for Unity
 * 5.2 and later.
 *
 * @param reader left just past the struct
 * @param owner the class being read, for the error message
 * @throws {CorruptError} when a count is negative or runs past the object's end
 */
export function readHumanPose(reader: ObjectReader, owner: string): HumanPose {
  return {
    m_RootX: readXForm(reader),
    m_LookAtPosition: readFloat3(reader),
    m_LookAtWeight: readFloat4(reader),
    m_GoalArray: readArray(reader, owner, "m_GoalArray", (r) => ({
      m_X: readXForm(r),
      m_WeightT: r.readFloat32(),
      m_WeightR: r.readFloat32(),
      m_HintT: readFloat3(r),
      m_HintWeightT: r.readFloat32(),
    })),
    m_LeftHandPose: readHandPose(reader, owner),
    m_RightHandPose: readHandPose(reader, owner),
    m_DoFArray: readFloats(reader, owner, "m_DoFArray"),
    m_TDoFArray: readArray(reader, owner, "m_TDoFArray", readFloat3),
  };
}

/** A `HandPose` (upstream's constructor; its Genshin-only `ParseGI` is not ported). */
function readHandPose(reader: ObjectReader, owner: string): HandPose {
  return {
    m_GrabX: readXForm(reader),
    m_DoFArray: readFloats(reader, owner, "m_DoFArray"),
    m_Override: reader.readFloat32(),
    m_CloseOpen: reader.readFloat32(),
    m_InOut: reader.readFloat32(),
    m_Grab: reader.readFloat32(),
  };
}

/**
 * An `Int32` count, then that many `float`s. Internal: shared with the
 * animation class readers.
 *
 * @throws {CorruptError} when the count is negative or runs past the object's end
 */
export function readFloats(reader: ObjectReader, owner: string, what: string): number[] {
  return readArray(reader, owner, what, (r) => r.readFloat32());
}

/** An `Int32` count, then that many `int`s. Internal, as {@link readFloats}. */
export function readInts(reader: ObjectReader, owner: string, what: string): number[] {
  return readArray(reader, owner, what, (r) => r.readInt32());
}

/** An `Int32` count, then that many `unsigned int`s. Internal, as {@link readFloats}. */
export function readUInts(reader: ObjectReader, owner: string, what: string): number[] {
  return readArray(reader, owner, what, (r) => r.readUInt32());
}

/**
 * The version whose layout an animation class object has, after the
 * refusals its readers share: Unity 2019.1 and later only, the supported
 * floor, and an unknown version (`[0, 0, 0, 0]`) read as 2019 in formats 18
 * to 21 only (see `layoutVersion`). Internal: shared with the animation
 * class readers.
 *
 * @throws {UnsupportedError} of kind `"Unity version"` before 2019.1, or for
 *   an unknown version in another format; of kind `"build target"` for an
 *   editor file, whose objects hold editor-only fields
 */
export function animationLayoutVersion(reader: ObjectReader, owner: string): UnityVersion {
  const stripped = reader.version.every((part) => part === 0);
  if (!stripped && !atLeast(reader.version, 2019, 1)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: the ${owner} reader reads Unity 2019.1 and later, the ` +
        "supported floor; readTypeTree() reads an older one",
    );
  }
  return layoutVersion(reader, owner, 2019, 1);
}

/** A `bool`: one byte, not 0 is true. Internal: shared with the animation class readers. */
export function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}
