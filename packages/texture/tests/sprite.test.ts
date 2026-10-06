// Sprites (#34): the crop, packing rotation and tight-mesh mask, checked against
// the oracle's sprite goldens (R12), AssetStudio's own CutImage where the two
// differ (plan §6), and the fixture's own pixels, which encode where they are.
// A variant atlas' resize (#153) is checked against AssetStudio's CutImage.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClassID,
  CorruptError,
  load,
  ResourceNotFoundError,
  SpritePackingRotation,
  UnsupportedError,
  type Env,
  type ObjectReader,
  type Sprite,
  type Texture2DData,
} from "unity-asset-reader";
import {
  golden,
  loadFixture,
  reverseRows,
  sha256,
  type GoldenSprite,
} from "../../../fixtures/helpers.js";
import { convertPlain, type RgbaImage } from "../src/convert.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { imageInfo } from "../src/image.js";
import {
  cutSprite,
  decodeSprite,
  findSpriteSource,
  locateSprite,
  spriteSize,
  type SpriteRect,
} from "../src/sprite.js";
import { ASSETSTUDIO_RGBA, IMAGE_ID } from "./assetstudio-sprites.js";

// As in decode.test.ts: the WASM half of texture2ddecoder-wasm needs Docker to
// build, so without it only the tests that need no decoder run, and the CI job
// that builds it sets REQUIRE_WASM=1 so that nothing skips there (#119). The
// fixture textures are RGBA32, so every test but the decodeSprite ones works
// on convertPlain's pixels instead.
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

const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const FIXTURES = ["editor/2019.4.41f2/sprite/sprites", "editor/6000.3.25f1/sprite/sprites"];

/** One fixture sprite, where its pixels are, and what the oracle says it is. */
interface FixtureSprite {
  fixture: string;
  env: Env;
  obj: ObjectReader;
  sprite: Sprite;
  rect: SpriteRect;
  /** Its texture, top row first, as `decodeTexture2D` would give it. */
  image: RgbaImage;
  golden: GoldenSprite;
}

/** Every Sprite of a fixture, through the lookup `decodeSprite` does. */
function fixtureSprites(fixture: string): FixtureSprite[] {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const [sf] = Object.values(golden(fixture).serialized!);
  return env.objects
    .filter((obj) => obj.type === ClassID.Sprite)
    .map((obj) => {
      const { sprite, rect, texture } = findSpriteSource(obj, env);
      const plain = convertPlain(texture.imageData, texture.m_Width, texture.m_Height, 4);
      assert.equal(texture.m_TextureFormat, 4, "the fixture textures are RGBA32");
      const image = { ...plain, data: reverseRows(plain.data, plain.width) };
      const g = sf!.sprites![String(obj.pathId)];
      assert.ok(g, `${fixture}: no sprite golden for ${obj.pathId}`);
      return { fixture, env, obj, sprite, rect, image, golden: g };
    });
}

const SPRITES = FIXTURES.flatMap(fixtureSprites);

/** Rows reversed back to the order the goldens hash. */
const stored = ({ data, width }: RgbaImage): string => sha256(reverseRows(data, width));

/** What a tight image must hash to: the golden, or AssetStudio's where they differ. */
function tightExpected({ golden: g }: FixtureSprite): string {
  const want = g.tightOracleNote ? ASSETSTUDIO_RGBA[g.name] : g.tightRgbaSha256;
  assert.ok(want, `${g.name}: no expected tight hash`);
  return want;
}

// --- the goldens -------------------------------------------------------------------

for (const s of SPRITES) {
  test(`${s.fixture} ${s.golden.name}: the rectangle, unpacked, equals the golden`, () => {
    const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, false);
    assert.equal(out.width, s.golden.width);
    assert.equal(out.height, s.golden.height);
    assert.equal(stored(out), s.golden.rgbaSha256);
  });

  test(`${s.fixture} ${s.golden.name}: tightMesh equals the golden, or AssetStudio`, () => {
    const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, true);
    if (s.golden.tightRgbaSha256 === undefined) {
      // Packed as a rectangle: the mesh is not applied.
      assert.equal((s.rect.settingsRaw >> 1) & 1, 1);
      assert.equal(stored(out), s.golden.rgbaSha256);
      return;
    }
    assert.equal(out.width, s.golden.tightWidth);
    assert.equal(out.height, s.golden.tightHeight);
    assert.equal(stored(out), tightExpected(s));
    // The note is right: here UnityPy's image is not AssetStudio's.
    if (s.golden.tightOracleNote) assert.notEqual(s.golden.tightRgbaSha256, tightExpected(s));
  });
}

