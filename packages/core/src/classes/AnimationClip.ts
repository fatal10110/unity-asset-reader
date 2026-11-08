// Ported from AssetStudio/Classes/AnimationClip.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader, Quaternion, Vector3, XForm } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import {
  animationLayoutVersion,
  readBool,
  readFloat3,
  readFloat4,
  readFloats,
  readHumanPose,
  readInts,
  readUInts,
  readXForm,
  type HumanPose,
  type OffsetPtr,
} from "./animation.js";
import type { PackedFloatVector, PackedIntVector } from "./Mesh.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray, type AABB } from "./Sprite.js";
import { readStringField } from "./strings.js";
import { atLeast, patchFrom } from "./version.js";

const OWNER = "AnimationClip";

/** A key of an {@link AnimationCurve} of `T` (Unity's `Keyframe`). */
export interface Keyframe<T> {
  time: number;
  value: T;
  inSlope: T;
  outSlope: T;
  /** Unity's `WeightedMode`: 0 none, 1 in, 2 out, 3 both. */
  weightedMode: number;
  inWeight: T;
  outWeight: T;
}

/** Keys of a value over time (Unity's `AnimationCurve`). */
export interface AnimationCurve<T> {
  m_Curve: Keyframe<T>[];
  /** Unity's `WrapMode` before the first key. */
  m_PreInfinity: number;
  /** Unity's `WrapMode` after the last key. */
  m_PostInfinity: number;
  /** Unity's `RotationOrder`: 4 is `ZXY`, Unity's default. */
  m_RotationOrder: number;
}

/** A legacy rotation curve: quaternion keys for one transform path. */
export interface QuaternionCurve {
  curve: AnimationCurve<Quaternion>;
  path: string;
}

/** A legacy position, scale or euler rotation curve: `Vector3` keys for one transform path. */
export interface Vector3Curve {
  curve: AnimationCurve<Vector3>;
  path: string;
}

/** Quaternions packed into `m_Data` (Unity's `PackedBitVector` of a compressed curve's values). */
export interface PackedQuatVector {
  m_NumItems: number;
  /** The packed bits: a view into the object's bytes (R7). */
  m_Data: Uint8Array;
}

/** A legacy rotation curve stored compressed, as the bit vectors Unity packed it into. */
export interface CompressedAnimationCurve {
  m_Path: string;
  m_Times: PackedIntVector;
  m_Values: PackedQuatVector;
  m_Slopes: PackedFloatVector;
  m_PreInfinity: number;
  m_PostInfinity: number;
}

/** A legacy curve of any other animatable float property. */
export interface FloatCurve {
  curve: AnimationCurve<number>;
  /** The property, as `m_Color.a` or a script field's name. */
  attribute: string;
  path: string;
  /** The class id of the component holding the property (a `Type*`, read unsigned). */
  classID: number;
  /** The script whose field it is, for a MonoBehaviour property. */
  script: PPtr;
  /** Unity 2022.2 and later. */
  flags?: number;
}

/** A key of a {@link PPtrCurve} (Unity's `PPtrKeyframe`). */
export interface PPtrKeyframe {
  time: number;
  value: PPtr;
}

/** A legacy curve of object references, as a sprite swap. */
export interface PPtrCurve {
  curve: PPtrKeyframe[];
  attribute: string;
  path: string;
  /** The class id of the component holding the property. */
  classID: number;
  script: PPtr;
  /** Unity 2022.2 and later. */
  flags?: number;
}

/**
 * The curves stored as keys (Unity's `StreamedClip`), the raw words: this
 * reader does not decode them.
 */
export interface StreamedClip {
  data: number[];
  /** An `unsigned int` before the split, a `UInt16` with it (see {@link readAnimationClip}). */
  curveCount: number;
  /** The curves of object references among them: with the split only. */
  discreteCurveCount?: number;
}

