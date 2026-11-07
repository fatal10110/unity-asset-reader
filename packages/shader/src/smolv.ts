// Ported from AssetStudio.Utility/Smolv/SmolvDecoder.cs, OpData.cs and SpvOp.cs (MIT, © Perfare / RazTools / Razviar)
//
// SMOL-V, Aras Pranckevičius's compact encoding of SPIR-V (MIT / public
// domain), decoded as AssetStudio's C# port of it decodes: Unity stores each
// Vulkan program stage as SMOL-V. Behaviour on bad input is upstream's too:
// a decode that ends at the wrong size reports failure, a varint cut off by
// the end of the stream reads as what it has.
//
// `decodeSmolvV1` is ported from aras-p/smol-v 6303e979, source/smolv.cpp
// `smolv::Decode` (MIT, © 2016-2018 Aras Pranckevicius): the encoding
// version 1 that Unity 2020.3 and later write, which AssetStudio's port
// predates (plan section 5, revision 2026-11-07c, #260).

import { DisassemblyError, StreamReader } from "./net.js";

/** `0x07230203`, the SPIR-V magic number written in place of SMOL-V's. */
const SPIRV_MAGIC = 0x07230203;

/** Six `uint` header words: magic, version, generator, bound, schema, decoded size. */
const HEADER_SIZE = 24;

/** .NET's message when a fixed-size `MemoryStream` is written past its end. */
const NOT_EXPANDABLE = "Memory stream is not expandable.";

/**
 * Per SPIR-V opcode (SMOL-V's `SpvOp`, 0 to 330): has a result ID, has a type
 * ID, how many words after them are deltas from the result (negative: zigzag
 * encoded), whether the rest are varints.
 */
const OP_DATA: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
  [0, 0, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0], [1, 1, 0, 1], [1, 1, 2, 1],
  [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [1, 1, 0, 0], [1, 0, 0, 1], [1, 0, 0, 1],
  [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1],
  [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1],
  [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [0, 0, 0, 1], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 9, 0], [1, 1, 0, 1], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 9, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 1], [1, 1, 0, 0],
  [0, 0, 0, 0], [1, 1, 9, 0], [1, 1, 0, 0], [1, 1, 0, 1], [1, 1, 0, 0], [1, 1, 1, 1], [0, 0, 2, 1],
  [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 1], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [0, 0, 0, 1], [0, 0, 0, 1], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0],
  [1, 1, 1, 1], [1, 1, 2, 1], [1, 1, 2, 1], [1, 1, 9, 0], [1, 1, 1, 1], [1, 1, 2, 1], [1, 1, 1, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 2, 1], [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1],
  [1, 1, 2, 1], [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1], [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1],
  [1, 1, 2, 1], [0, 0, 3, 1], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 2, 0], [1, 1, 1, 0],
  [1, 1, 2, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 0, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0],
  [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0],
  [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 1], [1, 1, 1, 0], [1, 1, 0, 0],
  [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 0, 0],
  [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 1, 0], [1, 1, 3, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 2, 0], [1, 1, 2, 0],
  [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 2, 0], [1, 1, 1, 0], [1, 1, 4, 0], [1, 1, 3, 0],
  [1, 1, 3, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [0, 0, -3, 0], [0, 0, -2, 0], [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, -2, 1], [0, 0, -1, 1], [1, 0, 0, 0], [0, 0, -1, 0],
  [0, 0, -3, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
  [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 2, 1],
  [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1], [1, 1, 2, 1], [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1],
  [1, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1], [1, 1, 1, 0], [0, 0, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0], [1, 1, 0, 0],
  [1, 1, 0, 0], [1, 1, 0, 1], [0, 0, -2, 1], [1, 1, 0, 0],
];

/**
 * SMOL-V encoding version 1 also knows `ExecutionModeId` (331) to
 * `GroupNonUniformQuadSwap` (366), with smol-v's `kSpirvOpData` for them. Its
 * entries for 0 to 330 are `OP_DATA`'s, without the sign: version 1 zigzags
 * every op's result deltas.
 */
const OP_DATA_V1: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 1],
  [0, 0, 0, 1],
  ...Array.from({ length: 34 }, () => [1, 1, 1, 1] as const),
];

