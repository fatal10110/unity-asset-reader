// Ported from AssetStudio/Classes/Shader.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import { readHash128, type Hash128 } from "./MonoScript.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { endOfObject, readArray, readGUID, type GUID } from "./Sprite.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

// The shapes below are Unity's type tree structs, under Unity's field names,
// as `readTypeTree()` gives them: map entries and pairs as `[first, second]`,
// byte arrays as `Uint8Array` views (R7), Int64 fields as `bigint` (D9).

/**
 * A float of the render state, or the material property it is bound to
 * (Unity's `SerializedShaderFloatValue`).
 */
export interface SerializedShaderFloatValue {
  val: number;
  /** The property the value comes from (`Cull [_Cull]`), or `"<noninit>"`. */
  name: string;
}

/** A vector of the render state (Unity's `SerializedShaderVectorValue`). */
export interface SerializedShaderVectorValue {
  x: SerializedShaderFloatValue;
  y: SerializedShaderFloatValue;
  z: SerializedShaderFloatValue;
  w: SerializedShaderFloatValue;
  /** As {@link SerializedShaderFloatValue}'s `name`. */
  name: string;
}

/** The blend state of one render target (Unity's `SerializedShaderRTBlendState`). */
export interface SerializedShaderRTBlendState {
  srcBlend: SerializedShaderFloatValue;
  destBlend: SerializedShaderFloatValue;
  srcBlendAlpha: SerializedShaderFloatValue;
  destBlendAlpha: SerializedShaderFloatValue;
  blendOp: SerializedShaderFloatValue;
  blendOpAlpha: SerializedShaderFloatValue;
  colMask: SerializedShaderFloatValue;
}

/** One face's stencil operations (Unity's `SerializedStencilOp`). */
export interface SerializedStencilOp {
  pass: SerializedShaderFloatValue;
  fail: SerializedShaderFloatValue;
  zFail: SerializedShaderFloatValue;
  comp: SerializedShaderFloatValue;
}

/** Tags, name to value (Unity's `SerializedTagMap`). */
export interface SerializedTagMap {
  tags: [string, string][];
}

/** A pass's render state (Unity's `SerializedShaderState`). */
export interface SerializedShaderState {
  /** The pass's name, as written in the shader. */
  m_Name: string;
  rtBlend0: SerializedShaderRTBlendState;
  rtBlend1: SerializedShaderRTBlendState;
  rtBlend2: SerializedShaderRTBlendState;
  rtBlend3: SerializedShaderRTBlendState;
  rtBlend4: SerializedShaderRTBlendState;
  rtBlend5: SerializedShaderRTBlendState;
  rtBlend6: SerializedShaderRTBlendState;
  rtBlend7: SerializedShaderRTBlendState;
  rtSeparateBlend: boolean;
  zClip: SerializedShaderFloatValue;
  zTest: SerializedShaderFloatValue;
  zWrite: SerializedShaderFloatValue;
  culling: SerializedShaderFloatValue;
  /** Unity 2020.1 and later. */
  conservative?: SerializedShaderFloatValue;
  offsetFactor: SerializedShaderFloatValue;
  offsetUnits: SerializedShaderFloatValue;
  alphaToMask: SerializedShaderFloatValue;
  stencilOp: SerializedStencilOp;
  stencilOpFront: SerializedStencilOp;
  stencilOpBack: SerializedStencilOp;
  stencilReadMask: SerializedShaderFloatValue;
  stencilWriteMask: SerializedShaderFloatValue;
  stencilRef: SerializedShaderFloatValue;
  fogStart: SerializedShaderFloatValue;
  fogEnd: SerializedShaderFloatValue;
  fogDensity: SerializedShaderFloatValue;
  fogColor: SerializedShaderVectorValue;
  /** Unity's `FogMode`: -1 unknown, 0 disabled, 1 linear, 2 exp, 3 exp2. */
  fogMode: number;
  gpuProgramID: number;
  m_Tags: SerializedTagMap;
  m_LOD: number;
  lighting: boolean;
}

/** A vertex input binding (Unity's `ShaderBindChannel`). */
export interface ShaderBindChannel {
  source: number;
  target: number;
}

/** The vertex inputs of a sub-program (Unity's `ParserBindChannels`). */
export interface ParserBindChannels {
  m_Channels: ShaderBindChannel[];
  m_SourceMap: number;
}

/**
 * Where a parameter or resource is bound, from Unity 6000.6 (Unity's
 * `Binding`).
 */
export interface Binding {
  m_EncodedData: number;
  m_Slot: number;
}

/** A vector parameter (Unity's `VectorParameter`). */
export interface VectorParameter {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Unity 6000.6 and later: `m_Index` renamed. */
  m_OffsetInConstantBuffer?: number;
  m_ArraySize: number;
  m_Type: number;
  m_Dim: number;
}

