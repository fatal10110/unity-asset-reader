import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { ClassID, load, type Texture2DData } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { encodePng } from "../src/index.js";

// Same rule as decode.test.ts: the fixture comparison needs the WASM decoder,
// which only the CI job that builds it has; REQUIRE_WASM=1 there turns a
// missing build into a failure.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the PNG fixture tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

// --- a PNG reader built on node:zlib, independent of the encoder -------------

interface Chunk {
  type: string;
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Split a PNG into its chunks, checking the signature and every chunk's CRC with node:zlib. */
function chunks(png: Uint8Array): Chunk[] {
  assert.deepEqual([...png.subarray(0, 8)], SIGNATURE, "PNG signature");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = crc32(png.subarray(at + 4, at + 8 + length));
    assert.equal(view.getUint32(at + 8 + length), crc, `${type} CRC`);
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
}

/**
 * Read an 8-bit RGBA, non-interlaced PNG back to its pixels, top row first:
 * IDAT inflated by node:zlib (which checks the zlib header and Adler-32), rows
 * unfiltered. Only filter type 0 is accepted: it is the only one `encodePng`
 * writes (#234), so any other byte is a bug.
 */
function readPng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const all = chunks(png);
  assert.deepEqual(all.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = all[0]!.data;
  assert.equal(ihdr.length, 13);
  const header = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  // Bit depth 8, colour type 6 (RGBA), compression 0, filter method 0, no interlace.
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]);
  assert.equal(all[2]!.data.length, 0);

  const raw = new Uint8Array(inflateSync(all[1]!.data));
  const line = width * 4 + 1;
  assert.equal(raw.length, line * height, "inflated size");
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * line], 0, `row ${y} filter type`);
    rgba.set(raw.subarray(y * line + 1, (y + 1) * line), y * width * 4);
  }
  return { width, height, rgba };
}

/** The stored deflate blocks of a PNG's zlib stream: `[BFINAL, BTYPE, LEN]` each. */
function deflateBlocks(png: Uint8Array): [number, number, number][] {
  const zlib = chunks(png)[1]!.data;
  const view = new DataView(zlib.buffer, zlib.byteOffset, zlib.byteLength);
  const out: [number, number, number][] = [];
  let at = 2;
  for (;;) {
    const head = zlib[at]!;
    const length = view.getUint16(at + 1, true);
    assert.equal(view.getUint16(at + 3, true), ~length & 0xffff, "NLEN");
    out.push([head & 1, (head >> 1) & 3, length]);
    at += 5 + length;
    if (head & 1) break;
  }
  assert.equal(at + 4, zlib.length, "Adler-32 follows the last block");
  return out;
}

/** A `width x height` image whose bytes differ from position to position. */
function pattern(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  return data;
}

// --- the encoder on hand-built images ------------------------------------------

