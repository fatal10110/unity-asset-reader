import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClassID, load, TextureFormat, type Texture2DData } from "unity-asset-reader";
import {
  golden,
  loadFixture,
  reverseRows,
  sha256,
  type GoldenTexture,
} from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";

// The signed EAC bundles of fixtures/BUILDING.md section 21 (#288): an editor
// script hands etc2comp's blocks to a Texture2D in EAC_R_SIGNED / EAC_RG_SIGNED,
// which the importer never produces. Without a built WASM the decode tests skip,
// as in decode.test.ts.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

/** A test that needs the decoder, skipped without it. */
const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

/**
 * sha256 of the image data etc2comp `EtcTool` wrote for section 21's 32x16
 * image (`-format SIGNED_R11` / `SIGNED_RG11 -effort 100`, the KTX's level 0):
 * the encoder's output, not this library's.
 */
const ETC2COMP_PAYLOAD: Record<number, string> = {
  [TextureFormat.EAC_R_SIGNED]: "456a042fdde523e151d46a2850f22c9d4dd2c0b25eb8afcd63218cf4c24e8a49",
  [TextureFormat.EAC_RG_SIGNED]: "7b7394deb2cd415e347c0af39506286b789f50d7047b03fbe8bdcd7f7fd5cd2b",
};

/** UnityPy 1.25.3 goldens (goldens.json); 6000.6 is in modern-goldens.json (UnityPy 1.25.4). */
const FIXTURES = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1"].map(
  (v) => `editor/${v}/signed-eac/android`,
);
const MODERN = "editor/6000.6.4f1/signed-eac/android";

const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"));
type Serialized = Record<string, { textures?: Record<string, GoldenTexture> }>;
const modernGoldens = fixtureJson("modern-goldens.json") as {
  fixtures: Record<string, { serialized: Serialized }>;
};
const exportGoldens = fixtureJson("assetstudio-export-goldens.json") as {
  fixtures: Record<string, Record<string, Record<string, { png?: { rgbaSha256: string } }>>>;
};

interface SignedTexture {
  fixture: string;
  file: string;
  pathId: string;
  input: Texture2DData;
  golden: GoldenTexture;
}

/** Every Texture2D of `fixture`, as `obj.read()` returns it, with its UnityPy golden. */
function textures(fixture: string): SignedTexture[] {
  const serialized =
    fixture === MODERN ? modernGoldens.fixtures[fixture]!.serialized : golden(fixture).serialized!;
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  return env.objects
    .filter((obj) => obj.type === ClassID.Texture2D)
    .map((obj) => {
      const pathId = String(obj.pathId);
      const g = serialized[obj.fileName]?.textures?.[pathId];
      assert.ok(g, `${fixture}: no texture golden for ${pathId}`);
      return { fixture, file: obj.fileName, pathId, input: obj.read<Texture2DData>(), golden: g };
    });
}

const ALL = [...FIXTURES, MODERN].flatMap(textures);

test("each signed EAC bundle holds EAC_R_SIGNED and EAC_RG_SIGNED, 32x16, no mips", () => {
  for (const fixture of [...FIXTURES, MODERN]) {
    const own = ALL.filter((t) => t.fixture === fixture);
    assert.deepEqual(
      own.map((t) => t.input.m_TextureFormat).sort((a, b) => a - b),
      [TextureFormat.EAC_R_SIGNED, TextureFormat.EAC_RG_SIGNED],
      fixture,
    );
    for (const t of own) {
      assert.deepEqual([t.input.m_Width, t.input.m_Height, t.input.m_MipCount], [32, 16, 1]);
      assert.equal(t.golden.format, t.input.m_TextureFormat, fixture);
    }
  }
});

test("the image data is etc2comp's payload, byte for byte, in every editor", () => {
  for (const t of ALL) {
    const where = `${t.fixture} ${t.golden.name}`;
    const want = ETC2COMP_PAYLOAD[t.input.m_TextureFormat];
    // 8 bytes per 4x4 block for R11, 16 for RG11.
    const bytes = t.input.m_TextureFormat === TextureFormat.EAC_R_SIGNED ? 8 : 16;
    assert.equal(t.input.imageData.length, (32 / 4) * (16 / 4) * bytes, where);
    assert.equal(sha256(t.input.imageData), want, where);
    assert.equal(t.golden.imageSha256, want, where);
  }
});

wasmTest("decodeTexture2D = UnityPy's RGBA (rows in Unity's stored order)", async () => {
  for (const t of ALL) {
    const where = `${t.fixture} ${t.golden.name}`;
    assert.ok(t.golden.rgbaSha256, where);
    assert.equal(t.golden.oracleNote, undefined, where);
    const out = await decodeTexture2D(t.input);
    assert.equal(sha256(reverseRows(out.data, out.width)), t.golden.rgbaSha256, where);
  }
});

wasmTest("decodeTexture2D = AssetStudio's ExportTexture2D PNG pixels (top row first)", async () => {
  // c37af7d cannot read the 6000.6 bundle (SerializedFile format 23).
  const exported = ALL.filter((t) => t.fixture !== MODERN);
  assert.equal(exported.length, 6);
  for (const t of exported) {
    const where = `${t.fixture} ${t.golden.name}`;
    const png = exportGoldens.fixtures[t.fixture]?.[t.file]?.[t.pathId]?.png;
    assert.ok(png, `${where}: no AssetStudio PNG`);
    const out = await decodeTexture2D(t.input);
    assert.equal(sha256(out.data), png.rgbaSha256, where);
  }
});
