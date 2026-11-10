// The texture pixel oracle's layer golden (#331): the Unity editor's pixels of
// every level of each Cubemap face, Texture2DArray slice and Texture3D depth
// slice of the cube-array-3d bundles, recorded by
// scripts/make-texture-pixel-goldens.py (plan section 5, revision 2026-11-10a).
// Checks its shape, that it was made from the committed bundles, and that the
// uncompressed levels are the pixels fixtures/BUILDING.md section 31 authors.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface EditorTexture {
  class: string;
  format: number;
  width: number;
  height: number;
  depth: number;
  mipCount: number;
  levels: string[][];
}

interface Set {
  bundle: string;
  sha256: string;
  buildTarget: string;
  textures: Record<string, EditorTexture>;
}

const golden = JSON.parse(
  readFileSync(new URL("../../fixtures/texture-layer-pixel-unity-goldens.json", import.meta.url), "utf8"),
) as {
  _generator: string;
  _comparison: string;
  _pixels: string;
  editors: Record<string, Record<string, Set>>;
};

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const FORMATS: Record<string, string[]> = {
  windows: ["4_RGBA32", "10_DXT1", "25_BC7"],
  android: ["47_ETC2_RGBA8", "48_ASTC_4x4"],
};

/** The textures BUILDING.md section 31 makes for one bundle; 2019.4 makes no compressed Texture3D. */
function expected(editor: string, target: string): string[] {
  return FORMATS[target]!.flatMap((f) => [
    `cube_${f}`,
    `array_${f}`,
    `array_${f}_sRGB`,
    ...(editor === "2019.4.41f2" && f !== "4_RGBA32" ? [] : [`volume_${f}`]),
  ]).sort();
}

/** BUILDING.md section 31: pixel (x, y) of level m of face or slice l, w x h, rows bottom first. */
function authored(w: number, h: number, m: number, l: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = Math.floor((x * 255) / Math.max(1, w - 1));
      out[i + 1] = Math.floor((y * 255) / Math.max(1, h - 1));
      out[i + 2] = (m * 40 + l * 9 + ((x ^ y) & 3) * 16) & 255;
      out[i + 3] = 255 - m * 30;
    }
  }
  return out;
}

const sets = () =>
  EDITORS.flatMap((editor) =>
    Object.entries(golden.editors[editor]!).map(([name, set]) => ({ editor, name, set })),
  );

test("the golden holds both cube-array-3d bundles of every fixture editor, from the committed bytes", () => {
  assert.equal(golden._generator, "scripts/make-texture-pixel-goldens.py");
  assert.match(golden._pixels, /CubemapFace order.*rows bottom first.*its own size/s);
  assert.match(golden._comparison, /level 0/);
  assert.deepEqual(Object.keys(golden.editors), EDITORS);
  for (const { editor, name, set } of sets()) {
    assert.ok(name in FORMATS, name);
    assert.equal(set.bundle, `editor/${editor}/cube-array-3d/${name}`);
    assert.equal(set.buildTarget, name === "android" ? "Android" : "Win64");
    const bytes = readFileSync(new URL(`../../fixtures/bundles/${set.bundle}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), set.sha256, set.bundle);
    assert.deepEqual(Object.keys(set.textures).sort(), expected(editor, name), set.bundle);
  }
});

test("every level holds each face or slice at its size: 6 faces, the slices, or max(1, depth >> level)", () => {
  for (const { set } of sets()) {
    for (const [name, t] of Object.entries(set.textures)) {
      const at = `${set.bundle} ${name}`;
      assert.equal(t.format, Number(name.split("_")[1]), at);
      assert.equal(t.class, { cube: "Cubemap", array: "Texture2DArray", volume: "Texture3D" }[name.split("_")[0]!], at);
      assert.equal(t.depth, t.class === "Cubemap" ? 6 : t.class === "Texture2DArray" ? 3 : 4, at);
      assert.equal(t.mipCount, Math.floor(Math.log2(Math.max(t.width, t.height))) + 1, at);
      assert.equal(t.levels.length, t.mipCount, at);
      t.levels.forEach((layers, m) => {
        const count = t.class === "Texture3D" ? Math.max(1, t.depth >> m) : t.depth;
        assert.equal(layers.length, count, `${at} level ${m}`);
        const size = Math.max(1, t.width >> m) * Math.max(1, t.height >> m) * 4;
        for (const layer of layers) assert.equal(Buffer.from(layer, "base64").length, size, `${at} level ${m}`);
      });
    }
  }
});

test("the RGBA32 faces and slices are the authored pixels, so the editor read the bundles as built", () => {
  let checked = 0;
  for (const { set } of sets()) {
    for (const [name, t] of Object.entries(set.textures)) {
      if (t.format !== 4) continue;
      t.levels.forEach((layers, m) => {
        const w = Math.max(1, t.width >> m);
        const h = Math.max(1, t.height >> m);
        layers.forEach((layer, l) => {
          assert.deepEqual(
            new Uint8Array(Buffer.from(layer, "base64")),
            authored(w, h, m, l),
            `${set.bundle} ${name} level ${m} layer ${l}`,
          );
        });
      });
      checked++;
    }
  }
  // A cube, two arrays and a volume in each windows bundle.
  assert.equal(checked, 4 * 4);
});
