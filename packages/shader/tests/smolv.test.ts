// SMOL-V decoding per Vulkan stage (#260) against the hybrid oracle: each
// Shader golden lists its stages under shader.spirv, by the sha256 of the
// stage's SMOL-V bytes, with the encoding version and the size and sha256 of
// the SPIR-V. Encoding 0 (Unity 2019.4) is AssetStudio c37af7d's SmolvDecoder,
// which aras-p/smol-v 6303e979 reproduces with its 2016-08-31 flag; encoding 1
// (Unity 2020.3) is smol-v's `Decode` (fixtures/assetstudio-export-goldens.json,
// scripts/make-export-goldens.py, R12).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClassID, load, type Shader } from "unity-asset-reader";

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { readPrograms, stageWords, subProgramText } from "../src/convert.js";
import { DisassemblyError } from "../src/net.js";
import { decodeSmolvV1 } from "../src/smolv.js";

interface Stage {
  encoding: number;
  size?: number;
  sha256?: string;
  error?: string;
}

interface ExportEntry {
  class: string;
  shader?: { size: number; sha256: string; spirv?: Record<string, Stage> };
}

const GOLDENS = new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url);
const goldens = JSON.parse(readFileSync(GOLDENS, "utf8")) as {
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
};

/** `ShaderGpuProgramType.SPIRV`. */
const SPIRV = 25;

const WITH_STAGES = Object.entries(goldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.shader?.spirv)
      .map(([pathId, entry]) => ({ fixture, file, pathId: BigInt(pathId), stages: entry.shader!.spirv! })),
  ),
);

/** The fixture Shader as `obj.read()` gives it. */
function readShader(fixture: string, file: string, pathId: bigint): Shader {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const reader = env.objects.find((o) => o.fileName === file && o.pathId === pathId);
  assert.ok(reader, `${fixture}: no object ${pathId} in ${file}`);
  assert.equal(reader.type, ClassID.Shader);
  return reader.read<Shader>();
}

/** `SpirVShaderConverter.Convert`'s stage table: (offset, size) of each stage. */
function stageTable(code: Uint8Array): [number, number][] {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const out: [number, number][] = [];
  let position = 4; // requirements
  let minOffset = code.length;
  for (let i = 0; i < 5 && position < minOffset; i++) {
    if (position + 8 > code.length) return []; // Convert fails before any stage
    const offset = view.getInt32(position, true);
    const size = view.getInt32(position + 4, true);
    position += 8;
    if (size > 0) {
      if (offset < minOffset) minOffset = offset;
      out.push([offset, size]);
    }
  }
  return out;
}

/** Every Vulkan stage of the shader with a header, as the golden records it. */
function stages(shader: Shader): Record<string, Stage> {
  const out: Record<string, Stage> = {};
  for (const program of readPrograms(shader).flat()) {
    if (program?.type !== SPIRV) continue;
    const code = program.code;
    for (const [offset, size] of stageTable(code)) {
      if (offset < 0 || offset + 24 > code.length) continue; // no header: no golden
      const key = sha256(code.subarray(offset, offset + size));
      const stage: Stage = { encoding: code[offset + 7]! };
      try {
        const words = stageWords(code, offset, size);
        stage.size = words.length;
        stage.sha256 = sha256(words);
      } catch (error) {
        if (!(error instanceof DisassemblyError)) throw error;
        stage.error = error.message;
      }
      out[key] = stage;
    }
  }
  return out;
}

test("the goldens list the Vulkan stages of 2019.4 (encoding 0), 2020.3 and 6000.x (encoding 1)", () => {
  const encodings = (editor: string): number[] => [
    ...new Set(
      WITH_STAGES.filter((s) => s.fixture.includes(`/${editor}/`)).flatMap((s) =>
        Object.values(s.stages).map((stage) => stage.encoding),
      ),
    ),
  ];
  // 8 by ExportShader; 3 6000.x Android UAR/ShaderFixtureSecond by the composite (#259).
  assert.equal(WITH_STAGES.length, 11);
  assert.deepEqual(encodings("2019.4.41f2"), [0]);
  assert.deepEqual(encodings("2020.3.30f1"), [1]);
  assert.deepEqual(encodings("6000.3.26f1"), [1]);
  assert.deepEqual(encodings("6000.6.4f1"), [1]);
});

for (const s of WITH_STAGES) {
  test(`${s.fixture} Shader ${s.pathId}: each Vulkan stage decodes to the oracle's SPIR-V`, () => {
    assert.deepEqual(stages(readShader(s.fixture, s.file, s.pathId)), s.stages);
  });
}

/** A version-1 SMOL-V header: magic, version word, generator, bound, schema, decoded size. */
function header(version: number, decodedSize: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x534d4f4c, true); // "SMOL"
  view.setUint32(4, version, true);
  view.setUint32(8, 0x00080001, true);
  view.setUint32(12, 10, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, decodedSize, true);
  return bytes;
}

test("a version-1 stream decodes its header, version word without the encoding byte", () => {
  const words = decodeSmolvV1(header(0x01010000, 20));
  assert.ok(words);
  const view = new DataView(words.buffer);
  assert.deepEqual(
    [0, 4, 8, 12, 16].map((at) => view.getUint32(at, true)),
    [0x07230203, 0x00010000, 0x00080001, 10, 0],
  );
});

