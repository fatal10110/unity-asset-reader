// The composite oracle on a stage with several variants (#283): UAR/ShaderVariants
// is the #237 fixture shader with no Int property and a multi_compile of two
// keywords (fixtures/BUILDING.md section 18), so c37af7d's converter writes its
// text and the layout rule of revision 2026-11-08a (plan section 5: each
// distinct blob index and program type of m_PlayerSubPrograms, its groups in
// order, where it first appears) is checked byte for byte against the oracle,
// not only by the unit tests in player.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClassID, load, type SerializedProgram, type Shader } from "unity-asset-reader";

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

function readShader(fixture: string, file: string, pathId: bigint): Shader {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const reader = env.objects.find((o) => o.fileName === file && o.pathId === pathId);
  assert.ok(reader && reader.type === ClassID.Shader, `${fixture}: no Shader ${pathId}`);
  return reader.read<Shader>();
}

/** Every Shader of the shader-variants bundles, with its golden. */
const VARIANTS = Object.entries(goldens.fixtures)
  .filter(([fixture]) => fixture.includes("/shader-variants/"))
  .flatMap(([fixture, files]) =>
    Object.entries(files).flatMap(([file, objects]) =>
      Object.entries(objects)
        .filter(([, entry]) => entry.class === "Shader")
        .map(([pathId, entry]) => {
          const shader = readShader(fixture, file, BigInt(pathId));
          return { fixture, pathId, entry, shader, name: shader.m_ParsedForm.m_Name };
        }),
    ),
  );

const COMPOSITE = /^composite \(plan section 5, revision 2026-11-08a\)/;

test("the shader-variants bundles' six Shaders all have the composite oracle's text", () => {
  assert.deepEqual(
    VARIANTS.map((s) => `${s.fixture} ${s.name}`).sort(),
    [
      "editor/6000.3.26f1/shader-variants/lz4/android",
      "editor/6000.3.26f1/shader-variants/lz4/ios",
      "editor/6000.6.4f1/shader-variants/lz4/android",
    ].flatMap((f) => [`${f} UAR/ShaderVariants`, `${f} UAR/ShaderVariantsSecond`]),
  );
  for (const s of VARIANTS) {
    assert.ok(s.entry.shader, `${s.fixture} ${s.name}: ${s.entry.exportError}`);
    assert.match(s.entry.oracle ?? "", COMPOSITE, s.fixture);
  }
});

/** The keyword names of a SubProgram block's `Keywords` line, sorted. */
const keywordsOf = (block: string): string => {
  const line = block.split("\n").find((l) => l.startsWith("Keywords {")) ?? "";
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort().join(" ");
};

for (const s of VARIANTS.filter((v) => v.name === "UAR/ShaderVariants")) {
  test(`${s.fixture}: stages with several blob indices and keyword variants match the composite golden byte for byte`, () => {
    const text = shaderToText(s.shader);
    const bytes = new TextEncoder().encode(text);
    assert.equal(bytes.length, s.entry.shader!.size);
    assert.equal(sha256(bytes), s.entry.shader!.sha256);

    // The first pass: Android lists GLES 3 and SPIR-V in its vertex stage,
    // iOS Metal vertex and fragment programs in theirs.
    const pass = s.shader.m_ParsedForm.m_SubShaders[0]!.m_Passes[0]!;
    const stages: [string, SerializedProgram][] = [
      ["vp", pass.progVertex],
      ["fp", pass.progFragment],
    ];
    let checked = 0;
    for (const [label, program] of stages) {
      const groups = program.m_PlayerSubPrograms ?? [];
      if (!groups.some((g) => g.length > 0)) continue;
      checked++;
      // Several non-empty groups repeat the same variants: they are written once.
      assert.ok(groups.filter((g) => g.length > 0).length > 1, `${label}: one group only`);
      const distinct = [...new Set(groups.flat().map((p) => `${p.m_BlobIndex}/${p.m_GpuProgramType}`))];
      const types = new Set(groups.flat().map((p) => p.m_GpuProgramType));
      // Per program type: 3 multi_compile states x instancing off and on.
      assert.equal(distinct.length, 6 * types.size, label);
      const block = text.split(`Program "${label}" {\n`)[1]!.split("\n}\n}\n")[0]!;
      const subPrograms = block.split(/^SubProgram ".*\n/m).slice(1);
      assert.equal(subPrograms.length, distinct.length, label);
      assert.deepEqual(
        [...new Set(subPrograms.map(keywordsOf))].sort(),
        [
          "",
          "INSTANCING_ON",
          "INSTANCING_ON UAR_MULTI_A",
          "INSTANCING_ON UAR_MULTI_B",
          "UAR_MULTI_A",
          "UAR_MULTI_B",
        ],
        label,
      );
    }
    assert.ok(checked > 0, "no stage with variants");
  });
}
