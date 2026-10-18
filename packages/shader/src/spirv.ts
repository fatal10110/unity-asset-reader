// Ported from AssetStudio.Utility/CSspv/Module.cs, Reader.cs, ParsedInstruction.cs, OperandType.cs, Instruction.cs, Types.cs, Disassembler.cs and SpirV.Meta.cs (BSD-2-Clause, © 2017 Matthäus G. Chajdas)
//
// CSspv's SPIR-V disassembler, as AssetStudio vendors it, quirks included,
// because the text must be AssetStudio's to the byte:
// - the operands an enum value takes (`Location 0`, `BuiltIn Position`,
//   `Aligned 4`) are read from the instruction's second word on, not from
//   after the enum, so they print that word instead;
// - a 32-bit float constant is read from the instruction's first word (its
//   opcode and length), so every one prints the same tiny number;
// - a 64-bit constant has one word more than its operands: the instruction
//   cannot be parsed.
// The C# objects become plain values; what C# prints through `ToString()`
// (enum names, anonymous types, `List<T>`) is formatted as .NET 8 does.
// Every exception the C# throws on a bad module is thrown here as a
// DisassemblyError with the message .NET 8 gives it, as AssetStudio writes
// that message into the text.

import { formatSingle } from "./float.js";
import { ENUMS, INSTRUCTIONS, type GrammarEnum, type OperandCode } from "./grammar.js";
import { decodeUtf8, DisassemblyError, StreamReader } from "./net.js";

/** An index past the end of a `List<T>` or of an array read as `IReadOnlyList<T>`. */
const INDEX_OUT_OF_RANGE =
  "Index was out of range. Must be non-negative and less than the size of the collection. " +
  "(Parameter 'index')";

/** A member called on `null`. */
const NULL_REFERENCE = "Object reference not set to an instance of an object.";

/** A `Dictionary` indexer's `KeyNotFoundException`. */
const keyNotFound = (key: number): DisassemblyError =>
  new DisassemblyError(`The given key '${key}' was not present in the dictionary.`);

const MAGIC = 0x07230203;

/** `Meta.Tools`: generator tool ID to vendor and, for some, a name. */
const TOOLS: ReadonlyMap<number, readonly [string, string?]> = new Map([
  [0, ["Khronos"]],
  [1, ["LunarG"]],
  [2, ["Valve"]],
  [3, ["Codeplay"]],
  [4, ["NVIDIA"]],
  [5, ["ARM"]],
  [6, ["Khronos", "LLVM/SPIR-V Translator"]],
  [7, ["Khronos", "SPIR-V Tools Assembler"]],
  [8, ["Khronos", "Glslang Reference Front End"]],
  [9, ["Qualcomm"]],
  [10, ["AMD"]],
  [11, ["Intel"]],
  [12, ["Imagination"]],
  [13, ["Google", "Shaderc over Glslang"]],
  [14, ["Google", "spiregg"]],
  [15, ["Google", "rspirv"]],
  [16, ["X-LEGEND", "Mesa-IR/SPIR-V Translator"]],
  [17, ["Khronos", "SPIR-V Tools Linker"]],
] as [number, [string, string?]][]);

/** `Module.debugInstructions_`: read after everything else. */
const DEBUG_INSTRUCTIONS = new Set([
  "OpSourceContinued",
  "OpSource",
  "OpSourceExtension",
  "OpName",
  "OpMemberName",
  "OpString",
  "OpLine",
  "OpNoLine",
  "OpModuleProcessed",
]);

// --- types (Types.cs) -------------------------------------------------------

/** A SPIR-V type, as CSspv models it. */
type SpvType =
  | { kind: "void" | "bool" | "sampler" | "opaque" | "function" | "runtimeArray" }
  | { kind: "int"; width: number; signed: boolean }
  | { kind: "float"; width: number }
  | { kind: "vector"; component: SpvType | null; count: number }
  | { kind: "matrix"; column: SpvType | null; count: number }
  | { kind: "image"; dim: number; arrayed: boolean; multisampled: boolean; access: number }
  | { kind: "sampledImage"; image: SpvType | null }
  | { kind: "array"; element: SpvType | null; count: number }
  | { kind: "struct"; members: (SpvType | null)[]; names: string[] }
  | { kind: "pointer"; storage: number; type: SpvType | null };