test("encodePng writes an 8-bit RGBA PNG of the pixels, rows in the order given", () => {
  // Top row red, green; bottom row blue, half-transparent white.
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const png = encodePng({ data, width: 2, height: 2 });
  assert.ok(png instanceof Uint8Array);
  const image = readPng(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.deepEqual(image.rgba, data);
  // The well-known IEND chunk, CRC included.
  assert.deepEqual(
    [...png.subarray(png.length - 12)],
    [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
  );
  // zlib header 0x78 0x01 and one final stored block: the file is the pixels plus framing.
  assert.deepEqual([...chunks(png)[1]!.data.subarray(0, 2)], [0x78, 0x01]);
  assert.deepEqual(deflateBlocks(png), [[1, 0, 18]]);
  assert.equal(png.length, 8 + 25 + 12 + 2 + 5 + 18 + 4 + 12);
});

test("encodePng does not modify its input, and accepts a subarray", () => {
  const backing = pattern(5, 4);
  const data = backing.subarray(4, 4 + 4 * 3 * 4);
  const copy = data.slice();
  const image = readPng(encodePng({ data, width: 4, height: 3 }));
  assert.deepEqual(image.rgba, copy);
  assert.deepEqual(data, copy);
});

test("encodePng splits the image data into stored blocks of at most 65535 bytes", () => {
  // 64 x 255: (64 * 4 + 1) * 255 = 65535 bytes, exactly one full block.
  assert.deepEqual(deflateBlocks(encodePng({ data: pattern(64, 255), width: 64, height: 255 })), [
    [1, 0, 65535],
  ]);
  // 64 x 256: the second block starts on row 255's filter byte.
  const exact = pattern(64, 256);
  const png = encodePng({ data: exact, width: 64, height: 256 });
  assert.deepEqual(deflateBlocks(png), [[0, 0, 65535], [1, 0, 257]]);
  assert.deepEqual(readPng(png).rgba, exact);
  // 300 x 200: block boundaries inside rows, 4 blocks.
  const big = pattern(300, 200);
  const many = encodePng({ data: big, width: 300, height: 200 });
  assert.deepEqual(
    deflateBlocks(many).map(([final, type]) => [final, type]),
    [[0, 0], [0, 0], [0, 0], [1, 0]],
  );
  assert.deepEqual(readPng(many).rgba, big);
});

test("encodePng writes a 1-pixel-wide and a 1-pixel-high image", () => {
  for (const [width, height] of [[1, 17500], [9000, 1]] as const) {
    const data = pattern(width, height);
    const image = readPng(encodePng({ data, width, height }));
    assert.equal(image.width, width);
    assert.equal(image.height, height);
    assert.deepEqual(image.rgba, data);
  }
});

test("encodePng refuses a 0x0 image: a PNG has at least one pixel", () => {
  // A dynamic font's "Font Texture" decodes to this (#139); AssetStudio exports nothing for it.
  for (const [width, height] of [[0, 0], [0, 4], [4, 0]] as const) {
    assert.throws(
      () => encodePng({ data: new Uint8Array(0), width, height }),
      (e: unknown) => e instanceof RangeError && /outside 1 to 2147483647/.test(e.message),
    );
  }
});

test("encodePng refuses image data that is not width * height * 4 bytes", () => {
  for (const length of [15, 17, 0]) {
    assert.throws(
      () => encodePng({ data: new Uint8Array(length), width: 2, height: 2 }),
      (e: unknown) =>
        e instanceof RangeError &&
        e.message === `encodePng: image data is ${length} bytes, 2 x 2 RGBA needs 16`,
    );
  }
});

test("encodePng refuses a size past the PNG limits", () => {
  assert.throws(
    () => encodePng({ data: new Uint8Array(0), width: 2 ** 31, height: 1 }),
    RangeError,
  );
  // 23171 x 23171 RGBA is more than one 2^31 - 1 byte chunk, refused before
  // anything is allocated; a stand-in with only a length, so the test allocates nothing either.
  const side = 23171;
  const fake = { length: side * side * 4 } as unknown as Uint8Array;
  Object.setPrototypeOf(fake, Uint8Array.prototype);
  assert.throws(
    () => encodePng({ data: fake, width: side, height: side }),
    (e: unknown) => e instanceof RangeError && /more than one PNG chunk holds/.test(e.message),
  );
});

test("encodePng refuses an image that is not an RgbaImage, with a TypeError", () => {
  const bad = [
    { data: [0, 0, 0, 0], width: 1, height: 1 },
    { data: new Uint8ClampedArray(4), width: 1, height: 1 },
    { data: new Uint8Array(4), width: 1.5, height: 1 },
    { data: new Uint8Array(4), width: 1, height: Number.NaN },
    { data: new Uint8Array(4), width: "1", height: 1 },
  ];
  for (const image of bad) {
    assert.throws(() => encodePng(image as never), TypeError, JSON.stringify(image));
  }
});

// --- every fixture Texture2D against AssetStudio's PNG export (#233) -----------

interface ExportEntry {
  class: string;
  input: { name: string; format: number; width: number; height: number };
  png?: { width: number; height: number; rgbaSha256: string };
  exportError?: string;
}

const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"));
const exportGoldens = fixtureJson("assetstudio-export-goldens.json") as {
  revision: string;
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
};
const modernGoldens = fixtureJson("modern-goldens.json") as {
  fixtures: Record<string, { serialized: Record<string, { formatVersion: number }> }>;
};

const textures = Object.entries(exportGoldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Texture2D")
      .map(([pathId, entry]) => ({ fixture, file, pathId, entry })),
  ),
);
const exported = textures.filter((t) => t.entry.png);

test("the export goldens are AssetStudio c37af7d's and hold Texture2D PNGs", () => {
  assert.equal(exportGoldens.revision, "c37af7dfcdafee93e33b5da9f0285c97998d6ae3");
  assert.ok(exported.length > 0);
});

test(
  "encodePng of every fixture Texture2D AssetStudio exports holds AssetStudio's PNG pixels",
  { skip },
  async () => {
    const envs = new Map<string, ReturnType<typeof load>>();
    for (const { fixture, file, pathId, entry } of exported) {
      const where = `${fixture} ${file} ${pathId} (${entry.input.name})`;
      let env = envs.get(fixture);
      if (!env) envs.set(fixture, (env = load([{ name: fixture, data: loadFixture(fixture) }])));
      const obj = env.objects.find(
        (o) => o.fileName === file && o.pathId === BigInt(pathId) && o.type === ClassID.Texture2D,
      );
      assert.ok(obj, `${where}: not in the fixture`);
      const image = readPng(encodePng(await decodeTexture2D(obj.read<Texture2DData>())));
      assert.equal(image.width, entry.png!.width, where);
      assert.equal(image.height, entry.png!.height, where);
      assert.equal(sha256(image.rgba), entry.png!.rgbaSha256, where);
    }
  },
);

test("every fixture Texture2D without an AssetStudio PNG has a known reason", () => {
  // Nothing to compare these with (R12): AssetStudio wrote no PNG. Each must be
  // one of the three cases fixtures/BUILDING.md section 17 lists, or the
  // goldens changed and this test needs a look.
  const reasons = new Map<string, number>();
  for (const { fixture, file, entry } of textures.filter((t) => !t.entry.png)) {
    const { exportError = "", input } = entry;
    const where = `${fixture} ${file} (${input.name}): ${exportError}`;
    let reason: string;
    if (/^AssetStudio did not load the object/.test(exportError)) {
      // c37af7d cannot read SerializedFile format 23 (Unity 6000.6), per UnityPy's golden.
      assert.equal(modernGoldens.fixtures[fixture]?.serialized[file]?.formatVersion, 23, where);
      reason = "format 23";
    } else if (exportError === "ExportTexture2D returned false") {
      // A 0x0 dynamic font texture: no pixels, and encodePng refuses a 0x0 image (tested above).
      assert.deepEqual([input.width, input.height], [0, 0], where);
      reason = "0x0";
    } else if (/AssetStudio's enum inserts R16_Alt at 66/.test(exportError)) {
      // AssetStudio decodes the next TextureFormat from 66 on; the method-level
      // AssetStudio references of decode.test.ts stay the verdict for these.
      assert.ok(input.format >= 66 && input.format <= 74, where);
      reason = "R16_Alt";
    } else {
      assert.fail(`unknown reason: ${where}`);
    }
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(reasons), { "format 23": 27, "0x0": 9, R16_Alt: 5 });
  assert.equal(exported.length + 27 + 9 + 5, textures.length);
});
