// sceneToGltf (#306): what it refuses and what it leaves out, on the 2019.4 scene
// bundle with some reads patched (a fresh env per test, so the patches stay local).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  load,
  UnsupportedError,
  type Animator,
  type Env,
  type GameObject,
  type MeshData,
  type ObjectReader,
  type SkinnedMeshRenderer,
} from "unity-asset-reader";
import { loadFixture } from "../../../fixtures/helpers.js";
import { sceneToGltf } from "../src/index.js";

const FIXTURE = "editor/2019.4.41f2/scene/lz4/scene";

/** Make `obj.read()` return its data with `change` applied. */
function patch<T>(obj: ObjectReader, change: (data: T) => Partial<T>): void {
  const data = obj.read<T>();
  const patched = { ...data, ...change(data) };
  Object.defineProperty(obj, "read", { value: () => patched });
}

const gameObject = (env: Env, name: string): ObjectReader => {
  const go = env.objects.find((o) => o.type === 1 && o.read<GameObject>().m_Name === name);
  if (!go) throw new Error(`no GameObject ${name}`);
  return go;
};

/** The Animator on the GameObject `scene`. */
function animatorOf(env: Env): ObjectReader {
  const scene = gameObject(env, "scene");
  const animator = env.objects.find((o) => {
    if (o.type !== 95) return false;
    const go = env.resolve(o.read<Animator>().m_GameObject, o);
    return go.status === "found" && go.object === scene;
  });
  if (!animator) throw new Error("no Animator on the GameObject scene");
  return animator;
}

/** The SkinnedMeshRenderer with bones and its mesh. */
function skinned(env: Env): { smr: ObjectReader; mesh: ObjectReader } {
  for (const smr of env.objects.filter((o) => o.type === 137)) {
    const data = smr.read<SkinnedMeshRenderer>();
    const found = env.resolve(data.m_Mesh, smr);
    if (data.m_Bones.length > 0 && found.status === "found") return { smr, mesh: found.object };
  }
  throw new Error("no skinned SkinnedMeshRenderer");
}

/** The glTF JSON chunk of a .glb. */
function json(glb: Uint8Array): { nodes: { name: string; mesh?: number; skin?: number }[]; skins?: unknown[] } {
  const length = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}

test("a root that is neither a GameObject nor an Animator is a TypeError", () => {
  const env = load(loadFixture(FIXTURE));
  const clip = env.objects.find((o) => o.type === 74)!;
  assert.throws(() => sceneToGltf(env, clip), TypeError);
});

test("an optimized hierarchy (m_HasTransformHierarchy false) is unsupported, from the Animator or its GameObject", () => {
  const env = load(loadFixture(FIXTURE));
  const animator = animatorOf(env);
  patch<Animator>(animator, () => ({ m_HasTransformHierarchy: false }));
  assert.throws(() => sceneToGltf(env, animator), UnsupportedError);
  assert.throws(() => sceneToGltf(env, gameObject(env, "scene")), UnsupportedError);
});

test("a skinned renderer with bind poses but no m_Bones (bones by name hash) is unsupported", () => {
  const env = load(loadFixture(FIXTURE));
  patch<SkinnedMeshRenderer>(skinned(env).smr, () => ({ m_Bones: [] }));
  assert.throws(() => sceneToGltf(env, animatorOf(env)), (e) => {
    assert.ok(e instanceof UnsupportedError);
    assert.match(e.message, /m_BoneNameHashes/);
    return true;
  });
});

test("a renderer without bones whose mesh has no bind poses writes the mesh unskinned", () => {
  const env = load(loadFixture(FIXTURE));
  const { smr, mesh } = skinned(env);
  patch<SkinnedMeshRenderer>(smr, () => ({ m_Bones: [] }));
  patch<MeshData>(mesh, () => ({ m_BindPose: [] }));
  const gltf = json(sceneToGltf(env, animatorOf(env)));
  const meshNodes = gltf.nodes.filter((n) => n.mesh !== undefined);
  assert.equal(meshNodes.length, 2);
  assert.ok(meshNodes.every((n) => n.skin === undefined));
  assert.equal(gltf.skins, undefined);
});

test("bones not one per bind pose are unsupported", () => {
  const env = load(loadFixture(FIXTURE));
  patch<SkinnedMeshRenderer>(skinned(env).smr, (d) => ({ m_Bones: d.m_Bones.slice(1) }));
  assert.throws(() => sceneToGltf(env, animatorOf(env)), (e) => {
    assert.ok(e instanceof UnsupportedError);
    assert.match(e.message, /bind poses/);
    return true;
  });
});

test("the root's ancestors are frames only: their renderers are not converted", () => {
  const env = load(loadFixture(FIXTURE));
  // Give the ancestor `scene` the Prop's MeshRenderer and MeshFilter, then export from Armature.
  const prop = gameObject(env, "Prop").read<GameObject>().m_Component;
  patch<GameObject>(gameObject(env, "scene"), (d) => ({
    m_Component: [...d.m_Component, ...prop.filter(({ component }) => {
      const found = env.resolve(component, gameObject(env, "Prop"));
      return found.status === "found" && found.object.type !== 4;
    })],
  }));
  const gltf = json(sceneToGltf(env, gameObject(env, "Armature")));
  assert.equal(gltf.nodes[0]!.name, "scene");
  assert.equal(gltf.nodes[0]!.mesh, undefined);
});
