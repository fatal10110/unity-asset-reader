// Ported from AssetStudio.Utility/Smolv/SmolvDecoder.cs, OpData.cs and SpvOp.cs (MIT, © Perfare / RazTools / Razviar)
//
// SMOL-V, Aras Pranckevičius's compact encoding of SPIR-V (MIT / public
// domain), decoded as AssetStudio's C# port of it decodes: Unity stores each
// Vulkan program stage as SMOL-V. Behaviour on bad input is upstream's too:
// a decode that ends at the wrong size reports failure, a varint cut off by
// the end of the stream reads as what it has.

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
