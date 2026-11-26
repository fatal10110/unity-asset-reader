// PNG writer for RGBA8 images (#234), written from the PNG specification
// (ISO/IEC 15948, W3C PNG 2nd edition) and RFC 1950 / RFC 1951, not ported:
// AssetStudio hands its images to ImageSharp, whose encoder is not followed here.

import { crc32 } from "unity-asset-reader";

import type { RgbaImage } from "./convert.js";

// The package compiles with `lib: ["ES2020"]` and no DOM types (R4), so the
// WHATWG `CompressionStream` is declared here by the members used.
declare const CompressionStream: new (format: "deflate") => {
  readonly readable: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  };
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The largest PNG chunk length and image dimension, 2^31 - 1. */
const PNG_MAX = 0x7fffffff;
/** The most bytes one stored deflate block holds (`LEN` is 16 bits). */
const STORED_MAX = 0xffff;
/** zlib header: deflate, 32 KiB window, no dictionary, "fastest"; `0x7801 % 31 === 0`. */
const ZLIB_HEADER = [0x78, 0x01];
/** Adler-32's modulus, and the most bytes summed before `b` can overflow 2^32 (RFC 1950). */
const ADLER_MOD = 65521;
const ADLER_NMAX = 5552;

/**
 * Encode an RGBA8 image as a PNG file: 8-bit RGBA (colour type 6), not
 * interlaced, every row with filter type 0 (None), in one `IDAT` chunk whose
 * zlib stream holds stored (uncompressed) deflate blocks. Sync, with no
 * dependency, so it runs the same in browsers, Workers and Node.js; the cost
 * is size: the file is about as large as the pixels (`width * height * 4`
 * bytes plus one byte a row and 5 bytes per 64 KiB). If size matters, use
 * {@link encodePngCompressed} (async) or recompress it with an image tool.
 *
 * The rows are written in the order `image.data` holds them, and a PNG starts
 * with its top row: pass a `decodeTexture2D` or `decodeSprite` result (top
 * row first) as is, and reverse the rows of a `convertPlain` result (bottom
 * row first) before.
 *
 * @param image the pixels, R G B A, `width * height * 4` bytes, top row first.
 *   A `decodeImage` result holds them in `rgba`:
 *   `encodePng({ data: image.rgba, width: image.width, height: image.height })`
 * @returns a new PNG file
 * @throws {TypeError} when `image.data` is not a `Uint8Array` or `width` /
 *   `height` is not an integer
 * @throws {RangeError} when `width` or `height` is outside 1 to 2^31 - 1 (a
 *   PNG has at least one pixel, so a 0x0 dynamic font texture has no PNG),
 *   `image.data` is not exactly `width * height * 4` bytes, or the image data
 *   would not fit in one PNG chunk (2^31 - 1 bytes, about 23170 x 23170
 *   pixels)
 * @example
 * const png = encodePng(await decodeTexture2D(obj.read()));
 */
export function encodePng(image: RgbaImage): Uint8Array {
  const { data, width, height } = image;
  const stride = checkImage(image, "encodePng");

  // The filtered image: each row is a filter-type byte (0) and the row's pixels.
  const raw = height * (stride + 1);
  const blocks = Math.ceil(raw / STORED_MAX);
  const idatLength = ZLIB_HEADER.length + blocks * 5 + raw + 4;
  // ponytail: one IDAT caps the image at 2^31 - 1 bytes of data, past Unity's
  // 16384 x 16384 maximum; split IDAT per deflate block if a caller needs more.
  if (idatLength > PNG_MAX) {
    throw new RangeError(
      `encodePng: ${width} x ${height} needs ${idatLength} bytes of image data, ` +
        `more than one PNG chunk holds (${PNG_MAX})`,
    );
  }

  return writePng(width, height, idatLength, (out, view, start) => {
    out.set(ZLIB_HEADER, start);
    let pos = start + ZLIB_HEADER.length;
    let a = 1;
    let b = 0;
    for (let from = 0; from < raw; from += STORED_MAX) {
      const length = Math.min(STORED_MAX, raw - from);
      out[pos] = from + length === raw ? 1 : 0; // BFINAL on the last block, BTYPE 00 (stored)
      view.setUint16(pos + 1, length, true);
      view.setUint16(pos + 3, ~length & 0xffff, true);
      pos += 5;
      copyRows(out, pos, data, stride, from, length);
      // Adler-32 of the uncompressed stream, which is exactly this block's payload.
      for (let i = pos, end = pos + length; i < end; ) {
        const stop = Math.min(end, i + ADLER_NMAX);
        for (; i < stop; i++) {
          a += out[i]!;
          b += a;
        }
        a %= ADLER_MOD;
        b %= ADLER_MOD;
      }
      pos += length;
    }
    view.setUint32(pos, ((b << 16) | a) >>> 0);
  });
}