test("the sprite checks cover both editors, every packing flip, and masks that cut", () => {
  const seen = new Set<string>();
  for (const s of SPRITES) {
    seen.add(s.fixture);
    const packed = (s.rect.settingsRaw & 1) === 1;
    if (packed) seen.add(`rotation ${(s.rect.settingsRaw >> 2) & 0xf}`);
    if (s.golden.tightOracleNote) seen.add("noted");
    if (s.golden.tightRgbaSha256 && !s.golden.tightOracleNote) seen.add("tight, oracles agree");
  }
  assert.deepEqual([...seen].filter((k) => k.startsWith("editor/")).sort(), FIXTURES);
  for (const want of ["rotation 0", "rotation 1", "rotation 2", "rotation 3"]) {
    assert.ok(seen.has(want), want);
  }
  assert.ok(seen.has("noted") && seen.has("tight, oracles agree"));
});

for (const fixture of FIXTURES) {
  test(`${fixture}: sheet_b turned every way a packer can, against the golden`, () => {
    const s = SPRITES.find((x) => x.fixture === fixture && x.golden.name === "sheet_b")!;
    const rotations = s.golden.rotations!;
    for (const [value, turned] of Object.entries(rotations)) {
      const settingsRaw = (s.rect.settingsRaw & ~0x3f) | 1 | 2 | (Number(value) << 2);
      const out = cutSprite(s.image, s.sprite, { ...s.rect, settingsRaw }, s.obj.version, false);
      assert.equal(out.width, turned.width);
      assert.equal(out.height, turned.height);
      // Rotate90 turns the other way in UnityPy (see the note); AssetStudio decides.
      const want = turned.oracleNote ? ASSETSTUDIO_RGBA["sheet_b Rotate90"] : turned.rgbaSha256;
      assert.equal(stored(out), want, `rotation ${value}`);
    }
    assert.ok(rotations[String(SpritePackingRotation.Rotate90)]!.oracleNote);
    assert.equal(Object.keys(rotations).length, 4);
  });
}

// --- the fixture's own pixels: every one says where it is ----------------------------

/**
 * Check that every opaque pixel of the sprite's own image lands where it was
 * drawn: the crop, the bottom-left origin, the undone packing flip and the
 * final top-down order all have to be right. With `onlyOwn`, also that no
 * pixel of another sprite is left (a packed neighbour's, inside the rectangle).
 *
 * @returns how many pixels were checked
 */
function checkOwnPixels(s: FixtureSprite, out: RgbaImage, onlyOwn: boolean): number {
  const id = IMAGE_ID[s.golden.name];
  assert.ok(id !== undefined, s.golden.name);
  // Where the image starts in the sprite: the sheet rectangle, or the trimmed margin.
  const onSheet = s.golden.name.startsWith("sheet_");
  const originX = onSheet ? s.sprite.m_Rect.x : Math.floor(s.rect.textureRectOffset.x);
  const originY = onSheet ? s.sprite.m_Rect.y : Math.floor(s.rect.textureRectOffset.y);
  let checked = 0;
  for (let row = 0; row < out.height; row++) {
    for (let x = 0; x < out.width; x++) {
      const at = (row * out.width + x) * 4;
      const [r, g, b, a] = out.data.subarray(at, at + 4);
      if (a !== 255) continue;
      if (b !== ((16 * id + 7) & 0xff)) {
        assert.ok(!onlyOwn, `${s.golden.name}: a pixel of image ${b} at (${x}, ${row})`);
        continue;
      }
      const y = out.height - 1 - row;
      assert.equal(r, (5 * (originX + x) + 3) & 0xff, `${s.golden.name} R at (${x}, ${y})`);
      assert.equal(g, (5 * (originY + y) + 5) & 0xff, `${s.golden.name} G at (${x}, ${y})`);
      checked++;
    }
  }
  return checked;
}

for (const fixture of FIXTURES) {
  test(`${fixture}: every opaque pixel of each sprite is where its image drew it`, () => {
    for (const s of SPRITES.filter((x) => x.fixture === fixture)) {
      const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, false);
      assert.ok(checkOwnPixels(s, out, false) > 0, s.golden.name);
      // The mask leaves nothing of a packed neighbour, and keeps the sprite.
      const tight = cutSprite(s.image, s.sprite, s.rect, s.obj.version, true);
      assert.ok(checkOwnPixels(s, tight, true) > 0, s.golden.name);
    }
  });
}

// --- the mask on hand-made triangles, against AssetStudio's ---------------------------

/**
 * A 16x16 texture whose pixel i has alpha i and colours that differ, cut as a
 * sprite with the given triangles in pixels (pivot at the corner, 1 pixel per
 * unit). The triangles have corners off the pixel grid, and one is a sliver
 * 0.2 wide, which fills a whole column. AssetStudio's CutImage gave the hashes.
 */
