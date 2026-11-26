// diffTexture (#352) on the two `diff` builds (fixtures/BUILDING.md section
// 30): v2 makes `changed.png` 64x32 RGB24 (was 32x32 RGBA32), repaints
// `repainted.png` at the same size, and leaves `same.png` as it was. The
// expected counts are taken by decoding each side here and comparing in the
// test, never from diffTexture's own output (R12).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { diff, load, type Asset, type DiffEntry, type Env } from "unity-asset-reader";
import { loadFixture } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { diffTexture } from "../src/index.js";

// Same rule as png.test.ts: decoding needs the WASM decoder, which only the CI
// job that builds it has; REQUIRE_WASM=1 there turns a missing build into a
// failure. The size and argument checks decode nothing and always run.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the texture diff tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

const DIR = "editor/2019.4.41f2/diff";
const DIRS = "assets/fixtures/diff/";

function build(version: string, bundles: string[]): Env {
  return load(bundles.map((name) => ({ name, data: loadFixture(`${DIR}/${version}/${name}`) })));
}

const v1 = build("v1", ["textures", "oldname"]);
const v2 = build("v2", ["textures", "newname"]);
const entries = diff(v1, v2);

function byPath(name: string): DiffEntry {
  const found = entries.find((e) => e.path === DIRS + name);
  assert.ok(found, `no entry for ${name}`);
  return found;
}

function texture(env: Env, name: string): Asset<"Texture2D"> {
  const asset = env.get(DIRS + name);
  assert.ok(asset?.type === "Texture2D", `no Texture2D ${name}`);
  return asset as Asset<"Texture2D">;
}

/** Pixels whose RGBA differs between the two sides' first mip level, counted here. */
async function changedIndices(a: Asset<"Texture2D">, b: Asset<"Texture2D">): Promise<number[]> {
  const x = (await decodeTexture2D(a.reader.read())).data;
  const y = (await decodeTexture2D(b.reader.read())).data;
  assert.equal(x.length, y.length);
  const changed: number[] = [];
  for (let p = 0; p < x.length / 4; p++) {
    if (!x.subarray(p * 4, p * 4 + 4).every((v, c) => v === y[p * 4 + c])) changed.push(p);
  }
  return changed;
}

test("a repainted texture reports its changed pixels, share and image", { skip }, async () => {
  const entry = byPath("repainted.png");
  const result = await diffTexture(entry);
  assert.equal(result.sizeChanged, false);
  if (result.sizeChanged) return;
  const expected = await changedIndices(entry.before as Asset<"Texture2D">,
    entry.after as Asset<"Texture2D">);
  assert.ok(expected.length > 0, "the fixture repaints at least one pixel");
  assert.equal(result.width, 16);
  assert.equal(result.height, 16);
  assert.equal(result.changedPixels, expected.length);
  assert.equal(result.changedShare, expected.length / 256);
  assert.ok(result.changedShare > 0);
  assert.equal(result.image.width, 16);
  assert.equal(result.image.height, 16);
  const marked = new Set(expected);
  for (let p = 0; p < 256; p++) {
    const want = marked.has(p) ? [255, 0, 0, 255] : [0, 0, 0, 0];
    assert.deepEqual([...result.image.data.subarray(p * 4, p * 4 + 4)], want, `pixel ${p}`);
  }
});

test("an unchanged texture compared across builds reports zero", { skip }, async () => {
  assert.ok(!entries.some((e) => e.path === `${DIRS}same.png`), "diff() does not list same.png");
  const result = await diffTexture(texture(v1, "same.png"), texture(v2, "same.png"));
  assert.equal(result.sizeChanged, false);
  if (result.sizeChanged) return;
  assert.equal(result.changedPixels, 0);
  assert.equal(result.changedShare, 0);
  assert.ok(result.image.data.every((v) => v === 0));
});

test("a size change is reported with both sizes and no comparison", async () => {
  // Runs without the WASM decoder too: nothing is decoded.
  const result = await diffTexture(byPath("changed.png"));
  assert.deepEqual(result, {
    sizeChanged: true,
    before: { width: 32, height: 32 },
    after: { width: 64, height: 32 },
  });
});

test("entries other than a modified Texture2D, and non-textures, are a TypeError", async () => {
  await assert.rejects(diffTexture(byPath("added.png")), {
    name: "TypeError",
    message: /expected a modified Texture2D entry, got added Texture2D/,
  });
  await assert.rejects(diffTexture(byPath("removed.png")), {
    name: "TypeError",
    message: /got removed Texture2D/,
  });
  const bundle = entries.find((e) => e.change === "modified" && e.type === "AssetBundle");
  assert.ok(bundle);
  await assert.rejects(diffTexture(bundle), {
    name: "TypeError",
    message: /got modified AssetBundle/,
  });
  const notTexture = bundle.after as unknown as Asset<"Texture2D">;
  await assert.rejects(diffTexture(texture(v1, "same.png"), notTexture), {
    name: "TypeError",
    message: /expected a Texture2D asset as after, got an asset of class AssetBundle/,
  });
});
