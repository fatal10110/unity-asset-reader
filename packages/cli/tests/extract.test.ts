import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  readTypeTree,
  type AudioClipData,
  type MeshData,
  type Shader,
  type TextAsset,
} from "unity-asset-reader";
import { Fsb5Codec, fsb5ToOgg, fsb5ToWav, readFsb5 } from "unity-asset-reader-audio";
import { meshToGltf, meshToObj } from "unity-asset-reader-mesh";
import { loadPath } from "unity-asset-reader-node";
import { shaderToText } from "unity-asset-reader-shader";
import { decodeImage, encodePng, packedSprites } from "unity-asset-reader-texture";

import { cli, EDITOR, fileName, fixture, noWasm, tempDir, written } from "./helpers.js";

const LZ4_DIR = fixture(`${EDITOR}/lz4`);
const utf8 = new TextEncoder();
/** The core README's replacer: bigint to decimal, bytes to hex. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return value;
}
const json = (value: unknown): Uint8Array =>
  utf8.encode(`${JSON.stringify(value, replacer, 2)}\n`);

/** Each written file must be the expected one, byte for byte, and nothing else written. */
function assertFiles(out: string, expected: Map<string, Uint8Array>): void {
  const files = written(out);
  assert.deepEqual([...files.keys()].sort(), [...expected.keys()].sort());
  for (const [path, bytes] of expected) assert.deepEqual(files.get(path), bytes, path);
}

test("extract writes text, audio, mesh and JSON files as the library calls produce them", () => {
  const out = join(tempDir(), "out");
  const types = "TextAsset,AudioClip,Mesh,MonoBehaviour";
  const run = cli("extract", LZ4_DIR, "-o", out, "--type", types);

  const expected = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  for (const asset of loadPath(LZ4_DIR).assets("TextAsset", "AudioClip", "Mesh", "MonoBehaviour")) {
    const name = `${asset.typeName}/${fileName(asset.name)}`;
    if (asset.type === "TextAsset") {
      expected.set(`${name}.txt`, asset.reader.read<TextAsset>().m_Script);
    } else if (asset.type === "AudioClip") {
      const bytes = asset.reader.read<AudioClipData>().audioData;
      if (readFsb5(bytes).codec === Fsb5Codec.VORBIS) skipped.push(asset.name);
      else expected.set(`${name}.wav`, fsb5ToWav(bytes));
    } else if (asset.type === "Mesh") {
      expected.set(`${name}.obj`, utf8.encode(meshToObj(asset.reader.read<MeshData>())));
    } else {
      expected.set(`${name}.json`, json(readTypeTree(asset.reader)));
    }
  }
  assert.ok(expected.size >= 10, `only ${expected.size} files to compare`);
  assert.deepEqual(skipped, ["tone-vorbis"]);

  assert.equal(run.status, 0, run.stderr);
  assertFiles(out, expected);
  assert.deepEqual(run.stdout.trimEnd().split("\n").sort(), [...expected.keys()].sort());
  assert.match(run.stderr, /^skipped: AudioClip "tone-vorbis" .*--vorbis-headers/m);
  assert.match(run.stderr, new RegExp(`extract: ${expected.size} written, 1 skipped, 0 failed`));
});

test("extract writes a Vorbis clip as Ogg with the --vorbis-headers table", () => {
  const dir = tempDir();
  // A setup header that holds together as far as the Ogg rebuild reads it (the audio
  // package's vorbis.test.ts builds the same): type 5, "vorbis", two filler bytes, then two
  // modes at bit 72 and the framing bit. FMOD's real headers are not in the repository.
  const bits: number[] = [];
  const put = (value: number, count: number): void => {
    for (let i = 0; i < count; i++) bits.push((value >>> i) & 1);
  };
  for (const byte of [5, ...utf8.encode("vorbis"), 0xa5, 0x5a]) put(byte, 8);
  const seekBit = bits.length;
  put(1, 6);
  for (const flag of [0, 1]) put(flag, 1), put(0, 16), put(0, 16), put(0, 8);
  put(1, 1);
  const headerBytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => (headerBytes[i >> 3]! |= bit << (i & 7)));
  const crc = 0x8d00698d; // tone-vorbis's, the audio package's TONE_CRC
  const table = join(dir, "headers.json");
  const base64 = Buffer.from(headerBytes).toString("base64");
  writeFileSync(table, JSON.stringify({ [crc]: { headerBytes: base64, seekBit } }));

  const out = join(dir, "out");
  const run = cli("extract", LZ4_DIR, "-o", out, "--type", "AudioClip", "--vorbis-headers", table);
  assert.equal(run.status, 0, run.stderr);
  const clip = [...loadPath(LZ4_DIR).assets("AudioClip")].find((a) => a.name === "tone-vorbis")!;
  const headers = new Map([[crc, { headerBytes, seekBit }]]);
  const ogg = fsb5ToOgg(clip.reader.read<AudioClipData>().audioData, headers);
  assert.deepEqual(written(out).get("AudioClip/tone-vorbis.ogg"), ogg);
  assert.match(run.stderr, /extract: 9 written, 0 skipped, 0 failed/);
});

