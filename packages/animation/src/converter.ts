// Ported from AssetStudio.Utility/YAML/AnimationClipConverter.cs (MIT, © Perfare / RazTools / Razviar)
import type {
  AnimationClip,
  AnimationClipBindingConstant,
  GenericBinding,
  PPtr,
  Quaternion,
  Vector3,
} from "unity-asset-reader";
import { crc32 } from "./crc.js";
import { BindingCustomType, type AttributeNamer } from "./custom.js";
import { muscleName } from "./muscle.js";
import { nextInSlope, readStreamedFrames, type StreamedFrame } from "./streamed.js";

const f32 = Math.fround;

/** One key of a curve: its time, value and tangents. */
export interface CurveKey<T> {
  time: number;
  value: T;
  inSlope: T;
  outSlope: T;
}

/** A transform curve: the keys of the Transform at `path`. */
export interface TransformCurve<T> {
  /** The Transform's path below the animated GameObject, `""` for the GameObject itself. */
  path: string;
  keyframes: CurveKey<T>[];
}

/** A curve of one float property. */
export interface FloatCurve {
  path: string;
  /** The property, as `m_IsActive`, `blendShape.Smile` or a humanoid muscle (`RootT.y`). */
  attribute: string;
  /** The class id of the component holding the property. */
  classId: number;
  keyframes: CurveKey<number>[];
}

/** A key of a {@link PPtrCurve}. */
export interface PPtrKey {
  time: number;
  /** The object switched to, relative to the clip's file. */
  value: PPtr;
}

/** A curve of object references, as a sprite swap. */
export interface PPtrCurve {
  path: string;
  attribute: string;
  classId: number;
  keyframes: PPtrKey[];
}

/** The curves of a clip, by kind, as AssetStudio's `.anim` lists them. */
export interface Curves {
  rotation: TransformCurve<Quaternion>[];
  euler: TransformCurve<Vector3>[];
  position: TransformCurve<Vector3>[];
  scale: TransformCurve<Vector3>[];
  float: FloatCurve[];
  pptr: PPtrCurve[];
}

const CLASS_GAME_OBJECT = 1;
const CLASS_TRANSFORM = 4;
const CLASS_MONO_BEHAVIOUR = 114;
const CLASS_ANIMATOR = 95;

/** Upstream `GetDimension`: 4 floats for a rotation, 3 for the other transform channels. */
const dimension = (binding: GenericBinding) => (binding.attribute === 2 ? 4 : 3);

/**
 * The binding of curve `index` (upstream `FindBinding`): a transform binding
 * spans its channel's floats, any other one float.
 *
 * @throws {Error} when the bindings end first, where upstream returns null
 *   and then throws `NullReferenceException`
 */
function findBinding(bindings: AnimationClipBindingConstant, index: number): GenericBinding {
  let curves = 0;
  for (const b of bindings.genericBindings) {
    if (b.typeID === CLASS_TRANSFORM) {
      curves +=
        b.attribute === 1 || b.attribute === 3 || b.attribute === 4 ? 3 : b.attribute === 2 ? 4 : 1;
    } else {
      curves += 1;
    }
    if (curves > index) return b;
  }
  throw new Error(`no binding for curve ${index}: the bindings hold ${curves} curves`);
}

/** `list[i]`, or an error where upstream's list index throws. */
function at<T>(list: T[], i: number, what: string): T {
  const item = list[i];
  if (item === undefined) throw new Error(`${what} ${i} is out of range (${list.length})`);
  return item;
}

/**
 * Decode a Mecanim clip's `m_MuscleClip` into curves, as upstream's
 * `AnimationClipConverter` does: the streamed keys (their in slopes computed
 * from the key before, out slopes stored), the dense samples and the
 * constants (at time 0 and at the clip's last frame), each without slopes.
 * Every float32 intermediate is rounded as upstream computes it.
 *
 * Deviation: upstream reads `StreamedClip.curveCount` as one `UInt32`
 * (`AnimationClip.cs:965`) and takes it as the number of streamed curves the
 * dense and constant curves follow. Since 2022.3.19, 2023.2.8 and 2023.3 the
 * field is two `UInt16`s, `curveCount` and `discreteCurveCount`, and the
 * discrete curves (object references, integers) are streamed after the
 * others, so upstream's count is `curveCount + (discreteCurveCount << 16)`.
 * The dense and constant curves follow `curveCount + discreteCurveCount`
 * here; the two agree on a clip without discrete curves. Upstream's ACL
 * clips are not Unity's and are not read.
 *
 * @param clip the clip's fields
 * @param tos each path hash's path ({@link findTOS})
 * @param attributeName names a custom binding's attribute
 * @throws {Error} where upstream throws: a curve without a binding, a
 *   streamed curve without an earlier key, a transform binding of an unknown
 *   channel, an object reference curve's index outside `pptrCurveMapping`,
 *   or a custom attribute the namer does not know
 * @throws {CorruptError} when the streamed words do not hold whole frames
 */
