import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CLI } from "./helpers.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the bin is dist/cli.mjs, a node script", () => {
  assert.deepEqual(manifest.bin, { "unity-asset-reader-cli": "dist/cli.mjs" });
  assert.ok(readFileSync(CLI, "utf8").startsWith("#!/usr/bin/env node\n"));
});

test("the packages it uses stay imports in dist/, never inlined (#71)", () => {
  const source = readFileSync(CLI, "utf8");
  const deps = Object.keys(manifest.dependencies);
  assert.equal(deps.length, 6);
  for (const dep of deps) assert.match(source, new RegExp(`from '${dep}';`), dep);
  // Only those and node builtins: nothing undeclared bundled in its place.
  const imported = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);
  for (const spec of imported) {
    assert.ok(deps.includes(spec) || spec.startsWith("node:"), `dist/cli.mjs imports ${spec}`);
  }
});

test("the published tarball holds the bin, LICENSE, NOTICE and README only", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const files: string[] = JSON.parse(result.stdout)[0].files.map((f: { path: string }) => f.path);
  assert.deepStrictEqual(files.sort(), [
    "LICENSE",
    "NOTICE",
    "README.md",
    "dist/cli.mjs",
    "package.json",
  ]);
});
