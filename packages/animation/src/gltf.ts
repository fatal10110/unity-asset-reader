// Ported from AssetStudio/AssetStudio.Utility/ModelConverter.cs (MIT, © Perfare / RazTools / Razviar)
// A GameObject's hierarchy, meshes, skins and clips as binary glTF 2.0, written
// with core's GltfWriter. AssetStudio exports this as FBX; the conversion to a
// right-handed space is ModelConverter's (SetFrame, the bind poses, the morph
// vertices, the keyframe tracks), the glTF and its cubic splines are not
// upstream's. The mesh conversion is meshToGltf's (unity-asset-reader-mesh),
// which this package cannot import (R14). A humanoid clip's bone rotations
// are not upstream's either: humanoid.ts derives them.

import {
  CorruptError,
  GltfWriter,
  UnsupportedError,
  type Animator,
  type Avatar,
  type Env,
  type GameObject,
  type GltfAnimationChannel,
  type GltfAnimationSampler,
  type GltfNode,
  type MeshData,
  type MeshFilter,
  type ObjectReader,
  type SkinnedMeshRenderer,
  type Transform,
} from "unity-asset-reader";
import type { CurveKey, Curves } from "./converter.js";
import {
  eulerSamples,
  normalizeRotation,
  packSampler,
  sampleCurves,
  type Sampled,
  type ScalarKey,
} from "./cubic.js";
import { qconj, qmul, sampleHumanoid, type Quat } from "./humanoid.js";
import { children, CLASS, Scene } from "./tos.js";

const MESH_FILTER = 33;
const SKINNED = CLASS.SkinnedMeshRenderer;

/** A clip to write as one glTF animation: its name, its curves and its `m_SampleRate`. */
export interface SceneClip {
  name: string;
  curves: Curves;
  sampleRate: number;
}

/**
 * Where an Avatar's human skeleton is in the glTF: per `m_Human.m_Skeleton`
 * node its glTF node (-1 when no node has its path), and the rotation of the
 * nodes between it and its human parent's node (mirrored, `undefined` when
 * there are none).
 */
interface HumanTarget {
  avatar: Avatar;
  nodes: number[];
  between: (Quat | undefined)[];
}

/** A converted mesh: its glTF index and the full weight of each morph target. */
interface WrittenMesh {
  index: number;
  fullWeights: number[];
  channels: string[];
}

/**
 * How far a normal may be from unit length: the Khronos glTF validator's
 * tolerance, as meshToGltf uses it.
 */
const UNIT_TOLERANCE = 0.00674;

/** The xyz of a Unity vector, mirrored as ModelConverter mirrors it: x negated. */
const mirror = (x: number, y: number, z: number): [number, number, number] => [-x, y, z];

/**
 * Write the scene: see `sceneToGltf` in the package entry, which reads the
 * clips' curves and calls this.
 */