/** The C# class of each kind, for the message of a failed cast. */
const CLASS_NAMES: Record<SpvType["kind"], string> = {
  void: "VoidType",
  bool: "BoolType",
  sampler: "SamplerType",
  opaque: "OpaqueType",
  function: "FunctionType",
  runtimeArray: "RuntimeArrayType",
  int: "IntegerType",
  float: "FloatingPointType",
  vector: "VectorType",
  matrix: "MatrixType",
  image: "ImageType",
  sampledImage: "SampledImageType",
  array: "ArrayType",
  struct: "StructType",
  pointer: "PointerType",
};

/**
 * A C# cast of a type to one of `kinds` (`null` casts to anything): an
 * `InvalidCastException` for any other.
 */
function cast(t: SpvType | null, to: string, ...kinds: SpvType["kind"][]): SpvType | null {
  if (t === null || kinds.includes(t.kind)) return t;
  throw new DisassemblyError(
    `Unable to cast object of type 'SpirV.${CLASS_NAMES[t.kind]}' to type 'SpirV.${to}'.`,
  );
}

/** `Type.ToString(StringBuilder)`; a `null` type fails as C# does. */
function typeText(t: SpvType | null): string {
  if (t === null) throw new DisassemblyError(NULL_REFERENCE);
  switch (t.kind) {
    case "void":
    case "bool":
    case "sampler":
      return t.kind;
    case "opaque":
    case "function":
    case "runtimeArray":
      return "";
    case "int":
      return `${t.signed ? "i" : "u"}${t.width}`;
    case "float":
      return `f${t.width}`;
    case "vector":
      return `${typeText(t.component)}_${t.count}`;
    case "matrix": {
      // StringBuilder.Append(object): nothing for null, else the column's
      // ToString(), an interpolation that writes a null component as nothing.
      const column = t.column?.kind === "vector" ? t.column : null;
      const text = column
        ? `${column.component ? typeText(column.component) : ""}_${column.count}`
        : "";
      return `${text}x${t.count}`;
    }
    case "image": {
      const access = ["read_only ", "write_only ", "read_write "][t.access] ?? "";
      const dim = ["1D", "2D", "3D", "Cube"][t.dim] ?? "";
      return `${access}Texture${dim}${t.multisampled ? "MS" : ""}${t.arrayed ? "Array" : ""}`;
    }
    case "sampledImage":
      return `${typeText(t.image)}Sampled`;
    case "array":
      return `${typeText(t.element)}[${t.count}]`;
    case "struct": {
      const members = t.members.map((m, i) => {
        const name = t.names[i]!;
        return typeText(m) + (name ? ` ${name}` : "") + ";";
      });
      return `struct {${members.join(" ")}}`;
    }
    case "pointer":
      return `${enumToString(ENUMS.StorageClass!, t.storage)} ${t.type ? typeText(t.type) : ""}*`;
  }
}

// --- operand values (ParsedInstruction.cs, OperandType.cs) -------------------

/** `ObjectReference`: an ID, and the instruction it resolves to. */
class Ref {
  target: Parsed | undefined;
  constructor(readonly id: number) {}
}

/** `BitEnumOperandValue<T>`: the set bits, each with its operands. */
class BitEnumValue {
  constructor(
    readonly grammar: GrammarEnum,
    readonly bits: [number, Value[]][],
  ) {}
}

/** `ValueEnumOperandValue<T>`: the value and its operands. */
class ValueEnumValue {
  constructor(
    readonly grammar: GrammarEnum,
    readonly key: number,
    readonly params: Value[],
  ) {}
}

/** `VaryingOperandValue`: every value of a `*` operand. */
class VaryingValue {
  constructor(readonly values: Value[]) {}
}

/** Anything C# writes through its `ToString()`, already formatted. */
class Text {
  constructor(readonly text: string) {}
}

/** A `System.Type`: what the base `OperandType.ReadValue` gives, its own type. */
class TypeName {
  constructor(readonly name: string) {}
}

/** A 32-bit float constant. */
class FloatConstant {
  constructor(readonly value: number) {}
}

/** A literal string is a `string`, an integer a `number`; `null` prints as nothing. */
type Value =
  | Ref
  | BitEnumValue
  | ValueEnumValue
  | VaryingValue
  | Text
  | TypeName
  | FloatConstant
  | string
  | number
  | null;

