// Ported from AssetStudio.Utility/ShaderConverter.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio.Utility/SpirVShaderConverter.cs (MIT, © Perfare / RazTools / Razviar)

import {
  CorruptError,
  decompressLz4,
  UnsupportedError,
  type SerializedPass,
  type SerializedProgram,
  type SerializedProperty,
  type SerializedShaderFloatValue,
  type SerializedShaderRTBlendState,
  type SerializedShaderState,
  type SerializedStencilOp,
  type SerializedSubProgram,
  type SerializedSubShader,
  type SerializedTagMap,
  type Shader,
} from "unity-asset-reader";
import { formatSingle, formatSingleInvariant } from "./float.js";
import { decodeUtf8, DisassemblyError, StreamReader } from "./net.js";
import { decodedBufferSize, decodeSmolv } from "./smolv.js";
import { disassemble } from "./spirv.js";

/** AssetStudio's `ShaderCompilerPlatform`, the values of `Shader.platforms`. */
const Platform = {
  GL: 0,
  D3D9: 1,
  Xbox360: 2,
  PS3: 3,
  D3D11: 4,
  GLES20: 5,
  NaCl: 6,
  Flash: 7,
  D3D11_9x: 8,
  GLES3Plus: 9,
  PSP2: 10,
  PS4: 11,
  XboxOne: 12,
  PSM: 13,
  Metal: 14,
  OpenGLCore: 15,
  N3DS: 16,
  WiiU: 17,
  Vulkan: 18,
  Switch: 19,
  XboxOneD3D12: 20,
  GameCoreXboxOne: 21,
  GameCoreScarlett: 22,
  PS5: 23,
  PS5NGGC: 24,
} as const;

/** AssetStudio's `ShaderGpuProgramType`, by value: a sub-program's `m_GpuProgramType`. */
const PROGRAM_TYPES = [
  "Unknown",
  "GLLegacy",
  "GLES31AEP",
  "GLES31",
  "GLES3",
  "GLES",
  "GLCore32",
  "GLCore41",
  "GLCore43",
  "DX9VertexSM20",
  "DX9VertexSM30",
  "DX9PixelSM20",
  "DX9PixelSM30",
  "DX10Level9Vertex",
  "DX10Level9Pixel",
  "DX11VertexSM40",
  "DX11VertexSM50",
  "DX11PixelSM40",
  "DX11PixelSM50",
  "DX11GeometrySM40",
  "DX11GeometrySM50",
  "DX11HullSM50",
  "DX11DomainSM50",
  "MetalVS",
  "MetalFS",
  "SPIRV",
  "ConsoleVS",
  "ConsoleFS",
  "ConsoleHS",
  "ConsoleDS",
  "ConsoleGS",
  "RayTracing",
  "PS5NGGC",
] as const;

type ProgramType = (typeof PROGRAM_TYPES)[number];

/** `ShaderGpuProgramType`'s name, or the number for a value it does not name. */
const programTypeName = (type: number): string => PROGRAM_TYPES[type] ?? String(type);

const HEADER =
  "//////////////////////////////////////////\n" +
  "//\n" +
  "// NOTE: This is *not* a valid shader file\n" +
  "//\n" +
  "///////////////////////////////////////////\n";

/**
 * Turn a `Shader` into the inspection text AssetStudio's
 * `ShaderConverter.Convert()` writes (its `.shader` export), byte for byte:
 * a "not a valid shader file" banner, then the ShaderLab as Unity parsed it
 * (properties, sub-shaders, passes, render state, tags) with each pass's
 * compiled programs in it, per stage and variant, under the platform's name:
 *
 * - OpenGL, OpenGL ES and OpenGL Core: the GLSL source as stored, after a
 *   `// hash:` line;
 * - Metal: the Metal source, after the hash line;
 * - Vulkan: the SPIR-V of each stage, decoded from SMOL-V and disassembled
 *   as CSspv does, after the hash line; where AssetStudio fails to decode or
 *   disassemble it, the `// disassembly error <message>` line it writes then;
 * - console platforms: the program bytes as UTF-8; other program types: a
 *   line saying AssetStudio does not disassemble them.
 *
 * Lines end with `\n`; the text has no final newline. Encode it as UTF-8
 * (`TextEncoder`) for the file AssetStudio writes.
 *
 * Unity 2019.1 and later, as `obj.read()` reads them. A shader built by Unity
 * 2021.3.10, 2022.1.13, 2022.2 or later usually lists its variants in
 * `m_PlayerSubPrograms`, which AssetStudio's converter does not read: such a
 * shader is refused rather than written without its programs.
 *
 * @param shader a Shader as `obj.read()` gives it
 * @returns the text
 * @throws {UnsupportedError} for a Direct3D program (DX9, DX10 level 9,
 *   DX11), which AssetStudio turns into text with Windows' D3DCompiler or
 *   HLSLDecompiler; for variants in `m_PlayerSubPrograms`; for a property of
 *   type `Int` (5, Unity 2021.1+ `Integer`), on which AssetStudio fails too;
 *   for a platform AssetStudio does not know (NaCl, Flash, PSM, or a value it
 *   has no name for)
 * @throws {CorruptError} when a platform's blob does not decompress to its
 *   size, or a program's entry or bytes run past the blob
 * @example
 * const text = shaderToText(env.objects.find((o) => o.type === ClassID.Shader)!.read<Shader>());
 */
