import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readBundle, readTypeTree } from "unity-asset-reader";
import { loadPath } from "unity-asset-reader-node";

import { cli, EDITOR, fixture, tempDir } from "./helpers.js";

/** The 2020.3.30f1 lz4 builds: nine bundles, textures, audio, a mesh, a TextAsset, a font. */
const LZ4_DIR = fixture(`${EDITOR}/lz4`);
const TEXTURE_BUNDLE = fixture(`${EDITOR}/lz4/texture`);

/** The core README's replacer: bigint to decimal, bytes to hex. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return value;
}

test("ls --json lists every object as env.assets() gives it", () => {
  const run = cli("ls", LZ4_DIR, "--json");
  assert.equal(run.status, 0, run.stderr);
  const expected = [...loadPath(LZ4_DIR).assets()].map((asset) => ({
    type: asset.typeName,
    name: asset.name,
    path: asset.path ?? "",
    pathId: asset.pathId.toString(),
    size: asset.byteSize,
    file: asset.file,
  }));
  assert.ok(expected.length > 20);
  assert.ok(expected.some((row) => row.path !== ""), "no container path to compare");
  assert.deepEqual(JSON.parse(run.stdout), expected);
});

test("ls --type keeps those classes, one table row each under a header", () => {
  const run = cli("ls", LZ4_DIR, "--type", "AudioClip,TextAsset");
  assert.equal(run.status, 0, run.stderr);
  const [header, ...rows] = run.stdout.trimEnd().split("\n");
  assert.match(header!, /^Type +Name +Path +PathID +Size +File$/);
  const env = loadPath(LZ4_DIR);
  const kept = [...env.assets("AudioClip", "TextAsset")];
  assert.equal(rows.length, kept.length);
  kept.forEach((asset, i) => {
    const cells = rows[i]!.split(/ {2,}/);
    assert.equal(cells[0], asset.typeName);
    assert.equal(cells[1], asset.name);
    assert.ok(rows[i]!.includes(` ${asset.pathId} `), rows[i]);
  });
});

test("info: each input's container and compression, the files, versions and class counts", () => {
  const run = cli("info", LZ4_DIR);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split("\n");
  const header = readBundle(new Uint8Array(readFileSync(TEXTURE_BUNDLE))).header;
  assert.ok(
    lines.includes(
      `  texture: UnityFS, format ${header.version}, Unity ${header.unityRevision}`,
    ),
    run.stdout,
  );
  const env = loadPath(LZ4_DIR);
  for (const file of env.files) {
    assert.ok(lines.some((line) => line.startsWith(`  ${file.path}: `)), file.path);
  }
  assert.ok(lines.includes("Unity version: 2020.3.30f1"), run.stdout);
  assert.ok(lines.includes("Platform: StandaloneWindows64"), run.stdout);
  assert.ok(lines.includes(`Objects: ${env.objects.length}`), run.stdout);
  const counts = new Map<string, number>();
  for (const { typeName } of env.assets()) counts.set(typeName, (counts.get(typeName) ?? 0) + 1);
  for (const [type, count] of counts) assert.ok(lines.includes(`  ${type}: ${count}`), type);

  // The compression of pre-format-6 UnityWeb (one LZMA stream) and UnityRaw files. A UnityFS
  // header names only its blocks info's (#355).
  const web = cli("info", fixture("unityweb-lzma.bundle"));
  assert.match(web.stdout, /^ {2}unityweb-lzma\.bundle: UnityWeb, format 3, .*, LZMA$/m);
  const raw = cli("info", fixture("unityraw.bundle"));
  assert.match(raw.stdout, /^ {2}unityraw\.bundle: UnityRaw, format \d, .*, uncompressed$/m);
});

test("info lists a split file once, by the name loadPath merges its parts to", () => {
  const dir = tempDir();
  const bytes = readFileSync(TEXTURE_BUNDLE);
  const cut = Math.floor(bytes.length / 2);
  writeFileSync(join(dir, "texture.split0"), bytes.subarray(0, cut));
  writeFileSync(join(dir, "texture.split1"), bytes.subarray(cut));
  const run = cli("info", dir);
  assert.equal(run.status, 0, run.stderr);
  const header = readBundle(new Uint8Array(bytes)).header;
  const lines = run.stdout.split("\n");
  const line = `  texture (2 split parts): UnityFS, format ${header.version}, Unity ${header.unityRevision}`;
  assert.ok(lines.includes(line), run.stdout);
  assert.doesNotMatch(run.stdout, /split0|split1/);
  assert.ok(lines.includes(`Objects: ${loadPath(dir).objects.length}`), run.stdout);
});

test("dump prints readTypeTree() as JSON, 64-bit values as strings", () => {
  const env = loadPath(TEXTURE_BUNDLE);
  const texture = env.objects.find((obj) => obj.type === 28)!;
  const run = cli("dump", TEXTURE_BUNDLE, "--path-id", texture.pathId.toString());
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(JSON.stringify(readTypeTree(texture), replacer));
  assert.deepEqual(JSON.parse(run.stdout), expected);

  const bundle = JSON.parse(cli("dump", TEXTURE_BUNDLE, "--path-id", "1").stdout);
  assert.equal(typeof bundle.m_PreloadTable[0].m_PathID, "string", "a bigint m_PathID");
});

test("dump: a path id in several files needs --file; an unknown one fails", () => {
  const ambiguous = cli("dump", LZ4_DIR, "--path-id", "1");
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /path id 1 is in several files .*--file/);

  const env = loadPath(LZ4_DIR);
  const file = env.objects.find((obj) => obj.pathId === 1n)!.fileName;
  const picked = cli("dump", LZ4_DIR, "--path-id", "1", "--file", file);
  assert.equal(picked.status, 0, picked.stderr);
  const bundle = env.objects.find((obj) => obj.pathId === 1n && obj.fileName === file)!;
  const expected = JSON.parse(JSON.stringify(readTypeTree(bundle), replacer));
  assert.deepEqual(JSON.parse(picked.stdout), expected);

  const missing = cli("dump", TEXTURE_BUNDLE, "--path-id", "424242");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no object with path id 424242/);
});

test("usage errors exit 2 with a message, before the input is read", () => {
  const dir = tempDir();
  const badHeaders = join(dir, "headers.json");
  writeFileSync(badHeaders, JSON.stringify({ x: { headerBytes: "", seekBit: 1 } }));
  const cases: [string[], RegExp][] = [
    [[], /no command given/],
    [["list", LZ4_DIR], /unknown command "list"/],
    [["toString", LZ4_DIR], /unknown command "toString"/],
    [["ls"], /ls needs a file or directory/],
    [["ls", TEXTURE_BUNDLE, LZ4_DIR], /takes one file or directory, got 2 paths.*one directory/],
    [["ls", LZ4_DIR, "-o", dir], /ls does not take --output/],
    [["ls", LZ4_DIR, "--bogus"], /--bogus/],
    [["ls", LZ4_DIR, "--type", ","], /--type needs at least one class name/],
    [["extract", LZ4_DIR], /extract needs -o <dir>/],
    [["extract", LZ4_DIR, "-o", dir, "--mesh", "fbx"], /--mesh takes obj or glb/],
    [["extract", LZ4_DIR, "-o", dir, "--vorbis-headers", badHeaders], /key "x" is not a CRC-32/],
    [["dump", LZ4_DIR], /dump needs --path-id/],
    [["dump", LZ4_DIR, "--path-id", "0x10"], /--path-id takes an integer/],
  ];
  for (const [args, message] of cases) {
    const run = cli(...args);
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, message, args.join(" "));
    assert.match(run.stderr, /--help for usage/, args.join(" "));
    assert.equal(run.stdout, "", args.join(" "));
  }

  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: unity-asset-reader-cli <command> <file-or-dir>/);
});

test("an input that cannot be read exits 1", () => {
  const missing = join(tempDir(), "nope.bundle");
  const run = cli("ls", missing);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /nope\.bundle.*ENOENT/);
});
