// Humanoid clips in sceneToGltf (#319) against the Unity editor's own poses
// (#318): fixtures/humanoid-unity-goldens.json holds, per editor, the muscles
// and body rotation of the fixture's `pose` and `muscle` clips at their keys
// and midpoints, and each bone's local transform HumanPoseHandler made of
// them; fixtures/humanoid2-unity-goldens.json the same for the second rigs'
// `pose2` and `upperchest` clips (#325). The goldens come from the Unity editor
// (scripts/make-humanoid-goldens.py, R12), compared within the owner's
// tolerance on #319: a bone's rotation within 1e-3 rad (q and -q being the
// same rotation), a position within 1e-4 x the avatar's human scale. The Hips
// position is not converted (#319's fallback): it is not compared.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as gltfValidator from "gltf-validator";
import type {
  AnimationClip,
  Animator,
  Avatar,
  Env,
  GameObject,
  ObjectReader,
} from "unity-asset-reader";
import { clipCurves, sceneToGltf } from "../src/index.js";
import { evaluate } from "../src/cubic.js";
import { writeScene } from "../src/gltf.js";
import { fixtureEnv } from "./helpers.js";

interface Sample {
  time: number;
  key: boolean;
  muscles: number[];
  bodyPosition: number[];
  bodyRotation: number[];
  localPosition: number[][];
  localRotation: number[][];
}
interface Clip {
  bundle: string;
  bones: string[];
  samples: Sample[];
}

interface Golden {
  muscleNames: string[];
  editors: Record<string, { clips: Record<string, Clip> }>;
}
const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8")) as Golden;
/** The first rig's golden (#318) and the second rigs' (#325). */
const goldens = [read("humanoid-unity-goldens.json"), read("humanoid2-unity-goldens.json")];
const muscleNames = goldens[0]!.muscleNames;

const ROTATION = 1e-3;
const POSITION = 1e-4;

/** A clip binds `Left Thumb 1 Stretched` as `LeftHand.Thumb.1 Stretched` (BUILDING.md section 28). */
const binding = (muscle: string) =>
  muscle.replace(/^(Left|Right) (Thumb|Index|Middle|Ring|Little) /, "$1Hand.$2.");

/** The angle between two rotations, radians; q and -q are the same rotation. */
function angle(a: number[], b: number[]): number {
  const dot = a.reduce((s, c, i) => s + c * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b));
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

/** glTF's LINEAR rotation between two samples: spherical linear interpolation. */
function slerp(a: number[], b: number[], s: number): number[] {
  const dot = a.reduce((sum, c, i) => sum + c * b[i]!, 0);
  const theta = Math.acos(Math.min(1, Math.abs(dot)));
  if (theta < 1e-9) return a;
  const sign = dot < 0 ? -1 : 1;
  const wa = Math.sin((1 - s) * theta) / Math.sin(theta);
  const wb = (sign * Math.sin(s * theta)) / Math.sin(theta);
  return a.map((c, i) => wa * c + wb * b[i]!);
}

interface Gltf {
  json: {
    nodes: { name: string; translation: number[]; rotation: number[] }[];
    animations: {
      name: string;
      channels: { sampler: number; target: { node: number; path: string } }[];
      samplers: { input: number; output: number; interpolation: string }[];
    }[];
  };
  data: (accessor: number) => number[];
}

function parse(glb: Uint8Array): Gltf {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  const bin = 20 + length + 8;
  const data = (index: number) => {
    const a = json.accessors[index];
    const v = json.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type as string] ?? 16;
    const out: number[] = [];
    for (let i = 0; i < a.count * width; i++) out.push(view.getFloat32(bin + v.byteOffset + i * 4, true));
    return out;
  };
  return { json, data };
}

/**
 * The Animator on the GameObject `root` (a golden's first bone: the prefab the
 * oracle posed) and its Avatar, which must be humanoid.
 */
