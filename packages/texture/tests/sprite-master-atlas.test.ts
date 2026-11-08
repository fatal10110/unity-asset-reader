// decodeSprite's preferMasterAtlas (#294): a variant-atlas Sprite cut from the
// atlas AssetStudio's AssetsManager moves it to, compared with AssetStudio's
// executed ExportSprite PNG. The goldens come from scripts/make-export-goldens.py
// (fixtures/BUILDING.md section 17), never from this package (R12).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClassID, load, type Env, type SpriteAtlas } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { initTexture } from "../src/decode.js";
import { decodeSprite, locateSprite } from "../src/sprite.js";

// Same rule as sprite-export.test.ts: the comparison needs the WASM decoder.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the master atlas tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

interface ExportEntry {
  class: string;
  input: { name: string };
  png?: { width: number; height: number; rgbaSha256: string };
  variantAtlas?: string;
  verdict?: string;
}

const FIXTURE = "editor/2019.4.41f2/variant/sprites";
const goldens = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url),
    "utf8",
  ),
) as { fixtures: Record<string, Record<string, Record<string, ExportEntry>>> };

const env = load([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
const variant = Object.entries(goldens.fixtures[FIXTURE] ?? {}).flatMap(([file, objects]) =>
  Object.entries(objects)
    .filter(([, e]) => e.class === "Sprite" && e.variantAtlas && e.png)
    .map(([pathId, entry]) => {
      const obj = env.objects.find(
        (o) => o.fileName === file && o.pathId === BigInt(pathId) && o.type === ClassID.Sprite,
      );
      assert.ok(obj, `${FIXTURE} ${file} ${pathId}: not in the fixture`);
      return { obj, entry, png: entry.png! };
    }),
);

test("the fixture's variant-atlas Sprites are r_a and r_b", () => {
  assert.deepEqual(variant.map((s) => s.entry.input.name).sort(), ["r_a", "r_b"]);
});

test(
  "preferMasterAtlas cuts a variant-atlas Sprite as AssetStudio's ExportSprite does",
  { skip },
  async () => {
    for (const { obj, entry, png } of variant) {
      const what = entry.input.name;
      assert.equal(locateSprite(obj, env).atlas?.m_IsVariant, true, what);
      const master = locateSprite(obj, env, true).atlas;
      assert.equal(master?.m_IsVariant, false, what);
      const out = await decodeSprite(obj, env, { tightMesh: true, preferMasterAtlas: true });
      assert.equal(out.width, png.width, what);
      assert.equal(out.height, png.height, what);
      assert.equal(sha256(out.data), png.rgbaSha256, what);
    }
  },
);

test(
  "without preferMasterAtlas the variant is cut, as the recorded verdict says",
  { skip },
  async () => {
    for (const { obj, entry, png } of variant) {
      const what = entry.input.name;
      assert.match(entry.verdict ?? "", /master atlas.*cuts the variant.*\(#153\)/, what);
      for (const options of [{ tightMesh: true }, { tightMesh: true, preferMasterAtlas: false }]) {
        const out = await decodeSprite(obj, env, options);
        assert.notEqual(sha256(out.data), png.rgbaSha256, what);
      }
    }
  },
);

test(
  "a variant whose master atlas is not loaded keeps the variant with preferMasterAtlas",
  { skip },
  async () => {
    // The fixture is one CAB, so its variant cannot be loaded without its master:
    // an Env that leaves the master atlases out of `objects` stands in for that.
    const masters = new Set(
      env.objects.filter(
        (o) => o.type === ClassID.SpriteAtlas && !o.read<SpriteAtlas>().m_IsVariant,
      ),
    );
    assert.ok(masters.size > 0);
    const alone: Env = Object.create(env, {
      objects: { value: env.objects.filter((o) => !masters.has(o)) },
    });
    for (const { obj, entry } of variant) {
      const what = entry.input.name;
      assert.equal(locateSprite(obj, alone, true).atlas?.m_IsVariant, true, what);
      const own = await decodeSprite(obj, alone, { tightMesh: true });
      const out = await decodeSprite(obj, alone, { tightMesh: true, preferMasterAtlas: true });
      assert.equal(sha256(out.data), sha256(own.data), what);
    }
  },
);