/** A matrix parameter (Unity's `MatrixParameter`). */
export interface MatrixParameter {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Unity 6000.6 and later: `m_Index` renamed. */
  m_OffsetInConstantBuffer?: number;
  m_ArraySize: number;
  m_Type: number;
  m_RowCount: number;
}

/** A struct parameter of a constant buffer (Unity's `StructParameter`). */
export interface StructParameter {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Unity 6000.6 and later: `m_Index` renamed. */
  m_OffsetInConstantBuffer?: number;
  m_ArraySize: number;
  m_StructSize: number;
  m_VectorMembers: VectorParameter[];
  m_MatrixMembers: MatrixParameter[];
}

/** A texture parameter (Unity's `TextureParameter`). */
export interface TextureParameter {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Before Unity 6000.6. */
  m_SamplerIndex?: number;
  /** Unity 6000.6 and later. */
  m_Binding?: Binding;
  /** Unity 6000.6 and later. */
  m_SamplerBinding?: Binding;
  m_MultiSampled: boolean;
  m_Dim: number;
}

/**
 * A buffer or constant buffer binding (Unity's `BufferBinding`; from 6000.5
 * `BufferBindingParameter`).
 */
export interface BufferBinding {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Unity 6000.6 and later. */
  m_Binding?: Binding;
  /** Unity 2020.1 and later. */
  m_ArraySize?: number;
  /** Unity 6000.6 and later. */
  m_ResourceType?: number;
}

/** A constant buffer (Unity's `ConstantBuffer`; from 6000.5 `ConstantBufferParameter`). */
export interface ConstantBuffer {
  m_NameIndex: number;
  m_MatrixParams: MatrixParameter[];
  m_VectorParams: VectorParameter[];
  m_StructParams: StructParameter[];
  m_Size: number;
  /** Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later. */
  m_IsPartialCB?: boolean;
}

/** An unordered access view parameter (Unity's `UAVParameter`). */
export interface UAVParameter {
  m_NameIndex: number;
  /** Before Unity 6000.6. */
  m_Index?: number;
  /** Before Unity 6000.6. */
  m_OriginalIndex?: number;
  /** Unity 6000.6 and later. */
  m_Binding?: Binding;
  /** Unity 6000.6 and later. */
  m_OriginalBinding?: Binding;
}

/** A sampler (Unity's `SamplerParameter`). */
export interface SamplerParameter {
  sampler: number;
  /** Before Unity 6000.6. */
  bindPoint?: number;
  /** Unity 6000.6 and later. */
  m_Binding?: Binding;
}

/**
 * A program's parameters (Unity's `SerializedProgramParameters`; from 6000.5
 * `ProgramParameters`). Before Unity 2020.3.2 / 2021.1.1 a sub-program holds
 * the same lists as fields of its own.
 */
export interface ProgramParameters {
  m_VectorParams: VectorParameter[];
  m_MatrixParams: MatrixParameter[];
  m_TextureParams: TextureParameter[];
  m_BufferParams: BufferBinding[];
  m_ConstantBuffers: ConstantBuffer[];
  m_ConstantBufferBindings: BufferBinding[];
  m_UAVParams: UAVParameter[];
  m_Samplers: SamplerParameter[];
}

/**
 * One compiled variant of a program stage (Unity's `SerializedSubProgram`):
 * its blob, its keywords and its parameters.
 */
export interface SerializedSubProgram extends Partial<ProgramParameters> {
  /** The index of its code in the platform's part of `compressedBlob`, once decompressed. */
  m_BlobIndex: number;
  m_Channels: ParserBindChannels;
  /** Before Unity 2021.2. */
  m_GlobalKeywordIndices?: number[];
  /** Before Unity 2021.2. */
  m_LocalKeywordIndices?: number[];
  /** Unity 2021.2 and later. */
  m_KeywordIndices?: number[];
  m_ShaderHardwareTier: number;
  /** Unity's `ShaderGpuProgramType` (upstream's enum). */
  m_GpuProgramType: number;
  /**
   * Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later; before that the
   * parameter lists are fields of the sub-program itself.
   */
  m_Parameters?: ProgramParameters;
  /** An `Int32`, from Unity 2021.1 an `Int64`. */
  m_ShaderRequirements: number | bigint;
}

/** A variant as a player uses it (Unity's `SerializedPlayerSubProgram`). */
export interface SerializedPlayerSubProgram {
  m_BlobIndex: number;
  m_KeywordIndices: number[];
  m_ShaderRequirements: bigint;
  m_GpuProgramType: number;
}

