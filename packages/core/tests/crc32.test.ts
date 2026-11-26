import assert from "node:assert/strict";
import { test } from "node:test";

import { crc32 } from "../src/index.js";

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

test("crc32 matches the standard check values", () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(ascii("a")), 0xe8b7be43);
  assert.equal(crc32(ascii("123456789")), 0xcbf43926);
  assert.equal(crc32(ascii("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("crc32 is unsigned", () => {
  // 0xcbf43926 has its top bit set: a signed result would be negative.
  const value = crc32(ascii("123456789"));
  assert.ok(value > 0x7fffffff);
  assert.equal(crc32(Uint8Array.of(0xff, 0xff, 0xff, 0xff)), 0xffffffff);
});

test("crc32 checksums bytes[start..end) only", () => {
  const bytes = ascii("xx123456789yy");
  assert.equal(crc32(bytes, 2, 11), 0xcbf43926);
  assert.equal(crc32(bytes, 2, 5), crc32(bytes.subarray(2, 5)));
  assert.equal(crc32(bytes, 4, 4), 0);
});

test("crc32 defaults start to 0 and end to the length", () => {
  const bytes = ascii("xx123456789");
  assert.equal(crc32(bytes, 2), 0xcbf43926);
  assert.equal(crc32(bytes), crc32(bytes, 0, bytes.length));
});