/**
 * Encode an RGBA8 image as a compressed PNG file: the same image as
 * {@link encodePng} writes, with each row filtered (None, Sub or Up, whichever
 * leaves the smallest residuals) and deflated by the platform's
 * `CompressionStream("deflate")`, whose zlib stream is the `IDAT` chunk. No
 * dependency; async because the stream is. `CompressionStream` is in Chrome
 * 80+, Firefox 113+, Safari 16.4+, Workers, Deno and Node.js 18+.
 *
 * The rows are taken top row first, as for {@link encodePng}.
 *
 * @param image the pixels, R G B A, `width * height * 4` bytes, top row first
 * @returns a promise of a new PNG file, which decodes to the same pixels as
 *   `encodePng(image)`
 * @throws {TypeError} (the promise rejects) when `image.data` is not a
 *   `Uint8Array` or `width` / `height` is not an integer
 * @throws {RangeError} (the promise rejects) when `width` or `height` is
 *   outside 1 to 2^31 - 1, `image.data` is not exactly `width * height * 4`
 *   bytes, or the compressed image data does not fit in one PNG chunk
 *   (2^31 - 1 bytes)
 * @throws {ReferenceError} (the promise rejects) when the platform has no
 *   `CompressionStream`
 * @example
 * const png = await encodePngCompressed(await decodeTexture2D(obj.read()));
 */
export async function encodePngCompressed(image: RgbaImage): Promise<Uint8Array> {
  const { data, width, height } = image;
  const stride = checkImage(image, "encodePngCompressed");
  const idat = await deflate(filterRows(data, stride, height));
  if (idat.length > PNG_MAX) {
    throw new RangeError(
      `encodePngCompressed: ${width} x ${height} compresses to ${idat.length} bytes of ` +
        `image data, more than one PNG chunk holds (${PNG_MAX})`,
    );
  }
  return writePng(width, height, idat.length, (out, _view, start) => out.set(idat, start));
}

/**
 * Check an image for a PNG encoder named `name`; returns its row length in bytes.
 * @throws {TypeError} / {RangeError} as {@link encodePng} documents
 */