const Op = {
  Nop: 0,
  Undef: 1,
  SourceContinued: 2,
  Source: 3,
  SourceExtension: 4,
  String: 7,
  Line: 8,
  Extension: 10,
  ExtInstImport: 11,
  VectorShuffleCompact: 13,
  MemoryModel: 14,
  EntryPoint: 15,
  TypePointer: 32,
  Variable: 59,
  Load: 61,
  Store: 62,
  AccessChain: 65,
  Decorate: 71,
  MemberDecorate: 72,
  VectorShuffle: 79,
  FNegate: 127,
  FAdd: 129,
  FMul: 133,
  Label: 248,
  ModuleProcessed: 330,
  GroupNonUniformQuadSwap: 366,
} as const;

/** `OpData.SpirvOpData[op]`, or all zero for an opcode SMOL-V does not know. */
function opData(op: number): readonly [number, number, number, number] {
  return OP_DATA[op] ?? [0, 0, 0, 0];
}

/**
 * `SmolvDecoder.GetDecodedBufferSize(stream)`: the decoded size the header at
 * the reader's position gives, or 0 when the stream is too short for a
 * header. The magic and version are not checked.
 */
export function decodedBufferSize(input: StreamReader): number {
  if (input.position + HEADER_SIZE > input.length) return 0;
  const at = input.position + HEADER_SIZE - 4;
  const b = input.bytes;
  return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);
}

/** A `BinaryWriter` over a `MemoryStream` of fixed size. */
class FixedWriter {
  position = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** `Write(uint)` or `Write(int)`: four little-endian bytes. */
  write(value: number): void {
    if (this.position + 4 > this.bytes.length) throw new DisassemblyError(NOT_EXPANDABLE);
    this.view.setUint32(this.position, value >>> 0, true);
    this.position += 4;
  }
}

/**
 * `SmolvDecoder.Decode(stream, inputSize, output)`: decode the SMOL-V module
 * at the reader's position, `inputSize` bytes of it, into `output`.
 *
 * @returns false where upstream returns false: the stream is shorter than a
 *   header, an unencoded word runs past its end, or the module does not
 *   decode to exactly `decodedSize` bytes
 * @throws {DisassemblyError} where upstream's reads or writes throw: a header
 *   or swizzle byte past the end of the stream, a decoded word past the end
 *   of `output`
 */
export function decodeSmolv(input: StreamReader, inputSize: number, output: Uint8Array): boolean {
  if (input.length < HEADER_SIZE) return false;
  const out = new FixedWriter(output);
  const inputEnd = input.position + inputSize;

  out.write(SPIRV_MAGIC);
  input.position += 4;
  out.write(input.readUInt32()); // version
  out.write(input.readUInt32()); // generator
  out.write(input.readInt32()); // bound
  out.write(input.readUInt32()); // schema
  const decodedSize = input.readInt32();

  let prevResult = 0;
  let prevDecorate = 0;
  while (input.position < inputEnd) {
    const [length, decoded] = readLengthOp(input);
    let op = decoded;
    const wasSwizzle = op === Op.VectorShuffleCompact;
    if (wasSwizzle) op = Op.VectorShuffle;
    out.write(((length << 16) | op) >>> 0);
    const [hasResult, hasType, deltaFromResult, varRest] = opData(op);

    let ioffs = 1;
    if (hasType) {
      out.write(readVarint(input));
      ioffs++;
    }
    if (hasResult) {
      const zds = (prevResult + zigDecode(readVarint(input))) | 0;
      out.write(zds);
      prevResult = zds;
      ioffs++;
    }
    // Decorate: IDs relative to the previous decorate.
    if (op === Op.Decorate || op === Op.MemberDecorate) {
      const zds = (prevDecorate + (readVarint(input) | 0)) | 0;
      out.write(zds);
      prevDecorate = zds;
      ioffs++;
    }
    // This many IDs relative to the result ID.
    const inverted = deltaFromResult < 0;
    const relativeCount = Math.abs(deltaFromResult);
    for (let i = 0; i < relativeCount && ioffs < length; ++i, ++ioffs) {
      const value = readVarint(input);
      const zd = inverted ? zigDecode(value) : value | 0;
      out.write((prevResult - zd) | 0);
    }

    if (wasSwizzle && length <= 9) {
      const swizzle = input.readUInt8();
      if (length > 5) out.write(swizzle >> 6);
      if (length > 6) out.write((swizzle >> 4) & 3);
      if (length > 7) out.write((swizzle >> 2) & 3);
      if (length > 8) out.write(swizzle & 3);
    } else if (varRest) {
      for (; ioffs < length; ++ioffs) out.write(readVarint(input));
    } else {
      for (; ioffs < length; ++ioffs) {
        if (input.position + 4 > input.length) return false;
        out.write(input.readUInt32());
      }
    }
  }
  // Something went wrong if the module did not decode to its exact size.
  return out.position === decodedSize;
}

