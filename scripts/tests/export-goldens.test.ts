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
  class:
    | "Texture2D"
    | "Mesh"
    | "AudioClip"
    | "TextAsset"
    | "Shader"
    | "Sprite"
    | "Font"
    | "VideoClip"
    | "AnimationClip";
  input: Record<string, string | number>;
  inputOracle: string;
  png?: { width: number; height: number; rgbaSha256: string };
  obj?: { size: number; sha256: string };
  wav?: { size: number; sha256: string };
  bytes?: { size: number; sha256: string };
  shader?: { size: number; sha256: string };
  font?: { size: number; sha256: string; extension: string };
  video?: { size: number; sha256: string; extension: string };
  anim?: { size: number; sha256: string; curves: Record<string, unknown[]>; events: unknown[] };
  exportError?: string;
  objWithoutBaseVertex?: { size: number; sha256: string };
  alphaTexture?: string;
  variantAtlas?: string;
  unreadObjects?: Record<string, number>;
  verdict?: string;
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
  74: "AnimationClip",
  83: "AudioClip",
  128: "Font",
  213: "Sprite",
  329: "VideoClip",
};
const OUTPUT = {
  Texture2D: "png",
  Mesh: "obj",
  AudioClip: "wav",
  TextAsset: "bytes",
  Shader: "shader",
  Sprite: "png",
  Font: "font",
  VideoClip: "video",
  AnimationClip: "anim",
} as const;

/**
 * Every Texture2D, Mesh, Shader, TextAsset, AnimationClip, AudioClip, Sprite, Font and VideoClip
 * the UnityPy goldens list, with its export entry.
 */
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