function synthetic(vertices: [number, number][], triangles: number[][]): RgbaImage {
  const texture = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    texture.set([(i * 37 + 11) & 255, (i * 91 + 3) & 255, (i * 53 + 7) & 255, i], i * 4);
  }
  const data = new Uint8Array(vertices.length * 12);
  const view = new DataView(data.buffer);
  vertices.forEach(([x, y], i) => {
    view.setFloat32(i * 12, x, true);
    view.setFloat32(i * 12 + 4, y, true);
  });
  const indices = new Uint8Array(new Uint16Array(triangles.flat()).buffer);
  const sprite = {
    m_Rect: { x: 0, y: 0, width: 16, height: 16 },
    m_Pivot: { x: 0, y: 0 },
    m_PixelsToUnits: 1,
    m_RD: {
      m_SubMeshes: [
        {
          firstByte: 0,
          indexCount: indices.length / 2,
          firstVertex: 0,
          vertexCount: vertices.length,
        },
      ],
      m_IndexBuffer: indices,
      m_VertexData: {
        m_VertexCount: vertices.length,
        m_Channels: [{ stream: 0, offset: 0, format: 0, dimension: 3 }],
        m_DataSize: data,
      },
    },
  } as unknown as Sprite;
  const rect: SpriteRect = {
    textureRect: { x: 0, y: 0, width: 16, height: 16 },
    textureRectOffset: { x: 0, y: 0 },
    settingsRaw: 0,
    downscaleMultiplier: 1,
  };
  const image = { data: reverseRows(texture, 16), width: 16, height: 16 };
  return cutSprite(image, sprite, rect, [2020, 3, 1, 1], true);
}

test("the tight mask fills triangles as AssetStudio's ImageSharp does, to the pixel", () => {
  const quad = synthetic(
    [[0, 0], [16, 0], [16, 16], [0, 16]],
    [[0, 1, 2], [0, 2, 3]],
  );
  const tri = synthetic([[0.3, 0.2], [15.7, 3.9], [6.1, 15.55]], [[0, 1, 2]]);
  const thin = synthetic([[2.1, 1], [2.25, 14], [2.3, 1]], [[0, 1, 2]]);
  assert.equal(stored(quad), ASSETSTUDIO_RGBA["synthetic quad"]);
  assert.equal(stored(tri), ASSETSTUDIO_RGBA["synthetic tri"]);
  assert.equal(stored(thin), ASSETSTUDIO_RGBA["synthetic thin"]);
  // A pixel the mask keeps keeps its colour at any alpha but 0, as upstream's blend does.
  const pixel = (image: RgbaImage, x: number, y: number) =>
    [...image.data.subarray(((15 - y) * 16 + x) * 4, ((15 - y) * 16 + x) * 4 + 4)];
  assert.deepEqual(pixel(quad, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(quad, 1, 0), [48, 94, 60, 1]);
  // The sliver fills column 2 from row 1 to 13, and nothing else.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      assert.equal(pixel(thin, x, y)[3]! > 0, x === 2 && y >= 1 && y <= 13, `(${x}, ${y})`);
    }
  }
});

// --- refusals -------------------------------------------------------------------------

const base = SPRITES.find((s) => s.fixture === FIXTURES[1] && s.golden.name === "sheet_d")!;
const cut = (rect: Partial<SpriteRect>, sprite: Sprite = base.sprite, tight = true) =>
  cutSprite(base.image, sprite, { ...base.rect, ...rect }, base.obj.version, tight);

test("a textureRect outside its texture throws CorruptError", () => {
  for (const textureRect of [
    { x: -1, y: 0, width: 4, height: 4 },
    { x: 0, y: -0.5, width: 4, height: 4 },
    { x: 64, y: 0, width: 4, height: 4 },
    { x: 0, y: 0, width: 0, height: 4 },
  ]) {
    assert.throws(() => cut({ textureRect }), CorruptError, JSON.stringify(textureRect));
  }
  // Past the far edges it is clipped, as upstream clips it.
  const clipped = cut({ textureRect: { x: 60, y: 40, width: 10, height: 10 } }, base.sprite, false);
  assert.deepEqual([clipped.width, clipped.height], [4, 8]);
});

test("a downscaleMultiplier of 1, 0 or below, or that keeps the size, does not resample", () => {
  const plain = stored(cut({}, base.sprite, false));
  // 1, upstream's 0 before 2017.1, and what upstream's `> 0f` check skips, mean none.
  for (const downscaleMultiplier of [1, 0, -0.5, NaN]) {
    assert.equal(stored(cut({ downscaleMultiplier }, base.sprite, false)), plain);
  }
  // A size that truncates back to the texture's: ImageSharp copies the pixels as they are.
  const { width } = base.image;
  const same = Math.fround(width / (width + 0.5));
  assert.equal(Math.trunc(Math.fround(width / same)), width);
  assert.equal(stored(cut({ downscaleMultiplier: same }, base.sprite, false)), plain);
  // Resampling changes the pixels of the same rectangle.
  assert.notEqual(stored(cut({ downscaleMultiplier: 0.75 }, base.sprite, false)), plain);
});