export function writeScene(env: Env, root: ObjectReader, clips: SceneClip[]): Uint8Array {
  const scene = new Scene(env);
  let rootGo = root;
  if (root.type === CLASS.Animator) {
    const go = scene.tryGet(scene.read<Animator>(root).m_GameObject, root, CLASS.GameObject);
    if (!go) throw new Error(`Animator ${root.pathId}: its GameObject is not loaded`);
    rootGo = go;
  } else if (root.type !== CLASS.GameObject) {
    throw new TypeError(
      `object ${root.pathId} is of class ${root.type}, not a GameObject (1) or an Animator (95)`,
    );
  }
  const rootTransform = scene.component(rootGo, CLASS.Transform);
  if (!rootTransform) throw new Error(`GameObject ${rootGo.pathId} has no Transform`);
  // An optimized hierarchy: upstream rebuilds it from the Avatar
  // (DeoptimizeTransformHierarchy, ModelConverter.cs:118), which is not ported.
  const animator = root.type === CLASS.Animator ? root : scene.component(rootGo, CLASS.Animator);
  if (animator && !scene.read<Animator>(animator).m_HasTransformHierarchy) {
    throw new UnsupportedError(
      "Animator hierarchy",
      "optimized (m_HasTransformHierarchy false)",
      `Animator ${animator.pathId}: its GameObjects were stripped; deoptimizing from the Avatar is not supported`,
    );
  }

  const gltf = new GltfWriter("unity-asset-reader-animation");
  const nodes: GltfNode[] = [];
  const objects: ObjectReader[] = [];
  const byPath = new Map<string, number>();
  const byTransform = new Map<ObjectReader, number>();
  const addNode = (go: ObjectReader, transform: ObjectReader): number => {
    const t = scene.read<Transform>(transform);
    const { x, y, z, w } = t.m_LocalRotation;
    const node: GltfNode = {
      name: scene.read<GameObject>(go).m_Name,
      // SetFrame (ModelConverter.cs:244): position x and rotation y, z negated.
      translation: mirror(t.m_LocalPosition.x, t.m_LocalPosition.y, t.m_LocalPosition.z),
      rotation: [x, -y, -z, w],
      scale: [t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z],
    };
    nodes.push(node);
    objects.push(go);
    byTransform.set(transform, nodes.length - 1);
    return gltf.addNode(node);
  };

  // The root's ancestors first, each the parent of the next, as InitWithGameObject
  // (ModelConverter.cs:115) chains them; only the root's own hierarchy is named
  // for the clips' paths.
  const ancestors: { go: ObjectReader; transform: ObjectReader }[] = [];
  for (let at = rootTransform; ; ) {
    const father = scene.tryGet(scene.read<Transform>(at).m_Father, at, CLASS.Transform);
    if (!father) break;
    const go = scene.tryGet(scene.read<Transform>(father).m_GameObject, father, CLASS.GameObject);
    if (!go) break;
    ancestors.unshift({ go, transform: father });
    at = father;
  }
  let parent: GltfNode | undefined;
  for (const { go, transform } of ancestors) {
    const index = addNode(go, transform);
    if (parent) parent.children = [index];
    parent = nodes[index];
  }
  const walk = (go: ObjectReader, transform: ObjectReader, path: string): number => {
    const index = addNode(go, transform);
    if (!byPath.has(path)) byPath.set(path, index);
    const kids = children(scene, go).map((c) => {
      const name = scene.read<GameObject>(c.go).m_Name;
      return walk(c.go, c.transform, path !== "" ? `${path}/${name}` : name);
    });
    if (kids.length > 0) nodes[index]!.children = kids;
    return index;
  };
  const rootIndex = walk(rootGo, rootTransform, "");
  if (parent) parent.children = [rootIndex];
  const human = animator && humanTarget(scene, animator, nodes, byPath, rootIndex);

  // Each node's renderer: a SkinnedMeshRenderer, or a MeshRenderer with its MeshFilter.
  const meshes = new Map<number, WrittenMesh>();
  // Only the root's own hierarchy, as ConvertTransforms (ModelConverter.cs:150) converts
  // renderers; the ancestors chained above it are frames only.
  objects.forEach((go, index) => {
    if (index < ancestors.length) return;
    const skinned = scene.component(go, SKINNED);
    const filter = skinned ? undefined : scene.component(go, MESH_FILTER);
    const holder = skinned ?? (scene.component(go, CLASS.MeshRenderer) && filter);
    if (!holder) return;
    const smr = skinned && scene.read<SkinnedMeshRenderer>(skinned);
    const ptr = smr ? smr.m_Mesh : scene.read<MeshFilter>(holder).m_Mesh;
    const meshObj = scene.tryGet(ptr, holder, CLASS.Mesh);
    if (!meshObj) return;
    const mesh = scene.read<MeshData>(meshObj);
    const node = nodes[index]!;
    let joints: number[] | undefined;
    if (smr && smr.m_Bones.length === 0 && mesh.m_BindPose.length > 0) {
      // Bone type 2 of ConvertMeshRenderer: the bones by m_BoneNameHashes, an optimized rig.
      throw new UnsupportedError(
        "SkinnedMeshRenderer bones",
        `no bones, ${mesh.m_BindPose.length} bind poses`,
        `Mesh "${mesh.m_Name}": bones found by m_BoneNameHashes (an optimized hierarchy) are not supported`,
      );
    }
    if (smr && smr.m_Bones.length > 0) {
      // Bone type 1 of ConvertMeshRenderer (ModelConverter.cs:437): m_Bones, one per bind pose.
      if (smr.m_Bones.length !== mesh.m_BindPose.length) {
        throw new UnsupportedError(
          "SkinnedMeshRenderer bones",
          `${smr.m_Bones.length} bones, ${mesh.m_BindPose.length} bind poses`,
          `Mesh "${mesh.m_Name}": a glTF skin needs one bind pose per bone`,
        );
      }
      joints = smr.m_Bones.map((bone, i) => {
        const transform = scene.tryGet(bone, skinned!, CLASS.Transform);
        const joint = transform && byTransform.get(transform);
        if (joint === undefined) {
          throw new UnsupportedError(
            "SkinnedMeshRenderer bone",
            `bone ${i} (path id ${bone.m_PathID})`,
            "a glTF joint must be a node of the exported hierarchy",
          );
        }
        return joint;
      });
    }
    const written = writeMesh(gltf, mesh, joints?.length ?? 0);
    meshes.set(index, written);
    node.mesh = written.index;
    if (joints) {
      // convert * bindpose * convert, convert = Scale(-1, 1, 1) (ModelConverter.cs:483):
      // the elements of row 0 or column 0, not both, negated. glTF is column-major;
      // Unity's eRC are written row by row.
      const matrices = new Float32Array(joints.length * 16);
      mesh.m_BindPose.forEach((m, i) => {
        for (let c = 0; c < 4; c++) {
          for (let r = 0; r < 4; r++) {
            const value = m[`e${r}${c}` as keyof typeof m];
            matrices[i * 16 + c * 4 + r] = (r === 0) !== (c === 0) ? 0 - value : value;
          }
        }
      });
      node.skin = gltf.addSkin({
        joints,
        inverseBindMatrices: gltf.addAccessor({ data: matrices, type: "MAT4" }),
      });
    }
    if (smr && written.fullWeights.length > 0) {
      node.weights = written.fullWeights.map((full, i) => (smr.m_BlendShapeWeights[i] ?? 0) / full);
    }
  });

  // The clips, named as ConvertAnimations names them: a repeated name gets _1, _2, ...
  const names = new Set<string>();
  for (const { name, curves, sampleRate } of clips) {
    let unique = name;
    for (let i = 1; names.has(unique); i++) unique = `${name}_${i}`;
    names.add(unique);
    const channels: GltfAnimationChannel[] = [];
    const samplers: GltfAnimationSampler[] = [];
    const add = (node: number, path: GltfAnimationChannel["target"]["path"], sampled: Sampled) => {
      const { input, output } = packSampler(sampled);
      samplers.push({
        input: gltf.addAccessor({ data: input, type: "SCALAR", bounds: true }),
        interpolation: sampled.interpolation,
        output: gltf.addAccessor({
          data: output,
          type: path === "weights" ? "SCALAR" : path === "rotation" ? "VEC4" : "VEC3",
        }),
      });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    };
    // A humanoid clip's human bones: their rotations from the muscles replace
    // any Transform curve of theirs, so that no node and path get two channels.
    const humanoid = human ? humanoidChannels(human, curves, sampleRate) : [];
    const posed = new Set(humanoid.map((h) => h.node));
    for (const { node, sampled } of humanoid) add(node, "rotation", sampled);
    const rotated = new Set<string>();
    for (const c of curves.position) {
      const node = byPath.get(c.path);
      if (node === undefined || c.keyframes.length === 0 || posed.has(node)) continue;
      add(node, "translation", sampleCurves(split(c.keyframes, (v) => mirror(v.x, v.y, v.z))));
    }
    for (const c of curves.rotation) {
      const node = byPath.get(c.path);
      if (node === undefined || c.keyframes.length === 0 || posed.has(node)) continue;
      rotated.add(c.path);
      const sampled = sampleCurves(split(c.keyframes, (q) => [q.x, -q.y, -q.z, q.w]));
      add(node, "rotation", normalizeRotation(sampled));
    }
    for (const c of curves.euler) {
      const node = byPath.get(c.path);
      // A path with a quaternion curve keeps it; Unity animates one of the two.
      if (node === undefined || c.keyframes.length === 0 || rotated.has(c.path)) continue;
      if (posed.has(node)) continue;
      const sampled = eulerSamples(sampleCurves(split(c.keyframes, (v) => [v.x, v.y, v.z])));
      for (const s of sampled.samples) {
        for (const part of [s.value, s.inTangent, s.outTangent]) {
          part[1] = -part[1]!;
          part[2] = -part[2]!;
        }
      }
      add(node, "rotation", sampled);
    }
    for (const c of curves.scale) {
      const node = byPath.get(c.path);
      if (node === undefined || c.keyframes.length === 0 || posed.has(node)) continue;
      add(node, "scale", sampleCurves(split(c.keyframes, (v) => [v.x, v.y, v.z])));
    }
    // Blend shape weights: one channel per node, every morph target of its mesh,
    // the ones no curve animates held at the renderer's weight.
    const weights = new Map<number, Map<number, CurveKey<number>[]>>();
    for (const c of curves.float) {
      const node = byPath.get(c.path);
      const mesh = node === undefined ? undefined : meshes.get(node);
      if (!mesh || c.classId !== SKINNED || !c.attribute.startsWith("blendShape.")) continue;
      const channel = c.attribute.slice("blendShape.".length);
      const target = mesh.channels.findIndex(
        (name) => name === channel || name.split(".").pop() === channel,
      );
      if (target < 0 || c.keyframes.length === 0) continue;
      if (!weights.has(node!)) weights.set(node!, new Map());
      weights.get(node!)!.set(target, c.keyframes);
    }
    for (const [node, animated] of weights) {
      const { fullWeights } = meshes.get(node)!;
      const held = nodes[node]!.weights ?? [];
      const components = fullWeights.map((full, i): ScalarKey[] => {
        const keys = animated.get(i);
        if (!keys) return [{ time: 0, value: held[i] ?? 0, inSlope: 0, outSlope: 0 }];
        return keys.map((k) => ({
          time: k.time,
          value: k.value / full,
          inSlope: k.inSlope / full,
          outSlope: k.outSlope / full,
        }));
      });
      add(node, "weights", sampleCurves(components));
    }
    if (channels.length > 0) gltf.addAnimation({ name: unique, channels, samplers });
  }

  gltf.addScene([ancestors.length > 0 ? 0 : rootIndex]);
  return gltf.toGlb();
}

