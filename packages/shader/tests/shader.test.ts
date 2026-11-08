// shaderToText (#242) against AssetStudio's own shader export: the golden of
// each fixture Shader is the size and sha256 of the .shader file AssetStudio
// c37af7d's `Exporter.ExportShader` (`ShaderConverter.Convert()`) wrote for it
// (fixtures/assetstudio-export-goldens.json, #233, R12); for a shader with
// variants in m_PlayerSubPrograms, which c37af7d does not read, the composite
// oracle's text (plan section 5, revision 2026-11-08a, #259). Where neither
// wrote anything, the golden says why, and these tests check that
// shaderToText refuses the shader instead of writing text nobody checked.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ClassID,
  CorruptError,
  load,
  UnsupportedError,
  type Shader,
  type SerializedProgram,
} from "unity-asset-reader";

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { shaderToText } from "../src/index.js";

interface ExportEntry {
  class: string;
  shader?: { size: number; sha256: string };
  exportError?: string;
  oracle?: string;
}

const GOLDENS = new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url);
const goldens = JSON.parse(readFileSync(GOLDENS, "utf8")) as {
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
};

/** Every fixture Shader the export goldens list: fixture, file, path ID, entry. */
const SHADERS = Object.entries(goldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Shader")
      .map(([pathId, entry]) => ({ fixture, file, pathId: BigInt(pathId), entry })),
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

/** `ShaderGpuProgramType` values, as AssetStudio numbers them. */
const GLES31AEP = 2;
const GLES3 = 4;
const METAL_VS = 23;
const METAL_FS = 24;
const SPIRV = 25;
const DX11 = new Set([15, 16, 17, 18, 19, 20, 21, 22]);

/** The program types of every variant `m_SubPrograms` and `m_PlayerSubPrograms` list. */
function programTypes(shader: Shader): Set<number> {
  const types = new Set<number>();
  for (const subShader of shader.m_ParsedForm.m_SubShaders) {
    for (const pass of subShader.m_Passes) {
      const programs: (SerializedProgram | undefined)[] = [
        pass.progVertex,
        pass.progFragment,
        pass.progGeometry,
        pass.progHull,
        pass.progDomain,
        pass.progRayTracing,
      ];
      for (const program of programs) {
        for (const sub of program?.m_SubPrograms ?? []) types.add(sub.m_GpuProgramType);
        for (const sub of program?.m_PlayerSubPrograms?.flat() ?? []) types.add(sub.m_GpuProgramType);
      }
    }
  }
  return types;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const at = (s: (typeof SHADERS)[number]): string => `${s.fixture} Shader ${s.pathId}`;
const WITH_TEXT = SHADERS.filter((s) => s.entry.shader);

test("the export goldens list the 42 fixture Shaders, 23 with text, 11 of them the composite's", () => {
  assert.equal(SHADERS.length, 42);
  assert.deepEqual(
    WITH_TEXT.map((s) => s.fixture).sort(),
    [
      ...Array(2).fill("editor/2019.4.41f2/shader/lz4-notypetree/android"),
      ...Array(2).fill("editor/2019.4.41f2/shader/lz4/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4-notypetree/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4-notypetree/ios"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4/ios"),
      ...Array(2).fill("editor/6000.3.26f1/shader-variants/lz4/android"),
      ...Array(2).fill("editor/6000.3.26f1/shader-variants/lz4/ios"),
      "editor/6000.3.26f1/shader/lz4-notypetree/android",
      "editor/6000.3.26f1/shader/lz4-notypetree/ios",
      "editor/6000.3.26f1/shader/lz4/android",
      "editor/6000.3.26f1/shader/lz4/ios",
      ...Array(2).fill("editor/6000.6.4f1/shader-variants/lz4/android"),
      "editor/6000.6.4f1/shader/lz4/android",
    ],
  );
  assert.deepEqual(
    WITH_TEXT.filter((s) => s.entry.oracle).map((s) => s.fixture.split("/")[1]),
    [...Array(8).fill("6000.3.26f1"), ...Array(3).fill("6000.6.4f1")],
  );
});

test("the fixtures with text hold GLES 3, GLES 3.1 AEP, Vulkan and Metal programs", () => {
  const types = new Set(WITH_TEXT.flatMap((s) => [...programTypes(readShader(s.fixture, s.file, s.pathId))]));
  assert.deepEqual([...types].sort((a, b) => a - b), [GLES31AEP, GLES3, METAL_VS, METAL_FS, SPIRV]);
  // Each editor contributes its own: SPIR-V from both 2019.4 and 2020.3.
  for (const editor of ["2019.4.41f2", "2020.3.30f1"]) {
    const s = WITH_TEXT.find((w) => w.fixture === `editor/${editor}/shader/lz4/android`)!;
    const t = programTypes(readShader(s.fixture, s.file, s.pathId));
    assert.ok(t.has(GLES3) && t.has(SPIRV), `${editor}: ${[...t]}`);
  }
});

for (const s of WITH_TEXT) {
  const oracle = s.entry.oracle ? "the composite oracle's text" : "AssetStudio's .shader file";
  test(`${at(s)}: shaderToText is byte-identical to ${oracle}`, () => {
    const bytes = encode(shaderToText(readShader(s.fixture, s.file, s.pathId)));
    assert.equal(bytes.length, s.entry.shader!.size);
    assert.equal(sha256(bytes), s.entry.shader!.sha256);
  });
}

test("2019.4's and 2020.3's Vulkan programs are both disassembled", () => {
  // 2020.3 writes SMOL-V encoding version 1 (header version 0x01010000),
  // which AssetStudio's decoder predates; its golden is the hybrid oracle's
  // (smol-v's words, AssetStudio's disassembler; plan section 5, #260).
  const text = (fixture: string): string => {
    const s = WITH_TEXT.find((w) => w.fixture === fixture)!;
    return shaderToText(readShader(s.fixture, s.file, s.pathId));
  };
  for (const editor of ["2019.4.41f2", "2020.3.30f1"]) {
    const out = text(`editor/${editor}/shader/lz4/android`);
    assert.match(out, /\n; SPIR-V\n; Version: 1\.0\n; Generator: Khronos Glslang Reference Front End; /);
    assert.doesNotMatch(out, /disassembly error/, editor);
  }
});

for (const s of SHADERS.filter((x) => !x.entry.shader)) {
  const windows = s.fixture.endsWith("/windows");
  const modern = !windows && /\/6000\.[36]\./.test(s.fixture);
  test(`${at(s)}: no golden (${modern ? "Int property" : "Direct3D"}), and shaderToText refuses it`, () => {
    assert.ok(windows || modern, s.fixture);
    const shader = readShader(s.fixture, s.file, s.pathId);
    if (modern) {
      // The composite oracle runs c37af7d's converter, which has no case for
      // an Int property (UAR/ShaderFixture's _Count).
      assert.match(
        s.entry.exportError!,
        /^ShaderConverter\.ConvertSerializedShader throws ArgumentOutOfRangeException/,
      );
    } else {
      // ShaderConverter needs Windows' D3DCompiler or HLSLDecompiler for these.
      assert.match(s.entry.exportError!, /D3D11 programs need Windows' D3DCompiler/);
      assert.ok([...programTypes(shader)].every((t) => DX11.has(t)));
    }
    assert.throws(
      () => shaderToText(shader),
      (error: unknown) =>
        error instanceof UnsupportedError &&
        (modern
          ? error.kind === "shader property type" && error.found === "Int"
          : (error.kind === "shader program type" && error.found === "DX11VertexSM40") ||
            // UAR/ShaderFixture of 6000.x: its Int property fails before its programs.
            (error.kind === "shader property type" && error.found === "Int" && /\/6000\./.test(s.fixture))),
    );
  });
}

/** The 2019.4 Android `UAR/ShaderFixtureSecond`, to change. */
const BASE = (() => {
  const s = WITH_TEXT.find(
    (w) => w.fixture === "editor/2019.4.41f2/shader/lz4/android" && w.entry.shader!.size < 100000,
  )!;
  return readShader(s.fixture, s.file, s.pathId);
})();

test("the base shader is UAR/ShaderFixtureSecond", () => {
  assert.equal(BASE.m_ParsedForm.m_Name, "UAR/ShaderFixtureSecond");
  assert.deepEqual(BASE.platforms, [9, 18]);
});

test("a property of type Int (5) is refused, as AssetStudio fails on it", () => {
  const prop = { ...BASE.m_ParsedForm.m_PropInfo.m_Props[0]!, m_Type: 5 };
  const shader: Shader = {
    ...BASE,
    m_ParsedForm: { ...BASE.m_ParsedForm, m_PropInfo: { m_Props: [prop] } },
  };
  assert.throws(
    () => shaderToText(shader),
    (error: unknown) =>
      error instanceof UnsupportedError && error.kind === "shader property type" && error.found === "Int",
  );
});

test("a platform AssetStudio does not know is refused", () => {
  // NaCl (6) in place of GLES3Plus: CheckGpuProgramUsable throws on it.
  assert.throws(
    () => shaderToText({ ...BASE, platforms: [6, 18] }),
    (error: unknown) =>
      error instanceof UnsupportedError && error.kind === "shader platform" && error.found === "NaCl",
  );
});

test("a blob cut short is a CorruptError", () => {
  const blob = BASE.compressedBlob.subarray(0, BASE.compressedBlob.length - 10);
  assert.throws(() => shaderToText({ ...BASE, compressedBlob: blob }), CorruptError);
});

test("text starts with AssetStudio's banner and has no final newline", () => {
  const text = shaderToText(BASE);
  assert.ok(text.startsWith("//////////////////////////////////////////\n//\n// NOTE: This is *not* a valid shader file\n"));
  assert.ok(text.endsWith("\n}"));
  assert.ok(!text.includes("\r"));
});
