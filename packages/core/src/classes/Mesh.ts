// Ported from AssetStudio/Classes/Mesh.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/AnimationClip.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Math/Vector3.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../errors.js";
import type { ObjectReader, Vector3 } from "../serialized/ObjectReader.js";
import { baseName, type UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import type { ResourceReader } from "./registry.js";
import {
  assumingLayout,
  endOfObject,
  layoutVersion,
  readArray,
  readBlendShapeData,
  readMatrix,
  readSubMesh,
  readVertexData,
  type AABB,
  type BlendShapeData,
  type Matrix4x4,
  type SubMesh,
  type VertexData,
} from "./Sprite.js";
import { readStreamingInfo, type StreamingInfo } from "./Texture2D.js";
import { atLeast } from "./version.js";

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
  /** Four per vertex: RGBA. */
  m_FloatColors: PackedFloatVector;
  /** One per weight in `m_Weights`, and one for the fourth weight it leaves implicit. */
  m_BoneIndices: PackedIntVector;
  m_Triangles: PackedIntVector;
  /**
   * Four bits per UV channel, channel 0 lowest: bit 2 set when the channel is
   * there, bits 0-1 its dimension minus 1. 0 for UV0 and UV1 of dimension 2.
   */
  m_UVInfo: number;
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
 * The fields of a `Mesh`, as a player build of Unity 2019.1 or later stores
 * them, under Unity's names: the keys, their order and their values agree
 * with `readTypeTree()` on the same object, except that `m_StreamData.offset`
 * is a `number` here.
 *
 * The vertices are in `m_VertexData`, or, when `m_StreamData.path` is not
 * empty, in `m_StreamData.size` bytes of a resource file; a compressed mesh
 * holds them in `m_CompressedMesh` instead. `obj.read()` decodes them
 * ({@link MeshData}).
 */
export interface Mesh extends NamedObject {
  m_SubMeshes: SubMesh[];
  m_Shapes: BlendShapeData;
  m_BindPose: Matrix4x4[];
  m_BoneNameHashes: number[];
  m_RootBoneNameHash: number;
  m_BonesAABB: MinMaxAABB[];
  m_VariableBoneCountWeights: VariableBoneCountWeights;
  /** 0 off, 1 low, 2 medium, 3 high: whether `m_CompressedMesh` holds the mesh. */
  m_MeshCompression: number;
  m_IsReadable: boolean;
  m_KeepVertices: boolean;
  m_KeepIndices: boolean;
  /** 0: `UInt16` indices; 1: `UInt32`. */
  m_IndexFormat: number;
  /** The indices of every submesh, in `m_IndexFormat`: a view into the object's bytes (R7). */
  m_IndexBuffer: Uint8Array;
  m_VertexData: VertexData;
  m_CompressedMesh: CompressedMesh;
  m_LocalAABB: AABB;
  /** Before Unity 6000.6. */
  m_MeshUsageFlags?: number;
  /** Unity 2022.1 and later. */
  m_CookingOptions?: number;
  /** Unity 6000.6 and later. */
  m_PreBakeConvexCollisionMesh?: boolean;
  /** Unity 6000.6 and later. */
  m_PreBakeTriangleCollisionMesh?: boolean;
  /** A view into the object's bytes (R7). */
  m_BakedConvexCollisionMesh: Uint8Array;
  /** A view into the object's bytes (R7). */
  m_BakedTriangleCollisionMesh: Uint8Array;
  "m_MeshMetrics[0]": number;
  "m_MeshMetrics[1]": number;
  /** Where the vertex data is when not inline: an empty `path` when it is. */
  m_StreamData: StreamingInfo;
  /** Unity 6000.2 and later. */
  m_MeshLodInfo?: MeshLodInfo;
}

/** The bones of one vertex and how much each moves it (upstream `BoneWeights4`). */
export interface VertexBoneWeights {
  weight: [number, number, number, number];
  boneIndex: [number, number, number, number];
}

/**
 * A `Mesh` as `obj.read()` returns it: every field `readMesh` reads, plus its
 * vertices and triangles decoded as upstream's `Mesh` does (its
 * `ProcessData`). The decoded fields are named outside Unity's `m_` names, as
 * `Texture2DData.imageData` is: they are not fields of the object.
 *
 * Vertex attributes are flat, `n` components per vertex, `n` being the
 * channel's dimension (a compressed mesh: 3 per vertex and normal, 4 per
 * tangent and colour). An attribute the mesh does not have, or stores in an
 * integer format, is absent, as upstream leaves it `null`.
 */
export interface MeshData extends Mesh {
  /**
   * Upstream `m_VertexCount`: `m_VertexData.m_VertexCount`, or for a
   * compressed mesh its vertex count.
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
   * Upstream `m_Indices`, split by submesh: each submesh's triangles, three
   * indices each, with strips and quads turned into triangle lists (strips
   * without their degenerate triangles). As upstream's, the indices are not
   * offset by `baseVertex`.
   */
  indices: Uint32Array[];
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
 * their order. Nothing is decoded or resolved; `obj.read()` does that
 * ({@link MeshData}).
 *
 * Only the layouts of Unity 2019.1 and later are read, the supported floor.
 * Upstream stops after `m_StreamData`; `m_MeshLodInfo` (6000.2+) is read here
 * so the object is consumed to its last byte, and the object must end exactly
 * there, so a layout this reader does not know is refused rather than
 * returned half-read. Where TPK and upstream disagree, TPK is followed:
 * 6000.6 drops `m_MeshUsageFlags` and adds `m_PreBakeConvexCollisionMesh` and
 * `m_PreBakeTriangleCollisionMesh`, which upstream does not know.
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
 * changed this layout in pre-releases (TPK: 2019.1.0a10, 2020.1.0a19,
 * 2022.1.0a15, 6000.2.0a8, 6000.6.0a5); an earlier alpha of those fails the
 * end-of-object check. Compare the build type in the gate if one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields after
 *   `m_Name` do not fit 2019's layout. Of kind `"build target"` for an editor
 *   file (`BuildTarget.NoTarget`), which stores editor-only fields in between
 * @throws {CorruptError} when the object ends early, a count or byte length is
 *   negative or runs past its end, `m_StreamData.offset` is 2^53 or above, or
 *   bytes are left over after the last field, with the version known; with it
 *   unknown, only inside `m_Name`
 */
export function readMesh(reader: ObjectReader): Mesh {
  const stripped = reader.version.every((part) => part === 0);
  if (!stripped && !atLeast(reader.version, 2019, 1)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: the Mesh reader reads Unity 2019.1 and later, the supported ` +
        "floor; readTypeTree() reads an older one",
    );
  }
  const version = layoutVersion(reader, "Mesh", 2019, 1);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Mesh> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "Mesh", () => readMeshFields(reader, version, out));
  // Every required field was set above.
  return out as Mesh;
}

/** Every field of a `Mesh` after `m_Name`, and the end-of-object check. */
function readMeshFields(reader: ObjectReader, version: UnityVersion, out: Partial<Mesh>): void {
  out.m_SubMeshes = readArray(reader, "Mesh", "m_SubMeshes", (r) => readSubMesh(r, version));
  out.m_Shapes = readBlendShapeData(reader, version, "Mesh", "m_Shapes");
  out.m_BindPose = readArray(reader, "Mesh", "m_BindPose", readMatrix);
  out.m_BoneNameHashes = readArray(reader, "Mesh", "m_BoneNameHashes", (r) => r.readUInt32());
  out.m_RootBoneNameHash = reader.readUInt32();
  out.m_BonesAABB = readArray(reader, "Mesh", "m_BonesAABB", (r) => ({
    m_Min: readVector3f(r),
    m_Max: readVector3f(r),
  }));
  out.m_VariableBoneCountWeights = {
    m_Data: readArray(reader, "Mesh", "m_VariableBoneCountWeights", (r) => r.readUInt32()),
  };
  out.m_MeshCompression = reader.readUInt8();
  out.m_IsReadable = readBool(reader);
  out.m_KeepVertices = readBool(reader);
  out.m_KeepIndices = readBool(reader);
  reader.align();
  out.m_IndexFormat = reader.readInt32();
  out.m_IndexBuffer = readByteArray(reader, "m_IndexBuffer");
  out.m_VertexData = readVertexData(reader, version, "Mesh");
  out.m_CompressedMesh = readCompressedMesh(reader);
  out.m_LocalAABB = { m_Center: readVector3f(reader), m_Extent: readVector3f(reader) };
  // Gone in 6000.6 (TPK; upstream reads it throughout).
  if (!atLeast(version, 6000, 6)) out.m_MeshUsageFlags = reader.readInt32();
  if (atLeast(version, 2022, 1)) out.m_CookingOptions = reader.readInt32();
  // 6000.6+ (TPK; upstream does not know them).
  if (atLeast(version, 6000, 6)) {
    out.m_PreBakeConvexCollisionMesh = readBool(reader);
    out.m_PreBakeTriangleCollisionMesh = readBool(reader);
    reader.align();
  }
  out.m_BakedConvexCollisionMesh = readByteArray(reader, "m_BakedConvexCollisionMesh");
  out.m_BakedTriangleCollisionMesh = readByteArray(reader, "m_BakedTriangleCollisionMesh");
  out["m_MeshMetrics[0]"] = reader.readFloat32();
  out["m_MeshMetrics[1]"] = reader.readFloat32();
  reader.align();
  out.m_StreamData = readStreamingInfo(reader, "Mesh", version);
  // 6000.2+ (TPK; upstream stops before it).
  if (atLeast(version, 6000, 2)) out.m_MeshLodInfo = readMeshLodInfo(reader);
  endOfObject(reader, "Mesh");
}

/** Upstream `CompressedMesh(ObjectReader)`, from 5.0. */
function readCompressedMesh(reader: ObjectReader): CompressedMesh {
  return {
    m_Vertices: readPackedFloats(reader, "m_Vertices"),
    m_UV: readPackedFloats(reader, "m_UV"),
    m_Normals: readPackedFloats(reader, "m_Normals"),
    m_Tangents: readPackedFloats(reader, "m_Tangents"),
    m_Weights: readPackedInts(reader, "m_Weights"),
    m_NormalSigns: readPackedInts(reader, "m_NormalSigns"),
    m_TangentSigns: readPackedInts(reader, "m_TangentSigns"),
    m_FloatColors: readPackedFloats(reader, "m_FloatColors"),
    m_BoneIndices: readPackedInts(reader, "m_BoneIndices"),
    m_Triangles: readPackedInts(reader, "m_Triangles"),
    m_UVInfo: reader.readUInt32(),
  };
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

/** A `vector<UInt8>`: a count, the bytes as a view (R7), then padding to 4. */
function readByteArray(reader: ObjectReader, field: string): Uint8Array {
  const bytes = reader.readBytes(readCount(reader, `Mesh ${reader.pathId} ${field} byte`));
  reader.align();
  return bytes;
}

/** A `Vector3f`: three floats, as every version this reader knows stores it. */
function readVector3f(reader: ObjectReader): Vector3 {
  return { x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32() };
}

/** A one-byte bool, as Unity writes it. */
function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}

// --- decoding (upstream `ProcessData`) ------------------------------------------------

/**
 * `readMesh` with the vertices and triangles decoded, as upstream's `Mesh`
 * constructor does: the vertex streams of `m_VertexData`, read from the
 * resource file `m_StreamData` names when its `path` is not empty and the
 * mesh has vertices; then `m_CompressedMesh`, whose non-empty vectors replace
 * what the streams gave; then each submesh's indices as triangles. The
 * registry's reader for `obj.read()`.
 *
 * Every component is computed in float32 as upstream computes it (`float`
 * arithmetic, each step rounded with `Math.fround`), so the values are
 * upstream's bit for bit.
 *
 * @param reader the object's reader
 * @param resources how to read resource files for it; `undefined` for a reader
 *   not built by `load()`
 * @throws {ResourceNotFoundError} when the vertex data is in a resource file
 *   that is not loaded, or there are no `resources` to look in
 * @throws {UnsupportedError} for a channel in a vertex format Unity does not
 *   define (above 11), bone weights in an integer format or more than four of
 *   them, bone indices in a float format, and a submesh of lines or points
 *   (upstream throws for each); and as `readMesh` does
 * @throws {CorruptError} when a vertex attribute, an index or a packed vector
 *   runs past the bytes that hold it, a packed vector has fewer signs or bone
 *   indices than it needs, or its bone weights run past the vertex count; and
 *   as `readMesh` does
 */
export function readMeshData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): MeshData {
  const mesh = readMesh(reader);
  let vertexBytes = mesh.m_VertexData.m_DataSize;
  const stream = mesh.m_StreamData;
  // Upstream reads the resource only for a mesh with vertices.
  if (stream.path && mesh.m_VertexData.m_VertexCount > 0) {
    // A reader built outside `load()` has no files to look in.
    if (!resources) throw new ResourceNotFoundError(stream.path, baseName(stream.path));
    vertexBytes = resources(stream, reader);
  }
  const decoded = new Decoder(mesh, reader);
  decoded.readVertexStreams(vertexBytes);
  decoded.decompress();
  const indices = decoded.triangles();
  const { vertexCount, vertices, normals, tangents, colors, uv, skin } = decoded;
  // Keys in a fixed order, the attributes a mesh lacks left out.
  return {
    ...mesh,
    vertexCount,
    ...(vertices && { vertices }),
    ...(normals && { normals }),
    ...(tangents && { tangents }),
    ...(colors && { colors }),
    uv,
    ...(skin && { skin }),
    indices,
  };
}

/**
 * Unity's `VertexFormat` from 2019.1, the only numbering this reader meets
 * (upstream `MeshHelper.ToVertexFormat` maps older ones onto it): the bytes of
 * one component, by format.
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

/** The first integer `VertexFormat` (upstream `MeshHelper.IsIntFormat`). */
const FIRST_INT_FORMAT = 6;

/** Upstream `Vector3.kEpsilon`, below which `Normalize` gives the zero vector. */
const EPSILON = Math.fround(0.00001);

const f = Math.fround;

/** A stream of `VertexData` as upstream's `GetStreams` lays it out (5.0+). */
interface VertexStream {
  channelMask: number;
  offset: number;
  stride: number;
}

/** Upstream `Mesh`'s decoding state, the vertex attributes it fills in. */
class Decoder {
  vertexCount: number;
  vertices?: Float32Array;
  normals?: Float32Array;
  tangents?: Float32Array;
  colors?: Float32Array;
  readonly uv: (Float32Array | undefined)[] = new Array<undefined>(8).fill(undefined);
  skin?: VertexBoneWeights[];
  /** Upstream `m_IndexBuffer`, as numbers. */
  private indexBuffer: Uint32Array;

  constructor(
    private readonly mesh: Mesh,
    private readonly reader: ObjectReader,
  ) {
    this.vertexCount = mesh.m_VertexData.m_VertexCount;
    this.indexBuffer = this.readIndexBuffer();
  }

  /** `Mesh <pathId>`, for error messages. */
  private get owner(): string {
    return `Mesh ${this.reader.pathId}`;
  }

  /** Upstream's `m_IndexBuffer`: `UInt16` or `UInt32` values in the file's byte order. */
  private readIndexBuffer(): Uint32Array {
    const bytes = this.mesh.m_IndexBuffer;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = this.reader.endian === "little";
    // 2017.4+: m_IndexFormat 0 is 16-bit, anything else 32-bit.
    const size = this.mesh.m_IndexFormat === 0 ? 2 : 4;
    const out = new Uint32Array(Math.floor(bytes.length / size));
    for (let i = 0; i < out.length; i++) {
      out[i] = size === 2 ? view.getUint16(i * 2, little) : view.getUint32(i * 4, little);
    }
    return out;
  }

  /** Upstream `VertexData.GetStreams`: each stream's channels, start and stride. */
  private streams(): VertexStream[] {
    const { m_VertexCount: count, m_Channels: channels } = this.mesh.m_VertexData;
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
        stride += dimension * this.formatSize(channel.format, chn);
      });
      out.push({ channelMask, offset, stride });
      // UInt32 arithmetic, as upstream's; each stream starts 16-byte aligned.
      offset = (offset + Math.imul(count, stride)) >>> 0;
      offset = ((offset + 15) & ~15) >>> 0;
    }
    return out;
  }

  /** Bytes per component of a vertex format (upstream `MeshHelper.GetFormatSize`). */
  private formatSize(format: number, chn: number): number {
    const size = FORMAT_SIZE[format];
    if (size === undefined) {
      throw new UnsupportedError("vertex format", format, `${this.owner} channel ${chn}`);
    }
    return size;
  }

  /** Upstream `ReadVertexData`, for the 2018+ channel numbering. */
  readVertexStreams(bytes: Uint8Array): void {
    const streams = this.streams();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = this.reader.endian === "little";
    const count = this.vertexCount;
    this.mesh.m_VertexData.m_Channels.forEach((channel, chn) => {
      const dimension = channel.dimension & 0xf;
      if (dimension === 0) return;
      const stream = streams[channel.stream]!;
      if (((stream.channelMask >>> chn) & 1) === 0) return;
      const format = channel.format;
      const size = this.formatSize(format, chn);
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
      this.assign(chn, dimension, format, isInt ? undefined : (values as Float32Array), values);
    });
  }

  /**
   * Upstream's switch on the channel (2018+ numbering): an attribute takes
   * the float components, so an integer format leaves it `undefined`.
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
      const skin = (this.skin ??= newSkin(this.vertexCount));
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
   * Upstream `DecompressCompressedMesh`, from 5.0: each non-empty vector
   * replaces its attribute.
   */
  decompress(): void {
    const packed = this.mesh.m_CompressedMesh;
    if (packed.m_Vertices.m_NumItems > 0) {
      this.vertexCount = Math.trunc(packed.m_Vertices.m_NumItems / 3);
      this.vertices = this.unpackFloats(packed.m_Vertices, "m_Vertices", 3);
    }
    if (packed.m_UV.m_NumItems > 0) this.decompressUV(packed);
    if (packed.m_Normals.m_NumItems > 0) {
      const signs = this.unpackInts(packed.m_NormalSigns, "m_NormalSigns");
      this.normals = this.decompressDirections(packed.m_Normals, "m_Normals", signs, 1, 3);
    }
    if (packed.m_Tangents.m_NumItems > 0) {
      const signs = this.unpackInts(packed.m_TangentSigns, "m_TangentSigns");
      this.tangents = this.decompressDirections(packed.m_Tangents, "m_Tangents", signs, 2, 4);
    }
    if (packed.m_FloatColors.m_NumItems > 0) {
      this.colors = this.unpackFloats(packed.m_FloatColors, "m_FloatColors", 1);
    }
    if (packed.m_Weights.m_NumItems > 0) this.decompressSkin(packed);
    if (packed.m_Triangles.m_NumItems > 0) {
      this.indexBuffer = Uint32Array.from(this.unpackInts(packed.m_Triangles, "m_Triangles"));
    }
  }

  /** The UV channels of a compressed mesh, by `m_UVInfo`, or UV0 and UV1 without it. */
  private decompressUV(packed: CompressedMesh): void {
    const count = this.vertexCount;
    const info = packed.m_UVInfo;
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
  private subMeshTriangles(subMesh: SubMesh, i: number): Uint32Array {
    const buffer = this.indexBuffer;
    // UInt32 division, as upstream's: firstByte over the index size.
    const first = Math.floor(subMesh.firstByte / (this.mesh.m_IndexFormat === 0 ? 2 : 4));
    const { indexCount, topology } = subMesh;
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
