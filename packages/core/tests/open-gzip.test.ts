// `open()` unwraps gzip before its sync `load()`, which refuses it (#348, D4).

import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { open } from "../src/open.js";

const FIXTURE = "gzip-lz4.bundle.gz";
const gzipped = (data: Uint8Array) => new Uint8Array(gzipSync(data));

/** What `load()` makes of the bundle inside the fixture, for comparison. */
function unwrapped() {
  return load([{ name: "lz4.bundle", data: loadFixture("lz4.bundle") }]);
}

test("open() unwraps the gzip fixture to the env load() gives for the bundle inside", async () => {
  const env = await open([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
  const expected = unwrapped();

  // The bundle's nodes carry their own names; the `.gz` one is not kept.
  assert.deepEqual(env.files.map((f) => f.path), ["CAB-lz4", "CAB-lz4.resS"]);
  assert.deepEqual(env.files, expected.files);
  assert.deepEqual(golden(FIXTURE).files, golden("lz4.bundle").files);
  assert.deepEqual(
    env.objects.map((o) => [String(o.pathId), o.type, o.byteSize]),
    expected.objects.map((o) => [String(o.pathId), o.type, o.byteSize]),
  );
});

test("open() unwraps bytes, a File and a Response alike", async () => {
  const data = loadFixture(FIXTURE);
  const expected = unwrapped().files;
  for (const source of [
    data,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    new File([data], FIXTURE),
    new Response(data),
  ]) {
    assert.deepEqual((await open(source)).files, expected);
  }
});

test("open() keeps unwrapping a doubly wrapped file", async () => {
  const env = await open({ name: `${FIXTURE}.gz`, data: gzipped(loadFixture(FIXTURE)) });
  assert.deepEqual(env.files, unwrapped().files);
});

test("open() keeps the .gz name for a file that unwraps to a leaf", async () => {
  // Upstream re-sniffs the inflated bytes under the same path, so a leaf keeps
  // the wrapper's name.
  const data = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff);
  const env = await open({ name: "a.resS.gz", data: gzipped(data) });
  assert.deepEqual(env.files, [{ path: "a.resS.gz", data }]);
});

test("open() rejects a gzip file that does not inflate, naming it", async () => {
  const data = loadFixture(FIXTURE);
  const truncated = data.subarray(0, data.length - 1);
  await assert.rejects(open({ name: FIXTURE, data: truncated }), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.match(
      error.message,
      new RegExp(`^${FIXTURE.replace(/\./g, "\\.")}: gzip stream of ${truncated.length} bytes`),
    );
    return true;
  });
});

test("open() refuses gzip nested past the depth cap", async () => {
  let data = gzipped(Uint8Array.of(1, 2, 3));
  for (let i = 0; i < 16; i++) data = gzipped(data);

  await assert.rejects(open({ name: "deep.gz", data }), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.strictEqual(error.kind, "container nesting");
    assert.match(error.message, /^deep\.gz: unsupported container nesting: 17/);
    return true;
  });
});
