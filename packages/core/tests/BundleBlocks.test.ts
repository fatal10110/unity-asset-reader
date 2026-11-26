import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { readBundle, type BundleFile } from "../src/bundle/BundleFile.js";

/** The data block codec ids, `flags & 0x3f`. */
const NONE = 0;
const LZMA = 1;
const LZ4HC = 3;

/** The codecs of a bundle's data blocks, distinct, in block order. */
function codecs(bundle: BundleFile): number[] {
  return [...new Set(bundle.blocks.map(({ flags }) => flags & 0x3f))];
}

/** The blocks decompress to exactly the bytes the directory's nodes span. */
function assertBlocksCoverFiles(bundle: BundleFile): void {
  const total = bundle.blocks.reduce((sum, block) => sum + block.uncompressedSize, 0);
  const end = Math.max(...bundle.files.map(({ data }) => data.byteOffset + data.byteLength));
  assert.ok(bundle.blocks.length > 0);
  assert.equal(end - bundle.files[0]!.data.byteOffset, total);
}

// Expectations from the build options in fixtures/BUILDING.md (2020.3.30f1 editor set):
// ChunkBasedCompression writes LZ4HC data blocks, the default (None) option LZMA, and
// UncompressedAssetBundle stored ones. The header names LZ4HC for all three: it is the blocks
// info's codec, not the data's.
for (const [build, codec] of [
  ["lz4", LZ4HC],
  ["lzma", LZMA],
  ["uncompressed", NONE],
] as const) {
  test(`blocks: the 2020.3.30f1 ${build} build's data blocks are codec ${codec}`, () => {
    const bundle = readBundle(loadFixture(`editor/2020.3.30f1/${build}/texture`));
    assert.deepEqual(codecs(bundle), [codec]);
    assert.equal(bundle.header.flags & 0x3f, LZ4HC);
    assertBlocksCoverFiles(bundle);
    if (codec !== NONE) {
      assert.ok(bundle.blocks.some((b) => b.compressedSize !== b.uncompressedSize));
    } else {
      assert.ok(bundle.blocks.every((b) => b.compressedSize === b.uncompressedSize));
    }
  });
}

test("blocks: a version-stripped padded bundle keeps its blocks", () => {
  const bundle = readBundle(loadFixture("editor/6000.3.25f1/stripped/lz4"));
  assert.deepEqual(codecs(bundle), [LZ4HC]);
  assertBlocksCoverFiles(bundle);
});

test("blocks: a legacy UnityWeb or UnityRaw bundle has none", () => {
  for (const name of ["unityweb-lzma.bundle", "unityraw.bundle"]) {
    assert.deepEqual(readBundle(loadFixture(name)).blocks, [], name);
  }
});
