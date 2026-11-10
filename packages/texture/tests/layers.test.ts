import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BuildTarget,
  ClassID,
  CorruptError,
  GraphicsFormat,
  load,
  TextureFormat,
  textureFormatOfGraphicsFormat,
  UnsupportedError,
  type CubemapData,
  type ObjectReader,
  type Texture2DArrayData,
  type Texture2DData,
  type Texture3DData,
} from "unity-asset-reader";
import { loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import type { RgbaImage } from "../src/convert.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { decodeCubemap, decodeTexture2DArray, decodeTexture3D } from "../src/layers.js";

// Cubemap faces, Texture2DArray slices and Texture3D depth slices (#331). The
// pixels of every level of each face and slice of the cube-array-3d bundles
// (fixtures/BUILDING.md section 31) are the Unity editor's, recorded by
// scripts/make-texture-pixel-goldens.py (plan section 5, revision
// 2026-11-10a); UnityPy's level 0 of each array slice is a second check.
// Without a built WASM the decode tests skip, as in decode.test.ts.
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

interface EditorTexture {
  class: string;
  /** The editor's TextureFormat. */
  format: number;
  width: number;
  height: number;
  /** Faces (6), slices or depth. */
  depth: number;
  mipCount: number;
  /** levels[mip][face or slice]: RGBA8, rows bottom first, base64. */
  levels: string[][];
}

/** A golden's sets: editor -> bundle name -> the bundle and its textures. */
type Sets<T> = Record<string, Record<string, { bundle: string; sha256: string; textures: Record<string, T> }>>;

const json = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8")) as T;
const LAYERS = json<{ editors: Sets<EditorTexture> }>("texture-layer-pixel-unity-goldens.json").editors;
const MIPS = json<{ editors: Sets<{ levels: string[] }> }>("texture-pixel-unity-goldens.json").editors;

/** One texture of a cube-array-3d bundle, as `obj.read()` returns it, and the editor's pixels. */
interface Layered {
  where: string;
  bundle: string;
  reader: ObjectReader;
  editor: EditorTexture;
}

const LAYERED: Layered[] = Object.entries(LAYERS).flatMap(([version, sets]) =>
  Object.values(sets).flatMap(({ bundle, sha256: hash, textures }) => {
    const data = loadFixture(bundle);
    // The golden was recorded from this very bundle.
    assert.equal(sha256(data), hash, bundle);
    return load([{ name: bundle, data }])
      .objects.filter((obj) =>
        [ClassID.Cubemap, ClassID.Texture2DArray, ClassID.Texture3D].includes(obj.type),
      )
      .map((reader) => {
        const name = reader.read<{ m_Name: string }>().m_Name;
        const editor = textures[name];
        assert.ok(editor, `${bundle}: no editor pixels for ${name}`);
        return { where: `${version} ${bundle.split("/").pop()} ${name}`, bundle, reader, editor };
      });
  }),
);

/** Level `mip` of every face or slice, decoded by the function of the object's class. */
function decode(t: Layered, mip: number): Promise<RgbaImage[]> {
  if (t.reader.type === ClassID.Cubemap) return decodeCubemap(t.reader.read<CubemapData>(), { mip });
  if (t.reader.type === ClassID.Texture3D) {
    return decodeTexture3D(t.reader.read<Texture3DData>(), { mip });
  }
  return decodeTexture2DArray(t.reader.read<Texture2DArrayData>(), { mip });
}

/** The editor's pixels of one face or slice, top row first, cropped to the level's size. */
function editorPixels(base64: string, width: number, height: number): Uint8Array {
  let editor = new Uint8Array(Buffer.from(base64, "base64"));
  if (editor.length !== width * height * 4) {
    // A DXT, BC or ETC level under 4x4 as the whole block (`_pixels`).
    const stride = Math.max(width, 4);
    assert.equal(editor.length, stride * Math.max(height, 4) * 4);
    const level = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      level.set(editor.subarray(y * stride * 4, (y * stride + width) * 4), y * width * 4);
    }
    editor = level;
  }
  return reverseRows(editor, width);
}

