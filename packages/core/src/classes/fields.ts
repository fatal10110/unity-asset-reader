// The TypeScript-style shapes of `asset.data` (#184): the low-level reader
// results (`obj.read()`) under camelCase names without Unity's `m_` prefix.
// Not a port: a renaming on top of the ported readers, which keep Unity's
// names because the UnityPy goldens and upstream compare against them.
//
// Naming: `<UnityType>Fields` is the friendly form of the low-level
// `<UnityType>`. Every renamed field cites its Unity name in its JSDoc.

import type { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader, Vector3 } from "../serialized/ObjectReader.js";
import type { TypeTreeObject } from "../serialized/TypeTreeReader.js";
import type {
  AssetBundle,
  AssetBundleScriptInfo,
  AssetInfo,
} from "./AssetBundle.js";
import type { AudioClipData } from "./AudioClip.js";
import type { EditorExtension } from "./EditorExtension.js";
import type { CharacterInfo, Font, Rectf } from "./Font.js";
import type {
  CompressedMesh,
  MeshData,
  MeshLodInfo,
  MinMaxAABB,
  PackedFloatVector,
  PackedIntVector,
  VertexBoneWeights,
} from "./Mesh.js";
import type {
  BuildTextureStackReference,
  Color,
  Material,
  UnityPropertySheet,
  UnityTexEnv,
  Vector2,
} from "./Material.js";
import type { MonoScript, Hash128 } from "./MonoScript.js";
import type { MovieTexture } from "./MovieTexture.js";
import type { NamedObject } from "./NamedObject.js";
import type { PPtr } from "./PPtr.js";
import type { MonoBehaviourData, Texture2DData } from "./registry.js";
import type {
  Binding,
  BufferBinding,
  MatrixParameter,
  ProgramParameters,
  SerializedPass,
  SerializedProgram,
  SerializedProperty,
  SerializedShader,
  SerializedShaderState,
  SerializedSubProgram,
  SerializedTagMap,
  Shader,
  ShaderBindChannel,
  VectorParameter,
} from "./Shader.js";
import type {
  AABB,
  BlendShapeData,
  BoneWeights4,
  ChannelInfo,
  GUID,
  Matrix4x4,
  SecondarySpriteTexture,
  Sprite,
  SpriteBone,
  SpriteRenderData,
  SpriteVertex,
  SubMesh,
  Vector4,
  VertexData,
} from "./Sprite.js";
import type { SpriteAtlas, SpriteAtlasData, SpriteInstanceData } from "./SpriteAtlas.js";
import { textAssetString, type TextAsset } from "./TextAsset.js";
import type { Texture } from "./Texture.js";
import type { GLTextureSettings, StreamingInfo } from "./Texture2D.js";
import type { TextureFormat } from "./TextureFormat.js";
import type { StreamedResource, VideoClipData } from "./VideoClip.js";

// ---------------------------------------------------------------------------
// Shared bases

/**
 * The fields every object of an editor file (`BuildTarget.NoTarget`) starts
 * with; a player build stores none of them, and then they are absent.
 */
export interface EditorExtensionFields {
  /** Unity: `m_ObjectHideFlags`. Editor file only. */
  objectHideFlags?: number;
  /** Unity: `m_ExtensionPtr`. Editor file, Unity 3.4 only. */
  extensionPtr?: PPtr;
  /** Unity: `m_PrefabParentObject`. Editor file, Unity 3.5 to 2018.1. */
  prefabParentObject?: PPtr;
  /**
   * Unity: `m_CorrespondingSourceObject`. Editor file, Unity 2018.2 and later:
   * `prefabParentObject` renamed.
   */
  correspondingSourceObject?: PPtr;
  /** Unity: `m_PrefabInternal`. Editor file, Unity 3.5 to 2018.2. */
  prefabInternal?: PPtr;
  /** Unity: `m_PrefabInstance`. Editor file, Unity 2018.3 and later. */
  prefabInstance?: PPtr;
  /** Unity: `m_PrefabAsset`. Editor file, Unity 2018.3 and later. */
  prefabAsset?: PPtr;
}

/** {@link EditorExtensionFields} and the object's name. */
export interface NamedObjectFields extends EditorExtensionFields {
  /** Unity: `m_Name`. */
  name: string;
}

/** The fields every texture class starts with (Unity's `Texture`). */
export interface TextureFields extends NamedObjectFields {
  /** Unity: `m_ForcedFallbackFormat`. Unity 2017.3 to 2023.1. */
  forcedFallbackFormat?: TextureFormat;
  /** Unity: `m_DownscaleFallback`. Unity 2017.3 to 2023.1. */
  downscaleFallback?: boolean;
  /** Unity: `m_IsAlphaChannelOptional`. Unity 2020.2 and later. */
  isAlphaChannelOptional?: boolean;
}

// ---------------------------------------------------------------------------
// AssetBundle

/** The friendly form of {@link AssetBundle}. */
export interface AssetBundleFields extends NamedObjectFields {
  /**
   * Unity: `m_PreloadTable`. Every object the bundle's assets need, their
   * dependencies included.
   */
  preloadTable: PPtr[];
  /**
   * Unity: `m_Container`. Asset path (`"assets/ui/logo.png"`, lower-cased by
   * Unity) to asset, in the order Unity wrote them; a path may repeat.
   */
  container: [string, AssetInfo][];
  /** Unity: `m_MainAsset`. */
  mainAsset: AssetInfo;
  /** Unity: `m_ScriptCompatibility`. Unity 3.4 to 4.x. */
  scriptCompatibility?: AssetBundleScriptInfo[];
  /** Unity: `m_ClassCompatibility`. Unity 3.5 to 4.x: class id to class version. */
  classCompatibility?: [number, number][];
  /** Unity: `m_ClassVersionMap`. Unity 5.4 only: class id to class version. */
  classVersionMap?: [number, number][];
  /** Unity: `m_RuntimeCompatibility`. Unity 4.2 and later. */
  runtimeCompatibility?: number;
  /** Unity: `m_AssetBundleName`. Unity 5.0 and later. */
  assetBundleName?: string;
  /** Unity: `m_Dependencies`. Unity 5.0 and later: the bundles this one needs. */
  dependencies?: string[];
  /** Unity: `m_IsStreamedSceneAssetBundle`. Unity 5.0 and later. */
  isStreamedSceneAssetBundle?: boolean;
  /** Unity: `m_ExplicitDataLayout`. Unity 2017.3 and later. */
  explicitDataLayout?: number;
  /** Unity: `m_PathFlags`. Unity 2017.1 and later. */
  pathFlags?: number;
  /** Unity: `m_SceneHashes`. Unity 2017.3 and later: scene path to scene hash. */
  sceneHashes?: [string, string][];
}

/**
 * An `AssetBundle` as {@link AssetBundleFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toAssetBundleFields(data: AssetBundle): AssetBundleFields {
  return defined({
    ...namedObject(data),
    preloadTable: data.m_PreloadTable,
    container: data.m_Container,
    mainAsset: data.m_MainAsset,
    scriptCompatibility: data.m_ScriptCompatibility,
    classCompatibility: data.m_ClassCompatibility,
    classVersionMap: data.m_ClassVersionMap,
    runtimeCompatibility: data.m_RuntimeCompatibility,
    assetBundleName: data.m_AssetBundleName,
    dependencies: data.m_Dependencies,
    isStreamedSceneAssetBundle: data.m_IsStreamedSceneAssetBundle,
    explicitDataLayout: data.m_ExplicitDataLayout,
    pathFlags: data.m_PathFlags,
    sceneHashes: data.m_SceneHashes,
  });
}

// ---------------------------------------------------------------------------
// TextAsset

/** The friendly form of {@link TextAsset}, with its content decoded too. */
export interface TextAssetFields extends NamedObjectFields {
  /**
   * Unity: `m_Script`. The file's content as it is stored (`.txt`, `.json`,
   * `.bytes`, ...), a view into the object's bytes (R7).
   */
  bytes: Uint8Array;
  /**
   * `bytes` decoded as UTF-8 by {@link textAssetString}: invalid sequences
   * become U+FFFD. Decoded on first access and kept, so a binary TextAsset
   * costs nothing until it is asked for.
   */
  readonly text: string;
  /** Unity: `m_PathName`. Unity 3.4 to 2017.1 only: the source asset's path. */
  pathName?: string;
}

/**
 * A `TextAsset` as {@link TextAssetFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toTextAssetFields(data: TextAsset): TextAssetFields {
  let text: string | undefined;
  const out: TextAssetFields = {
    ...namedObject(data),
    bytes: data.m_Script,
    get text(): string {
      text ??= textAssetString(data);
      return text;
    },
  };
  if (data.m_PathName !== undefined) out.pathName = data.m_PathName;
  return out;
}

// ---------------------------------------------------------------------------
// MonoBehaviour

/** The friendly form of {@link MonoBehaviourData}: the header, and the script's fields apart. */
export interface MonoBehaviourFields extends EditorExtensionFields {
  /**
   * Unity: `m_GameObject`. The GameObject it is attached to; a null pointer
   * for a ScriptableObject.
   */
  gameObject: PPtr;
  /** Unity: `m_Enabled`, a `UInt8`: `true` when it is not 0. */
  enabled: boolean;
  /** Unity: `m_EditorHideFlags`. Editor file only. */
  editorHideFlags?: number;
  /** Unity: `m_Script`. The `MonoScript` naming its C# class. */
  script: PPtr;
  /** Unity: `m_Name`. The asset's name; `""` for a component on a GameObject. */
  name: string;
  /** Unity: `m_EditorClassIdentifier`. Editor file, Unity 4.2 and later. */
  editorClassIdentifier?: string;
  /**
   * The script's own serialized fields, under the names the script gives
   * them: the object's type tree without the header fields above. Absent
   * when the file has no type tree, which is the only way to read them here
   * (see {@link MonoBehaviourData}).
   */
  fields?: TypeTreeObject;
}