/** `ParsedInstruction`. */
interface Parsed {
  words: number[];
  /** The grammar's name and operand codes. */
  name: string;
  codes: readonly OperandCode[];
  operands: { value: Value; code: OperandCode }[];
  resultType: SpvType | null;
  /** From `OpName`. */
  debugName: string | null;
  /** A constant's value (`OpConstant`, `OpSpecConstant`). */
  value: Value;
}

/** `words[index]`, failing where C#'s indexer throws. */
function word(words: number[], index: number): number {
  const w = words[index];
  if (w === undefined) throw new DisassemblyError(INDEX_OUT_OF_RANGE);
  return w;
}

/** `Operands[i]`. */
function operand(p: Parsed, i: number): { value: Value; code: OperandCode } {
  const o = p.operands[i];
  if (!o) throw new DisassemblyError(INDEX_OUT_OF_RANGE);
  return o;
}

/** `OperandType.ReadValue`: the operand at `index`, and how many words it takes. */
function readValue(code: OperandCode, words: number[], index: number): [Value, number] {
  switch (code) {
    case "I":
    case "R":
      return [new Ref(word(words, index)), 1];
    case "T":
    case "L":
    case "X":
      return [word(words, index), 1];
    case "S":
      return [new Text(enumToString(ENUMS.Scope!, word(words, index))), 1];
    case "M":
      return [new Text(enumToString(ENUMS.MemorySemantics!, word(words, index))), 1];
    case "Str":
      return readString(words, index);
    case "C":
      return [new TypeName("LiteralContextDependentNumber"), 1];
    case "SC":
      // A List<ObjectReference>, which prints as its type's name.
      return [
        new Text("System.Collections.Generic.List`1[SpirV.ObjectReference]"),
        words.length - index,
      ];
  }
  // Anonymous types: `{ Name = value, ... }`, an ObjectReference as `%id`.
  if (code === "PII" || code === "PIL" || code === "PLI") {
    const first = word(words, index);
    const second = word(words, index + 1);
    if (code === "PII") return [pair("Variable", `%${first}`, "Parent", `%${second}`), 2];
    if (code === "PIL") return [pair("Type", `%${first}`, "Member", `${second}`), 2];
    return [pair("Selector", `${first}`, "Label", `%${second}`), 2];
  }
  return readEnum(code, words, index);
}

/** A C# anonymous type of two members, as its `ToString()` writes it. */
function pair(a: string, aValue: string, b: string, bValue: string): Text {
  return new Text(`{ ${a} = ${aValue}, ${b} = ${bValue} }`);
}

/** `LiteralString.ReadValue`: bytes up to the first NUL, UTF-8. */
function readString(words: number[], index: number): [string, number] {
  let used = 1;
  const bytes: number[] = [];
  outer: for (let i = index; i < words.length; ++i) {
    const w = words[i]!;
    for (const shift of [0, 8, 16, 24]) {
      const b = (w >>> shift) & 0xff;
      if (b === 0) break outer;
      bytes.push(b);
    }
    used++;
  }
  return [decodeUtf8(Uint8Array.from(bytes)), used];
}

/**
 * `EnumType<T, U>.ReadValue`: a bit set or a value, each set bit or the value
 * followed by its operands. Upstream reads those operands from word 1 of the
 * instruction on, wherever the enum is.
 */
function readEnum(code: OperandCode, words: number[], index: number): [Value, number] {
  const noParams = code.endsWith("!");
  const grammar = ENUMS[noParams ? code.slice(0, -1) : code]!;
  const params = (value: number): readonly OperandCode[] | undefined => {
    if (noParams) return undefined;
    const entry = grammar.entries.find(([, v]) => v === value);
    return entry && grammar.params[entry[0]];
  };
  let used = 0;
  const readParams = (codes: readonly OperandCode[] | undefined): Value[] =>
    (codes ?? []).map((c) => {
      const [v, n] = readValue(c, words, 1 + used);
      used += n;
      return v;
    });
  const w = word(words, index);
  if (grammar.flags) {
    const bits: [number, Value[]][] = [];
    for (const bit of sorted(grammar).values) {
      // bit 0 and a word of 0: the None value.
      if ((w & bit) !== 0 || (bit === 0 && w === 0)) {
        // Dictionary.Add of a value the enum names twice.
        if (bits.some(([b]) => b === bit)) {
          throw new DisassemblyError(
            `An item with the same key has already been added. Key: ${bit}`,
          );
        }
        bits.push([bit, readParams(params(bit))]);
      }
    }
    return [new BitEnumValue(grammar, bits), used + 1];
  }
  const items = readParams(params(w));
  return [new ValueEnumValue(grammar, w, items), used + 1];
}

