// No AssetStudio or UnityPy reader to port: AssetStudio has no Cubemap class,
// and UnityPy reads it through a type tree. The layout and its version gates
// are Unity's own player type trees (UnityPy's TPK data,
// fixtures/tpk-trees.json): a Texture2D, then m_SourceTextures (#331).

import { CorruptError, UnsupportedError } from "../errors.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readArray } from "./Sprite.js";
import { readTexture2DFields, type Texture2D } from "./Texture2D.js";
import { atLeast } from "./version.js";

/**
 * The fields of a `Cubemap` (class 89), as a player build stores them, under
 * Unity's names: every `Texture2D` field, then `m_SourceTextures`. The keys,
 * their order and their values agree with `readTypeTree()` on the same object,
 * except that `m_StreamData.offset` is a `number` here.
 *
 * `m_ImageCount` is 6, one image per face, and `m_CompleteImageSize` is the
 * bytes of one face, all its mip levels. The image data holds the faces in
 * Unity's `CubemapFace` order (+X, -X, +Y, -Y, +Z, -Z), each with its own mip
 * levels, largest first, still encoded in `m_TextureFormat`.
 */
export interface Cubemap extends Texture2D {
  /** The textures the cubemap was made from, in the editor; often null pointers. */
  m_SourceTextures: PPtr[];
}

/**
 * Read a `Cubemap` from the object's first byte: the `Texture2D` fields, as
 * `readTexture2D` reads them, then `m_SourceTextures`. Unity 2019.1 and later
 * only, the supported floor.
 *
 * The object must end exactly where `m_SourceTextures` does, so a layout this
 * reader does not know is refused rather than returned half-read.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"` before Unity 2019.1 or
 *   for an unknown version; of kind `"build target"` for an editor file
 * @throws {CorruptError} when the object ends early, a byte count or element
 *   count is negative or runs past its end, `m_StreamData.offset` is 2^53 or
 *   above, or bytes are left over after the last field
 */
export function readCubemap(reader: ObjectReader): Cubemap {
  refuseBefore2019(reader, "Cubemap");
  const out: Partial<Cubemap> & Texture2D = readTexture2DFields(reader, "Cubemap");
  out.m_SourceTextures = readArray(reader, "Cubemap", "m_SourceTextures", readPPtr);
  if (reader.remaining !== 0) {
    throw new CorruptError(
      `Cubemap ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  return out as Cubemap;
}

/**
 * Refuse a file older than Unity 2019.1, the supported floor, for the texture
 * readers that start there. An unknown version is left to `readTexture`,
 * which refuses it. Internal: shared with `Texture2DArray.ts`.
 *
 * @throws {UnsupportedError} of kind `"Unity version"`
 */
export function refuseBefore2019(reader: ObjectReader, owner: string): void {
  const stripped = reader.version.every((part) => part === 0);
  if (!stripped && !atLeast(reader.version, 2019, 1)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: the ${owner} reader reads Unity 2019.1 and later, the ` +
        "supported floor; readTypeTree() reads an older one",
    );
  }
}
