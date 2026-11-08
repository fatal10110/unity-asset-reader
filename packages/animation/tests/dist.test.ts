import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
const require = createRequire(import.meta.url);

test("emits dist/index.mjs, dist/index.cjs and dist/index.d.ts", () => {
  for (const file of ["index.mjs", "index.cjs", "index.d.ts"]) {
    assert.ok(existsSync(dist(file)), `missing dist/${file}`);
  }
});

test("both entry points export clipCurves and muscleName", async () => {
  for (const entry of [await import(dist("index.mjs")), require(dist("index.cjs"))]) {
    assert.equal(typeof entry.clipCurves, "function");
    assert.equal(typeof entry.muscleName, "function");
  }
});

test("no runtime dependency: core is a peer at the first release with the readers", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, { "unity-asset-reader": "^1.3.0" });
});