/** `ParsedInstruction(opCode, words)`: the operands, by the grammar. */
function parseInstruction(opCode: number, words: number[]): Parsed {
  const grammar = INSTRUCTIONS.get(opCode);
  if (!grammar) {
    // Dictionary<int, Instruction>'s indexer: a KeyNotFoundException, which
    // AssetStudio writes into the text.
    throw new DisassemblyError(`The given key '${opCode}' was not present in the dictionary.`);
  }
  const [name, ...codes] = grammar as [string, ...string[]];
  const parsed: Parsed = {
    words,
    name,
    codes,
    operands: [],
    resultType: null,
    debugName: null,
    value: null,
  };
  if (codes.length === 0) return parsed;
  let currentWord = 1;
  let currentOperand = 0;
  const varying: Value[] = [];
  let varyingCode: OperandCode | undefined;
  while (currentWord < words.length) {
    // More words than the grammar has operands, such as a 64-bit constant.
    const spec = codes[currentOperand];
    if (spec === undefined) throw new DisassemblyError(INDEX_OUT_OF_RANGE);
    const isVarying = spec.endsWith("*");
    const code = spec.replace(/[?*]$/, "");
    const [value, used] = readValue(code, words, currentWord);
    if (isVarying) {
      varying.push(value);
      varyingCode = code;
    } else {
      parsed.operands.push({ value, code });
    }
    currentWord += used;
    if (!isVarying) ++currentOperand;
  }
  if (varyingCode !== undefined) {
    // `new uint[count]` of a negative count.
    if (currentWord > words.length) {
      throw new DisassemblyError("Arithmetic operation resulted in an overflow.");
    }
    parsed.operands.push({ value: new VaryingValue(varying), code: varyingCode });
  }
  return parsed;
}

/** `ParsedInstruction.ResultId`: the ID of its `IdResult` operand, or 0. */
function resultId(p: Parsed): number {
  const i = p.codes.findIndex((c) => c === "R");
  return i < 0 ? 0 : (operand(p, i).value as Ref).id;
}

// --- module (Module.cs, Reader.cs) ------------------------------------------

/** `Module`: header and instructions, every reference resolved. */
interface Module {
  version: string;
  generator: string;
  bound: number;
  schema: number;
  instructions: Parsed[];
}

/** `Module.ReadFrom`: a SPIR-V module, either byte order. */
function readModule(bytes: Uint8Array): Module {
  const reader = new StreamReader(bytes);
  const first = reader.readUInt32();
  let little: boolean;
  if (first === MAGIC) little = true;
  else if (reverse(first) === MAGIC) little = false;
  else throw new DisassemblyError("Invalid magic number");
  const dword = (): number => (little ? reader.readUInt32() : reverse(reader.readUInt32()));

  const versionNumber = dword();
  const version = `${versionNumber >>> 16}.${(versionNumber >>> 8) & 0xff}`;
  const generatorMagic = dword();
  const tool = TOOLS.get(generatorMagic >>> 16);
  const vendor = tool?.[0] ?? "unknown";
  const toolName = tool?.[1];
  const generatorVersion = generatorMagic & 0xffff;
  const generator =
    toolName === undefined
      ? `unknown; ${generatorVersion}`
      : `${vendor} ${toolName}; ${generatorVersion}`;
  const bound = dword();
  const schema = dword();

  const instructions: Parsed[] = [];
  while (reader.position !== reader.length) {
    const start = dword();
    const count = start >>> 16;
    // `words[0] = start` in an array of none.
    if (count === 0) throw new DisassemblyError("Index was outside the bounds of the array.");
    const words = [start];
    for (let i = 1; i < count; ++i) words.push(dword());
    instructions.push(parseInstruction(start & 0xffff, words));
  }
  resolve(instructions);
  return { version, generator, bound, schema, instructions };
}

function reverse(u: number): number {
  return ((u << 24) | ((u & 0xff00) << 8) | ((u >>> 8) & 0xff00) | (u >>> 24)) >>> 0;
}