test("smol-v's refusals: bad magic, SPIR-V version, encoding version, size or truncation", () => {
  const magic = header(0x01010000, 20);
  magic[0] = 0;
  assert.equal(decodeSmolvV1(magic), undefined, "magic");
  assert.equal(decodeSmolvV1(header(0x01010700, 20)), undefined, "SPIR-V 1.7");
  assert.equal(decodeSmolvV1(header(0x02010000, 20)), undefined, "encoding 2");
  assert.equal(decodeSmolvV1(header(0x01010000, 0)), undefined, "decoded size 0");
  assert.equal(decodeSmolvV1(header(0x01010000, 16)), undefined, "decoded size below the header");
  assert.equal(decodeSmolvV1(header(0x01010000, 24)), undefined, "decodes short of its size");
  assert.equal(decodeSmolvV1(header(0x01010000, 20).subarray(0, 23)), undefined, "truncated header");
  // OpName (5), two words, the second raw: cut off after the length and opcode.
  const cut = new Uint8Array([...header(0x01010000, 28), (1 << 4) | 5]);
  assert.equal(decodeSmolvV1(cut), undefined, "instruction past the end");
});

test("a 2020.3 stage cut short is AssetStudio's failed-decode error, not a partial module", () => {
  const s = WITH_STAGES.find((w) => w.fixture === "editor/2020.3.30f1/shader/lz4/android")!;
  const program = readPrograms(readShader(s.fixture, s.file, s.pathId))
    .flat()
    .find((p) => p?.type === SPIRV)!;
  const [offset, size] = stageTable(program.code)[0]!;
  assert.equal(program.code[offset + 7], 1);
  assert.ok(stageWords(program.code, offset, size).length > 20);
  assert.throws(
    () => stageWords(program.code, offset, size - 1),
    (error) => error instanceof DisassemblyError && error.message === "Unable to decode SMOL-V shader",
  );
});

/** SMOL-V's varint: 7 bits a byte, low bits first. */
function varint(value: number): number[] {
  const out: number[] = [];
  for (; value >= 128; value = Math.floor(value / 128)) out.push((value % 128) | 128);
  out.push(value);
  return out;
}

/** An instruction's length-and-opcode varint, as smol-v's `EncodeLen` and `smolv_ReadLengthOp` lay it out. */
function lengthOp(op: number, words: number): number[] {
  const length = words - 1; // DecodeLen adds 1 for an op without a bias
  return varint((op & 0xf) | ((length & 0xf) << 4) | ((op & 0xfff0) << 4) | ((length >> 4) << 20));
}

/** A stage: the header, then the instruction bytes, decoding to `words` words after the header. */
function stage(version: number, words: number, body: number[]): Uint8Array {
  return new Uint8Array([...header(version, 20 + 4 * words), ...body]);
}

/** The SPIR-V words of a decoded module. */
function words(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

test("ops 331 to 366 have op data in encoding 1 and raw words in smol-v's encoding 0", () => {
  // OpGroupNonUniformElect (333): result type, result (zigzag delta 10 -> 5),
  // execution scope relative to the result (zigzag 4 -> 2, so 5 - 2 = 3).
  const v1 = decodeSmolvV1(stage(0x01010000, 4, [...lengthOp(333, 4), 2, 10, 4]));
  assert.ok(v1);
  assert.deepEqual(words(v1).slice(5), [(4 << 16) | 333, 2, 5, 3]);
  // Encoding 0 knows ops up to OpModuleProcessed (330): the operands are raw words.
  const raw = [2, 0, 0, 0, 5, 0, 0, 0, 3, 0, 0, 0];
  const v0 = decodeSmolvV1(stage(0x00010000, 4, [...lengthOp(333, 4), ...raw]));
  assert.ok(v0);
  assert.deepEqual(words(v0).slice(5), [(4 << 16) | 333, 2, 5, 3]);
  // Read as encoding 1, those raw bytes are varints and do not decode to 4 words.
  assert.equal(decodeSmolvV1(stage(0x01010000, 4, [...lengthOp(333, 4), ...raw])), undefined);
});

test("a version-1 stage that decodes but CSspv cannot disassemble keeps AssetStudio's error line", () => {
  // Op 5380, which CSspv's grammar does not have, with one raw operand word.
  const smolv = stage(0x01010000, 2, [...lengthOp(5380, 2), 42, 0, 0, 0]);
  assert.deepEqual(words(decodeSmolvV1(smolv)!).slice(5), [(2 << 16) | 5380, 42]);
  // The program: requirements, then one (offset, size) entry and the stage.
  const code = new Uint8Array(12 + smolv.length);
  const view = new DataView(code.buffer);
  view.setInt32(4, 12, true);
  view.setInt32(8, smolv.length, true);
  code.set(smolv, 12);
  const text = subProgramText({ type: SPIRV, keywords: [], localKeywords: undefined, code });
  assert.match(
    text,
    /^"\/\/ hash: [0-9a-f]{8,}\n\/\/ disassembly error The given key '5380' was not present in the dictionary\.\n"$/,
  );
});