export function convertMuscleClip(
  clip: AnimationClip,
  tos: Map<number, string>,
  attributeName: AttributeNamer,
): Curves {
  const translations = new Map<string, CurveKey<Vector3>[]>();
  const rotations = new Map<string, CurveKey<Quaternion>[]>();
  const scales = new Map<string, CurveKey<Vector3>[]>();
  const eulers = new Map<string, CurveKey<Vector3>[]>();
  // Keyed by (attribute, path, classID), upstream FloatCurve's equality.
  const floats = new Map<string, FloatCurve>();
  // Upstream PPtrCurve's Equals is reference equality, so every key starts a curve of its own.
  const pptrs: PPtrCurve[] = [];

  const {
    m_StreamedClip: streamed,
    m_DenseClip: dense,
    m_ConstantClip: constant,
  } = clip.m_MuscleClip.m_Clip.data;
  const bindings = clip.m_ClipBindingConstant;
  const owner = `AnimationClip ${JSON.stringify(clip.m_Name)}`;

  const curvePath = (hash: number) => tos.get(hash) ?? `path_${hash}`;

  const vector = (v: number[], o: number): Vector3 => ({ x: v[o]!, y: v[o + 1]!, z: v[o + 2]! });
  const addTransformCurve = (
    time: number,
    transType: number,
    values: number[],
    inSlopes: number[],
    outSlopes: number[],
    offset: number,
    path: string,
  ) => {
    const add = <T>(map: Map<string, CurveKey<T>[]>, key: CurveKey<T>) => {
      const list = map.get(path);
      if (list) list.push(key);
      else map.set(path, [key]);
    };
    if (transType === 2) {
      const q = (v: number[], o: number): Quaternion => ({ ...vector(v, o), w: v[o + 3]! });
      add(rotations, {
        time,
        value: q(values, offset),
        inSlope: q(inSlopes, 0),
        outSlope: q(outSlopes, 0),
      });
      return;
    }
    const map =
      transType === 1
        ? translations
        : transType === 3
          ? scales
          : transType === 4
            ? eulers
            : undefined;
    if (!map) throw new Error(`transform binding of unknown channel ${transType}`);
    add(map, {
      time,
      value: vector(values, offset),
      inSlope: vector(inSlopes, 0),
      outSlope: vector(outSlopes, 0),
    });
  };

  const addFloatKeyframe = (
    path: string,
    attribute: string,
    classId: number,
    time: number,
    value: number,
  ) => {
    const id = JSON.stringify([attribute, path, classId]);
    let curve = floats.get(id);
    if (!curve) floats.set(id, (curve = { path, attribute, classId, keyframes: [] }));
    curve.keyframes.push({ time, value, inSlope: 0, outSlope: 0 });
  };

  const addDefaultCurve = (binding: GenericBinding, path: string, time: number, value: number) => {
    if (binding.typeID === CLASS_GAME_OBJECT) {
      const attribute =
        binding.attribute === crc32("m_IsActive") ? "m_IsActive" : `missed_${binding.attribute}`;
      addFloatKeyframe(path, attribute, CLASS_GAME_OBJECT, time, value);
    } else if (binding.typeID === CLASS_MONO_BEHAVIOUR) {
      addFloatKeyframe(path, `script_${binding.attribute}`, CLASS_MONO_BEHAVIOUR, time, value);
    } else {
      addFloatKeyframe(path, `typetree_${binding.attribute}`, binding.typeID, time, value);
    }
  };

  const addCustomCurve = (binding: GenericBinding, path: string, time: number, value: number) => {
    if (binding.customType === BindingCustomType.AnimatorMuscle) {
      addFloatKeyframe("", muscleName(binding.attribute), CLASS_ANIMATOR, time, value);
      return;
    }
    const attribute = attributeName(binding.customType, binding.attribute, path);
    if (binding.isPPtrCurve === 1) {
      // Upstream's (int) cast of the float; its first key is the reference
      // before, at time 0.
      const index = Math.trunc(value);
      const mapping = bindings.pptrCurveMapping;
      pptrs.push({
        path,
        attribute,
        classId: binding.typeID,
        keyframes: [
          { time: 0, value: at(mapping, index - 1, "pptrCurveMapping index") },
          { time, value: at(mapping, index, "pptrCurveMapping index") },
        ],
      });
    } else {
      addFloatKeyframe(path, attribute, binding.typeID, time, value);
    }
  };

  /** A curve's value at `time`, by its binding's kind. */
  const addCurve = (binding: GenericBinding, path: string, time: number, value: number) => {
    if (binding.customType === BindingCustomType.None) addDefaultCurve(binding, path, time, value);
    else addCustomCurve(binding, path, time, value);
  };

  const frames = readStreamedFrames(streamed.data, owner);
  const lastDenseFrame = f32(dense.m_FrameCount / dense.m_SampleRate);
  const lastSampleFrame = frames.length > 1 ? frames[frames.length - 2]!.time : 0;
  const lastFrame = Math.max(lastDenseFrame, lastSampleFrame);

  processStreams(frames, (frame, frameIndex) => {
    const keys = frame.keyList;
    const values = [0, 0, 0, 0];
    const inSlopes = [0, 0, 0, 0];
    const outSlopes = [0, 0, 0, 0];
    for (let curveIndex = 0; curveIndex < keys.length;) {
      const curve = keys[curveIndex]!;
      const binding = findBinding(bindings, curve.index);
      const path = curvePath(binding.path);
      if (binding.typeID === CLASS_TRANSFORM) {
        const [prevFrameIndex, prevCurveIndex] = previousFrame(frames, curve.index, frameIndex);
        for (let key = 0; key < dimension(binding); key++) {
          const keyCurve = at(keys, curveIndex, "streamed key");
          const prevFrame = frames[prevFrameIndex]!;
          const prevKeyCurve = at(prevFrame.keyList, prevCurveIndex + key, "streamed key");
          const deltaTime = f32(frame.time - prevFrame.time);
          values[key] = keyCurve.value;
          inSlopes[key] = nextInSlope(prevKeyCurve, deltaTime, keyCurve);
          outSlopes[key] = keyCurve.outSlope;
          curveIndex = nextCurve(frame, curveIndex);
        }
        addTransformCurve(frame.time, binding.attribute, values, inSlopes, outSlopes, 0, path);
      } else {
        addCurve(binding, path, frame.time, curve.value);
        curveIndex = nextCurve(frame, curveIndex);
      }
    }
  });

  // See the deviation above: the discrete curves are streamed too.
  const streamCount = streamed.curveCount + (streamed.discreteCurveCount ?? 0);
  const noSlopes = [0, 0, 0, 0];
  for (let frameIndex = 0; frameIndex < dense.m_FrameCount; frameIndex++) {
    const time = f32(frameIndex / dense.m_SampleRate);
    const frameOffset = frameIndex * dense.m_CurveCount;
    for (let curveIndex = 0; curveIndex < dense.m_CurveCount;) {
      const binding = findBinding(bindings, streamCount + curveIndex);
      const path = curvePath(binding.path);
      const framePosition = frameOffset + curveIndex;
      if (binding.typeID === CLASS_TRANSFORM) {
        addTransformCurve(
          time,
          binding.attribute,
          dense.m_SampleArray,
          noSlopes,
          noSlopes,
          framePosition,
          path,
        );
        curveIndex += dimension(binding);
      } else {
        addCurve(binding, path, time, at(dense.m_SampleArray, framePosition, "dense sample"));
        curveIndex++;
      }
    }
  }

  // Only the first and the last frame.
  for (const time of [0, lastFrame]) {
    for (let curveIndex = 0; curveIndex < constant.data.length;) {
      const binding = findBinding(bindings, streamCount + dense.m_CurveCount + curveIndex);
      const path = curvePath(binding.path);
      if (binding.typeID === CLASS_TRANSFORM) {
        addTransformCurve(
          time,
          binding.attribute,
          constant.data,
          noSlopes,
          noSlopes,
          curveIndex,
          path,
        );
        curveIndex += dimension(binding);
      } else {
        addCurve(binding, path, time, constant.data[curveIndex]!);
        curveIndex++;
      }
    }
  }

  const transform = <T>(map: Map<string, CurveKey<T>[]>): TransformCurve<T>[] =>
    [...map].map(([path, keyframes]) => ({ path, keyframes }));
  return {
    rotation: transform(rotations),
    euler: transform(eulers),
    position: transform(translations),
    scale: transform(scales),
    float: [...floats.values()],
    pptr: pptrs,
  };
}

