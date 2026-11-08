// Unity's Hermite keyframe curves as glTF 2.0 animation samplers. Not a port:
// AssetStudio's FBX path keeps key values only (ModelConverter), so the
// tangents follow Unity's own curve evaluation and the glTF 2.0 spec's cubic
// spline (Appendix C, "Spline Interpolation").

/** One key of one component's Unity curve: a Hermite key, slopes per second. */
export interface ScalarKey {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
}

/** A channel at one sample time: each component's value and tangents there. */
export interface Sample {
  time: number;
  value: number[];
  inTangent: number[];
  outTangent: number[];
  /** Whether every component has a key at this time. */
  keyed: boolean;
}

/** A channel's samples and the interpolation that reproduces its curves between them. */
export interface Sampled {
  interpolation: "STEP" | "CUBICSPLINE";
  samples: Sample[];
}

/**
 * Whether Unity holds the left key's value over the segment: it evaluates a
 * segment whose out slope or next in slope is infinite (a stepped key, the
 * "Constant" tangent mode) as the left key's value.
 */
const stepped = (a: ScalarKey, b: ScalarKey): boolean =>
  !Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope);

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The float32 just below the float32 `t`. */
export function floatBefore(t: number): number {
  f32[0] = t;
  if (t > 0) u32[0]!--;
  else if (t === 0) u32[0] = 0x80000001;
  else u32[0]!++;
  return f32[0]!;
}

/**
 * Value and derivative of the Hermite segment from `a` to `b` at time `t`,
 * as Unity evaluates a key pair: slopes per second, scaled by the interval.
 */
export function hermite(a: ScalarKey, b: ScalarKey, t: number): [number, number] {
  const dt = b.time - a.time;
  const s = (t - a.time) / dt;
  const m0 = a.outSlope * dt;
  const m1 = b.inSlope * dt;
  const s2 = s * s;
  const s3 = s2 * s;
  const value =
    (2 * s3 - 3 * s2 + 1) * a.value + (s3 - 2 * s2 + s) * m0 +
    (-2 * s3 + 3 * s2) * b.value + (s3 - s2) * m1;
  const slope =
    ((6 * s2 - 6 * s) * a.value + (3 * s2 - 4 * s + 1) * m0 +
      (-6 * s2 + 6 * s) * b.value + (3 * s2 - 2 * s) * m1) / dt;
  return [value, slope];
}

/** One component at time `t`: value, in tangent, out tangent, and whether it has a key there. */
function at(keys: ScalarKey[], t: number, step: boolean): [number, number, number, boolean] {
  let j = -1;
  while (j + 1 < keys.length && keys[j + 1]!.time <= t) j++;
  // Before the first key and after the last, Unity holds the end key's value.
  if (j < 0) return [keys[0]!.value, 0, 0, false];
  const key = keys[j]!;
  const next = keys[j + 1];
  if (key.time === t) {
    if (step) return [key.value, 0, 0, true];
    // A tangent no segment uses (the first key's in, the last key's out, an
    // infinite slope) or a held segment's is 0: glTF holds finite floats only.
    const prev = keys[j - 1];
    const inTangent = !prev || stepped(prev, key) ? 0 : key.inSlope;
    const outTangent = !next || stepped(key, next) ? 0 : key.outSlope;
    return [key.value, inTangent, outTangent, true];
  }
  if (!next || step || stepped(key, next)) return [key.value, 0, 0, false];
  const [value, slope] = hermite(key, next, t);
  return [value, slope, slope, false];
}

/**
 * Sample a channel's curves, one per component, for a glTF sampler.
 *
 * The samples are at the union of the components' key times; between its own
 * keys a component is evaluated on its Hermite segment, value and derivative,
 * which splits the segment exactly. Tangents are Unity's slopes per second:
 * the glTF cubic spline multiplies them by the key interval as Unity does.
 *
 * A stepped segment (an infinite out slope, or an infinite in slope on the
 * key after it) holds its left value with zero tangents. Where the next key's
 * value differs, a sample one float32 step before the next key ends the hold,
 * so the value jumps within that step (glTF holds no infinity). When every
 * segment of every component is stepped, or there is one sample time, the
 * channel is `STEP` instead, which holds values exactly. An infinite in slope
 * on a curve's first key (or out slope on its last) is used by no segment and
 * is written as 0.
 *
 * Weighted tangents fall back to plain Hermite: the keys carry no weights.
 *
 * @param components each component's keys, in time order, at least one each
 */
