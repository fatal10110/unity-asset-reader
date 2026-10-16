// Ported from AssetStudio/Classes/Mesh.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/AnimationClip.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Math/Vector3.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../errors.js";
import type { ObjectReader, Vector3 } from "../serialized/ObjectReader.js";
import { baseName, type UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import type { Vector2 } from "./Material.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import type { ResourceReader } from "./registry.js";
import {
  assumingLayout,
  endOfObject,
  layoutVersion,
  readArray,
  readMatrix,
  type AABB,
  type BlendShapeData,
  type BlendShapeVertex,
  type BoneWeights4,
  type ChannelInfo,
  type Matrix4x4,
  type SubMesh,
  type Vector4,
} from "./Sprite.js";
import { readStreamingInfo, type StreamingInfo } from "./Texture2D.js";
import { atLeast } from "./version.js";

/** A submesh as Unity 3.4 and 3.5 store it: `isTriStrip` where later ones have `topology`. */
export interface LegacySubMesh {
  firstByte: number;
  indexCount: number;
  /** 0 for a triangle list; anything else a strip. */
  isTriStrip: number;
  triangleCount: number;
  firstVertex: number;
  vertexCount: number;
  localAABB: AABB;
}

/** A blend shape as Unity 4.1 and 4.2 store it (Unity's `MeshBlendShape`). */
export interface LegacyMeshBlendShape {
  name: string;
  firstVertex: number;
  vertexCount: number;
  aabbMinDelta: Vector3;
  aabbMaxDelta: Vector3;
  hasNormals: boolean;
  hasTangents: boolean;
}

/** A vertex stream of Unity 4.x (Unity's `StreamInfo`). */
export interface StreamInfo {
  /** Bit `n` set when channel `n` is in this stream. */
  channelMask: number;
  /** Byte offset of the stream in `m_DataSize`. */
  offset: number;
  /** Bytes per vertex. */
  stride: number;
  dividerOp: number;
  frequency: number;
}

/** A vertex stream of Unity 3.5 (Unity's `StreamInfo`), whose channels are implied by the mask. */
export interface LegacyStreamInfo {
  /** Bit `n` set for channel `n`: position, normal, colour, UV0, UV1, tangent. */
  channelMask: number;
  offset: number;
  stride: number;
  align: number;
}

/**
 * The vertex streams of a mesh (Unity's `VertexData`), Unity 3.5 and later.
 * Unity 5.0 dropped the stream table: the streams follow from `m_Channels`.
 */
export interface MeshVertexData {
  /** Before Unity 2018.1. */
  m_CurrentChannels?: number;
  m_VertexCount: number;
  /** Unity 4.0 and later. */
  m_Channels?: ChannelInfo[];
  /** Unity 4.x. */
  m_Streams?: StreamInfo[];
  /** Unity 3.5: four streams, `"m_Streams[0]"` to `"m_Streams[3]"`. */
  [stream: `m_Streams[${number}]`]: LegacyStreamInfo;
  /** Every stream, one after the other: a view into the object's bytes (R7). */
  m_DataSize: Uint8Array;
}

/** A box by its corners (Unity's `MinMaxAABB`): the bounds of a bone. */
export interface MinMaxAABB {
  m_Min: Vector3;
  m_Max: Vector3;
}

/** The bone weights of a vertex beyond four (Unity's `VariableBoneCountWeights`). */
export interface VariableBoneCountWeights {
  m_Data: number[];
}

/**
 * Floats packed into `m_BitSize` bits each (Unity's `PackedBitVector` with a
 * range): an item `x` stands for `x / (2^m_BitSize - 1) * m_Range + m_Start`.
 */
export interface PackedFloatVector {
  m_NumItems: number;
  m_Range: number;
  m_Start: number;
  /** The packed bits, least significant first: a view into the object's bytes (R7). */
  m_Data: Uint8Array;
  m_BitSize: number;
}

/** Integers packed into `m_BitSize` bits each (Unity's `PackedBitVector` without a range). */
export interface PackedIntVector {
  m_NumItems: number;
  /** The packed bits, least significant first: a view into the object's bytes (R7). */
  m_Data: Uint8Array;
  m_BitSize: number;
}

/**
 * The vertices and indices of a mesh built with mesh compression (Unity's
 * `CompressedMesh`); every vector is empty for an uncompressed one.
 */
export interface CompressedMesh {
  /** Three per vertex. */
  m_Vertices: PackedFloatVector;
  /** The UV channels one after the other, laid out by `m_UVInfo`. */
  m_UV: PackedFloatVector;
  /** Before Unity 5.0: 16 per bind pose. */
  m_BindPoses?: PackedFloatVector;
  /** X and y per vertex; z follows from the length and `m_NormalSigns`. */
  m_Normals: PackedFloatVector;
  /** X and y per vertex; z and w follow from the length and `m_TangentSigns`. */
  m_Tangents: PackedFloatVector;
  /** Bone weights in 31ths, one to four per vertex, as long as they sum below 31. */
  m_Weights: PackedIntVector;
  /** One per vertex: 0 when the normal's z is negative. */
  m_NormalSigns: PackedIntVector;
  /** Two per vertex: the sign of z, then of w. */
  m_TangentSigns: PackedIntVector;
  /** Unity 5.0 and later: four per vertex, RGBA. */
  m_FloatColors?: PackedFloatVector;
  /** One per weight in `m_Weights`, and one for the fourth weight it leaves implicit. */
  m_BoneIndices: PackedIntVector;
  m_Triangles: PackedIntVector;
  /** Unity 3.5 to 4.x: one per vertex, RGBA, a quarter of `m_BitSize` per channel. */
  m_Colors?: PackedIntVector;
  /**
   * Unity 5.0 and later. Four bits per UV channel, channel 0 lowest: bit 2 set
   * when the channel is there, bits 0-1 its dimension minus 1. 0 for UV0 and
   * UV1 of dimension 2.
   */
  m_UVInfo?: number;
}

/** How a mesh picks its level of detail (Unity's `LodSelectionCurve`). */
export interface LodSelectionCurve {
  m_LodSlope: number;
  m_LodBias: number;
}

/** The indices of one level of detail of a submesh (Unity's `MeshLodRange`). */
export interface MeshLodRange {
  m_IndexStart: number;
  m_IndexCount: number;
}

/** The levels of detail of a mesh (Unity's `MeshLodInfo`), Unity 6000.2 and later. */
export interface MeshLodInfo {
  m_LodSelectionCurve: LodSelectionCurve;
  m_NumLevels: number;
  /** One per submesh: its index range at each level. */
  m_SubMeshes: { m_Levels: MeshLodRange[] }[];
}

/**
 * The fields of a `Mesh`, as a player build stores them, under Unity's names:
 * the keys, their order and their values agree with `readTypeTree()` on the
 * same object, except that `m_StreamData.offset` is a `number` here.
 *
 * The vertices are in `m_VertexData` (from Unity 3.5), or, when
 * `m_StreamData.path` is not empty, in `m_StreamData.size` bytes of a resource
 * file; before 3.5 in `m_Vertices` and the arrays after it. A compressed mesh
 * holds them in `m_CompressedMesh` instead. `obj.read()` decodes them
 * ({@link MeshData}).
 */
export interface Mesh extends NamedObject {
  /** Unity 3.4: 1 for `UInt16` indices, 0 for `UInt32`. */
  m_Use16BitIndices?: number;
  /** `LegacySubMesh` in Unity 3.4 and 3.5. */
  m_SubMeshes: (SubMesh | LegacySubMesh)[];
  /** Unity 4.1 and later; a list of shapes in 4.1 and 4.2. */
  m_Shapes?: BlendShapeData | LegacyMeshBlendShape[];
  /** Unity 4.1 and 4.2. */
  m_ShapeVertices?: BlendShapeVertex[];
  m_BindPose: Matrix4x4[];
  /** Unity 4.3 and later. */
  m_BoneNameHashes?: number[];
  /** Unity 4.3 and later. */
  m_RootBoneNameHash?: number;
  /** Unity 2019.1 and later. */
  m_BonesAABB?: MinMaxAABB[];
  /** Unity 2019.1 and later. */
  m_VariableBoneCountWeights?: VariableBoneCountWeights;
  /** 0 off, 1 low, 2 medium, 3 high: whether `m_CompressedMesh` holds the mesh. */
  m_MeshCompression: number;
  /** Unity 4.x. */
  m_StreamCompression?: number;
  /** Unity 4.0 and later. */
  m_IsReadable?: boolean;
  /** Unity 4.0 and later. */
  m_KeepVertices?: boolean;
  /** Unity 4.0 and later. */
  m_KeepIndices?: boolean;
  /** Unity 2017.3 and later (see {@link readMesh}): 0 for `UInt16` indices, 1 for `UInt32`. */
  m_IndexFormat?: number;
  /** The indices of every submesh: a view into the object's bytes (R7). */
  m_IndexBuffer: Uint8Array;
  /** Unity 3.4: positions. */
  m_Vertices?: Vector3[];
  /** Before Unity 2018.2: four bone weights per vertex. */
  m_Skin?: BoneWeights4[];
  /** Unity 3.4. */
  m_UV?: Vector2[];
  /** Unity 3.4. */
  m_UV1?: Vector2[];
  /** Unity 3.4. */
  m_Tangents?: Vector4[];
  /** Unity 3.4. */
  m_Normals?: Vector3[];
  /** Unity 3.5 and later. */
  m_VertexData?: MeshVertexData;
  m_CompressedMesh: CompressedMesh;
  m_LocalAABB: AABB;
  /** Unity 3.4: an `RGBA32` per vertex, packed into a `UInt32`. */
  m_Colors?: { rgba: number }[];
  /** Unity 3.4. */
  m_CollisionTriangles?: number[];
  /** Unity 3.4. */
  m_CollisionVertexCount?: number;
  /** Before Unity 6000.6. */
  m_MeshUsageFlags?: number;
  /** Unity 2022.1 and later. */
  m_CookingOptions?: number;
  /** Unity 6000.6 and later. */
  m_PreBakeConvexCollisionMesh?: boolean;
  /** Unity 6000.6 and later. */
  m_PreBakeTriangleCollisionMesh?: boolean;
  /** Unity 5.0 and later: a view into the object's bytes (R7). */
  m_BakedConvexCollisionMesh?: Uint8Array;
  /** Unity 5.0 and later: a view into the object's bytes (R7). */
  m_BakedTriangleCollisionMesh?: Uint8Array;
  /** Unity 2018.2 and later. */
  "m_MeshMetrics[0]"?: number;
  /** Unity 2018.2 and later. */
  "m_MeshMetrics[1]"?: number;
  /** Unity 2018.3 and later: where the vertex data is when not inline (an empty `path`). */
  m_StreamData?: StreamingInfo;
  /** Unity 6000.2 and later. */
  m_MeshLodInfo?: MeshLodInfo;
}

/** The bones of one vertex and how much each moves it (upstream `BoneWeights4`). */
export interface VertexBoneWeights {
  weight: [number, number, number, number];
  boneIndex: [number, number, number, number];
}

/**
 * A mesh's vertices and triangles, decoded as upstream's `Mesh` does (its
 * `ProcessData`), each field named after upstream's.
 *
 * Vertex attributes are flat, `n` components per vertex, `n` being the
 * channel's dimension (a compressed mesh: 3 per position and normal, 4 per
 * tangent and colour). An attribute the mesh does not have, or stores in an
 * integer format, is absent, as upstream leaves it `null`.
 */
export interface MeshGeometry {
  /**
   * Upstream `m_VertexCount`: `m_VertexData.m_VertexCount` (before 3.5: the
   * number of `m_Vertices`), or for a compressed mesh its vertex count.
   */
  vertexCount: number;
  /** Upstream `m_Vertices`: positions. */
  vertices?: Float32Array;
  /** Upstream `m_Normals`. */
  normals?: Float32Array;
  /** Upstream `m_Tangents`, with the handedness as w. */
  tangents?: Float32Array;
  /** Upstream `m_Colors`: RGBA, 0 to 1. */
  colors?: Float32Array;
  /** Upstream `m_UV0` to `m_UV7`: eight entries, `undefined` where the mesh has no such channel. */
  uv: (Float32Array | undefined)[];
  /** Upstream `m_Skin`: one per vertex, when the mesh has bone weights. */
  skin?: VertexBoneWeights[];
  /**
   * Upstream `m_BindPose` where it differs from the `m_BindPose` field: the
   * bind poses of a compressed mesh before Unity 5.0, unpacked from
   * `m_CompressedMesh.m_BindPoses`. Absent otherwise.
   */
  bindPoses?: Matrix4x4[];
  /**
   * Upstream `m_Indices`, split by submesh: each submesh's triangles, three
   * indices each, with strips and quads turned into triangle lists (strips
   * without their degenerate triangles). As upstream's, the indices are not
   * offset by `baseVertex`.
   */
  indices: Uint32Array[];
}

/**
 * A `Mesh` as `obj.read()` returns it: every field `readMesh` reads, and its
 * vertices and triangles decoded in `geometry`, apart from Unity's fields
 * (whose names a Unity 3.4 mesh's `m_Vertices`, `m_Normals`, ... would
 * otherwise collide with in `asset.data`).
 */
export interface MeshData extends Mesh {
  geometry: MeshGeometry;
}

/** Unity's `GfxPrimitiveType`: how a submesh's indices make up its faces. */
export const GfxPrimitiveType = {
  Triangles: 0,
  TriangleStrip: 1,
  Quads: 2,
  Lines: 3,
  LineStrip: 4,
  Points: 5,
} as const;

/**
 * Read a `Mesh` from the object's first byte: every field Unity's own player
 * type trees give for its version (as UnityPy's TPK data records them), in
 * their order, from Unity 3.4, the first version with type tree data. Nothing
 * is decoded or resolved; `obj.read()` does that ({@link MeshData}).
 *
 * Upstream stops after `m_StreamData`; `m_MeshLodInfo` (6000.2+) is read here
 * so the object is consumed to its last byte, and the object must end exactly
 * there, so a layout this reader does not know is refused rather than
 * returned half-read. Where TPK and upstream disagree, TPK is followed:
 *
 * - 6000.6 drops `m_MeshUsageFlags` and adds `m_PreBakeConvexCollisionMesh`
 *   and `m_PreBakeTriangleCollisionMesh`, which upstream does not know.
 * - A `Vector3f` (a submesh's `localAABB`, a blend shape vertex) is three
 *   floats in every version, as TPK records it and as upstream's own skip of
 *   `m_LocalAABB` (24 bytes) has it; upstream's `ReadVector3` reads four
 *   before 5.4.
 * - Fields keep TPK's names: a 3.x submesh's `isTriStrip`, which upstream
 *   reads as `topology`.
 *
 * One gate is upstream's, not TPK's: `m_IndexFormat`, which TPK has from
 * 2017.3.0b1, is read from 2017.4, from 2017.3.1 patch releases, and in
 * 2017.3 for a mesh without mesh compression (upstream: "Unity fixed it in
 * 2017.3.1p1").
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`, as
 * `AssetBundleStripUnityVersion` leaves it) is read when its format is 18 to
 * 21: only Unity 2019 writes those, and every 2019 release has one Mesh
 * layout, as `readSprite` reads one (rule for version-stripped files, #36, as
 * amended). An object that does not fit that layout is refused as not that
 * layout rather than called corrupt. Any other format allows layouts that
 * differ inside the object, so the file is refused.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). Unity
 * changed this layout in pre-releases (TPK: 2017.1.0b1, 2017.3.0b1,
 * 2018.1.0b2, 2018.2.0b1, 2018.3.0b1, 2019.1.0a10, 2020.1.0a19, 2022.1.0a15,
 * 6000.2.0a8, 6000.6.0a5); an earlier pre-release of those fails the
 * end-of-object check. Compare the build type in the gate if one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 3.4, for an unknown version unless the
 *   format is 18 to 21, and in those formats when the fields after `m_Name`
 *   do not fit 2019's layout. Of kind `"build target"` for an editor file
 *   (`BuildTarget.NoTarget`), which stores editor-only fields in between
 * @throws {CorruptError} when the object ends early, a count or byte length is
 *   negative or runs past its end, `m_StreamData.offset` is 2^53 or above, or
 *   bytes are left over after the last field, with the version known; with it
 *   unknown, only inside `m_Name`
 */
export function readMesh(reader: ObjectReader): Mesh {
  const version = meshVersion(reader);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Mesh> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "Mesh", () => readMeshFields(reader, version, out));
  // Every required field was set above.
  return out as Mesh;
}