/** The curves stored as one sample per frame (Unity's `DenseClip`), the raw samples. */
export interface DenseClip {
  m_FrameCount: number;
  m_CurveCount: number;
  m_SampleRate: number;
  m_BeginTime: number;
  /** `m_CurveCount` samples per frame. */
  m_SampleArray: number[];
}

/** The curves that hold one value (Unity's `ConstantClip`): one float per curve. */
export interface ConstantClip {
  data: number[];
}

/** The three parts a Mecanim clip's curves are stored in (Unity's `Clip`). */
export interface Clip {
  m_StreamedClip: StreamedClip;
  m_DenseClip: DenseClip;
  m_ConstantClip: ConstantClip;
}

/** A curve's first and last values (Unity's `ValueDelta`). */
export interface ValueDelta {
  m_Start: number;
  m_Stop: number;
}

/** A Mecanim clip's runtime data and its import settings (Unity's `ClipMuscleConstant`). */
export interface ClipMuscleConstant {
  m_DeltaPose: HumanPose;
  m_StartX: XForm;
  m_StopX: XForm;
  m_LeftFootStartX: XForm;
  m_RightFootStartX: XForm;
  m_AverageSpeed: Vector3;
  m_Clip: OffsetPtr<Clip>;
  m_StartTime: number;
  m_StopTime: number;
  m_OrientationOffsetY: number;
  m_Level: number;
  m_CycleOffset: number;
  m_AverageAngularSpeed: number;
  /** Each binding's curve index, -1 for none. */
  m_IndexArray: number[];
  m_ValueArrayDelta: ValueDelta[];
  m_ValueArrayReferencePose: number[];
  m_Mirror: boolean;
  m_LoopTime: boolean;
  m_LoopBlend: boolean;
  m_LoopBlendOrientation: boolean;
  m_LoopBlendPositionY: boolean;
  m_LoopBlendPositionXZ: boolean;
  m_StartAtOrigin: boolean;
  m_KeepOriginalOrientation: boolean;
  m_KeepOriginalPositionY: boolean;
  m_KeepOriginalPositionXZ: boolean;
  m_HeightFromFeet: boolean;
}

/** What a Mecanim clip's curve animates (Unity's `GenericBinding`). */
export interface GenericBinding {
  /** The CRC32 of the transform path. */
  path: number;
  /** The CRC32 of the property, or a transform channel: 1 position, 2 rotation, 3 scale, 4 euler. */
  attribute: number;
  script: PPtr;
  /** The class id of the animated component. */
  typeID: number;
  customType: number;
  /** 1 for a curve of object references. */
  isPPtrCurve: number;
  /** Unity 2022.1 and later. */
  isIntCurve?: number;
  /** Unity 2022.2 and later. */
  isSerializeReferenceCurve?: number;
  /** Unity 6000.5 and later. */
  metaData?: number;
}

/** A Mecanim clip's bindings (Unity's `AnimationClipBindingConstant`). */
export interface AnimationClipBindingConstant {
  genericBindings: GenericBinding[];
  /** The objects the curves of object references switch between. */
  pptrCurveMapping: PPtr[];
}

/** A function call at a time of the clip (Unity's `AnimationEvent`). */
export interface AnimationEvent {
  time: number;
  functionName: string;
  /** The string parameter. */
  data: string;
  objectReferenceParameter: PPtr;
  floatParameter: number;
  intParameter: number;
  /** Unity's `SendMessageOptions`: 0 require a receiver, 1 do not. */
  messageOptions: number;
}

/**
 * The fields of an `AnimationClip`, as a player build stores them, under
 * Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object. The curves come raw: the streamed
 * words, dense samples and constants are not decoded.
 *
 * A legacy clip (`m_Legacy`) keeps its curves in the curve arrays and an
 * empty `m_MuscleClip`; a Mecanim clip has them in `m_MuscleClip`, the curve
 * arrays emptied.
 */