export function sampleCurves(components: ScalarKey[][]): Sampled {
  const times = new Set<number>();
  for (const keys of components) for (const k of keys) times.add(k.time);
  const allStepped = components.every((keys) =>
    keys.every((k, i) => i === 0 || stepped(keys[i - 1]!, k)),
  );
  const step = times.size === 1 || allStepped;
  if (!step) {
    for (const keys of components) {
      for (let i = 1; i < keys.length; i++) {
        const [a, b] = [keys[i - 1]!, keys[i]!];
        if (!stepped(a, b) || a.value === b.value) continue;
        const end = floatBefore(b.time);
        if (end > a.time) times.add(end);
      }
    }
  }
  const samples = [...times]
    .sort((a, b) => a - b)
    .map((time): Sample => {
      const sample: Sample = { time, value: [], inTangent: [], outTangent: [], keyed: true };
      for (const keys of components) {
        const [value, inTangent, outTangent, keyed] = at(keys, time, step);
        sample.value.push(value);
        sample.inTangent.push(inTangent);
        sample.outTangent.push(outTangent);
        sample.keyed &&= keyed;
      }
      return sample;
    });
  return { interpolation: step ? "STEP" : "CUBICSPLINE", samples };
}

/**
 * The sampler's input and output data: the times, and per sample the values
 * (`STEP`), or the in tangents, the values and the out tangents
 * (`CUBICSPLINE`), every component of each in turn.
 */
export function packSampler(sampled: Sampled): { input: Float32Array; output: Float32Array } {
  const { samples, interpolation } = sampled;
  const input = Float32Array.from(samples, (s) => s.time);
  const parts = interpolation === "STEP"
    ? samples.map((s) => s.value)
    : samples.flatMap((s) => [s.inTangent, s.value, s.outTangent]);
  return { input, output: Float32Array.from(parts.flat()) };
}

/**
 * Normalize a rotation's samples where a component was evaluated between its
 * keys, as Unity normalizes the interpolated quaternion: the value divided by
 * its length, the tangents by the derivative of that. Samples where every
 * component has a key keep the key values as they are.
 */
export function normalizeRotation(sampled: Sampled): Sampled {
  const unit = (q: number[], dq: number[]): number[] => {
    const len = Math.hypot(...q);
    const dot = q.reduce((sum, c, i) => sum + c * dq[i]!, 0);
    return dq.map((d, i) => d / len - (q[i]! * dot) / len ** 3);
  };
  for (const s of sampled.samples) {
    if (s.keyed) continue;
    const len = Math.hypot(...s.value);
    if (len === 0) continue;
    s.inTangent = unit(s.value, s.inTangent);
    s.outTangent = unit(s.value, s.outTangent);
    s.value = s.value.map((c) => c / len);
  }
  return sampled;
}

/** A quaternion, x, y, z, w. */
type Quat = [number, number, number, number];

const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * Unity's `Quaternion.Euler` of angles in degrees, and its derivative for the
 * angles' rates in degrees per second: z first, then x, then y, about the
 * fixed axes (`q = qy * qx * qz`). No oracle: AssetStudio converts with the
 * native FBX SDK (`Fbx.EulerToQuaternion`).
 */
export function eulerToQuaternion(degrees: number[], rates: number[]): [Quat, Quat] {
  const toRad = Math.PI / 180;
  const axis = (d: number, angle: number, rate: number): [Quat, Quat] => {
    const half = (angle * toRad) / 2;
    const q: Quat = [0, 0, 0, Math.cos(half)];
    const dq: Quat = [0, 0, 0, -Math.sin(half) * rate * toRad / 2];
    q[d] = Math.sin(half);
    dq[d] = Math.cos(half) * rate * toRad / 2;
    return [q, dq];
  };
  const [qx, dx] = axis(0, degrees[0]!, rates[0]!);
  const [qy, dy] = axis(1, degrees[1]!, rates[1]!);
  const [qz, dz] = axis(2, degrees[2]!, rates[2]!);
  const q = multiply(multiply(qy, qx), qz);
  const sum = (a: Quat, b: Quat, c: Quat): Quat => [0, 1, 2, 3].map((i) => a[i]! + b[i]! + c[i]!) as Quat;
  const dq = sum(
    multiply(multiply(dy, qx), qz),
    multiply(multiply(qy, dx), qz),
    multiply(multiply(qy, qx), dz),
  );
  return [q, dq];
}

/**
 * An euler channel's samples (three components, degrees) as a rotation's:
 * each sample's angles converted with {@link eulerToQuaternion}, each tangent
 * as the quaternion's derivative for the angles' slopes. Exact at the
 * samples; between them glTF's spline in quaternion space only approximates
 * Unity's interpolation of the angles.
 */
export function eulerSamples(sampled: Sampled): Sampled {
  return {
    interpolation: sampled.interpolation,
    samples: sampled.samples.map((s) => {
      const [value, dIn] = eulerToQuaternion(s.value, s.inTangent);
      const [, dOut] = eulerToQuaternion(s.value, s.outTangent);
      return { time: s.time, value, inTangent: dIn, outTangent: dOut, keyed: s.keyed };
    }),
  };
}
