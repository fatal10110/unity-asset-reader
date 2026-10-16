// shaderToText (#242) against AssetStudio's own shader export: the golden of
// each fixture Shader is the size and sha256 of the .shader file AssetStudio
// c37af7d's `Exporter.ExportShader` (`ShaderConverter.Convert()`) wrote for it
// (fixtures/assetstudio-export-goldens.json, #233, R12). Where AssetStudio
// wrote nothing, the golden says why, and these tests check that
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

/** The program types of every variant `m_SubPrograms` lists, the ones the text holds. */
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
      }
    }
  }
  return types;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const at = (s: (typeof SHADERS)[number]): string => `${s.fixture} Shader ${s.pathId}`;
const WITH_TEXT = SHADERS.filter((s) => s.entry.shader);

test("the export goldens list the 36 fixture Shaders, 12 with AssetStudio's text", () => {
  assert.equal(SHADERS.length, 36);
  assert.deepEqual(
    WITH_TEXT.map((s) => s.fixture).sort(),
    [
      ...Array(2).fill("editor/2019.4.41f2/shader/lz4-notypetree/android"),
      ...Array(2).fill("editor/2019.4.41f2/shader/lz4/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4-notypetree/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4-notypetree/ios"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4/android"),
      ...Array(2).fill("editor/2020.3.30f1/shader/lz4/ios"),
    ],
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
  test(`${at(s)}: shaderToText is byte-identical to AssetStudio's .shader file`, () => {
    const bytes = encode(shaderToText(readShader(s.fixture, s.file, s.pathId)));
    assert.equal(bytes.length, s.entry.shader!.size);
    assert.equal(sha256(bytes), s.entry.shader!.sha256);
  });
}

test("2019.4's Vulkan programs are disassembled, 2020.3's are AssetStudio's error line", () => {
  // AssetStudio's SMOL-V decoder predates the format 2020.3 writes (header
  // version 0x01010000): it reports a failed decode, and the golden holds
  // that line, so ours must too.
  const text = (fixture: string): string => {
    const s = WITH_TEXT.find((w) => w.fixture === fixture)!;
    return shaderToText(readShader(s.fixture, s.file, s.pathId));
  };
  const old = text("editor/2019.4.41f2/shader/lz4/android");
  assert.match(old, /\n; SPIR-V\n; Version: 1\.0\n; Generator: Khronos Glslang Reference Front End; /);
  assert.doesNotMatch(old, /disassembly error/);
  const newer = text("editor/2020.3.30f1/shader/lz4/android");
  assert.match(newer, /"\/\/ hash: [0-9a-f]{8,16}\n\/\/ disassembly error Unable to decode SMOL-V shader\n"/);
  assert.doesNotMatch(newer, /; SPIR-V/);
});

for (const s of SHADERS.filter((x) => !x.entry.shader)) {
  const windows = s.fixture.endsWith("/windows");
  const modern = /\/6000\.[36]\./.test(s.fixture);
  test(`${at(s)}: no golden (${modern ? "Unity 6000" : "Direct3D"}), and shaderToText refuses it`, () => {
    assert.ok(windows || modern, s.fixture);
    const shader = readShader(s.fixture, s.file, s.pathId);
    if (modern) {
      // AssetStudio c37af7d skips every 6000+ Shader and cannot load format 23.
      assert.match(
        s.entry.exportError!,
        /ArgumentNullException|AssetStudio did not load the object/,
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
          ? error.kind === "shader variant list" && error.found === "m_PlayerSubPrograms"
          : error.kind === "shader program type" && error.found === "DX11VertexSM40"),
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