/** One program stage of a pass, every variant of it (Unity's `SerializedProgram`). */
export interface SerializedProgram {
  /**
   * Every variant with its parameters. Empty in the 6000.3 and 6000.6 fixtures,
   * which list theirs in `m_PlayerSubPrograms`.
   */
  m_SubPrograms: SerializedSubProgram[];
  /**
   * Unity 2021.3.10 to 2021.3.x, 2022.1.13 to 2022.1.x, and 2022.2 and later:
   * the variants a player uses, grouped as Unity groups them, their parameters
   * in the blob (`m_ParameterBlobIndices`).
   */
  m_PlayerSubPrograms?: SerializedPlayerSubProgram[][];
  /** As `m_PlayerSubPrograms`. */
  m_ParameterBlobIndices?: number[][];
  /** Unity 2020.3.2 to 2020.3.x, and 2021.1.1 and later. */
  m_CommonParameters?: ProgramParameters;
  /** Unity 2022.1 and later. */
  m_SerializedKeywordStateMask?: number[];
}

/** One pass of a sub-shader (Unity's `SerializedPass`). */
export interface SerializedPass {
  /** Unity 2020.2 to 2022.x: one hash per platform. */
  m_EditorDataHash?: Hash128[];
  /** Unity 2020.2 to 2022.x: the `ShaderCompilerPlatform` of each hash. */
  m_Platforms?: Uint8Array;
  /** Unity 2020.2 to 2021.1. */
  m_LocalKeywordMask?: number[];
  /** Unity 2020.2 to 2021.1. */
  m_GlobalKeywordMask?: number[];
  /** Parameter, buffer and keyword names, name to index (`m_NameIndex`). */
  m_NameIndices: [string, number][];
  /** Upstream's `PassType`: 0 normal, 1 `UsePass`, 2 `GrabPass`. */
  m_Type: number;
  m_State: SerializedShaderState;
  m_ProgramMask: number;
  progVertex: SerializedProgram;
  progFragment: SerializedProgram;
  progGeometry: SerializedProgram;
  progHull: SerializedProgram;
  progDomain: SerializedProgram;
  /** Unity 2019.3 and later. */
  progRayTracing?: SerializedProgram;
  m_HasInstancingVariant: boolean;
  m_HasProceduralInstancingVariant: boolean;
  /** For a `UsePass`, the pass it names (`"Shader/PASS"`). */
  m_UseName: string;
  m_Name: string;
  /** For a `GrabPass`, the texture it grabs into. */
  m_TextureName: string;
  m_Tags: SerializedTagMap;
  /** Unity 2021.2 to 2021.x; from 2022.1 on each program has one instead. */
  m_SerializedKeywordStateMask?: number[];
}

/** A sub-shader (Unity's `SerializedSubShader`). */
export interface SerializedSubShader {
  m_Passes: SerializedPass[];
  m_Tags: SerializedTagMap;
  m_LOD: number;
}

/** A texture property's default (Unity's `SerializedTextureProperty`). */
export interface SerializedTextureProperty {
  m_DefaultName: string;
  /** Unity's `TextureDimension`: 2 is 2D, 3 3D, 4 Cube, 5 2DArray, 6 CubeArray. */
  m_TexDim: number;
}

/** A property of the `Properties` block (Unity's `SerializedProperty`). */
export interface SerializedProperty {
  m_Name: string;
  m_Description: string;
  /** The attributes, such as `"Toggle(UAR_FEATURE)"`, without brackets. */
  m_Attributes: string[];
  /** Upstream's `SerializedPropertyType`: 0 Color, 1 Vector, 2 Float, 3 Range, 4 Texture, 5 Int. */
  m_Type: number;
  /** Upstream's `SerializedPropertyFlag` bits (`HideInInspector` 1, `HDR` 16, ...). */
  m_Flags: number;
  /** The default value; for a `Range`, `[default, min, max, 0]`. */
  "m_DefValue[0]": number;
  "m_DefValue[1]": number;
  "m_DefValue[2]": number;
  "m_DefValue[3]": number;
  m_DefTexture: SerializedTextureProperty;
}

/** The parsed ShaderLab of a shader, without its compiled code (Unity's `SerializedShader`). */
export interface SerializedShader {
  m_PropInfo: { m_Props: SerializedProperty[] };
  m_SubShaders: SerializedSubShader[];
  /** Unity 2021.2 and later: every keyword the shader declares. */
  m_KeywordNames?: string[];
  /** Unity 2021.2 and later: a flag byte per keyword of `m_KeywordNames`. */
  m_KeywordFlags?: Uint8Array;
  /** The shader's name, such as `"UAR/ShaderFixture"`. */
  m_Name: string;
  m_CustomEditorName: string;
  m_FallbackName: string;
  /** The `Dependency` lines. */
  m_Dependencies: { from: string; to: string }[];
  /** Unity 2021.1 and later. */
  m_CustomEditorForRenderPipelines?: { customEditorName: string; renderPipelineType: string }[];
  m_DisableNoSubshadersMessage: boolean;
}