test("the resized size divides in 32-bit floats, as upstream's int / float does", () => {
  // 64 / 0.8f is 80 in floats; in doubles it is 79.99999880790713, which truncates to 79.
  const m = Math.fround(0.8);
  assert.equal(Math.trunc(64 / m), 79);
  const rect: SpriteRect = {
    ...base.rect,
    textureRect: { x: 0, y: 0, width: 80, height: 80 },
    settingsRaw: 0,
    downscaleMultiplier: m,
  };
  assert.deepEqual(spriteSize(rect, 64, 64), { width: 80, height: 80 });
  const image = { data: new Uint8Array(64 * 64 * 4).fill(255), width: 64, height: 64 };
  const out = cutSprite(image, base.sprite, rect, base.obj.version, false);
  assert.deepEqual([out.width, out.height], [80, 80]);
  // 1024 / 0.2f likewise: 5120, not 5119.
  const wide = { ...rect, textureRect: { x: 0, y: 0, width: 5120, height: 1 } };
  assert.equal(spriteSize({ ...wide, downscaleMultiplier: Math.fround(0.2) }, 1024, 1).width, 5120);
});

test("a downscaleMultiplier that resizes the texture to nothing throws CorruptError", () => {
  for (const downscaleMultiplier of [1e6, Infinity]) {
    assert.throws(
      () => cut({ downscaleMultiplier }),
      (err: unknown) =>
        err instanceof CorruptError && /downscaleMultiplier .* to 0 x 0/.test(err.message),
    );
  }
  assert.throws(() => cut({ downscaleMultiplier: 1e-30 }), /downscaleMultiplier/);
});

test("a packing rotation Unity does not define is refused, unless the sprite is not packed", () => {
  assert.throws(
    () => cut({ settingsRaw: 1 | (5 << 2) }),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "sprite packing rotation" && err.found === 5,
  );
  cut({ settingsRaw: 5 << 2 });
});

test("tightMesh refuses a mesh it cannot read, rather than skip the mask as upstream does", () => {
  const rd = base.sprite.m_RD;
  const vd = rd.m_VertexData!;
  const withMesh = (changes: Partial<Sprite["m_RD"]>): Sprite => ({
    ...base.sprite,
    m_RD: { ...rd, ...changes },
  });
  // Positions that are not 32-bit floats.
  const channels = [{ ...vd.m_Channels[0]!, format: 1 }];
  const half = withMesh({ m_VertexData: { ...vd, m_Channels: channels } });
  assert.throws(
    () => cut({}, half),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "sprite vertex format",
  );
  // An index past the sub-mesh's vertices.
  const index = rd.m_IndexBuffer!.slice();
  index[0] = 0xff;
  assert.throws(() => cut({}, withMesh({ m_IndexBuffer: index })), /outside its sub-mesh/);
  // Vertex data cut short.
  const short = withMesh({ m_VertexData: { ...vd, m_DataSize: vd.m_DataSize.subarray(0, 20) } });
  assert.throws(() => cut({}, short), CorruptError);
  // No mesh at all.
  const none = withMesh({ m_VertexData: undefined });
  assert.throws(() => cut({}, none), /has no mesh/);
  // Without tightMesh the mesh is never read.
  cut({}, half, false);
});

/** A fixture loaded fresh, so that its bytes can be changed. */
function fresh(name: string): { env: Env; sprite: ObjectReader; file: Uint8Array } {
  const env = load([{ name: FIXTURES[1]!, data: loadFixture(FIXTURES[1]!) }]);
  const sprite = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === name,
  )!;
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  return { env, sprite, file };
}

/** Where `pattern` starts in the object's bytes, which must hold it once. */
function find(obj: ObjectReader, file: Uint8Array, pattern: Uint8Array): number {
  const bytes = file.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  const hits: number[] = [];
  for (let i = 0; i + pattern.length <= bytes.length; i++) {
    if (pattern.every((b, k) => bytes[i + k] === b)) hits.push(i);
  }
  assert.equal(hits.length, 1, "pattern not found exactly once");
  return obj.byteStart + hits[0]!;
}

/** A pointer's bytes: `Int32` file id, `Int64` path id. */
function pointer(fileId: number, pathId: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setInt32(0, fileId, true);
  new DataView(out.buffer).setBigInt64(4, pathId, true);
  return out;
}

test("decodeSprite's lookup refuses what is not a Sprite with a TypeError", () => {
  const { env } = fresh("sheet_a");
  const texture = env.objects.find((o) => o.type === ClassID.Texture2D)!;
  assert.throws(() => findSpriteSource(texture, env), /expected the ObjectReader of a Sprite/);
  assert.throws(() => findSpriteSource(undefined as unknown as ObjectReader, env), TypeError);
});

test("a packed sprite whose key is not in its atlas throws CorruptError", () => {
  const { env, sprite, file } = fresh("p_tri");
  const key = sprite.read<Sprite>().m_RenderDataKey![0];
  const guid = new Uint8Array(new Uint32Array([0, 1, 2, 3].map((i) => key[`data[${i}]`]!)).buffer);
  file[find(sprite, file, guid)]! ^= 0xff;
  assert.throws(() => findSpriteSource(sprite, env), /has no render data for its m_RenderDataKey/);
});

