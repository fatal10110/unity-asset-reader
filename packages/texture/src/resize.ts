// Resamples like ImageSharp 2.1.3's default Resize, which upstream AssetStudio
// (AssetStudio.Utility/SpriteHelper.cs, CutImage) runs on a variant atlas.
// Written from that resize's arithmetic, not translated from its code: see resizeCrop.

import type { RgbaImage } from "./convert.js";

/** 32-bit float rounding: ImageSharp computes pixels in `float`. */
const f32 = Math.fround;

/** ImageSharp's tolerance for "an integer" when it places a kernel window. */
const EPSILON = 1e-8;

/** Where a kernel starts in the source row or column, and its weights from there. */
interface Kernel {
  start: number;
  weights: Float32Array;
}

/**
 * Part of `image` resized to `toWidth x toHeight` as ImageSharp 2.1.3's
 * `Resize(width, height)` resizes it (bicubic, alpha premultiplied, no
 * companding), which is what upstream `CutImage` does to a variant atlas
 * before it cuts the sprite out: the `width x height` pixels from (`x`, `y`)
 * up of the resized image, rows bottom first, as `CutImage` holds them.
 *
 * Only the pixels asked for are computed: each depends only on the source
 * pixels under its kernel, so this is the resized image cropped, without
 * resizing all of it. Upstream resizes the texture with its rows as stored,
 * bottom first, and so does this; `image` is top row first, as
 * `decodeTexture2D` returns it.
 *
 * The arithmetic is ImageSharp's, in 32-bit floats where it uses `float`:
 *
 * - A byte `b` becomes `b / 255`, and colour is multiplied by alpha.
 * - Each axis has a kernel per destination pixel `i`, centred on
 *   `(i + 0.5) * from / to - 0.5` in source pixels: Keys' cubic (a = -0.5)
 *   of radius 2, widened by `from / to` when shrinking, over the source
 *   pixels within its radius (window ends within 1e-8 of an integer are
 *   that integer). Weights are computed in double, divided by their sum and
 *   stored as floats.
 * - Rows are resampled first, then columns: each a sum, term by term in
 *   order, of pixel times weight.
 * - Colour is divided by alpha, and a float `v` becomes the byte
 *   `v * 255 + 0.5`, clamped to 0..255 and truncated (`NaN` gives 0).
 *
 * ponytail: ImageSharp's own output depends on the CPU. On x64 with AVX2
 * and FMA it sums with fused multiply-adds in four interleaved accumulators,
 * and rows of 128 or 256 pixels or more convert bytes with `b * (1 / 255)`
 * and may round floats half to even; a channel can then differ by 1. This is
 * its scalar arithmetic, which the executed AssetStudio reference (#153,
 * a 32 -> 64 atlas) matches to the byte where the FMA sum does not. A wider
 * variant atlas reference would pin the row conversions too.
 *
 * @param image the texture, top row first
 * @param toWidth the width to resize it to
 * @param toHeight the height to resize it to
 * @param x the first column of the resized image to return
 * @param y the first row, counting from the bottom
 * @param width how many columns, all inside `toWidth`
 * @param height how many rows, all inside `toHeight`
 * @returns a new `width x height` RGBA image, rows bottom first
 */