/**
 * The Animator's human skeleton in the glTF, from its Avatar: each human
 * skeleton node by its path (`m_ID` in `m_TOS`), the skeleton's root the
 * Animator's own node. `undefined` without an Avatar with a Hips (a generic
 * one).
 */
function humanTarget(
  scene: Scene,
  animator: ObjectReader,
  nodes: GltfNode[],
  byPath: Map<string, number>,
  rootIndex: number,
): HumanTarget | undefined {
  const ptr = scene.tryGet(scene.read<Animator>(animator).m_Avatar, animator, CLASS.Avatar);
  if (!ptr) return undefined;
  const avatar = scene.read<Avatar>(ptr);
  const human = avatar.m_Avatar.m_Human.data;
  if ((human.m_HumanBoneIndex[0] ?? -1) < 0) return undefined;
  const tos = new Map(avatar.m_TOS);
  const skeleton = human.m_Skeleton.data;
  const target = skeleton.m_Node.map((node, i) => {
    if (node.m_ParentId < 0) return rootIndex;
    const path = tos.get(skeleton.m_ID[i]!);
    return (path === undefined ? undefined : byPath.get(path)) ?? -1;
  });
  const parents = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parents.set(c, i)));
  // A human bone's rotation is in its human parent's space; nodes the Avatar
  // left out of the human skeleton between the two keep their own rotation.
  const between = skeleton.m_Node.map((node, i): Quat | undefined => {
    const parent = target[node.m_ParentId] ?? -1;
    if (target[i]! < 0 || parent < 0) return undefined;
    let q: Quat | undefined;
    for (let at = parents.get(target[i]!); at !== undefined && at !== parent; at = parents.get(at)) {
      const r = nodes[at]!.rotation as Quat;
      q = q ? qmul(r, q) : r;
    }
    return q;
  });
  return { avatar, nodes: target, between };
}

