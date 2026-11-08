// Ported from AssetStudio/Classes/Renderer.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/MeshRenderer.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/SkinnedMeshRenderer.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { animationLayoutVersion, readBool, readFloat3, readFloats } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import {
  assumingLayout,
  endOfObject,
  readArray,
  readVector4,
  type AABB,
  type Vector4,
} from "./Sprite.js";
import { atLeast } from "./version.js";

/** Which submeshes of a statically batched mesh a renderer draws (Unity's `StaticBatchInfo`). */
export interface StaticBatchInfo {
  firstSubMesh: number;
  subMeshCount: number;
}

/**
 * The fields every renderer component starts with (Unity's `Renderer`), as a
 * player build stores them, under Unity's names. The byte-sized settings are
 * kept as the numbers the file holds (Unity's enums: `m_CastShadows` is a
 * `ShadowCastingMode`, `m_LightProbeUsage` a `LightProbeUsage`, ...).
 */
export interface Renderer extends EditorExtension {
  /** The GameObject it is attached to. */
  m_GameObject: PPtr;
  m_Enabled: boolean;
  /** Unity's `ShadowCastingMode`: 0 off, 1 on, 2 two sided, 3 shadows only. */
  m_CastShadows: number;
  m_ReceiveShadows: number;
  m_DynamicOccludee: number;
  /** Unity 2021.1 and later. */
  m_StaticShadowCaster?: number;
  /** Unity's `MotionVectorGenerationMode`. */
  m_MotionVectors: number;
  m_LightProbeUsage: number;
  m_ReflectionProbeUsage: number;
  /** Unity 2019.3 and later. */
  m_RayTracingMode?: number;
  /** Unity 2020.1 and later. */
  m_RayTraceProcedural?: number;
  /** Unity 2023.2 and later. */
  m_RayTracingAccelStructBuildFlagsOverride?: number;
  /** Unity 2023.2 and later. */
  m_RayTracingAccelStructBuildFlags?: number;
  /** Unity 2023.3 (6000.0) and later. */
  m_SmallMeshCulling?: number;
  /** Unity 6000.2 and later. */
  m_ForceMeshLod?: number;
  /** Unity 6000.2 and later. */
  m_MeshLodSelectionBias?: number;
  m_RenderingLayerMask: number;
  m_RendererPriority: number;
  /** 65535 when the renderer has no lightmap. */
  m_LightmapIndex: number;
  m_LightmapIndexDynamic: number;
  m_LightmapTilingOffset: Vector4;
  m_LightmapTilingOffsetDynamic: Vector4;
  m_Materials: PPtr[];
  m_StaticBatchInfo: StaticBatchInfo;
  m_StaticBatchRoot: PPtr;
  m_ProbeAnchor: PPtr;
  m_LightProbeVolumeOverride: PPtr;
  m_SortingLayerID: number;
  m_SortingLayer: number;
  m_SortingOrder: number;
  /** Unity's `SpriteMaskInteraction`. Unity 6000.3 and later. */
  m_MaskInteraction?: number;
}

/**
 * The fields of a `MeshRenderer` component: {@link Renderer}'s, then its own,
 * agreeing with `readTypeTree()` on the same object.
 */
export interface MeshRenderer extends Renderer {
  m_AdditionalVertexStreams: PPtr;
  /** Unity 2020.1 and later. */
  m_EnlightenVertexStream?: PPtr;
}

/**
 * The fields of a `SkinnedMeshRenderer` component: {@link Renderer}'s, then
 * its own, agreeing with `readTypeTree()` on the same object.
 */
export interface SkinnedMeshRenderer extends Renderer {
  /** Unity's `SkinQuality`: 0 auto, 1, 2 or 4 bones. */
  m_Quality: number;
  m_UpdateWhenOffscreen: boolean;
  m_SkinnedMotionVectors: boolean;
  /** The skinned `Mesh`. */
  m_Mesh: PPtr;
  /** The bone Transforms, in the order of the mesh's bind poses. */
  m_Bones: PPtr[];
  /** One weight per blend shape of the mesh, 0 to 100. */
  m_BlendShapeWeights: number[];
  m_RootBone: PPtr;
  /** The bounds, relative to the root bone. */
  m_AABB: AABB;
  m_DirtyAABB: boolean;
}

/**
 * Read a `MeshRenderer` from the object's first byte: the {@link Renderer}
 * fields (see {@link readSkinnedMeshRenderer} for where they come from), then
 * `m_AdditionalVertexStreams` and, from 2020.1, `m_EnlightenVertexStream`,
 * which upstream lacks (TPK). The object must end exactly there.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields do not fit
 *   2019's layout. Of kind `"build target"` for an editor file
 *   (`BuildTarget.NoTarget`)
 * @throws {CorruptError} when the object ends early or bytes are left over
 *   after the last field, with the version known
 */
export function readMeshRenderer(reader: ObjectReader): MeshRenderer {
  const version = animationLayoutVersion(reader, "MeshRenderer");
  const out: Partial<MeshRenderer> = readEditorExtension(reader);
  assumingLayout(reader, "MeshRenderer", () => {
    readRendererFields(reader, version, out, "MeshRenderer");
    out.m_AdditionalVertexStreams = readPPtr(reader);
    // 2020.1+ (TPK; upstream lacks it).
    if (atLeast(version, 2020, 1)) out.m_EnlightenVertexStream = readPPtr(reader);
    endOfObject(reader, "MeshRenderer");
  });
  // Every required field was set above.
  return out as MeshRenderer;
}