/**
 * The fields of a `Shader`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object.
 *
 * A shader is its parsed form plus, in `compressedBlob`, the compiled code of
 * every variant for each platform in `platforms`: platform `i`'s code starts
 * at `offsets[i]`, `compressedLengths[i]` bytes of LZ4 that decompress to
 * `decompressedLengths[i]`. From 2019.3 each of the three is a list per
 * platform, the code split in parts.
 */
export interface Shader extends NamedObject {
  /** The parsed ShaderLab; its `m_Name` is the shader's name (`m_Name` is empty). */
  m_ParsedForm: SerializedShader;
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
  /** The shaders it falls back to or uses passes of. */
  m_Dependencies: PPtr[];
  /** Property name to texture. */
  m_NonModifiableTextures: [string, PPtr][];
  m_ShaderIsBaked: boolean;
  /** Unity 6000.0 and later. */
  m_AssetGUID?: GUID;
  /** Unity 6000.3 and later. */
  m_AssetLocalIdentifierInFile?: bigint;
}

/**
 * Read a `Shader` from the object's first byte: every field Unity's own
 * player type trees give for its version (as UnityPy's TPK data records
 * them), in their order, so the object is consumed to its last byte; it must
 * end exactly there. Unity 2019.1 to 6000.6: older versions are not supported
 * (plan revision 2026-10-16, §4 M2), and `readTypeTree()` still reads them.
 *
 * Upstream (Razviar/assetstudio c37af7d) reads the layouts up to 2022.x and
 * skips the object from Unity 6000 on; its `UNITY_6000_FIXES.md` describes a
 * `< 6000` gate on four pass fields (#52, from AXiX-official/Studio) that its
 * code does not have. TPK puts that change at 2023.1 (the 6000.6.4f1
 * fixtures have none of the four): `m_EditorDataHash` and `m_Platforms` are
 * read for 2020.2 to 2022.x (`m_LocalKeywordMask` and `m_GlobalKeywordMask` to
 * 2021.1, as upstream), so 2023.1 and 2023.2 are not misread. The 2023.1+
 * layouts, with what Unity 6000 added, are TPK's. Where TPK and upstream
 * disagree before that, TPK is taken: `m_IsPartialCB` from 2021.1.1 (upstream: 2021.1.4), and
 * `m_PlayerSubPrograms`, `m_ParameterBlobIndices` and `stageCounts` from
 * 2022.2 on (upstream: 2022.x only). `offsets` and the two lengths stay flat
 * lists before 2019.3, as Unity stores them (upstream wraps each in a list of
 * one). Upstream's game-specific variants are not read.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`) is read as 2019.4
 * when its format is 21, which only 2019.3 and 2019.4 write, and refused
 * otherwise (rule for version-stripped files, #36, as amended): every other
 * format allows Shader layouts that differ inside the object.
 *
 * A version newer than the newest gate (6000.6) is read with 6000.6's layout,
 * as the other class readers do. TPK records two more changes in the 6000.7
 * alphas (`m_SpecializationConstantParams`, `m_SerializedDynamicBranchKeywordMask`);
 * a file with them fails the end-of-object check.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). Alphas
 * and betas with an interim layout (TPK has several: 2019.3.0a7, 2021.2.0a16,
 * 2022.1.0a7 to a15, 2022.2.0a13 to b4, 2023.1.0a1 to a10, 6000.6.0a2 to a6)
 * fail the end-of-object check or misread. Compare `buildType` and the build
 * number in the gates if one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: below 2019.1 (unsupported, see above); for an
 *   unknown version unless the format is 21, and in that format when the
 *   fields after `m_Name` do not fit 2019's layout. Of kind `"build target"`
 *   for an editor file (`BuildTarget.NoTarget`), whose Shader layout differs
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field, with the version known; with it unknown, only inside `m_Name`
 */
export function readShader(reader: ObjectReader): Shader {
  const version = layoutVersion(reader);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Shader> & NamedObject = readNamedObject(reader);
  if (!reader.version.every((part) => part === 0)) {
    readFields(reader, version, out);
  } else {
    // #36 rule, as readMaterial: with the layout assumed, a misfit means
    // "not 2019's layout", which the file cannot tell apart from corruption.
    try {
      readFields(reader, version, out);
    } catch (error) {
      if (!(error instanceof CorruptError)) throw error;
      throw refuse(
        reader,
        `the object does not fit 2019's Shader layout, the only one format 21 allows ` +
          `(${error.message})`,
      );
    }
  }
  // Every required field was set above.
  return out as Shader;
}