export interface AnimationClip extends NamedObject {
  m_Legacy: boolean;
  m_Compressed: boolean;
  m_UseHighQualityCurve: boolean;
  m_RotationCurves: QuaternionCurve[];
  m_CompressedRotationCurves: CompressedAnimationCurve[];
  m_EulerCurves: Vector3Curve[];
  m_PositionCurves: Vector3Curve[];
  m_ScaleCurves: Vector3Curve[];
  m_FloatCurves: FloatCurve[];
  m_PPtrCurves: PPtrCurve[];
  m_SampleRate: number;
  /** Unity's `WrapMode`. */
  m_WrapMode: number;
  m_Bounds: AABB;
  /** The byte size of the runtime clip blob; 0 for a legacy clip. */
  m_MuscleClipSize: number;
  m_MuscleClip: ClipMuscleConstant;
  m_ClipBindingConstant: AnimationClipBindingConstant;
  m_HasGenericRootTransform: boolean;
  m_HasMotionFloatCurves: boolean;
  m_Events: AnimationEvent[];
}

/**
 * Read an `AnimationClip` from the object's first byte: every field Unity's
 * own player type trees give for its version (as UnityPy's TPK data records
 * them), in their order. The object must end exactly there.
 *
 * Upstream reads the 2019.1 fields, `isIntCurve` (2022.1) and the curves'
 * `flags` (2022.2). It lacks what TPK adds: `isSerializeReferenceCurve`
 * (2022.2) and `metaData` (6000.5) at the end of each `GenericBinding`, and
 * the split of `StreamedClip`'s `unsigned int curveCount` into the `UInt16`s
 * `curveCount` and `discreteCurveCount` (2022.3.19 to 2022.3, 2023.2.8 to
 * 2023.2, and 2023.3 and later; 2023.1 has no split). Upstream's
 * game-specific clips and fields (the ACL clips, `m_StreamData`) are not
 * Unity's and are not read; nor are its pre-2019 layouts.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). TPK
 * records the 2023.3 alphas before b1 without the split; such a pre-release
 * gets its `unsigned int` count's 4 bytes as the two `UInt16`s.
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
export function readAnimationClip(reader: ObjectReader): AnimationClip {
  const version = animationLayoutVersion(reader, OWNER);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<AnimationClip> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, OWNER, () => readClipFields(reader, version, out));
  // Every required field was set above.
  return out as AnimationClip;
}

function readClipFields(reader: ObjectReader, version: UnityVersion, out: Partial<AnimationClip>) {
  out.m_Legacy = readBool(reader);
  out.m_Compressed = readBool(reader);
  out.m_UseHighQualityCurve = readBool(reader);
  reader.align();
  out.m_RotationCurves = curves(reader, "m_RotationCurves", (r) => ({
    curve: readCurve(r, readFloat4),
    path: readStringField(r, OWNER, "path"),
  }));
  out.m_CompressedRotationCurves = curves(reader, "m_CompressedRotationCurves", (r) => {
    const m_Path = readStringField(r, OWNER, "m_Path");
    // Each packed vector's bytes, and its bit size, are padded to 4.
    const m_Times = {
      m_NumItems: r.readUInt32(),
      m_Data: readBytes(r, "m_Times"),
      m_BitSize: readUInt8Aligned(r),
    };
    const m_Values = { m_NumItems: r.readUInt32(), m_Data: readBytes(r, "m_Values") };
    const m_Slopes = {
      m_NumItems: r.readUInt32(),
      m_Range: r.readFloat32(),
      m_Start: r.readFloat32(),
      m_Data: readBytes(r, "m_Slopes"),
      m_BitSize: readUInt8Aligned(r),
    };
    return {
      m_Path,
      m_Times,
      m_Values,
      m_Slopes,
      m_PreInfinity: r.readInt32(),
      m_PostInfinity: r.readInt32(),
    };
  });
  const vector3Curve = (r: ObjectReader): Vector3Curve => ({
    curve: readCurve(r, readFloat3),
    path: readStringField(r, OWNER, "path"),
  });
  out.m_EulerCurves = curves(reader, "m_EulerCurves", vector3Curve);
  out.m_PositionCurves = curves(reader, "m_PositionCurves", vector3Curve);
  out.m_ScaleCurves = curves(reader, "m_ScaleCurves", vector3Curve);
  // 2022.2+: a curve's flags.
  const flags = atLeast(version, 2022, 2);
  out.m_FloatCurves = curves(reader, "m_FloatCurves", (r) => {
    const curve: FloatCurve = {
      curve: readCurve(r, (k) => k.readFloat32()),
      attribute: readStringField(r, OWNER, "attribute"),
      path: readStringField(r, OWNER, "path"),
      classID: r.readUInt32(),
      script: readPPtr(r),
    };
    if (flags) curve.flags = r.readInt32();
    return curve;
  });
  out.m_PPtrCurves = curves(reader, "m_PPtrCurves", (r) => {
    const keys = readArray(r, OWNER, "curve", (k) => ({ time: k.readFloat32(), value: readPPtr(k) }));
    r.align();
    const curve: PPtrCurve = {
      curve: keys,
      attribute: readStringField(r, OWNER, "attribute"),
      path: readStringField(r, OWNER, "path"),
      classID: r.readUInt32(),
      script: readPPtr(r),
    };
    if (flags) curve.flags = r.readInt32();
    return curve;
  });
  out.m_SampleRate = reader.readFloat32();
  out.m_WrapMode = reader.readInt32();
  out.m_Bounds = { m_Center: readFloat3(reader), m_Extent: readFloat3(reader) };
  out.m_MuscleClipSize = reader.readUInt32();
  out.m_MuscleClip = readMuscleClip(reader, version);
  out.m_ClipBindingConstant = readBindings(reader, version);
  out.m_HasGenericRootTransform = readBool(reader);
  out.m_HasMotionFloatCurves = readBool(reader);
  reader.align();
  out.m_Events = curves(reader, "m_Events", (r) => ({
    time: r.readFloat32(),
    functionName: readStringField(r, OWNER, "functionName"),
    data: readStringField(r, OWNER, "data"),
    objectReferenceParameter: readPPtr(r),
    floatParameter: r.readFloat32(),
    intParameter: r.readInt32(),
    messageOptions: r.readInt32(),
  }));
  endOfObject(reader, OWNER);
}

/** One of the clip's top-level arrays: a count, the elements, then padding to 4. */
function curves<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  const out = readArray(reader, OWNER, what, element);
  reader.align();
  return out;
}

