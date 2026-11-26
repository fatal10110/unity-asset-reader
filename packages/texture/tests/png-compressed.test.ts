import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { ClassID, load, type Texture2DData } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { encodePng, encodePngCompressed } from "../src/index.js";

// Same rule as png.test.ts: the fixture comparison needs the WASM decoder.
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

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read an 8-bit RGBA, non-interlaced PNG of chunks IHDR, IDAT, IEND back to its
 * pixels, top row first: every chunk CRC checked with node:zlib, IDAT inflated
 * by node:zlib (which checks the zlib header and Adler-32), rows unfiltered.
 * Filter types 0 (None), 1 (Sub) and 2 (Up) are accepted, the ones
 * `encodePngCompressed` writes; any other byte is a bug.
 */
function readPng(png: Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
  filters: number[];
} {
  assert.deepEqual([...png.subarray(0, 8)], SIGNATURE, "PNG signature");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0]!.data;
  assert.equal(ihdr.length, 13);
  const header = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]);
  assert.equal(chunks[2]!.data.length, 0);

  const raw = new Uint8Array(inflateSync(chunks[1]!.data));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height, "inflated size");
  const rgba = new Uint8Array(stride * height);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    assert.ok(type <= 2, `row ${y} filter type ${type}`);
    filters.push(type);
    for (let i = 0; i < stride; i++) {
      const left = i < 4 ? 0 : rgba[y * stride + i - 4]!;
      const above = y === 0 ? 0 : rgba[(y - 1) * stride + i]!;
      const predictor = type === 1 ? left : type === 2 ? above : 0;
      rgba[y * stride + i] = raw[y * (stride + 1) + 1 + i]! + predictor;
    }
  }
  return { width, height, rgba, filters };
}

/** A `width x height` image whose bytes differ from position to position. */
function pattern(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  return data;
}

/** Deterministic noise, so a row matches neither its left neighbour nor itself shifted. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** Both encoders' PNGs of one image decode to the image itself. */
async function assertSamePixels(data: Uint8Array, width: number, height: number) {
  const plain = readPng(encodePng({ data, width, height }));
  const packed = readPng(await encodePngCompressed({ data, width, height }));
  assert.equal(packed.width, width);
  assert.equal(packed.height, height);
  assert.deepEqual(packed.rgba, plain.rgba);
  assert.deepEqual(packed.rgba, data);
  return packed;
}

// --- the encoder on hand-built images ------------------------------------------

test("encodePngCompressed writes a PNG with encodePng's pixels", async () => {
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const png = await encodePngCompressed({ data, width: 2, height: 2 });
  assert.ok(png instanceof Uint8Array);
  await assertSamePixels(data, 2, 2);
  await assertSamePixels(pattern(7, 5), 7, 5);
  await assertSamePixels(noise(13 * 11 * 4, 3), 13, 11);
});

test("encodePngCompressed handles 1 x N and N x 1 images", async () => {
  await assertSamePixels(pattern(1, 1), 1, 1);
  await assertSamePixels(pattern(1, 37), 1, 37);
  await assertSamePixels(pattern(37, 1), 37, 1);
});

test("encodePngCompressed handles image data past one 65535-byte stored block", async () => {
  // 200 x 100: (200 * 4 + 1) * 100 = 80100 bytes of filtered rows.
  await assertSamePixels(pattern(200, 100), 200, 100);
  await assertSamePixels(noise(200 * 100 * 4, 7), 200, 100);
});

test("encodePngCompressed is smaller than encodePng for a typical image", async () => {
  // A 256 x 256 atlas: a gradient, a flat area and transparent padding.
  const width = 256;
  const height = 256;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x < 128) data.set([x * 2, y, 255 - y, 255], i);
      else if (y < 128) data.set([40, 90, 200, 255], i);
    }
  }
  const plain = encodePng({ data, width, height });
  const packed = await encodePngCompressed({ data, width, height });
  assert.ok(
    packed.length * 10 < plain.length,
    `compressed ${packed.length} bytes, stored ${plain.length}`,
  );
  await assertSamePixels(data, width, height);
});