export function shaderToText(shader: Shader): string {
  const form = shader.m_ParsedForm;
  for (const subShader of form.m_SubShaders) {
    for (const pass of subShader.m_Passes) {
      for (const [, program] of stages(pass)) {
        const players = program.m_PlayerSubPrograms?.reduce((n, group) => n + group.length, 0);
        if (players) {
          throw new UnsupportedError(
            "shader variant list",
            "m_PlayerSubPrograms",
            `${players} variants of pass "${pass.m_State.m_Name}" are listed there, ` +
              "which AssetStudio's ShaderConverter does not read",
          );
        }
      }
    }
  }
  const programs = readPrograms(shader);
  let out = `Shader "${form.m_Name}" {\n`;
  out += propertiesText(form.m_PropInfo.m_Props);
  for (const subShader of form.m_SubShaders) {
    out += subShaderText(subShader, shader.platforms, programs);
  }
  if (form.m_FallbackName) out += `Fallback "${form.m_FallbackName}"\n`;
  if (form.m_CustomEditorName) out += `CustomEditor "${form.m_CustomEditorName}"\n`;
  out += "}";
  return HEADER + out;
}

/** A pass's program stages, with the name ShaderLab gives each. */
function stages(pass: SerializedPass): [string, SerializedProgram][] {
  const out: [string, SerializedProgram][] = [
    ["vp", pass.progVertex],
    ["fp", pass.progFragment],
    ["gp", pass.progGeometry],
    ["hp", pass.progHull],
    ["dp", pass.progDomain],
  ];
  if (pass.progRayTracing) out.push(["rtp", pass.progRayTracing]);
  return out;
}

// --- the compiled programs (ShaderProgram, ShaderSubProgram) -----------------

/** One compiled program of the blob (`ShaderSubProgram`). */
interface SubProgram {
  type: number;
  keywords: string[];
  localKeywords: string[] | undefined;
  code: Uint8Array;
}

/**
 * Every platform's programs, by blob index: each platform's part of the blob,
 * decompressed, holds a table of entries (offset, length and, from Unity
 * 2019.3, the segment the program is in) and the programs.
 */