function checkImage(image: RgbaImage, name: string): number {
  const { data, width, height } = image;
  if (!(data instanceof Uint8Array)) {
    const value = data as unknown;
    const got =
      typeof value === "object" && value !== null
        ? (value.constructor?.name ?? "object")
        : String(value);
    throw new TypeError(`${name}: image.data must be a Uint8Array, got ${got}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new TypeError(`${name}: image size ${width} x ${height} is not an integer size`);
  }
  if (width < 1 || height < 1 || width > PNG_MAX || height > PNG_MAX) {
    throw new RangeError(
      `${name}: image size ${width} x ${height} is outside 1 to ${PNG_MAX} pixels a side`,
    );
  }
  const stride = width * 4;
  if (data.length !== stride * height) {
    throw new RangeError(
      `${name}: image data is ${data.length} bytes, ${width} x ${height} RGBA needs ` +
        `${stride * height}`,
    );
  }
  return stride;
}

/**
 * Write a PNG file of a `width x height` 8-bit RGBA image: signature, `IHDR`,
 * one `IDAT` of `idatLength` bytes that `fill` writes from the offset it is
 * given, and `IEND`.
 */
function writePng(
  width: number,
  height: number,
  idatLength: number,
  fill: (out: Uint8Array, view: DataView, start: number) => void,
): Uint8Array {
  const out = new Uint8Array(SIGNATURE.length + (12 + 13) + (12 + idatLength) + 12);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;

  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), compression 0,
  // filter method 0, interlace 0.
  at = chunk(out, view, at, "IHDR", 13, (start) => {
    view.setUint32(start, width);
    view.setUint32(start + 4, height);
    out.set([8, 6, 0, 0, 0], start + 8);
  });
  at = chunk(out, view, at, "IDAT", idatLength, (start) => fill(out, view, start));
  chunk(out, view, at, "IEND", 0, () => {});
  return out;
}

/**
 * The filtered image: each row is a filter-type byte and the row's filtered
 * pixels. Per row it takes None (0), Sub (1) or Up (2), whichever has the
 * smallest sum of residuals read as signed bytes, the PNG specification's
 * suggested heuristic (ISO/IEC 15948 section 12.8); a tie keeps the lower type.
 */
function filterRows(data: Uint8Array, stride: number, height: number): Uint8Array {
  const out = new Uint8Array(height * (stride + 1));
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  const cost = (v: number): number => (v < 128 ? v : 256 - v);
  for (let y = 0, row = 0; y < height; y++, row += stride) {
    let none = 0;
    let left = 0;
    let above = 0;
    for (let i = 0; i < stride; i++) {
      const x = data[row + i]!;
      sub[i] = x - (i < 4 ? 0 : data[row + i - 4]!);
      up[i] = x - (y === 0 ? 0 : data[row - stride + i]!);
      none += cost(x);
      left += cost(sub[i]!);
      above += cost(up[i]!);
    }
    let type = 0;
    let best = none;
    if (left < best) [type, best] = [1, left];
    if (above < best) type = 2;
    const at = y * (stride + 1);
    out[at] = type;
    out.set(type === 1 ? sub : type === 2 ? up : data.subarray(row, row + stride), at + 1);
  }
  return out;
}

/**
 * Deflate `data` into a zlib stream (RFC 1950: header, deflate data, Adler-32)
 * with the platform's `CompressionStream("deflate")`. The input is written
 * while the output is read: the stream applies backpressure, so writing
 * everything first would stall on a large input.
 */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  // A failing stream rejects the write side as well as the read side; the read
  // side reports it first, so this one must not go unhandled meanwhile.
  written.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.length;
    }
  }
  await written;
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Copy `length` bytes of the filtered image, from its offset `from`, to
 * `out[at..]`: the pixels of the rows they cover. Filter-type bytes are 0,
 * which `out` already holds.
 */
function copyRows(
  out: Uint8Array,
  at: number,
  data: Uint8Array,
  stride: number,
  from: number,
  length: number,
): void {
  const line = stride + 1;
  for (let offset = from, end = from + length; offset < end; ) {
    const row = Math.floor(offset / line);
    const column = offset - row * line; // 0 is the filter byte
    const stop = Math.min(end, (row + 1) * line);
    if (column === 0) {
      offset++;
      continue;
    }
    const pixels = row * stride + column - 1;
    out.set(data.subarray(pixels, pixels + (stop - offset)), at + (offset - from));
    offset = stop;
  }
}

/**
 * Write one chunk at `at`: length, type, the `length` data bytes `fill`
 * writes from the offset it is given, and the CRC-32 of type and data.
 * Returns the offset after the chunk.
 */
function chunk(
  out: Uint8Array,
  view: DataView,
  at: number,
  type: string,
  length: number,
  fill: (start: number) => void,
): number {
  view.setUint32(at, length);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
  fill(at + 8);
  view.setUint32(at + 8 + length, crc32(out, at + 4, at + 8 + length));
  return at + 12 + length;
}
