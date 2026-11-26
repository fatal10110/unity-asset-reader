import assert from "node:assert/strict";
import { test } from "node:test";

import { diff, type Env } from "unity-asset-reader";
import { loadPath } from "unity-asset-reader-node";

import { cli, fixture } from "./helpers.js";

// Two builds of one project (fixtures/BUILDING.md, the `diff` bundles): v2
// changes `changed.png` and `repainted.png`, removes `removed.png`, adds
// `added.png`, and moves `moved.png` from the bundle `oldname` into `newname`.
// `same.png` and `note.txt` do not change. The expected entries are known by
// construction (R12), as in core's tests/diff.test.ts.
const V1 = fixture("editor/2019.4.41f2/diff/v1");
const V2 = fixture("editor/2019.4.41f2/diff/v2");
const DIRS = "assets/fixtures/diff/";

const EXPECTED = [
  "added AssetBundle newname",
  `added Texture2D ${DIRS}added.png`,
  "modified AssetBundle textures",
  `modified Texture2D ${DIRS}changed.png`,
  `modified Texture2D ${DIRS}repainted.png`,
  "removed AssetBundle oldname",
  `removed Texture2D ${DIRS}removed.png`,
].sort();

/** `<file>/<path id>` of each AssetBundle object of `env`, to its bundle name. */
function bundleNames(env: Env): Map<string, string> {
  const names = new Map<string, string>();
  for (const asset of env.assets()) {
    if (asset.typeName === "AssetBundle") names.set(`${asset.file}/${asset.pathId}`, asset.name);
  }
  return names;
}

test("diff prints one line per entry: change, class, path or file/path id, size, fields", () => {
  const run = cli("diff", V1, V2);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "");
  const bundles = new Map([...bundleNames(loadPath(V1)), ...bundleNames(loadPath(V2))]);
  const lines = run.stdout.trimEnd().split("\n").map((line) => line.split(/ {2,}/));
  assert.equal(lines.length, 7);
  const summary = lines.map(([change, type, where]) => {
    // An AssetBundle object has no container path: it is named by file/path id.
    const name = type === "AssetBundle" ? bundles.get(where!) : where;
    assert.ok(name, `no bundle at ${where}`);
    return `${change} ${type} ${name}`;
  });
  assert.deepEqual(summary.sort(), EXPECTED);

  const line = (path: string): string[] => {
    const found = lines.find((cells) => cells[2] === DIRS + path);
    assert.ok(found, `no line for ${path}`);
    return found;
  };
  // Same texture on both sides of add / remove, so the size moves by its bytes.
  const added = Number(line("added.png")[3]);
  assert.ok(line("added.png")[3]!.startsWith("+") && added > 0);
  assert.equal(Number(line("removed.png")[3]), -added);
  // 32x32 RGBA32 became 64x32 RGB24: 4096 bytes of pixels to 6144.
  assert.equal(line("changed.png")[3], "+2048");
  assert.ok(line("changed.png")[4]!.split(",").includes("m_Width"));
  assert.deepEqual(line("repainted.png").slice(3), ["0", "m_StreamData"]);
});

test("diff --json prints core diff()'s entries without their assets", () => {
  const run = cli("diff", V1, V2, "--json");
  assert.equal(run.status, 1, run.stderr);
  const rows = JSON.parse(run.stdout) as Record<string, unknown>[];
  const expected = diff(loadPath(V1), loadPath(V2)).map((e) => {
    const row: Record<string, unknown> = {
      change: e.change,
      type: e.type,
      name: e.name,
      path: e.path ?? "",
      file: e.file,
      pathId: e.pathId.toString(),
      sizeDelta: e.sizeDelta,
    };
    if (e.fields !== undefined) row.fields = e.fields;
    return row;
  });
  assert.deepEqual(rows, expected);
  const summary = rows.map((r) => `${r.change} ${r.type} ${r.path === "" ? r.name : r.path}`);
  assert.deepEqual(summary.sort(), EXPECTED);
  for (const row of rows) {
    assert.ok(!("before" in row) && !("after" in row));
    assert.match(row.pathId as string, /^-?\d+$/);
  }
});

test("diff of a build with itself prints nothing and exits 0", () => {
  const run = cli("diff", V1, V1);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  const json = cli("diff", V1, V1, "--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), []);
});

test("diff exits 2 on an error: an input it cannot read, or a wrong command line", () => {
  const missing = fixture("editor/2019.4.41f2/diff/missing");
  const run = cli("diff", V1, missing);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.startsWith(`error: ${missing}: `), run.stderr);
  for (const args of [["diff", V1], ["diff", V1, V2, V2], ["diff", V1, V2, "--type", "Mesh"]]) {
    const usage = cli(...args);
    assert.equal(usage.status, 2, args.join(" "));
    assert.match(usage.stderr, /--help for usage/);
  }
});