function readPrograms(shader: Shader): (SubProgram | undefined)[][] {
  // Before 2019.3 each of the three is one value per platform, from 2019.3 a
  // list (the segments); the entries name a segment from 2019.3 on.
  const segmented = shader.offsets.some((o) => Array.isArray(o));
  const list = (v: number | number[] | undefined): number[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  return shader.platforms.map((platform, i) => {
    const offsets = list(shader.offsets[i]);
    const compressed = list(shader.compressedLengths[i]);
    const decompressed = list(shader.decompressedLengths[i]);
    let entries: { offset: number; length: number; segment: number }[] = [];
    const programs: (SubProgram | undefined)[] = [];
    offsets.forEach((offset, j) => {
      const size = decompressed[j];
      const packed = compressed[j];
      const blobSize = shader.compressedBlob.length;
      if (size === undefined || packed === undefined || offset + packed > blobSize) {
        throw new CorruptError(
          `Shader: platform ${platform} segment ${j} (offset ${offset}, ${packed} bytes) ` +
            `runs past the ${blobSize}-byte blob`,
        );
      }
      const bytes = decompressLz4(shader.compressedBlob.subarray(offset, offset + packed), size);
      const reader = new BlobReader(bytes);
      if (j === 0) entries = readEntries(reader, segmented);
      entries.forEach((entry, k) => {
        if (entry.segment !== j) return;
        reader.position = entry.offset;
        programs[k] = readSubProgram(reader);
      });
    });
    return programs;
  });
}

/** `ShaderProgram`'s entry table: count, then offset, length (and segment). */
function readEntries(
  reader: BlobReader,
  segmented: boolean,
): { offset: number; length: number; segment: number }[] {
  const count = reader.int32();
  if (count < 0) throw reader.fail(`a negative entry count, ${count}`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const offset = reader.int32();
    const length = reader.int32();
    entries.push({ offset, length, segment: segmented ? reader.int32() : 0 });
  }
  return entries;
}

/** `ShaderSubProgram(reader)`. */
function readSubProgram(reader: BlobReader): SubProgram {
  // The blob's format version: 201806140 for 2019.1 to 2021.1, 202012090
  // from 2021.2.
  const version = reader.int32();
  const type = reader.int32();
  reader.position += 12;
  if (version >= 201608170) reader.position += 4;
  const keywords = reader.strings();
  // 2019.1 to 2021.1: local keywords apart.
  const localKeywords = version >= 201806140 && version < 202012090 ? reader.strings() : undefined;
  const code = reader.bytes(reader.int32());
  reader.align();
  return { type, keywords, localKeywords, code };
}

/**
 * A little-endian reader over one decompressed blob part (`EndianBinaryReader`),
 * failing with a `CorruptError` where the C# throws.
 */
class BlobReader {
  position = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  fail(what: string): CorruptError {
    return new CorruptError(
      `Shader blob: ${what}, at offset ${this.position} of ${this.data.length} bytes`,
    );
  }

  private take(count: number): number {
    const at = this.position;
    if (count < 0 || at < 0 || at + count > this.data.length) {
      throw this.fail(`${count} bytes past the end`);
    }
    this.position += count;
    return at;
  }

  int32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  bytes(count: number): Uint8Array {
    const at = this.take(count);
    return this.data.subarray(at, at + count);
  }

  align(): void {
    this.position = (this.position + 3) & ~3;
  }

  /** `ReadAlignedString`: an invalid length reads as `""`, aligned after. */
  string(): string {
    const length = this.int32();
    let text = "";
    if (length > 0 && length <= this.data.length - this.position) {
      text = decodeUtf8(this.bytes(length));
    }
    this.align();
    return text;
  }

  /** A count, then that many aligned strings. */
  strings(): string[] {
    const count = this.int32();
    if (count < 0) throw this.fail(`a negative string count, ${count}`);
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(this.string());
    return out;
  }
}

/** `ShaderSubProgram.Export()`: keywords, then the program in quotes. */
function subProgramText(program: SubProgram): string {
  let out = "";
  if (program.keywords.length > 0) {
    out += `Keywords { ${program.keywords.map((k) => `"${k}" `).join("")}}\n`;
  }
  if (program.localKeywords && program.localKeywords.length > 0) {
    out += `Local Keywords { ${program.localKeywords.map((k) => `"${k}" `).join("")}}\n`;
  }
  out += '"';
  const code = program.code;
  if (code.length > 0) {
    const type = programTypeName(program.type) as ProgramType | string;
    switch (type) {
      case "GLLegacy":
      case "GLES31AEP":
      case "GLES31":
      case "GLES3":
      case "GLES":
      case "GLCore32":
      case "GLCore41":
      case "GLCore43":
        out += `// hash: ${hash64(code)}\n${decodeUtf8(code)}`;
        break;
      case "DX9VertexSM20":
      case "DX9VertexSM30":
      case "DX9PixelSM20":
      case "DX9PixelSM30":
      case "DX10Level9Vertex":
      case "DX10Level9Pixel":
      case "DX11VertexSM40":
      case "DX11VertexSM50":
      case "DX11PixelSM40":
      case "DX11PixelSM50":
      case "DX11GeometrySM40":
      case "DX11GeometrySM50":
      case "DX11HullSM50":
      case "DX11DomainSM50":
        throw new UnsupportedError(
          "shader program type",
          type,
          "AssetStudio turns Direct3D bytecode into text with Windows' D3DCompiler or " +
            "HLSLDecompiler",
        );
      case "MetalVS":
      case "MetalFS":
        out += `// hash: ${hash64(code)}\n${metalSource(code)}`;
        break;
      case "SPIRV":
        out += `// hash: ${hash64(code)}\n`;
        try {
          out += spirvText(code);
        } catch (error) {
          if (!(error instanceof DisassemblyError)) throw error;
          out += `// disassembly error ${error.message}\n`;
        }
        break;
      case "ConsoleVS":
      case "ConsoleFS":
      case "ConsoleHS":
      case "ConsoleDS":
      case "ConsoleGS":
        out += `//hash: ${hash64(code)}\n${decodeUtf8(code)}`;
        break;
      default:
        out += `//hash: ${hash64(code)}\n//shader disassembly not supported on ${type}`;
        break;
    }
  }
  return out + '"';
}

/**
 * A Metal program: after a `0xf00dcafe` header the source starts at the
 * offset it gives; the entry point's name, NUL-terminated, comes first.
 */
function metalSource(code: Uint8Array): string {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  if (code.length < 4) throw new CorruptError(`Metal program: ${code.length} bytes, no header`);
  let position = 4;
  if (view.getUint32(0, true) === 0xf00dcafe) {
    if (code.length < 8) throw new CorruptError("Metal program: its header has no offset");
    position = view.getInt32(4, true);
    if (position < 0 || position > code.length) {
      throw new CorruptError(
        `Metal program: source offset ${position} past its ${code.length} bytes`,
      );
    }
  }
  // ReadStringToNull: up to a NUL or 32767 bytes.
  let count = 0;
  while (position < code.length && count < 32767) {
    const b = code[position++]!;
    if (b === 0) break;
    count++;
  }
  return decodeUtf8(code.subarray(position));
}

/**
 * `SpirVShaderConverter.Convert`: a Vulkan program's requirements word, then
 * up to five (offset, size) pairs, one per stage snippet, each SMOL-V; the
 * first snippet's offset ends the table.
 */
function spirvText(code: Uint8Array): string {
  const reader = new StreamReader(code);
  reader.readInt32(); // requirements
  let minOffset = code.length;
  let out = "";
  for (let i = 0; i < 5; i++) {
    if (reader.position >= minOffset) break;
    const offset = reader.readInt32();
    const size = reader.readInt32();
    if (size > 0) {
      if (offset < minOffset) minOffset = offset;
      const position = reader.position;
      out += snippetText(reader, offset, size);
      reader.position = position;
    }
  }
  return out;
}

/** `SpirVShaderConverter.ExportSnippet`: one stage, SMOL-V decoded and disassembled. */
function snippetText(reader: StreamReader, offset: number, size: number): string {
  if (offset < 0) {
    // MemoryStream.Position = a negative value.
    throw new DisassemblyError("Non-negative number required. (Parameter 'value')");
  }
  reader.position = offset;
  const decodedSize = decodedBufferSize(reader);
  if (decodedSize === 0) throw new DisassemblyError("Invalid SMOL-V shader header");
  if (decodedSize < 0) throw new DisassemblyError("Arithmetic operation resulted in an overflow.");
  const decoded = new Uint8Array(decodedSize);
  if (!decodeSmolv(reader, size, decoded)) {
    throw new DisassemblyError("Unable to decode SMOL-V shader");
  }
  return disassemble(decoded);
}

/**
 * `ComputeHash64`: `h = h × 0x100000001B3 ^ b` over the bytes, 64 bits, in
 * lowercase hex of at least 8 digits.
 */
function hash64(bytes: Uint8Array): string {
  // The 64-bit value as two 32-bit halves; × (2^40 + 0x1B3) is a shift plus a
  // product that stays below 2^53.
  let lo = 0;
  let hi = 0;
  for (const b of bytes) {
    const low = lo * 0x1b3;
    const carry = Math.floor(low / 0x100000000);
    const high = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) % 0x100000000;
    lo = (low % 0x100000000) ^ b;
    lo >>>= 0;
    hi = high >>> 0;
  }
  const low = lo.toString(16);
  return hi === 0 ? low.padStart(8, "0") : hi.toString(16) + low.padStart(8, "0");
}

