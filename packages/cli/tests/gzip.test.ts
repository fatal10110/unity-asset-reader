// The CLI reads a gzip-wrapped file through loadPath(), which unwraps it (#348).

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { cli, EDITOR, fixture, tempDir } from "./helpers.js";

test("ls --json lists a gzip-wrapped bundle as the bundle inside", () => {
  const bundle = fixture(`${EDITOR}/lz4/texture`);
  const wrapped = join(tempDir(), "texture.gz");
  writeFileSync(wrapped, gzipSync(readFileSync(bundle)));

  const fromGzip = cli("ls", wrapped, "--json");
  const plain = cli("ls", bundle, "--json");
  assert.equal(fromGzip.status, 0, fromGzip.stderr);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(JSON.parse(plain.stdout).length > 0);
  assert.deepEqual(JSON.parse(fromGzip.stdout), JSON.parse(plain.stdout));
});
