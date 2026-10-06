// Sprites packed into a Unity 6000.6 SpriteAtlas (#229). Such an atlas holds
// its sprites itself (`*spriteInstanceData` of each `m_RenderDataMap` entry),
// and a 6000.6 bundle has no Sprite objects for them: `packedSprites` lists
// them, and the image API cuts them out of the atlas texture.
//
// The oracles (R12): UnityPy 1.25.4 exports Sprite objects only, so
// `make-modern-goldens.py` gives its own `get_image_from_sprite` a stand-in
// sprite naming the atlas entry (`packedSprites` in `modern-goldens.json`):
// the crop with the packing flip undone, as the main goldens' `rgbaSha256`.
// UnityPy has no tight image of them, and ignores a variant's
// downscaleMultiplier. So, independently of UnityPy: the fixture's pixels say
// where they are (`fixtures/BUILDING.md` section 12), and the 6000.3 build of
// the same project holds the same sprites as Sprite objects, whose tight
// images AssetStudio's executed `CutImage` gave (`ASSETSTUDIO_RGBA`).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClassID,
  CorruptError,
  load,
  UnsupportedError,
  type Asset,
  type Env,
  type ObjectReader,
  type Sprite,
  type SpriteAtlas,
  type Texture2DData,
} from "unity-asset-reader";
import { golden, loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { convertPlain, type RgbaImage } from "../src/convert.js";
import { initTexture } from "../src/decode.js";
import { decodeImage, imageInfo, images } from "../src/image.js";
import {
  cutSprite,
  decodeSprite,
  findSpriteSource,
  locateSprite,
  packedSprites,
  type PackedSprite,
  type SpriteLocation,
} from "../src/sprite.js";
import { ASSETSTUDIO_RGBA, IMAGE_ID } from "./assetstudio-sprites.js";

// As in sprite.test.ts: without the WASM decoder only the tests that need none
// run; the CI job that builds it sets REQUIRE_WASM=1 so that nothing skips.
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

const FIXTURE = "editor/6000.6.4f1/sprite/sprites";
const VARIANT = "editor/6000.6.4f1/variant/sprites";
/** Atlas V2 builds of the same sprites: their atlases are DXT5, so their pixels need the WASM. */
const V2 = ["editor/6000.6.4f1/sprite-v2/sprites", "editor/6000.6.4f1/sprite-v2-rect/sprites"];
const ALL = [FIXTURE, VARIANT, ...V2];

/** UnityPy's crop of one packed sprite (`make-modern-goldens.py`, `packed_sprite_goldens`). */
interface PackedGolden {
  name: string;
  index: number;
  settingsRaw: number;
  downscaleMultiplier: number;
  width: number;
  height: number;
  rgbaSha256: string;
  oracleNote: string;
  /** A variant entry's: UnityPy ignores the downscale, so the hash is not the answer. */
  variantOracleNote?: string;
}

type ModernSerialized = {
  sprites?: Record<string, { name: string; rgbaSha256: string }>;
  packedSprites?: Record<string, PackedGolden[]>;
};

const MODERN = JSON.parse(
  readFileSync(new URL("../../../fixtures/modern-goldens.json", import.meta.url), "utf8"),
) as { fixtures: Record<string, { serialized: Record<string, ModernSerialized> }> };

/** The fixture's one SerializedFile's goldens. */
function modern(fixture: string): ModernSerialized {
  const files = Object.values(MODERN.fixtures[fixture]!.serialized);
  assert.equal(files.length, 1, fixture);
  return files[0]!;
}

/** The 6000.3 build of the same project: its Sprite objects' goldens, by name. */
const SAME_6000_3 = new Map(
  Object.values(golden("editor/6000.3.25f1/sprite/sprites").serialized!).flatMap((sf) =>
    Object.values(sf.sprites ?? {}).map((g) => [g.name, g] as const),
  ),
);

/** One packed sprite of a fixture, its lookup, its golden and, for an RGBA32 atlas, its texture. */
interface Packed {
  fixture: string;
  env: Env;
  packed: PackedSprite;
  location: SpriteLocation;
  golden: PackedGolden;
  /** The atlas texture as `decodeTexture2D` gives it, without the WASM: RGBA32 atlases only. */
  image: RgbaImage | undefined;
}

/** Every packed sprite of a fixture, in `env.assets()` and `renderDataMap` order. */
function fixturePacked(fixture: string): Packed[] {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const goldens = modern(fixture).packedSprites!;
  return [...env.assets("SpriteAtlas")].flatMap((atlas) => {
    const want = goldens[String(atlas.pathId)]!;
    assert.ok(want, `${fixture}: no packed sprite goldens for atlas ${atlas.pathId}`);
    return packedSprites(atlas).map((packed, i) => {
      const location = locateSprite(packed, env);
      const texture = location.texture.read<Texture2DData>();
      let image: RgbaImage | undefined;
      if (texture.m_TextureFormat === 4) {
        const plain = convertPlain(texture.imageData, texture.m_Width, texture.m_Height, 4);
        image = { ...plain, data: reverseRows(plain.data, plain.width) };
      }
      return { fixture, env, packed, location, golden: want[i]!, image };
    });
  });
}

const PACKED = ALL.flatMap(fixturePacked);
/** The packed sprites whose atlas is RGBA32, so that their pixels need no WASM. */
const PLAIN = PACKED.filter((p) => p.image);

/** Rows reversed back to the order the goldens hash. */
const stored = ({ data, width }: RgbaImage): string => sha256(reverseRows(data, width));

/** `decodeSprite` of a packed sprite, its atlas texture handed in as decoded (no WASM). */
function decodePlain(p: Packed, tightMesh = false): Promise<RgbaImage> {
  const decodedTextures = new Map<ObjectReader, RgbaImage>([[p.location.texture, p.image!]]);
  return decodeSprite(p.packed, p.env, { decodedTextures, tightMesh });
}

// --- listing -----------------------------------------------------------------------

test("packedSprites lists every sprite a 6000.6 atlas holds, as the oracle does", () => {
  const counts: Record<string, number> = {};
  for (const fixture of ALL) {
    const own = PACKED.filter((p) => p.fixture === fixture);
    counts[fixture] = own.length;
    for (const p of own) {
      assert.equal(p.packed.type, "PackedSprite");
      assert.equal(p.packed.name, p.golden.name, fixture);
      assert.equal(p.packed.index, p.golden.index, `${fixture} ${p.golden.name}`);
      assert.equal(p.location.rect.settingsRaw, p.golden.settingsRaw, p.golden.name);
    }
    // The bundle has no Sprite objects for them: those it has are the unpacked ones.
    const env = own[0]!.env;
    const sprites = env.objects
      .filter((o) => o.type === ClassID.Sprite)
      .map((o) => o.read<Sprite>().m_Name);
    for (const name of sprites) assert.ok(!own.some((p) => p.packed.name === name), name);
  }
  assert.deepEqual(counts, { [FIXTURE]: 17, [VARIANT]: 4, [V2[0]!]: 17, [V2[1]!]: 17 });
});

test("packedSprites is [] for an atlas before 6000.6, and refuses what is not an atlas", () => {
  const fixture = "editor/6000.3.25f1/sprite/sprites";
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const atlases = [...env.assets("SpriteAtlas")];
  assert.equal(atlases.length, 2);
  // Their packed sprites are Sprite objects, found as before.
  for (const atlas of atlases) assert.deepEqual(packedSprites(atlas), []);
  const texture = [...env.assets("Texture2D")][0]!;
  assert.throws(
    () => packedSprites(texture as unknown as Asset<"SpriteAtlas">),
    (err: unknown) => err instanceof TypeError && /expected a SpriteAtlas asset/.test(err.message),
  );
});

// --- the pixels, without the WASM: the RGBA32 atlases ---------------------------------

test("the RGBA32 atlases' packed sprites cover the packings, without the WASM", () => {
  const names = (fixture: string) => PLAIN.filter((p) => p.fixture === fixture).length;
  // Every sprite of the V1 build, and the variant's master and half-scale atlases.
  assert.deepEqual([names(FIXTURE), names(VARIANT)], [17, 4]);
  const rotations = new Set(PLAIN.map((p) => (p.golden.settingsRaw >> 2) & 0xf));
  assert.deepEqual([...rotations].sort(), [0, 2, 3]);
  const modes = new Set(PLAIN.map((p) => (p.golden.settingsRaw >> 1) & 1));
  assert.deepEqual([...modes].sort(), [0, 1]);
});

for (const p of PLAIN.filter((x) => !x.golden.variantOracleNote)) {
  test(`${p.fixture} ${p.golden.name}: decodeSprite cuts it to the golden`, async () => {
    const out = await decodePlain(p);
    assert.deepEqual([out.width, out.height], [p.golden.width, p.golden.height]);
    assert.equal(stored(out), p.golden.rgbaSha256);
  });
}

/**
 * Check that every opaque pixel of the sprite's own image lands where it was
 * drawn (sprite.test.ts' `checkOwnPixels`): the crop, the trimmed margin
 * (`textureRectOffset`), the undone packing flip and the top-down order. With
 * `onlyOwn`, also that no pixel of a packed neighbour is left.
 *
 * @returns how many pixels were checked
 */
function checkOwnPixels(p: Packed, out: RgbaImage, onlyOwn: boolean): number {
  const id = IMAGE_ID[p.golden.name]!;
  assert.ok(id !== undefined, p.golden.name);
  const originX = Math.floor(p.location.rect.textureRectOffset.x);
  const originY = Math.floor(p.location.rect.textureRectOffset.y);
  let checked = 0;
  for (let row = 0; row < out.height; row++) {
    for (let x = 0; x < out.width; x++) {
      const at = (row * out.width + x) * 4;
      const [r, g, b, a] = out.data.subarray(at, at + 4);
      if (a !== 255) continue;
      if (b !== ((16 * id + 7) & 0xff)) {
        assert.ok(!onlyOwn, `${p.golden.name}: a pixel of image ${b} at (${x}, ${row})`);
        continue;
      }
      const y = out.height - 1 - row;
      assert.equal(r, (5 * (originX + x) + 3) & 0xff, `${p.golden.name} R at (${x}, ${y})`);
      assert.equal(g, (5 * (originY + y) + 5) & 0xff, `${p.golden.name} G at (${x}, ${y})`);
      checked++;
    }
  }
  return checked;
}

test(`${FIXTURE}: every opaque pixel of a packed sprite is where its image drew it`, async () => {
  let neighbours = 0;
  for (const p of PLAIN.filter((x) => x.fixture === FIXTURE)) {
    const out = await decodePlain(p);
    const own = checkOwnPixels(p, out, false);
    assert.ok(own > 0, p.golden.name);
    // Tight packing puts neighbours inside the rectangle; the mesh leaves none of them.
    const tight = await decodePlain(p, true);
    assert.equal(checkOwnPixels(p, tight, true), own, p.golden.name);
    for (let i = 3; i < out.data.length; i += 4) if (out.data[i] === 255) neighbours++;
    neighbours -= own;
  }
  assert.ok(neighbours > 0, "some rectangles hold a neighbour's pixels");
});

test(`${FIXTURE}: tightMesh masks as AssetStudio masks the 6000.3 sprite`, async () => {
  let assetStudio = 0;
  for (const p of PLAIN.filter((x) => x.fixture === FIXTURE)) {
    const same = SAME_6000_3.get(p.golden.name)!;
    assert.ok(same, `${p.golden.name}: not in the 6000.3 build`);
    const out = await decodePlain(p, true);
    if (((p.golden.settingsRaw >> 1) & 1) === 1) {
      // Packed as a rectangle: no mask.
      assert.equal(stored(out), p.golden.rgbaSha256, p.golden.name);
      continue;
    }
    // AssetStudio's image where UnityPy's differs (`tightOracleNote`), else the oracles agree.
    const want = same.tightOracleNote ? ASSETSTUDIO_RGBA[p.golden.name] : same.tightRgbaSha256;
    assert.ok(want, p.golden.name);
    assert.deepEqual([out.width, out.height], [same.tightWidth, same.tightHeight], p.golden.name);
    assert.equal(stored(out), want, p.golden.name);
    if (same.tightOracleNote) assetStudio++;
  }
  // Every tight mesh of more than a rectangle (and the trimmed p_margin).
  assert.equal(assetStudio, 11);
});

/**
 * The sprite cut with `tightMesh` out of a fully opaque stand-in of its atlas
 * texture: what is left opaque is exactly its mask (in sprite space, packing
 * undone), whatever the atlas' real pixels are. So it needs no WASM for the
 * DXT5 atlases.
 */
function maskOf(p: Packed): { width: number; height: number; alpha: number[] } {
  const { m_Width: width, m_Height: height } = p.location.texture.read<Texture2DData>();
  const opaque = { data: new Uint8Array(width * height * 4).fill(255), width, height };
  const { sprite, rect, version } = p.location;
  const out = cutSprite(opaque, sprite, rect, version, true);
  const alpha = Array.from({ length: out.width * out.height }, (_, i) => out.data[i * 4 + 3]!);
  return { width: out.width, height: out.height, alpha };
}

test("the V2 atlases' masks are those of the same sprites in the V1 build, flips too", () => {
  const v1 = new Map(
    PACKED.filter((p) => p.fixture === FIXTURE).map((p) => [p.golden.name, maskOf(p)]),
  );
  const rotations = new Set<number>();
  let compared = 0;
  for (const p of PACKED.filter((x) => V2.includes(x.fixture))) {
    const what = `${p.fixture} ${p.golden.name}`;
    // Every V2 packed sprite is tight-packed: the mask applies.
    assert.equal((p.golden.settingsRaw >> 1) & 1, 0, what);
    const mask = maskOf(p);
    if (p.golden.name === "r_b") {
      // Verdict: no reference. r_b is rectangle-packed in the V1 and 6000.3 builds, so
      // its 8-vertex V2 mask has nothing to equal. Only checked: it keeps every pixel
      // of r_b's diamond (BUILDING.md section 12's `Pixels`), and clears some corner.
      const { width: w, height: h } = mask;
      for (let row = 0; row < h; row++) {
        for (let x = 0; x < w; x++) {
          const y = h - 1 - row;
          const inside = Math.abs(x + 0.5 - w / 2) / (w / 2) + Math.abs(y + 0.5 - h / 2) / (h / 2);
          if (inside <= 1) assert.equal(mask.alpha[row * w + x], 255, `${what} (${x}, ${y})`);
        }
      }
      assert.ok(mask.alpha.includes(0), `${what}: its mesh is more than its rectangle`);
      continue;
    }
    // The V1 masks are pinned above, to AssetStudio's or UnityPy's (oracles agreeing).
    assert.deepStrictEqual(mask, v1.get(p.golden.name), what);
    rotations.add((p.golden.settingsRaw >> 2) & 0xf);
    compared++;
  }
  // 16 sprites per V2 build; V2 is where a mask runs over FlipHorizontal (p_tri3, p_tri5).
  assert.equal(compared, 32);
  assert.ok(rotations.has(1), "a FlipHorizontal-packed sprite is masked");
});

// --- imageInfo -----------------------------------------------------------------------

test("imageInfo describes a packed sprite from its atlas entry and instance data", () => {
  for (const p of PACKED) {
    const info = imageInfo(p.packed);
    const atlas = p.packed.atlas.reader.read<SpriteAtlas>();
    const entry = atlas.m_RenderDataMap[p.packed.index]![1];
    const instance = entry["*spriteInstanceData"]!;
    const what = `${p.fixture} ${p.golden.name}`;
    assert.equal(info.kind, "Sprite");
    assert.equal(info.name, instance.spriteName);
    assert.equal(info.path, undefined);
    assert.equal(info.pathId, p.packed.atlas.pathId);
    assert.equal(info.file, p.packed.atlas.file);
    assert.deepEqual(info.sprite.rect, instance.rect, what);
    assert.deepEqual(info.sprite.textureRect, entry.textureRect, what);
    assert.deepEqual(info.sprite.pivot, instance.pivot);
    assert.deepEqual(info.sprite.border, instance.border);
    assert.equal(info.sprite.pixelsPerUnit, instance.pixelsToUnits);
    assert.equal(info.sprite.packed, true);
    const mode = ((entry.settingsRaw >> 1) & 1) === 0 ? "tight" : "rectangle";
    assert.equal(info.sprite.packingMode, mode);
    assert.equal(info.sprite.rotation, (entry.settingsRaw >> 2) & 0xf);
    assert.equal(info.sprite.atlas, atlas.m_Name);
    assert.equal(info.sprite.texture.pathId, p.location.texture.pathId);
    // The size it is cut at: UnityPy's crop, but a variant's, which is resized first.
    if (!p.golden.variantOracleNote) {
      assert.deepEqual([info.width, info.height], [p.golden.width, p.golden.height], what);
    }
    assert.equal(imageInfo(p.packed).width, info.width);
  }
});

// --- the variant atlas: resized before the cut (#153) ---------------------------------

/**
 * Mean absolute difference per channel between two images of the same size,
 * over the pixels whose 3x3 neighbourhood is opaque in `master`.
 */
function interiorDifference(out: RgbaImage, master: RgbaImage): number {
  const { width, height } = master;
  let sum = 0;
  let count = 0;
  for (let y = 1; y + 1 < height; y++) {
    for (let x = 1; x + 1 < width; x++) {
      let opaque = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (master.data[((y + dy) * width + x + dx) * 4 + 3] !== 255) opaque = false;
        }
      }
      if (!opaque) continue;
      for (let c = 0; c < 4; c++) {
        const i = (y * width + x) * 4 + c;
        sum += Math.abs(out.data[i]! - master.data[i]!);
      }
      count++;
    }
  }
  assert.ok(count > 0);
  return sum / count / 4;
}