// --- the ShaderLab text -------------------------------------------------------

/** `ConvertSerializedSubShader`. */
function subShaderText(
  subShader: SerializedSubShader,
  platforms: number[],
  programs: (SubProgram | undefined)[][],
): string {
  let out = "SubShader {\n";
  if (subShader.m_LOD !== 0) out += ` LOD ${subShader.m_LOD}\n`;
  out += tagsText(subShader.m_Tags, 1);
  for (const pass of subShader.m_Passes) out += passText(pass, platforms, programs);
  return out + "}\n";
}

/** `ConvertSerializedPass`: upstream's `PassType` 0 normal, 1 `UsePass`, 2 `GrabPass`. */
function passText(
  pass: SerializedPass,
  platforms: number[],
  programs: (SubProgram | undefined)[][],
): string {
  let out = [" Pass ", " UsePass ", " GrabPass "][pass.m_Type] ?? "";
  if (pass.m_Type === 1) return `${out}"${pass.m_UseName}"\n`;
  out += "{\n";
  if (pass.m_Type === 2) {
    if (pass.m_TextureName) out += `  "${pass.m_TextureName}"\n`;
  } else {
    out += stateText(pass.m_State);
    for (const [name, program] of stages(pass)) {
      if (program.m_SubPrograms.length > 0) {
        out += `Program "${name}" {\n`;
        out += subProgramsText(program.m_SubPrograms, platforms, programs);
        out += "}\n";
      }
    }
  }
  return out + "}\n";
}