/**
 * A humanoid clip's rotation channels, one per human bone with a node:
 * `LINEAR` samples of {@link sampleHumanoid}, mirrored as every rotation is.
 */
function humanoidChannels(
  human: HumanTarget,
  curves: Curves,
  sampleRate: number,
): { node: number; sampled: Sampled }[] {
  const sampled = sampleHumanoid(human.avatar, curves.float, sampleRate);
  if (!sampled) return [];
  return sampled.bones.flatMap(({ node, rotations }) => {
    const target = human.nodes[node] ?? -1;
    if (target < 0) return [];
    const between = human.between[node];
    const samples = rotations.map((r, i) => {
      const mirrored: Quat = [r[0], -r[1], -r[2], r[3]];
      const value = between ? qmul(qconj(between), mirrored) : mirrored;
      return { time: sampled.times[i]!, value, inTangent: [], outTangent: [], keyed: true };
    });
    return [{ node: target, sampled: { interpolation: "LINEAR" as const, samples } }];
  });
}

/** A vector curve's keys split into one curve per component, each converted by `parts`. */
function split<T>(keys: CurveKey<T>[], parts: (v: T) => number[]): ScalarKey[][] {
  const converted = keys.map((k) => ({
    time: k.time,
    value: parts(k.value),
    inSlope: parts(k.inSlope),
    outSlope: parts(k.outSlope),
  }));
  return converted[0]!.value.map((_, d) =>
    converted.map((k) => ({
      time: k.time,
      value: k.value[d]!,
      inSlope: k.inSlope[d]!,
      outSlope: k.outSlope[d]!,
    })),
  );
}

