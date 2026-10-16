import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

test("the ESM entry point exports shaderToText via import()", async () => {
  assert.equal(typeof (await import(dist("index.mjs"))).shaderToText, "function");
});

test("the CJS entry point exports shaderToText via require()", () => {
  assert.equal(typeof require(dist("index.cjs")).shaderToText, "function");
});

test("the published tarball holds dist, LICENSE, LICENSE-BSD, NOTICE and README only", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const files: string[] = JSON.parse(result.stdout)[0].files.map((f: { path: string }) => f.path);
  assert.deepStrictEqual(
    files.filter((path) => !path.startsWith("dist/")).sort(),
    ["LICENSE", "LICENSE-BSD", "NOTICE", "README.md", "package.json"],
  );
  assert.deepStrictEqual(
    files.filter((path) => path.endsWith(".tsbuildinfo") || /(?<!\.d)\.ts$/.test(path)),
    [],
  );
});

test("package.json names both licenses", () => {
  // Scanners read this field, not NOTICE: the BSD-2-Clause disassembler must show here.
  assert.strictEqual(require("../package.json").license, "MIT AND BSD-2-Clause");
});
