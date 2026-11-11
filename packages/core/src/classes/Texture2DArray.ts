// No AssetStudio or UnityPy reader to port: AssetStudio has neither class, and
// UnityPy reads them through type trees. The layouts and their version gates
// are Unity's own player type trees (UnityPy's TPK data,
// fixtures/tpk-trees.json), from Unity 2019.1, the supported floor (#331).

import { CorruptError } from "../errors.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { refuseBefore2019 } from "./Cubemap.js";
import { readStringField } from "./strings.js";
import { readTexture, type Texture } from "./Texture.js";
import {
  readBool,
  readStreamingInfo,
  readTextureSettings,
  type GLTextureSettings,
  type StreamingInfo,
} from "./Texture2D.js";
import { atLeast } from "./version.js";

/**
 * The fields of a `Texture3D` (class 117), as a player build stores them,
 * under Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object, except that `m_StreamData.offset` is
 * a `number` here.
 *
 * The image data holds the mip levels largest first. Level `n` is
 * `max(1, m_Width >> n)` by `max(1, m_Height >> n)` pixels and
 * `max(1, m_Depth >> n)` slices deep, its slices one after another, each a
 * 2D image in whole blocks of the format.
 */
export interface Texture3D extends Texture {
  m_ColorSpace: number;
  /**
   * A `GraphicsFormat` value, not a `TextureFormat`: see
   * `textureFormatOfGraphicsFormat`.
   */
  m_Format: number;
  m_Width: number;
  m_Height: number;
  m_Depth: number;
  m_MipCount: number;
  /** Bytes of image data, all mip levels. */
  m_DataSize: number;
  m_TextureSettings: GLTextureSettings;
  /** Unity 2020.2 and later. */
  m_UsageMode?: number;
  m_IsReadable: boolean;
  /**
   * The inline image data, a view into the object's bytes (R7); empty when the
   * data is in a resource file (see `m_StreamData`).
   */
  "image data": Uint8Array;
  m_StreamData: StreamingInfo;
}

/**
 * The fields of a `Texture2DArray` (class 187), as a player build stores
 * them, under Unity's names, as {@link Texture3D}'s are, plus the mipmap
 * limit fields of Unity 2023.2.
 *
 * `m_Depth` is the number of slices. The image data holds the slices one
 * after another, each with its own mip levels, largest first, so each slice
 * is `m_DataSize / m_Depth` bytes.
 */
export interface Texture2DArray extends Texture3D {
  /** Unity 2023.2 and later. */
  m_MipsStripped?: number;
  /** Unity 2023.2 and later. */
  m_IgnoreMipmapLimit?: boolean;
  /** Unity 2023.2 and later. */
  m_MipmapLimitGroupName?: string;
}

/**
 * Read a `Texture3D` from the object's first byte, every field through
 * `m_StreamData`. Unity 2019.1 and later only, the supported floor.
 *
 * The object must end exactly where `m_StreamData` does, so a layout this
 * reader does not know is refused rather than returned half-read. The gates
 * compare release numbers only, as `readTexture` explains: an alpha of 2020.2
 * (before `m_UsageMode`) may be misread or refused.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"` before Unity 2019.1 or
 *   for an unknown version; of kind `"build target"` for an editor file
 * @throws {CorruptError} when the object ends early, the `m_Name`,
 *   `image data` or `m_StreamData.path` byte count is negative or runs past
 *   its end, `m_StreamData.offset` is 2^53 or above, or bytes are left over
 *   after the last field
 */
export function readTexture3D(reader: ObjectReader): Texture3D {
  return readLayered(reader, "Texture3D");
}

/**
 * Read a `Texture2DArray` from the object's first byte, every field through
 * `m_StreamData`. Unity 2019.1 and later only, the supported floor; as
 * {@link readTexture3D}, whose layout it shares but for the fields Unity 2023.2
 * added.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} as {@link readTexture3D}
 * @throws {CorruptError} as {@link readTexture3D}, and when the
 *   `m_MipmapLimitGroupName` byte count is negative or runs past the end
 */
export function readTexture2DArray(reader: ObjectReader): Texture2DArray {
  return readLayered(reader, "Texture2DArray");
}

function readLayered(reader: ObjectReader, owner: "Texture3D" | "Texture2DArray"): Texture2DArray {
  refuseBefore2019(reader, owner);
  const base = readTexture(reader);
  const { version } = reader;
  const array = owner === "Texture2DArray";
  const v2023_2 = atLeast(version, 2023, 2);

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Texture2DArray> & Texture = { ...base };
  out.m_ColorSpace = reader.readInt32();
  out.m_Format = reader.readInt32();
  out.m_Width = reader.readInt32();
  out.m_Height = reader.readInt32();
  out.m_Depth = reader.readInt32();
  out.m_MipCount = reader.readInt32();
  // 2023.2+, Texture2DArray only.
  if (array && v2023_2) out.m_MipsStripped = reader.readInt32();
  out.m_DataSize = reader.readUInt32();
  out.m_TextureSettings = readTextureSettings(reader);
  // 2020.2+.
  if (atLeast(version, 2020, 2)) out.m_UsageMode = reader.readInt32();
  out.m_IsReadable = readBool(reader);
  // 2023.2+, Texture2DArray only: the mipmap limit, as Texture2D's of 2022.2.
  if (array && v2023_2) {
    out.m_IgnoreMipmapLimit = readBool(reader);
    reader.align();
    out.m_MipmapLimitGroupName = readStringField(reader, owner, "m_MipmapLimitGroupName");
  }
  reader.align();
  out["image data"] = reader.readBytes(readCount(reader, "image data byte"));
  reader.align();
  out.m_StreamData = readStreamingInfo(reader, owner);
  if (reader.remaining !== 0) {
    throw new CorruptError(
      `${owner} ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as Texture2DArray;
}