/** The fields after `m_Name`, and the end-of-object check. */
function readFields(reader: ObjectReader, v: UnityVersion, out: Partial<Shader>): void {
  out.m_ParsedForm = readSerializedShader(reader, v);
  out.platforms = readUInt32s(reader, "platforms");
  // 2019.3+: a list per platform (the blob of each platform in parts).
  const lengths = atLeast(v, 2019, 3)
    ? (what: string) => readList(reader, what, (r) => readUInt32s(r, `${what} entry`))
    : (what: string) => readUInt32s(reader, what);
  out.offsets = lengths("offsets");
  out.compressedLengths = lengths("compressedLengths");
  out.decompressedLengths = lengths("decompressedLengths");
  out.compressedBlob = readByteArray(reader, "compressedBlob");
  if (since(v, [2022, 2, 0], [2021, 3, 12], [2022, 1, 21])) {
    out.stageCounts = readUInt32s(reader, "stageCounts");
  }
  out.m_Dependencies = readList(reader, "m_Dependencies", readPPtr);
  out.m_NonModifiableTextures = readList(reader, "m_NonModifiableTextures", (r) => [
    readString(r, "m_NonModifiableTextures name"),
    readPPtr(r),
  ]);
  out.m_ShaderIsBaked = readBool(reader, true);
  if (atLeast(v, 6000, 0)) out.m_AssetGUID = readGUID(reader);
  if (atLeast(v, 6000, 3)) out.m_AssetLocalIdentifierInFile = reader.readInt64();
  endOfObject(reader, "Shader");
}

/**
 * The version whose layout the object has: the file's own, or 2019.4's for an
 * unknown version in format 21 (see `readShader`).
 *
 * @throws {UnsupportedError} when no layout can be picked, or for an editor file
 */
function layoutVersion(reader: ObjectReader): UnityVersion {
  const { version, format } = reader;
  let layout = version;
  if (version.every((part) => part === 0)) {
    if (format !== V.StoresTypeDependencies) {
      throw refuse(
        reader,
        `a Shader's layout depends on the Unity version, which this format ${format} file ` +
          "does not record, and its bytes cannot decide it",
      );
    }
    layout = [2019, 4, 0, 0];
  } else if (!atLeast(version, 2019, 1)) {
    // Plan revision 2026-10-16 (§4 M2): nothing older than Unity 2019 is supported.
    throw refuse(reader, "Shaders before Unity 2019.1 are not supported");
  }
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's Shader has another layout`,
    );
  }
  return layout;
}

/**
 * Whether `v` has a field Unity added in the `mainline` release and backported
 * to the patch releases `backports` of older minor versions. Each backport
 * covers its own `major.minor` only.
 */
function since(
  v: UnityVersion,
  mainline: [number, number, number],
  ...backports: [number, number, number][]
): boolean {
  if (atLeast(v, ...mainline)) return true;
  return backports.some(([major, minor, patch]) =>
    v[0] === major && v[1] === minor && v[2] >= patch,
  );
}

/**
 * Whether `v` has the program parameters struct (`m_Parameters`,
 * `m_CommonParameters`) and `m_IsPartialCB`: 2021.1.1 and later, backported
 * to 2020.3.2 (TPK; upstream: `m_IsPartialCB` from 2021.1.4).
 */
const hasProgramParameters = (v: UnityVersion): boolean => since(v, [2021, 1, 1], [2020, 3, 2]);

function readSerializedShader(reader: ObjectReader, v: UnityVersion): SerializedShader {
  const out: Partial<SerializedShader> = {
    m_PropInfo: { m_Props: readList(reader, "m_Props", readProperty) },
    m_SubShaders: readList(reader, "m_SubShaders", (r) => ({
      m_Passes: readList(r, "m_Passes", (p) => readPass(p, v)),
      m_Tags: readTagMap(r),
      m_LOD: r.readInt32(),
    })),
  };
  if (atLeast(v, 2021, 2)) {
    out.m_KeywordNames = readStrings(reader, "m_KeywordNames");
    out.m_KeywordFlags = readByteArray(reader, "m_KeywordFlags");
  }
  out.m_Name = readString(reader, "m_ParsedForm.m_Name");
  out.m_CustomEditorName = readString(reader, "m_CustomEditorName");
  out.m_FallbackName = readString(reader, "m_FallbackName");
  out.m_Dependencies = readList(reader, "m_ParsedForm.m_Dependencies", (r) => ({
    from: readString(r, "m_Dependencies from"),
    to: readString(r, "m_Dependencies to"),
  }));
  if (atLeast(v, 2021, 1)) {
    out.m_CustomEditorForRenderPipelines = readList(
      reader,
      "m_CustomEditorForRenderPipelines",
      (r) => ({
        customEditorName: readString(r, "customEditorName"),
        renderPipelineType: readString(r, "renderPipelineType"),
      }),
    );
  }
  out.m_DisableNoSubshadersMessage = readBool(reader, true);
  return out as SerializedShader;
}

