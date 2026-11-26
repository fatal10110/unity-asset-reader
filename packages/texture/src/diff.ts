import type { Asset, DiffEntry } from "unity-asset-reader";
import type { RgbaImage } from "./convert.js";
import { decodeImage, imageInfo } from "./image.js";
import type { DecodeImageOptions } from "./image.js";

/** {@link diffTexture}'s result when both sides have the same size: their pixels compared. */
export interface TexturePixelDiff {
  sizeChanged: false;
  /** Width of both sides, in pixels. */
  width: number;
  /** Height of both sides, in pixels. */
  height: number;
  /** Pixels whose decoded RGBA differs in at least one channel. */
  changedPixels: number;
  /** {@link changedPixels} over `width * height`, from 0 to 1; 0 for an empty texture. */
  changedShare: number;
  /**
   * The changed pixels, top row first: opaque red (255, 0, 0, 255) where a
   * pixel changed, transparent black (0, 0, 0, 0) where it did not.
   */
  image: RgbaImage;
}

/**
 * {@link diffTexture}'s result when the two sides differ in width or height:
 * the sizes only, no pixels compared and none decoded.
 */
export interface TextureSizeChange {
  sizeChanged: true;
  /** Size of the old side. */
  before: { width: number; height: number };
  /** Size of the new side. */
  after: { width: number; height: number };
}

/** What {@link diffTexture} returns; `sizeChanged` tells the two apart. */
export type TextureDiff = TexturePixelDiff | TextureSizeChange;

/**
 * Compare the pixels of a Texture2D in two builds: a `"modified"` Texture2D
 * entry of core's `diff()`, or its two sides given as assets (also for a
 * texture `diff()` does not list). Both sides' first mip level is decoded to
 * RGBA8 (`decodeImage`) and compared pixel by pixel; a pixel changed when any
 * of its four decoded bytes differ, so a format change that decodes to the
 * same RGBA (RGB24 to an opaque RGBA32) changes nothing.
 *
 * When the width or height differs, nothing is decoded or compared: the
 * result is a {@link TextureSizeChange} with both sizes.
 *
 * The WASM decoder is loaded on first use, as `decodeImage` loads it.
 *
 * @param entry a `diff()` entry with `change: "modified"` and `type: "Texture2D"`
 * @param options WASM location and an optional caller-owned decoded texture map
 * @returns a {@link TexturePixelDiff}, or a {@link TextureSizeChange} when the sizes differ
 * @throws {TypeError} when `entry` is not a modified Texture2D entry, or an
 *   asset is not a Texture2D
 * @throws what `decodeImage` throws for either side (R9): an unsupported
 *   format, a `.resS` that is not loaded, data that does not hold together
 * @example
 * for (const entry of diff(oldEnv, newEnv)) {
 *   if (entry.change !== "modified" || entry.type !== "Texture2D") continue;
 *   const result = await diffTexture(entry);
 *   if (!result.sizeChanged) console.log(entry.path, result.changedShare);
 * }
 */
export async function diffTexture(
  entry: DiffEntry,
  options?: DecodeImageOptions,
): Promise<TextureDiff>;
/**
 * Compare the pixels of a Texture2D in two builds, given as its old and new
 * asset. Same comparison and result as the {@link DiffEntry} form.
 *
 * @param before the texture in the old build
 * @param after the texture in the new build
 * @param options WASM location and an optional caller-owned decoded texture map
 * @throws {TypeError} when `before` or `after` is not a Texture2D asset
 */
export async function diffTexture(
  before: Asset<"Texture2D">,
  after: Asset<"Texture2D">,
  options?: DecodeImageOptions,
): Promise<TextureDiff>;
export async function diffTexture(
  first: DiffEntry | Asset<"Texture2D">,
  second?: Asset<"Texture2D"> | DecodeImageOptions,
  third?: DecodeImageOptions,
): Promise<TextureDiff> {
  let before: unknown;
  let after: unknown;
  let options: DecodeImageOptions | undefined;
  if (first !== null && typeof first === "object" && "change" in first) {
    const entry = first;
    if (entry.change !== "modified" || entry.type !== "Texture2D") {
      throw new TypeError(
        `diffTexture: expected a modified Texture2D entry, got ${entry.change} ${entry.type}`,
      );
    }
    before = entry.before;
    after = entry.after;
    options = second as DecodeImageOptions | undefined;
  } else {
    before = first;
    after = second;
    options = third;
  }
  const old = checkTexture(before, "before");
  const now = checkTexture(after, "after");

  // Sizes from the object fields: no WASM, no image data read.
  const a = imageInfo(old);
  const b = imageInfo(now);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sizeChanged: true,
      before: { width: a.width, height: a.height },
      after: { width: b.width, height: b.height },
    };
  }

  const x = (await decodeImage(old, options)).rgba;
  const y = (await decodeImage(now, options)).rgba;
  const { width, height } = a;
  const data = new Uint8Array(width * height * 4);
  let changedPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2] || x[i + 3] !== y[i + 3]) {
      data[i] = 255;
      data[i + 3] = 255;
      changedPixels++;
    }
  }
  const total = width * height;
  return {
    sizeChanged: false,
    width,
    height,
    changedPixels,
    changedShare: total === 0 ? 0 : changedPixels / total,
    image: { data, width, height },
  };
}

/** `asset` is checked at run time: a JavaScript caller's type is only a claim. */
function checkTexture(asset: unknown, side: string): Asset<"Texture2D"> {
  const { type, typeName } = (asset ?? {}) as { type?: unknown; typeName?: unknown };
  if (type === "Texture2D") return asset as Asset<"Texture2D">;
  const got = typeName === undefined ? String(asset) : `an asset of class ${String(typeName)}`;
  throw new TypeError(`diffTexture: expected a Texture2D asset as ${side}, got ${got}`);
}
