// Variants in m_PlayerSubPrograms (#259): Unity 2021.3.10, 2022.1.13, 2022.2
// and later list them there, which AssetStudio c37af7d's ShaderConverter does
// not read. Their golden is the composite oracle's text (plan section 5,
// revision 2026-11-08a): each distinct blob index and program type, its groups
// in order, where it first appears, one SubProgram without hw_tierNN. The
// byte-identical checks are in shader.test.ts; these check the layout rule.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClassID, load, type Shader } from "unity-asset-reader";

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { shaderToText } from "../src/index.js";
import { readPrograms } from "../src/convert.js";

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

/** Every fixture Shader with its golden, read as `obj.read()` gives it. */
const SHADERS = Object.entries(goldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Shader")
      .map(([pathId, entry]) => ({ fixture, file, pathId: BigInt(pathId), entry })),
  ),
);

function readShader(fixture: string, file: string, pathId: bigint): Shader {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const reader = env.objects.find((o) => o.fileName === file && o.pathId === pathId);
  assert.ok(reader && reader.type === ClassID.Shader, `${fixture}: no Shader ${pathId}`);
  return reader.read<Shader>();
}

/** Whether any stage of the shader lists variants in `m_PlayerSubPrograms`. */
function hasPlayers(shader: Shader): boolean {
  return shader.m_ParsedForm.m_SubShaders.some((sub) =>
    sub.m_Passes.some((pass) =>
      [pass.progVertex, pass.progFragment, pass.progGeometry, pass.progHull, pass.progDomain, pass.progRayTracing].some(
        (program) => program?.m_PlayerSubPrograms?.some((group) => group.length > 0),
      ),
    ),
  );
}

/** The 6000.3.26f1 shader `name` (by its text size) of a platform bundle. */
function modern(platform: string, main: boolean): Shader {
  const fixture = `editor/6000.3.26f1/shader/lz4/${platform}`;
  const s = SHADERS.find((x) => x.fixture === fixture && (main ? !x.entry.shader : !!x.entry.shader))!;
  return readShader(s.fixture, s.file, s.pathId);
}

test("exactly the Shaders with variants in m_PlayerSubPrograms have the composite oracle", () => {
  let composite = 0;
  for (const s of SHADERS) {
    const players = hasPlayers(readShader(s.fixture, s.file, s.pathId));
    assert.equal(!!s.entry.oracle?.startsWith("composite (plan section 5, revision 2026-11-08a)"), players, s.fixture);
    if (players) composite++;
  }
  // Every 6000.3.26f1 and 6000.6.4f1 Shader; none of 2019.4 or 2020.3.
  assert.equal(composite, 16);
});

test("Unity 6 GLES, Vulkan and Metal programs: one SubProgram per blob index and type, no hw_tier", () => {
  const android = shaderToText(modern("android", false));
  assert.deepEqual(android.match(/^SubProgram ".*$/gm), ['SubProgram "gles3 " {', 'SubProgram "vulkan " {']);
  assert.match(android, /\n#ifdef VERTEX\n#version 300 es\n/);
  assert.match(android, /\n; SPIR-V\n; Version: 1\.0\n/);
  assert.doesNotMatch(android, /hw_tier|disassembly error/);
  const ios = shaderToText(modern("ios", false));
  assert.deepEqual(ios.match(/^SubProgram ".*$/gm), ['SubProgram "metal " {', 'SubProgram "metal " {']);
  assert.match(ios, /\n#include <metal_stdlib>\n/);
});

test("variants repeated across m_PlayerSubPrograms' groups are written once, where they first appear", () => {
  // UAR/ShaderFixture's first pass: three equal groups (and an empty one) of
  // blobs 4 to 7, each GLES 3 (4) and SPIR-V (25). Its Int property, which
  // AssetStudio fails on, made a Float here to reach the programs.
  const shader = modern("android", true);
  for (const prop of shader.m_ParsedForm.m_PropInfo.m_Props) if (prop.m_Type === 5) prop.m_Type = 2;
  const groups = shader.m_ParsedForm.m_SubShaders[0]!.m_Passes[0]!.progVertex.m_PlayerSubPrograms!;
  assert.deepEqual(groups.map((g) => g.length), [8, 8, 8, 0]);
  const vp = shaderToText(shader).split('Program "vp" {\n')[1]!.split('\n}\n}\n')[0]!;
  const headers = vp.match(/^SubProgram ".*$/gm)!;
  assert.deepEqual(headers, Array(4).fill(['SubProgram "gles3 " {', 'SubProgram "vulkan " {']).flat());
  // Blobs 4 to 7 in order, each entry's own keywords (none for blob 4).
  const firsts = vp.split(/^SubProgram ".*\n/m).slice(1).map((block) => block.split("\n")[0]!);
  const expected = [
    undefined,
    'Keywords { "INSTANCING_ON" }',
    'Keywords { "UAR_MULTI_A" }',
    'Keywords { "INSTANCING_ON" "UAR_MULTI_A" }',
  ].flatMap((k) => [k, k]);
  assert.deepEqual(
    firsts.map((line) => (line.startsWith("Keywords") ? line : undefined)),
    expected,
  );
});

test("duplicating a group or reordering groups' repeats does not change the text", () => {
  const s = SHADERS.find((x) => x.fixture === "editor/6000.3.26f1/shader/lz4/android" && x.entry.shader)!;
  const shader = readShader(s.fixture, s.file, s.pathId);
  const program = shader.m_ParsedForm.m_SubShaders[0]!.m_Passes[0]!.progVertex;
  program.m_PlayerSubPrograms!.push([...program.m_PlayerSubPrograms![0]!].reverse());
  const bytes = new TextEncoder().encode(shaderToText(shader));
  assert.equal(sha256(bytes), s.entry.shader!.sha256);
});

test("the blob's parameter entries (m_ParameterBlobIndices) are not read as programs", () => {
  const shader = modern("android", true);
  const program = shader.m_ParsedForm.m_SubShaders[0]!.m_Passes[0]!.progVertex;
  const parameters = new Set(program.m_ParameterBlobIndices!.flat());
  assert.deepEqual([...parameters].sort(), [0, 1, 2, 3]);
  const programs = readPrograms(shader);
  for (const platform of programs) {
    for (const index of parameters) assert.equal(platform[index], undefined);
  }
  // Each referenced entry of the platform that runs its type is read: GLES 3 on
  // platform 0 (GLES3x), SPIR-V on platform 1 (Vulkan).
  assert.deepEqual([4, 5, 6, 7].map((i) => programs[0]![i]?.type), [4, 4, 4, 4]);
  assert.deepEqual([4, 5, 6, 7].map((i) => programs[1]![i]?.type), [25, 25, 25, 25]);
});
