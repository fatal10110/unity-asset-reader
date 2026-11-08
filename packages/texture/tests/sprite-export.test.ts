// Every fixture Sprite against AssetStudio's executed ExportSprite (#275): the
// PNG `Sprite.GetImage()` writes, which is `decodeSprite(..., { tightMesh: true })`.
// The goldens come from scripts/make-export-goldens.py (fixtures/BUILDING.md
// section 17), never from this package (R12).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClassID,
  load,
  type Sprite,
  type SpriteAtlas,
  type Texture2DData,
} from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { cutSprite, decodeSprite, locateSprite } from "../src/sprite.js";

// Same rule as png.test.ts: the comparison needs the WASM decoder, which only
// the CI job that builds it has; REQUIRE_WASM=1 there turns a missing build
// into a failure.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the Sprite export tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

interface ExportEntry {
  class: string;
  input: { name: string };
  png?: { width: number; height: number; rgbaSha256: string };
  exportError?: string;
  alphaTexture?: string;
  variantAtlas?: string;
  verdict?: string;
}

const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"));
const exportGoldens = fixtureJson("assetstudio-export-goldens.json") as {
  methods: Record<string, string>;
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
};
const modernGoldens = fixtureJson("modern-goldens.json") as {
  fixtures: Record<string, { serialized: Record<string, { formatVersion: number }> }>;
};

const sprites = Object.entries(exportGoldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Sprite")
      .map(([pathId, entry]) => ({ fixture, file, pathId, entry })),
  ),
);
const exported = sprites.filter((s) => s.entry.png);
const plain = exported.filter((s) => !s.entry.alphaTexture && !s.entry.variantAtlas);
const splitAlpha = exported.filter((s) => s.entry.alphaTexture);
const variant = exported.filter((s) => s.entry.variantAtlas);

const envs = new Map<string, ReturnType<typeof load>>();
/** The fixture's Env (loaded once) and the Sprite's ObjectReader in it. */
function sprite({ fixture, file, pathId }: (typeof sprites)[number]) {
  let env = envs.get(fixture);
  if (!env) envs.set(fixture, (env = load([{ name: fixture, data: loadFixture(fixture) }])));
  const obj = env.objects.find(
    (o) => o.fileName === file && o.pathId === BigInt(pathId) && o.type === ClassID.Sprite,
  );
  assert.ok(obj, `${fixture} ${file} ${pathId}: not in the fixture`);
  return { env, obj };
}

const where = (s: (typeof sprites)[number]) =>
  `${s.fixture} ${s.file} ${s.pathId} (${s.entry.input.name})`;

