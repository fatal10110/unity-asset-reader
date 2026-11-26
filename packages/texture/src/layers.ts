// Cubemap faces, Texture2DArray slices and Texture3D depth slices to RGBA8
// (#331). No upstream decodes them past level 0 of an array slice (UnityPy),
// so the layouts here are the ones the Unity editor's own pixels confirm
// (fixtures/BUILDING.md section 32): each face or slice is a Texture2D for
// `decodeTexture2D`.

import {
  BuildTarget,
  CorruptError,
  TextureFormat,
  UnsupportedError,
  textureFormatOfGraphicsFormat,
} from "unity-asset-reader";
import type { CubemapData, Texture2DArrayData, Texture3DData } from "unity-asset-reader";

import type { RgbaImage } from "./convert.js";
import { decodeTexture2D, levelLayout } from "./decode.js";

/** Options of {@link decodeCubemap}, {@link decodeTexture2DArray} and {@link decodeTexture3D}. */
export interface DecodeLayersOptions {
  /**
   * The mip level to decode: 0, the default, is the full size; level `n` is
   * each side halved `n` times, down to 1 (for a Texture3D its depth too). It
   * must be below `m_MipCount`.
   */
  mip?: number;
}

/**
 * Decode the six faces of a Cubemap to RGBA8, at one mip level.
 *
 * The faces come in Unity's `CubemapFace` order: +X, -X, +Y, -Y, +Z, -Z.
 * Each face is decoded as `decodeTexture2D` decodes a Texture2D: top row
 * first, RGBA.
 *
 * @param cubemap what `obj.read()` returns for a Cubemap
 * @param options the mip level; see {@link DecodeLayersOptions}
 * @returns six new RGBA images, each `width * height * 4` bytes, top row first
 * @throws {Error} before `initTexture` has finished
 * @throws {TypeError} when `options` or `options.mip` has the wrong type
 * @throws {RangeError} when `options.mip` is not a whole number below the mip count
 * @throws {UnsupportedError} what `decodeTexture2D` throws for the format;
 *   for a Crunch format (kind `"texture format"`: no fixture shows how a
 *   Crunch cubemap stores its faces); and for a Switch, Xbox 360, PS4 or PS5
 *   build (kind `"texture platform"`: no upstream reads their console layout
 *   of a cubemap)
 * @throws {CorruptError} when the image data does not split into six faces,
 *   or a face is shorter than its levels need
 * @example
 * await initTexture();
 * const [px, nx, py, ny, pz, nz] = await decodeCubemap(obj.read());
 */
export async function decodeCubemap(
  cubemap: CubemapData,
  options: DecodeLayersOptions = {},
): Promise<RgbaImage[]> {
  const mip = checkMip("decodeCubemap", options, cubemap.m_MipCount ?? 1);
  refusePlatform(cubemap.platform, "Cubemap");
  if (CRUNCH.has(cubemap.m_TextureFormat)) {
    throw new UnsupportedError(
      "texture format",
      cubemap.m_TextureFormat,
      "a Crunch Cubemap: no fixture shows how it stores its faces",
    );
  }
  const faces = split(cubemap.imageData, 6, "Cubemap", "faces");
  const out: RgbaImage[] = [];
  for (const face of faces) {
    out.push(await decodeTexture2D({ ...cubemap, imageData: face }, { mip }));
  }
  return out;
}

/**
 * Decode every slice of a Texture2DArray to RGBA8, at one mip level, in
 * slice order. Each slice is decoded as `decodeTexture2D` decodes a
 * Texture2D: top row first, RGBA.
 *
 * @param array what `obj.read()` returns for a Texture2DArray
 * @param options the mip level; see {@link DecodeLayersOptions}
 * @returns `m_Depth` new RGBA images, each `width * height * 4` bytes, top row first
 * @throws {Error} before `initTexture` has finished
 * @throws {TypeError} when `options` or `options.mip` has the wrong type
 * @throws {RangeError} when `options.mip` is not a whole number below the mip count
 * @throws {UnsupportedError} for an `m_Format` `textureFormatOfGraphicsFormat`
 *   refuses (kind `"graphics format"`), and for a Switch, Xbox 360, PS4 or PS5
 *   build (kind `"texture platform"`)
 * @throws {CorruptError} when the image data does not split into `m_Depth`
 *   slices, or a slice is shorter than its levels need
 * @example
 * await initTexture();
 * const slices = await decodeTexture2DArray(obj.read(), { mip: 1 });
 */
export async function decodeTexture2DArray(
  array: Texture2DArrayData,
  options: DecodeLayersOptions = {},
): Promise<RgbaImage[]> {
  const mip = checkMip("decodeTexture2DArray", options, array.m_MipCount);
  refusePlatform(array.platform, "Texture2DArray");
  const format = textureFormatOfGraphicsFormat(array.m_Format);
  const out: RgbaImage[] = [];
  for (const slice of split(array.imageData, array.m_Depth, "Texture2DArray", "slices")) {
    const texture = {
      m_Width: array.m_Width,
      m_Height: array.m_Height,
      m_TextureFormat: format,
      m_MipCount: array.m_MipCount,
      imageData: slice,
    };
    out.push(await decodeTexture2D(texture, { mip }));
  }
  return out;
}

