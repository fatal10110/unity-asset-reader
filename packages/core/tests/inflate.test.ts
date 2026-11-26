import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { golden, loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { brotliDecompress, gunzip, lzhamDecompress, unzlib } from "../src/codec/inflate.js";

/**
 * Vectors are compressed here with `node:zlib` - an implementation independent
 * of the one under test - so a round-trip proves interoperability rather than
 * self-consistency. Test-only `node:*` never reaches `src/` (R4).
 */
const VECTORS: [name: string, data: Uint8Array][] = [
  ["empty", new Uint8Array(0)],
  ["one byte", Uint8Array.of(0x55)],
  ["short ascii", new TextEncoder().encode("UnityFS 5.x.x")],
  ["64 KiB of zeros", new Uint8Array(65536)],
  ["64 KiB pseudo-random", pseudoRandom(65536)],
];

/** Deterministic, badly compressible bytes from a fixed-seed 32-bit LCG. */
function pseudoRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x1234abcd;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const gzipped = (data: Uint8Array) => new Uint8Array(gzipSync(data));
const zlibbed = (data: Uint8Array) => new Uint8Array(deflateSync(data));

/** Same bytes with one byte inverted, so the stream stays structurally plausible. */
function flipByte(data: Uint8Array, index: number): Uint8Array {
  const copy = data.slice();
  copy[index]! ^= 0xff;
  return copy;
}

/** Same bytes followed by `extra`. */
function append(data: Uint8Array, ...extra: number[]): Uint8Array {
  return Uint8Array.from([...data, ...extra]);
}

/** Asserts a rejection with a {@link CorruptError} naming the format and the input size. */
async function rejectsCorrupt(
  promise: Promise<Uint8Array>,
  format: "gzip" | "zlib",
  size: number,
  note?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CorruptError, note);
    const expected = `^${format} stream of ${size} bytes failed to inflate: .+`;
    assert.match(error.message, new RegExp(expected));
    return true;
  }, note);
}

for (const [name, data] of VECTORS) {
  test(`gunzip round-trips ${name}`, async () => {
    assert.deepStrictEqual(await gunzip(gzipped(data)), data);
  });

  test(`unzlib round-trips ${name}`, async () => {
    assert.deepStrictEqual(await unzlib(zlibbed(data)), data);
  });
}

test("gunzip and unzlib return promises: inflating is async (D4)", async () => {
  const pending = gunzip(gzipped(Uint8Array.of(1)));
  assert.ok(pending instanceof Promise);
  assert.ok(unzlib(zlibbed(Uint8Array.of(1))) instanceof Promise);
  await pending;
});

test("gunzip unwraps the real gzip-wrapped bundle fixture", async () => {
  const name = "gzip-lz4.bundle.gz";
  const inner = await gunzip(loadFixture(name));

  // The oracle does not unwrap gzip around a bundle (fixtures/README.md), so
  // the golden describes what is inside: the same UnityFS bundle as lz4.bundle.
  assert.match(golden(name).oracleNote ?? "", /gunzipped with stdlib/);
  assert.strictEqual(new TextDecoder().decode(inner.subarray(0, 7)), "UnityFS");
  assert.strictEqual(sha256(inner), sha256(loadFixture("lz4.bundle")));
  assert.deepStrictEqual(golden(name).files, golden("lz4.bundle").files);
});

test("gunzip rejects a stream that is not gzip", async () => {
  const notGzip = new Uint8Array(32).fill(0x42);
  await rejectsCorrupt(gunzip(notGzip), "gzip", 32);
});

test("gunzip rejects empty input and input too short to hold a header and trailer", async () => {
  await rejectsCorrupt(gunzip(new Uint8Array(0)), "gzip", 0);
  await rejectsCorrupt(gunzip(Uint8Array.of(0x1f, 0x8b, 0x08)), "gzip", 3);
});