function readProperty(reader: ObjectReader): SerializedProperty {
  return {
    m_Name: readString(reader, "m_Props m_Name"),
    m_Description: readString(reader, "m_Description"),
    m_Attributes: readStrings(reader, "m_Attributes"),
    m_Type: reader.readInt32(),
    m_Flags: reader.readUInt32(),
    "m_DefValue[0]": reader.readFloat32(),
    "m_DefValue[1]": reader.readFloat32(),
    "m_DefValue[2]": reader.readFloat32(),
    "m_DefValue[3]": reader.readFloat32(),
    m_DefTexture: {
      m_DefaultName: readString(reader, "m_DefaultName"),
      m_TexDim: reader.readInt32(),
    },
  };
}

function readPass(reader: ObjectReader, v: UnityVersion): SerializedPass {
  const out: Partial<SerializedPass> = {};
  // 2020.2 to 2022.x (TPK: gone from 2023.1.0a9). Upstream reads them from
  // 2020.2 on; #52's fix stops them at 6000.
  if (atLeast(v, 2020, 2) && !atLeast(v, 2023, 1)) {
    out.m_EditorDataHash = readList(reader, "m_EditorDataHash", readHash128);
    out.m_Platforms = readByteArray(reader, "m_Platforms");
    // 2021.2 replaced the masks with m_SerializedKeywordStateMask.
    if (!atLeast(v, 2021, 2)) {
      out.m_LocalKeywordMask = readUInt16s(reader, "m_LocalKeywordMask");
      out.m_GlobalKeywordMask = readUInt16s(reader, "m_GlobalKeywordMask");
    }
  }
  out.m_NameIndices = readList(reader, "m_NameIndices", (r): [string, number] => [
    readString(r, "m_NameIndices name"),
    r.readInt32(),
  ]);
  out.m_Type = reader.readInt32();
  out.m_State = readState(reader, v);
  out.m_ProgramMask = reader.readUInt32();
  out.progVertex = readProgram(reader, v);
  out.progFragment = readProgram(reader, v);
  out.progGeometry = readProgram(reader, v);
  out.progHull = readProgram(reader, v);
  out.progDomain = readProgram(reader, v);
  if (atLeast(v, 2019, 3)) out.progRayTracing = readProgram(reader, v);
  out.m_HasInstancingVariant = readBool(reader, false);
  out.m_HasProceduralInstancingVariant = readBool(reader, false);
  reader.align();
  out.m_UseName = readString(reader, "m_UseName");
  out.m_Name = readString(reader, "m_Name");
  out.m_TextureName = readString(reader, "m_TextureName");
  out.m_Tags = readTagMap(reader);
  // 2021.2 to 2021.x; 2022.1 moved it into each program.
  if (atLeast(v, 2021, 2) && !atLeast(v, 2022, 1)) {
    out.m_SerializedKeywordStateMask = readUInt16s(reader, "m_SerializedKeywordStateMask");
  }
  return out as SerializedPass;
}

function readState(reader: ObjectReader, v: UnityVersion): SerializedShaderState {
  const value = (): SerializedShaderFloatValue => readFloatValue(reader);
  const stencil = (): SerializedStencilOp => ({
    pass: value(),
    fail: value(),
    zFail: value(),
    comp: value(),
  });
  const blend = (): SerializedShaderRTBlendState => ({
    srcBlend: value(),
    destBlend: value(),
    srcBlendAlpha: value(),
    destBlendAlpha: value(),
    blendOp: value(),
    blendOpAlpha: value(),
    colMask: value(),
  });
  const out: Partial<SerializedShaderState> = {
    m_Name: readString(reader, "m_State m_Name"),
    rtBlend0: blend(),
    rtBlend1: blend(),
    rtBlend2: blend(),
    rtBlend3: blend(),
    rtBlend4: blend(),
    rtBlend5: blend(),
    rtBlend6: blend(),
    rtBlend7: blend(),
  };
  out.rtSeparateBlend = readBool(reader, true);
  out.zClip = value();
  out.zTest = value();
  out.zWrite = value();
  out.culling = value();
  if (atLeast(v, 2020, 1)) out.conservative = value();
  out.offsetFactor = value();
  out.offsetUnits = value();
  out.alphaToMask = value();
  out.stencilOp = stencil();
  out.stencilOpFront = stencil();
  out.stencilOpBack = stencil();
  out.stencilReadMask = value();
  out.stencilWriteMask = value();
  out.stencilRef = value();
  out.fogStart = value();
  out.fogEnd = value();
  out.fogDensity = value();
  out.fogColor = {
    x: value(),
    y: value(),
    z: value(),
    w: value(),
    name: readString(reader, "fogColor name"),
  };
  out.fogMode = reader.readInt32();
  out.gpuProgramID = reader.readInt32();
  out.m_Tags = readTagMap(reader);
  out.m_LOD = reader.readInt32();
  out.lighting = readBool(reader, true);
  return out as SerializedShaderState;
}