/** An `AnimationCurve` of the values `value` reads: its keys (padded to 4), then three ints. */
function readCurve<T>(reader: ObjectReader, value: (r: ObjectReader) => T): AnimationCurve<T> {
  const m_Curve = readArray(reader, OWNER, "m_Curve", (r) => ({
    time: r.readFloat32(),
    value: value(r),
    inSlope: value(r),
    outSlope: value(r),
    weightedMode: r.readInt32(),
    inWeight: value(r),
    outWeight: value(r),
  }));
  reader.align();
  return {
    m_Curve,
    m_PreInfinity: reader.readInt32(),
    m_PostInfinity: reader.readInt32(),
    m_RotationOrder: reader.readInt32(),
  };
}

/** A `vector<UInt8>`: a count, the bytes as a view (R7), then padding to 4. */
function readBytes(reader: ObjectReader, what: string): Uint8Array {
  const bytes = reader.readBytes(readCount(reader, `${OWNER} ${reader.pathId} ${what} byte`));
  reader.align();
  return bytes;
}

function readUInt8Aligned(reader: ObjectReader): number {
  const value = reader.readUInt8();
  reader.align();
  return value;
}

/** `m_MuscleClip`: upstream's `ClipMuscleConstant` for 5.5 and later, Unity's own clips. */
function readMuscleClip(reader: ObjectReader, version: UnityVersion): ClipMuscleConstant {
  const head = {
    m_DeltaPose: readHumanPose(reader, OWNER),
    m_StartX: readXForm(reader),
    m_StopX: readXForm(reader),
    m_LeftFootStartX: readXForm(reader),
    m_RightFootStartX: readXForm(reader),
    m_AverageSpeed: readFloat3(reader),
  };
  const data = readUInts(reader, OWNER, "m_StreamedClip.data");
  const m_StreamedClip: StreamedClip = splitCurveCount(version)
    ? { data, curveCount: reader.readUInt16(), discreteCurveCount: reader.readUInt16() }
    : { data, curveCount: reader.readUInt32() };
  const m_DenseClip: DenseClip = {
    m_FrameCount: reader.readInt32(),
    m_CurveCount: reader.readUInt32(),
    m_SampleRate: reader.readFloat32(),
    m_BeginTime: reader.readFloat32(),
    m_SampleArray: readFloats(reader, OWNER, "m_SampleArray"),
  };
  const clip: ClipMuscleConstant = {
    ...head,
    m_Clip: {
      data: {
        m_StreamedClip,
        m_DenseClip,
        m_ConstantClip: { data: readFloats(reader, OWNER, "m_ConstantClip.data") },
      },
    },
    m_StartTime: reader.readFloat32(),
    m_StopTime: reader.readFloat32(),
    m_OrientationOffsetY: reader.readFloat32(),
    m_Level: reader.readFloat32(),
    m_CycleOffset: reader.readFloat32(),
    m_AverageAngularSpeed: reader.readFloat32(),
    m_IndexArray: readInts(reader, OWNER, "m_IndexArray"),
    m_ValueArrayDelta: readArray(reader, OWNER, "m_ValueArrayDelta", (r) => ({
      m_Start: r.readFloat32(),
      m_Stop: r.readFloat32(),
    })),
    m_ValueArrayReferencePose: readFloats(reader, OWNER, "m_ValueArrayReferencePose"),
    m_Mirror: readBool(reader),
    m_LoopTime: readBool(reader),
    m_LoopBlend: readBool(reader),
    m_LoopBlendOrientation: readBool(reader),
    m_LoopBlendPositionY: readBool(reader),
    m_LoopBlendPositionXZ: readBool(reader),
    m_StartAtOrigin: readBool(reader),
    m_KeepOriginalOrientation: readBool(reader),
    m_KeepOriginalPositionY: readBool(reader),
    m_KeepOriginalPositionXZ: readBool(reader),
    m_HeightFromFeet: readBool(reader),
  };
  reader.align();
  return clip;
}

