// The texture pixel oracle's golden (#331): the Unity editor's GetPixels32 of
// every mip level of the mips bundles, recorded by
// scripts/make-texture-pixel-goldens.py (plan section 5, revision 2026-11-10a).
// Checks its shape, that it was made from the committed bundles, and that the
// uncompressed levels are the pixels fixtures/BUILDING.md section 29 authors.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface EditorTexture {
  format: number;
  width: number;
  height: number;
  mipCount: number;
  levels: string[];
}

interface Set {
  bundle: string;
  sha256: string;
  buildTarget: string;
  textures: Record<string, EditorTexture>;
}

const golden = JSON.parse(
  readFileSync(new URL("../../fixtures/texture-pixel-unity-goldens.json", import.meta.url), "utf8"),
) as {
  _generator: string;
  _comparison: string;
  _pixels: string;
  editors: Record<string, Record<string, Set>>;
};

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const TEXTURES: Record<string, Record<string, number>> = {
  windows: { "4_RGBA32": 4, "4_RGBA32_20x12": 4, "10_DXT1": 10, "12_DXT5": 12, "25_BC7": 25 },
  android: { "45_ETC2_RGB": 45, "47_ETC2_RGBA8": 47, "48_ASTC_4x4": 48, "50_ASTC_6x6": 50 },
};

/** BUILDING.md section 29: pixel (x, y) of level m, w x h, rows bottom first. */
function authored(w: number, h: number, m: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = Math.floor((x * 255) / Math.max(1, w - 1));
      out[i + 1] = Math.floor((y * 255) / Math.max(1, h - 1));
      out[i + 2] = (m * 50 + ((x ^ y) & 3) * 16) & 255;
      out[i + 3] = 255 - m * 30;
    }
  }
  return out;
}

const sets = () =>
  EDITORS.flatMap((editor) =>
    Object.entries(golden.editors[editor]!).map(([name, set]) => ({ editor, name, set })),
  );

test("the golden holds both mips bundles of every fixture editor, from the committed bytes", () => {
  assert.equal(golden._generator, "scripts/make-texture-pixel-goldens.py");
  assert.match(golden._pixels, /rows bottom first.*whole block/s);
  assert.match(golden._comparison, /level 0/);
  assert.deepEqual(Object.keys(golden.editors), EDITORS);
  for (const { editor, name, set } of sets()) {
    assert.ok(name in TEXTURES, name);
    assert.equal(set.bundle, `editor/${editor}/mips/${name}`);
    assert.equal(set.buildTarget, name === "android" ? "Android" : "Win64");
    const bytes = readFileSync(new URL(`../../fixtures/bundles/${set.bundle}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), set.sha256, set.bundle);
    // 2019.4 and 2020.3 name format 50 ASTC_RGB_6x6, Unity 6 ASTC_6x6.
    const names = Object.keys(set.textures).map((n) => n.replace("ASTC_RGB_6x6", "ASTC_6x6"));
    assert.deepEqual(names.sort(), Object.keys(TEXTURES[name]!).sort(), set.bundle);
  }
});

test("every level has its size: max(1, side >> level), down to 1x1, or a whole 4x4 block", () => {
  for (const { set } of sets()) {
    for (const [name, t] of Object.entries(set.textures)) {
      const at = `${set.bundle} ${name}`;
      assert.equal(t.format, TEXTURES[set.bundle.split("/").pop()!]![name.replace("ASTC_RGB_6x6", "ASTC_6x6")], at);
      assert.equal(t.mipCount, Math.floor(Math.log2(Math.max(t.width, t.height))) + 1, at);
      assert.equal(t.levels.length, t.mipCount, at);
      t.levels.forEach((level, m) => {
        const w = Math.max(1, t.width >> m);
        const h = Math.max(1, t.height >> m);
        // GetPixels32 of a DXT, BC or ETC level under 4x4 is the whole block (_pixels).
        const block = [10, 12, 25, 45, 47].includes(t.format);
        const size = block ? Math.max(w, 4) * Math.max(h, 4) * 4 : w * h * 4;
        assert.equal(Buffer.from(level, "base64").length, size, `${at} level ${m}`);
      });
    }
  }
});

test("the RGBA32 levels are the authored pixels, so the editor read the bundles as built", () => {
  for (const { set } of sets()) {
    for (const [name, t] of Object.entries(set.textures)) {
      if (t.format !== 4) continue;
      t.levels.forEach((level, m) => {
        const w = Math.max(1, t.width >> m);
        const h = Math.max(1, t.height >> m);
        assert.deepEqual(
          new Uint8Array(Buffer.from(level, "base64")),
          authored(w, h, m),
          `${set.bundle} ${name} level ${m}`,
        );
      });
    }
  }
});
