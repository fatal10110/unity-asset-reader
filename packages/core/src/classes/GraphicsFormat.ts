// Ported from UnityPy/enums/GraphicsFormat.py (MIT, © K0lb3)

import { UnsupportedError } from "../errors.js";
import { TextureFormat } from "./TextureFormat.js";

/**
 * The `GraphicsFormat` values (`m_Format` of a `Texture2DArray` or
 * `Texture3D`) this library decodes, by the value the file holds: only those
 * a fixture holds, each checked against the Unity editor's own pixels
 * (fixtures/BUILDING.md section 32). Every other value is refused, since
 * UnityPy, which maps them all, calls its map experimental and untested.
 *
 * @example
 * if (array.m_Format === GraphicsFormat.RGBA_BC7_UNorm) ...
 */
export const GraphicsFormat = {
  R8G8B8A8_SRGB: 4,
  R8G8B8A8_UNorm: 8,
  RGBA_DXT1_SRGB: 96,
  RGBA_DXT1_UNorm: 97,
  RGBA_BC7_SRGB: 108,
  RGBA_BC7_UNorm: 109,
  RGBA_ETC2_SRGB: 123,
  RGBA_ETC2_UNorm: 124,
  RGBA_ASTC4X4_SRGB: 129,
  RGBA_ASTC4X4_UNorm: 130,
} as const;

/** A {@link GraphicsFormat} value. */
export type GraphicsFormat = (typeof GraphicsFormat)[keyof typeof GraphicsFormat];

// UnityPy's GRAPHICS_TO_TEXTURE_MAP, cut to the verified entries. The sRGB and
// UNorm forms hold the same bytes; sRGB only tells the GPU to linearize them.
// UnityPy maps ASTC 4x4 to ASTC_RGBA_4x4 (54); the editor itself reports
// these textures as ASTC_4x4 (48, upstream's ASTC_RGB_4x4), the same blocks.
const TO_TEXTURE_FORMAT: ReadonlyMap<number, TextureFormat> = new Map<number, TextureFormat>([
  [GraphicsFormat.R8G8B8A8_SRGB, TextureFormat.RGBA32],
  [GraphicsFormat.R8G8B8A8_UNorm, TextureFormat.RGBA32],
  [GraphicsFormat.RGBA_DXT1_SRGB, TextureFormat.DXT1],
  [GraphicsFormat.RGBA_DXT1_UNorm, TextureFormat.DXT1],
  [GraphicsFormat.RGBA_BC7_SRGB, TextureFormat.BC7],
  [GraphicsFormat.RGBA_BC7_UNorm, TextureFormat.BC7],
  [GraphicsFormat.RGBA_ETC2_SRGB, TextureFormat.ETC2_RGBA8],
  [GraphicsFormat.RGBA_ETC2_UNorm, TextureFormat.ETC2_RGBA8],
  [GraphicsFormat.RGBA_ASTC4X4_SRGB, TextureFormat.ASTC_RGB_4x4],
  [GraphicsFormat.RGBA_ASTC4X4_UNorm, TextureFormat.ASTC_RGB_4x4],
]);

/**
 * The `TextureFormat` whose blocks a `GraphicsFormat` holds, for decoding a
 * `Texture2DArray` or `Texture3D` (whose `m_Format` is a `GraphicsFormat`).
 *
 * @param format the `m_Format` value
 * @returns the `TextureFormat` with the same bytes per pixel or block
 * @throws {UnsupportedError} of kind `"graphics format"` for a value not in
 *   {@link GraphicsFormat}: no fixture checks it (R9)
 * @example
 * textureFormatOfGraphicsFormat(GraphicsFormat.RGBA_DXT1_UNorm); // TextureFormat.DXT1
 */
export function textureFormatOfGraphicsFormat(format: number): TextureFormat {
  const out = TO_TEXTURE_FORMAT.get(format);
  if (out === undefined) {
    throw new UnsupportedError(
      "graphics format",
      format,
      "only the GraphicsFormat values a fixture checks are mapped to a TextureFormat",
    );
  }
  return out;
}