/**
 * `ReadVarint`: seven bits a byte, low first, until a byte without the high
 * bit or the end of the stream (not the module: upstream reads on), whatever
 * has been read so far being the value.
 */
function readVarint(input: StreamReader): number {
  let value = 0;
  let shift = 0;
  while (input.position < input.length) {
    const b = input.readUInt8();
    // C#'s `<<` on a uint takes the shift count mod 32.
    value = (value | ((b & 127) << (shift & 31))) >>> 0;
    shift += 7;
    if ((b & 128) === 0) break;
  }
  return value;
}

/** `ReadLengthOp`: an instruction's word count and opcode. */
function readLengthOp(input: StreamReader): [number, number] {
  const value = readVarint(input);
  const length = (((value >>> 20) << 4) | ((value >>> 4) & 0xf)) >>> 0;
  const op = remapOp(((value >>> 4) & 0xfff0) | (value & 0xf));
  return [decodeLength(op, length), op];
}

/**
 * `RemapOp`: SMOL-V swaps the most common opcodes with rare ones below 16,
 * for shorter varints. Its own inverse.
 */
function remapOp(op: number): number {
  const pairs: [number, number][] = [
    [Op.Decorate, Op.Nop],
    [Op.Load, Op.Undef],
    [Op.Store, Op.SourceContinued],
    [Op.AccessChain, Op.Source],
    [Op.VectorShuffle, Op.SourceExtension],
    [Op.MemberDecorate, Op.String],
    [Op.Label, Op.Line],
    [Op.Variable, 9],
    [Op.FMul, Op.Extension],
    [Op.FAdd, Op.ExtInstImport],
    [Op.TypePointer, Op.MemoryModel],
    [Op.FNegate, Op.EntryPoint],
  ];
  for (const [a, b] of pairs) {
    if (op === a) return b;
    if (op === b) return a;
  }
  return op;
}

/** `DecodeLen`: the word count, with the bias SMOL-V takes off common opcodes. */
function decodeLength(op: number, length: number): number {
  let len = length + 1;
  switch (op) {
    case Op.VectorShuffle:
    case Op.VectorShuffleCompact:
      len += 4;
      break;
    case Op.Decorate:
      len += 2;
      break;
    case Op.Load:
    case Op.AccessChain:
      len += 3;
      break;
  }
  return len >>> 0;
}

/** `ZigDecode`: zigzag to signed. */
function zigDecode(u: number): number {
  return u & 1 ? ~(u >>> 1) | 0 : (u >>> 1) | 0;
}

/** SMOL-V's header magic, "SMOL" (`kSmolHeaderMagic`). */
const SMOL_MAGIC = 0x534d4f4c;

/** The newest SMOL-V encoding version smol-v decodes (`kSmolCurrEncodingVersion`). */
const SMOL_ENCODING_VERSION = 1;