function humanoid(env: Env, root: string): { animator: ObjectReader; avatar: Avatar } {
  for (const o of env.objects) {
    if (o.type !== 95) continue;
    const animator = o.read<Animator>();
    const go = env.resolve(animator.m_GameObject, o);
    if (go.status !== "found" || go.object.read<GameObject>().m_Name !== root) continue;
    const ptr = env.resolve(animator.m_Avatar, o);
    assert.equal(ptr.status, "found", `${root}: no Avatar`);
    if (ptr.status !== "found") break;
    const avatar = ptr.object.read<Avatar>();
    assert.ok((avatar.m_Avatar.m_Human.data.m_HumanBoneIndex[0] ?? -1) >= 0, `${root}: not humanoid`);
    return { animator: o, avatar };
  }
  throw new Error(`no Animator on ${root}`);
}

const clipOf = (env: Env, name: string) => {
  const asset = [...env.assets("AnimationClip")].find((a) => a.name === name);
  assert.ok(asset, `no clip ${name}`);
  return asset.reader;
};

const cases = goldens.flatMap((golden) =>
  Object.entries(golden.editors).flatMap(([editor, { clips }]) =>
    Object.entries(clips).map(([name, clip]) => ({ editor, name, clip })),
  ),
);

test("the goldens cover the pose, muscle, pose2 and upperchest clips in all four editors", () => {
  for (const golden of goldens) {
    assert.deepEqual(Object.keys(golden.editors).sort(), ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"]);
    assert.deepEqual(golden.muscleNames, muscleNames);
  }
  const names = (golden: Golden) => Object.values(golden.editors).flatMap(({ clips }) => Object.keys(clips));
  assert.deepEqual(names(goldens[0]!), Array(4).fill(["pose", "muscle"]).flat());
  assert.deepEqual(names(goldens[1]!), Array(4).fill(["pose2", "upperchest"]).flat());
  assert.equal(cases.length, 16);
});

test("clipCurves evaluated at the golden times gives the golden muscles and RootT/RootQ", () => {
  for (const { editor, name, clip } of cases) {
    const env = fixtureEnv(clip.bundle);
    const curves = new Map(clipCurves(env, clipOf(env, name)).float.map((c) => [c.attribute, c]));
    const at = (attribute: string, t: number, absent: number) => {
      const c = curves.get(attribute);
      return c ? evaluate(c.keyframes, t) : absent;
    };
    for (const s of clip.samples) {
      const where = `${editor} ${name} t=${s.time}`;
      muscleNames.forEach((muscle, i) => {
        const value = at(binding(muscle), s.time, 0);
        assert.ok(Math.abs(value - s.muscles[i]!) <= 1e-6, `${where} ${muscle}: ${value} vs ${s.muscles[i]}`);
      });
      ["x", "y", "z"].forEach((c, i) => {
        const value = at(`RootT.${c}`, s.time, 0);
        assert.ok(Math.abs(value - s.bodyPosition[i]!) <= 1e-6, `${where} RootT.${c}`);
      });
      const q = ["x", "y", "z", "w"].map((c, i) => at(`RootQ.${c}`, s.time, i === 3 ? 1 : 0));
      assert.ok(angle(q, s.bodyRotation) <= 1e-6, `${where} RootQ`);
    }
  }
});

test("the .glb's bones match Unity's poses within the owner's tolerance, per editor", (t) => {
  for (const { editor, name, clip } of cases) {
    const env = fixtureEnv(clip.bundle);
    const { animator, avatar } = humanoid(env, clip.bones[0]!);
    const scale = avatar.m_Avatar.m_Human.data.m_Scale;
    const gltf = parse(sceneToGltf(env, animator, { clips: [clipOf(env, name)] }));
    const [animation] = gltf.json.animations;
    assert.ok(animation, `${editor} ${name}: no animation`);
    const channels = new Map(animation.channels.map((c) => [`${c.target.node} ${c.target.path}`, c.sampler]));
    let worstRotation = 0;
    let worstHips = 0;
    let worstPosition = 0;
    clip.bones.forEach((bone, b) => {
      const node = gltf.json.nodes.findIndex((n) => n.name === bone);
      assert.ok(node >= 0, `${editor} ${name}: no node ${bone}`);
      // Human bones get rotations only: their positions are the skeleton's.
      assert.ok(!channels.has(`${node} translation`), `${editor} ${name} ${bone}: a translation channel`);
      const sampler = channels.get(`${node} rotation`);
      const s = sampler === undefined ? undefined : animation.samplers[sampler]!;
      const input = s ? gltf.data(s.input) : [];
      const output = s ? gltf.data(s.output) : [];
      if (s) assert.equal(s.interpolation, "LINEAR");
      for (const sample of clip.samples) {
        let q = gltf.json.nodes[node]!.rotation;
        if (s) {
          const time = Math.fround(sample.time);
          let i = input.findIndex((x) => x >= time);
          if (i < 0) i = input.length - 1;
          const get = (k: number) => output.slice(k * 4, k * 4 + 4);
          q = input[i] === time || i === 0 ? get(i) : slerp(get(i - 1), get(i), (time - input[i - 1]!) / (input[i]! - input[i - 1]!));
        }
        // Unmirrored: the glTF rotation is Unity's with y and z negated.
        const error = angle([q[0]!, -q[1]!, -q[2]!, q[3]!], sample.localRotation[b]!);
        const where = `${editor} ${name} t=${sample.time} ${bone}`;
        assert.ok(error <= ROTATION, `${where}: rotation off by ${error} rad`);
        if (bone === "Hips") {
          worstHips = Math.max(worstHips, error);
          continue;
        }
        worstRotation = Math.max(worstRotation, error);
        const p = gltf.json.nodes[node]!.translation;
        const offset = Math.hypot(-p[0]! - sample.localPosition[b]![0]!, p[1]! - sample.localPosition[b]![1]!,
          p[2]! - sample.localPosition[b]![2]!);
        assert.ok(offset <= POSITION * scale, `${where}: position off by ${offset} m`);
        worstPosition = Math.max(worstPosition, offset / scale);
      }
    });
    t.diagnostic(`${editor} ${name}: rotation ${worstRotation.toExponential(2)} rad, ` +
      `Hips rotation ${worstHips.toExponential(2)} rad, position ${worstPosition.toExponential(2)} x humanScale`);
  }
});

test("a humanoid .glb passes the Khronos validator", async () => {
  for (const { editor, name, clip } of cases) {
    const env = fixtureEnv(clip.bundle);
    const glb = sceneToGltf(env, humanoid(env, clip.bones[0]!).animator, { clips: [clipOf(env, name)] });
    const report = await gltfValidator.validateBytes(glb);
    const errors = report.issues.messages.filter((m) => m.severity === 0);
    assert.deepEqual(errors, [], `${editor} ${name}`);
  }
});

test("a human bone's Transform curves give way to its humanoid rotation", async () => {
  const { clip } = cases.find((c) => c.name === "pose")!;
  const env = fixtureEnv(clip.bundle);
  const { animator } = humanoid(env, "humanoid");
  const reader = clipOf(env, "pose");
  const curves = clipCurves(env, reader);
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const k = <T>(time: number, value: T, slope: T) => ({ time, value, inSlope: slope, outSlope: slope });
  const zero = v(0, 0, 0);
  const still = { x: 0, y: 0, z: 0, w: 0 };
  curves.rotation.push({
    path: "Hips/Spine",
    keyframes: [k(0, { x: 0, y: 0, z: 0, w: 1 }, still), k(1, { x: 0, y: 0.6, z: 0, w: 0.8 }, still)],
  });
  curves.position.push({ path: "Hips/Spine", keyframes: [k(0, v(0, 0.1, 0), zero), k(1, v(0, 0.3, 0), zero)] });
  const sampleRate = reader.read<AnimationClip>().m_SampleRate;
  const glb = writeScene(env, animator, [{ name: "pose", curves, sampleRate }]);
  const gltf = parse(glb);
  const spine = gltf.json.nodes.findIndex((n) => n.name === "Spine");
  assert.ok(spine >= 0);
  const [animation] = gltf.json.animations;
  const onSpine = animation!.channels.filter((c) => c.target.node === spine);
  assert.deepEqual(onSpine.map((c) => c.target.path), ["rotation"]);
  assert.equal(animation!.samplers[onSpine[0]!.sampler]!.interpolation, "LINEAR");
  const report = await gltfValidator.validateBytes(glb);
  assert.deepEqual(report.issues.messages.filter((m) => m.severity === 0), []);
  // Without the muscles, the same curves do animate the Spine: the path resolves.
  const generic = { ...curves, float: [] };
  const plain = parse(writeScene(env, animator, [{ name: "pose", curves: generic, sampleRate }]));
  const paths = plain.json.animations[0]!.channels.filter((c) => c.target.node === spine).map((c) => c.target.path);
  assert.deepEqual(paths.sort(), ["rotation", "translation"]);
});

test("the second and third rigs hold what the first lacks (BUILDING.md section 31)", () => {
  const identity = (q: { x: number; y: number; z: number; w: number }) =>
    Math.abs(Math.abs(q.w) - 1) < 1e-6;
  for (const editor of Object.keys(goldens[1]!.editors)) {
    const bundle = `editor/${editor}/humanoid2/lz4/humanoid2`;
    const env = fixtureEnv(bundle);
    const first = humanoid(fixtureEnv(`editor/${editor}/humanoid/lz4/humanoid`), "humanoid").avatar
      .m_Avatar.m_Human.data;
    const limits = (h: typeof first, bone: number) => {
      const skeleton = h.m_Skeleton.data;
      return skeleton.m_AxesArray[skeleton.m_Node[h.m_HumanBoneIndex[bone]!]!.m_AxesId]!.m_Limit;
    };

    const avatar = humanoid(env, "humanoid2").avatar;
    const two = avatar.m_Avatar.m_Human.data;
    const index = two.m_HumanBoneIndex;
    const pose = two.m_SkeletonPose.data.m_X;
    // UpperChest, eyes, jaw and all 30 fingers.
    for (const bone of [9, 22, 23, 24]) assert.ok(index[bone]! >= 0, `${editor}: human bone ${bone}`);
    for (const hand of [two.m_LeftHand.data, two.m_RightHand.data]) {
      assert.equal(hand.m_HandBoneIndex.filter((n) => n >= 0).length, 15, editor);
    }
    // A rotated bind pose: no human bone at the identity.
    assert.ok(index.every((n) => n < 0 || !identity(pose[n]!.q)), `${editor}: an unrotated bone`);
    // A rotated node between the root and the Hips, and one between the Spine and the Chest.
    const tos = new Map(avatar.m_TOS);
    const ids = avatar.m_Avatar.m_AvatarSkeleton.data.m_ID;
    const armature = ids.findIndex((id) => tos.get(id) === "Armature");
    assert.ok(armature >= 0, `${editor}: no Armature`);
    assert.ok(!identity(avatar.m_Avatar.m_AvatarSkeletonPose.data.m_X[armature]!.q), editor);
    assert.ok([...tos.values()].includes("Armature/Hips/Spine/SpineMid/Chest"), editor);
    // Twist shares other than 0.5, each its own.
    assert.deepEqual(
      [two.m_ArmTwist, two.m_ForeArmTwist, two.m_UpperLegTwist, two.m_LegTwist],
      [0.3, 0.7, 0.2, 0.6].map(Math.fround),
      editor,
    );
    // Limits other than the first rig's defaults on every body bone both have.
    for (let bone = 1; bone < 22; bone++) {
      if (first.m_HumanBoneIndex[bone]! < 0) continue;
      assert.notDeepEqual(limits(two, bone), limits(first, bone), `${editor}: bone ${bone}`);
    }

    // The third rig: no UpperChest, and Chest limits whose halves are not the
    // +-20 degrees of Unity's default UpperChest range: each at least 0.01 rad
    // (ten times the tolerance) away, so the upperchest clip tells them apart.
    const three = humanoid(env, "humanoid3").avatar.m_Avatar.m_Human.data;
    assert.equal(three.m_HumanBoneIndex[9], -1, editor);
    const chest = limits(three, 8);
    const range = (20 * Math.PI) / 180;
    for (const v of [chest.m_Min, chest.m_Max]) {
      for (const c of [v.x, v.y, v.z]) assert.ok(Math.abs(Math.abs(c / 2) - range) > 0.01, `${editor}: ${c}`);
    }
  }
});
