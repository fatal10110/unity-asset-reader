// The AssetStudio export goldens (#233) against the UnityPy goldens they were
// matched on. Nothing here runs AssetStudio: scripts/make-export-goldens.py
// does, outside the repo (R2). This proves the committed file covers every
// exportable fixture object, carries the input it was matched on, and names a
// reason wherever it has no golden.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reverseRows, sha256 } from "../../fixtures/helpers.js";

interface Entry {
  class: "Texture2D" | "Mesh" | "AudioClip" | "TextAsset" | "Shader";
  input: Record<string, string | number>;
  inputOracle: string;
  png?: { width: number; height: number; rgbaSha256: string };
  obj?: { size: number; sha256: string };
  wav?: { size: number; sha256: string };
  bytes?: { size: number; sha256: string };
  shader?: { size: number; sha256: string };
  exportError?: string;
}

interface UnityPyGolden {
  fixtures: Record<
    string,
    {
      objects?: Record<string, { pathId: string; classId: number; byteSize: number }[]>;
      serialized?: Record<
        string,
        {
          names: Record<string, string>;
          textures?: Record<string, Record<string, string | number>>;
          rawData?: Record<string, { size: number; sha256: string }>;
          typetrees?: Record<string, { value: Record<string, unknown> }>;
        }
      >;
    }
  >;
}

const json = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8")) as T;
const exports = json<{
  revision: string;
  _generator: string;
  fixtures: Record<string, Record<string, Record<string, Entry>>>;
}>("assetstudio-export-goldens.json");
const sources = {
  "goldens.json": json<UnityPyGolden>("goldens.json"),
  "modern-goldens.json": json<UnityPyGolden>("modern-goldens.json"),
};
const CLASSES: Record<number, Entry["class"]> = {
  28: "Texture2D",
  43: "Mesh",
  48: "Shader",
  49: "TextAsset",
  83: "AudioClip",
};
const OUTPUT = {
  Texture2D: "png",
  Mesh: "obj",
  AudioClip: "wav",
  TextAsset: "bytes",
  Shader: "shader",
} as const;

/** Every Texture2D, Mesh, Shader, TextAsset and AudioClip the UnityPy goldens list, with its export entry. */
function objects() {
  const out = [];
  for (const [source, golden] of Object.entries(sources)) {
    for (const [fixture, g] of Object.entries(golden.fixtures)) {
      for (const [file, table] of Object.entries(g.objects ?? {})) {
        const serialized = g.serialized![file]!;
        for (const row of table) {
          const cls = CLASSES[row.classId];
          if (!cls) continue;
          const entry = exports.fixtures[fixture]?.[file]?.[row.pathId];
          out.push({ source, fixture, file, row, cls, serialized, entry });
        }
      }
    }
  }
  return out;
}

const all = objects();
const at = (o: (typeof all)[number]) => `${o.fixture} ${o.file} ${o.row.pathId}`;

test("the export goldens come from AssetStudio c37af7d through the export harness", () => {
  assert.equal(exports.revision, "c37af7dfcdafee93e33b5da9f0285c97998d6ae3");
  assert.equal(exports._generator, "scripts/make-export-goldens.py");
});

test("every Texture2D, Mesh, Shader, TextAsset and AudioClip of the fixtures has an entry, and nothing else", () => {
  assert.ok(all.length > 0);
  for (const o of all) {
    assert.ok(o.entry, `${at(o)}: no export golden entry`);
    assert.equal(o.entry.class, o.cls, at(o));
  }
  const listed = Object.values(exports.fixtures)
    .flatMap((files) => Object.values(files))
    .flatMap((objs) => Object.keys(objs)).length;
  assert.equal(listed, all.length, "export goldens list objects the UnityPy goldens do not");
});

test("each entry carries the UnityPy input it was matched on", () => {
  for (const o of all) {
    const { input } = o.entry!;
    const where = at(o);
    assert.equal(input.classId, o.row.classId, where);
    assert.equal(input.byteSize, o.row.byteSize, where);
    assert.equal(input.name, o.serialized.names[o.row.pathId], where);
    const texture = o.serialized.textures?.[o.row.pathId];
    if (o.cls === "Texture2D" && texture) {
      for (const key of ["format", "width", "height", "imageSize", "imageSha256"]) {
        assert.equal(input[key], texture[key], `${where} ${key}`);
      }
    }
    const raw = o.serialized.rawData?.[o.row.pathId];
    if (o.cls === "AudioClip" && raw) {
      assert.equal(input.dataSize, raw.size, where);
      assert.equal(input.dataSha256, raw.sha256, where);
    }
    const dump = o.serialized.typetrees?.[o.row.pathId];
    if (o.cls === "TextAsset" && dump) {
      // make-goldens.py keeps m_Script as UnityPy decodes it, from UTF-8. Every
      // fixture TextAsset is valid UTF-8, so encoding it again gives its bytes.
      const script = Buffer.from(dump.value.m_Script as string, "utf8");
      assert.equal(input.scriptSize, script.length, where);
      assert.equal(input.scriptSha256, sha256(script), where);
    }
    assert.match(o.entry!.inputOracle, new RegExp(`^${o.source.replace(".", "\\.")}`), where);
  }
});

