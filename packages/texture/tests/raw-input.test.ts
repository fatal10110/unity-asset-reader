// decodeTexture2D on a Texture2D built by hand (#335): typed without a cast,
// and told the DXT Crunch variant by `options.crunch` instead of the 2017.3
// fields.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ClassID,
  load,
  TextureFormat,
  UnsupportedError,
  type Texture2DData,
} from "unity-asset-reader";
import { golden, loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");

// Without the Docker-built WASM only the tests that need no decoder run, as in
// decode.test.ts; REQUIRE_WASM=1 (the CI decoder job) turns a skip into a failure.
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

test("a hand-built Texture2D compiles without a cast, and obj.read() still does", () => {
  const config = ts.readConfigFile(join(PACKAGE, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE);
  assert.equal(options.strict, true);
  const program = ts.createProgram([join(HERE, "types", "raw-input.ts")], {
    ...options,
    noEmit: true,
    rootDir: undefined,
  });
  const problems = ts
    .getPreEmitDiagnostics(program)
    // Only this package's files count; the core's d.ts is checked where it is built.
    .filter((d) => !d.file || !relative(PACKAGE, d.file.fileName).startsWith(`..${sep}`))
    .map((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return text;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${relative(PACKAGE, d.file.fileName)}:${line + 1}: ${text}`;
    });
  assert.deepStrictEqual(problems, []);
});

wasmTest("only the four required fields decode, and crunch is ignored outside Crunch", async () => {
  // RGBA32, 1 x 2, stored bottom row first.
  const imageData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const input = { m_Width: 1, m_Height: 2, m_TextureFormat: TextureFormat.RGBA32, imageData };
  for (const options of [undefined, { crunch: "original" as const }]) {
    const out = await decodeTexture2D(input, options);
    assert.deepEqual({ ...out, data: [...out.data] }, {
      data: [5, 6, 7, 8, 1, 2, 3, 4],
      width: 1,
      height: 2,
    });
  }
});

const BLOCK_FIXTURES = [
  "editor/6000.3.25f1/block/windows",
  "editor/6000.3.25f1/block/android",
  "editor/2019.4.41f2/block/ios",
];

/** The fixture Texture2D in `format`, as `obj.read()` returns it, and its RGBA golden hash. */
function crunched(format: number): { input: Texture2DData; rgbaSha256: string } {
  for (const fixture of BLOCK_FIXTURES) {
    const env = load([{ name: fixture, data: loadFixture(fixture) }]);
    for (const obj of env.objects) {
      if (obj.type !== ClassID.Texture2D) continue;
      const input = obj.read<Texture2DData>();
      if (input.m_TextureFormat !== format) continue;
      const g = Object.values(golden(fixture).serialized ?? {})
        .map((s) => s.textures?.[String(obj.pathId)])
        .find((t) => t);
      assert.ok(g, `${fixture}: no texture golden for ${obj.pathId}`);
      return { input, rgbaSha256: g.rgbaSha256 };
    }
  }
  assert.fail(`no block fixture texture in format ${format}`);
}

/** The decode's RGBA in Unity's stored row order, which the goldens hash. */
async function stored(...args: Parameters<typeof decodeTexture2D>): Promise<string> {
  const out = await decodeTexture2D(...args);
  return sha256(reverseRows(out.data, out.width));
}

wasmTest("options.crunch picks the DXT Crunch variant over the 2017.3 fields", async () => {
  for (const format of [TextureFormat.DXT1Crunched, TextureFormat.DXT5Crunched]) {
    const { input, rgbaSha256 } = crunched(format);
    // A 6000.3 texture: m_IsAlphaChannelOptional says Unity's crunch.
    assert.equal(typeof input.m_IsAlphaChannelOptional, "boolean");
    const { m_Width, m_Height, m_TextureFormat, imageData } = input;
    const bare = { m_Width, m_Height, m_TextureFormat, imageData };
    // Without the fields and the option: the original crunch, which decode.test.ts
    // checks against AssetStudio's UnpackCrunch.
    const original = await stored(bare);
    assert.notEqual(original, rgbaSha256);
    assert.equal(await stored(bare, { crunch: "unity" }), rgbaSha256);
    assert.equal(await stored(input, { crunch: "original" }), original);
    assert.equal(await stored(input, { crunch: "unity" }), rgbaSha256);
  }
});

test("ETC Crunch read as the original crunch is an UnsupportedError", async () => {
  for (const format of [TextureFormat.ETC_RGB4Crunched, TextureFormat.ETC2_RGBA8Crunched]) {
    const input = { m_Width: 4, m_Height: 4, m_TextureFormat: format, imageData: new Uint8Array(8) };
    await assert.rejects(
      decodeTexture2D(input, { crunch: "original" }),
      (e: Error) =>
        e instanceof UnsupportedError &&
        e.kind === "texture format" &&
        e.found === format &&
        /only in Unity's Crunch/.test(e.message),
    );
  }
});

test("options that are not DecodeTexture2DOptions are a TypeError", async () => {
  const input = { m_Width: 4, m_Height: 4, m_TextureFormat: 28, imageData: new Uint8Array(8) };
  const cases: [unknown, RegExp][] = [
    [null, /options must be an object \(missing\)/],
    ["unity", /options must be an object \(string\)/],
    [{ crunch: "legacy" }, /options\.crunch must be "unity" or "original" \("legacy"\)/],
    [{ crunch: true }, /options\.crunch must be "unity" or "original" \(boolean\)/],
  ];
  for (const [options, message] of cases) {
    await assert.rejects(
      decodeTexture2D(input, options as never),
      (e: Error) => e instanceof TypeError && message.test(e.message),
      String(options),
    );
  }
});