test(`${VARIANT}: a half-scale packed sprite is cut from its atlas resized`, async () => {
  const variant = PLAIN.filter((p) => p.fixture === VARIANT);
  const half = variant.filter((p) => p.golden.variantOracleNote);
  assert.deepEqual(half.map((p) => p.golden.name).sort(), ["r_a", "r_b"]);
  for (const p of half) {
    const master = variant.find(
      (x) => !x.golden.variantOracleNote && x.golden.name === p.golden.name,
    )!;
    assert.equal(p.location.rect.downscaleMultiplier, 0.5);
    assert.deepEqual([p.image!.width, p.image!.height], [32, 32]);
    const out = await decodePlain(p);
    // AssetStudio's size: the texture resized to 64x64, the rectangle cut out of it.
    assert.deepEqual([out.width, out.height], [p.golden.width, p.golden.height]);
    const info = imageInfo(p.packed);
    const sizes = [info.width, info.height, info.sprite.texture.width];
    assert.deepEqual(sizes, [out.width, out.height, 32]);
    // UnityPy crops the texture unscaled; that is not the answer.
    assert.notEqual(stored(out), p.golden.rgbaSha256);
    // Not bit-exactly checkable (no AssetStudio run of this 6000.6 variant, #230), but
    // the resampled half-scale sprite is the full-scale one, blurred: measured 1.19 (r_a)
    // and 0.41 (r_b) per channel; cut one pixel off, they are 2.59 and 1.81.
    const difference = interiorDifference(out, await decodePlain(master));
    assert.ok(difference < 1.5, `${p.golden.name}: ${difference}`);
  }
  // r_a lies outside the unscaled 32x32 texture: only the resize makes it cuttable.
  const r = half.find((p) => p.golden.name === "r_a")!;
  assert.throws(
    () => cutSprite(r.image!, r.location.sprite, { ...r.location.rect, downscaleMultiplier: 1 },
      r.location.version, false),
    CorruptError,
  );
});

