// loadPath() unwraps gzip itself, sync with node:zlib: core's load() refuses it
// because the platform inflate is async (#348).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { CorruptError, load, UnsupportedError } from "unity-asset-reader";

import { loadFixture } from "../../../fixtures/helpers.js";
import { loadPath } from "../src/index.js";

const FIXTURE = "gzip-lz4.bundle.gz";
const tmp = mkdtempSync(join(tmpdir(), "unity-asset-reader-node-gzip-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Write `files` (name → bytes) into a new folder. */
function folder(name: string, files: Record<string, Uint8Array>): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const [path, data] of Object.entries(files)) writeFileSync(join(root, path), data);
  return root;
}

test("load() refuses the gzip fixture that loadPath() unwraps", () => {
  assert.throws(() => load(loadFixture(FIXTURE)), UnsupportedError);
});

test("loadPath() of a gzip-wrapped bundle gives the env of the bundle inside", () => {
  const root = folder("single", {
    [FIXTURE]: loadFixture(FIXTURE),
    "lz4.bundle": loadFixture("lz4.bundle"),
  });
  const env = loadPath(join(root, FIXTURE));
  const expected = loadPath(join(root, "lz4.bundle"));
  assert.deepEqual(env.files.map((f) => f.path), ["CAB-lz4", "CAB-lz4.resS"]);
  assert.deepEqual(env.files, expected.files);
  assert.equal(env.objects.length, expected.objects.length);
});

test("loadPath() of a folder unwraps every wrapper, keeping a leaf's .gz name", () => {
  const leaf = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff);
  const root = folder("scan", {
    [`${FIXTURE}.gz`]: gzipSync(loadFixture(FIXTURE)),
    "a.resS.gz": gzipSync(leaf),
  });
  const env = loadPath(root);
  // Inputs go in name order: `a.resS.gz` before the bundle.
  assert.deepEqual(env.files.map((f) => f.path), ["a.resS.gz", "CAB-lz4", "CAB-lz4.resS"]);
  assert.deepEqual(env.files[0]!.data, leaf);
});

test("loadPath() refuses a gzip file that does not inflate, naming it", () => {
  const data = loadFixture(FIXTURE);
  const root = folder("corrupt", { [FIXTURE]: data.subarray(0, data.length - 1) });
  assert.throws(() => loadPath(root), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.ok(error.message.startsWith(`${join(root, FIXTURE)}: gzip stream of `), error.message);
    return true;
  });
});

test("loadPath() refuses gzip nested past the depth cap", () => {
  let data: Uint8Array = gzipSync(Uint8Array.of(1, 2, 3));
  for (let i = 0; i < 16; i++) data = gzipSync(data);
  const root = folder("deep", { "deep.gz": data });
  assert.throws(() => loadPath(root), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.match(error.message, /deep\.gz: unsupported container nesting: 17/);
    return true;
  });
});
