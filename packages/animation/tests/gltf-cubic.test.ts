// The curve to glTF sampler conversion of sceneToGltf (#306) on synthetic
// curves: the cases no fixture holds (stepped keys, weighted keys, curves
// with different key times, euler angles).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as gltfValidator from "gltf-validator";
import type { Animator, GameObject } from "unity-asset-reader";
import type { Curves } from "../src/index.js";
import { writeScene } from "../src/gltf.js";
import { fixtureEnv } from "./helpers.js";
import {
  eulerToQuaternion,
  floatBefore,
  hermite,
  normalizeRotation,
  packSampler,
  sampleCurves,
  type Sampled,
  type ScalarKey,
} from "../src/cubic.js";

const key = (time: number, value: number, inSlope = 0, outSlope = inSlope): ScalarKey => ({
  time,
  value,
  inSlope,
  outSlope,
});

/** The glTF 2.0 cubic spline (Appendix C) of component `d` at time `t`. */
function gltfCubic(s: Sampled, d: number, t: number): number {
  const k = s.samples.findIndex((x, i) => x.time <= t && t <= s.samples[i + 1]!.time);
  const [a, b] = [s.samples[k]!, s.samples[k + 1]!];
  const td = b.time - a.time;
  const u = (t - a.time) / td;
  return (2 * u ** 3 - 3 * u ** 2 + 1) * a.value[d]! + td * (u ** 3 - 2 * u ** 2 + u) * a.outTangent[d]! +
    (-2 * u ** 3 + 3 * u ** 2) * b.value[d]! + td * (u ** 3 - u ** 2) * b.inTangent[d]!;
}

