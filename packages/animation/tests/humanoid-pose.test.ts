// Humanoid clips in sceneToGltf (#319) against the Unity editor's own poses
// (#318): fixtures/humanoid-unity-goldens.json holds, per editor, the muscles
// and body rotation of the fixture's `pose` and `muscle` clips at their keys
// and midpoints, and each bone's local transform HumanPoseHandler made of
// them. The golden comes from the Unity editor (scripts/make-humanoid-goldens.py,
// R12), compared within the owner's tolerance on #319: a bone's rotation
// within 1e-3 rad (q and -q being the same rotation), a position within
// 1e-4 x the avatar's human scale. The Hips position is not converted (#319's
// fallback): it is not compared.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as gltfValidator from "gltf-validator";
import type { AnimationClip, Animator, Avatar, Env, ObjectReader } from "unity-asset-reader";
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

const golden = JSON.parse(
  readFileSync(new URL("../../../fixtures/humanoid-unity-goldens.json", import.meta.url), "utf8"),
) as { muscleNames: string[]; editors: Record<string, { clips: Record<string, Clip> }> };

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

/** The Animator whose Avatar is humanoid, and that Avatar. */
function humanoid(env: Env): { animator: ObjectReader; avatar: Avatar } {
  for (const o of env.objects) {
    if (o.type !== 95) continue;
    const ptr = env.resolve(o.read<Animator>().m_Avatar, o);
    if (ptr.status !== "found") continue;
    const avatar = ptr.object.read<Avatar>();
    if ((avatar.m_Avatar.m_Human.data.m_HumanBoneIndex[0] ?? -1) >= 0) return { animator: o, avatar };
  }
  throw new Error("no Animator with a humanoid Avatar");
}

const clipOf = (env: Env, name: string) => {
  const asset = [...env.assets("AnimationClip")].find((a) => a.name === name);
  assert.ok(asset, `no clip ${name}`);
  return asset.reader;
};

const cases = Object.entries(golden.editors).flatMap(([editor, { clips }]) =>
  Object.entries(clips).map(([name, clip]) => ({ editor, name, clip })),
);

test("the golden covers the pose and muscle clips in all four editors", () => {
  assert.deepEqual(Object.keys(golden.editors).sort(), ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"]);
  assert.equal(cases.length, 8);
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
      golden.muscleNames.forEach((muscle, i) => {
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
    const { animator, avatar } = humanoid(env);
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
    const glb = sceneToGltf(env, humanoid(env).animator, { clips: [clipOf(env, name)] });
    const report = await gltfValidator.validateBytes(glb);
    const errors = report.issues.messages.filter((m) => m.severity === 0);
    assert.deepEqual(errors, [], `${editor} ${name}`);
  }
});

test("a human bone's Transform curves give way to its humanoid rotation", async () => {
  const { clip } = cases.find((c) => c.name === "pose")!;
  const env = fixtureEnv(clip.bundle);
  const { animator } = humanoid(env);
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