test("a dangling atlas pointer, with no texture in m_RD to fall back to, is what is blamed", () => {
  const { env, sprite, file } = fresh("p_tri");
  const atlas = sprite.read<Sprite>().m_SpriteAtlas!;
  const at = find(sprite, file, pointer(0, atlas.m_PathID));
  // objectNotFound: the pointer's own path id, and the atlas, are named.
  file.set(pointer(0, 12345n), at);
  assert.throws(
    () => findSpriteSource(sprite, env),
    (err: unknown) =>
      err instanceof CorruptError &&
      /'s atlas, which holds its texture, \(path id 12345\) is not in/.test(err.message),
  );
  // fileIdOutOfRange.
  file.set(pointer(1, atlas.m_PathID), at);
  assert.throws(
    () => findSpriteSource(sprite, env),
    (err: unknown) =>
      err instanceof CorruptError && /'s atlas, .* has file id 1, past/.test(err.message),
  );
  // A null atlas pointer means "not packed": then m_RD's null texture is the fault.
  file.set(pointer(0, 0n), at);
  assert.throws(() => findSpriteSource(sprite, env), /'s texture is a null pointer/);
});

test("an alpha texture pointer: null is none, the wrong class or nothing is CorruptError", () => {
  const { env, sprite, file } = fresh("sheet_a");
  // m_RD: texture, then alphaTexture, a null pointer: no alpha texture.
  assert.equal(findSpriteSource(sprite, env).alphaTexture, undefined);
  const texture = sprite.read<Sprite>().m_RD.texture;
  const pair = Uint8Array.from([...pointer(0, texture.m_PathID), ...pointer(0, 0n)]);
  const at = find(sprite, file, pair) + 12;
  file.set(pointer(0, texture.m_PathID), at);
  assert.equal(findSpriteSource(sprite, env).alphaTexture?.m_Name, "sheet");
  file.set(pointer(0, sprite.pathId), at);
  assert.throws(
    () => findSpriteSource(sprite, env),
    (err: unknown) =>
      err instanceof CorruptError && /'s alpha texture \(path id -?\d+\) is class 213, not 28/
        .test(err.message),
  );
  file.set(pointer(0, 777n), at);
  assert.throws(
    () => findSpriteSource(sprite, env),
    (err: unknown) =>
      err instanceof CorruptError && /'s alpha texture \(path id 777\) is not in/.test(err.message),
  );
});

test("a texture pointer at the wrong class or at nothing throws CorruptError", () => {
  const { env, sprite, file } = fresh("sheet_a");
  const texture = sprite.read<Sprite>().m_RD.texture;
  const at = find(sprite, file, pointer(0, texture.m_PathID));
  file.set(pointer(0, sprite.pathId), at);
  assert.throws(() => findSpriteSource(sprite, env), /is class 213, not 28/);
  file.set(pointer(0, 777n), at);
  assert.throws(() => findSpriteSource(sprite, env), /path id 777\) is not in/);
});

test("an atlas texture in a .resS that is not loaded throws ResourceNotFoundError", () => {
  const { env: whole } = fresh("p_tri");
  const cab = whole.files.find((f) => !f.path.endsWith(".resS"))!;
  const env = load([{ name: cab.path, data: cab.data }]);
  const sprite = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === "p_tri",
  )!;
  assert.throws(() => findSpriteSource(sprite, env), ResourceNotFoundError);
});

// --- variant atlases: resized as AssetStudio resizes them (#153) ----------------------

/**
 * A half-scale variant SpriteAtlas (`fixtures/BUILDING.md` sections 14 and 15):
 * its two sprites' entries have `downscaleMultiplier` 0.5 on a 32x32 texture.
 * UnityPy ignores the multiplier, so the golden carries AssetStudio's executed
 * `CutImage` result (ImageSharp 2.1.3 bicubic resize, rectangle path) as
 * `assetStudioCrossCheck`, rows bottom first like the goldens.
 */
const VARIANT = "editor/2019.4.41f2/variant/sprites";

type VariantGolden = GoldenSprite & {
  assetStudioCrossCheck?: { width: number; height: number; rgbaSha256: string };
};

const VARIANTS = fixtureSprites(VARIANT);

/** AssetStudio's image of a variant fixture sprite. */
function assetStudio(s: FixtureSprite): { width: number; height: number; rgbaSha256: string } {
  const want = (s.golden as VariantGolden).assetStudioCrossCheck;
  assert.ok(want, `${s.golden.name}: no AssetStudio cross-check`);
  return want;
}

test("a variant sprite is cut from its texture resized as AssetStudio does, to the byte", () => {
  assert.deepEqual(VARIANTS.map((s) => s.golden.name).sort(), ["r_a", "r_b"]);
  for (const s of VARIANTS) {
    const want = assetStudio(s);
    assert.equal(s.rect.downscaleMultiplier, 0.5);
    assert.deepEqual([s.image.width, s.image.height], [32, 32]);
    // Packed as rectangles: tightMesh leaves them as they are.
    for (const tight of [false, true]) {
      const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, tight);
      assert.deepEqual([out.width, out.height], [want.width, want.height], s.golden.name);
      assert.equal(stored(out), want.rgbaSha256, s.golden.name);
    }
    // UnityPy crops the texture unscaled; that is not the answer.
    assert.notEqual(s.golden.rgbaSha256, want.rgbaSha256);
  }
});