/**
 * Read a `SkinnedMeshRenderer` from the object's first byte: the
 * {@link Renderer} fields, then the skin's. The object must end exactly there.
 *
 * Every field comes from Unity's own player type trees for the version (as
 * UnityPy's TPK data records them), in their order. Upstream (2019.1 on)
 * reads the same bytes but skips several fields and lacks the later ones;
 * what differs here:
 *
 * - `m_SortingLayerID` is an `int` (upstream: `UInt32`), and `m_SortingLayer`
 *   (an `SInt16` upstream skips, its alignment covering the bytes) is read;
 * - fields upstream lacks: `m_RayTracingAccelStructBuildFlagsOverride` and
 *   `m_RayTracingAccelStructBuildFlags` (2023.2), `m_SmallMeshCulling`
 *   (2023.3), `m_ForceMeshLod` and `m_MeshLodSelectionBias` (6000.2) and
 *   `m_MaskInteraction` (6000.3);
 * - `m_RootBone`, `m_AABB` and `m_DirtyAABB`, which upstream reads only for
 *   one game's files, are Unity's own fields at every version.
 *
 * Upstream's game-specific fields are not Unity's and are not read.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), as
 * upstream's do. TPK records 2020.1.0a7 without `m_RayTraceProcedural`;
 * such a pre-release fails the end-of-object check.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields do not fit
 *   2019's layout. Of kind `"build target"` for an editor file
 *   (`BuildTarget.NoTarget`)
 * @throws {CorruptError} when the object ends early or bytes are left over
 *   after the last field, with the version known
 */
export function readSkinnedMeshRenderer(reader: ObjectReader): SkinnedMeshRenderer {
  const owner = "SkinnedMeshRenderer";
  const version = animationLayoutVersion(reader, owner);
  const out: Partial<SkinnedMeshRenderer> = readEditorExtension(reader);
  assumingLayout(reader, owner, () => {
    readRendererFields(reader, version, out, owner);
    out.m_Quality = reader.readInt32();
    out.m_UpdateWhenOffscreen = readBool(reader);
    out.m_SkinnedMotionVectors = readBool(reader);
    reader.align();
    out.m_Mesh = readPPtr(reader);
    out.m_Bones = readArray(reader, owner, "m_Bones", readPPtr);
    out.m_BlendShapeWeights = readFloats(reader, owner, "m_BlendShapeWeights");
    out.m_RootBone = readPPtr(reader);
    out.m_AABB = { m_Center: readFloat3(reader), m_Extent: readFloat3(reader) };
    out.m_DirtyAABB = readBool(reader);
    reader.align();
    endOfObject(reader, owner);
  });
  // Every required field was set above.
  return out as SkinnedMeshRenderer;
}

/** The `Renderer` fields, from `m_GameObject` on, into `out` in Unity's order. */
function readRendererFields(
  reader: ObjectReader,
  version: UnityVersion,
  out: Partial<Renderer>,
  owner: string,
): void {
  out.m_GameObject = readPPtr(reader);
  out.m_Enabled = readBool(reader);
  out.m_CastShadows = reader.readUInt8();
  out.m_ReceiveShadows = reader.readUInt8();
  out.m_DynamicOccludee = reader.readUInt8();
  // 2021.1+
  if (atLeast(version, 2021, 1)) out.m_StaticShadowCaster = reader.readUInt8();
  out.m_MotionVectors = reader.readUInt8();
  out.m_LightProbeUsage = reader.readUInt8();
  out.m_ReflectionProbeUsage = reader.readUInt8();
  // 2019.3+
  if (atLeast(version, 2019, 3)) out.m_RayTracingMode = reader.readUInt8();
  // 2020.1+
  if (atLeast(version, 2020, 1)) out.m_RayTraceProcedural = reader.readUInt8();
  // 2023.2+ and 2023.3+ (TPK; upstream lacks them)
  if (atLeast(version, 2023, 2)) {
    out.m_RayTracingAccelStructBuildFlagsOverride = reader.readUInt8();
    out.m_RayTracingAccelStructBuildFlags = reader.readUInt8();
  }
  if (atLeast(version, 2023, 3)) out.m_SmallMeshCulling = reader.readUInt8();
  reader.align();
  // 6000.2+ (TPK; upstream lacks them)
  if (atLeast(version, 6000, 2)) {
    out.m_ForceMeshLod = reader.readInt16();
    reader.align();
    out.m_MeshLodSelectionBias = reader.readFloat32();
  }
  out.m_RenderingLayerMask = reader.readUInt32();
  out.m_RendererPriority = reader.readInt32();
  out.m_LightmapIndex = reader.readUInt16();
  out.m_LightmapIndexDynamic = reader.readUInt16();
  out.m_LightmapTilingOffset = readVector4(reader);
  out.m_LightmapTilingOffsetDynamic = readVector4(reader);
  out.m_Materials = readArray(reader, owner, "m_Materials", readPPtr);
  out.m_StaticBatchInfo = {
    firstSubMesh: reader.readUInt16(),
    subMeshCount: reader.readUInt16(),
  };
  out.m_StaticBatchRoot = readPPtr(reader);
  out.m_ProbeAnchor = readPPtr(reader);
  out.m_LightProbeVolumeOverride = readPPtr(reader);
  out.m_SortingLayerID = reader.readInt32();
  out.m_SortingLayer = reader.readInt16();
  out.m_SortingOrder = reader.readInt16();
  // 6000.3+ (TPK; upstream lacks it)
  if (atLeast(version, 6000, 3)) out.m_MaskInteraction = reader.readInt32();
}