test("gunzip rejects truncated streams at every stage", async () => {
  const full = gzipped(pseudoRandom(8192));
  // 10 is the header alone; length - 4 drops ISIZE, length - 1 its last byte.
  for (const cut of [10, 18, Math.floor(full.length / 2), full.length - 4, full.length - 1]) {
    await rejectsCorrupt(gunzip(full.subarray(0, cut)), "gzip", cut, `cut at ${cut}`);
  }
});

test("gunzip rejects a corrupted deflate payload instead of returning garbage", async () => {
  // fflate inflated this one to wrong bytes of the right length; only the
  // CRC32 trailer catches it (R9).
  const full = gzipped(pseudoRandom(4096));
  await rejectsCorrupt(gunzip(flipByte(full, 15)), "gzip", full.length);
});

test("gunzip rejects a CRC32 trailer that disagrees with the output", async () => {
  const full = gzipped(pseudoRandom(4096));
  // CRC32 is the four bytes before ISIZE, little-endian.
  await rejectsCorrupt(gunzip(flipByte(full, full.length - 8)), "gzip", full.length);
});

test("gunzip rejects a trailer whose length disagrees with the output", async () => {
  const full = gzipped(pseudoRandom(4096));
  const bad = full.slice();
  bad[bad.length - 1]! ^= 0x01; // ISIZE is the last four bytes, little-endian
  await rejectsCorrupt(gunzip(bad), "gzip", full.length);
});

test("gunzip rejects bytes after the end of the stream", async () => {
  const full = gzipped(pseudoRandom(1024));
  await rejectsCorrupt(gunzip(append(full, 1, 2, 3)), "gzip", full.length + 3);
});

test("unzlib rejects empty input and input too short to hold a header and trailer", async () => {
  await rejectsCorrupt(unzlib(new Uint8Array(0)), "zlib", 0);
  await rejectsCorrupt(unzlib(Uint8Array.of(0x78, 0x9c, 0x03)), "zlib", 3);
});

test("unzlib rejects truncated streams, including one cut to its header", async () => {
  const full = zlibbed(pseudoRandom(8192));
  // Cut to its 2-byte header or to six bytes, fflate returned zero bytes
  // rather than throwing (R9).
  for (const cut of [2, 6, Math.floor(full.length / 2), full.length - 1]) {
    await rejectsCorrupt(unzlib(full.subarray(0, cut)), "zlib", cut, `cut at ${cut}`);
  }
});

test("unzlib rejects a corrupted deflate payload instead of returning garbage", async () => {
  const full = zlibbed(pseudoRandom(4096));
  await rejectsCorrupt(unzlib(flipByte(full, Math.floor(full.length / 2))), "zlib", full.length);
});

test("unzlib rejects an Adler-32 trailer that disagrees with the output", async () => {
  const full = zlibbed(pseudoRandom(4096));
  await rejectsCorrupt(unzlib(flipByte(full, full.length - 1)), "zlib", full.length);
});

test("unzlib rejects a stream with a broken zlib header", async () => {
  const full = zlibbed(pseudoRandom(1024));
  await rejectsCorrupt(unzlib(flipByte(full, 0)), "zlib", full.length);
});

test("unzlib rejects bytes after the end of the stream", async () => {
  const full = zlibbed(pseudoRandom(1024));
  await rejectsCorrupt(unzlib(append(full, 1, 2, 3)), "zlib", full.length + 3);
});

test("brotli input throws UnsupportedError naming brotli", () => {
  const brotli = new Uint8Array(brotliCompressSync(pseudoRandom(1024)));
  assert.throws(() => brotliDecompress(brotli), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.ok(!(error instanceof CorruptError));
    assert.strictEqual(error.kind, "compression type");
    assert.strictEqual(error.found, "brotli");
    assert.match(error.message, /unsupported compression type: brotli \(.+open an issue.*\)/);
    return true;
  });
});

test("LZHAM input throws UnsupportedError naming LZHAM", () => {
  // No LZHAM encoder exists here; a block of one is all a caller would hand over.
  assert.throws(() => lzhamDecompress(pseudoRandom(64)), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.strictEqual(error.found, "LZHAM");
    assert.match(error.message, /unsupported compression type: LZHAM \(.+\)/);
    return true;
  });
});
