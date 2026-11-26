// crc32 against an independent CRC-32 (#349): every expected value is Python's
// `zlib.crc32` of the string's UTF-8 bytes, a lone surrogate taken as U+FFFD.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "../src/crc.js";

test("crc32 matches zlib.crc32 on ASCII", () => {
  assert.equal(crc32(""), 0x00000000);
  assert.equal(crc32("a"), 0xe8b7be43);
  assert.equal(crc32("123456789"), 0xcbf43926);
  assert.equal(crc32("Hello"), 0xf7d18982);
  assert.equal(crc32("root/Arm/Hand"), 0x21f3e3d7);
});

test("crc32 matches zlib.crc32 on 2-, 3- and 4-byte UTF-8", () => {
  assert.equal(crc32("é"), 0x0e048d3e);
  assert.equal(crc32("€"), 0x83f2c8d6);
  assert.equal(crc32("日本語"), 0xa80b52e5);
  // U+1F600 as a surrogate pair, encoded as one 4-byte sequence.
  assert.equal(crc32("😀"), 0x054db544);
  assert.equal(crc32("\u{1f600}"), 0x054db544);
});

test("crc32 hashes a lone surrogate as U+FFFD, as .NET encodes it", () => {
  // zlib.crc32("a�b".encode("utf-8"))
  assert.equal(crc32("a\ud800b"), 0xd0b99122);
  assert.equal(crc32("a\udc00b"), 0xd0b99122);
  // zlib.crc32("�".encode("utf-8"))
  assert.equal(crc32("\ud800"), 0x8b7233c9);
  assert.equal(crc32("\udc00"), 0x8b7233c9);
});