/** The largest difference of one channel between two RGBA images of one size. */
function maxError(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

/**
 * Measured largest channel difference against the editor, per format
 * (2026-11-10, fixtures/BUILDING.md section 31): at level 0 of the mips
 * Texture2Ds (the bound), and over every level, face and slice here.
 */
const MEASURED: Record<number, { bound: number; layers: number }> = {
  [TextureFormat.RGBA32]: { bound: 0, layers: 0 },
  [TextureFormat.DXT1]: { bound: 0, layers: 0 },
  [TextureFormat.BC7]: { bound: 0, layers: 0 },
  [TextureFormat.ETC2_RGBA8]: { bound: 0, layers: 0 },
  [TextureFormat.ASTC_RGB_4x4]: { bound: 0, layers: 0 },
};

test("the bundles hold each class in each format, Texture3D compressed from 2020.3 on", () => {
  assert.deepEqual(Object.keys(LAYERS), ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"]);
  for (const version of Object.keys(LAYERS)) {
    const own = LAYERED.filter((t) => t.where.startsWith(`${version} `));
    const by = (cls: string) =>
      own
        .filter((t) => t.editor.class === cls)
        .map((t) => t.editor.format)
        .sort((a, b) => a - b);
    assert.deepEqual(by("Cubemap"), [4, 10, 25, 47, 48], version);
    assert.deepEqual(by("Texture2DArray"), [4, 4, 10, 10, 25, 25, 47, 47, 48, 48], version);
    assert.deepEqual(by("Texture3D"), version === "2019.4.41f2" ? [4] : [4, 10, 25, 47, 48], version);
    for (const t of own) {
      const data = t.reader.read<Texture2DData & Texture3DData>();
      const format =
        t.editor.class === "Cubemap" ? data.m_TextureFormat : textureFormatOfGraphicsFormat(data.m_Format);
      assert.equal(format, t.editor.format, t.where);
      const depth = t.editor.class === "Cubemap" ? 6 : data.m_Depth;
      assert.deepEqual(
        [data.m_Width, data.m_Height, depth, data.m_MipCount],
        [t.editor.width, t.editor.height, t.editor.depth, t.editor.mipCount],
        t.where,
      );
      assert.ok(t.editor.mipCount > 1, t.where);
    }
  }
});

wasmTest("every level of every face and slice = the editor's, as plan section 5 compares", async () => {
  // A compressed format's bound is its largest error at level 0 of a plain
  // Texture2D against the editor, over the mips fixtures of the four editors
  // (the owner's rule on #331); uncompressed formats match exactly.
  const bound = new Map<number, number>();
  for (const sets of Object.values(MIPS)) {
    for (const { bundle, textures } of Object.values(sets)) {
      for (const obj of load([{ name: bundle, data: loadFixture(bundle) }]).objects) {
        if (obj.type !== ClassID.Texture2D) continue;
        const texture = obj.read<Texture2DData>();
        const out = await decodeTexture2D(texture);
        const want = editorPixels(textures[texture.m_Name]!.levels[0]!, out.width, out.height);
        const format = texture.m_TextureFormat;
        bound.set(format, Math.max(bound.get(format) ?? 0, maxError(out.data, want)));
      }
    }
  }
  const measured = new Map<number, number>();
  for (const t of LAYERED) {
    for (let mip = 0; mip < t.editor.mipCount; mip++) {
      const images = await decode(t, mip);
      const levels = t.editor.levels[mip]!;
      assert.equal(images.length, levels.length, `${t.where} level ${mip}`);
      const width = Math.max(1, t.editor.width >> mip);
      const height = Math.max(1, t.editor.height >> mip);
      images.forEach((image, layer) => {
        const at = `${t.where} level ${mip} layer ${layer}`;
        assert.deepEqual([image.width, image.height], [width, height], at);
        const error = maxError(image.data, editorPixels(levels[layer]!, width, height));
        measured.set(t.editor.format, Math.max(measured.get(t.editor.format) ?? 0, error));
        const limit = t.editor.format === TextureFormat.RGBA32 ? 0 : bound.get(t.editor.format)!;
        assert.ok(error <= limit, `${at}: error ${error}, level 0 bound ${limit}`);
      });
    }
  }
  // The table BUILDING.md section 31 records.
  for (const [format, { bound: b, layers }] of Object.entries(MEASURED)) {
    assert.equal(bound.get(Number(format)), b, `bound of ${format}`);
    assert.equal(measured.get(Number(format)), layers, `layers of ${format}`);
  }
  assert.deepEqual([...measured.keys()].sort((a, b) => a - b), Object.keys(MEASURED).map(Number));
});

wasmTest("level 0 of each array slice = UnityPy's Texture2DArray.images, the second check", async () => {
  interface WithArrays {
    serialized?: Record<string, { textureArrays?: Record<string, { rgbaSha256?: string[] }> }>;
  }
  const goldens = {
    ...json<{ fixtures: Record<string, WithArrays> }>("goldens.json").fixtures,
    ...json<{ fixtures: Record<string, WithArrays> }>("modern-goldens.json").fixtures,
  };
  let checked = 0;
  for (const t of LAYERED) {
    if (t.reader.type !== ClassID.Texture2DArray) continue;
    const [sf] = Object.values(goldens[t.bundle]!.serialized!);
    const want = sf!.textureArrays![String(t.reader.pathId)]!.rgbaSha256;
    assert.ok(want, `${t.where}: UnityPy decoded no slices`);
    const slices = await decode(t, 0);
    assert.deepEqual(slices.map((s) => sha256(s.data)), want, t.where);
    checked++;
  }
  // Six arrays in each windows bundle, four in each android one.
  assert.equal(checked, 4 * 10);
});

wasmTest("mip 0 is the default, and each face and slice has its own pixels", async () => {
  for (const t of LAYERED.filter((x) => x.where.startsWith("6000.3.26f1 windows"))) {
    const first = await decode(t, 0);
    const reader = t.reader;
    const again =
      reader.type === ClassID.Cubemap
        ? await decodeCubemap(reader.read<CubemapData>())
        : reader.type === ClassID.Texture3D
          ? await decodeTexture3D(reader.read<Texture3DData>())
          : await decodeTexture2DArray(reader.read<Texture2DArrayData>());
    assert.deepEqual(again, first, t.where);
    assert.equal(new Set(first.map((image) => sha256(image.data))).size, first.length, t.where);
  }
});

// --- hand-built input ----------------------------------------------------------------------

/** A 4x4 RGBA32 Texture2DArray of `depth` slices with 3 levels (4x4, 2x2, 1x1). */
function array(depth: number, format: number = GraphicsFormat.R8G8B8A8_UNorm): Texture2DArrayData {
  const slice = (4 * 4 + 2 * 2 + 1) * 4;
  const imageData = new Uint8Array(slice * depth).map((_, i) => i & 255);
  return {
    m_Name: "a",
    m_ColorSpace: 0,
    m_Format: format,
    m_Width: 4,
    m_Height: 4,
    m_Depth: depth,
    m_MipCount: 3,
    m_DataSize: imageData.length,
    m_TextureSettings: { m_FilterMode: 0, m_Aniso: 0, m_MipBias: 0 },
    m_IsReadable: true,
    "image data": imageData,
    m_StreamData: { offset: 0, size: 0, path: "" },
    imageData,
    platform: BuildTarget.StandaloneWindows64,
  };
}

wasmTest("an array slice is the slice's bytes; a 3D level is its depth slices, level after level", async () => {
  const a = array(2);
  const [, second] = await decodeTexture2DArray(a, { mip: 1 });
  // Slice 1, level 1: 84 bytes in, after its 64-byte level 0; rows flipped.
  const level = a.imageData.subarray(84 + 64, 84 + 80);
  assert.deepEqual(second!.data, reverseRows(level, 2));

  // 4x4x4 RGBA32: level 0 is 4 slices of 64 bytes, level 1 is 2 of 16, level 2 one of 4.
  const imageData = new Uint8Array(4 * 64 + 2 * 16 + 4).map((_, i) => (i * 7) & 255);
  const volume: Texture3DData = { ...array(1), m_Depth: 4, imageData, m_DataSize: imageData.length };
  const slices = await decodeTexture3D(volume, { mip: 1 });
  assert.equal(slices.length, 2);
  assert.deepEqual(slices[1]!.data, reverseRows(imageData.subarray(256 + 16, 256 + 32), 2));
  const [last] = await decodeTexture3D(volume, { mip: 2 });
  assert.deepEqual(last!.data, imageData.subarray(288, 292));
  await assert.rejects(
    decodeTexture3D({ ...volume, imageData: imageData.subarray(0, 291) }, { mip: 2 }),
    (err: unknown) => err instanceof CorruptError && /ends at byte 292/.test(err.message),
  );
});

test("an unverified GraphicsFormat, a console build or a Crunch cubemap is refused", async () => {
  await assert.rejects(
    decodeTexture2DArray(array(1, GraphicsFormat.R8G8B8A8_UNorm + 1)),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "graphics format" && err.found === 9,
  );
  for (const platform of [BuildTarget.Switch, BuildTarget.XBOX360, BuildTarget.PS4, BuildTarget.PS5]) {
    await assert.rejects(
      decodeTexture2DArray({ ...array(1), platform }),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "texture platform",
    );
  }
  const cube = LAYERED.find((t) => t.reader.type === ClassID.Cubemap)!.reader.read<CubemapData>();
  for (const format of [
    TextureFormat.DXT1Crunched,
    TextureFormat.DXT5Crunched,
    TextureFormat.ETC_RGB4Crunched,
    TextureFormat.ETC2_RGBA8Crunched,
  ]) {
    await assert.rejects(
      decodeCubemap({ ...cube, m_TextureFormat: format }),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "texture format" && err.found === format,
    );
  }
});

test("a mip level outside the texture, or image data that does not split, is refused", async () => {
  await assert.rejects(decodeTexture2DArray(array(1), { mip: 3 }), RangeError);
  await assert.rejects(decodeTexture2DArray(array(1), { mip: -1 }), RangeError);
  await assert.rejects(decodeTexture2DArray(array(1), { mip: "1" as unknown as number }), TypeError);
  await assert.rejects(
    decodeTexture2DArray({ ...array(2), imageData: new Uint8Array(85) }),
    (err: unknown) => err instanceof CorruptError && /does not split into 2 slices/.test(err.message),
  );
  const cube = LAYERED.find((t) => t.reader.type === ClassID.Cubemap)!.reader.read<CubemapData>();
  await assert.rejects(decodeCubemap(cube, { mip: cube.m_MipCount! }), RangeError);
  await assert.rejects(
    decodeCubemap({ ...cube, imageData: cube.imageData.subarray(1) }),
    (err: unknown) => err instanceof CorruptError && /does not split into 6 faces/.test(err.message),
  );
});