// --- what stays refused (R9) -----------------------------------------------------------

test("a packed sprite whose index is not in its atlas throws CorruptError", async () => {
  const p = PLAIN[0]!;
  const stale: PackedSprite = { ...p.packed, index: 99 };
  const corrupt = (err: unknown) =>
    err instanceof CorruptError && /no packed sprite at renderDataMap index 99/.test(err.message);
  assert.throws(() => imageInfo(stale), corrupt);
  await assert.rejects(decodeSprite(stale, p.env), corrupt);
  assert.throws(
    () => findSpriteSource({ type: "nope" } as unknown as PackedSprite, p.env),
    TypeError,
  );
});

test("tightMesh refuses a packed sprite's indices that are not UInt16", () => {
  const p = PLAIN.find((x) => x.golden.name === "p_tri")!;
  const { sprite, rect, version } = p.location;
  assert.equal(sprite.m_RD.m_IndexFormat, 0);
  const uint32 = { ...sprite, m_RD: { ...sprite.m_RD, m_IndexFormat: 1 } };
  // Only the mask reads the indices.
  cutSprite(p.image!, uint32, rect, version, false);
  assert.throws(
    () => cutSprite(p.image!, uint32, rect, version, true),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "sprite index format" && err.found === 1,
  );
});

/** Little-endian `UInt32`s. */
const words = (...values: number[]): Uint8Array => new Uint8Array(new Uint32Array(values).buffer);