/** smol-v's `MemberDecorate` decoration `Offset`, whose value is a delta. */
const DECORATION_OFFSET = 35;

/**
 * smol-v `smolv_GetKnownOpsCount`: the opcodes an encoding version has op
 * data for; any other opcode has no type, result or deltas, and raw words.
 */
function knownOpsCount(version: number): number {
  return version === 0 ? Op.ModuleProcessed + 1 : Op.GroupNonUniformQuadSwap + 1;
}

/** `kSpirvOpData[op]` for an opcode the encoding version knows, else all zero. */
function opDataV1(op: number, opsCount: number): readonly [number, number, number, number] {
  if (op >= opsCount) return [0, 0, 0, 0];
  const [hasResult, hasType, delta, varRest] = OP_DATA[op] ?? OP_DATA_V1[op - OP_DATA.length]!;
  return [hasResult, hasType, Math.abs(delta), varRest];
}

/** smol-v `smolv_DecorationExtraOps`: a member decoration's operand count, or -1 if stored. */
function decorationExtraOps(decoration: number): number {
  if (decoration === 0 || (decoration >= 2 && decoration <= 5)) return 0; // RelaxedPrecision, Block..ColMajor
  if (decoration >= 29 && decoration <= 37) return 1; // Stream..XfbStride
  return -1;
}

/**
 * smol-v `GetDecodedBufferSize`: the decoded size the header gives, or 0
 * when the header is not SMOL-V's (`smolv_CheckSmolHeader`): magic "SMOL",
 * SPIR-V version 1.0 to 1.6 in the low three bytes of the version word, an
 * encoding version in its high byte smol-v knows, and the size word present.
 */
function smolvDecodedSize(bytes: Uint8Array): number {
  if (bytes.length < HEADER_SIZE) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SMOL_MAGIC) return 0;
  const version = view.getUint32(4, true);
  const spirv = version & 0x00ffffff;
  if (spirv < 0x00010000 || spirv > 0x00010600) return 0;
  if (version >>> 24 > SMOL_ENCODING_VERSION) return 0;
  return view.getUint32(20, true);
}

/**
 * smol-v `smolv::Decode(smolv, size, out, outSize, kDecodeFlagNone)`: decode
 * one SMOL-V stage of encoding version 1 (Unity 2020.3 and later), or of
 * version 0 as smol-v itself writes it, to SPIR-V. Unlike version 0 as Unity
 * 2017 to 2020 write it (`decodeSmolv`): Decorate IDs and every op's result
 * deltas are zigzag encoded, MemberDecorate runs are packed, ops 331 to 366
 * have op data, and the SPIR-V version word loses the encoding version byte.
 *
 * Reads stop at the end of `smolv`; nothing past the stage is read.
 *
 * @param smolv the stage's bytes
 * @returns the SPIR-V module, or undefined where smol-v returns false: the
 *   header is not SMOL-V's, an instruction runs past the end of the stage or
 *   of the decoded size, or the stage does not decode to exactly that size
 */
