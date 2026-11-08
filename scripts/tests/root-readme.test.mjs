// Checks the root README's package guide (#295): it names every package by its npm
// name, says what each one does not do, and the peer setup it describes is the real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

const PACKAGES = ["core", "texture", "node", "mesh", "audio", "spine", "shader", "decoder"];
const manifest = (pkg) => JSON.parse(read(`packages/${pkg}/package.json`));

/** The "Choose your packages" section of the root README, up to the next `##` heading. */
function guide() {
  const readme = read("README.md");
  const start = readme.indexOf("\n## Choose your packages\n");
  assert.notEqual(start, -1, "README.md has a Choose your packages section");
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

test("the package guide names all 8 packages by their npm names", () => {
  const section = guide();
  for (const pkg of PACKAGES) {
    const { name } = manifest(pkg);
    assert.ok(section.includes(`\`${name}\``), `${name} is named in the guide`);
  }
  assert.ok(!section.includes("unity-asset-reader-decoder"), "no stale decoder name");
});

test("each package's guide entry links its README and says what it does not do", () => {
  const section = guide();
  const entries = section.split("\n- **[").slice(1);
  const linked = entries.map((entry) => entry.match(/^[^\]]+\]\(packages\/(\w+)\/README\.md\)/)?.[1]);
  assert.deepEqual([...linked].sort(), [...PACKAGES].sort());
  for (const [i, entry] of entries.entries()) {
    assert.match(entry, /does not/, `${linked[i]} entry says what it does not do`);
  }
});

test("feature packages peer on the core, and the texture package brings the decoder", () => {
  const core = manifest("core").name;
  for (const pkg of ["texture", "node", "mesh", "audio", "spine", "shader"]) {
    assert.ok(manifest(pkg).peerDependencies?.[core], `${pkg} lists ${core} as a peer`);
  }
  assert.ok(manifest("texture").dependencies?.[manifest("decoder").name]);
  assert.equal(manifest("core").peerDependencies, undefined);
  assert.equal(manifest("decoder").peerDependencies, undefined);
  assert.match(guide(), /peer dependency/);
});
