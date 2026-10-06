// Ported from AssetStudio/Classes/SpriteAtlas.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import type { Rectf } from "./Font.js";
import type { Vector2 } from "./Material.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import {
  assumingLayout,
  endOfObject,
  isPatchFrom,
  layoutVersion,
  readArray,
  readBlendShapeData,
  readBone,
  readGUID,
  readMatrix,
  readRectf,
  readSecondaryTextures,
  readSubMesh,
  readVector2,
  readVector4,
  readVertexData,
  type BlendShapeData,
  type GUID,
  type Matrix4x4,
  type SecondarySpriteTexture,
  type SpriteBone,
  type SubMesh,
  type Vector4,
  type VertexData,
} from "./Sprite.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/**
 * A packed sprite as a Unity 6000.6 atlas holds it (Unity's
 * `SpriteInstanceData`): what its `Sprite` object held, which a 6000.6 bundle
 * no longer needs to contain. Keys as `readTypeTree()` gives them.
 */
export interface SpriteInstanceData {
  /** The sprite's name (its `m_Name`). */
  spriteName: string;
  /** The sprite's area in its source texture, in pixels from the bottom-left corner. */
  rect: Rectf;
  /** The 9-slice border, left, bottom, right, top. */
  border: Vector4;
  pivot: Vector2;
  pixelsToUnits: number;
  /** Unity's `IndexFormat` of `m_IndexBuffer`: 0 is `UInt16`, 1 is `UInt32`. */
  m_IndexFormat: number;
  m_SubMeshes: SubMesh[];
  /** The indices, as `m_IndexFormat` says: a view into the object's bytes (R7). */
  m_IndexBuffer: Uint8Array;
  m_VertexData: VertexData;
  m_Bindpose: Matrix4x4[];
  m_BlendShapes: BlendShapeData;
  spriteBones: SpriteBone[];
  /** One outline per shape, in units. */
  physicsShape: Vector2[][];
}

/**
 * Where one packed sprite sits in its atlas (Unity's `SpriteAtlasData`): the
 * fields of a sprite's `m_RD` that packing changes and, from Unity 6000.6,
 * the sprite itself.
 */
export interface SpriteAtlasData {
  texture: PPtr;
  alphaTexture: PPtr;
  /** The sprite's area in `texture`, in pixels from its bottom-left corner. */
  textureRect: Rectf;
  textureRectOffset: Vector2;
  /** Unity 2017.1.1p1 and later. */
  atlasRectOffset?: Vector2;
  uvTransform: Vector4;
  downscaleMultiplier: number;
  /** As a sprite's `m_RD.settingsRaw`. */
  settingsRaw: number;
  /** Unity 2020.2 and later. */
  secondaryTextures?: SecondarySpriteTexture[];
  /**
   * Unity 6000.6 and later: the packed sprite. The key keeps the `*` of
   * Unity's field name (a `SpriteInstanceData *`), as `readTypeTree()` gives it.
   */
  "*spriteInstanceData"?: SpriteInstanceData;
}

/**
 * The fields of a `SpriteAtlas`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object, map entries and pairs as `[first, second]` arrays as it
 * gives them.
 */
export interface SpriteAtlas extends NamedObject {
  /** Before Unity 6000.6. */
  m_PackedSprites?: PPtr[];
  /** Before Unity 6000.6: the names of `m_PackedSprites`, in the same order. */
  m_PackedSpriteNamesToIndex?: string[];
  /** A packed sprite's `m_RenderDataKey` to where it sits in the atlas. */
  m_RenderDataMap: [[GUID, bigint], SpriteAtlasData][];
  m_Tag: string;
  m_IsVariant: boolean;
  /** Unity 6000.5 and later. */
  m_Guid?: GUID;
}

/**
 * Read a `SpriteAtlas` from the object's first byte: every field Unity's own
 * player type trees give for its version (as UnityPy's TPK data records
 * them), in their order, so the object is consumed to its last byte; it must
 * end exactly there.
 *
 * Where TPK and upstream disagree, TPK's gates are taken: `atlasRectOffset`
 * from 2017.1.1p1 (upstream: 2017.2), and `m_Guid` from 6000.5, which
 * upstream does not read. Unity 6000.6 drops `m_PackedSprites` and
 * `m_PackedSpriteNamesToIndex` and embeds the packed sprite (its name, rect,
 * border, pivot, mesh, bones and physics shape) in every `m_RenderDataMap`
 * entry, as `*spriteInstanceData`. Upstream has no such layout; this one is
 * Unity's own type tree, as 6000.6.4f1 writes it into its bundles and as TPK
 * records it.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`) is read as 2019 when
 * its format is 18 to 21, which only 2019 writes, and refused otherwise, as
 * `readSprite` does (rule for version-stripped files, #36, as amended).
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), except
 * the 2017.1 patch-release gate. 2017.2.0b2 to b8 lack `atlasRectOffset`, and
 * 6000.6.0a1 and a2 still have 6000.5's layout (TPK: 6000.6.0a3 changed it);
 * such a pre-release fails the end-of-object check with a CorruptError.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: when the version is unknown (`[0, 0, 0, 0]`)
 *   unless the format is 18 to 21, and in those formats when the fields after
 *   `m_Name` do not fit 2019's layout; or older than 2017.1, which had no
 *   sprite atlases. Of kind `"build target"` for an editor file
 *   (`BuildTarget.NoTarget`), which stores the atlas' editor settings in
 *   between
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field, with the version known; with it unknown, only inside `m_Name`
 */