/** `Module.Read`: types, constants, names, then every reference. */
function resolve(instructions: Parsed[]): void {
  const objects = new Map<number, Parsed>();
  const get = (id: number): Parsed => {
    const p = objects.get(id);
    if (!p) throw keyNotFound(id);
    return p;
  };
  // Debug instructions may name types not seen yet, and entry points refer
  // forward: both wait.
  const debug: Parsed[] = [];
  for (const p of instructions) {
    if (DEBUG_INSTRUCTIONS.has(p.name)) {
      debug.push(p);
      continue;
    }
    if (p.name === "OpEntryPoint") continue;
    if (p.name.startsWith("OpType")) processType(p, objects, get);
    // ResolveResultType
    if (p.codes.length > 0 && p.codes[0] === "T") {
      p.resultType = get(operandNumber(p, 0)).resultType;
    }
    const id = resultId(p);
    if (id !== 0) objects.set(id, p);
    if (p.name === "OpSpecConstant" || p.name === "OpConstant") {
      const constant = convertConstant(p.resultType, p.words, 3);
      operand(p, 2).value = constant;
      p.value = constant;
    }
  }
  for (const p of debug) {
    if (p.name === "OpMemberName") {
      const t = cast(get(word(p.words, 1)).resultType, "StructType", "struct");
      const member = operand(p, 1).value as number;
      const name = operand(p, 2).value as string;
      if (t === null) throw new DisassemblyError(NULL_REFERENCE);
      if (t.kind !== "struct") continue; // unreachable: cast() checked it
      if (member >= t.names.length) throw new DisassemblyError(INDEX_OUT_OF_RANGE);
      t.names[member] = name;
    } else if (p.name === "OpName") {
      const target = get(word(p.words, 1));
      target.debugName = operand(p, 1).value as string;
    }
  }
  for (const p of instructions) {
    for (const { value } of p.operands) {
      if (value instanceof Ref) value.target = get(value.id);
    }
  }
}

// The grammar fixes each operand's type, so the C# casts below cannot fail.

/** An operand read as a number (`(uint)Operands[i].Value`). */
function operandNumber(p: Parsed, i: number): number {
  return operand(p, i).value as number;
}

/**
 * An operand read as a value enum (`GetSingleEnumValue<T>`): its value; the
 * enums it is used on (Dim, ImageFormat, AccessQualifier) take no operands.
 */
function operandEnum(p: Parsed, i: number): number {
  return (operand(p, i).value as ValueEnumValue).key;
}

/** `Module.ProcessTypeInstruction`: the type an `OpType*` declares, in C#'s order. */
function processType(
  p: Parsed,
  objects: Map<number, Parsed>,
  get: (id: number) => Parsed,
): void {
  const w = (i: number): number => word(p.words, i);
  const typeAt = (i: number): SpvType | null => get(w(i)).resultType;
  switch (p.name) {
    case "OpTypeInt":
      p.resultType = { kind: "int", width: w(2) | 0, signed: w(3) === 1 };
      break;
    case "OpTypeFloat":
      p.resultType = { kind: "float", width: w(2) | 0 };
      break;
    case "OpTypeVector": {
      const component = cast(typeAt(2), "ScalarType", "bool", "int", "float");
      p.resultType = { kind: "vector", component, count: w(3) | 0 };
      break;
    }
    case "OpTypeMatrix": {
      const column = cast(typeAt(2), "VectorType", "vector");
      p.resultType = { kind: "matrix", column, count: w(3) | 0 };
      break;
    }
    case "OpTypeArray": {
      // The length constant's integer value; anything else gives 0.
      const constant = get(w(3)).value;
      const count = typeof constant === "number" ? constant | 0 : 0;
      p.resultType = { kind: "array", element: typeAt(2), count };
      break;
    }
    case "OpTypeRuntimeArray":
      typeAt(2);
      p.resultType = { kind: "runtimeArray" };
      break;
    case "OpTypeBool":
      p.resultType = { kind: "bool" };
      break;
    case "OpTypeOpaque":
      p.resultType = { kind: "opaque" };
      break;
    case "OpTypeVoid":
      p.resultType = { kind: "void" };
      break;
    case "OpTypeImage": {
      get((operand(p, 1).value as Ref).id);
      const dim = operandEnum(p, 2);
      operandNumber(p, 3);
      const arrayed = operandNumber(p, 4) !== 0;
      const multisampled = operandNumber(p, 5) !== 0;
      operandNumber(p, 6);
      operandEnum(p, 7);
      // ReadOnly when the access qualifier is left out.
      const access = p.operands.length > 8 ? operandEnum(p, 8) : 0;
      p.resultType = { kind: "image", dim, arrayed, multisampled, access };
      break;
    }
    case "OpTypeSampler":
      p.resultType = { kind: "sampler" };
      break;
    case "OpTypeSampledImage":
      p.resultType = { kind: "sampledImage", image: cast(typeAt(2), "ImageType", "image") };
      break;
    case "OpTypeFunction":
      for (let j = 3; j < p.words.length; ++j) typeAt(j);
      typeAt(2);
      p.resultType = { kind: "function" };
      break;
    case "OpTypeForwardPointer":
      p.resultType = { kind: "pointer", storage: w(2), type: null };
      break;
    case "OpTypePointer":
      if (objects.has(w(1))) {
        // A forward reference: upstream resolves it on this instruction's own
        // type, which is still null.
        typeAt(3);
        throw new DisassemblyError(NULL_REFERENCE);
      }
      p.resultType = { kind: "pointer", storage: w(2), type: typeAt(3) };
      break;
    case "OpTypeStruct": {
      const members: (SpvType | null)[] = [];
      for (let j = 2; j < p.words.length; ++j) members.push(typeAt(j));
      p.resultType = { kind: "struct", members, names: members.map(() => "") };
      break;
    }
  }
}