test("a tight variant sprite is masked after the resize and cut, as upstream orders them", () => {
  let cleared = 0;
  for (const s of VARIANTS) {
    // The whole resized texture: 64x64, through the same resampling.
    const all = { x: 0, y: 0, width: 64, height: 64 };
    const resized = cutSprite(s.image, s.sprite, { ...s.rect, textureRect: all, settingsRaw: 2 },
      s.obj.version, false);
    assert.deepEqual([resized.width, resized.height], [64, 64]);
    // Only the sprite's pixels are resampled, and they are the whole resize's.
    const unscaled = { ...s.rect, downscaleMultiplier: 1 };
    assert.equal(stored(cutSprite(resized, s.sprite, unscaled, s.obj.version, false)),
      assetStudio(s).rgbaSha256);
    // Packed Tight: the mask is the same mesh over the cut of the resized texture.
    const tight = { ...s.rect, settingsRaw: s.rect.settingsRaw & ~2 };
    const out = cutSprite(s.image, s.sprite, tight, s.obj.version, true);
    const want = cutSprite(resized, s.sprite, { ...tight, downscaleMultiplier: 1 }, s.obj.version,
      true);
    assert.equal(stored(out), stored(want), s.golden.name);
    const rect = cutSprite(s.image, s.sprite, s.rect, s.obj.version, false);
    for (let i = 3; i < rect.data.length; i += 4) {
      if (rect.data[i] !== 0 && out.data[i] === 0) cleared++;
    }
  }
  assert.ok(cleared > 0, "r_b's mesh leaves part of its rectangle out");
});

test("imageInfo gives a variant sprite the size it is cut at, from the resized texture", () => {
  const env = VARIANTS[0]!.env;
  for (const asset of env.assets("Sprite")) {
    const s = VARIANTS.find((x) => x.obj === asset.reader)!;
    const info = imageInfo(asset);
    assert.deepEqual([info.width, info.height], [assetStudio(s).width, assetStudio(s).height]);
    assert.deepEqual([info.sprite.texture.width, info.sprite.texture.height], [32, 32]);
  }
});

test("decodeSprite resizes per call; the caller's map keeps the texture as decoded", async () => {
  // A map holding the decoded texture: decodeSprite takes it from there, without the WASM.
  const { env } = VARIANTS[0]!;
  const texture = locateSprite(VARIANTS[0]!.obj, env).texture;
  const image = VARIANTS[0]!.image;
  const before = sha256(image.data);
  const decodedTextures = new Map<ObjectReader, RgbaImage>([[texture, image]]);
  for (const s of VARIANTS) {
    assert.strictEqual(locateSprite(s.obj, env).texture, texture, "one atlas texture");
    const out = await decodeSprite(s.obj, env, { decodedTextures });
    assert.equal(stored(out), assetStudio(s).rgbaSha256, s.golden.name);
  }
  // Nothing resized went into the map: it still holds the texture, unchanged.
  assert.equal(decodedTextures.size, 1);
  assert.strictEqual(decodedTextures.get(texture), image);
  assert.deepEqual([image.width, image.height], [32, 32]);
  assert.equal(sha256(image.data), before);
  // Each sprite's own multiplier applies: r_a's rectangle is not even in the unscaled
  // texture, and another multiplier resamples the same texture to other pixels.
  const r = VARIANTS.find((s) => s.golden.name === "r_a")!;
  assert.throws(
    () => cutSprite(image, r.sprite, { ...r.rect, downscaleMultiplier: 1 }, r.obj.version, false),
    CorruptError,
  );
  const quarter = cutSprite(image, r.sprite, { ...r.rect, downscaleMultiplier: 0.25 },
    r.obj.version, false);
  assert.deepEqual([quarter.width, quarter.height], [10, 8]);
  assert.notEqual(stored(quarter), assetStudio(r).rgbaSha256);
});

// --- decodeSprite, end to end with the WASM decoder ------------------------------------

wasmTest(`${VARIANT}: decodeSprite decodes the atlas once and resizes it per sprite`, async () => {
  const env = load([{ name: VARIANT, data: loadFixture(VARIANT) }]);
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  const sprites = env.objects.filter((o) => o.type === ClassID.Sprite);
  assert.equal(sprites.length, 2);
  for (const obj of sprites) {
    const s = VARIANTS.find((x) => x.obj.pathId === obj.pathId)!;
    assert.equal(stored(await decodeSprite(obj, env)), assetStudio(s).rgbaSha256, s.golden.name);
    const cached = await decodeSprite(obj, env, { decodedTextures });
    assert.equal(stored(cached), assetStudio(s).rgbaSha256, s.golden.name);
  }
  assert.equal(decodedTextures.size, 1);
  const [texture] = decodedTextures.values();
  assert.deepEqual([texture!.width, texture!.height], [32, 32]);
});

