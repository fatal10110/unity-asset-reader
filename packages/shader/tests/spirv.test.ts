// The SPIR-V disassembler on hand-built modules, for what the fixtures do not
// reach: debug names, a float constant, an opcode CSspv does not know. The
// expected text is worked out from CSspv's code as AssetStudio c37af7d has it
// (Disassembler.cs, Module.cs, OperandType.cs), quirks included; the fixture
// programs check the rest against AssetStudio's own output (shader.test.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSingle } from "../src/float.js";
import { DisassemblyError } from "../src/net.js";
import { disassemble } from "../src/spirv.js";

/** A module: SPIR-V 1.0 from glslang (tool 8) version 1, bound 10, then the instructions. */
function module(...instructions: number[][]): Uint8Array {
  const words = [0x07230203, 0x00010000, (8 << 16) | 1, 10, 0, ...instructions.flat()];
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  return bytes;
}

/** An instruction: its word count and opcode, then its operands. */
const op = (opcode: number, ...operands: number[]): number[] => [
  ((operands.length + 1) << 16) | opcode,
  ...operands,
];

const HEADER =
  "; SPIR-V\n; Version: 1.0\n; Generator: Khronos Glslang Reference Front End; 1\n" +
  "; Bound: 10\n; Schema: 0\n";

test("names replace IDs, operands of an enum come from word 1, a float from word 0", () => {
  const constant = op(43, 2, 3, 0x3f800000); // OpConstant f32 %3 = 1.0
  const text = disassemble(
    module(
      op(17, 1), // OpCapability Shader
      op(5, 3, 0x78), // OpName %3 "x"
      op(71, 3, 30, 7), // OpDecorate %3 Location 7
      op(22, 2, 32), // %2 = OpTypeFloat 32
      constant,
    ),
  );
  // CSspv reads the float from the instruction's first word, not its value.
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, constant[0]!);
  const float = formatSingle(view.getFloat32(0));
  assert.equal(
    text,
    HEADER +
      "          OpCapability Shader \n" +
      '          OpName x "x" \n' +
      // Location's literal is word 1 of the instruction: the target's ID.
      "          OpDecorate x Location 3 \n" +
      "   %2 = OpTypeFloat 32 \n" +
      `f32 x = OpConstant ${float} \n`,
  );
});

test("a matrix of vectors of a type CSspv does not model prints as upstream's ToString()", () => {
  // OpTypeEvent declares a type CSspv gives no ResultType (null). A vector of
  // it fails when printed itself, but inside a matrix C# formats the column
  // with string interpolation, which writes the null component as nothing.
  const text = disassemble(
    module(
      op(34, 2), // %2 = OpTypeEvent
      op(23, 3, 2, 4), // %3 = OpTypeVector %2 4
      op(24, 4, 3, 4), // %4 = OpTypeMatrix %3 4
      op(1, 4, 5), // %5 = OpUndef %4
    ),
  );
  assert.equal(
    text,
    HEADER +
      "     %2 = OpTypeEvent \n" +
      "     %3 = OpTypeVector %2 4 \n" +
      "     %4 = OpTypeMatrix %3 4 \n" +
      "_4x4 %5 = OpUndef \n",
  );
});

test("an opcode CSspv does not know fails with .NET's KeyNotFoundException message", () => {
  // OpDemoteToHelperInvocation (5380) is newer than CSspv's grammar.
  assert.throws(
    () => disassemble(module(op(17, 1), op(5380))),
    (error: unknown) =>
      error instanceof DisassemblyError &&
      error.message === "The given key '5380' was not present in the dictionary.",
  );
});

test("a bad magic number fails with upstream's message", () => {
  const bytes = module(op(17, 1));
  bytes[0] = 0;
  assert.throws(
    () => disassemble(bytes),
    (error: unknown) => error instanceof DisassemblyError && error.message === "Invalid magic number",
  );
});

test("a big-endian module reads as the same one", () => {
  const little = module(op(17, 1), op(22, 2, 32));
  const big = new Uint8Array(little.length);
  for (let i = 0; i < little.length; i += 4) big.set(little.subarray(i, i + 4).reverse(), i);
  assert.equal(disassemble(big), disassemble(little));
});