test("the samples are at the union of the components' key times, exact at every key", () => {
  const x = [key(0, 1, 0, 2), key(1, 3, 1), key(2, 0, -1)];
  const y = [key(0.5, -1, 0.5), key(1.5, 2, 4)];
  const s = sampleCurves([x, y]);
  assert.equal(s.interpolation, "CUBICSPLINE");
  assert.deepEqual(s.samples.map((v) => v.time), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(s.samples[2]!.value[0], 3);
  assert.deepEqual([s.samples[2]!.inTangent[0], s.samples[2]!.outTangent[0]], [1, 1]);
  // y before its first key and after its last holds the end value, tangents 0.
  assert.deepEqual([s.samples[0]!.value[1], s.samples[0]!.outTangent[1]], [-1, 0]);
  assert.deepEqual([s.samples[4]!.value[1], s.samples[4]!.inTangent[1]], [2, 0]);
  // Where a component has no key it is split on its segment: the glTF spline
  // then follows the original Hermite curve.
  for (const t of [0.1, 0.25, 0.7, 0.9, 1.2, 1.8]) {
    const j = x.findIndex((k, i) => k.time <= t && t <= x[i + 1]!.time);
    const [want] = hermite(x[j]!, x[j + 1]!, t);
    assert.ok(Math.abs(gltfCubic(s, 0, t) - want) < 1e-12, `x at ${t}`);
  }
  assert.ok(!s.samples[1]!.keyed && s.samples[0]!.keyed === false);
});

test("an infinite in slope on the first key is used by no segment: written as 0", () => {
  const s = sampleCurves([[key(0, 0.1, Infinity, 0), key(0.5, 0.25, 0.75)]]);
  assert.equal(s.interpolation, "CUBICSPLINE");
  assert.equal(s.samples[0]!.inTangent[0], 0);
  assert.equal(s.samples.length, 2);
  // The same for an infinite out slope on the last key.
  const end = sampleCurves([[key(0, 0, 1), key(1, 1, 1, -Infinity)]]);
  assert.equal(end.samples[1]!.outTangent[0], 0);
  assert.ok(packSampler(end).output.every(Number.isFinite));
});

test("a stepped segment between equal values holds them with zero tangents, no extra key", () => {
  // The fixture's Spine rotation: x and y stay 0, their last key's in slope infinite.
  const s = sampleCurves([
    [key(0, 0, Infinity, 0), key(1, 0, Infinity, 0)],
    [key(0, 1, Infinity, 0), key(1, 0.5, -1, 0)],
  ]);
  assert.equal(s.interpolation, "CUBICSPLINE");
  assert.deepEqual(s.samples.map((v) => v.time), [0, 1]);
  assert.deepEqual([s.samples[0]!.outTangent[0], s.samples[1]!.inTangent[0]], [0, 0]);
  assert.equal(gltfCubic(s, 0, 0.5), 0);
});

test("an interior stepped key holds the value and jumps one float32 step before the next key", () => {
  // Constant tangent mode: key 1's out slope infinite.
  const curve = [key(0, 0, 1), key(0.5, 1, 1, Infinity), key(1, 3, 0), key(2, 4, 0)];
  const s = sampleCurves([curve]);
  assert.equal(s.interpolation, "CUBICSPLINE");
  const end = floatBefore(1);
  assert.ok(end < 1 && Math.fround(end) === end && end > 0.99999);
  assert.deepEqual(s.samples.map((v) => v.time), [0, 0.5, end, 1, 2]);
  assert.deepEqual(s.samples[2]!.value, [1]);
  assert.deepEqual([s.samples[1]!.outTangent[0], s.samples[2]!.inTangent[0]], [0, 0]);
  assert.deepEqual([s.samples[2]!.outTangent[0], s.samples[3]!.inTangent[0]], [0, 0]);
  for (const t of [0.5, 0.6, 0.9, 0.99999]) assert.equal(gltfCubic(s, 0, t), 1, `held at ${t}`);
  assert.equal(gltfCubic(s, 0, 1), 3);
  // The infinite slope never reaches the file.
  assert.ok(packSampler(s).output.every(Number.isFinite));
  // An infinite in slope on the next key steps the segment the same way.
  const viaIn = sampleCurves([[key(0, 0, 1), key(0.5, 1, 1), key(1, 3, Infinity, 0), key(2, 4, 0)]]);
  assert.deepEqual(viaIn.samples.map((v) => v.time), [0, 0.5, end, 1, 2]);
});

test("a channel stepped at every key is a STEP sampler; one key too", () => {
  const s = sampleCurves([
    [key(0, 1, Infinity), key(0.5, 2, Infinity), key(1, 0, Infinity)],
    [key(0.25, 5, Infinity), key(1, 6, Infinity)],
  ]);
  assert.equal(s.interpolation, "STEP");
  assert.deepEqual(s.samples.map((v) => [v.time, ...v.value]), [
    [0, 1, 5], [0.25, 1, 5], [0.5, 2, 5], [1, 0, 6],
  ]);
  const packed = packSampler(s);
  assert.deepEqual([...packed.input], [0, 0.25, 0.5, 1]);
  assert.deepEqual([...packed.output], [1, 5, 1, 5, 2, 5, 0, 6]);
  const one = sampleCurves([[key(0.5, 7, 3)]]);
  assert.equal(one.interpolation, "STEP");
  assert.deepEqual([...packSampler(one).output], [7]);
});

test("weighted keys fall back to plain Hermite: their weights are not read", () => {
  const plain = [key(0, 0, 0, 2), key(1, 1, 0)];
  const weighted = plain.map((k) => ({ ...k, weightedMode: 3, inWeight: 0.9, outWeight: 0.1 }));
  assert.deepEqual(sampleCurves([weighted]), sampleCurves([plain]));
});

test("CUBICSPLINE output is in tangents, values, out tangents per sample", () => {
  const s = sampleCurves([[key(0, 1, 5, 2), key(1, 3, 4, 6)], [key(0, 10, 0), key(1, 20, 7)]]);
  assert.deepEqual([...packSampler(s).output], [0, 0, 1, 10, 2, 0, 4, 7, 3, 20, 0, 0]);
});

test("a rotation evaluated between keys is normalized with its tangents", () => {
  const s = normalizeRotation(sampleCurves([
    [key(0, 0), key(1, 0.7071067690849304)],
    [key(0, 0)],
    [key(0, 0)],
    [key(0, 1), key(0.5, 0.9), key(1, 0.7071067690849304)],
  ]));
  const mid = s.samples[1]!;
  assert.ok(!mid.keyed);
  assert.ok(Math.abs(Math.hypot(...mid.value) - 1) < 1e-12);
  // The key samples are left as the curves hold them.
  assert.deepEqual(s.samples[0]!.value, [0, 0, 0, 1]);
  // The tangent stays orthogonal to the unit value (the derivative of a unit quaternion).
  const dot = mid.value.reduce((sum, c, i) => sum + c * mid.outTangent[i]!, 0);
  assert.ok(Math.abs(dot) < 1e-12);
});

test("euler angles convert as Quaternion.Euler: z, then x, then y", () => {
  const close = (a: number[], b: number[]) =>
    a.every((v, i) => Math.abs(v - b[i]!) < 1e-12) || assert.fail(`${a} != ${b}`);
  const h = Math.SQRT1_2;
  close(eulerToQuaternion([0, 90, 0], [0, 0, 0])[0], [0, h, 0, h]);
  close(eulerToQuaternion([90, 0, 0], [0, 0, 0])[0], [h, 0, 0, h]);
  // Euler(90, 90, 0) = Euler(0, 90, 0) * Euler(90, 0, 0): (0.5, 0.5, -0.5, 0.5).
  close(eulerToQuaternion([90, 90, 0], [0, 0, 0])[0], [0.5, 0.5, -0.5, 0.5]);
  // Euler(0, 90, 90) = Euler(0, 90, 0) * Euler(0, 0, 90): (0.5, 0.5, 0.5, 0.5).
  close(eulerToQuaternion([0, 90, 90], [0, 0, 0])[0], [0.5, 0.5, 0.5, 0.5]);
  // The derivative matches a central difference.
  const e = [30, -45, 60];
  const rate = [10, 20, -30];
  const [, dq] = eulerToQuaternion(e, rate);
  const step = 1e-6;
  const at = (t: number) => eulerToQuaternion(e.map((v, i) => v + rate[i]! * t), [0, 0, 0])[0];
  const [plus, minus] = [at(step), at(-step)];
  dq.forEach((d, i) => assert.ok(Math.abs(d - (plus[i]! - minus[i]!) / (2 * step)) < 1e-6));
});

test("euler and stepped curves export to a validator-clean scene", async () => {
  const env = fixtureEnv("editor/2019.4.41f2/scene/lz4/scene");
  const root = env.objects.find((o) => {
    if (o.type !== 1 || o.read<GameObject>().m_Name !== "scene") return false;
    return env.objects.some((a) => a.type === 95 && a.read<Animator>().m_GameObject.m_PathID === o.pathId);
  })!;
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const k = <T>(time: number, value: T, inSlope: T, outSlope: T) => ({ time, value, inSlope, outSlope });
  const inf = v(Infinity, Infinity, Infinity);
  const zero = v(0, 0, 0);
  const curves: Curves = {
    rotation: [],
    euler: [{ path: "Armature/Hips", keyframes: [k(0, v(0, 0, 0), zero, v(0, 90, 0)), k(1, v(0, 90, 30), v(0, 90, 0), zero)] }],
    position: [{ path: "Armature", keyframes: [k(0, v(1, 2, 3), inf, inf), k(0.5, v(4, 5, 6), inf, inf)] }],
    scale: [],
    float: [
      { path: "Prop", attribute: "m_IsActive", classId: 1, keyframes: [k(0, 1, 0, 0), k(1, 0, 0, 0)] },
      { path: "", attribute: "Spine Front-Back", classId: 95, keyframes: [k(0, 1, 0, 0), k(1, 0, 0, 0)] },
    ],
    pptr: [],
  };
  const glb = writeScene(env, root, [{ name: "synthetic", curves }, { name: "synthetic", curves }]);
  const report = await gltfValidator.validateBytes(glb);
  assert.deepEqual(report.issues.messages.filter((m) => m.severity === 0), []);
  const length = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  // A repeated name gets _1, as ConvertAnimations names it.
  assert.deepEqual(json.animations.map((a: { name: string }) => a.name), ["synthetic", "synthetic_1"]);
  const [anim] = json.animations;
  // The muscle and m_IsActive curves have no channel; the euler curve is a rotation.
  assert.deepEqual(
    anim.channels.map((c: { target: { node: number; path: string } }) => [json.nodes[c.target.node].name, c.target.path]),
    [["Armature", "translation"], ["Hips", "rotation"]],
  );
  assert.deepEqual(anim.samplers.map((s: { interpolation: string }) => s.interpolation), ["STEP", "CUBICSPLINE"]);
  const floats = (index: number): number[] => {
    const a = json.accessors[index];
    const view = json.bufferViews[a.bufferView];
    const at = glb.byteOffset + 20 + length + 8 + view.byteOffset;
    return [...new Float32Array(glb.buffer.slice(at, at + view.byteLength))];
  };
  // The stepped translation: x negated, values held.
  assert.deepEqual(floats(anim.samplers[0].output), [-1, 2, 3, -4, 5, 6]);
  // The rotation's last key: Quaternion.Euler(0, 90, 30) with y and z negated, in tangent
  // its derivative for 90 degrees per second about y.
  const rotation = floats(anim.samplers[1].output);
  const [q, dq] = eulerToQuaternion([0, 90, 30], [0, 90, 0]);
  const mirrored = (p: number[]) => [p[0]!, -p[1]!, -p[2]!, p[3]!].map(Math.fround);
  assert.deepEqual(rotation.slice(12, 16), mirrored(dq));
  assert.deepEqual(rotation.slice(16, 20), mirrored(q));
  assert.deepEqual(rotation.slice(20, 24).map(Math.abs), [0, 0, 0, 0]);
});