test("the export goldens hold AssetStudio's ExportSprite PNGs", () => {
  assert.match(exportGoldens.methods.Sprite!, /^AssetStudio\.CLI\.Exporter\.ExportSprite\(/);
  // Every 2019.4.41f2 and 6000.3.25f1 fixture Sprite, 17 of them split alpha, and the
  // animation bundles' two of 2019.4, 2020.3 and 6000.3.26f1, typed and not (#302).
  assert.equal(exported.length, 124);
  assert.equal(splitAlpha.length, 17);
  for (const s of splitAlpha) assert.equal(s.fixture, "editor/2019.4.41f2/split-alpha/sprites");
  assert.deepEqual(variant.map((s) => [s.fixture, s.entry.input.name, s.entry.variantAtlas]), [
    ["editor/2019.4.41f2/variant/sprites", "r_a", "half"],
    ["editor/2019.4.41f2/variant/sprites", "r_b", "half"],
  ]);
  assert.equal(plain.length, 124 - 17 - 2);
});

test(
  "decodeSprite with tightMesh of every fixture Sprite AssetStudio exports is its PNG",
  { skip },
  async () => {
    const decodedTextures = new Map();
    for (const s of plain) {
      const { env, obj } = sprite(s);
      // The verdicts below are for these alone: no alpha texture, no variant atlas.
      const source = locateSprite(obj, env);
      assert.equal(source.alphaTexture, undefined, where(s));
      assert.notEqual(source.atlas?.m_IsVariant, true, where(s));
      const out = await decodeSprite(obj, env, { tightMesh: true, decodedTextures });
      assert.equal(out.width, s.entry.png!.width, where(s));
      assert.equal(out.height, s.entry.png!.height, where(s));
      assert.equal(sha256(out.data), s.entry.png!.rgbaSha256, where(s));
    }
  },
);

test(
  "a split-alpha Sprite's PNG is cutSprite of its base texture; decodeSprite merges the alpha",
  { skip },
  async () => {
    const alphaDiffers = new Set<string>();
    for (const s of splitAlpha) {
      const { env, obj } = sprite(s);
      // The verdict the script records next to the golden: GetImage() never
      // reads the alpha texture, decodeSprite merges it (#152).
      const verdict = /never reads its alpha texture.*merges.*\(#152\)/;
      assert.match(s.entry.verdict ?? "", verdict, where(s));
      const source = locateSprite(obj, env);
      assert.ok(source.alphaTexture, where(s));
      assert.equal(source.alphaTexture.read<Texture2DData>().m_Name, s.entry.alphaTexture);
      const base = await decodeTexture2D(source.texture.read<Texture2DData>());
      const cut = cutSprite(base, source.sprite, source.rect, source.version, true);
      assert.equal(cut.width, s.entry.png!.width, where(s));
      assert.equal(cut.height, s.entry.png!.height, where(s));
      assert.equal(sha256(cut.data), s.entry.png!.rgbaSha256, where(s));

      // decodeSprite: the golden's red, green and blue with the alpha texture's
      // red as alpha (the same cut of it, unmasked). Outside the mask both are
      // cleared; inside, a Tight sprite's mask also clears a pixel whose alpha
      // is 0 altogether, as upstream's does.
      const alpha = await decodeTexture2D(source.alphaTexture.read<Texture2DData>());
      const alphaCut = cutSprite(alpha, source.sprite, source.rect, source.version, false);
      const merged = await decodeSprite(obj, env, { tightMesh: true });
      assert.equal(merged.data.length, cut.data.length, where(s));
      const tight = ((source.rect.settingsRaw >> 1) & 1) === 0;
      for (let i = 0; i < cut.data.length; i += 4) {
        const at = `${where(s)} pixel ${i / 4}`;
        const a = cut.data[i + 3] === 0 ? 0 : alphaCut.data[i]!;
        const cleared = cut.data[i + 3] === 0 || (tight && a === 0);
        const rgb = cleared ? [0, 0, 0] : cut.data.subarray(i, i + 3);
        assert.deepEqual([...merged.data.subarray(i, i + 4)], [...rgb, a], at);
        if (a !== cut.data[i + 3]) alphaDiffers.add(s.entry.input.name);
      }
    }
    // The verdict is not vacuous: the alpha texture changes the golden's pixels.
    assert.ok(alphaDiffers.size > 0);
  },
);

test(
  "a variant-atlas Sprite's PNG is cut from its master atlas; decodeSprite cuts the variant",
  { skip },
  async () => {
    for (const s of variant) {
      const { env, obj } = sprite(s);
      // The verdict the script records next to the golden: AssetsManager moves
      // the sprite to the master atlas, decodeSprite follows its own pointer (#153).
      assert.match(s.entry.verdict ?? "", /master atlas.*cuts the variant.*\(#153\)/, where(s));
      const own = locateSprite(obj, env);
      assert.equal(own.atlas?.m_IsVariant, true, where(s));
      assert.equal(own.atlas.m_Name, s.entry.variantAtlas, where(s));
      const out = await decodeSprite(obj, env, { tightMesh: true });
      assert.notEqual(sha256(out.data), s.entry.png!.rgbaSha256, where(s));

      // The master atlas packing the sprite, and its entry under the sprite's key.
      const [guid, id] = obj.read<Sprite>().m_RenderDataKey!;
      const masters = env.objects
        .filter((o) => o.type === ClassID.SpriteAtlas)
        .map((o) => o.read<SpriteAtlas>())
        .filter((a) => !a.m_IsVariant && a.m_PackedSprites!.some((p) => p.m_PathID === obj.pathId));
      assert.equal(masters.length, 1, where(s));
      const entry = masters[0]!.m_RenderDataMap.find(
        ([[g, i]]) => i === id && JSON.stringify(g) === JSON.stringify(guid),
      )?.[1];
      assert.ok(entry, where(s));
      const texture = env.objects.find(
        (o) => o.type === ClassID.Texture2D && o.pathId === entry.texture.m_PathID,
      );
      assert.ok(texture, where(s));
      const image = await decodeTexture2D(texture.read<Texture2DData>());
      const cut = cutSprite(image, own.sprite, entry, own.version, true);
      assert.equal(cut.width, s.entry.png!.width, where(s));
      assert.equal(cut.height, s.entry.png!.height, where(s));
      assert.equal(sha256(cut.data), s.entry.png!.rgbaSha256, where(s));
    }
  },
);

test("every fixture Sprite without an AssetStudio PNG has a known reason", () => {
  const reasons = new Map<string, number>();
  for (const s of sprites.filter((x) => !x.entry.png)) {
    const { exportError = "" } = s.entry;
    const at = `${where(s)}: ${exportError}`;
    let reason: string;
    if (/^AssetStudio did not load the object: /.test(exportError)) {
      // c37af7d cannot read SerializedFile format 23 (Unity 6000.6), per UnityPy's golden.
      assert.equal(modernGoldens.fixtures[s.fixture]?.serialized[s.file]?.formatVersion, 23, at);
      reason = "format 23";
    } else {
      assert.fail(`unknown reason: ${at}`);
    }
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  // Of them, 6000.6.4f1's animation bundles' four (#302).
  assert.deepEqual(Object.fromEntries(reasons), { "format 23": 19 });
  assert.equal(exported.length + 19, sprites.length);
});