for (const fixture of FIXTURES) {
  wasmTest(`${fixture}: decodeSprite(obj, env) gives every sprite its expected image`, async () => {
    const env = load([{ name: fixture, data: loadFixture(fixture) }]);
    const expected = new Map(
      SPRITES.filter((s) => s.fixture === fixture).map((s) => [String(s.obj.pathId), s]),
    );
    const sprites = env.objects.filter((o) => o.type === ClassID.Sprite);
    assert.equal(sprites.length, expected.size);
    for (const obj of sprites) {
      const s = expected.get(String(obj.pathId))!;
      const out = await decodeSprite(obj, env);
      assert.equal(stored(out), s.golden.rgbaSha256, s.golden.name);
      const tight = await decodeSprite(obj, env, { tightMesh: true });
      const want = s.golden.tightRgbaSha256 ? tightExpected(s) : s.golden.rgbaSha256;
      assert.equal(stored(tight), want, `${s.golden.name} tightMesh`);
    }
  });
}

// --- split alpha (#152): an Android atlas whose ETC1 textures keep alpha apart ---------

const SPLIT_ALPHA = "editor/2019.4.41f2/split-alpha/sprites";

/** The split-alpha fixture, freshly loaded, its Sprites, and their goldens. */
function splitAlpha(): { env: Env; sprites: { obj: ObjectReader; golden: GoldenSprite }[] } {
  const env = load([{ name: SPLIT_ALPHA, data: loadFixture(SPLIT_ALPHA) }]);
  const [sf] = Object.values(golden(SPLIT_ALPHA).serialized!);
  const sprites = env.objects
    .filter((obj) => obj.type === ClassID.Sprite)
    .map((obj) => ({ obj, golden: sf!.sprites![String(obj.pathId)]! }));
  return { env, sprites };
}

/**
 * A stand-in for a decoded texture, `pixel(x, y)` at each pixel, put into
 * `textures` where `decodeTexture2D`'s image of `texture` would be, so that
 * `decodeSprite` takes it without the WASM decoder (the fixture's textures
 * are ETC1). Its size is `texture`'s, or `size`.
 */
function seed(
  textures: Map<ObjectReader, RgbaImage>,
  texture: ObjectReader,
  pixel: (x: number, y: number) => number[],
  size: { m_Width: number; m_Height: number } = texture.read<Texture2DData>(),
): RgbaImage {
  const { m_Width: width, m_Height: height } = size;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  const image = { data, width, height };
  textures.set(texture, image);
  return image;
}

test("split alpha: the alpha texture's red is the alpha, merged before the cut", async () => {
  const { env, sprites } = splitAlpha();
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  let merged = 0;
  for (const { obj, golden: g } of sprites) {
    const { sprite, rect, texture, alphaTexture } = locateSprite(obj, env);
    if (!alphaTexture) continue;
    // Every colour pixel differs, and its alpha (to be replaced) is 0x55; the
    // alpha texture's red varies, and its other channels are not alpha.
    const colour =
      decodedTextures.get(texture) ??
      seed(decodedTextures, texture, (x, y) => [x, y, (x * y) & 0xff, 0x55]);
    const alpha =
      decodedTextures.get(alphaTexture) ??
      seed(decodedTextures, alphaTexture, (x, y) => [(x * 7 + y * 13) & 0xff, 1, 2, 3]);
    const before = [sha256(colour.data), sha256(alpha.data)];
    // Merged by hand over the whole texture, then cut as any texture is.
    const whole = new Uint8Array(colour.data);
    for (let i = 0; i < whole.length; i += 4) whole[i + 3] = alpha.data[i]!;
    for (const tightMesh of [false, true]) {
      const want = cutSprite({ ...colour, data: whole }, sprite, rect, obj.version, tightMesh);
      const out = await decodeSprite(obj, env, { decodedTextures, tightMesh });
      assert.deepStrictEqual(out, want, `${g.name}, tightMesh ${tightMesh}`);
      assert.equal(out.width, tightMesh ? (g.tightWidth ?? g.width) : g.width, g.name);
    }
    // The caller's entries are still the two textures' own pixels.
    assert.deepStrictEqual([sha256(colour.data), sha256(alpha.data)], before, g.name);
    assert.strictEqual(decodedTextures.get(texture), colour);
    assert.strictEqual(decodedTextures.get(alphaTexture), alpha);
    merged++;
  }
  // Every atlas entry, of two atlases with a colour and an alpha texture each.
  assert.equal(merged, 17);
  assert.equal(decodedTextures.size, 4);
});