/**
 * Whether `StreamedClip` has the `UInt16` `curveCount` and
 * `discreteCurveCount` (TPK): 2022.3.19 to 2022.3, 2023.2.8 to 2023.2, and
 * 2023.3 (6000.0) and later, not 2023.1.
 */
function splitCurveCount(version: UnityVersion): boolean {
  return (
    patchFrom(version, 2022, 3, 19) || patchFrom(version, 2023, 2, 8) || atLeast(version, 2023, 3)
  );
}

/** `m_ClipBindingConstant`, with TPK's binding fields upstream lacks. */
function readBindings(reader: ObjectReader, version: UnityVersion): AnimationClipBindingConstant {
  const genericBindings = readArray(reader, OWNER, "genericBindings", (r) => {
    const binding: GenericBinding = {
      path: r.readUInt32(),
      attribute: r.readUInt32(),
      script: readPPtr(r),
      typeID: r.readInt32(),
      customType: r.readUInt8(),
      isPPtrCurve: r.readUInt8(),
    };
    // 2022.1+: isIntCurve; 2022.2+: isSerializeReferenceCurve; 6000.5+: metaData.
    if (atLeast(version, 2022, 1)) binding.isIntCurve = r.readUInt8();
    if (atLeast(version, 2022, 2)) binding.isSerializeReferenceCurve = r.readUInt8();
    if (atLeast(version, 6000, 5)) binding.metaData = r.readUInt16();
    r.align();
    return binding;
  });
  reader.align();
  const pptrCurveMapping = readArray(reader, OWNER, "pptrCurveMapping", readPPtr);
  reader.align();
  return { genericBindings, pptrCurveMapping };
}