test("each entry holds its class's export or an exportError, never both", () => {
  for (const o of all) {
    const e = o.entry!;
    const outputs = (["png", "obj", "wav", "bytes", "shader"] as const).filter((k) => e[k]);
    if (e.exportError) assert.deepEqual(outputs, [], at(o));
    else assert.deepEqual(outputs, [OUTPUT[o.cls]], at(o));
  }
});

test("only the objects AssetStudio cannot export lack a golden, each for its known reason", () => {
  // Acceptance: a golden for every fixture object AssetStudio can export. A new
  // failure must fail here until it is understood, not become a quiet gap.
  for (const o of all.filter((x) => x.entry!.exportError)) {
    const { exportError, input } = o.entry!;
    const where = `${at(o)}: ${exportError}`;
    if (o.source === "modern-goldens.json") {
      // c37af7d cannot read SerializedFile format 23 (6000.6) at all.
      assert.match(exportError!, /^AssetStudio did not load the object: /, where);
    } else if (o.cls === "Shader") {
      // Not run for Direct3D programs (host-dependent text); c37af7d skips
      // parsing every 6000+ Shader, so ShaderConverter has no blob or script.
      assert.match(
        exportError!,
        o.fixture.includes("/6000.")
          ? /^ArgumentNullException: Value cannot be null\. \(Parameter 'bytes'\)$/
          : /^not exported: its D3D11 programs need Windows' D3DCompiler or HLSLDecompiler/,
        where,
      );
      assert.ok(o.fixture.includes("/6000.") || o.fixture.endsWith("/windows"), where);
    } else if (o.cls === "Texture2D" && !o.serialized.textures?.[o.row.pathId]) {
      // A dynamic font's 0x0 "Font Texture": no image data to export.
      assert.equal(exportError, "ExportTexture2D returned false", where);
    } else {
      // AssetStudio's TextureFormat enum inserts R16_Alt at 66, so from there
      // on it decodes the next format (Unity's RG32, 72, as ASTC_HDR_12x12).
      assert.equal(o.cls, "Texture2D", where);
      assert.ok(Number(input.format) >= 66, where);
      assert.match(exportError!, /^input mismatch: AssetStudio reads TextureFormat /, where);
    }
  }
  const exported = (cls: Entry["class"]) =>
    all.filter((o) => o.cls === cls && !o.entry!.exportError).length;
  assert.equal(exported("Mesh"), 12, "the one-triangle Mesh of every main bundle");
  assert.equal(exported("AudioClip"), 18, "both clips of every audio bundle");
  assert.equal(exported("TextAsset"), 28);
  assert.equal(exported("Shader"), 12, "both shaders of the 2019.4 and 2020.3 Android and iOS bundles");
  assert.equal(exported("Texture2D"), 97);
});

test("hello.txt exports back to the file it was imported from", () => {
  // fixtures/BUILDING.md section 1: ExportTextAsset writes m_Script as is, an
  // oracle check that needs no AssetStudio.
  const hello = all.filter((o) => o.cls === "TextAsset" && o.entry!.input.name === "hello");
  assert.equal(hello.length, 16);
  for (const o of hello) {
    assert.deepEqual(
      o.entry!.bytes,
      { size: 58, sha256: "3606049155e66b287de2e2ff7d5c19473df8c3f6ae817c2c67856ff74783ba06" },
      at(o),
    );
  }
});

test("the PCM clip exports back to the WAV it was imported from", () => {
  // tone.wav, fixtures/BUILDING.md section 11: AssetStudio's FMOD decode of a
  // PCM clip is that file to the byte, an oracle check that needs no AssetStudio.
  const pcm = all.filter((o) => o.cls === "AudioClip" && o.entry!.input.name === "tone-pcm");
  assert.equal(pcm.length, 9);
  for (const o of pcm) {
    assert.deepEqual(
      o.entry!.wav,
      { size: 11068, sha256: "8edec60ce5b7c3c12eaec3a6cece2e442b4b12f47c77cbc8857a2be8118c4fac" },
      at(o),
    );
  }
});

test("ExportTexture2D agrees with section 15's executed DecodeRG16", () => {
  // Two harnesses over the same AssetStudio revision: the method-level
  // reference (stored rows) turned top-down is the exported PNG's pixels.
  const reference = json<{ plain: Record<string, { rgbaHex: string; width: number; imageSha256: string }> }>(
    "assetstudio-fixture-cross-checks.json",
  ).plain.RG16!;
  const o = all.find((x) => x.entry!.input.imageSha256 === reference.imageSha256);
  assert.ok(o?.entry!.png, "no RG16 export golden");
  const topDown = reverseRows(Uint8Array.from(Buffer.from(reference.rgbaHex, "hex")), reference.width);
  assert.equal(o.entry!.png.rgbaSha256, sha256(topDown));
});