test("encodePngCompressed filters each row with None, Sub or Up, whichever is smaller", async () => {
  // All zeros: every filter leaves zeros, and a tie keeps None.
  assert.deepEqual((await assertSamePixels(new Uint8Array(16 * 3 * 4), 16, 3)).filters, [0, 0, 0]);

  // A checkerboard of pixels 0 and 2: None leaves half the bytes at 2, Sub and Up
  // leave every byte at -2 or 2.
  const small = new Uint8Array(16 * 3 * 4);
  for (let i = 0; i < small.length; i++) small[i] = ((i >> 2) + (i >> 6)) % 2 === 0 ? 0 : 2;
  assert.deepEqual((await assertSamePixels(small, 16, 3)).filters, [0, 0, 0]);

  // One noise row repeated: the first row has no row above, Up is all zeros after it.
  const row = noise(16 * 4, 2);
  const repeated = new Uint8Array(16 * 3 * 4);
  for (let y = 0; y < 3; y++) repeated.set(row, y * 16 * 4);
  assert.deepEqual((await assertSamePixels(repeated, 16, 3)).filters, [0, 2, 2]);

  // A left-to-right ramp starting at a different noise value each row: Sub.
  const ramps = new Uint8Array(16 * 3 * 4);
  const starts = noise(3 * 4, 5);
  for (let y = 0; y < 3; y++) {
    for (let i = 0; i < 16 * 4; i++) ramps[y * 64 + i] = starts[y * 4 + (i % 4)]! + (i >> 2) * 3;
  }
  assert.deepEqual((await assertSamePixels(ramps, 16, 3)).filters, [1, 1, 1]);

  // A flat image: Sub (row 0, only the first pixel is a residual), then Up (all zeros).
  const flat = new Uint8Array(8 * 3 * 4).fill(200);
  assert.deepEqual((await assertSamePixels(flat, 8, 3)).filters, [1, 2, 2]);
});

test("encodePngCompressed does not modify its input, and accepts a subarray", async () => {
  const backing = pattern(5, 4);
  const data = backing.subarray(4, 4 + 4 * 3 * 4);
  const copy = data.slice();
  const image = readPng(await encodePngCompressed({ data, width: 4, height: 3 }));
  assert.deepEqual(image.rgba, copy);
  assert.deepEqual(data, copy);
});

test("encodePngCompressed rejects what encodePng throws on", async () => {
  const cases: [Parameters<typeof encodePng>[0], typeof TypeError, RegExp][] = [
    [
      { data: [1, 2, 3, 4] as unknown as Uint8Array, width: 1, height: 1 },
      TypeError,
      /^encodePngCompressed: image.data must be a Uint8Array, got Array$/,
    ],
    [{ data: new Uint8Array(4), width: 1.5, height: 1 }, TypeError, /is not an integer size/],
    [{ data: new Uint8Array(0), width: 0, height: 0 }, RangeError, /outside 1 to 2147483647/],
    [{ data: new Uint8Array(4), width: 2 ** 31, height: 1 }, RangeError, /outside 1 to/],
    [
      { data: new Uint8Array(15), width: 2, height: 2 },
      RangeError,
      /^encodePngCompressed: image data is 15 bytes, 2 x 2 RGBA needs 16$/,
    ],
  ];
  for (const [image, type, message] of cases) {
    const result = encodePngCompressed(image);
    assert.ok(result instanceof Promise, "rejects, does not throw synchronously");
    await assert.rejects(result, (error: Error) => {
      assert.ok(error instanceof type, `${error.name}: ${error.message}`);
      assert.match(error.message, message);
      return true;
    });
    assert.throws(() => encodePng(image), type);
  }
});

// --- every fixture Texture2D against AssetStudio's PNG export (#233) -----------

interface ExportEntry {
  class: string;
  input: { name: string };
  png?: { width: number; height: number; rgbaSha256: string };
}

const exportGoldens = JSON.parse(
  readFileSync(new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url), "utf8"),
) as { fixtures: Record<string, Record<string, Record<string, ExportEntry>>> };

const exported = Object.entries(exportGoldens.fixtures).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, objects]) =>
    Object.entries(objects)
      .filter(([, entry]) => entry.class === "Texture2D" && entry.png)
      .map(([pathId, entry]) => ({ fixture, file, pathId, entry })),
  ),
);

test(
  "encodePngCompressed of every fixture Texture2D AssetStudio exports holds AssetStudio's PNG pixels",
  { skip },
  async () => {
    assert.ok(exported.length > 0);
    const envs = new Map<string, ReturnType<typeof load>>();
    for (const { fixture, file, pathId, entry } of exported) {
      const where = `${fixture} ${file} ${pathId} (${entry.input.name})`;
      let env = envs.get(fixture);
      if (!env) envs.set(fixture, (env = load([{ name: fixture, data: loadFixture(fixture) }])));
      const obj = env.objects.find(
        (o) => o.fileName === file && o.pathId === BigInt(pathId) && o.type === ClassID.Texture2D,
      );
      assert.ok(obj, `${where}: not in the fixture`);
      const decoded = await decodeTexture2D(obj.read<Texture2DData>());
      const image = readPng(await encodePngCompressed(decoded));
      assert.equal(image.width, entry.png!.width, where);
      assert.equal(image.height, entry.png!.height, where);
      assert.equal(sha256(image.rgba), entry.png!.rgbaSha256, where);
    }
  },
);