test("split alpha in a variant atlas: the merged texture is what is resized", async () => {
  // No editor fixture has both, so r_a's atlas entry gets a downscaleMultiplier of 0.5.
  const { env, sprites } = splitAlpha();
  const { obj } = sprites.find((s) => s.golden.name === "r_a")!;
  const { sprite, rect, texture, alphaTexture } = locateSprite(obj, env);
  assert.equal(rect.downscaleMultiplier, 1);
  const atlasPointer = sprite.m_SpriteAtlas!;
  const atlas = env.resolve(atlasPointer, obj);
  if (atlas.status !== "found") assert.fail("r_a's atlas is in the fixture");
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  const { x, y, width, height } = rect.textureRect;
  const floats = new Float32Array([x, y, width, height]);
  const at = find(atlas.object, file, new Uint8Array(floats.buffer));
  // After textureRect: the multiplier (1.0f) and settingsRaw, within the entry.
  const tail = new Uint8Array(new Float32Array([1, 0]).buffer);
  new DataView(tail.buffer).setUint32(4, rect.settingsRaw, true);
  let multiplier = -1;
  for (let i = at + 16; i < at + 80 && multiplier < 0; i++) {
    if (tail.every((b, k) => file[i + k] === b)) multiplier = i;
  }
  assert.ok(multiplier > 0, "downscaleMultiplier not found after textureRect");
  new DataView(file.buffer, file.byteOffset).setFloat32(multiplier, 0.5, true);
  const variant = locateSprite(obj, env).rect;
  assert.equal(variant.downscaleMultiplier, 0.5);

  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  const colour = seed(decodedTextures, texture, (x, y) => [x * 4, y * 4, 9, 0x55]);
  const alpha = seed(decodedTextures, alphaTexture!, (x, y) => [((x ^ y) * 37) & 0xff, 1, 2, 3]);
  const whole = new Uint8Array(colour.data);
  for (let i = 0; i < whole.length; i += 4) whole[i + 3] = alpha.data[i]!;
  const out = await decodeSprite(obj, env, { decodedTextures });
  const merged = { ...colour, data: whole };
  assert.deepStrictEqual(out, cutSprite(merged, sprite, variant, obj.version, false));
  // Resampled from the merged pixels: not the colour texture's alpha, and not unscaled.
  assert.notDeepStrictEqual(out, cutSprite(colour, sprite, variant, obj.version, false));
  assert.notDeepStrictEqual(out, cutSprite(merged, sprite, rect, obj.version, false));
  // The caller's textures stay as decoded.
  assert.strictEqual(decodedTextures.get(texture), colour);
  assert.equal(colour.data[3], 0x55);
});

test("split alpha: an alpha texture of another size than its texture is refused", async () => {
  const { env, sprites } = splitAlpha();
  const { obj } = sprites.find((s) => s.golden.name === "r_a")!;
  const { texture, alphaTexture } = locateSprite(obj, env);
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  const colour = seed(decodedTextures, texture, () => [1, 2, 3, 255]);
  assert.deepStrictEqual([colour.width, colour.height], [64, 64]);
  seed(decodedTextures, alphaTexture!, () => [9, 9, 9, 255], { m_Width: 32, m_Height: 64 });
  await assert.rejects(
    decodeSprite(obj, env, { decodedTextures }),
    (err: unknown) =>
      err instanceof UnsupportedError &&
      err.kind === "sprite alpha texture size" &&
      err.found === "32 x 64" &&
      err.message.includes(`"r_a" (path id ${obj.pathId})'s texture is 64 x 64`),
  );
});

wasmTest(`${SPLIT_ALPHA}: decodeSprite gives every sprite its golden, alpha merged`, async () => {
  const { env, sprites } = splitAlpha();
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  let merged = 0;
  for (const { obj, golden: g } of sprites) {
    const out = await decodeSprite(obj, env);
    assert.equal(stored(out), g.rgbaSha256, g.name);
    // The same through the caller's textures, each decoded once.
    assert.deepStrictEqual(await decodeSprite(obj, env, { decodedTextures }), out, g.name);
    // Only where UnityPy and AssetStudio agree on the mesh: no AssetStudio
    // hashes were made of this fixture's pixels.
    if (!g.tightOracleNote) {
      const tight = await decodeSprite(obj, env, { tightMesh: true });
      assert.equal(stored(tight), g.tightRgbaSha256 ?? g.rgbaSha256, `${g.name} tightMesh`);
    }
    if (locateSprite(obj, env).alphaTexture) merged++;
  }
  assert.equal(merged, 17);
  // Two atlases' colour and alpha textures, the sheet and tight: each entry
  // is its Texture2D's own image, the colour textures' alpha not merged in.
  assert.equal(decodedTextures.size, 6);
  for (const [texture, image] of decodedTextures) {
    assert.deepStrictEqual(image, await decodeTexture2D(texture.read<Texture2DData>()));
  }
});

wasmTest("decodeSprite refuses a sprite that is not one of the env's objects", async () => {
  const other = load([{ name: FIXTURES[1]!, data: loadFixture(FIXTURES[1]!) }]);
  await assert.rejects(decodeSprite(base.obj, other), /was not loaded by this env/);
});