/**
 * Decode the depth slices of one mip level of a Texture3D to RGBA8, front to
 * back. Level `n` is `max(1, m_Depth >> n)` slices deep. Each slice is
 * decoded as `decodeTexture2D` decodes a Texture2D: top row first, RGBA.
 *
 * @param texture what `obj.read()` returns for a Texture3D
 * @param options the mip level; see {@link DecodeLayersOptions}
 * @returns the level's depth slices, new RGBA images of
 *   `width * height * 4` bytes each, top row first
 * @throws {Error} before `initTexture` has finished
 * @throws {TypeError} when `options` or `options.mip` has the wrong type
 * @throws {RangeError} when `options.mip` is not a whole number below the mip count
 * @throws {UnsupportedError} as {@link decodeTexture2DArray}
 * @throws {CorruptError} when the size is not a positive whole number, or the
 *   image data is shorter than the levels up to and including `options.mip`
 * @example
 * await initTexture();
 * const slices = await decodeTexture3D(obj.read());
 */
export async function decodeTexture3D(
  texture: Texture3DData,
  options: DecodeLayersOptions = {},
): Promise<RgbaImage[]> {
  const mip = checkMip("decodeTexture3D", options, texture.m_MipCount);
  refusePlatform(texture.platform, "Texture3D");
  const format = textureFormatOfGraphicsFormat(texture.m_Format);
  const { m_Width: width, m_Height: height, m_Depth: depth, imageData } = texture;
  for (const side of [width, height, depth]) {
    if (!Number.isInteger(side) || side < 1) {
      throw new CorruptError(
        `Texture3D size ${width} x ${height} x ${depth} is not a positive whole number size`,
      );
    }
  }
  // Levels are stored largest first, each with all its depth slices.
  let offset = 0;
  for (let n = 0; n < mip; n++) {
    offset += levelLayout(format, width, height, n).bytes * sideOf(depth, n);
  }
  const level = levelLayout(format, width, height, mip);
  const slices = sideOf(depth, mip);
  const end = offset + level.bytes * slices;
  if (imageData.length < end) {
    throw new CorruptError(
      `Texture3D image data is ${imageData.length} bytes, mip level ${mip} ` +
        `(${level.width} x ${level.height} x ${slices}) of ${width} x ${height} x ${depth} ` +
        `ends at byte ${end}`,
    );
  }
  const out: RgbaImage[] = [];
  for (let z = 0; z < slices; z++) {
    const from = offset + z * level.bytes;
    const slice = {
      m_Width: level.width,
      m_Height: level.height,
      m_TextureFormat: format,
      imageData: imageData.subarray(from, from + level.bytes),
    };
    out.push(await decodeTexture2D(slice));
  }
  return out;
}

/** The Crunch formats: their decoder unpacks level 0 of one image only. */
const CRUNCH: ReadonlySet<number> = new Set([
  TextureFormat.DXT1Crunched,
  TextureFormat.DXT5Crunched,
  TextureFormat.ETC_RGB4Crunched,
  TextureFormat.ETC2_RGBA8Crunched,
]);

/** A side of level `n`: halved `n` times, rounding down, but not below 1. */
function sideOf(size: number, n: number): number {
  return Math.max(1, Math.floor(size / 2 ** n));
}

/** `options.mip`, checked: a whole number from 0, below `mipCount`. */
function checkMip(caller: string, options: unknown, mipCount: number): number {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${caller}: options must be an object (${String(options)})`);
  }
  const { mip = 0 } = options as { mip?: unknown };
  if (typeof mip !== "number") {
    throw new TypeError(`${caller}: options.mip must be a number (${typeof mip})`);
  }
  if (!Number.isInteger(mip) || mip < 0) {
    throw new RangeError(`${caller}: options.mip must be a whole number from 0 (${mip})`);
  }
  if (mip > 0 && mip >= mipCount) {
    throw new RangeError(
      `${caller}: options.mip is ${mip}, but the texture has ${mipCount} mip ` +
        `level${mipCount === 1 ? "" : "s"}`,
    );
  }
  return mip;
}

/**
 * Refuse the console builds whose image data is swizzled or tiled: no upstream
 * reads their layout of a cubemap, array or volume.
 */
function refusePlatform(platform: BuildTarget, owner: string): void {
  const names: Partial<Record<number, string>> = {
    [BuildTarget.Switch]: "Switch",
    [BuildTarget.XBOX360]: "Xbox 360",
    [BuildTarget.PS4]: "PS4",
    [BuildTarget.PS5]: "PS5",
  };
  const name = names[platform];
  if (name !== undefined) {
    throw new UnsupportedError(
      "texture platform",
      platform,
      `a ${name} ${owner}: no upstream reads its console layout`,
    );
  }
}

/** `data` cut into `count` equal parts, views (R7). */
function split(data: Uint8Array, count: number, owner: string, what: string): Uint8Array[] {
  if (!Number.isInteger(count) || count < 1 || data.length % count !== 0) {
    throw new CorruptError(
      `${owner} image data is ${data.length} bytes, which does not split into ${count} ${what}`,
    );
  }
  const size = data.length / count;
  return Array.from({ length: count }, (_, i) => data.subarray(i * size, (i + 1) * size));
}