/**
 * `Module.ConvertConstant`: an integer constant's value; a 32-bit float
 * read, as upstream reads it, from word 0 rather than `index`.
 */
function convertConstant(type: SpvType | null, words: number[], index: number): Value {
  if (type?.kind === "int") {
    const w = word(words, index);
    if (type.width === 16) return type.signed ? (w << 16) >> 16 : w & 0xffff;
    if (type.width === 32) return type.signed ? w | 0 : w;
    // 64 bits cannot get here: two words, more than the grammar's operands.
    throw new DisassemblyError("Cannot construct integer literal.");
  }
  if (type?.kind === "float") {
    if (type.width === 32) {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, word(words, 0));
      return new FloatConstant(view.getFloat32(0));
    }
    if (type.width === 64) {
      // Unreachable: a 64-bit constant has more words than the grammar's operands.
      throw new DisassemblyError(INDEX_OUT_OF_RANGE);
    }
    throw new DisassemblyError("Cannot construct floating point literal.");
  }
  return null;
}

// --- .NET enum formatting -----------------------------------------------------

/** `EnumInfo`: names and values sorted by value, a stable sort. */
interface SortedEnum {
  names: string[];
  values: number[];
  sequential: boolean;
}

const SORTED = new Map<GrammarEnum, SortedEnum>();

function sorted(grammar: GrammarEnum): SortedEnum {
  let info = SORTED.get(grammar);
  if (!info) {
    const entries = grammar.entries
      .map(([name, value], i) => ({ name, value, i }))
      .sort((a, b) => a.value - b.value || a.i - b.i);
    const values = entries.map((e) => e.value);
    info = {
      names: entries.map((e) => e.name),
      values,
      sequential: values.every((v, i) => v === i),
    };
    SORTED.set(grammar, info);
  }
  return info;
}

/** `Enum.GetName`: .NET 8 searches linearly up to 32 values, else binary. */
function enumName(grammar: GrammarEnum, value: number): string | undefined {
  const { names, values, sequential } = sorted(grammar);
  let index: number;
  if (sequential) index = value < values.length ? value : -1;
  else if (values.length <= 32) index = values.indexOf(value);
  else {
    index = -1;
    let lo = 0;
    let hi = values.length - 1;
    while (lo <= hi) {
      const i = (lo + hi) >>> 1;
      const v = values[i]!;
      if (value === v) {
        index = i;
        break;
      }
      if (value > v) lo = i + 1;
      else hi = i - 1;
    }
  }
  return index >= 0 ? names[index] : undefined;
}