/** The {@link MonoBehaviourData} keys that are header, not the script's fields. */
const MONO_BEHAVIOUR_HEADER: ReadonlySet<string> = new Set([
  "m_ObjectHideFlags",
  "m_ExtensionPtr",
  "m_PrefabParentObject",
  "m_CorrespondingSourceObject",
  "m_PrefabInternal",
  "m_PrefabInstance",
  "m_PrefabAsset",
  "m_GameObject",
  "m_Enabled",
  "m_EditorHideFlags",
  "m_Script",
  "m_Name",
  "m_EditorClassIdentifier",
]);

/**
 * A `MonoBehaviour` as {@link MonoBehaviourFields}.
 *
 * @param data what `obj.read()` returns for the object
 * @param reader the object it was read from: its type tree, or the lack of
 *   one, tells whether `data` holds the script's fields (a script with no
 *   fields and a file without type trees give the same keys)
 */
export function toMonoBehaviourFields(
  data: MonoBehaviourData,
  reader: ObjectReader,
): MonoBehaviourFields {
  const out: MonoBehaviourFields = defined({
    ...editorExtension(data),
    gameObject: data.m_GameObject,
    enabled: data.m_Enabled !== 0,
    editorHideFlags: data.m_EditorHideFlags as number | undefined,
    script: data.m_Script,
    name: data.m_Name,
    editorClassIdentifier: data.m_EditorClassIdentifier as string | undefined,
  });
  const nodes = reader.serializedType?.nodes;
  if (nodes && nodes.length > 0) {
    // With a type tree, `data` is `readTypeTree()`'s result: every value past
    // the header is a TypeTreeValue.
    const entries = Object.entries(data).filter(([key]) => !MONO_BEHAVIOUR_HEADER.has(key));
    out.fields = Object.fromEntries(entries) as TypeTreeObject;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MonoScript

/** The friendly form of {@link MonoScript}. */
export interface MonoScriptFields extends NamedObjectFields {
  /** Unity: `m_ExecutionOrder`. */
  executionOrder: number;
  /**
   * Unity: `m_PropertiesHash`. A `UInt32` before Unity 5.0, a {@link Hash128}
   * from 5.0: the hash of the class's serialized fields.
   */
  propertiesHash: number | Hash128;
  /** Unity: `m_ClassName`. The C# class name, without its namespace. */
  className: string;
  /** Unity: `m_Namespace`. `""` for the global namespace. */
  namespace: string;
  /** Unity: `m_AssemblyName`. Such as `"Assembly-CSharp.dll"`. */
  assemblyName: string;
  /** Unity: `m_IsEditorScript`. Before Unity 2018.2. */
  isEditorScript?: boolean;
}

/**
 * A `MonoScript` as {@link MonoScriptFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMonoScriptFields(data: MonoScript): MonoScriptFields {
  return defined({
    ...namedObject(data),
    executionOrder: data.m_ExecutionOrder,
    propertiesHash: data.m_PropertiesHash,
    className: data.m_ClassName,
    namespace: data.m_Namespace,
    assemblyName: data.m_AssemblyName,
    isEditorScript: data.m_IsEditorScript,
  });
}

// ---------------------------------------------------------------------------
// Material

/** The friendly form of {@link UnityTexEnv}: one texture slot of a material. */
export interface UnityTexEnvFields {
  /** Unity: `m_Texture`. A null pointer (`m_PathID` 0) when the slot is empty. */
  texture: PPtr;
  /** Unity: `m_Scale`. Tiling. */
  scale: Vector2;
  /** Unity: `m_Offset`. */
  offset: Vector2;
}

/** The friendly form of {@link UnityPropertySheet}: a material's properties by name. */
export interface UnityPropertySheetFields {
  /** Unity: `m_TexEnvs`. Texture slots, such as `"_MainTex"`. */
  texEnvs: [string, UnityTexEnvFields][];
  /** Unity: `m_Ints`. Unity 2021.1 and later: properties declared `Integer`. */
  ints?: [string, number][];
  /** Unity: `m_Floats`. */
  floats: [string, number][];
  /** Unity: `m_Colors`. */
  colors: [string, Color][];
}

/** The friendly form of {@link Material}. */
export interface MaterialFields extends NamedObjectFields {
  /** Unity: `m_Shader`. Usually in another file (a dependency bundle or built-in resources). */
  shader: PPtr;
  /**
   * Unity: `m_ShaderKeywords`. The enabled keywords: a list in Unity 4.1 to
   * 4.x, one space-separated string from 5.0 until 2021.2.18.
   */
  shaderKeywords?: string | string[];
  /** Unity: `m_ValidKeywords`. Unity 2021.2.18 and later. */
  validKeywords?: string[];
  /** Unity: `m_InvalidKeywords`. Unity 2021.2.18 and later. */
  invalidKeywords?: string[];
  /** Unity: `m_LightmapFlags`. Unity 5.0 and later: `MaterialGlobalIlluminationFlags`. */
  lightmapFlags?: number;
  /** Unity: `m_EnableInstancingVariants`. Unity 5.6 and later. */
  enableInstancingVariants?: boolean;
  /** Unity: `m_DoubleSidedGI`. Unity 5.6.2 and later. */
  doubleSidedGI?: boolean;
  /** Unity: `m_CustomRenderQueue`. Unity 4.3 and later: -1 for the shader's own. */
  customRenderQueue?: number;
  /** Unity 5.1 and later: override tags, tag name to value. */
  stringTagMap?: [string, string][];
  /** Unity 5.6 and later: the `LightMode` of each disabled pass. */
  disabledShaderPasses?: string[];
  /** Unity: `m_SavedProperties`. */
  savedProperties: UnityPropertySheetFields;
  /** Unity: `m_BuildTextureStacks`. Unity 2020.1 and later. */
  buildTextureStacks?: BuildTextureStackReference[];
}

/**
 * A `Material` as {@link MaterialFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMaterialFields(data: Material): MaterialFields {
  const sheet = data.m_SavedProperties;
  return defined({
    ...namedObject(data),
    shader: data.m_Shader,
    shaderKeywords: data.m_ShaderKeywords,
    validKeywords: data.m_ValidKeywords,
    invalidKeywords: data.m_InvalidKeywords,
    lightmapFlags: data.m_LightmapFlags,
    enableInstancingVariants: data.m_EnableInstancingVariants,
    doubleSidedGI: data.m_DoubleSidedGI,
    customRenderQueue: data.m_CustomRenderQueue,
    stringTagMap: data.stringTagMap,
    disabledShaderPasses: data.disabledShaderPasses,
    savedProperties: defined({
      texEnvs: sheet.m_TexEnvs.map(([name, env]): [string, UnityTexEnvFields] => [
        name,
        { texture: env.m_Texture, scale: env.m_Scale, offset: env.m_Offset },
      ]),
      ints: sheet.m_Ints,
      floats: sheet.m_Floats,
      colors: sheet.m_Colors,
    }),
    buildTextureStacks: data.m_BuildTextureStacks,
  });
}

// ---------------------------------------------------------------------------
// Shader

/** The friendly form of {@link SerializedShaderState}: a pass's render state. */
export interface SerializedShaderStateFields
  extends Omit<SerializedShaderState, "m_Name" | "m_Tags" | "m_LOD"> {
  /** Unity: `m_Name`. The pass's name, as written in the shader. */
  name: string;
  /** Unity: `m_Tags`. */
  tags: SerializedTagMap;
  /** Unity: `m_LOD`. */
  lod: number;
}

/** The friendly form of {@link VectorParameter}. */
export interface VectorParameterFields {
  /** Unity: `m_NameIndex`. */
  nameIndex: number;
  /** Unity: `m_Index`. Before Unity 6000.6. */
  index?: number;
  /** Unity: `m_OffsetInConstantBuffer`. Unity 6000.6 and later: `index` renamed. */
  offsetInConstantBuffer?: number;
  /** Unity: `m_ArraySize`. */
  arraySize: number;
  /** Unity: `m_Type`. */
  type: number;
  /** Unity: `m_Dim`. */
  dim: number;
}

/** The friendly form of {@link MatrixParameter}. */
export interface MatrixParameterFields extends Omit<VectorParameterFields, "dim"> {
  /** Unity: `m_RowCount`. */
  rowCount: number;
}

/** The friendly form of {@link StructParameter}. */
export interface StructParameterFields extends Omit<VectorParameterFields, "type" | "dim"> {
  /** Unity: `m_StructSize`. */
  structSize: number;
  /** Unity: `m_VectorMembers`. */
  vectorMembers: VectorParameterFields[];
  /** Unity: `m_MatrixMembers`. */
  matrixMembers: MatrixParameterFields[];
}

/** The friendly form of {@link Binding}. */
export interface BindingFields {
  /** Unity: `m_EncodedData`. */
  encodedData: number;
  /** Unity: `m_Slot`. */
  slot: number;
}

/** The friendly form of {@link TextureParameter}. */
export interface TextureParameterFields {
  /** Unity: `m_NameIndex`. */
  nameIndex: number;
  /** Unity: `m_Index`. Before Unity 6000.6. */
  index?: number;
  /** Unity: `m_SamplerIndex`. Before Unity 6000.6. */
  samplerIndex?: number;
  /** Unity: `m_Binding`. Unity 6000.6 and later. */
  binding?: BindingFields;
  /** Unity: `m_SamplerBinding`. Unity 6000.6 and later. */
  samplerBinding?: BindingFields;
  /** Unity: `m_MultiSampled`. */
  multiSampled: boolean;
  /** Unity: `m_Dim`. */
  dim: number;
}

/** The friendly form of {@link BufferBinding}. */
export interface BufferBindingFields {
  /** Unity: `m_NameIndex`. */
  nameIndex: number;
  /** Unity: `m_Index`. Before Unity 6000.6. */
  index?: number;
  /** Unity: `m_Binding`. Unity 6000.6 and later. */
  binding?: BindingFields;
  /** Unity: `m_ArraySize`. Unity 2020.1 and later. */
  arraySize?: number;
  /** Unity: `m_ResourceType`. Unity 6000.6 and later. */
  resourceType?: number;
}

/** The friendly form of {@link ConstantBuffer}. */
export interface ConstantBufferFields {
  /** Unity: `m_NameIndex`. */
  nameIndex: number;
  /** Unity: `m_MatrixParams`. */
  matrixParams: MatrixParameterFields[];
  /** Unity: `m_VectorParams`. */
  vectorParams: VectorParameterFields[];
  /** Unity: `m_StructParams`. */
  structParams: StructParameterFields[];
  /** Unity: `m_Size`. */
  size: number;
  /** Unity: `m_IsPartialCB`. Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later. */
  isPartialCB?: boolean;
}

/** The friendly form of {@link UAVParameter}. */
export interface UAVParameterFields {
  /** Unity: `m_NameIndex`. */
  nameIndex: number;
  /** Unity: `m_Index`. Before Unity 6000.6. */
  index?: number;
  /** Unity: `m_OriginalIndex`. Before Unity 6000.6. */
  originalIndex?: number;
  /** Unity: `m_Binding`. Unity 6000.6 and later. */
  binding?: BindingFields;
  /** Unity: `m_OriginalBinding`. Unity 6000.6 and later. */
  originalBinding?: BindingFields;
}

/** The friendly form of {@link SamplerParameter}. */
export interface SamplerParameterFields {
  sampler: number;
  /** Before Unity 6000.6. */
  bindPoint?: number;
  /** Unity: `m_Binding`. Unity 6000.6 and later. */
  binding?: BindingFields;
}

/** The friendly form of {@link ProgramParameters}. */
export interface ProgramParametersFields {
  /** Unity: `m_VectorParams`. */
  vectorParams: VectorParameterFields[];
  /** Unity: `m_MatrixParams`. */
  matrixParams: MatrixParameterFields[];
  /** Unity: `m_TextureParams`. */
  textureParams: TextureParameterFields[];
  /** Unity: `m_BufferParams`. */
  bufferParams: BufferBindingFields[];
  /** Unity: `m_ConstantBuffers`. */
  constantBuffers: ConstantBufferFields[];
  /** Unity: `m_ConstantBufferBindings`. */
  constantBufferBindings: BufferBindingFields[];
  /** Unity: `m_UAVParams`. */
  uavParams: UAVParameterFields[];
  /** Unity: `m_Samplers`. */
  samplers: SamplerParameterFields[];
}

/** The friendly form of {@link SerializedSubProgram}: one compiled variant of a stage. */
export interface SerializedSubProgramFields extends Partial<ProgramParametersFields> {
  /** Unity: `m_BlobIndex`. */
  blobIndex: number;
  /** Unity: `m_Channels`, with its `m_Channels` and `m_SourceMap`. */
  channels: { channels: ShaderBindChannel[]; sourceMap: number };
  /** Unity: `m_GlobalKeywordIndices`. Before Unity 2021.2. */
  globalKeywordIndices?: number[];
  /** Unity: `m_LocalKeywordIndices`. Before Unity 2021.2. */
  localKeywordIndices?: number[];
  /** Unity: `m_KeywordIndices`. Unity 2021.2 and later. */
  keywordIndices?: number[];
  /** Unity: `m_ShaderHardwareTier`. */
  shaderHardwareTier: number;
  /** Unity: `m_GpuProgramType`. */
  gpuProgramType: number;
  /** Unity: `m_Parameters`. Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later. */
  parameters?: ProgramParametersFields;
  /** Unity: `m_ShaderRequirements`. A `bigint` from Unity 2021.1. */
  shaderRequirements: number | bigint;
}

/** The friendly form of {@link SerializedPlayerSubProgram}. */
export interface SerializedPlayerSubProgramFields {
  /** Unity: `m_BlobIndex`. */
  blobIndex: number;
  /** Unity: `m_KeywordIndices`. */
  keywordIndices: number[];
  /** Unity: `m_ShaderRequirements`. */
  shaderRequirements: bigint;
  /** Unity: `m_GpuProgramType`. */
  gpuProgramType: number;
}

/** The friendly form of {@link SerializedProgram}: one stage of a pass, every variant. */
export interface SerializedProgramFields {
  /** Unity: `m_SubPrograms`. */
  subPrograms: SerializedSubProgramFields[];
  /** Unity: `m_PlayerSubPrograms`. Unity 2021.3.10+, 2022.1.13+ and 2022.2 and later. */
  playerSubPrograms?: SerializedPlayerSubProgramFields[][];
  /** Unity: `m_ParameterBlobIndices`. As `playerSubPrograms`. */
  parameterBlobIndices?: number[][];
  /** Unity: `m_CommonParameters`. Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later. */
  commonParameters?: ProgramParametersFields;
  /** Unity: `m_SerializedKeywordStateMask`. Unity 2022.1 and later. */
  serializedKeywordStateMask?: number[];
}

/** The friendly form of {@link SerializedPass}. */
export interface SerializedPassFields {
  /** Unity: `m_EditorDataHash`. Unity 2020.2 to 2022.x. */
  editorDataHash?: Hash128[];
  /** Unity: `m_Platforms`. Unity 2020.2 to 2022.x. */
  platforms?: Uint8Array;
  /** Unity: `m_LocalKeywordMask`. Unity 2020.2 to 2021.1. */
  localKeywordMask?: number[];
  /** Unity: `m_GlobalKeywordMask`. Unity 2020.2 to 2021.1. */
  globalKeywordMask?: number[];
  /** Unity: `m_NameIndices`. Parameter, buffer and keyword names to `nameIndex`. */
  nameIndices: [string, number][];
  /** Unity: `m_Type`. 0 normal, 1 `UsePass`, 2 `GrabPass`. */
  type: number;
  /** Unity: `m_State`. */
  state: SerializedShaderStateFields;
  /** Unity: `m_ProgramMask`. */
  programMask: number;
  progVertex: SerializedProgramFields;
  progFragment: SerializedProgramFields;
  progGeometry: SerializedProgramFields;
  progHull: SerializedProgramFields;
  progDomain: SerializedProgramFields;
  /** Unity 2019.3 and later. */
  progRayTracing?: SerializedProgramFields;
  /** Unity: `m_HasInstancingVariant`. */
  hasInstancingVariant: boolean;
  /** Unity: `m_HasProceduralInstancingVariant`. */
  hasProceduralInstancingVariant: boolean;
  /** Unity: `m_UseName`. For a `UsePass`, the pass it names. */
  useName: string;
  /** Unity: `m_Name`. */
  name: string;
  /** Unity: `m_TextureName`. For a `GrabPass`, the texture it grabs into. */
  textureName: string;
  /** Unity: `m_Tags`. */
  tags: SerializedTagMap;
  /** Unity: `m_SerializedKeywordStateMask`. Unity 2021.2 to 2021.x. */
  serializedKeywordStateMask?: number[];
}

/** The friendly form of {@link SerializedSubShader}. */
export interface SerializedSubShaderFields {
  /** Unity: `m_Passes`. */
  passes: SerializedPassFields[];
  /** Unity: `m_Tags`. */
  tags: SerializedTagMap;
  /** Unity: `m_LOD`. */
  lod: number;
}

/** The friendly form of {@link SerializedProperty}: a property of the `Properties` block. */
export interface SerializedPropertyFields {
  /** Unity: `m_Name`. */
  name: string;
  /** Unity: `m_Description`. */
  description: string;
  /** Unity: `m_Attributes`. */
  attributes: string[];
  /** Unity: `m_Type`. 0 Color, 1 Vector, 2 Float, 3 Range, 4 Texture, 5 Int. */
  type: number;
  /** Unity: `m_Flags`. */
  flags: number;
  /** Unity: `m_DefValue[0]`. The default value; for a `Range`, `[default, min, max, 0]`. */
  "defValue[0]": number;
  /** Unity: `m_DefValue[1]`. */
  "defValue[1]": number;
  /** Unity: `m_DefValue[2]`. */
  "defValue[2]": number;
  /** Unity: `m_DefValue[3]`. */
  "defValue[3]": number;
  /** Unity: `m_DefTexture`, with its `m_DefaultName` and `m_TexDim`. */
  defTexture: { defaultName: string; texDim: number };
}

/** The friendly form of {@link SerializedShader}: the parsed ShaderLab. */
export interface SerializedShaderFields {
  /** Unity: `m_PropInfo`, with its `m_Props`. */
  propInfo: { props: SerializedPropertyFields[] };
  /** Unity: `m_SubShaders`. */
  subShaders: SerializedSubShaderFields[];
  /** Unity: `m_KeywordNames`. Unity 2021.2 and later. */
  keywordNames?: string[];
  /** Unity: `m_KeywordFlags`. Unity 2021.2 and later. */
  keywordFlags?: Uint8Array;
  /** Unity: `m_Name`. The shader's name, such as `"UAR/ShaderFixture"`. */
  name: string;
  /** Unity: `m_CustomEditorName`. */
  customEditorName: string;
  /** Unity: `m_FallbackName`. */
  fallbackName: string;
  /** Unity: `m_Dependencies`. The `Dependency` lines. */
  dependencies: { from: string; to: string }[];
  /** Unity: `m_CustomEditorForRenderPipelines`. Unity 2021.1 and later. */
  customEditorForRenderPipelines?: { customEditorName: string; renderPipelineType: string }[];
  /** Unity: `m_DisableNoSubshadersMessage`. */
  disableNoSubshadersMessage: boolean;
}

/** The friendly form of {@link Shader}. */
export interface ShaderFields extends NamedObjectFields {
  /**
   * Unity: `m_ParsedForm`. The parsed ShaderLab, whose `name` is the
   * shader's (`name`, `m_Name`, is empty).
   */
  parsedForm: SerializedShaderFields;
  /** The `ShaderCompilerPlatform` of each part of `compressedBlob`. */
  platforms: number[];
  /** One offset per platform; from Unity 2019.3 a list of them per platform. */
  offsets: number[] | number[][];
  /** As `offsets`. */
  compressedLengths: number[] | number[][];
  /** As `offsets`. */
  decompressedLengths: number[] | number[][];
  /** Every platform's compiled programs. */
  compressedBlob: Uint8Array;
  /** Unity 2021.3.12 to 2021.3.x, 2022.1.21 to 2022.1.x, and 2022.2 and later. */
  stageCounts?: number[];
  /** Unity: `m_Dependencies`. */
  dependencies: PPtr[];
  /** Unity: `m_NonModifiableTextures`. Property name to texture. */
  nonModifiableTextures: [string, PPtr][];
  /** Unity: `m_ShaderIsBaked`. */
  shaderIsBaked: boolean;
  /** Unity: `m_AssetGUID`. Unity 6000.0 and later. */
  assetGUID?: GUID;
  /** Unity: `m_AssetLocalIdentifierInFile`. Unity 6000.3 and later. */
  assetLocalIdentifierInFile?: bigint;
}

/**
 * A `Shader` as {@link ShaderFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toShaderFields(data: Shader): ShaderFields {
  return defined({
    ...namedObject(data),
    parsedForm: serializedShader(data.m_ParsedForm),
    platforms: data.platforms,
    offsets: data.offsets,
    compressedLengths: data.compressedLengths,
    decompressedLengths: data.decompressedLengths,
    compressedBlob: data.compressedBlob,
    stageCounts: data.stageCounts,
    dependencies: data.m_Dependencies,
    nonModifiableTextures: data.m_NonModifiableTextures,
    shaderIsBaked: data.m_ShaderIsBaked,
    assetGUID: data.m_AssetGUID,
    assetLocalIdentifierInFile: data.m_AssetLocalIdentifierInFile,
  });
}

// ---------------------------------------------------------------------------
// Texture2D

/** The friendly form of {@link GLTextureSettings}: how a texture is sampled. */
export interface GLTextureSettingsFields {
  /** Unity: `m_FilterMode`. 0 point, 1 bilinear, 2 trilinear. */
  filterMode: number;
  /** Unity: `m_Aniso`. */
  aniso: number;
  /** Unity: `m_MipBias`. */
  mipBias: number;
  /** Unity: `m_WrapMode`. Before Unity 2017.1. */
  wrapMode?: number;
  /** Unity: `m_WrapU`. Unity 2017.1 and later. */
  wrapU?: number;
  /** Unity: `m_WrapV`. Unity 2017.1 and later. */
  wrapV?: number;
  /** Unity: `m_WrapW`. Unity 2017.1 and later. */
  wrapW?: number;
}

/**
 * The friendly form of {@link Texture2DData}: the header, the image bytes
 * wherever they were stored, and the platform they were built for.
 */
export interface Texture2DFields extends TextureFields {
  /** Unity: `m_Width`. */
  width: number;
  /** Unity: `m_Height`. */
  height: number;
  /** Unity: `m_CompleteImageSize`. Bytes of image data, all mip levels. */
  completeImageSize: number;
  /** Unity: `m_MipsStripped`. Unity 2020.1 and later. */
  mipsStripped?: number;
  /**
   * Unity: `m_TextureFormat`. The number the file holds, which may be one
   * `TextureFormat` does not name.
   */
  format: TextureFormat;
  /** Unity: `m_MipMap`. Before Unity 5.2: whether there are mip levels at all. */
  mipMap?: boolean;
  /** Unity: `m_MipCount`. Unity 5.2 and later. */
  mipCount?: number;
  /** Unity: `m_IsReadable`. Unity 2.6 and later. */
  isReadable?: boolean;
  /** Unity: `m_IsPreProcessed`. Unity 2019.4.9 and later. */
  isPreProcessed?: boolean;
  /** Unity: `m_IgnoreMasterTextureLimit`. Unity 2019.3 to 2022.1. */
  ignoreMasterTextureLimit?: boolean;
  /** Unity: `m_IgnoreMipmapLimit`. Unity 2022.2 and later. */
  ignoreMipmapLimit?: boolean;
  /** Unity: `m_MipmapLimitGroupName`. Unity 2022.2 and later. */
  mipmapLimitGroupName?: string;
  /** Unity: `m_ReadAllowed`. Unity 3.0 to 5.4. */
  readAllowed?: boolean;
  /** Unity: `m_StreamingMipmaps`. Unity 2018.2 and later. */
  streamingMipmaps?: boolean;
  /** Unity: `m_StreamingMipmapsPriority`. Unity 2018.2 and later. */
  streamingMipmapsPriority?: number;
  /** Unity: `m_ImageCount`. */
  imageCount: number;
  /** Unity: `m_TextureDimension`. */
  textureDimension: number;
  /** Unity: `m_TextureSettings`. */
  textureSettings: GLTextureSettingsFields;
  /** Unity: `m_LightmapFormat`. Unity 3.0 and later. */
  lightmapFormat?: number;
  /** Unity: `m_ColorSpace`. Unity 3.5 and later. */
  colorSpace?: number;
  /** Unity: `m_PlatformBlob`. Unity 2020.2 and later: a view into the object's bytes (R7). */
  platformBlob?: Uint8Array;
  /**
   * Unity: `m_StreamData`. Unity 5.3 and later: the byte range of a resource
   * file holding the image when it is not inline (an empty `path` otherwise).
   */
  streamData?: StreamingInfo;
  /**
   * The image, every mip level, still encoded in `format`: Unity's inline
   * `image data` when it is not empty, and otherwise the `streamData` bytes
   * (see {@link Texture2DData.imageData}). A view, never a copy (R7).
   */
  imageData: Uint8Array;
  /**
   * The platform the object's file was built for; not a Texture2D field
   * (see {@link Texture2DData.platform}).
   */
  platform: BuildTarget;
}

/**
 * A `Texture2D` as {@link Texture2DFields}. Unity's inline `image data` is
 * not carried over on its own: `imageData` is it whenever it holds anything.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toTexture2DFields(data: Texture2DData): Texture2DFields {
  return defined({
    ...texture(data),
    width: data.m_Width,
    height: data.m_Height,
    completeImageSize: data.m_CompleteImageSize,
    mipsStripped: data.m_MipsStripped,
    format: data.m_TextureFormat as TextureFormat,
    mipMap: data.m_MipMap,
    mipCount: data.m_MipCount,
    isReadable: data.m_IsReadable,
    isPreProcessed: data.m_IsPreProcessed,
    ignoreMasterTextureLimit: data.m_IgnoreMasterTextureLimit,
    ignoreMipmapLimit: data.m_IgnoreMipmapLimit,
    mipmapLimitGroupName: data.m_MipmapLimitGroupName,
    readAllowed: data.m_ReadAllowed,
    streamingMipmaps: data.m_StreamingMipmaps,
    streamingMipmapsPriority: data.m_StreamingMipmapsPriority,
    imageCount: data.m_ImageCount,
    textureDimension: data.m_TextureDimension,
    textureSettings: textureSettings(data.m_TextureSettings),
    lightmapFormat: data.m_LightmapFormat,
    colorSpace: data.m_ColorSpace,
    platformBlob: data.m_PlatformBlob,
    streamData: data.m_StreamData,
    imageData: data.imageData,
    platform: data.platform,
  });
}

// ---------------------------------------------------------------------------
// Sprite

/** The friendly form of {@link AABB}: a bounding box, its centre and half its size. */
export interface AABBFields {
  /** Unity: `m_Center`. */
  center: Vector3;
  /** Unity: `m_Extent`. */
  extent: Vector3;
}

/** The friendly form of {@link SubMesh}: a run of a mesh's index buffer. */
export interface SubMeshFields {
  /** Byte offset of its first index in the index buffer. */
  firstByte: number;
  indexCount: number;
  /** Unity's `GfxPrimitiveType`: 0 is triangles. */
  topology: number;
  /** Unity 2017.3 and later. */
  baseVertex?: number;
  firstVertex: number;
  vertexCount: number;
  localAABB: AABBFields;
}

/** The friendly form of {@link VertexData}: a mesh's vertex streams. */
export interface VertexDataFields {
  /** Unity: `m_CurrentChannels`. Before Unity 2018.1. */
  currentChannels?: number;
  /** Unity: `m_VertexCount`. */
  vertexCount: number;
  /** Unity: `m_Channels`. */
  channels: ChannelInfo[];
  /**
   * Unity: `m_DataSize`, which despite its name holds the bytes: every stream,
   * one after the other, a view into the object's bytes (R7).
   */
  data: Uint8Array;
}

/** The friendly form of {@link SpriteRenderData}: the mesh and texture area a sprite draws. */
export interface SpriteRenderDataFields {
  texture: PPtr;
  /** Unity 5.2 and later: the alpha of a texture whose format has none. */
  alphaTexture?: PPtr;
  /** Unity 2019.1 and later. */
  secondaryTextures?: SecondarySpriteTexture[];
  /** Unity: `m_SubMeshes`. Unity 5.6 and later. */
  subMeshes?: SubMeshFields[];
  /** Unity: `m_IndexBuffer`. Unity 5.6 and later: `UInt16` indices, a view (R7). */
  indexBuffer?: Uint8Array;
  /** Unity: `m_VertexData`. Unity 5.6 and later. */
  vertexData?: VertexDataFields;
  /** Before Unity 5.6. */
  vertices?: SpriteVertex[];
  /** Before Unity 5.6. */
  indices?: number[];
  /** Unity: `m_Bindpose`. Unity 2018.1 and later. */
  bindpose?: Matrix4x4[];
  /** Unity: `m_SourceSkin`. Unity 2018.1 only. */
  sourceSkin?: BoneWeights4[];
  /** Unity: `m_BlendShapes`. Unity 6000.5 and later. */
  blendShapes?: BlendShapeData;
  /** The sprite's area in `texture`, in pixels from its bottom-left corner. */
  textureRect: Rectf;
  /** Where `textureRect` starts inside the sprite's `rect` (its trimmed margin). */
  textureRectOffset: Vector2;
  /** Unity 5.4.6 to 5.4.x, 5.5.3 to 5.5.x, and 5.6 and later. */
  atlasRectOffset?: Vector2;
  /** Packing flags (see {@link SpriteRenderData.settingsRaw}). */
  settingsRaw: number;
  /** Unity 4.5 and later. */
  uvTransform?: Vector4;
  /** Unity 2017.1 and later. */
  downscaleMultiplier?: number;
}

/** The friendly form of {@link Sprite}. */
export interface SpriteFields extends NamedObjectFields {
  /** Unity: `m_Rect`. The sprite's area in its source texture, from the bottom-left corner. */
  rect: Rectf;
  /** Unity: `m_Offset`. */
  offset: Vector2;
  /** Unity: `m_Border`. Unity 4.5 and later: the 9-slice border, left, bottom, right, top. */
  border?: Vector4;
  /** Unity: `m_PixelsToUnits`. */
  pixelsToUnits: number;
  /** Unity: `m_Pivot`. Unity 5.4.1p3 and later; the centre (0.5, 0.5) before. */
  pivot?: Vector2;
  /** Unity: `m_Extrude`. */
  extrude: number;
  /** Unity: `m_IsPolygon`. Unity 5.3 to 6000.4. */
  isPolygon?: boolean;
  /**
   * Unity: `m_RenderDataKey`. Unity 2017.1 and later: the key of the sprite's
   * render data in its atlas' `renderDataMap`.
   */
  renderDataKey?: [GUID, bigint];
  /** Unity: `m_AtlasTags`. Unity 2017.1 and later. */
  atlasTags?: string[];
  /** Unity: `m_SpriteAtlas`. Unity 2017.1 and later: a null pointer when not packed. */
  spriteAtlas?: PPtr;
  /** Unity: `m_RD`. */
  renderData: SpriteRenderDataFields;
  /** Unity: `m_PhysicsShape`. Unity 2017.1 and later: one outline per shape, in units. */
  physicsShape?: Vector2[][];
  /** Unity: `m_Bones`. Unity 2018.1 and later. */
  bones?: SpriteBone[];
  /** Unity: `m_ScriptableObjects`. Unity 2023.1 and later. */
  scriptableObjects?: PPtr[];
}

/**
 * A `Sprite` as {@link SpriteFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toSpriteFields(data: Sprite): SpriteFields {
  return defined({
    ...namedObject(data),
    rect: data.m_Rect,
    offset: data.m_Offset,
    border: data.m_Border,
    pixelsToUnits: data.m_PixelsToUnits,
    pivot: data.m_Pivot,
    extrude: data.m_Extrude,
    isPolygon: data.m_IsPolygon,
    renderDataKey: data.m_RenderDataKey,
    atlasTags: data.m_AtlasTags,
    spriteAtlas: data.m_SpriteAtlas,
    renderData: spriteRenderData(data.m_RD),
    physicsShape: data.m_PhysicsShape,
    bones: data.m_Bones,
    scriptableObjects: data.m_ScriptableObjects,
  });
}

// ---------------------------------------------------------------------------
// SpriteAtlas

/**
 * The friendly form of {@link SpriteInstanceData}: a packed sprite as a Unity
 * 6000.6 atlas holds it.
 */
export interface SpriteInstanceDataFields {
  /** The sprite's name, a `Sprite`'s `name`. */
  spriteName: string;
  /** The sprite's area in its source texture, in pixels from the bottom-left corner. */
  rect: Rectf;
  /** The 9-slice border, left, bottom, right, top. */
  border: Vector4;
  pivot: Vector2;
  pixelsToUnits: number;
  /** Unity: `m_IndexFormat`. Of `indexBuffer`: 0 is `UInt16`, 1 is `UInt32`. */
  indexFormat: number;
  /** Unity: `m_SubMeshes`. */
  subMeshes: SubMeshFields[];
  /** Unity: `m_IndexBuffer`. The indices, as `indexFormat` says, a view (R7). */
  indexBuffer: Uint8Array;
  /** Unity: `m_VertexData`. */
  vertexData: VertexDataFields;
  /** Unity: `m_Bindpose`. */
  bindpose: Matrix4x4[];
  /** Unity: `m_BlendShapes`. */
  blendShapes: BlendShapeData;
  spriteBones: SpriteBone[];
  /** One outline per shape, in units. */
  physicsShape: Vector2[][];
}

/** The friendly form of {@link SpriteAtlasData}: where one packed sprite sits in its atlas. */
export interface SpriteAtlasDataFields extends Omit<SpriteAtlasData, "*spriteInstanceData"> {
  /** Unity: `*spriteInstanceData`. Unity 6000.6 and later: the packed sprite. */
  spriteInstanceData?: SpriteInstanceDataFields;
}

/** The friendly form of {@link SpriteAtlas}. */
export interface SpriteAtlasFields extends NamedObjectFields {
  /** Unity: `m_PackedSprites`. Before Unity 6000.6. */
  packedSprites?: PPtr[];
  /**
   * Unity: `m_PackedSpriteNamesToIndex`. Before Unity 6000.6: the names of
   * `packedSprites`, in the same order.
   */
  packedSpriteNamesToIndex?: string[];
  /**
   * Unity: `m_RenderDataMap`. A packed sprite's `renderDataKey` to where it
   * sits in the atlas.
   */
  renderDataMap: [[GUID, bigint], SpriteAtlasDataFields][];
  /** Unity: `m_Tag`. */
  tag: string;
  /** Unity: `m_IsVariant`. */
  isVariant: boolean;
  /** Unity: `m_Guid`. Unity 6000.5 and later. */
  guid?: GUID;
}

/**
 * A `SpriteAtlas` as {@link SpriteAtlasFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toSpriteAtlasFields(data: SpriteAtlas): SpriteAtlasFields {
  return defined({
    ...namedObject(data),
    packedSprites: data.m_PackedSprites,
    packedSpriteNamesToIndex: data.m_PackedSpriteNamesToIndex,
    renderDataMap: data.m_RenderDataMap.map(([key, entry]) => [key, spriteAtlasData(entry)]),
    tag: data.m_Tag,
    isVariant: data.m_IsVariant,
    guid: data.m_Guid,
  });
}

// ---------------------------------------------------------------------------
// AudioClip, VideoClip

/** The friendly form of {@link StreamedResource}: a byte range of a resource file. */
export interface StreamedResourceFields {
  /** Unity: `m_Source`. The resource file; `""` when there is none. */
  source: string;
  /** Unity: `m_Offset`. */
  offset: number;
  /** Unity: `m_Size`. */
  size: number;
}

/** The friendly form of {@link AudioClipData}. */
export interface AudioClipFields extends NamedObjectFields {
  /** Unity: `m_Format`. Before Unity 5.0. */
  format?: number;
  /** Unity: `m_Type`. Before Unity 5.0: an FMOD sound type. */
  type?: number;
  /** Unity: `m_3D`. Before Unity 5.0. */
  is3D?: boolean;
  /** Unity: `m_UseHardware`. Before Unity 5.0. */
  useHardware?: boolean;
  /** Unity: `m_Stream`. Before Unity 5.0. */
  stream?: number;
  /** Unity: `m_Size`. Before Unity 5.0, streamed only: the sound's byte count. */
  size?: number;
  /** Unity: `m_Offset`. Before Unity 5.0, streamed only: where it starts in the `.resS`. */
  offset?: number;
  /** Unity: `m_LoadType`. Unity 5.0 and later. */
  loadType?: number;
  /** Unity: `m_Channels`. Unity 5.0 and later. */
  channels?: number;
  /** Unity: `m_Frequency`. Unity 5.0 and later. */
  frequency?: number;
  /** Unity: `m_BitsPerSample`. Unity 5.0 and later. */
  bitsPerSample?: number;
  /** Unity: `m_Length`. Unity 5.0 and later: seconds. */
  length?: number;
  /** Unity: `m_IsTrackerFormat`. Unity 5.0 and later. */
  isTrackerFormat?: boolean;
  /** Unity: `m_Ambisonic`. Unity 2017.1 and later. */
  ambisonic?: boolean;
  /** Unity: `m_SubsoundIndex`. Unity 5.0 and later. */
  subsoundIndex?: number;
  /** Unity: `m_PreloadAudioData`. Unity 5.0 and later. */
  preloadAudioData?: boolean;
  /** Unity: `m_LoadInBackground`. Unity 5.0 and later. */
  loadInBackground?: boolean;
  /** Unity: `m_Legacy3D`. Unity 5.0 and later. */
  legacy3D?: boolean;
  /** Unity: `m_Resource`. Unity 5.0 and later: where the sound is. */
  resource?: StreamedResourceFields;
  /**
   * Unity: `m_CompressionFormat`. Unity 5.0 and later: upstream's
   * `AudioCompressionFormat` (0 PCM, 1 Vorbis, ...).
   */
  compressionFormat?: number;
  /**
   * The sound, still encoded (usually FSB5), wherever it was stored; before
   * Unity 5.0 it is Unity's inline `m_AudioData` when there is one (see
   * {@link AudioClipData.audioData}). A view, never a copy (R7).
   */
  audioData: Uint8Array;
}

/**
 * An `AudioClip` as {@link AudioClipFields}. Unity's pre-5.0 inline
 * `m_AudioData` is not carried over on its own: `audioData` is it then.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toAudioClipFields(data: AudioClipData): AudioClipFields {
  return defined({
    ...namedObject(data),
    format: data.m_Format,
    type: data.m_Type,
    is3D: data.m_3D,
    useHardware: data.m_UseHardware,
    stream: data.m_Stream,
    size: data.m_Size,
    offset: data.m_Offset,
    loadType: data.m_LoadType,
    channels: data.m_Channels,
    frequency: data.m_Frequency,
    bitsPerSample: data.m_BitsPerSample,
    length: data.m_Length,
    isTrackerFormat: data.m_IsTrackerFormat,
    ambisonic: data.m_Ambisonic,
    subsoundIndex: data.m_SubsoundIndex,
    preloadAudioData: data.m_PreloadAudioData,
    loadInBackground: data.m_LoadInBackground,
    legacy3D: data.m_Legacy3D,
    resource: data.m_Resource && streamedResource(data.m_Resource),
    compressionFormat: data.m_CompressionFormat,
    audioData: data.audioData,
  });
}

/** The friendly form of {@link VideoClipData}. */
export interface VideoClipFields extends NamedObjectFields {
  /** Unity: `m_OriginalPath`. The asset's path in the editor project. */
  originalPath: string;
  /** Unity: `m_ProxyWidth`. */
  proxyWidth: number;
  /** Unity: `m_ProxyHeight`. */
  proxyHeight: number;
  /** Unity: `Width`. */
  width: number;
  /** Unity: `Height`. */
  height: number;
  /** Unity: `m_PixelAspecRatioNum` (sic). Unity 2017.2 and later. */
  pixelAspectRatioNum?: number;
  /** Unity: `m_PixelAspecRatioDen` (sic). Unity 2017.2 and later. */
  pixelAspectRatioDen?: number;
  /** Unity: `m_FrameRate`. */
  frameRate: number;
  /** Unity: `m_FrameCount`, a `UInt64` (D9). */
  frameCount: bigint;
  /** Unity: `m_Format`. */
  format: number;
  /** Unity: `m_AudioChannelCount`. One per audio track. */
  audioChannelCount: number[];
  /** Unity: `m_AudioSampleRate`. One per audio track. */
  audioSampleRate: number[];
  /** Unity: `m_AudioLanguage`. One per audio track. */
  audioLanguage: string[];
  /** Unity: `m_VideoShaders`. Unity 2020.1 and later. */
  videoShaders?: PPtr[];
  /** Unity: `m_ExternalResources`. Where the video is. */
  externalResources: StreamedResourceFields;
  /** Unity: `m_HasSplitAlpha`. */
  hasSplitAlpha: boolean;
  /** Unity: `m_sRGB`. Unity 2019.2 and later. */
  sRGB?: boolean;
  /**
   * The video, still encoded (the imported file, or the editor's transcode;
   * see {@link VideoClipData.videoData}). A view, never a copy (R7).
   */
  videoData: Uint8Array;
}

/**
 * A `VideoClip` as {@link VideoClipFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toVideoClipFields(data: VideoClipData): VideoClipFields {
  return defined({
    ...namedObject(data),
    originalPath: data.m_OriginalPath,
    proxyWidth: data.m_ProxyWidth,
    proxyHeight: data.m_ProxyHeight,
    width: data.Width,
    height: data.Height,
    pixelAspectRatioNum: data.m_PixelAspecRatioNum,
    pixelAspectRatioDen: data.m_PixelAspecRatioDen,
    frameRate: data.m_FrameRate,
    frameCount: data.m_FrameCount,
    format: data.m_Format,
    audioChannelCount: data.m_AudioChannelCount,
    audioSampleRate: data.m_AudioSampleRate,
    audioLanguage: data.m_AudioLanguage,
    videoShaders: data.m_VideoShaders,
    externalResources: streamedResource(data.m_ExternalResources),
    hasSplitAlpha: data.m_HasSplitAlpha,
    sRGB: data.m_sRGB,
    videoData: data.videoData,
  });
}

// ---------------------------------------------------------------------------
// Font, MovieTexture

/** The friendly form of {@link Font}. */
export interface FontFields extends NamedObjectFields {
  /** Unity: `m_AsciiStartOffset`. */
  asciiStartOffset: number;
  /** Unity: `m_FontCountX`. Unity 3.4 to 3.5. */
  fontCountX?: number;
  /** Unity: `m_FontCountY`. Unity 3.4 to 3.5. */
  fontCountY?: number;
  /** Unity: `m_Kerning`. Before Unity 5.3; renamed `tracking` there. */
  kerning?: number;
  /** Unity: `m_Tracking`. Unity 5.3 and later. */
  tracking?: number;
  /** Unity: `m_LineSpacing`. */
  lineSpacing: number;
  /** Unity: `m_PerCharacterKerning`. Unity 3.4 to 3.5: `[character, kerning]`. */
  perCharacterKerning?: [number, number][];
  /** Unity: `m_CharacterSpacing`. Unity 4.0 and later. */
  characterSpacing?: number;
  /** Unity: `m_CharacterPadding`. Unity 4.0 and later. */
  characterPadding?: number;
  /** Unity: `m_ConvertCase`. */
  convertCase: number;
  /** Unity: `m_DefaultMaterial`. */
  defaultMaterial: PPtr;
  /** Unity: `m_CharacterRects`. */
  characterRects: CharacterInfo[];
  /** Unity: `m_Texture`. */
  texture: PPtr;
  /** Unity: `m_KerningValues`. `[[first character, second character], kerning]`. */
  kerningValues: [[number, number], number][];
  /** Unity: `m_GridFont`. Unity 3.4 to 3.5. */
  gridFont?: boolean;
  /** Unity: `m_PixelScale`. Unity 4.0 and later. */
  pixelScale?: number;
  /** Unity: `m_FontData`. The TrueType / OpenType file, a view into the object's bytes (R7). */
  fontData: Uint8Array;
  /** Unity: `m_FontSize`. */
  fontSize: number;
  /** Unity: `m_Ascent`. */
  ascent: number;
  /** Unity: `m_Descent`. Unity 5.4 and later. */
  descent?: number;
  /** Unity: `m_DefaultStyle`. */
  defaultStyle: number;
  /** Unity: `m_FontNames`. */
  fontNames: string[];
  /** Unity: `m_FallbackFonts`. Unity 4.0 and later. */
  fallbackFonts?: PPtr[];
  /** Unity: `m_FontRenderingMode`. Unity 4.0 and later. */
  fontRenderingMode?: number;
  /** Unity: `m_UseLegacyBoundsCalculation`. Some releases of 5.6 to 2017.3, and 2018.1+. */
  useLegacyBoundsCalculation?: boolean;
  /** Unity: `m_ShouldRoundAdvanceValue`. Unity 2018.1 and later. */
  shouldRoundAdvanceValue?: boolean;
}

/**
 * A `Font` as {@link FontFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toFontFields(data: Font): FontFields {
  return defined({
    ...namedObject(data),
    asciiStartOffset: data.m_AsciiStartOffset,
    fontCountX: data.m_FontCountX,
    fontCountY: data.m_FontCountY,
    kerning: data.m_Kerning,
    tracking: data.m_Tracking,
    lineSpacing: data.m_LineSpacing,
    perCharacterKerning: data.m_PerCharacterKerning,
    characterSpacing: data.m_CharacterSpacing,
    characterPadding: data.m_CharacterPadding,
    convertCase: data.m_ConvertCase,
    defaultMaterial: data.m_DefaultMaterial,
    characterRects: data.m_CharacterRects,
    texture: data.m_Texture,
    kerningValues: data.m_KerningValues,
    gridFont: data.m_GridFont,
    pixelScale: data.m_PixelScale,
    fontData: data.m_FontData,
    fontSize: data.m_FontSize,
    ascent: data.m_Ascent,
    descent: data.m_Descent,
    defaultStyle: data.m_DefaultStyle,
    fontNames: data.m_FontNames,
    fallbackFonts: data.m_FallbackFonts,
    fontRenderingMode: data.m_FontRenderingMode,
    useLegacyBoundsCalculation: data.m_UseLegacyBoundsCalculation,
    shouldRoundAdvanceValue: data.m_ShouldRoundAdvanceValue,
  });
}

/** The friendly form of {@link MovieTexture}. */
export interface MovieTextureFields extends TextureFields {
  /** Unity: `m_Loop`. Before Unity 2019.3. */
  loop?: boolean;
  /** Unity: `m_AudioClip`. Before Unity 2019.3: the clip that plays with the movie. */
  audioClip?: PPtr;
  /** Unity: `m_MovieData`. Before Unity 2019.3: the Ogg Theora file, a view (R7). */
  movieData?: Uint8Array;
  /** Unity: `m_ColorSpace`. Unity 3.5 to 2019.2. */
  colorSpace?: number;
}

/**
 * A `MovieTexture` as {@link MovieTextureFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMovieTextureFields(data: MovieTexture): MovieTextureFields {
  return defined({
    ...texture(data),
    loop: data.m_Loop,
    audioClip: data.m_AudioClip,
    movieData: data.m_MovieData,
    colorSpace: data.m_ColorSpace,
  });
}

// ---------------------------------------------------------------------------
// Mesh

/** The friendly form of {@link MinMaxAABB}: a box by its corners. */
export interface MinMaxAABBFields {
  /** Unity: `m_Min`. */
  min: Vector3;
  /** Unity: `m_Max`. */
  max: Vector3;
}

/** The friendly form of {@link PackedFloatVector}: floats packed into `bitSize` bits each. */
export interface PackedFloatVectorFields {
  /** Unity: `m_NumItems`. */
  numItems: number;
  /** Unity: `m_Range`. */
  range: number;
  /** Unity: `m_Start`. */
  start: number;
  /** Unity: `m_Data`. The packed bits, a view (R7). */
  data: Uint8Array;
  /** Unity: `m_BitSize`. */
  bitSize: number;
}

/** The friendly form of {@link PackedIntVector}: integers packed into `bitSize` bits each. */
export interface PackedIntVectorFields {
  /** Unity: `m_NumItems`. */
  numItems: number;
  /** Unity: `m_Data`. The packed bits, a view (R7). */
  data: Uint8Array;
  /** Unity: `m_BitSize`. */
  bitSize: number;
}

/** The friendly form of {@link CompressedMesh}: a mesh built with mesh compression. */
export interface CompressedMeshFields {
  /** Unity: `m_Vertices`. */
  vertices: PackedFloatVectorFields;
  /** Unity: `m_UV`. */
  uv: PackedFloatVectorFields;
  /** Unity: `m_Normals`. */
  normals: PackedFloatVectorFields;
  /** Unity: `m_Tangents`. */
  tangents: PackedFloatVectorFields;
  /** Unity: `m_Weights`. */
  weights: PackedIntVectorFields;
  /** Unity: `m_NormalSigns`. */
  normalSigns: PackedIntVectorFields;
  /** Unity: `m_TangentSigns`. */
  tangentSigns: PackedIntVectorFields;
  /** Unity: `m_FloatColors`. */
  floatColors: PackedFloatVectorFields;
  /** Unity: `m_BoneIndices`. */
  boneIndices: PackedIntVectorFields;
  /** Unity: `m_Triangles`. */
  triangles: PackedIntVectorFields;
  /** Unity: `m_UVInfo`. The UV channels' layout in `uv` (see {@link CompressedMesh.m_UVInfo}). */
  uvInfo: number;
}

/** The friendly form of {@link MeshLodInfo}: a mesh's levels of detail. */
export interface MeshLodInfoFields {
  /** Unity: `m_LodSelectionCurve`. */
  lodSelectionCurve: {
    /** Unity: `m_LodSlope`. */
    lodSlope: number;
    /** Unity: `m_LodBias`. */
    lodBias: number;
  };
  /** Unity: `m_NumLevels`. */
  numLevels: number;
  /** Unity: `m_SubMeshes`. One per submesh. */
  subMeshes: {
    /** Unity: `m_Levels`. Its index range at each level. */
    levels: {
      /** Unity: `m_IndexStart`. */
      indexStart: number;
      /** Unity: `m_IndexCount`. */
      indexCount: number;
    }[];
  }[];
}

/**
 * The friendly form of {@link MeshData}: the fields of a `Mesh`, and its
 * vertices and triangles decoded (the fields after `streamData`).
 */
export interface MeshFields extends NamedObjectFields {
  /** Unity: `m_SubMeshes`. */
  subMeshes: SubMeshFields[];
  /** Unity: `m_Shapes`. The blend shapes. */
  shapes: BlendShapeData;
  /** Unity: `m_BindPose`. */
  bindPose: Matrix4x4[];
  /** Unity: `m_BoneNameHashes`. */
  boneNameHashes: number[];
  /** Unity: `m_RootBoneNameHash`. */
  rootBoneNameHash: number;
  /** Unity: `m_BonesAABB`. */
  bonesAABB: MinMaxAABBFields[];
  /** Unity: `m_VariableBoneCountWeights`. */
  variableBoneCountWeights: {
    /** Unity: `m_Data`. */
    data: number[];
  };
  /** Unity: `m_MeshCompression`. 0 off, 1 low, 2 medium, 3 high. */
  meshCompression: number;
  /** Unity: `m_IsReadable`. */
  isReadable: boolean;
  /** Unity: `m_KeepVertices`. */
  keepVertices: boolean;
  /** Unity: `m_KeepIndices`. */
  keepIndices: boolean;
  /** Unity: `m_IndexFormat`. 0: `UInt16` indices; 1: `UInt32`. */
  indexFormat: number;
  /** Unity: `m_IndexBuffer`. The indices in `indexFormat`, a view (R7). */
  indexBuffer: Uint8Array;
  /** Unity: `m_VertexData`. */
  vertexData: VertexDataFields;
  /** Unity: `m_CompressedMesh`. */
  compressedMesh: CompressedMeshFields;
  /** Unity: `m_LocalAABB`. */
  localAABB: AABBFields;
  /** Unity: `m_MeshUsageFlags`. Before Unity 6000.6. */
  meshUsageFlags?: number;
  /** Unity: `m_CookingOptions`. Unity 2022.1 and later. */
  cookingOptions?: number;
  /** Unity: `m_PreBakeConvexCollisionMesh`. Unity 6000.6 and later. */
  preBakeConvexCollisionMesh?: boolean;
  /** Unity: `m_PreBakeTriangleCollisionMesh`. Unity 6000.6 and later. */
  preBakeTriangleCollisionMesh?: boolean;
  /** Unity: `m_BakedConvexCollisionMesh`. A view (R7). */
  bakedConvexCollisionMesh: Uint8Array;
  /** Unity: `m_BakedTriangleCollisionMesh`. A view (R7). */
  bakedTriangleCollisionMesh: Uint8Array;
  /** Unity: `m_MeshMetrics[0]`. */
  "meshMetrics[0]": number;
  /** Unity: `m_MeshMetrics[1]`. */
  "meshMetrics[1]": number;
  /**
   * Unity: `m_StreamData`. The byte range of a resource file holding the
   * vertex data when it is not inline (an empty `path` otherwise).
   */
  streamData: StreamingInfo;
  /** Unity: `m_MeshLodInfo`. Unity 6000.2 and later. */
  meshLodInfo?: MeshLodInfoFields;
  /** Not a Mesh field: the vertex count (see {@link MeshData.vertexCount}). */
  vertexCount: number;
  /** Not a Mesh field: positions (see {@link MeshData.vertices}). */
  vertices?: Float32Array;
  /** Not a Mesh field: normals (see {@link MeshData.normals}). */
  normals?: Float32Array;
  /** Not a Mesh field: tangents (see {@link MeshData.tangents}). */
  tangents?: Float32Array;
  /** Not a Mesh field: RGBA colours (see {@link MeshData.colors}). */
  colors?: Float32Array;
  /** Not a Mesh field: UV0 to UV7 (see {@link MeshData.uv}). */
  uv: (Float32Array | undefined)[];
  /** Not a Mesh field: bone weights per vertex (see {@link MeshData.skin}). */
  skin?: VertexBoneWeights[];
  /** Not a Mesh field: each submesh's triangles (see {@link MeshData.indices}). */
  indices: Uint32Array[];
}

/**
 * A `Mesh` as {@link MeshFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMeshFields(data: MeshData): MeshFields {
  return defined({
    ...namedObject(data),
    subMeshes: data.m_SubMeshes.map(subMesh),
    shapes: data.m_Shapes,
    bindPose: data.m_BindPose,
    boneNameHashes: data.m_BoneNameHashes,
    rootBoneNameHash: data.m_RootBoneNameHash,
    bonesAABB: data.m_BonesAABB.map((box) => ({ min: box.m_Min, max: box.m_Max })),
    variableBoneCountWeights: { data: data.m_VariableBoneCountWeights.m_Data },
    meshCompression: data.m_MeshCompression,
    isReadable: data.m_IsReadable,
    keepVertices: data.m_KeepVertices,
    keepIndices: data.m_KeepIndices,
    indexFormat: data.m_IndexFormat,
    indexBuffer: data.m_IndexBuffer,
    vertexData: vertexData(data.m_VertexData),
    compressedMesh: compressedMesh(data.m_CompressedMesh),
    localAABB: aabb(data.m_LocalAABB),
    meshUsageFlags: data.m_MeshUsageFlags,
    cookingOptions: data.m_CookingOptions,
    preBakeConvexCollisionMesh: data.m_PreBakeConvexCollisionMesh,
    preBakeTriangleCollisionMesh: data.m_PreBakeTriangleCollisionMesh,
    bakedConvexCollisionMesh: data.m_BakedConvexCollisionMesh,
    bakedTriangleCollisionMesh: data.m_BakedTriangleCollisionMesh,
    "meshMetrics[0]": data["m_MeshMetrics[0]"],
    "meshMetrics[1]": data["m_MeshMetrics[1]"],
    streamData: data.m_StreamData,
    meshLodInfo: data.m_MeshLodInfo && meshLodInfo(data.m_MeshLodInfo),
    vertexCount: data.vertexCount,
    vertices: data.vertices,
    normals: data.normals,
    tangents: data.tangents,
    colors: data.colors,
    uv: data.uv,
    skin: data.skin,
    indices: data.indices,
  });
}

// ---------------------------------------------------------------------------
// Helpers

/** Drop the keys whose value is `undefined`: a field a version does not have is absent. */
function defined<T extends object>(fields: T): T {
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
}

function editorExtension(data: EditorExtension): EditorExtensionFields {
  return {
    objectHideFlags: data.m_ObjectHideFlags,
    extensionPtr: data.m_ExtensionPtr,
    prefabParentObject: data.m_PrefabParentObject,
    correspondingSourceObject: data.m_CorrespondingSourceObject,
    prefabInternal: data.m_PrefabInternal,
    prefabInstance: data.m_PrefabInstance,
    prefabAsset: data.m_PrefabAsset,
  };
}

function namedObject(data: NamedObject): NamedObjectFields {
  return defined({ ...editorExtension(data), name: data.m_Name });
}

function texture(data: Texture): TextureFields {
  return defined({
    ...namedObject(data),
    forcedFallbackFormat: data.m_ForcedFallbackFormat as TextureFormat | undefined,
    downscaleFallback: data.m_DownscaleFallback,
    isAlphaChannelOptional: data.m_IsAlphaChannelOptional,
  });
}

function textureSettings(settings: GLTextureSettings): GLTextureSettingsFields {
  return defined({
    filterMode: settings.m_FilterMode,
    aniso: settings.m_Aniso,
    mipBias: settings.m_MipBias,
    wrapMode: settings.m_WrapMode,
    wrapU: settings.m_WrapU,
    wrapV: settings.m_WrapV,
    wrapW: settings.m_WrapW,
  });
}

function streamedResource(resource: StreamedResource): StreamedResourceFields {
  return { source: resource.m_Source, offset: resource.m_Offset, size: resource.m_Size };
}

function aabb(box: AABB): AABBFields {
  return { center: box.m_Center, extent: box.m_Extent };
}

function subMesh(mesh: SubMesh): SubMeshFields {
  return { ...mesh, localAABB: aabb(mesh.localAABB) };
}

function vertexData(data: VertexData): VertexDataFields {
  return defined({
    currentChannels: data.m_CurrentChannels,
    vertexCount: data.m_VertexCount,
    channels: data.m_Channels,
    data: data.m_DataSize,
  });
}

function packedFloats(vector: PackedFloatVector): PackedFloatVectorFields {
  return {
    numItems: vector.m_NumItems,
    range: vector.m_Range,
    start: vector.m_Start,
    data: vector.m_Data,
    bitSize: vector.m_BitSize,
  };
}

function packedInts(vector: PackedIntVector): PackedIntVectorFields {
  return { numItems: vector.m_NumItems, data: vector.m_Data, bitSize: vector.m_BitSize };
}

function compressedMesh(mesh: CompressedMesh): CompressedMeshFields {
  return {
    vertices: packedFloats(mesh.m_Vertices),
    uv: packedFloats(mesh.m_UV),
    normals: packedFloats(mesh.m_Normals),
    tangents: packedFloats(mesh.m_Tangents),
    weights: packedInts(mesh.m_Weights),
    normalSigns: packedInts(mesh.m_NormalSigns),
    tangentSigns: packedInts(mesh.m_TangentSigns),
    floatColors: packedFloats(mesh.m_FloatColors),
    boneIndices: packedInts(mesh.m_BoneIndices),
    triangles: packedInts(mesh.m_Triangles),
    uvInfo: mesh.m_UVInfo,
  };
}

function meshLodInfo(info: MeshLodInfo): MeshLodInfoFields {
  const curve = info.m_LodSelectionCurve;
  return {
    lodSelectionCurve: { lodSlope: curve.m_LodSlope, lodBias: curve.m_LodBias },
    numLevels: info.m_NumLevels,
    subMeshes: info.m_SubMeshes.map((subMesh) => ({
      levels: subMesh.m_Levels.map((level) => ({
        indexStart: level.m_IndexStart,
        indexCount: level.m_IndexCount,
      })),
    })),
  };
}

function spriteRenderData(rd: SpriteRenderData): SpriteRenderDataFields {
  return defined({
    texture: rd.texture,
    alphaTexture: rd.alphaTexture,
    secondaryTextures: rd.secondaryTextures,
    subMeshes: rd.m_SubMeshes?.map(subMesh),
    indexBuffer: rd.m_IndexBuffer,
    vertexData: rd.m_VertexData && vertexData(rd.m_VertexData),
    vertices: rd.vertices,
    indices: rd.indices,
    bindpose: rd.m_Bindpose,
    sourceSkin: rd.m_SourceSkin,
    blendShapes: rd.m_BlendShapes,
    textureRect: rd.textureRect,
    textureRectOffset: rd.textureRectOffset,
    atlasRectOffset: rd.atlasRectOffset,
    settingsRaw: rd.settingsRaw,
    uvTransform: rd.uvTransform,
    downscaleMultiplier: rd.downscaleMultiplier,
  });
}

function spriteAtlasData(entry: SpriteAtlasData): SpriteAtlasDataFields {
  const { "*spriteInstanceData": instance, ...rest } = entry;
  return defined({ ...rest, spriteInstanceData: instance && spriteInstanceData(instance) });
}

function spriteInstanceData(data: SpriteInstanceData): SpriteInstanceDataFields {
  return {
    spriteName: data.spriteName,
    rect: data.rect,
    border: data.border,
    pivot: data.pivot,
    pixelsToUnits: data.pixelsToUnits,
    indexFormat: data.m_IndexFormat,
    subMeshes: data.m_SubMeshes.map(subMesh),
    indexBuffer: data.m_IndexBuffer,
    vertexData: vertexData(data.m_VertexData),
    bindpose: data.m_Bindpose,
    blendShapes: data.m_BlendShapes,
    spriteBones: data.spriteBones,
    physicsShape: data.physicsShape,
  };
}

function serializedShader(shader: SerializedShader): SerializedShaderFields {
  return defined({
    propInfo: { props: shader.m_PropInfo.m_Props.map(serializedProperty) },
    subShaders: shader.m_SubShaders.map((sub) => ({
      passes: sub.m_Passes.map(serializedPass),
      tags: sub.m_Tags,
      lod: sub.m_LOD,
    })),
    keywordNames: shader.m_KeywordNames,
    keywordFlags: shader.m_KeywordFlags,
    name: shader.m_Name,
    customEditorName: shader.m_CustomEditorName,
    fallbackName: shader.m_FallbackName,
    dependencies: shader.m_Dependencies,
    customEditorForRenderPipelines: shader.m_CustomEditorForRenderPipelines,
    disableNoSubshadersMessage: shader.m_DisableNoSubshadersMessage,
  });
}

function serializedProperty(prop: SerializedProperty): SerializedPropertyFields {
  return {
    name: prop.m_Name,
    description: prop.m_Description,
    attributes: prop.m_Attributes,
    type: prop.m_Type,
    flags: prop.m_Flags,
    "defValue[0]": prop["m_DefValue[0]"],
    "defValue[1]": prop["m_DefValue[1]"],
    "defValue[2]": prop["m_DefValue[2]"],
    "defValue[3]": prop["m_DefValue[3]"],
    defTexture: {
      defaultName: prop.m_DefTexture.m_DefaultName,
      texDim: prop.m_DefTexture.m_TexDim,
    },
  };
}

function serializedPass(pass: SerializedPass): SerializedPassFields {
  return defined({
    editorDataHash: pass.m_EditorDataHash,
    platforms: pass.m_Platforms,
    localKeywordMask: pass.m_LocalKeywordMask,
    globalKeywordMask: pass.m_GlobalKeywordMask,
    nameIndices: pass.m_NameIndices,
    type: pass.m_Type,
    state: shaderState(pass.m_State),
    programMask: pass.m_ProgramMask,
    progVertex: serializedProgram(pass.progVertex),
    progFragment: serializedProgram(pass.progFragment),
    progGeometry: serializedProgram(pass.progGeometry),
    progHull: serializedProgram(pass.progHull),
    progDomain: serializedProgram(pass.progDomain),
    progRayTracing: pass.progRayTracing && serializedProgram(pass.progRayTracing),
    hasInstancingVariant: pass.m_HasInstancingVariant,
    hasProceduralInstancingVariant: pass.m_HasProceduralInstancingVariant,
    useName: pass.m_UseName,
    name: pass.m_Name,
    textureName: pass.m_TextureName,
    tags: pass.m_Tags,
    serializedKeywordStateMask: pass.m_SerializedKeywordStateMask,
  });
}

/** The render state, its three `m_` fields renamed in place, so the keys keep Unity's order. */
function shaderState(state: SerializedShaderState): SerializedShaderStateFields {
  const renames: Record<string, string> = { m_Name: "name", m_Tags: "tags", m_LOD: "lod" };
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [renames[key] ?? key, value]),
  ) as unknown as SerializedShaderStateFields;
}

