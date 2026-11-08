// Ported from AssetStudio/Classes/AnimationClip.cs (MIT, © Perfare / RazTools / Razviar)
import { CorruptError } from "unity-asset-reader";

const f32 = Math.fround;

/** One key of a streamed curve (upstream `StreamedClip.StreamedCurveKey`). */
export interface StreamedCurveKey {
  /** The curve's index among the clip's curves. */
  index: number;
  /** The cubic's four coefficients; the last two are the out slope and the value. */
  coeff: [number, number, number, number];
  value: number;
  outSlope: number;
  /** Filled in by {@link readStreamedFrames} from the previous key of the same curve. */
  inSlope: number;
}

/** The keys of one time (upstream `StreamedClip.StreamedFrame`). */
export interface StreamedFrame {
  time: number;
  keyList: StreamedCurveKey[];
}

/**
 * The in slope at `rhs` of the segment that starts at `key` and lasts `dx`
 * (upstream `StreamedCurveKey.CalculateNextInSlope`): infinity for a stepped
 * segment. Every intermediate is a float32, in upstream's order.
 */
export function nextInSlope(key: StreamedCurveKey, dx: number, rhs: StreamedCurveKey): number {
  const [c0, c1, c2] = key.coeff;
  if (c0 === 0 && c1 === 0 && c2 === 0) return Infinity;
  dx = Math.max(dx, f32(0.0001));
  const dy = f32(rhs.value - key.value);
  const length = f32(1 / f32(dx * dx));
  const d1 = f32(key.outSlope * dx);
  const d2 = f32(f32(f32(f32(f32(dy + dy) + dy) - d1) - d1) - f32(c1 / length));
  return f32(d2 / dx);
}

/**
 * Decode a `StreamedClip`'s words into its frames (upstream
 * `StreamedClip.ReadData`): each frame a float32 time, an int32 key count and
 * that many keys of an int32 curve index and four float32 coefficients,
 * little-endian. The first frame only gives the slopes of the first real one,
 * and the last is at +infinity.
 *
 * @param data the clip's `m_StreamedClip.data` words
 * @param owner names the clip in an error
 * @throws {CorruptError} when a frame runs past the end of the words, or a
 *   key count is negative
 */
export function readStreamedFrames(data: number[], owner: string): StreamedFrame[] {
  const view = new DataView(new ArrayBuffer(data.length * 4));
  data.forEach((word, i) => view.setUint32(i * 4, word, true));
  const frames: StreamedFrame[] = [];
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > view.byteLength) {
      throw new CorruptError(
        `${owner}: m_StreamedClip.data ends inside a frame at byte ${pos}, ` +
          `needing ${n} bytes of ${view.byteLength}`,
      );
    }
  };
  while (pos < view.byteLength) {
    need(8);
    const time = view.getFloat32(pos, true);
    const numKeys = view.getInt32(pos + 4, true);
    pos += 8;
    if (numKeys < 0) {
      throw new CorruptError(`${owner}: m_StreamedClip.data has a frame of ${numKeys} keys`);
    }
    const keyList: StreamedCurveKey[] = [];
    for (let i = 0; i < numKeys; i++) {
      need(20);
      const index = view.getInt32(pos, true);
      const coeff: [number, number, number, number] = [
        view.getFloat32(pos + 4, true),
        view.getFloat32(pos + 8, true),
        view.getFloat32(pos + 12, true),
        view.getFloat32(pos + 16, true),
      ];
      pos += 20;
      keyList.push({ index, coeff, outSlope: coeff[2], value: coeff[3], inSlope: 0 });
    }
    frames.push({ time, keyList });
  }
  for (let frameIndex = 2; frameIndex < frames.length - 1; frameIndex++) {
    const frame = frames[frameIndex]!;
    for (const curveKey of frame.keyList) {
      for (let i = frameIndex - 1; i >= 0; i--) {
        const preFrame = frames[i]!;
        const preCurveKey = preFrame.keyList.find((x) => x.index === curveKey.index);
        if (preCurveKey) {
          curveKey.inSlope = nextInSlope(preCurveKey, f32(frame.time - preFrame.time), curveKey);
          break;
        }
      }
    }
  }
  return frames;
}