/** `Enum.ToString()`: the name, `A, B` for a set of flags, else the number. */
function enumToString(grammar: GrammarEnum, value: number): string {
  if (!grammar.flags) return enumName(grammar, value) ?? String(value >>> 0);
  const { names, values } = sorted(grammar);
  if (value === 0) return values[0] === 0 ? names[0]! : "0";
  let index = values.length - 1;
  while (index >= 0) {
    if (values[index] === value) return names[index]!;
    if (values[index]! < value) break;
    index--;
  }
  let rest = value >>> 0;
  const found: string[] = [];
  for (; index >= 0; index--) {
    const v = values[index]!;
    if (index === 0 && v === 0) break;
    if (((rest & v) >>> 0) === v) {
      rest = (rest - v) >>> 0;
      found.push(names[index]!);
    }
  }
  return rest !== 0 ? String(value >>> 0) : found.reverse().join(", ");
}

// --- disassembly (Disassembler.cs) -------------------------------------------

/** .NET's `char.IsWhiteSpace` set, for `string.IsNullOrWhiteSpace`. */
const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** `!string.IsNullOrWhiteSpace(name)`. */
const hasName = (name: string | null): name is string =>
  name !== null && [...name].some((c) => !WHITESPACE.has(c.charCodeAt(0)));

/** `PrintOperandValue`, with names and types shown. */
function operandText(value: Value): string {
  if (value === null) return "";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(value);
  if (value instanceof TypeName) return value.name;
  if (value instanceof Text) return value.text;
  if (value instanceof FloatConstant) return formatSingle(value.value);
  if (value instanceof Ref) {
    const name = value.target?.debugName ?? null;
    return hasName(name) ? name : `%${value.id}`;
  }
  if (value instanceof BitEnumValue) {
    return value.bits
      .map(([bit, params]) => {
        // Type.GetEnumName: null, so nothing, for a bit the enum does not name.
        const name = enumName(value.grammar, bit) ?? "";
        return params.length > 0 ? `${name} ${params.map(operandText).join("")}` : name;
      })
      .join("");
  }
  if (value instanceof ValueEnumValue) {
    const key = enumToString(value.grammar, value.key);
    return value.params.length > 0 ? `${key} ${value.params.map(operandText).join("")}` : key;
  }
  // VaryingOperandValue.ToString: IDs as `%id`, never names; the rest through ToString().
  return value.values
    .map((v) => {
      if (v instanceof Ref) return `%${v.id}`;
      if (v instanceof TypeName) return `SpirV.${v.name}`;
      return v === null || typeof v === "string" ? (v ?? "") : operandText(v);
    })
    .join(" ");
}

/** `PrintInstruction`. */
function instructionText(p: Parsed): string {
  if (p.operands.length === 0) return p.name;
  let out = "";
  let current = 0;
  if (p.codes[current] === "T") {
    out += typeText(p.resultType) + " ";
    ++current;
  }
  if (current < p.operands.length && p.codes[current] === "R") {
    out += hasName(p.debugName) ? p.debugName : operandText(p.operands[current]!.value);
    out += " = ";
    ++current;
  }
  out += p.name + " ";
  for (; current < p.operands.length; ++current) {
    out += operandText(p.operands[current]!.value) + " ";
  }
  return out;
}

/**
 * `Disassembler.Disassemble(module, DisassemblyOptions.Default)` on a SPIR-V
 * module, then `.Replace("\r\n", "\n")` as AssetStudio does: a `; SPIR-V`
 * header, then one instruction a line, aligned on the `=` of the result IDs
 * (at most 50 characters in).
 *
 * @param bytes the module
 * @throws {DisassemblyError} wherever upstream throws, with .NET's message
 */
export function disassemble(bytes: Uint8Array): string {
  const module = readModule(bytes);
  // AppendLine on Windows, where AssetStudio runs: "\r\n".
  const nl = "\r\n";
  const lines = [
    `; SPIR-V${nl}; Version: ${module.version}${nl}; Generator: ${module.generator}${nl}` +
      `; Bound: ${module.bound}${nl}; Schema: ${module.schema}${nl}`,
    ...module.instructions.map(instructionText),
  ];
  let longest = 0;
  for (const line of lines) {
    longest = Math.max(longest, line.indexOf("="));
    if (longest > 50) {
      longest = 50;
      break;
    }
  }
  let out = lines[0]!;
  for (const line of lines.slice(1)) {
    const index = line.indexOf("=");
    if (index === -1) out += " ".repeat(longest + 4) + line;
    else out += " ".repeat(Math.max(0, longest - index)) + line;
    out += nl;
  }
  return out.split("\r\n").join("\n");
}
