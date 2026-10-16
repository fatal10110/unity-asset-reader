import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
const require = createRequire(import.meta.url);

test("emits dist/index.mjs, dist/index.cjs and dist/index.d.ts", () => {
  for (const file of ["index.mjs", "index.cjs", "index.d.ts"]) {
    assert.ok(existsSync(dist(file)), `missing dist/${file}`);
  }
});

test("the ESM entry point exports meshToObj and meshToGltf via import()", async () => {
  const entry = await import(dist("index.mjs"));
  assert.equal(typeof entry.meshToObj, "function");
  assert.equal(typeof entry.meshToGltf, "function");
});

test("the CJS entry point exports meshToObj and meshToGltf via require()", () => {
  const entry = require(dist("index.cjs"));
  assert.equal(typeof entry.meshToObj, "function");
  assert.equal(typeof entry.meshToGltf, "function");
});

test("gltf-validator is for the tests only: not a dependency, not in dist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.dependencies, undefined);
  assert.deepEqual(manifest.optionalDependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, { "unity-asset-reader": "^1.2.0" });
  assert.ok(manifest.devDependencies["gltf-validator"]);
  for (const file of ["index.mjs", "index.cjs", "index.d.ts"]) {
    const text = readFileSync(dist(file), "utf8");
    // Names only the validator's code holds (comments here mention the validator).
    assert.doesNotMatch(text, /gltf[-_]validator|validateBytes|\bdart\b/i, `dist/${file}`);
  }
});

test("the published tarball holds dist, LICENSE, NOTICE and README only", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const files: string[] = JSON.parse(result.stdout)[0].files.map((f: { path: string }) => f.path);
  assert.deepStrictEqual(
    files.filter((path) => !path.startsWith("dist/")).sort(),
    ["LICENSE", "NOTICE", "README.md", "package.json"],
  );
  assert.deepStrictEqual(
    files.filter((path) => path.endsWith(".tsbuildinfo") || /(?<!\.d)\.ts$/.test(path)),
    [],
  );
});
