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
import { writeScene } from "./gltf.js";
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

/** Options of {@link sceneToGltf}. */
export interface SceneToGltfOptions {
  /**
   * The AnimationClips (class 74, objects of the same `env`) to write as glTF
   * animations, each read with {@link clipCurves}. None by default.
   */
  clips?: ObjectReader[];
}

/**
 * Write a GameObject's scene as a binary glTF 2.0 file (`.glb`): its
 * Transform hierarchy as nodes, its renderers' meshes with their skins and
 * blend shapes, and the clips as animations. AssetStudio exports the same
 * scene as FBX (`ModelConverter`); the conversion from Unity's left-handed
 * space is the one it applies and `meshToGltf` (unity-asset-reader-mesh)
 * applies to the geometry: positions, translations and morph deltas get x
 * negated, rotations y and z, bind poses are mirrored on both sides, and
 * triangles reverse their winding.
 *
 * - Nodes: the root GameObject's ancestors (each the only child of the one
 *   above, as ModelConverter keeps them) and its hierarchy by `m_Children`,
 *   each named after its GameObject with its local position, rotation and
 *   scale. Inactive GameObjects are written too; glTF has no visibility.
 * - Meshes: a SkinnedMeshRenderer's mesh, or a MeshRenderer's MeshFilter
 *   mesh, on the GameObject's node in the root's hierarchy (not on the
 *   ancestors, as upstream converts renderers from the root down): `POSITION`, `NORMAL` (left out when a
 *   normal is not unit length), `TEXCOORD_0`, a primitive per submesh with
 *   triangles. No materials, tangents, colours or other UV channels.
 * - Skins: a SkinnedMeshRenderer with `m_Bones` gets a skin whose joints are
 *   the bones' nodes, in `m_Bones` order (the order of the vertices' bone
 *   indices), and whose inverse bind matrices are the mesh's `m_BindPose`;
 *   `JOINTS_0` and `WEIGHTS_0` from the mesh's bone weights. A renderer
 *   without bones writes its mesh unskinned when the mesh has no bind poses;
 *   with bind poses (upstream finds the bones by `m_BoneNameHashes`, an
 *   optimized rig) it throws `UnsupportedError`.
 * - Blend shapes: a morph target per channel, the deltas of its last frame
 *   (glTF has no in-between frames, so a channel's earlier frames are
 *   dropped); the node's weights are the renderer's `m_BlendShapeWeights`
 *   over that frame's full weight (usually 100), so 1 is the full shape.
 * - Animations: per clip, `translation`, `rotation` (quaternion curves, or
 *   euler curves converted as `Quaternion.Euler` does, which has no oracle:
 *   AssetStudio converts with the native FBX SDK), `scale` and blend shape
 *   `weights` channels on the nodes the curves' paths name, relative to the
 *   root. Each channel is a `CUBICSPLINE` sampler from Unity's Hermite keys:
 *   samples at the union of the components' key times, tangents Unity's
 *   slopes (glTF scales them by the key interval as Unity does); a stepped
 *   key (infinite slope) holds its value and jumps one float32 step before
 *   the next key, or makes the whole channel `STEP` when every key is
 *   stepped; weighted tangents fall back to plain Hermite (the curves carry
 *   no weights). Skipped, as glTF has no channel for them: humanoid muscle
 *   curves (until #318), `m_IsActive` and every other float or object
 *   reference curve, curves whose path names no node, and a clip left
 *   without channels.
 *
 * Isomorphic and sync.
 *
 * @param env the loaded files, holding the scene, its meshes and the clips
 * @param root the scene's root: a GameObject (class 1), or an Animator (95)
 *   for its GameObject
 * @param options the clips to animate it with
 * @returns the `.glb` file's bytes
 * @throws {TypeError} when `root` is neither, or a clip is not an AnimationClip
 * @throws {UnsupportedError} when the root's Animator has an optimized
 *   hierarchy (`m_HasTransformHierarchy` false), a skin's bones are not one
 *   per bind pose or not nodes of the hierarchy, a skinned renderer has bind
 *   poses but no `m_Bones`, a skinned mesh lacks bone weights, or a mesh
 *   has no positions or triangles or a layout glTF cannot take
 * @throws {CorruptError} when a mesh's indices, bone indices or blend shapes
 *   point past its data
 * @throws {Error} what {@link clipCurves} throws, and when a GameObject of
 *   the hierarchy has no Transform
 * @example
 * const animator = env.objects.find((o) => o.type === 95)!;
 * const clips = env.objects.filter((o) => o.type === 74);
 * const glb = sceneToGltf(env, animator, { clips });
 */
export function sceneToGltf(
  env: Env,
  root: ObjectReader,
  options: SceneToGltfOptions = {},
): Uint8Array {
  const clips = (options.clips ?? []).map((clip) => {
    const curves = clipCurves(env, clip);
    return { name: clip.read<AnimationClip>().m_Name, curves };
  });
  return writeScene(env, root, clips);
}