/**
 * Every real frame of the stream, in order: upstream skips the first, which
 * only gives slopes, and the last, at +infinity.
 */
function processStreams(
  frames: StreamedFrame[],
  each: (frame: StreamedFrame, index: number) => void,
) {
  for (let frameIndex = 1; frameIndex < frames.length - 1; frameIndex++)
    each(frames[frameIndex]!, frameIndex);
}

/**
 * The latest frame before `currentFrame` with a key of curve `curveID`, and
 * that key's index in it (upstream `GetPreviousFrame`).
 */
function previousFrame(
  frames: StreamedFrame[],
  curveID: number,
  currentFrame: number,
): [number, number] {
  for (let frameIndex = currentFrame - 1; frameIndex >= 0; frameIndex--) {
    const curveIndex = frames[frameIndex]!.keyList.findIndex((k) => k.index === curveID);
    if (curveIndex >= 0) return [frameIndex, curveIndex];
  }
  throw new Error(`There is no curve with index ${curveID} in any of previous frames`);
}

/** The index of the frame's next key of another curve (upstream `GetNextCurve`). */
function nextCurve(frame: StreamedFrame, currentCurve: number): number {
  const index = frame.keyList[currentCurve]!.index;
  let i = currentCurve + 1;
  while (i < frame.keyList.length && frame.keyList[i]!.index === index) i++;
  return i;
}
