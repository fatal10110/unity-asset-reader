// Ported from AssetStudio.Utility/YAML/AnimationClipExtensions.cs (MIT, © Perfare / RazTools / Razviar)
import type {
  AnimationClip,
  AnimationEvent,
  Env,
  Keyframe,
  ObjectReader,
} from "unity-asset-reader";
import {
  convertMuscleClip,
  type CurveKey,
  type Curves,
  type FloatCurve,
  type TransformCurve,
} from "./converter.js";
import { customCurveResolver } from "./custom.js";
import { CLASS, findTOS, Scene } from "./tos.js";

export type {
  CurveKey,
  Curves,
  FloatCurve,
  PPtrCurve,
  PPtrKey,
  TransformCurve,
} from "./converter.js";
export { muscleName } from "./muscle.js";

/** A clip's curves and events, as AssetStudio's `.anim` export holds them. */
export interface ClipCurves extends Curves {
  /** The clip's `m_Events`, as read. */
  events: AnimationEvent[];
}

const key = <T>(k: Keyframe<T>): CurveKey<T> => ({
  time: k.time,
  value: k.value,
  inSlope: k.inSlope,
  outSlope: k.outSlope,
});

/** `converted`, then each of `legacy` whose id no curve before it has (C#'s `Union`). */
function union<T>(converted: T[], legacy: T[], id: (curve: T) => string): T[] {
  const seen = new Set<string>();
  return [...converted, ...legacy].filter((curve) => {
    const k = id(curve);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The curves of an `AnimationClip`, as AssetStudio's `.anim` export holds them
 * (upstream `AnimationClipExtensions.Convert`, without the YAML): rotation,
 * euler, position, scale, float and object reference curves, each with its
 * path and keyframes, plus the clip's events.
 *
 * A Mecanim clip's `m_MuscleClip` is decoded as upstream's
 * `AnimationClipConverter` does ({@link convertMuscleClip}): its bindings'
 * path hashes are named from the loaded Avatars, the Animators that play the
 * clip and the legacy Animation components that list it (upstream `FindTOS`),
 * and stay `path_<hash>` where none names them;
 * humanoid curves are named muscle attributes (`RootT.y`, `Spine Front-Back`)
 * on path `""`, not converted to bones. The legacy curve arrays follow, each
 * curve unless a decoded one has its path (and for a float curve its
 * attribute and class id), as upstream's `Union`; object reference curves are
 * never merged, as upstream compares them by reference. Upstream leaves
 * `m_CompressedRotationCurves` compressed, so they are not here either.
 *
 * Isomorphic and sync. Each call reads what it needs from `env` again.
 *
 * @param env the loaded files; upstream searches all of them for the clip's
 *   Avatar, Animator or Animation, so load the bundle that holds them too
 * @param clip the clip's object, one of `env.objects`
 * @returns plain data: numbers are float32 values, as upstream computes them
 * @throws {TypeError} when `clip` is not an `AnimationClip` (class 74)
 * @throws {Error} where upstream's conversion throws (see
 *   {@link convertMuscleClip}), and when a GameObject the paths are walked
 *   through has no Transform or an Animator with a hierarchy lacks its
 *   GameObject, where upstream throws `NullReferenceException`
 * @throws {UnsupportedError} / {CorruptError} what reading the clip or the
 *   objects its names come from throws
 */
export function clipCurves(env: Env, clip: ObjectReader): ClipCurves {
  if (clip.type !== CLASS.AnimationClip) {
    throw new TypeError(
      `object ${clip.pathId} is of class ${clip.type}, not an AnimationClip (74)`,
    );
  }
  const scene = new Scene(env);
  const data = scene.read<AnimationClip>(clip);
  const converted = convertMuscleClip(
    data,
    findTOS(scene, clip, data),
    customCurveResolver(scene, clip),
  );
  const transform = <T>(c: {
    curve: { m_Curve: Keyframe<T>[] };
    path: string;
  }): TransformCurve<T> => ({
    path: c.path,
    keyframes: c.curve.m_Curve.map(key),
  });
  const byPath = (c: { path: string }) => c.path;
  return {
    rotation: union(converted.rotation, data.m_RotationCurves.map(transform), byPath),
    euler: union(converted.euler, data.m_EulerCurves.map(transform), byPath),
    position: union(converted.position, data.m_PositionCurves.map(transform), byPath),
    scale: union(converted.scale, data.m_ScaleCurves.map(transform), byPath),
    float: union(
      converted.float,
      data.m_FloatCurves.map((c): FloatCurve => ({
        path: c.path,
        attribute: c.attribute,
        classId: c.classID,
        keyframes: c.curve.m_Curve.map(key),
      })),
      (c) => JSON.stringify([c.attribute, c.path, c.classId]),
    ),
    pptr: [
      ...converted.pptr,
      ...data.m_PPtrCurves.map((c) => ({
        path: c.path,
        attribute: c.attribute,
        classId: c.classID,
        keyframes: c.curve.map((k) => ({ time: k.time, value: k.value })),
      })),
    ],
    events: data.m_Events,
  };
}