/** A `SerializedShaderFloatValue`. */
function readFloatValue(reader: ObjectReader): SerializedShaderFloatValue {
  return { val: reader.readFloat32(), name: readString(reader, "float value name") };
}

function readProgram(reader: ObjectReader, v: UnityVersion): SerializedProgram {
  const out: SerializedProgram = {
    m_SubPrograms: readList(reader, "m_SubPrograms", (r) => readSubProgram(r, v)),
  };
  if (since(v, [2022, 2, 0], [2021, 3, 10], [2022, 1, 13])) {
    out.m_PlayerSubPrograms = readList(reader, "m_PlayerSubPrograms", (r) =>
      readList(r, "m_PlayerSubPrograms entry", (p) => ({
        m_BlobIndex: p.readUInt32(),
        m_KeywordIndices: readUInt16s(p, "m_PlayerSubPrograms m_KeywordIndices"),
        m_ShaderRequirements: p.readInt64(),
        m_GpuProgramType: readInt8Aligned(p),
      })),
    );
    out.m_ParameterBlobIndices = readList(reader, "m_ParameterBlobIndices", (r) =>
      readUInt32s(r, "m_ParameterBlobIndices entry"),
    );
  }
  if (hasProgramParameters(v)) out.m_CommonParameters = readParameters(reader, v);
  if (atLeast(v, 2022, 1)) {
    out.m_SerializedKeywordStateMask = readUInt16s(reader, "m_SerializedKeywordStateMask");
  }
  return out;
}

function readSubProgram(reader: ObjectReader, v: UnityVersion): SerializedSubProgram {
  const m_BlobIndex = reader.readUInt32();
  const m_Channels = readList(reader, "m_Channels", (r) => ({
    source: r.readInt8(),
    target: r.readInt8(),
  }));
  reader.align();
  const m_SourceMap = reader.readInt32();
  const out = { m_BlobIndex, m_Channels: { m_Channels, m_SourceMap } } as SerializedSubProgram;
  // 2019.1 to 2021.1: global and local keywords apart.
  if (!atLeast(v, 2021, 2)) {
    out.m_GlobalKeywordIndices = readUInt16s(reader, "m_GlobalKeywordIndices");
    out.m_LocalKeywordIndices = readUInt16s(reader, "m_LocalKeywordIndices");
  } else {
    out.m_KeywordIndices = readUInt16s(reader, "m_KeywordIndices");
  }
  out.m_ShaderHardwareTier = reader.readInt8();
  out.m_GpuProgramType = readInt8Aligned(reader);
  if (hasProgramParameters(v)) {
    out.m_Parameters = readParameters(reader, v);
  } else {
    Object.assign(out, readParameters(reader, v));
  }
  // 2021.1: Int64.
  out.m_ShaderRequirements = atLeast(v, 2021, 1) ? reader.readInt64() : reader.readInt32();
  return out;
}

/** The parameter lists, as a struct of their own or as a sub-program's fields. */
function readParameters(reader: ObjectReader, v: UnityVersion): ProgramParameters {
  const out: Partial<ProgramParameters> = {
    m_VectorParams: readList(reader, "m_VectorParams", (r) => readVector(r, v)),
    m_MatrixParams: readList(reader, "m_MatrixParams", (r) => readMatrix(r, v)),
    m_TextureParams: readList(reader, "m_TextureParams", (r) => readTexture(r, v)),
    m_BufferParams: readList(reader, "m_BufferParams", (r) => readBufferBinding(r, v)),
    m_ConstantBuffers: readList(reader, "m_ConstantBuffers", (r) => readConstantBuffer(r, v)),
    m_ConstantBufferBindings: readList(reader, "m_ConstantBufferBindings", (r) =>
      readBufferBinding(r, v),
    ),
    m_UAVParams: readList(reader, "m_UAVParams", (r) => readUAV(r, v)),
  };
  out.m_Samplers = readList(reader, "m_Samplers", (r) => {
    const sampler = r.readUInt32();
    return atLeast(v, 6000, 6)
      ? { sampler, m_Binding: readBinding(r) }
      : { sampler, bindPoint: r.readInt32() };
  });
  return out as ProgramParameters;
}

/** `m_Index` before 6000.6, renamed `m_OffsetInConstantBuffer` there. */
function readIndex(reader: ObjectReader, v: UnityVersion): Partial<VectorParameter> {
  return atLeast(v, 6000, 6)
    ? { m_OffsetInConstantBuffer: reader.readInt32() }
    : { m_Index: reader.readInt32() };
}

function readVector(reader: ObjectReader, v: UnityVersion): VectorParameter {
  return {
    m_NameIndex: reader.readInt32(),
    ...readIndex(reader, v),
    m_ArraySize: reader.readInt32(),
    m_Type: reader.readInt8(),
    m_Dim: readInt8Aligned(reader),
  } as VectorParameter;
}