/**
 * The version whose layout the object has, as `layoutVersion` decides it,
 * after refusing a version before 3.4, which has no type tree data.
 *
 * @throws {UnsupportedError} as {@link readMesh} documents
 */
function meshVersion(reader: ObjectReader): UnityVersion {
  const { version } = reader;
  if (!version.every((part) => part === 0) && !atLeast(version, 3, 4)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: no known Mesh layout before Unity 3.4, the first with type ` +
        "tree data",
    );
  }
  return layoutVersion(reader, "Mesh", 3, 4);
}

/** Every field of a `Mesh` after `m_Name`, and the end-of-object check. */
function readMeshFields(reader: ObjectReader, version: UnityVersion, out: Partial<Mesh>): void {
  const v = (major: number, minor: number) => atLeast(version, major, minor);
  // Before 3.5.
  if (!v(3, 5)) out.m_Use16BitIndices = reader.readInt32();
  out.m_SubMeshes = readArray(reader, "Mesh", "m_SubMeshes", (r) => readSubMesh(r, version));
  // 4.3+: BlendShapeData; 4.1 and 4.2: a list of shapes and their vertices.
  if (v(4, 3)) out.m_Shapes = readBlendShapeData(reader);
  else if (v(4, 1)) {
    out.m_Shapes = readArray(reader, "Mesh", "m_Shapes", readLegacyShape);
    reader.align();
    out.m_ShapeVertices = readArray(reader, "Mesh", "m_ShapeVertices", (r) =>
      readShapeVertex(r, true),
    );
  }
  if (v(4, 3)) {
    out.m_BindPose = readArray(reader, "Mesh", "m_BindPose", readMatrix);
    out.m_BoneNameHashes = readArray(reader, "Mesh", "m_BoneNameHashes", (r) => r.readUInt32());
    out.m_RootBoneNameHash = reader.readUInt32();
  }
  if (v(2019, 1)) {
    out.m_BonesAABB = readArray(reader, "Mesh", "m_BonesAABB", (r) => ({
      m_Min: readVector3f(r),
      m_Max: readVector3f(r),
    }));
    out.m_VariableBoneCountWeights = {
      m_Data: readArray(reader, "Mesh", "m_VariableBoneCountWeights", (r) => r.readUInt32()),
    };
  }
  out.m_MeshCompression = reader.readUInt8();
  if (v(4, 0)) {
    // 4.x only.
    if (!v(5, 0)) out.m_StreamCompression = reader.readUInt8();
    out.m_IsReadable = readBool(reader);
    out.m_KeepVertices = readBool(reader);
    out.m_KeepIndices = readBool(reader);
  }
  reader.align();
  if (hasIndexFormat(reader, version, out.m_MeshCompression)) {
    out.m_IndexFormat = reader.readInt32();
  }
  out.m_IndexBuffer = readByteArray(reader, "m_IndexBuffer");
  if (!v(3, 5)) {
    // 3.4: the vertices as arrays of their own.
    out.m_Vertices = readArray(reader, "Mesh", "m_Vertices", readVector3f);
    out.m_Skin = readArray(reader, "Mesh", "m_Skin", readBoneWeights);
    out.m_BindPose = readArray(reader, "Mesh", "m_BindPose", readMatrix);
    out.m_UV = readArray(reader, "Mesh", "m_UV", readVector2f);
    out.m_UV1 = readArray(reader, "Mesh", "m_UV1", readVector2f);
    out.m_Tangents = readArray(reader, "Mesh", "m_Tangents", readVector4f);
    out.m_Normals = readArray(reader, "Mesh", "m_Normals", readVector3f);
    reader.align();
  } else {
    // Before 2018.2.
    if (!v(2018, 2)) out.m_Skin = readArray(reader, "Mesh", "m_Skin", readBoneWeights);
    // 3.5 to 4.2; 4.3 moved it before the bone hashes.
    if (!v(4, 3)) out.m_BindPose = readArray(reader, "Mesh", "m_BindPose", readMatrix);
    out.m_VertexData = readVertexData(reader, version);
  }
  out.m_CompressedMesh = readCompressedMesh(reader, version);
  out.m_LocalAABB = readAABB(reader);
  if (!v(3, 5)) {
    out.m_Colors = readArray(reader, "Mesh", "m_Colors", (r) => ({ rgba: r.readUInt32() }));
    out.m_CollisionTriangles = readArray(reader, "Mesh", "m_CollisionTriangles", (r) =>
      r.readUInt32(),
    );
    out.m_CollisionVertexCount = reader.readInt32();
  }
  // Gone in 6000.6 (TPK; upstream reads it throughout).
  if (!v(6000, 6)) out.m_MeshUsageFlags = reader.readInt32();
  if (v(2022, 1)) out.m_CookingOptions = reader.readInt32();
  // 6000.6+ (TPK; upstream does not know them).
  if (v(6000, 6)) {
    out.m_PreBakeConvexCollisionMesh = readBool(reader);
    out.m_PreBakeTriangleCollisionMesh = readBool(reader);
    reader.align();
  }
  if (v(5, 0)) {
    out.m_BakedConvexCollisionMesh = readByteArray(reader, "m_BakedConvexCollisionMesh");
    out.m_BakedTriangleCollisionMesh = readByteArray(reader, "m_BakedTriangleCollisionMesh");
  }
  if (v(2018, 2)) {
    out["m_MeshMetrics[0]"] = reader.readFloat32();
    out["m_MeshMetrics[1]"] = reader.readFloat32();
  }
  if (v(2018, 3)) {
    reader.align();
    out.m_StreamData = readStreamingInfo(reader, "Mesh", version);
  }
  // 6000.2+ (TPK; upstream stops before it).
  if (v(6000, 2)) out.m_MeshLodInfo = readMeshLodInfo(reader);
  endOfObject(reader, "Mesh");
}

/**
 * Whether the object holds `m_IndexFormat`, by upstream's gate: 2017.4 and
 * later, 2017.3.1 patch releases, and 2017.3 without mesh compression.
 */
function hasIndexFormat(reader: ObjectReader, version: UnityVersion, compression = 0): boolean {
  const [major, minor, patch] = version;
  if (atLeast(version, 2017, 4)) return true;
  if (major !== 2017 || minor !== 3) return false;
  return (patch === 1 && reader.buildType === "p") || compression === 0;
}

/** Upstream `SubMesh(ObjectReader)`, from 3.4, with TPK's names. */
function readSubMesh(reader: ObjectReader, version: UnityVersion): SubMesh | LegacySubMesh {
  const firstByte = reader.readUInt32();
  const indexCount = reader.readUInt32();
  if (!atLeast(version, 4, 0)) {
    return {
      firstByte,
      indexCount,
      isTriStrip: reader.readUInt32(),
      triangleCount: reader.readUInt32(),
      firstVertex: reader.readUInt32(),
      vertexCount: reader.readUInt32(),
      localAABB: readAABB(reader),
    };
  }
  const out: Partial<SubMesh> = { firstByte, indexCount, topology: reader.readInt32() };
  // 2017.3+.
  if (atLeast(version, 2017, 3)) out.baseVertex = reader.readUInt32();
  out.firstVertex = reader.readUInt32();
  out.vertexCount = reader.readUInt32();
  out.localAABB = readAABB(reader);
  return out as SubMesh;
}

/** Upstream `BlendShapeData(ObjectReader)`, from 4.3. */
function readBlendShapeData(reader: ObjectReader): BlendShapeData {
  const out: BlendShapeData = {
    vertices: readArray(reader, "Mesh", "m_Shapes vertices", (r) => readShapeVertex(r, false)),
    shapes: readArray(reader, "Mesh", "m_Shapes shapes", (r) => {
      const shape = {
        firstVertex: r.readUInt32(),
        vertexCount: r.readUInt32(),
        hasNormals: readBool(r),
        hasTangents: readBool(r),
      };
      r.align();
      return shape;
    }),
    channels: readArray(reader, "Mesh", "m_Shapes channels", (r) => ({
      name: readStringField(r, "m_Shapes channel name"),
      nameHash: r.readUInt32(),
      frameIndex: r.readInt32(),
      frameCount: r.readInt32(),
    })),
    fullWeights: readArray(reader, "Mesh", "m_Shapes fullWeights", (r) => r.readFloat32()),
  };
  return out;
}

/** Upstream `MeshBlendShape(ObjectReader)` for 4.1 and 4.2. */
function readLegacyShape(reader: ObjectReader): LegacyMeshBlendShape {
  return {
    name: readStringField(reader, "m_Shapes name"),
    firstVertex: reader.readUInt32(),
    vertexCount: reader.readUInt32(),
    aabbMinDelta: readVector3f(reader),
    aabbMaxDelta: readVector3f(reader),
    hasNormals: readBool(reader),
    hasTangents: readBool(reader),
  };
}

/** Upstream `BlendShapeVertex(ObjectReader)`; its index is an `Int32` in 4.1 and 4.2. */
function readShapeVertex(reader: ObjectReader, signedIndex: boolean): BlendShapeVertex {
  return {
    vertex: readVector3f(reader),
    normal: readVector3f(reader),
    tangent: readVector3f(reader),
    index: signedIndex ? reader.readInt32() : reader.readUInt32(),
  };
}

/** Upstream `VertexData(ObjectReader)`, from 3.5. */
function readVertexData(reader: ObjectReader, version: UnityVersion): MeshVertexData {
  const out: Partial<MeshVertexData> = {};
  // Before 2018.1 (TPK: gone in 2018.1.0b2; upstream: before 2018); signed from 5.6.
  if (!atLeast(version, 2018, 1)) {
    out.m_CurrentChannels = atLeast(version, 5, 6) ? reader.readInt32() : reader.readUInt32();
  }
  out.m_VertexCount = reader.readUInt32();
  if (atLeast(version, 4, 0)) {
    out.m_Channels = readArray(reader, "Mesh", "m_Channels", (r) => ({
      stream: r.readUInt8(),
      offset: r.readUInt8(),
      format: r.readUInt8(),
      dimension: r.readUInt8(),
    }));
  }
  if (!atLeast(version, 4, 0)) {
    // 3.5: four streams, each with its channels by mask.
    for (let i = 0; i < 4; i++) {
      out[`m_Streams[${i}]`] = {
        channelMask: reader.readUInt32(),
        offset: reader.readUInt32(),
        stride: reader.readUInt32(),
        align: reader.readUInt32(),
      };
    }
  } else if (!atLeast(version, 5, 0)) {
    out.m_Streams = readArray(reader, "Mesh", "m_Streams", (r) => ({
      channelMask: r.readUInt32(),
      offset: r.readUInt32(),
      stride: r.readUInt8(),
      dividerOp: r.readUInt8(),
      frequency: r.readUInt16(),
    }));
  }
  out.m_DataSize = readByteArray(reader, "m_DataSize");
  return out as MeshVertexData;
}

/** Upstream `CompressedMesh(ObjectReader)`, from 3.4. */
function readCompressedMesh(reader: ObjectReader, version: UnityVersion): CompressedMesh {
  const out: Partial<CompressedMesh> = {
    m_Vertices: readPackedFloats(reader, "m_Vertices"),
    m_UV: readPackedFloats(reader, "m_UV"),
  };
  if (!atLeast(version, 5, 0)) out.m_BindPoses = readPackedFloats(reader, "m_BindPoses");
  out.m_Normals = readPackedFloats(reader, "m_Normals");
  out.m_Tangents = readPackedFloats(reader, "m_Tangents");
  out.m_Weights = readPackedInts(reader, "m_Weights");
  out.m_NormalSigns = readPackedInts(reader, "m_NormalSigns");
  out.m_TangentSigns = readPackedInts(reader, "m_TangentSigns");
  if (atLeast(version, 5, 0)) out.m_FloatColors = readPackedFloats(reader, "m_FloatColors");
  out.m_BoneIndices = readPackedInts(reader, "m_BoneIndices");
  out.m_Triangles = readPackedInts(reader, "m_Triangles");
  // 3.5+: packed colours before 5.0, the UV layout from 5.0.
  if (atLeast(version, 5, 0)) out.m_UVInfo = reader.readUInt32();
  else if (atLeast(version, 3, 5)) out.m_Colors = readPackedInts(reader, "m_Colors");
  return out as CompressedMesh;
}

/** Upstream `PackedFloatVector(ObjectReader)`. */
function readPackedFloats(reader: ObjectReader, field: string): PackedFloatVector {
  const m_NumItems = reader.readUInt32();
  const m_Range = reader.readFloat32();
  const m_Start = reader.readFloat32();
  const m_Data = readByteArray(reader, `m_CompressedMesh.${field}.m_Data`);
  const m_BitSize = reader.readUInt8();
  reader.align();
  return { m_NumItems, m_Range, m_Start, m_Data, m_BitSize };
}

/** Upstream `PackedIntVector(ObjectReader)`. */
function readPackedInts(reader: ObjectReader, field: string): PackedIntVector {
  const m_NumItems = reader.readUInt32();
  const m_Data = readByteArray(reader, `m_CompressedMesh.${field}.m_Data`);
  const m_BitSize = reader.readUInt8();
  reader.align();
  return { m_NumItems, m_Data, m_BitSize };
}

/** `MeshLodInfo`, 6000.2+: not in upstream, laid out as TPK records it. */
function readMeshLodInfo(reader: ObjectReader): MeshLodInfo {
  return {
    m_LodSelectionCurve: { m_LodSlope: reader.readFloat32(), m_LodBias: reader.readFloat32() },
    m_NumLevels: reader.readInt32(),
    m_SubMeshes: readArray(reader, "Mesh", "m_MeshLodInfo.m_SubMeshes", (r) => ({
      m_Levels: readArray(r, "Mesh", "m_MeshLodInfo.m_SubMeshes.m_Levels", (l) => ({
        m_IndexStart: l.readUInt32(),
        m_IndexCount: l.readUInt32(),
      })),
    })),
  };
}

/** Upstream `BoneWeights4(ObjectReader)` (TPK's `BoneInfluence` before 2017.1). */
function readBoneWeights(reader: ObjectReader): BoneWeights4 {
  return {
    "weight[0]": reader.readFloat32(),
    "weight[1]": reader.readFloat32(),
    "weight[2]": reader.readFloat32(),
    "weight[3]": reader.readFloat32(),
    "boneIndex[0]": reader.readInt32(),
    "boneIndex[1]": reader.readInt32(),
    "boneIndex[2]": reader.readInt32(),
    "boneIndex[3]": reader.readInt32(),
  };
}

/** A `vector<UInt8>` or `TypelessData`: a count, the bytes as a view (R7), then padding to 4. */
function readByteArray(reader: ObjectReader, field: string): Uint8Array {
  const bytes = reader.readBytes(readCount(reader, `Mesh ${reader.pathId} ${field} byte`));
  reader.align();
  return bytes;
}

/** An aligned string, its errors naming the field. */
function readStringField(reader: ObjectReader, field: string): string {
  const text = reader.readString(readCount(reader, `Mesh ${reader.pathId} ${field} byte`));
  reader.align();
  return text;
}

/** An `AABB`: its centre and extent. */
function readAABB(reader: ObjectReader): AABB {
  return { m_Center: readVector3f(reader), m_Extent: readVector3f(reader) };
}

/** A `Vector2f`. */
function readVector2f(reader: ObjectReader): Vector2 {
  return { x: reader.readFloat32(), y: reader.readFloat32() };
}

/** A `Vector3f`: three floats in every version, as TPK records it (see {@link readMesh}). */
function readVector3f(reader: ObjectReader): Vector3 {
  return { x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32() };
}

/** A `Vector4f`. */
function readVector4f(reader: ObjectReader): Vector4 {
  return {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    w: reader.readFloat32(),
  };
}

/** A one-byte bool, as Unity writes it. */
function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}

// --- decoding (upstream `ProcessData`) ------------------------------------------------

/**
 * `readMesh` with the vertices and triangles decoded into `geometry`, as
 * upstream's `Mesh` constructor does: before 3.5 the vertex arrays of the
 * object; from 3.5 the vertex streams of `m_VertexData`, read from the
 * resource file `m_StreamData` names when its `path` is not empty and the
 * mesh has vertices; then `m_CompressedMesh`, whose non-empty vectors replace
 * what those gave; then each submesh's indices as triangles. The registry's
 * reader for `obj.read()`.
 *
 * Every component is computed in float32 as upstream computes it (`float`
 * arithmetic, each step rounded with `Math.fround`), so the values are
 * upstream's bit for bit.
 *
 * Where upstream throws, this throws too. One difference: a mesh from 2018.1
 * whose `m_Skin` is empty gets its bone weights from its vertex channels, as
 * every later version does, where upstream indexes past the empty list.
 *
 * @param reader the object's reader
 * @param resources how to read resource files for it; `undefined` for a reader
 *   not built by `load()`
 * @throws {ResourceNotFoundError} when the vertex data is in a resource file
 *   that is not loaded, or there are no `resources` to look in
 * @throws {UnsupportedError} for a channel in a vertex format Unity does not
 *   define for the mesh's version, bone weights in an integer format or more
 *   than four of them, bone indices in a float format, and a submesh of lines
 *   or points from Unity 4.0 (upstream throws for each); and as `readMesh`
 *   does
 * @throws {CorruptError} when a vertex attribute, an index or a packed vector
 *   runs past the bytes that hold it, a channel names a stream there is not,
 *   a packed vector has fewer signs or bone indices than it needs, or bone
 *   weights run past the vertex count; and as `readMesh` does
 */
export function readMeshData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): MeshData {
  const mesh = readMesh(reader);
  const version = meshVersion(reader);
  const decoder = new Decoder(mesh, reader, version);
  const vertexData = mesh.m_VertexData;
  if (vertexData) {
    let bytes = vertexData.m_DataSize;
    const stream = mesh.m_StreamData;
    // Upstream reads the resource only for a mesh with vertices.
    if (stream?.path && vertexData.m_VertexCount > 0) {
      // A reader built outside `load()` has no files to look in.
      if (!resources) throw new ResourceNotFoundError(stream.path, baseName(stream.path));
      bytes = resources(stream, reader);
    }
    decoder.readVertexStreams(vertexData, bytes);
  } else {
    decoder.readLegacyVertices();
  }
  decoder.decompress();
  const indices = decoder.triangles();
  const { vertexCount, vertices, normals, tangents, colors, uv, skin, bindPoses } = decoder;
  // Keys in a fixed order, the attributes a mesh lacks left out.
  const geometry: MeshGeometry = {
    vertexCount,
    ...(vertices && { vertices }),
    ...(normals && { normals }),
    ...(tangents && { tangents }),
    ...(colors && { colors }),
    uv,
    ...(skin && { skin }),
    ...(bindPoses && { bindPoses }),
    indices,
  };
  return { ...mesh, geometry };
}

/**
 * Unity's `VertexFormat` from 2019.1, upstream `MeshHelper.VertexFormat`, to
 * which `toVertexFormat` maps older numberings: the bytes of one component.
 */
const FORMAT_SIZE = [
  4, // Float
  2, // Float16
  1, // UNorm8
  1, // SNorm8
  2, // UNorm16
  2, // SNorm16
  1, // UInt8
  1, // SInt8
  2, // UInt16
  2, // SInt16
  4, // UInt32
  4, // SInt32
];

/** Before 2017.1 (`VertexChannelFormat`): Float, Float16, Color (UNorm8), Byte (UInt8), UInt32. */
const FORMATS_BEFORE_2017 = [0, 1, 2, 6, 10];

/**
 * 2017.1 to 2018.4 (`VertexFormat2017`): as 2019's, with Color (UNorm8) at 2
 * and the rest one later.
 */
const FORMATS_2017 = [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** The first integer `VertexFormat` (upstream `MeshHelper.IsIntFormat`). */
const FIRST_INT_FORMAT = 6;

/** Upstream `Vector3.kEpsilon`, below which `Normalize` gives the zero vector. */
const EPSILON = Math.fround(0.00001);

const f = Math.fround;

/** A vertex stream: the channels in it, where it starts and its bytes per vertex. */
interface VertexStream {
  channelMask: number;
  offset: number;
  stride: number;
}

/** Upstream `Mesh`'s decoding state, the vertex attributes it fills in. */
class Decoder {
  vertexCount = 0;
  vertices?: Float32Array;
  normals?: Float32Array;
  tangents?: Float32Array;
  colors?: Float32Array;
  readonly uv: (Float32Array | undefined)[] = new Array<undefined>(8).fill(undefined);
  skin?: VertexBoneWeights[];
  bindPoses?: Matrix4x4[];
  /** Upstream `m_Use16BitIndices`. */
  private readonly use16: boolean;
  /** Upstream `m_IndexBuffer`, as numbers. */
  private indexBuffer: Uint32Array;

  constructor(
    private readonly mesh: Mesh,
    private readonly reader: ObjectReader,
    private readonly version: UnityVersion,
  ) {
    // 16-bit unless the object says otherwise: m_Use16BitIndices before 3.5,
    // m_IndexFormat (0 for 16-bit) where it is read.
    if (mesh.m_Use16BitIndices !== undefined) this.use16 = mesh.m_Use16BitIndices > 0;
    else if (mesh.m_IndexFormat !== undefined) this.use16 = mesh.m_IndexFormat === 0;
    else this.use16 = true;
    this.indexBuffer = this.readIndexBuffer();
    // Before 2018.2 the object holds four bone weights per vertex.
    if (mesh.m_Skin && mesh.m_Skin.length > 0) {
      this.skin = mesh.m_Skin.map((w) => ({
        weight: [w["weight[0]"], w["weight[1]"], w["weight[2]"], w["weight[3]"]],
        boneIndex: [w["boneIndex[0]"], w["boneIndex[1]"], w["boneIndex[2]"], w["boneIndex[3]"]],
      }));
    }
  }

  /** `Mesh <pathId>`, for error messages. */
  private get owner(): string {
    return `Mesh ${this.reader.pathId}`;
  }

  /** Whether the version is `major.minor` or later. */
  private atLeast(major: number, minor = 0): boolean {
    return atLeast(this.version, major, minor);
  }

  /** Upstream's `m_IndexBuffer`: `UInt16` or `UInt32` values in the file's byte order. */
  private readIndexBuffer(): Uint32Array {
    const bytes = this.mesh.m_IndexBuffer;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = this.reader.endian === "little";
    const size = this.use16 ? 2 : 4;
    const out = new Uint32Array(Math.floor(bytes.length / size));
    for (let i = 0; i < out.length; i++) {
      out[i] = size === 2 ? view.getUint16(i * 2, little) : view.getUint32(i * 4, little);
    }
    return out;
  }

  /** Before 3.5: the vertex arrays of the object, flattened, and its colours over 255. */
  readLegacyVertices(): void {
    const { mesh } = this;
    const flat = (items: object[] | undefined) =>
      Float32Array.from((items ?? []).flatMap((item) => Object.values(item) as number[]));
    this.vertexCount = mesh.m_Vertices?.length ?? 0;
    this.vertices = flat(mesh.m_Vertices);
    this.uv[0] = flat(mesh.m_UV);
    this.uv[1] = flat(mesh.m_UV1);
    this.tangents = flat(mesh.m_Tangents);
    this.normals = flat(mesh.m_Normals);
    // An RGBA32 per vertex: its bytes in the order the file holds them.
    const little = this.reader.endian === "little";
    this.colors = Float32Array.from(
      (mesh.m_Colors ?? []).flatMap(({ rgba }) =>
        [0, 8, 16, 24].map((shift) => f(((rgba >>> (little ? shift : 24 - shift)) & 0xff) / 255)),
      ),
    );
  }

  /**
   * The streams of the vertex data: from 5.0 laid out from the channels
   * (upstream `GetStreams`), in 4.x as the object holds them, and in 3.5 the
   * four of the object, whose channels follow from their masks.
   */
  private streams(data: MeshVertexData, channels: ChannelInfo[]): VertexStream[] {
    if (!this.atLeast(5)) {
      if (data.m_Streams) return data.m_Streams;
      // readVertexData sets all four.
      return [0, 1, 2, 3].map((i) => data[`m_Streams[${i}]`]!);
    }
    const count = data.m_VertexCount;
    const streamCount = Math.max(-1, ...channels.map((c) => c.stream)) + 1;
    const out: VertexStream[] = [];
    let offset = 0;
    for (let s = 0; s < streamCount; s++) {
      let channelMask = 0;
      let stride = 0;
      channels.forEach((channel, chn) => {
        // Upstream `ChannelInfo` keeps the low 4 bits of the dimension byte.
        const dimension = channel.dimension & 0xf;
        if (channel.stream !== s || dimension === 0) return;
        channelMask |= 1 << chn;
        stride += dimension * FORMAT_SIZE[this.vertexFormat(channel.format, chn)]!;
      });
      out.push({ channelMask, offset, stride });
      // UInt32 arithmetic, as upstream's; each stream starts 16-byte aligned.
      offset = (offset + Math.imul(count, stride)) >>> 0;
      offset = ((offset + 15) & ~15) >>> 0;
    }
    return out;
  }

  /**
   * Upstream `VertexData.GetChannels`, for 3.5: six channels (position,
   * normal, colour, UV0, UV1, tangent) placed in the streams their masks name,
   * one after the other.
   */
  private legacyChannels(streams: VertexStream[]): ChannelInfo[] {
    // [format, dimension]: Float or Color (UNorm8, one byte a component).
    const kinds: [number, number][] = [[0, 3], [0, 3], [2, 4], [0, 2], [0, 2], [0, 4]];
    const channels = kinds.map(() => ({ stream: 0, offset: 0, format: 0, dimension: 0 }));
    streams.forEach((stream, s) => {
      let offset = 0;
      kinds.forEach(([format, dimension], i) => {
        if (((stream.channelMask >>> i) & 1) === 0) return;
        channels[i] = { stream: s, offset, format, dimension };
        // A byte, as upstream's.
        offset = (offset + dimension * (format === 2 ? 1 : 4)) & 0xff;
      });
    });
    return channels;
  }

  /**
   * A channel's format in 2019's numbering (upstream `MeshHelper.ToVertexFormat`).
   *
   * @throws {UnsupportedError} for a format the version does not define
   */
  private vertexFormat(format: number, chn: number): number {
    const mapped = this.atLeast(2019)
      ? format
      : this.atLeast(2017)
        ? FORMATS_2017[format]
        : FORMATS_BEFORE_2017[format];
    if (mapped === undefined || FORMAT_SIZE[mapped] === undefined) {
      throw new UnsupportedError("vertex format", format, `${this.owner} channel ${chn}`);
    }
    return mapped;
  }

  /** Upstream `ReadVertexData`, from 3.5. */
  readVertexStreams(data: MeshVertexData, bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = this.reader.endian === "little";
    const count = (this.vertexCount = data.m_VertexCount);
    let channels = data.m_Channels ?? [];
    const streams = this.streams(data, channels);
    if (!data.m_Channels) channels = this.legacyChannels(streams);
    channels.forEach((channel, chn) => {
      let dimension = channel.dimension & 0xf;
      if (dimension === 0) return;
      const stream = streams[channel.stream];
      if (!stream) {
        throw new CorruptError(
          `${this.owner} channel ${chn} is in stream ${channel.stream} of ${streams.length}`,
        );
      }
      if (((stream.channelMask >>> chn) & 1) === 0) return;
      // Before 2018: a colour in the Color format is four bytes.
      if (this.version[0] < 2018 && chn === 2 && channel.format === 2) dimension = 4;
      const format = this.vertexFormat(channel.format, chn);
      const size = FORMAT_SIZE[format]!;
      const start = stream.offset + channel.offset;
      const at = (v: number, d: number) => start + stream.stride * v + size * d;
      // The last component must be there before any is read (upstream's
      // `BlockCopy` throws on the first one missing).
      if (count > 0 && at(count - 1, dimension - 1) + size > bytes.length) {
        throw new CorruptError(
          `${this.owner} channel ${chn}: ${count} vertices of stride ${stream.stride} from byte ` +
            `${start} run past the ${bytes.length} bytes of vertex data`,
        );
      }
      const isInt = format >= FIRST_INT_FORMAT;
      const length = count * dimension;
      const values = isInt ? new Int32Array(length) : new Float32Array(length);
      for (let v = 0; v < count; v++) {
        for (let d = 0; d < dimension; d++) {
          values[v * dimension + d] = component(view, at(v, d), format, little);
        }
      }
      const floats = isInt ? undefined : (values as Float32Array);
      if (this.version[0] >= 2018) this.assign(chn, dimension, format, floats, values);
      else this.assignBefore2018(chn, floats);
    });
  }

  /**
   * Upstream's channel switch before 2018: 0 position, 1 normal, 2 colour,
   * 3 UV0, 4 UV1, 5 UV2 from 5.0 (the tangent before), 6 UV3, 7 tangent.
   */
  private assignBefore2018(chn: number, floats: Float32Array | undefined): void {
    if (chn === 0) this.vertices = floats;
    else if (chn === 1) this.normals = floats;
    else if (chn === 2) this.colors = floats;
    else if (chn === 3 || chn === 4) this.uv[chn - 3] = floats;
    else if (chn === 5 && this.atLeast(5)) this.uv[2] = floats;
    else if (chn === 5 || chn === 7) this.tangents = floats;
    else if (chn === 6) this.uv[3] = floats;
  }

  /**
   * Upstream's switch on the channel from 2018: an attribute takes the float
   * components, so an integer format leaves it `undefined`.
   */
  private assign(
    chn: number,
    dimension: number,
    format: number,
    floats: Float32Array | undefined,
    values: Float32Array | Int32Array,
  ): void {
    if (chn === 0) this.vertices = floats;
    else if (chn === 1) this.normals = floats;
    else if (chn === 2) this.tangents = floats;
    else if (chn === 3) this.colors = floats;
    else if (chn >= 4 && chn <= 11) this.uv[chn - 4] = floats;
    else if (chn === 12 || chn === 13) {
      // 12: kShaderChannelBlendWeight; 13: kShaderChannelBlendIndices.
      const weights = chn === 12;
      if (weights !== (floats !== undefined)) {
        throw new UnsupportedError(
          "vertex format",
          format,
          `${this.owner}: bone ${weights ? "weights" : "indices"} in ` +
            `${weights ? "an integer" : "a float"} format`,
        );
      }
      if (dimension > 4) {
        throw new UnsupportedError(
          "bones per vertex",
          dimension,
          `${this.owner}: a vertex holds at most four bone ${weights ? "weights" : "indices"}`,
        );
      }
      // 2018.1's m_Skin when it has the vertices, a new one otherwise.
      if (!this.skin) this.skin = newSkin(this.vertexCount);
      const skin = this.skin;
      if (skin.length < this.vertexCount) {
        throw new CorruptError(
          `${this.owner}: m_Skin has ${skin.length} of the ${this.vertexCount} vertices`,
        );
      }
      for (let i = 0; i < this.vertexCount; i++) {
        for (let j = 0; j < dimension; j++) {
          const value = values[i * dimension + j]!;
          if (weights) skin[i]!.weight[j] = value;
          else skin[i]!.boneIndex[j] = value;
        }
      }
    }
  }

  /**
   * Upstream `DecompressCompressedMesh`: each non-empty vector replaces its
   * attribute.
   */
  decompress(): void {
    const packed = this.mesh.m_CompressedMesh;
    if (packed.m_Vertices.m_NumItems > 0) {
      this.vertexCount = Math.trunc(packed.m_Vertices.m_NumItems / 3);
      this.vertices = this.unpackFloats(packed.m_Vertices, "m_Vertices", 3);
    }
    if (packed.m_UV.m_NumItems > 0) this.decompressUV(packed);
    // Before 5.0.
    if (packed.m_BindPoses && packed.m_BindPoses.m_NumItems > 0) {
      const values = this.unpackFloats(packed.m_BindPoses, "m_BindPoses", 16);
      this.bindPoses = Array.from({ length: values.length / 16 }, (_, i) => matrix(values, i * 16));
    }
    if (packed.m_Normals.m_NumItems > 0) {
      const signs = this.unpackInts(packed.m_NormalSigns, "m_NormalSigns");
      this.normals = this.decompressDirections(packed.m_Normals, "m_Normals", signs, 1, 3);
    }
    if (packed.m_Tangents.m_NumItems > 0) {
      const signs = this.unpackInts(packed.m_TangentSigns, "m_TangentSigns");
      this.tangents = this.decompressDirections(packed.m_Tangents, "m_Tangents", signs, 2, 4);
    }
    // 5.0+.
    if (packed.m_FloatColors && packed.m_FloatColors.m_NumItems > 0) {
      this.colors = this.unpackFloats(packed.m_FloatColors, "m_FloatColors", 1);
    }
    if (packed.m_Weights.m_NumItems > 0) this.decompressSkin(packed);
    if (packed.m_Triangles.m_NumItems > 0) {
      this.indexBuffer = Uint32Array.from(this.unpackInts(packed.m_Triangles, "m_Triangles"));
    }
    // 3.5 to 4.x: each colour's four channels share m_BitSize.
    const colors = packed.m_Colors;
    if (colors && colors.m_NumItems > 0) {
      const channels = {
        ...colors,
        m_NumItems: (colors.m_NumItems * 4) >>> 0,
        m_BitSize: colors.m_BitSize >> 2,
      };
      this.colors = Float32Array.from(this.unpackInts(channels, "m_Colors"), (c) => f(c / 255));
    }
  }

  /** The UV channels of a compressed mesh, by `m_UVInfo`, or UV0 and UV1 without it. */
  private decompressUV(packed: CompressedMesh): void {
    const count = this.vertexCount;
    const info = packed.m_UVInfo ?? 0;
    if (info === 0) {
      this.uv[0] = this.unpackFloats(packed.m_UV, "m_UV", 2, 0, count);
      if (packed.m_UV.m_NumItems >= count * 4) {
        this.uv[1] = this.unpackFloats(packed.m_UV, "m_UV", 2, count * 2, count);
      }
      return;
    }
    let start = 0;
    for (let uv = 0; uv < 8; uv++) {
      const bits = (info >>> (uv * 4)) & 0xf;
      // Bit 2: the channel is there; bits 0-1: its dimension minus 1.
      if ((bits & 4) === 0) continue;
      const dimension = 1 + (bits & 3);
      this.uv[uv] = this.unpackFloats(packed.m_UV, "m_UV", dimension, start, count);
      start += dimension * count;
    }
  }

  /**
   * Normals (`width` 3) or tangents (4) from their packed x and y: z from the
   * unit length, negated where its sign is 0, and a tangent's w from the
   * second sign. Every step in float32, as upstream's `float` arithmetic.
   */
  private decompressDirections(
    vector: PackedFloatVector,
    field: string,
    signs: Int32Array,
    signsPerItem: number,
    width: number,
  ): Float32Array {
    const xy = this.unpackFloats(vector, field, 2);
    const count = Math.trunc(vector.m_NumItems / 2);
    if (signs.length < count * signsPerItem) {
      throw new CorruptError(
        `${this.owner} m_CompressedMesh.${field}: ${count} items need ${count * signsPerItem} ` +
          `signs, and there are ${signs.length}`,
      );
    }
    const out = new Float32Array(count * width);
    for (let i = 0; i < count; i++) {
      let x = xy[i * 2]!;
      let y = xy[i * 2 + 1]!;
      const zsqr = f(f(1 - f(x * x)) - f(y * y));
      let z: number;
      if (zsqr >= 0) {
        z = f(Math.sqrt(zsqr));
      } else {
        // Upstream `Vector3.Normalize` of (x, y, 0).
        z = 0;
        const length = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
        if (length > EPSILON) {
          const inverse = f(1 / length);
          x = f(x * inverse);
          y = f(y * inverse);
          z = f(z * inverse);
        } else {
          x = y = z = 0;
        }
      }
      if (signs[i * signsPerItem] === 0) z = -z;
      out[i * width] = x;
      out[i * width + 1] = y;
      out[i * width + 2] = z;
      if (width === 4) out[i * width + 3] = signs[i * 2 + 1]! > 0 ? 1 : -1;
    }
    return out;
  }

  /**
   * Bone weights in 31ths, up to four per vertex: a vertex ends when its
   * weights reach 31, or after three, whose remainder makes a fourth with
   * one more bone index.
   */
  private decompressSkin(packed: CompressedMesh): void {
    const weights = this.unpackInts(packed.m_Weights, "m_Weights");
    const bones = this.unpackInts(packed.m_BoneIndices, "m_BoneIndices");
    const skin = (this.skin = newSkin(this.vertexCount));
    let vertex = 0;
    let bone = 0;
    let j = 0;
    let sum = 0;
    const next = (): number => {
      if (bone >= bones.length) {
        throw new CorruptError(
          `${this.owner} m_CompressedMesh: the bone weights need more than the ` +
            `${bones.length} bone indices of m_BoneIndices`,
        );
      }
      return bones[bone++]!;
    };
    for (const weight of weights) {
      const at = skin[vertex];
      if (!at) {
        throw new CorruptError(
          `${this.owner} m_CompressedMesh: m_Weights runs past the ${skin.length} vertices`,
        );
      }
      at.weight[j] = f(weight / 31);
      at.boneIndex[j] = next();
      j++;
      sum += weight;
      if (sum >= 31) {
        // The weights add up to one: the rest of this vertex's are zero.
        for (; j < 4; j++) {
          at.weight[j] = 0;
          at.boneIndex[j] = 0;
        }
      } else if (j === 3) {
        // Three weights short of one: the fourth is what they leave.
        at.weight[3] = f((31 - sum) / 31);
        at.boneIndex[3] = next();
      } else {
        continue;
      }
      vertex++;
      j = 0;
      sum = 0;
    }
  }

  /**
   * Upstream `PackedFloatVector.UnpackFloats`, for the strides it is called
   * with (`itemCount` floats a chunk): `chunks` chunks from item `start`,
   * every chunk of the vector by default. In float32, as upstream's `float`
   * arithmetic: `x / (scale * (2^bits - 1)) + m_Start`, `scale` being
   * `1 / m_Range`.
   */
  private unpackFloats(
    vector: PackedFloatVector,
    field: string,
    itemCount: number,
    start = 0,
    chunks = Math.trunc(vector.m_NumItems / itemCount),
  ): Float32Array {
    const bits = vector.m_BitSize;
    const total = itemCount * chunks;
    this.checkBits(vector, field, start, total);
    const scale = f(1 / vector.m_Range);
    // Int32 arithmetic, as upstream's `(1 << m_BitSize) - 1`.
    const denominator = f(scale * f(((1 << bits) - 1) | 0));
    const mask = ((1 << bits) >>> 0) - 1;
    const out = new Float32Array(total);
    const read = bitReader(vector.m_Data, bits * start);
    for (let i = 0; i < total; i++) {
      const x = (read(bits) & mask) >>> 0;
      out[i] = f(f(f(x) / denominator) + vector.m_Start);
    }
    return out;
  }

  /** Upstream `PackedIntVector.UnpackInts`: every item, as Int32 values. */
  private unpackInts(vector: PackedIntVector, field: string): Int32Array {
    const bits = vector.m_BitSize;
    this.checkBits(vector, field, 0, vector.m_NumItems);
    const mask = ((1 << bits) - 1) | 0;
    const out = new Int32Array(vector.m_NumItems);
    const read = bitReader(vector.m_Data, 0);
    for (let i = 0; i < out.length; i++) out[i] = read(bits) & mask;
    return out;
  }

  /**
   * Items `start` to `start + count` must lie inside `m_Data` (upstream throws
   * on the first that does not).
   */
  private checkBits(
    vector: PackedFloatVector | PackedIntVector,
    field: string,
    start: number,
    count: number,
  ): void {
    const need = Math.ceil((vector.m_BitSize * (start + count)) / 8);
    if (need > vector.m_Data.length) {
      throw new CorruptError(
        `${this.owner} m_CompressedMesh.${field}: items ${start} to ${start + count} of ` +
          `${vector.m_BitSize} bits need ${need} bytes, and m_Data has ${vector.m_Data.length}`,
      );
    }
  }

  /**
   * Upstream `GetTriangles`: each submesh's indices as a triangle list. A
   * strip drops its degenerate triangles and flips every other one's winding;
   * quads split along their first diagonal.
   */
  triangles(): Uint32Array[] {
    return this.mesh.m_SubMeshes.map((subMesh, i) => this.subMeshTriangles(subMesh, i));
  }

  /** One submesh's part of upstream's `GetTriangles`. */
  private subMeshTriangles(subMesh: SubMesh | LegacySubMesh, i: number): Uint32Array {
    const buffer = this.indexBuffer;
    // UInt32 division, as upstream's: firstByte over the index size.
    const first = Math.floor(subMesh.firstByte / (this.use16 ? 2 : 4));
    const { indexCount } = subMesh;
    // Upstream reads 3.x's isTriStrip as the topology, and before 4.0 takes
    // anything but a triangle list for a strip.
    const raw = "topology" in subMesh ? subMesh.topology : subMesh.isTriStrip | 0;
    const topology =
      raw !== GfxPrimitiveType.Triangles && !this.atLeast(4) ? GfxPrimitiveType.TriangleStrip : raw;
    // How many indices from `first` the topology reads: upstream's loops step
    // past indexCount to a whole face. A strip of fewer than 3 has no face;
    // upstream's `indexCount - 2` wraps there and it throws past the buffer.
    let reads: number;
    if (topology === GfxPrimitiveType.Triangles) reads = Math.ceil(indexCount / 3) * 3;
    else if (topology === GfxPrimitiveType.TriangleStrip) reads = indexCount >= 3 ? indexCount : 0;
    else if (topology === GfxPrimitiveType.Quads) reads = Math.ceil(indexCount / 4) * 4;
    else {
      throw new UnsupportedError(
        "mesh topology",
        topology,
        `${this.owner} submesh ${i}: only triangles, strips and quads make faces`,
      );
    }
    if (reads > 0 && first + reads > buffer.length) {
      throw new CorruptError(
        `${this.owner} submesh ${i}: indices ${first} to ${first + reads} run past the ` +
          `${buffer.length} of the index buffer`,
      );
    }
    const at = (k: number): number => buffer[first + k]!;
    if (topology === GfxPrimitiveType.Triangles) return buffer.subarray(first, first + reads);
    if (topology === GfxPrimitiveType.Quads) {
      const out = new Uint32Array((reads / 4) * 6);
      for (let q = 0; q < reads; q += 4) {
        // Split along the first diagonal: (0, 1, 2) and (0, 2, 3).
        out.set([at(q), at(q + 1), at(q + 2), at(q), at(q + 2), at(q + 3)], (q / 4) * 6);
      }
      return out;
    }
    const out: number[] = [];
    for (let k = 0; k < reads - 2; k++) {
      const [a, b, c] = [at(k), at(k + 1), at(k + 2)];
      // Degenerate triangles only join the strip's runs.
      if (a === b || a === c || b === c) continue;
      // Every other triangle of a strip is wound the other way.
      if ((k & 1) === 1) out.push(b, a, c);
      else out.push(a, b, c);
    }
    return Uint32Array.from(out);
  }
}

/** Sixteen floats from `at` as a `Matrix4x4f`, `e00` to `e33` in the order the file holds them. */
function matrix(values: Float32Array, at: number): Matrix4x4 {
  const out: Partial<Matrix4x4> = {};
  for (let i = 0; i < 16; i++) {
    out[`e${i >> 2}${i & 3}` as keyof Matrix4x4] = values[at + i]!;
  }
  return out as Matrix4x4;
}

/** Upstream `InitMSkin`: every vertex with four zero weights on bone 0. */
function newSkin(count: number): VertexBoneWeights[] {
  return Array.from({ length: count }, () => ({ weight: [0, 0, 0, 0], boneIndex: [0, 0, 0, 0] }));
}

/**
 * One vertex component in a 2019+ `VertexFormat`, as upstream's
 * `MeshHelper.BytesToFloatArray` and `BytesToIntArray` convert it: norm
 * formats divided in float32, SNorm clamped to -1; the signed 8-bit format
 * read unsigned and both 16-bit ones signed, as upstream does.
 */
function component(view: DataView, at: number, format: number, little: boolean): number {
  switch (format) {
    case 0:
      return view.getFloat32(at, little);
    case 1:
      return halfToFloat(view.getUint16(at, little));
    case 2:
      return f(view.getUint8(at) / 255);
    case 3:
      return Math.max(f(view.getInt8(at) / 127), -1);
    case 4:
      return f(view.getUint16(at, little) / 65535);
    case 5:
      return Math.max(f(view.getInt16(at, little) / 32767), -1);
    case 6:
    case 7:
      return view.getUint8(at);
    case 8:
    case 9:
      return view.getInt16(at, little);
    default:
      return view.getInt32(at, little);
  }
}

/** An IEEE half-precision value, exactly (upstream `Half.ToHalf`). */
function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1024 + mantissa) * 2 ** (exponent - 25);
}

/**
 * A reader of `bits`-wide items from `data`, least significant bit first,
 * from bit `position`: upstream's loop, which takes what is left of the
 * current byte, then the next. Shifts are Int32 shifts, as upstream's.
 */
function bitReader(data: Uint8Array, position: number): (bits: number) => number {
  let index = Math.floor(position / 8);
  let bit = position % 8;
  return (bits) => {
    let x = 0;
    for (let have = 0; have < bits; ) {
      x |= (data[index]! >> bit) << have;
      const take = Math.min(bits - have, 8 - bit);
      bit += take;
      have += take;
      if (bit === 8) {
        index++;
        bit = 0;
      }
    }
    return x;
  };
}