test("split alpha: a packed sprite's entry alpha texture is merged before the cut", async () => {
  // No 6000.6 fixture has an alpha texture (no Android build, BUILDING.md section 13), so
  // the rect atlas' first entry gets one: its alphaTexture pointer, null after its
  // texture pointer, is pointed at that same 64x64 texture.
  const env = load([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
  const atlas = [...env.assets("SpriteAtlas")].find((a) => a.name === "rect")!;
  const [first] = packedSprites(atlas);
  const before = locateSprite(first!, env);
  assert.equal(before.alphaTexture, undefined);
  const texture = before.texture;
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  const { byteStart, byteSize } = atlas.reader;
  const bytes = file.subarray(byteStart, byteStart + byteSize);
  // texture (m_FileID 0, m_PathID), then alphaTexture (0, 0): PPtrs of 12 bytes.
  const pointer = new Uint8Array(24);
  new DataView(pointer.buffer).setBigInt64(4, texture.pathId, true);
  const at = [...bytes.keys()].find((i) => pointer.every((b, k) => bytes[i + k] === b))!;
  assert.ok(at !== undefined, "the first entry's texture pointer");
  new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(at + 16, texture.pathId, true);
  const located = locateSprite(first!, env);
  assert.strictEqual(located.alphaTexture, texture);

  // Its alpha is 0x55; as its own alpha texture, its red (x) becomes the alpha.
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set([i % 64, i >> 6, 9, 0x55], i * 4);
  const image = { data, width: 64, height: 64 };
  const merged = new Uint8Array(data);
  for (let i = 0; i < merged.length; i += 4) merged[i + 3] = merged[i]!;
  const decodedTextures = new Map<ObjectReader, RgbaImage>([[texture, image]]);
  for (const tightMesh of [false, true]) {
    const out = await decodeSprite(first!, env, { decodedTextures, tightMesh });
    const { sprite, rect, version } = located;
    const want = cutSprite({ ...image, data: merged }, sprite, rect, version, tightMesh);
    assert.deepStrictEqual(out, want, `tightMesh ${tightMesh}`);
    assert.notDeepStrictEqual(out, cutSprite(image, sprite, rect, version, tightMesh));
  }
  // The caller's texture stays as decoded.
  assert.strictEqual(decodedTextures.get(texture), image);
  assert.equal(image.data[3], 0x55);
});

test("a Sprite object packed into a 6000.6 atlas is still refused: UnsupportedError", async () => {
  const env = load([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
  const atlas = env.objects.find((o) => o.type === ClassID.SpriteAtlas)!;
  const [guid, id] = atlas.read<SpriteAtlas>().m_RenderDataMap[0]![0];
  // No fixture has one (6000.6 holds packed sprites in the atlas), so point an
  // unpacked one at the atlas' first entry.
  const obj = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === "sheet_a",
  )!;
  const sprite = obj.read<Sprite>();
  assert.equal(sprite.m_SpriteAtlas!.m_PathID, 0n);
  findSpriteSource(obj, env); // readable as it is: its own m_RD

  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  const bytes = file.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  const key = sprite.m_RenderDataKey![0];
  const at = [...bytes.keys()].filter((i) =>
    words(...[0, 1, 2, 3].map((w) => key[`data[${w}]`]!)).every((b, k) => bytes[i + k] === b),
  );
  assert.equal(at.length, 1);
  // m_RenderDataKey (GUID, Int64), m_AtlasTags (empty), then m_SpriteAtlas.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(words(...[0, 1, 2, 3].map((w) => guid[`data[${w}]`]!)), at[0]!);
  view.setBigInt64(at[0]! + 16, id, true);
  assert.equal(view.getInt32(at[0]! + 24, true), 0);
  view.setBigInt64(at[0]! + 32, atlas.pathId, true);
  const packed = obj.read<Sprite>();
  assert.equal(packed.m_SpriteAtlas!.m_PathID, atlas.pathId);
  assert.equal(packed.m_RenderDataKey![1], id);

  const refused = (err: unknown) =>
    err instanceof UnsupportedError &&
    err.kind === "Unity version" &&
    err.found === "6000.6.4f1" &&
    /Sprite object packed into a 6000\.6 SpriteAtlas is not supported/.test(err.message);
  assert.throws(() => findSpriteSource(obj, env), refused);
  await assert.rejects(decodeSprite(obj, env), refused);
  const asset = [...env.assets("Sprite")].find((a) => a.pathId === obj.pathId)!;
  assert.throws(() => imageInfo(asset), refused);
  await assert.rejects(decodeImage(asset), refused);
});

// --- end to end with the WASM decoder ---------------------------------------------------

for (const fixture of ALL) {
  wasmTest(`${fixture}: images() lists the Sprites and every packed sprite, decoded`, async () => {
    const env = load([{ name: fixture, data: loadFixture(fixture) }]);
    const goldens = modern(fixture);
    const packed = PACKED.filter((p) => p.fixture === fixture);
    const seen: string[] = [];
    for await (const image of images(env)) {
      if (image.kind !== "Sprite") continue;
      const sprite = Object.entries(goldens.sprites ?? {}).find(
        ([pathId]) => pathId === String(image.pathId),
      );
      if (sprite) {
        // A Sprite object of the bundle (the sheet, the unpacked tight sprite).
        assert.equal(sha256(reverseRows(image.rgba, image.width)), sprite[1].rgbaSha256);
        continue;
      }
      const key = (x: Packed) => `${x.packed.atlas.pathId} ${x.packed.index}`;
      const p = packed.find((x) => x.packed.atlas.pathId === image.pathId &&
        x.golden.name === image.name && !seen.includes(key(x)));
      assert.ok(p, `${fixture}: ${image.name} is not a packed sprite`);
      seen.push(key(p));
      const hash = sha256(reverseRows(image.rgba, image.width));
      if (p.golden.variantOracleNote) {
        // UnityPy ignores the downscale: the same resize as without the WASM.
        assert.equal(hash, stored(await decodePlain(p)), p.golden.name);
      } else {
        assert.equal(hash, p.golden.rgbaSha256, `${fixture} ${p.golden.name}`);
      }
    }
    assert.equal(seen.length, packed.length);
  });
}