function readMatrix(reader: ObjectReader, v: UnityVersion): MatrixParameter {
  return {
    m_NameIndex: reader.readInt32(),
    ...readIndex(reader, v),
    m_ArraySize: reader.readInt32(),
    m_Type: reader.readInt8(),
    m_RowCount: readInt8Aligned(reader),
  } as MatrixParameter;
}

function readTexture(reader: ObjectReader, v: UnityVersion): TextureParameter {
  const out: Partial<TextureParameter> = { m_NameIndex: reader.readInt32() };
  if (atLeast(v, 6000, 6)) {
    out.m_Binding = readBinding(reader);
    out.m_SamplerBinding = readBinding(reader);
  } else {
    out.m_Index = reader.readInt32();
    out.m_SamplerIndex = reader.readInt32();
  }
  out.m_MultiSampled = readBool(reader, false);
  out.m_Dim = readInt8Aligned(reader);
  return out as TextureParameter;
}

function readBufferBinding(reader: ObjectReader, v: UnityVersion): BufferBinding {
  const out: BufferBinding = { m_NameIndex: reader.readInt32() };
  if (atLeast(v, 6000, 6)) out.m_Binding = readBinding(reader);
  else out.m_Index = reader.readInt32();
  if (atLeast(v, 2020, 1)) out.m_ArraySize = reader.readInt32();
  if (atLeast(v, 6000, 6)) out.m_ResourceType = reader.readInt32();
  return out;
}

function readConstantBuffer(reader: ObjectReader, v: UnityVersion): ConstantBuffer {
  const out: Partial<ConstantBuffer> = {
    m_NameIndex: reader.readInt32(),
    m_MatrixParams: readList(reader, "m_MatrixParams", (r) => readMatrix(r, v)),
    m_VectorParams: readList(reader, "m_VectorParams", (r) => readVector(r, v)),
  };
  out.m_StructParams = readList(reader, "m_StructParams", (r) => ({
    m_NameIndex: r.readInt32(),
    ...readIndex(r, v),
    m_ArraySize: r.readInt32(),
    m_StructSize: r.readInt32(),
    m_VectorMembers: readList(r, "m_VectorMembers", (m) => readVector(m, v)),
    m_MatrixMembers: readList(r, "m_MatrixMembers", (m) => readMatrix(m, v)),
  }) as StructParameter);
  out.m_Size = reader.readInt32();
  if (hasProgramParameters(v)) out.m_IsPartialCB = readBool(reader, true);
  return out as ConstantBuffer;
}

function readUAV(reader: ObjectReader, v: UnityVersion): UAVParameter {
  const m_NameIndex = reader.readInt32();
  return atLeast(v, 6000, 6)
    ? { m_NameIndex, m_Binding: readBinding(reader), m_OriginalBinding: readBinding(reader) }
    : { m_NameIndex, m_Index: reader.readInt32(), m_OriginalIndex: reader.readInt32() };
}

function readBinding(reader: ObjectReader): Binding {
  return { m_EncodedData: reader.readUInt32(), m_Slot: reader.readUInt32() };
}

function readTagMap(reader: ObjectReader): SerializedTagMap {
  return {
    tags: readList(reader, "tags", (r): [string, string] => [
      readString(r, "tag name"),
      readString(r, "tag value"),
    ]),
  };
}

// --- primitives ----------------------------------------------------------------

/** An `Int32` count, then that many elements. */
function readList<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  return readArray(reader, "Shader", what, element);
}

function readString(reader: ObjectReader, what: string): string {
  return readStringField(reader, "Shader", what);
}

/** A `vector<string>`. */
function readStrings(reader: ObjectReader, what: string): string[] {
  return readList(reader, what, (r) => readString(r, `${what} element`));
}

/** A `vector<UInt8>`, aligned after: a view into the object's bytes (R7). */
function readByteArray(reader: ObjectReader, what: string): Uint8Array {
  const bytes = reader.readBytes(readCount(reader, `Shader ${reader.pathId} ${what} byte`));
  reader.align();
  return bytes;
}

/** A `vector<UInt16>`, aligned after. */
function readUInt16s(reader: ObjectReader, what: string): number[] {
  const out = readList(reader, what, (r) => r.readUInt16());
  reader.align();
  return out;
}

/** A `vector<unsigned int>`. */
function readUInt32s(reader: ObjectReader, what: string): number[] {
  return readList(reader, what, (r) => r.readUInt32());
}

/** An `SInt8` the type tree aligns after. */
function readInt8Aligned(reader: ObjectReader): number {
  const value = reader.readInt8();
  reader.align();
  return value;
}

/** A one-byte bool, aligned after when the type tree says so. */
function readBool(reader: ObjectReader, aligned: boolean): boolean {
  const value = reader.readUInt8() !== 0;
  if (aligned) reader.align();
  return value;
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
}