/**
 * One mesh as a glTF mesh, converted as meshToGltf converts it: x of positions
 * and normals negated, the winding reversed, UV v as `1 - v`; `JOINTS_0` and
 * `WEIGHTS_0` when it is skinned to `bones` joints; a morph target per blend
 * shape channel, its last (full weight) frame.
 */
function writeMesh(gltf: GltfWriter, mesh: MeshData, bones: number): WrittenMesh {
  const name = mesh.m_Name;
  const count = mesh.vertexCount;
  const stride = (values: Float32Array | undefined, allowed: number[], what: string) => {
    if (!values || values.length === 0) return 0;
    const n = values.length / count;
    if (!allowed.includes(n)) {
      throw new UnsupportedError(
        `${what} layout`,
        `${values.length} floats for ${count} vertices`,
        `Mesh "${name}": glTF takes ${allowed.join(" or ")} per vertex`,
      );
    }
    return n;
  };
  if (count <= 0 || !mesh.vertices || mesh.vertices.length === 0) {
    throw new UnsupportedError(
      "mesh for glTF",
      count <= 0 ? `${count} vertices` : "no positions",
      `Mesh "${name}": glTF needs the vertices' positions`,
    );
  }
  const vector3 = (values: Float32Array, n: number) => {
    const out = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      out.set(mirror(values[v * n]!, values[v * n + 1]!, values[v * n + 2]!), v * 3);
    }
    return out;
  };
  const attributes: Record<string, number> = {};
  const positions = vector3(mesh.vertices, stride(mesh.vertices, [3, 4], "position"));
  attributes.POSITION = gltf.addAccessor({
    data: positions,
    type: "VEC3",
    target: "ARRAY_BUFFER",
    bounds: true,
  });
  // Normals glTF forbids (not unit length) leave NORMAL out, as meshToGltf does.
  const normalStride = stride(mesh.normals, [3, 4], "normal");
  if (normalStride > 0) {
    const normals = vector3(mesh.normals!, normalStride);
    let unit = true;
    for (let at = 0; at < normals.length && unit; at += 3) {
      const length = Math.hypot(normals[at]!, normals[at + 1]!, normals[at + 2]!);
      unit = Math.abs(length - 1) <= UNIT_TOLERANCE;
    }
    if (unit) {
      attributes.NORMAL = gltf.addAccessor({ data: normals, type: "VEC3", target: "ARRAY_BUFFER" });
    }
  }
  const uvStride = stride(mesh.uv[0], [2, 3, 4], "UV0");
  if (uvStride > 0) {
    const uv = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      uv[v * 2] = mesh.uv[0]![v * uvStride]!;
      uv[v * 2 + 1] = 1 - mesh.uv[0]![v * uvStride + 1]!;
    }
    attributes.TEXCOORD_0 = gltf.addAccessor({ data: uv, type: "VEC2", target: "ARRAY_BUFFER" });
  }
  if (bones > 0) {
    if (!mesh.skin || mesh.skin.length !== count) {
      throw new UnsupportedError(
        "skinned mesh",
        `${mesh.skin?.length ?? 0} bone weights for ${count} vertices`,
        `Mesh "${name}": a glTF skin needs the weights of every vertex`,
      );
    }
    const joints = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    mesh.skin.forEach((influence, v) => {
      for (let k = 0; k < 4; k++) {
        const bone = influence.boneIndex[k]!;
        if (bone >= bones) {
          throw new CorruptError(
            `Mesh "${name}" vertex ${v}: bone index ${bone} is past the ${bones} bones`,
          );
        }
        joints[v * 4 + k] = bone;
        weights[v * 4 + k] = influence.weight[k]!;
      }
    });
    attributes.JOINTS_0 = gltf.addAccessor({ data: joints, type: "VEC4", target: "ARRAY_BUFFER" });
    attributes.WEIGHTS_0 = gltf.addAccessor({ data: weights, type: "VEC4", target: "ARRAY_BUFFER" });
  }

  // Morph targets (ConvertMeshRenderer's morphs, ModelConverter.cs:510): each
  // channel's last frame, the delta of x negated; glTF has no in-between frames.
  const targets: Record<string, number>[] = [];
  const fullWeights: number[] = [];
  const channels: string[] = [];
  const shapes = mesh.m_Shapes;
  for (const channel of shapes?.channels ?? []) {
    const frame = channel.frameIndex + channel.frameCount - 1;
    const shape = shapes!.shapes[frame];
    const full = shapes!.fullWeights[frame];
    if (channel.frameCount < 1 || !shape || full === undefined || !(full > 0)) {
      throw new CorruptError(
        `Mesh "${name}" blend shape "${channel.name}": no frame of a positive weight at ${frame}`,
      );
    }
    const position = new Float32Array(count * 3);
    const normal = attributes.NORMAL !== undefined && shape.hasNormals
      ? new Float32Array(count * 3)
      : undefined;
    for (let j = shape.firstVertex; j < shape.firstVertex + shape.vertexCount; j++) {
      const vertex = shapes!.vertices[j];
      if (!vertex || vertex.index >= count) {
        throw new CorruptError(`Mesh "${name}" blend shape "${channel.name}": vertex ${j} is past the data`);
      }
      position.set(mirror(vertex.vertex.x, vertex.vertex.y, vertex.vertex.z), vertex.index * 3);
      normal?.set(mirror(vertex.normal.x, vertex.normal.y, vertex.normal.z), vertex.index * 3);
    }
    const target: Record<string, number> = {
      POSITION: gltf.addAccessor({ data: position, type: "VEC3", target: "ARRAY_BUFFER", bounds: true }),
    };
    if (normal) target.NORMAL = gltf.addAccessor({ data: normal, type: "VEC3", target: "ARRAY_BUFFER" });
    targets.push(target);
    fullWeights.push(full);
    channels.push(channel.name);
  }

  const wide = count > 0xffff;
  const primitives = mesh.indices.flatMap((triangles, i) => {
    // glTF has no empty accessor, so a submesh without triangles is left out.
    if (triangles.length === 0) return [];
    if (triangles.length % 3 !== 0) {
      throw new CorruptError(
        `Mesh "${name}" submesh ${i}: ${triangles.length} indices are not whole triangles`,
      );
    }
    const indices = wide ? new Uint32Array(triangles.length) : new Uint16Array(triangles.length);
    for (let k = 0; k < triangles.length; k++) {
      // The winding reversed: each triangle (a, b, c) is written (c, b, a).
      const at = k - (k % 3) + 2 - (k % 3);
      const index = triangles[at]!;
      if (index >= count) {
        throw new CorruptError(
          `Mesh "${name}" submesh ${i}: index ${at} is ${index}, past the ${count} vertices`,
        );
      }
      indices[k] = index;
    }
    return [{
      attributes,
      indices: gltf.addAccessor({ data: indices, type: "SCALAR", target: "ELEMENT_ARRAY_BUFFER" }),
      ...(targets.length > 0 && { targets }),
    }];
  });
  if (primitives.length === 0) {
    throw new UnsupportedError("mesh for glTF", "no triangles", `Mesh "${name}": a glTF mesh needs a primitive`);
  }
  return { index: gltf.addMesh({ name, primitives }), fullWeights, channels };
}