export function decodeSmolvV1(smolv: Uint8Array): Uint8Array | undefined {
  const size = smolvDecodedSize(smolv);
  if (size === 0) return undefined;
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  const input = new DataView(smolv.buffer, smolv.byteOffset, smolv.byteLength);
  const end = smolv.length;
  let at = 0;
  let written = 0;
  /** `smolv_Write4Safe`: false once the decoded size is full. */
  const write = (value: number): boolean => {
    if (written + 4 > size) return false;
    view.setUint32(written, value >>> 0, true);
    written += 4;
    return true;
  };
  /** `smolv_ReadVarint`, bounded by the stage's end. */
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    while (at < end) {
      const b = smolv[at++]!;
      value = (value | ((b & 127) << (shift & 31))) >>> 0;
      shift += 7;
      if ((b & 128) === 0) break;
    }
    return value;
  };
  const zig = (u: number): number => (u & 1 ? ~(u >>> 1) : u >>> 1) >>> 0;

  // Header: the size check above guarantees its 24 bytes; the decoded size
  // may still be too small for the five words.
  const versionWord = input.getUint32(4, true);
  const version = versionWord >>> 24;
  const header = [
    SPIRV_MAGIC,
    versionWord & 0x00ffffff,
    input.getUint32(8, true), // generator
    input.getUint32(12, true), // bound
    input.getUint32(16, true), // schema
  ];
  for (const word of header) if (!write(word)) return undefined;
  at = HEADER_SIZE;
  const opsCount = knownOpsCount(version);

  let prevResult = 0;
  let prevDecorate = 0;
  while (at < end) {
    const lengthOp = varint();
    let op = remapOp(((lengthOp >>> 4) & 0xfff0) | (lengthOp & 0xf));
    const length = decodeLength(op, (((lengthOp >>> 20) << 4) | ((lengthOp >>> 4) & 0xf)) >>> 0);
    const wasSwizzle = op === Op.VectorShuffleCompact;
    if (wasSwizzle) op = Op.VectorShuffle;
    if (!write((length << 16) | op)) return undefined;
    const [hasResult, hasType, relativeCount, varRest] = opDataV1(op, opsCount);

    let ioffs = 1;
    if (hasType) {
      if (!write(varint())) return undefined;
      ioffs++;
    }
    if (hasResult) {
      prevResult = (prevResult + zig(varint())) >>> 0;
      if (!write(prevResult)) return undefined;
      ioffs++;
    }
    // Decorate: IDs relative to the previous decorate, zigzag encoded.
    if (op === Op.Decorate || op === Op.MemberDecorate) {
      prevDecorate = (prevDecorate + zig(varint())) >>> 0;
      if (!write(prevDecorate)) return undefined;
      ioffs++;
    }

    // A run of member decorations of one struct: a count byte, then for each
    // the member index (delta), the decoration, its length when it is not a
    // known one, and its operands (an Offset's as a delta).
    if (op === Op.MemberDecorate) {
      if (at >= end) return undefined;
      const count = smolv[at++]!;
      let prevIndex = 0;
      let prevOffset = 0;
      for (let m = 0; m < count; ++m) {
        const memberIndex = (varint() + prevIndex) >>> 0;
        prevIndex = memberIndex;
        const decoration = varint();
        const extra = decorationExtraOps(decoration);
        const memberLength = extra === -1 ? (varint() + 4) >>> 0 : 4 + extra;
        // The first member's op and target were written above.
        if (m !== 0) {
          if (!write((memberLength << 16) | op) || !write(prevDecorate)) return undefined;
        }
        if (!write(memberIndex) || !write(decoration)) return undefined;
        if (decoration === DECORATION_OFFSET) {
          if (memberLength !== 5) return undefined;
          prevOffset = (varint() + prevOffset) >>> 0;
          if (!write(prevOffset)) return undefined;
        } else {
          for (let i = 4; i < memberLength; ++i) if (!write(varint())) return undefined;
        }
      }
      continue;
    }

    // This many IDs relative to the result ID, all zigzag encoded.
    for (let i = 0; i < relativeCount && ioffs < length; ++i, ++ioffs) {
      if (!write(prevResult - zig(varint()))) return undefined;
    }

    if (wasSwizzle && length <= 9) {
      if (at >= end) return undefined;
      const swizzle = smolv[at++]!;
      if (length > 5 && !write((swizzle >> 6) & 3)) return undefined;
      if (length > 6 && !write((swizzle >> 4) & 3)) return undefined;
      if (length > 7 && !write((swizzle >> 2) & 3)) return undefined;
      if (length > 8 && !write(swizzle & 3)) return undefined;
    } else if (varRest) {
      for (; ioffs < length; ++ioffs) if (!write(varint())) return undefined;
    } else {
      for (; ioffs < length; ++ioffs) {
        if (at + 4 > end) return undefined;
        if (!write(input.getUint32(at, true))) return undefined;
        at += 4;
      }
    }
  }
  // Something went wrong if the stage did not decode to its exact size.
  return written === size ? output : undefined;
}