function serializedProgram(program: SerializedProgram): SerializedProgramFields {
  return defined({
    subPrograms: program.m_SubPrograms.map(subProgram),
    playerSubPrograms: program.m_PlayerSubPrograms?.map((variants) =>
      variants.map((p) => ({
        blobIndex: p.m_BlobIndex,
        keywordIndices: p.m_KeywordIndices,
        shaderRequirements: p.m_ShaderRequirements,
        gpuProgramType: p.m_GpuProgramType,
      })),
    ),
    parameterBlobIndices: program.m_ParameterBlobIndices,
    commonParameters: program.m_CommonParameters && programParameters(program.m_CommonParameters),
    serializedKeywordStateMask: program.m_SerializedKeywordStateMask,
  });
}

function subProgram(sub: SerializedSubProgram): SerializedSubProgramFields {
  // Before 2020.3.2 / 2021.1.1 the parameter lists are the sub-program's own
  // fields, between `m_GpuProgramType` and `m_ShaderRequirements`.
  const inline = sub.m_VectorParams ? programParameters(sub as ProgramParameters) : {};
  return defined({
    blobIndex: sub.m_BlobIndex,
    channels: { channels: sub.m_Channels.m_Channels, sourceMap: sub.m_Channels.m_SourceMap },
    globalKeywordIndices: sub.m_GlobalKeywordIndices,
    localKeywordIndices: sub.m_LocalKeywordIndices,
    keywordIndices: sub.m_KeywordIndices,
    shaderHardwareTier: sub.m_ShaderHardwareTier,
    gpuProgramType: sub.m_GpuProgramType,
    ...inline,
    parameters: sub.m_Parameters && programParameters(sub.m_Parameters),
    shaderRequirements: sub.m_ShaderRequirements,
  });
}