test("extract --mesh glb writes meshToGltf()'s files", () => {
  const input = fixture(`${EDITOR}/mesh/lz4`);
  const out = join(tempDir(), "out");
  const run = cli("extract", input, "-o", out, "--mesh", "glb");
  assert.equal(run.status, 0, run.stderr);
  const expected = new Map<string, Uint8Array>();
  for (const mesh of loadPath(input).assets("Mesh")) {
    expected.set(`Mesh/${fileName(mesh.name)}.glb`, meshToGltf(mesh.reader.read<MeshData>()));
  }
  assert.ok(expected.size >= 3);
  assertFiles(out, expected);
});

test("extract writes shaders as shaderToText() gives them", () => {
  const input = fixture(`${EDITOR}/shader/lz4/android`);
  const out = join(tempDir(), "out");
  const run = cli("extract", input, "-o", out);
  assert.equal(run.status, 0, run.stderr);
  const expected = new Map<string, Uint8Array>();
  for (const shader of loadPath(input).assets("Shader")) {
    const text = shaderToText(shader.reader.read<Shader>());
    expected.set(`Shader/${fileName(shader.name)}.txt`, utf8.encode(text));
  }
  assert.deepEqual([...expected.keys()].sort(), [
    "Shader/UAR_ShaderFixture.txt",
    "Shader/UAR_ShaderFixtureSecond.txt",
  ]);
  assertFiles(out, expected);
});

test("extract goes on past an asset that fails, reports it and exits 1", () => {
  // Built without type trees: the MonoBehaviour has no JSON, the TextAsset still has its bytes.
  const input = fixture(`${EDITOR}/lz4-notypetree`);
  const out = join(tempDir(), "out");
  const run = cli("extract", input, "-o", out, "--type", "MonoBehaviour,TextAsset");
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /^failed: MonoBehaviour "data" \(CAB-\w+, path id -?\d+\): .*without a type tree/m,
  );
  const text = [...loadPath(input).assets("TextAsset")];
  assert.equal(text.length, 1);
  assertFiles(out, new Map([["TextAsset/hello.txt", text[0]!.reader.read<TextAsset>().m_Script]]));
  assert.match(run.stderr, /extract: 1 written, 0 skipped, 1 failed/);
});

test("extract gives a repeated name the path id, and never overwrites in one run", () => {
  // The same bundle twice: two "hello" TextAssets with the same path id.
  const dir = tempDir();
  mkdirSync(join(dir, "in"));
  copyFileSync(fixture(`${EDITOR}/lz4/shared`), join(dir, "in", "a"));
  copyFileSync(fixture(`${EDITOR}/lz4-notypetree/shared`), join(dir, "in", "b"));
  const out = join(dir, "out");
  const run = cli("extract", join(dir, "in"), "-o", out, "--type", "TextAsset");
  assert.equal(run.status, 0, run.stderr);
  const [first, second] = [...loadPath(join(dir, "in")).assets("TextAsset")];
  assert.equal(first!.name, second!.name);
  const files = [...written(out).keys()].sort();
  assert.deepEqual(files, [`TextAsset/hello.txt`, `TextAsset/hello_${second!.pathId}.txt`].sort());
});

const IMAGES = "extract writes images and packed sprites as decodeImage() and encodePng() do";
test(IMAGES, { skip: noWasm }, async () => {
  for (const input of [LZ4_DIR, fixture("editor/6000.6.4f1/sprite-v2/sprites")]) {
    const out = join(tempDir(), "out");
    const run = cli("extract", input, "-o", out, "--type", "Texture2D,Sprite");
    assert.equal(run.status, 0, run.stderr);

    const expected = new Map<string, Uint8Array>();
    const add = async (
      dir: string,
      item: Parameters<typeof decodeImage>[0],
    ): Promise<void> => {
      const { rgba, width, height, name } = await decodeImage(item);
      if (width === 0 || height === 0) return; // a dynamic font's texture: skipped
      const path = `${dir}/${fileName(name)}.png`;
      assert.ok(!expected.has(path), `${path} twice: rename in the test`);
      expected.set(path, encodePng({ data: rgba, width, height }));
    };
    for (const asset of loadPath(input).assets("Texture2D", "Sprite", "SpriteAtlas")) {
      if (asset.type !== "SpriteAtlas") await add(asset.typeName, asset);
      else for (const sprite of packedSprites(asset)) await add("Sprite", sprite);
    }
    assertFiles(out, expected);
    if (input === LZ4_DIR) {
      assert.match(run.stderr, /^skipped: Texture2D "Font Texture" .*: 0 x 0 image, no pixels$/m);
    } else {
      assert.ok([...expected.keys()].some((path) => path.startsWith("Sprite/")), "no sprite");
    }
  }
});