export function readSpriteAtlas(reader: ObjectReader): SpriteAtlas {
  const version = layoutVersion(reader, "SpriteAtlas", 2017, 1);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<SpriteAtlas> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "SpriteAtlas", () => readAtlasFields(reader, version, out));
  // Every required field was set above.
  return out as SpriteAtlas;
}

/** Every field of a `SpriteAtlas` after `m_Name`, and the end-of-object check. */
function readAtlasFields(
  reader: ObjectReader,
  version: UnityVersion,
  out: Partial<SpriteAtlas>,
): void {
  // Before 6000.6, which holds the packed sprites in m_RenderDataMap instead.
  if (!atLeast(version, 6000, 6)) {
    out.m_PackedSprites = readArray(reader, "SpriteAtlas", "m_PackedSprites", readPPtr);
    out.m_PackedSpriteNamesToIndex = readArray(
      reader,
      "SpriteAtlas",
      "m_PackedSpriteNamesToIndex",
      (r) => readStringField(r, "SpriteAtlas", "m_PackedSpriteNamesToIndex name"),
    );
  }
  out.m_RenderDataMap = readArray(reader, "SpriteAtlas", "m_RenderDataMap", (r) => [
    [readGUID(r), r.readInt64()],
    readSpriteAtlasData(r, version),
  ]);
  out.m_Tag = readStringField(reader, "SpriteAtlas", "m_Tag");
  out.m_IsVariant = reader.readUInt8() !== 0;
  reader.align();
  if (atLeast(version, 6000, 5)) out.m_Guid = readGUID(reader);
  endOfObject(reader, "SpriteAtlas");
}

/** Upstream `SpriteAtlasData(ObjectReader)`, with the fields TPK adds. */
function readSpriteAtlasData(reader: ObjectReader, version: UnityVersion): SpriteAtlasData {
  const out: Partial<SpriteAtlasData> = {
    texture: readPPtr(reader),
    alphaTexture: readPPtr(reader),
    textureRect: readRectf(reader),
    textureRectOffset: readVector2(reader),
  };
  // 2017.1.1p1+ (TPK; upstream reads it from 2017.2 only).
  if (atLeast(version, 2017, 1, 2) || isPatchFrom(reader, 2017, 1, 1, 1)) {
    out.atlasRectOffset = readVector2(reader);
  }
  out.uvTransform = readVector4(reader);
  out.downscaleMultiplier = reader.readFloat32();
  out.settingsRaw = reader.readUInt32();
  // 2020.2+.
  if (atLeast(version, 2020, 2)) {
    out.secondaryTextures = readSecondaryTextures(reader, "SpriteAtlas");
    reader.align();
  }
  // 6000.6+ (TPK: from 6000.6.0a3).
  if (atLeast(version, 6000, 6)) out["*spriteInstanceData"] = readInstanceData(reader, version);
  return out as SpriteAtlasData;
}

/**
 * Unity 6000.6's `SpriteInstanceData`: a `Sprite`'s own fields, then its
 * `m_RD` mesh (`m_IndexFormat` first, no `m_CurrentChannels`), its bones and
 * its physics shape, aligned as in a `Sprite`.
 */
function readInstanceData(reader: ObjectReader, version: UnityVersion): SpriteInstanceData {
  const owner = "SpriteAtlas";
  const out: Partial<SpriteInstanceData> = {
    spriteName: readStringField(reader, owner, "spriteName"),
    rect: readRectf(reader),
    border: readVector4(reader),
    pivot: readVector2(reader),
    pixelsToUnits: reader.readFloat32(),
    m_IndexFormat: reader.readInt32(),
    m_SubMeshes: readArray(reader, owner, "m_SubMeshes", (r) => readSubMesh(r, version)),
  };
  const indexBytes = readCount(reader, `${owner} ${reader.pathId} m_IndexBuffer byte`);
  out.m_IndexBuffer = reader.readBytes(indexBytes);
  reader.align();
  out.m_VertexData = readVertexData(reader, version, owner);
  out.m_Bindpose = readArray(reader, owner, "m_Bindpose", readMatrix);
  out.m_BlendShapes = readBlendShapeData(reader, version, owner);
  out.spriteBones = readArray(reader, owner, "spriteBones", (r) =>
    readBone(r, version, owner, "spriteBones"),
  );
  out.physicsShape = readArray(reader, owner, "physicsShape", (r) =>
    readArray(r, owner, "physicsShape outline", readVector2),
  );
  return out as SpriteInstanceData;
}