export function resizeCrop(
  image: RgbaImage,
  toWidth: number,
  toHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImage {
  const columns = kernels(image.width, toWidth, x, width);
  const rows = kernels(image.height, toHeight, y, height);
  const first = Math.min(...rows.map((k) => k.start));
  const last = Math.max(...rows.map((k) => k.start + k.weights.length));

  // Rows first: each source row a kernel window needs, at each output column.
  const stride = width * 4;
  const pass = new Float32Array((last - first) * stride);
  for (let row = first; row < last; row++) {
    const source = premultiplied(image, image.height - 1 - row);
    const at = (row - first) * stride;
    for (let col = 0; col < width; col++) {
      const { start, weights } = columns[col]!;
      convolve(source, start * 4, 4, weights, pass, at + col * 4);
    }
  }

  // Then columns, into bytes.
  const out = new Uint8Array(width * height * 4);
  const sum = new Float32Array(4);
  for (let row = 0; row < height; row++) {
    const { start, weights } = rows[row]!;
    for (let col = 0; col < width; col++) {
      convolve(pass, (start - first) * stride + col * 4, stride, weights, sum, 0);
      const alpha = sum[3]!;
      const at = (row * width + col) * 4;
      for (let c = 0; c < 3; c++) out[at + c] = toByte(f32(sum[c]! / alpha));
      out[at + 3] = toByte(alpha);
    }
  }
  return { data: out, width, height };
}

/** Row `row` (top first) of `image` as floats in 0..1, colour multiplied by alpha. */
function premultiplied({ data, width }: RgbaImage, row: number): Float32Array {
  const out = new Float32Array(width * 4);
  const from = row * width * 4;
  for (let at = 0; at < out.length; at += 4) {
    const alpha = f32(data[from + at + 3]! / 255);
    for (let c = 0; c < 3; c++) out[at + c] = f32(f32(data[from + at + c]! / 255) * alpha);
    out[at + 3] = alpha;
  }
  return out;
}

/**
 * The weighted sum of `weights.length` RGBA float pixels of `values`,
 * `stride` floats apart from `from`, into `out` at `to`.
 */
function convolve(
  values: Float32Array,
  from: number,
  stride: number,
  weights: Float32Array,
  out: Float32Array,
  to: number,
): void {
  for (let c = 0; c < 4; c++) {
    let sum = 0;
    for (let k = 0, at = from + c; k < weights.length; k++, at += stride) {
      sum = f32(sum + f32(values[at]! * weights[k]!));
    }
    out[to + c] = sum;
  }
}

/** A float in 0..1 to a byte: `v * 255 + 0.5` clamped to 0..255 and truncated, `NaN` 0. */
function toByte(value: number): number {
  const half = f32(f32(value * 255) + 0.5);
  if (!(half > 0)) return 0;
  return half >= 255 ? 255 : Math.trunc(half);
}

/** `value` to the nearest integer, halves to even (C#'s `Math.Round`). */
function roundHalfEven(value: number): number {
  const up = Math.round(value);
  return up - value === 0.5 && up % 2 !== 0 ? up - 1 : up;
}

/** `Math.ceil`, but a value within {@link EPSILON} of an integer is that integer. */
function ceilTolerant(value: number): number {
  const nearest = roundHalfEven(value);
  return Math.abs(value - nearest) < EPSILON ? nearest : Math.ceil(value);
}

/** `Math.floor`, but a value within {@link EPSILON} of an integer is that integer. */
function floorTolerant(value: number): number {
  const nearest = roundHalfEven(value);
  return Math.abs(value - nearest) < EPSILON ? nearest : Math.floor(value);
}

/** Keys' cubic convolution kernel with a = -0.5, in floats. */
function bicubic(distance: number): number {
  const x = Math.abs(distance);
  if (x <= 1) return f32(f32(f32(f32(f32(1.5 * x) - 2.5) * x) * x) + 1);
  if (x < 2) return f32(f32(f32(f32(f32(f32(-0.5 * x) + 2.5) * x) - 4) * x) + 2);
  return 0;
}

/**
 * The kernels of destination pixels `first` to `first + count - 1` when a
 * `from`-pixel axis is resized to `to` pixels.
 */
function kernels(from: number, to: number, first: number, count: number): Kernel[] {
  const ratio = from / to;
  const scale = Math.max(ratio, 1);
  const radius = ceilTolerant(scale * 2);
  const out: Kernel[] = [];
  for (let i = first; i < first + count; i++) {
    const c = (i + 0.5) * ratio - 0.5;
    const start = Math.max(ceilTolerant(c - radius), 0);
    const end = Math.min(floorTolerant(c + radius), from - 1);
    const values: number[] = [];
    let sum = 0;
    for (let j = start; j <= end; j++) {
      const value = bicubic(f32((j - c) / scale));
      sum += value;
      values.push(value);
    }
    out.push({ start, weights: Float32Array.from(values, (v) => (sum > 0 ? v / sum : v)) });
  }
  return out;
}