function programParameters(params: ProgramParameters): ProgramParametersFields {
  return defined({
    vectorParams: params.m_VectorParams.map(vectorParameter),
    matrixParams: params.m_MatrixParams.map(matrixParameter),
    textureParams: params.m_TextureParams.map((t) =>
      defined({
        nameIndex: t.m_NameIndex,
        index: t.m_Index,
        samplerIndex: t.m_SamplerIndex,
        binding: t.m_Binding && binding(t.m_Binding),
        samplerBinding: t.m_SamplerBinding && binding(t.m_SamplerBinding),
        multiSampled: t.m_MultiSampled,
        dim: t.m_Dim,
      }),
    ),
    bufferParams: params.m_BufferParams.map(bufferBinding),
    constantBuffers: params.m_ConstantBuffers.map((cb) =>
      defined({
        nameIndex: cb.m_NameIndex,
        matrixParams: cb.m_MatrixParams.map(matrixParameter),
        vectorParams: cb.m_VectorParams.map(vectorParameter),
        structParams: cb.m_StructParams.map((sp) =>
          defined({
            nameIndex: sp.m_NameIndex,
            index: sp.m_Index,
            offsetInConstantBuffer: sp.m_OffsetInConstantBuffer,
            arraySize: sp.m_ArraySize,
            structSize: sp.m_StructSize,
            vectorMembers: sp.m_VectorMembers.map(vectorParameter),
            matrixMembers: sp.m_MatrixMembers.map(matrixParameter),
          }),
        ),
        size: cb.m_Size,
        isPartialCB: cb.m_IsPartialCB,
      }),
    ),
    constantBufferBindings: params.m_ConstantBufferBindings.map(bufferBinding),
    uavParams: params.m_UAVParams.map((u) =>
      defined({
        nameIndex: u.m_NameIndex,
        index: u.m_Index,
        originalIndex: u.m_OriginalIndex,
        binding: u.m_Binding && binding(u.m_Binding),
        originalBinding: u.m_OriginalBinding && binding(u.m_OriginalBinding),
      }),
    ),
    samplers: params.m_Samplers.map((s) =>
      defined({
        sampler: s.sampler,
        bindPoint: s.bindPoint,
        binding: s.m_Binding && binding(s.m_Binding),
      }),
    ),
  });
}

function vectorParameter(v: VectorParameter): VectorParameterFields {
  return defined({
    nameIndex: v.m_NameIndex,
    index: v.m_Index,
    offsetInConstantBuffer: v.m_OffsetInConstantBuffer,
    arraySize: v.m_ArraySize,
    type: v.m_Type,
    dim: v.m_Dim,
  });
}

function matrixParameter(m: MatrixParameter): MatrixParameterFields {
  return defined({
    nameIndex: m.m_NameIndex,
    index: m.m_Index,
    offsetInConstantBuffer: m.m_OffsetInConstantBuffer,
    arraySize: m.m_ArraySize,
    type: m.m_Type,
    rowCount: m.m_RowCount,
  });
}

function bufferBinding(b: BufferBinding): BufferBindingFields {
  return defined({
    nameIndex: b.m_NameIndex,
    index: b.m_Index,
    binding: b.m_Binding && binding(b.m_Binding),
    arraySize: b.m_ArraySize,
    resourceType: b.m_ResourceType,
  });
}

function binding(b: Binding): BindingFields {
  return { encodedData: b.m_EncodedData, slot: b.m_Slot };
}
