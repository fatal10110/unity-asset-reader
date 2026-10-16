// PNG writer for RGBA8 images (#234), written from the PNG specification
// (ISO/IEC 15948, W3C PNG 2nd edition) and RFC 1950 / RFC 1951, not ported:
// AssetStudio hands its images to ImageSharp, whose encoder is not followed here.

import type { RgbaImage } from "./convert.js";

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

let crcTable: Uint32Array | undefined;

/**
 * Encode an RGBA8 image as a PNG file: 8-bit RGBA (colour type 6), not
 * interlaced, every row with filter type 0 (None), in one `IDAT` chunk whose
 * zlib stream holds stored (uncompressed) deflate blocks. Sync, with no
 * dependency, so it runs the same in browsers, Workers and Node.js; the cost
 * is size: the file is about as large as the pixels (`width * height * 4`
 * bytes plus one byte a row and 5 bytes per 64 KiB). Recompress it with an
 * image tool if size matters.
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
  if (!(data instanceof Uint8Array)) {
    const value = data as unknown;
    const got =
      typeof value === "object" && value !== null
        ? (value.constructor?.name ?? "object")
        : String(value);
    throw new TypeError(`encodePng: image.data must be a Uint8Array, got ${got}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new TypeError(`encodePng: image size ${width} x ${height} is not an integer size`);
  }
  if (width < 1 || height < 1 || width > PNG_MAX || height > PNG_MAX) {
    throw new RangeError(
      `encodePng: image size ${width} x ${height} is outside 1 to ${PNG_MAX} pixels a side`,
    );
  }
  const stride = width * 4;
  if (data.length !== stride * height) {
    throw new RangeError(
      `encodePng: image data is ${data.length} bytes, ${width} x ${height} RGBA needs ` +
        `${stride * height}`,
    );
  }

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

  at = chunk(out, view, at, "IDAT", idatLength, (start) => {
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

  chunk(out, view, at, "IEND", 0, () => {});
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

/** CRC-32 (ISO 3309, polynomial 0xEDB88320 reflected) of `bytes[start..end)`, as PNG uses. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  const table = (crcTable ??= makeCrcTable());
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