test("every exported class's fixture objects have an entry, and nothing else", () => {
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
    if ((o.cls === "AudioClip" || o.cls === "Font" || o.cls === "VideoClip") && raw) {
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
    const kinds = ["png", "obj", "wav", "bytes", "shader", "font", "video", "anim"] as const;
    const outputs = kinds.filter((k) => e[k]);
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
    if (o.cls === "Shader") {
      // Not run for Direct3D programs (host-dependent text). A 6000.x Shader
      // gets the composite oracle (#259), c37af7d's converter, which has no case
      // for UAR/ShaderFixture's Int property.
      assert.match(
        exportError!,
        o.fixture.endsWith("/windows")
          ? /^not exported: its D3D11 programs need Windows' D3DCompiler or HLSLDecompiler/
          : /^ShaderConverter\.ConvertSerializedShader throws ArgumentOutOfRangeException: /,
        where,
      );
      assert.ok(o.fixture.includes("/6000.") || o.fixture.endsWith("/windows"), where);
    } else if (o.cls === "AnimationClip") {
      // c37af7d reads 6000.6's (format 23) clips without type trees, but without
      // GenericBinding's metaData (6000.5), so their bindings come out misread and
      // Convert() throws on them; with type trees it cannot load the file at all.
      assert.equal(o.source, "modern-goldens.json", where);
      assert.match(
        exportError!,
        /^(AssetStudio did not load the object: |ArgumentException: )/,
        where,
      );
    } else if (o.source === "modern-goldens.json") {
      // c37af7d cannot read SerializedFile format 23's (6000.6) type trees.
      assert.match(exportError!, /^AssetStudio did not load the object: /, where);
    } else if (o.cls === "Mesh") {
      // fixtures/BUILDING.md section 20: ExportMesh leaves out the submesh's
      // baseVertex (#257); the OBJ it wrote is kept beside the verdict.
      assert.equal(input.name, "basevertex", where);
      assert.equal(
        exportError,
        "not exported: ExportMesh leaves out the submesh's baseVertex 3, which " +
          "unity-asset-reader adds to the indices (#257)",
        where,
      );
      assert.ok(o.entry!.objWithoutBaseVertex, where);
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
  assert.equal(
    exported("Mesh"),
    43,
    "main's triangle; detail, compressed, skinned and skinned-compressed of the mesh bundles; " +
      "the scene bundles' skinned mesh (#305) and the legacy-animation bundles' quad (#314), " +
      "but 6000.6.4f1's typed ones",
  );
  assert.equal(
    exported("AudioClip"),
    51,
    "both clips of every audio and adpcm bundle, the five of every audiohdr bundle",
  );
  assert.equal(exported("TextAsset"), 32);
  // Both shaders of the 2019.4 and 2020.3 Android and iOS bundles; the composite's
  // UAR/ShaderFixtureSecond of the 6000.3 Android and iOS and 6000.6 Android ones (#259),
  // and both shaders of the shader-variants bundles of the same three (#283).
  assert.equal(exported("Shader"), 23);
  // And the animation bundles' two textures (#302) of 2019.4, 2020.3 and 6000.3.26f1, typed
  // and not, and of 6000.6.4f1 without type trees: c37af7d fails on format 23's type trees,
  // and reads a format-23 file without them. And the nine of each mips bundle pair (#331) of
  // 2019.4, 2020.3 and 6000.3.26f1.
  assert.equal(exported("Texture2D"), 146);
  assert.equal(
    exported("Sprite"),
    124,
    "every 2019.4.41f2 and 6000.3.25f1 fixture Sprite, and the animation bundles' two (#302) of " +
      "2019.4, 2020.3 and 6000.3.26f1",
  );
  assert.equal(exported("Font"), 9, "the font bundles of 2019.4, 2020.3 and 6000.3");
  assert.equal(exported("VideoClip"), 9, "the video bundles of 2019.4, 2020.3 and 6000.3");
  assert.equal(
    exported("AnimationClip"),
    125,
    "the 17 clips of the animation, animator and scene bundles, the 2 of the legacy-animation " +
      "bundles (#314) and the 1 of the ui-animation bundles (#315) of 2019.4, 2020.3 and 6000.3, typed and not (#304), and 6000.6.4f1's legacy and dense clips without type trees, " +
      "whose bindings c37af7d misreads harmlessly (none, or one Transform binding); the " +
      "humanoid bundles' pose clip of the same three editors (#318)",
  );
});

test("a verdict sits next to a Sprite golden exactly where decodeSprite differs by design", () => {
  // fixtures/BUILDING.md section 17: GetImage() ignores an ETC1 split alpha
  // texture (decodeSprite merges it, #152), and AssetsManager moves a sprite
  // off its variant atlas (decodeSprite cuts the variant, #153).
  const verdicts = all.filter((o) => o.entry!.verdict && o.cls !== "AnimationClip");
  for (const o of verdicts) {
    const e = o.entry!;
    assert.equal(o.cls, "Sprite", at(o));
    assert.ok(e.png, at(o));
    assert.equal(/\(#152\)/.test(e.verdict!), e.alphaTexture !== undefined, at(o));
    assert.equal(/\(#153\)/.test(e.verdict!), e.variantAtlas !== undefined, at(o));
  }
  const count = (field: "alphaTexture" | "variantAtlas") =>
    all.filter((o) => o.entry![field] !== undefined).length;
  assert.equal(count("alphaTexture"), 17, "the split-alpha bundle's sprites on its ETC1 atlas");
  assert.equal(count("variantAtlas"), 2, "r_a and r_b of the variant bundle");
  assert.equal(verdicts.length, 19);
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

test("the font and the video clip export back to the files they were imported from", () => {
  // glyphs.ttf and clip.webm, fixtures/BUILDING.md section 11: ExportFont writes
  // m_FontData as is, ExportVideoClip the clip's .resource bytes, an oracle check
  // that needs no AssetStudio.
  const sources = {
    Font: {
      size: 672,
      sha256: "f69124a81f4347a08c2d0f68bd970fb755d7d6dda8003976b51ad8274e8045ab",
      extension: ".ttf",
    },
    VideoClip: {
      size: 4860,
      sha256: "3772a3e4275b99ebeecba8d52b90cc9192cce137af06c6889459107b460e7459",
      extension: ".webm",
    },
  } as const;
  for (const cls of ["Font", "VideoClip"] as const) {
    const objs = all.filter((o) => o.cls === cls);
    assert.equal(objs.length, 9, cls);
    for (const o of objs) {
      assert.deepEqual(o.entry![OUTPUT[cls]], sources[cls], at(o));
    }
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

test("an AnimationClip golden has a verdict exactly where AssetStudio missed its renderer", () => {
  // fixtures/BUILDING.md section 17 (#304): c37af7d's Renderer reader fails on
  // Unity 6000's SkinnedMeshRenderer, so its blend shape attributes stay CRC-32s.
  const clips = all.filter((o) => o.cls === "AnimationClip" && o.entry!.anim);
  const withVerdict = clips.filter(
    (o) => o.entry!.verdict && !o.entry!.verdict.startsWith("c37af7d's Animator reader"),
  );
  for (const o of withVerdict) {
    assert.match(o.entry!.verdict!, /^c37af7d's Renderer reader fails on this file's/, at(o));
    assert.ok(o.entry!.unreadObjects?.SkinnedMeshRenderer, at(o));
    assert.equal(o.fixture.split("/")[1], "6000.3.26f1", at(o));
  }
  assert.deepEqual(
    withVerdict.map((o) => o.entry!.input.name),
    ["walk", "walk", "smile", "smile"],
    "the 6000.3.26f1 legacy-animation (#314) and scene bundles' blend shape clips, typed and not",
  );
  // A clip nothing plays keeps path_<hash> and CRC-32 attributes with the
  // renderer too, so it gets no verdict though the renderer was not read (#314).
  const unlisted = clips.filter((o) => o.entry!.input.name === "unlisted");
  assert.equal(unlisted.length, 6);
  for (const o of unlisted) {
    assert.equal(o.entry!.verdict, undefined, at(o));
    const float = o.entry!.anim!.curves.float;
    assert.ok(float.every((c) => /^path_\d+$/.test(c.path)), at(o));
    if (o.fixture.includes("/6000.3.")) assert.ok(o.entry!.unreadObjects?.SkinnedMeshRenderer, at(o));
  }
});

test("an AnimationClip golden has the Animator verdict exactly where AssetStudio named no path", () => {
  // fixtures/BUILDING.md section 26 (#315): c37af7d reads Unity 2023.1+'s
  // m_AnimatePhysics as m_HasTransformHierarchy, so an Animator without an
  // Avatar names none of its clip's paths.
  const clips = all.filter((o) => o.cls === "AnimationClip" && o.entry!.anim);
  const withVerdict = clips.filter((o) => o.entry!.verdict?.startsWith("c37af7d's Animator reader"));
  assert.deepEqual(
    withVerdict.map((o) => o.fixture),
    [
      "editor/6000.3.26f1/ui-animation/lz4-notypetree/ui-animation",
      "editor/6000.3.26f1/ui-animation/lz4/ui-animation",
    ],
    "the 6000.3.26f1 ui-animation bundles' clip, typed and not",
  );
  for (const o of withVerdict) {
    const paths = Object.values(o.entry!.anim!.curves).flatMap((list) => list.map((c) => c.path));
    assert.ok(paths.every((p) => /^path_\d+$/.test(p)), at(o));
  }
});