/**
 * `ConvertSerializedSubPrograms`: the variants grouped by blob index, then by
 * program type, each written for the first platform that runs its type.
 */
function subProgramsText(
  subPrograms: SerializedSubProgram[],
  platforms: number[],
  programs: (SubProgram | undefined)[][],
): string {
  let out = "";
  for (const group of groupBy(subPrograms, (s) => s.m_BlobIndex)) {
    for (const variants of groupBy(group, (s) => s.m_GpuProgramType)) {
      const type = variants[0]!.m_GpuProgramType;
      const i = platforms.findIndex((platform) => usable(platform, type));
      if (i < 0) continue;
      const isTier = variants.length > 1;
      for (const variant of variants) {
        out += `SubProgram "${platformName(platforms[i]!)} `;
        if (isTier) out += `hw_tier${tier(variant.m_ShaderHardwareTier)} `;
        out += '" {\n';
        const program = programs[i]?.[variant.m_BlobIndex];
        if (!program) {
          throw new CorruptError(
            `Shader: blob index ${variant.m_BlobIndex} names no program of platform ` +
              `${platforms[i]}`,
          );
        }
        out += subProgramText(program);
        out += "\n}\n";
      }
    }
  }
  return out;
}

/** LINQ's `GroupBy`: groups in the order their keys first appear. */
function groupBy<T>(items: T[], key: (item: T) => number): T[][] {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

/** An `sbyte` formatted `00`. */
function tier(value: number): string {
  const digits = String(Math.abs(value)).padStart(2, "0");
  return value < 0 ? `-${digits}` : digits;
}

/**
 * `CheckGpuProgramUsable`: whether a platform runs a program type.
 *
 * @throws {UnsupportedError} for a platform AssetStudio throws on
 */
function usable(platform: number, type: number): boolean {
  const name = programTypeName(type);
  switch (platform) {
    case Platform.GL:
      return name === "GLLegacy";
    case Platform.D3D9:
      return name.startsWith("DX9");
    case Platform.Xbox360:
    case Platform.PS3:
    case Platform.PSP2:
    case Platform.PS4:
    case Platform.XboxOne:
    case Platform.N3DS:
    case Platform.WiiU:
    case Platform.Switch:
    case Platform.XboxOneD3D12:
    case Platform.GameCoreXboxOne:
    case Platform.GameCoreScarlett:
    case Platform.PS5:
      return name.startsWith("Console");
    case Platform.PS5NGGC:
      return name === "PS5NGGC";
    case Platform.D3D11:
      return name.startsWith("DX11");
    case Platform.GLES20:
      return name === "GLES";
    case Platform.D3D11_9x:
      return name.startsWith("DX10Level9");
    case Platform.GLES3Plus:
      return name === "GLES31AEP" || name === "GLES31" || name === "GLES3";
    case Platform.Metal:
      return name === "MetalVS" || name === "MetalFS";
    case Platform.OpenGLCore:
      return name.startsWith("GLCore");
    case Platform.Vulkan:
      return name === "SPIRV";
  }
  // NaCl, Flash, PSM and values AssetStudio has no name for: NotSupportedException.
  const known = Object.entries(Platform).find(([, v]) => v === platform)?.[0];
  throw new UnsupportedError(
    "shader platform",
    known ?? platform,
    "AssetStudio's ShaderConverter does not know its programs",
  );
}

/** `GetPlatformString`. */
function platformName(platform: number): string {
  const names: Record<number, string> = {
    [Platform.GL]: "openGL",
    [Platform.D3D9]: "d3d9",
    [Platform.Xbox360]: "xbox360",
    [Platform.PS3]: "ps3",
    [Platform.D3D11]: "d3d11",
    [Platform.GLES20]: "gles",
    [Platform.NaCl]: "glesdesktop",
    [Platform.Flash]: "flash",
    [Platform.D3D11_9x]: "d3d11_9x",
    [Platform.GLES3Plus]: "gles3",
    [Platform.PSP2]: "psp2",
    [Platform.PS4]: "ps4",
    [Platform.XboxOne]: "xboxone",
    [Platform.PSM]: "psm",
    [Platform.Metal]: "metal",
    [Platform.OpenGLCore]: "glcore",
    [Platform.N3DS]: "n3ds",
    [Platform.WiiU]: "wiiu",
    [Platform.Vulkan]: "vulkan",
    [Platform.Switch]: "switch",
    [Platform.XboxOneD3D12]: "xboxone_d3d12",
    [Platform.GameCoreXboxOne]: "xboxone",
    [Platform.GameCoreScarlett]: "xbox_scarlett",
    [Platform.PS5]: "ps5",
    [Platform.PS5NGGC]: "ps5_nggc",
  };
  return names[platform] ?? "unknown";
}

/** `ConvertSerializedShaderState`: what differs from ShaderLab's defaults. */
function stateText(state: SerializedShaderState): string {
  let out = "";
  if (state.m_Name) out += `  Name "${state.m_Name}"\n`;
  if (state.m_LOD !== 0) out += `  LOD ${state.m_LOD}\n`;
  out += tagsText(state.m_Tags, 2);
  out += blendText(
    [
      state.rtBlend0,
      state.rtBlend1,
      state.rtBlend2,
      state.rtBlend3,
      state.rtBlend4,
      state.rtBlend5,
      state.rtBlend6,
      state.rtBlend7,
    ],
    state.rtSeparateBlend,
  );
  if (state.alphaToMask.val > 0) out += "  AlphaToMask On\n";
  if (state.zClip.val !== 1) out += "  ZClip Off\n";
  if (state.zTest.val !== 4) {
    // CompareFunction; 4 (LEqual) is the default, unknown values print nothing.
    const names: Record<number, string> = {
      0: "Off",
      1: "Never",
      2: "Less",
      3: "Equal",
      5: "Greater",
      6: "NotEqual",
      7: "GEqual",
      8: "Always",
    };
    out += `  ZTest ${names[state.zTest.val] ?? ""}\n`;
  }
  if (state.zWrite.val !== 1) out += "  ZWrite Off\n";
  if (state.culling.val !== 2) {
    const names: Record<number, string> = { 0: "Off", 1: "Front" };
    out += `  Cull ${names[state.culling.val] ?? ""}\n`;
  }
  if (state.offsetFactor.val !== 0 || state.offsetUnits.val !== 0) {
    const factor = formatSingle(state.offsetFactor.val);
    out += `  Offset ${factor}, ${formatSingle(state.offsetUnits.val)}\n`;
  }
  const ops: [SerializedStencilOp, string][] = [
    [state.stencilOp, ""],
    [state.stencilOpFront, "Front"],
    [state.stencilOpBack, "Back"],
  ];
  const stencilSet = (op: SerializedStencilOp): boolean =>
    op.pass.val !== 0 || op.fail.val !== 0 || op.zFail.val !== 0 || op.comp.val !== 8;
  if (
    state.stencilRef.val !== 0 ||
    state.stencilReadMask.val !== 255 ||
    state.stencilWriteMask.val !== 255 ||
    ops.some(([op]) => stencilSet(op))
  ) {
    out += "  Stencil {\n";
    if (state.stencilRef.val !== 0) out += `   Ref ${formatSingle(state.stencilRef.val)}\n`;
    if (state.stencilReadMask.val !== 255) {
      out += `   ReadMask ${formatSingle(state.stencilReadMask.val)}\n`;
    }
    if (state.stencilWriteMask.val !== 255) {
      out += `   WriteMask ${formatSingle(state.stencilWriteMask.val)}\n`;
    }
    for (const [op, suffix] of ops) {
      if (!stencilSet(op)) continue;
      out += `   Comp${suffix} ${stencilComp(op.comp)}\n`;
      out += `   Pass${suffix} ${stencilOp(op.pass)}\n`;
      out += `   Fail${suffix} ${stencilOp(op.fail)}\n`;
      out += `   ZFail${suffix} ${stencilOp(op.zFail)}\n`;
    }
    out += "  }\n";
  }
  const color = state.fogColor;
  const colorSet = color.x.val !== 0 || color.y.val !== 0 || color.z.val !== 0 || color.w.val !== 0;
  if (
    state.fogMode !== -1 ||
    colorSet ||
    state.fogDensity.val !== 0 ||
    state.fogStart.val !== 0 ||
    state.fogEnd.val !== 0
  ) {
    out += "  Fog {\n";
    if (state.fogMode !== -1) {
      const modes: Record<number, string> = { 0: "Off", 1: "Linear", 2: "Exp", 3: "Exp2" };
      out += `   Mode ${modes[state.fogMode] ?? ""}\n`;
    }
    // These three upstream formats with the invariant culture.
    const f = (v: SerializedShaderFloatValue): string => formatSingleInvariant(v.val);
    if (colorSet) out += `   Color (${f(color.x)},${f(color.y)},${f(color.z)},${f(color.w)})\n`;
    if (state.fogDensity.val !== 0) out += `   Density ${f(state.fogDensity)}\n`;
    if (state.fogStart.val !== 0 || state.fogEnd.val !== 0) {
      out += `   Range ${f(state.fogStart)}, ${f(state.fogEnd)}\n`;
    }
    out += "  }\n";
  }
  if (state.lighting) out += "  Lighting On\n";
  return out + `  GpuProgramID ${state.gpuProgramID}\n`;
}

/** `ConvertStencilOp`: `Keep` for an unknown value. */
function stencilOp(op: SerializedShaderFloatValue): string {
  const names = ["Keep", "Zero", "Replace", "IncrSat", "DecrSat", "Invert", "IncrWrap", "DecrWrap"];
  return (Number.isInteger(op.val) && names[op.val]) || "Keep";
}

/** `ConvertStencilComp`: `Always` for an unknown value. */
function stencilComp(comp: SerializedShaderFloatValue): string {
  const names = ["Disabled", "Never", "Less", "Equal", "LEqual", "Greater", "NotEqual", "GEqual"];
  return (Number.isInteger(comp.val) && names[comp.val]) || "Always";
}

/** `ConvertSerializedShaderRTBlendState`. */
function blendText(blends: SerializedShaderRTBlendState[], separate: boolean): string {
  let out = "";
  blends.forEach((blend, i) => {
    const target = i !== 0 || separate ? `${i} ` : "";
    if (
      blend.srcBlend.val !== 1 ||
      blend.destBlend.val !== 0 ||
      blend.srcBlendAlpha.val !== 1 ||
      blend.destBlendAlpha.val !== 0
    ) {
      out += `  Blend ${target}${blendFactor(blend.srcBlend)} ${blendFactor(blend.destBlend)}`;
      if (blend.srcBlendAlpha.val !== 1 || blend.destBlendAlpha.val !== 0) {
        out += `, ${blendFactor(blend.srcBlendAlpha)} ${blendFactor(blend.destBlendAlpha)}`;
      }
      out += "\n";
    }
    if (blend.blendOp.val !== 0 || blend.blendOpAlpha.val !== 0) {
      out += `  BlendOp ${target}${blendOp(blend.blendOp)}`;
      if (blend.blendOpAlpha.val !== 0) out += `, ${blendOp(blend.blendOpAlpha)}`;
      out += "\n";
    }
    const mask = toInt32(blend.colMask.val);
    if (mask !== 0xf) {
      let channels = "0";
      if (mask !== 0) {
        channels = (mask & 0x2 ? "R" : "") + (mask & 0x4 ? "G" : "") + (mask & 0x8 ? "B" : "");
        channels += mask & 0x1 ? "A" : "";
      }
      out += `  ColorMask ${channels} ${i}\n`;
    }
  });
  return out;
}

/**
 * C#'s `(int)` of a float on x64: truncated toward zero, and `int.MinValue`
 * for NaN or a value out of range.
 */
function toInt32(value: number): number {
  const t = Math.trunc(value);
  return Number.isNaN(t) || t < -2147483648 || t > 2147483647 ? -2147483648 : t;
}

/** `ConvertBlendOp`: `Add` for an unknown value. */
function blendOp(op: SerializedShaderFloatValue): string {
  const names = [
    "Add",
    "Sub",
    "RevSub",
    "Min",
    "Max",
    "LogicalClear",
    "LogicalSet",
    "LogicalCopy",
    "LogicalCopyInverted",
    "LogicalNoop",
    "LogicalInvert",
    "LogicalAnd",
    "LogicalNand",
    "LogicalOr",
    "LogicalNor",
    "LogicalXor",
    "LogicalEquiv",
    "LogicalAndReverse",
    "LogicalAndInverted",
    "LogicalOrReverse",
    "LogicalOrInverted",
  ];
  return (Number.isInteger(op.val) && names[op.val]) || "Add";
}

/** `ConvertBlendFactor`: `One` for an unknown value. */
function blendFactor(factor: SerializedShaderFloatValue): string {
  const names = [
    "Zero",
    "One",
    "DstColor",
    "SrcColor",
    "OneMinusDstColor",
    "SrcAlpha",
    "OneMinusSrcColor",
    "DstAlpha",
    "OneMinusDstAlpha",
    "SrcAlphaSaturate",
    "OneMinusSrcAlpha",
  ];
  return (Number.isInteger(factor.val) && names[factor.val]) || "One";
}

/** `ConvertSerializedTagMap`. */
function tagsText(tags: SerializedTagMap, indent: number): string {
  if (tags.tags.length === 0) return "";
  return `${" ".repeat(indent)}Tags { ${tags.tags.map(([k, v]) => `"${k}" = "${v}" `).join("")}}\n`;
}

/** `SerializedPropertyFlag`, by bit. */
const PROPERTY_FLAGS = [
  "HideInInspector",
  "PerRendererData",
  "NoScaleOffset",
  "Normal",
  "HDR",
  "Gamma",
  "NonModifiableTextureData",
  "MainTexture",
  "MainColor",
];

/** `ConvertSerializedProperties`. */
function propertiesText(props: SerializedProperty[]): string {
  return `Properties {\n${props.map(propertyText).join("")}}\n`;
}

/**
 * `ConvertSerializedProperty`.
 *
 * @throws {UnsupportedError} for a type other than Color, Vector, Float,
 *   Range or Texture, which AssetStudio fails on
 */
function propertyText(prop: SerializedProperty): string {
  let out = prop.m_Attributes.map((a) => `[${a}] `).join("");
  PROPERTY_FLAGS.forEach((flag, bit) => {
    if (prop.m_Flags & (1 << bit)) out += `[${flag}] `;
  });
  const v = [
    prop["m_DefValue[0]"],
    prop["m_DefValue[1]"],
    prop["m_DefValue[2]"],
    prop["m_DefValue[3]"],
  ];
  out += `${prop.m_Name} ("${prop.m_Description}", `;
  switch (prop.m_Type) {
    case 0:
      out += `Color) = (${v.map(formatSingle).join(",")})`;
      break;
    case 1:
      out += `Vector) = (${v.map(formatSingle).join(",")})`;
      break;
    case 2:
      out += `Float) = ${formatSingle(v[0]!)}`;
      break;
    case 3:
      out += `Range(${formatSingle(v[1]!)}, ${formatSingle(v[2]!)})) = ${formatSingle(v[0]!)}`;
      break;
    case 4: {
      // TextureDimension; None (0) and unknown values print nothing.
      const dims = ["", "any", "2D", "3D", "Cube", "2DArray", "CubeArray"];
      const dim = dims[prop.m_DefTexture.m_TexDim] ?? "";
      out += `${dim}) = "${prop.m_DefTexture.m_DefaultName}" { }`;
      break;
    }
    default:
      // Upstream's second switch has no case for it: ArgumentOutOfRangeException.
      throw new UnsupportedError(
        "shader property type",
        prop.m_Type === 5 ? "Int" : prop.m_Type,
        `property ${prop.m_Name}: AssetStudio's ShaderConverter fails on it`,
      );
  }
  return out + "\n";
}
