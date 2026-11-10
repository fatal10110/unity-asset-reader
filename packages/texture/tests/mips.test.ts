import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BuildTarget,
  ClassID,
  CorruptError,
  load,
  TextureFormat,
  UnsupportedError,
  type Texture2DData,
} from "unity-asset-reader";
import { loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";

// Mip levels past the first (#331). The pixels of every level of the mips
// bundles (fixtures/BUILDING.md section 29) are the Unity editor's
// GetPixels32(mip), recorded by scripts/make-texture-pixel-goldens.py (plan
// section 5, revision 2026-11-10a). Without a built WASM the decode tests
// skip, as in decode.test.ts.
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

/** A test that needs the decoder, skipped without it. */
const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

interface EditorTexture {
  format: number;
  width: number;
  height: number;
  mipCount: number;
  /** GetPixels32 of each level: RGBA8, rows bottom first, base64. */
  levels: string[];
}

const pixels = JSON.parse(
  readFileSync(new URL("../../../fixtures/texture-pixel-unity-goldens.json", import.meta.url), "utf8"),
) as {
  editors: Record<
    string,
    Record<string, { bundle: string; sha256: string; textures: Record<string, EditorTexture> }>
  >;
};

/** One Texture2D of a mips bundle, as `obj.read()` returns it, and the editor's pixels. */
interface MipTexture {
  where: string;
  input: Texture2DData;
  editor: EditorTexture;
}

const MIPS: MipTexture[] = Object.entries(pixels.editors).flatMap(([version, sets]) =>
  Object.values(sets).flatMap(({ bundle, sha256: hash, textures }) => {
    const data = loadFixture(bundle);
    // The golden was recorded from this very bundle.
    assert.equal(sha256(data), hash, bundle);
    const env = load([{ name: bundle, data }]);
    return env.objects
      .filter((obj) => obj.type === ClassID.Texture2D)
      .map((obj) => {
        const input = obj.read<Texture2DData>();
        const editor = textures[input.m_Name];
        assert.ok(editor, `${bundle}: no editor pixels for ${input.m_Name}`);
        return { where: `${version} ${input.m_Name}`, input, editor };
      });
  }),
);

/** The formats the editor's pixels are compared with exactly. */
const UNCOMPRESSED = new Set<number>([TextureFormat.RGBA32]);

/** The largest difference of one channel between two RGBA images of one size. */
function maxError(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

/**
 * Level `mip` of `t` decoded, and the editor's pixels of it, both top row
 * first. For a DXT, BC or ETC level smaller than a 4x4 block the editor
 * returns the whole block; the level is its first rows and columns.
 */
async function level(t: MipTexture, mip: number) {
  const out = await decodeTexture2D(t.input, { mip });
  const { width, height } = out;
  let editor = new Uint8Array(Buffer.from(t.editor.levels[mip]!, "base64"));
  if (editor.length !== width * height * 4) {
    const stride = Math.max(width, 4);
    assert.equal(editor.length, stride * Math.max(height, 4) * 4, `${t.where} level ${mip}`);
    const level = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      level.set(editor.subarray(y * stride * 4, (y * stride + width) * 4), y * width * 4);
    }
    editor = level;
  }
  return { out, want: reverseRows(editor, width) };
}

test("the mips bundles hold every format of section 29, in all four fixture editors", () => {
  assert.deepEqual(Object.keys(pixels.editors), [
    "2019.4.41f2",
    "2020.3.30f1",
    "6000.3.26f1",
    "6000.6.4f1",
  ]);
  for (const version of Object.keys(pixels.editors)) {
    const own = MIPS.filter((t) => t.where.startsWith(`${version} `));
    assert.deepEqual(
      own.map((t) => t.input.m_TextureFormat).sort((a, b) => a - b),
      [4, 4, 10, 12, 25, 45, 47, 48, 50],
      version,
    );
    for (const t of own) {
      assert.equal(t.input.m_TextureFormat, t.editor.format, t.where);
      assert.deepEqual(
        [t.input.m_Width, t.input.m_Height, t.input.m_MipCount],
        [t.editor.width, t.editor.height, t.editor.mipCount],
        t.where,
      );
      assert.ok(t.editor.mipCount > 1, t.where);
    }
  }
});

wasmTest("every mip level = the editor's GetPixels32(mip), as plan section 5 compares", async () => {
  // A compressed format's bound is its largest error at level 0 against the
  // editor, over every fixture of it (the owner's rule on #331); uncompressed
  // levels match exactly.
  const bound = new Map<number, number>();
  for (const t of MIPS) {
    const { out, want } = await level(t, 0);
    const format = t.input.m_TextureFormat;
    bound.set(format, Math.max(bound.get(format) ?? 0, maxError(out.data, want)));
  }
  for (const format of UNCOMPRESSED) assert.equal(bound.get(format), 0);
  for (const t of MIPS) {
    for (let mip = 1; mip < t.editor.mipCount; mip++) {
      const { out, want } = await level(t, mip);
      assert.deepEqual(
        [out.width, out.height],
        [Math.max(1, t.input.m_Width >> mip), Math.max(1, t.input.m_Height >> mip)],
        `${t.where} level ${mip}`,
      );
      const error = maxError(out.data, want);
      assert.ok(
        error <= bound.get(t.input.m_TextureFormat)!,
        `${t.where} level ${mip}: error ${error}, level 0 bound ${bound.get(t.input.m_TextureFormat)}`,
      );
    }
  }
});

wasmTest("mip 0 is the default", async () => {
  const t = MIPS.find((x) => x.input.m_TextureFormat === TextureFormat.BC7)!;
  const first = await decodeTexture2D(t.input);
  assert.deepEqual(await decodeTexture2D(t.input, { mip: 0 }), first);
  assert.notDeepEqual((await decodeTexture2D(t.input, { mip: 1 })).data, first.data);
});

/** Every non-Crunch Texture2D with mips of the earlier texture bundles, and the mips ones. */
const LAYOUT_FIXTURES = [
  "editor/6000.3.25f1/block/windows",
  "editor/6000.3.25f1/block/android",
  "editor/2019.4.41f2/block/ios",
];

wasmTest("the last level ends where the image data ends, for every block format", async () => {
  // Unity sizes the image data (m_CompleteImageSize) as the sum of its levels,
  // so a level layout off by a byte anywhere moves the last level's end.
  const inputs = [
    ...LAYOUT_FIXTURES.flatMap((fixture) =>
      load([{ name: fixture, data: loadFixture(fixture) }])
        .objects.filter((obj) => obj.type === ClassID.Texture2D)
        .map((obj) => obj.read<Texture2DData>()),
    ),
    ...MIPS.map((t) => t.input),
  ].filter((t) => !/Crunched/.test(t.m_Name));
  assert.equal(inputs.length, 24 + 36);
  for (const t of inputs) {
    const last = t.m_MipCount! - 1;
    assert.ok(last > 0, t.m_Name);
    assert.equal(t.imageData.length, t.m_CompleteImageSize, t.m_Name);
    const out = await decodeTexture2D(t, { mip: last });
    assert.deepEqual([out.width, out.height], [1, 1], t.m_Name);
    const short = { ...t, imageData: t.imageData.subarray(0, t.imageData.length - 1) };
    await assert.rejects(
      decodeTexture2D(short, { mip: last }),
      (e: Error) =>
        e instanceof CorruptError &&
        e.message.endsWith(`mip level ${last} (1 x 1) of ${t.m_Width} x ${t.m_Height} ends at ` +
          `byte ${t.imageData.length}`),
      t.m_Name,
    );
  }
});

wasmTest("PVRTC levels under 2 x 2 blocks are stored padded and cropped back", async () => {
  const ios = load([{ name: "ios", data: loadFixture(LAYOUT_FIXTURES[2]!) }])
    .objects.filter((obj) => obj.type === ClassID.Texture2D)
    .map((obj) => obj.read<Texture2DData>());
  assert.equal(ios.length, 4);
  for (const t of ios) {
    // 32 x 32: levels 2-5 (8x8 .. 1x1) are each stored as 8x8 (4 bpp) or 16x8 (2 bpp).
    for (let mip = 0; mip < 6; mip++) {
      const out = await decodeTexture2D(t, { mip });
      assert.deepEqual([out.width, out.height], [32 >> mip, 32 >> mip], `${t.m_Name} ${mip}`);
    }
  }
});

/** Hand-built RGBA32 with three levels, 4x4, 2x2 and 1x1: byte i of the data is i. */
function rgba32(fields: Partial<Texture2DData> = {}): Texture2DData {
  const imageData = new Uint8Array((16 + 4 + 1) * 4).map((_, i) => i);
  return {
    m_Width: 4,
    m_Height: 4,
    m_TextureFormat: TextureFormat.RGBA32,
    imageData,
    m_MipCount: 3,
    ...fields,
  } as Texture2DData;
}

wasmTest("a level of hand-built data starts after the levels before it, rows flipped", async () => {
  const t = rgba32();
  const second = await decodeTexture2D(t, { mip: 1 });
  // Level 1 is bytes 64..79, two rows of two pixels, stored bottom row first.
  assert.deepEqual(second, {
    data: new Uint8Array([72, 73, 74, 75, 76, 77, 78, 79, 64, 65, 66, 67, 68, 69, 70, 71]),
    width: 2,
    height: 2,
  });
  assert.deepEqual(await decodeTexture2D(t, { mip: 2 }), {
    data: new Uint8Array([80, 81, 82, 83]),
    width: 1,
    height: 1,
  });
});

wasmTest("the mip count is m_MipCount, or before Unity 5.2 m_MipMap's full chain", async () => {
  // 4 x 4 with m_MipMap: 4x4, 2x2, 1x1.
  const legacy = rgba32({ m_MipCount: undefined, m_MipMap: true });
  assert.equal((await decodeTexture2D(legacy, { mip: 2 })).width, 1);
  await assert.rejects(
    decodeTexture2D(legacy, { mip: 3 }),
    (e: Error) =>
      e instanceof RangeError &&
      e.message === "decodeTexture2D: options.mip is 3, but the texture has 3 mip levels",
  );
  // Neither field: one level, as data built by hand without m_MipCount.
  await assert.rejects(
    decodeTexture2D(rgba32({ m_MipCount: undefined }), { mip: 1 }),
    (e: Error) =>
      e instanceof RangeError &&
      e.message === "decodeTexture2D: options.mip is 1, but the texture has 1 mip level",
  );
});

test("options.mip that is not a whole number from 0: TypeError or RangeError", async () => {
  // Checked before the decoder is needed, so these run without the WASM too.
  for (const mip of ["1", null, 1n]) {
    await assert.rejects(
      decodeTexture2D(rgba32(), { mip } as never),
      (e: Error) => e instanceof TypeError && /^decodeTexture2D: options\.mip must be a number/.test(e.message),
      String(mip),
    );
  }
  for (const mip of [-1, 0.5, Number.NaN, Infinity]) {
    await assert.rejects(
      decodeTexture2D(rgba32(), { mip }),
      (e: Error) =>
        e instanceof RangeError &&
        e.message === `decodeTexture2D: options.mip must be a whole number from 0 (${mip})`,
      String(mip),
    );
  }
});

wasmTest("Crunch decodes level 0 only: a later level is an UnsupportedError", async () => {
  const windows = "editor/6000.3.25f1/block/windows";
  const crunched = load([{ name: windows, data: loadFixture(windows) }])
    .objects.filter((obj) => obj.type === ClassID.Texture2D)
    .map((obj) => obj.read<Texture2DData>())
    .filter((t) => /Crunched/.test(t.m_Name));
  assert.equal(crunched.length, 2);
  for (const t of crunched) {
    assert.ok(t.m_MipCount! > 1, t.m_Name);
    await decodeTexture2D(t, { mip: 0 });
    await assert.rejects(
      decodeTexture2D(t, { mip: 1 }),
      (e: Error) =>
        e instanceof UnsupportedError &&
        e.kind === "texture format" &&
        /only mip level 0 unpacks/.test(e.message),
      t.m_Name,
    );
  }
});

wasmTest("Switch and Xbox 360 decode level 0 only: a later level is an UnsupportedError", async () => {
  for (const platform of [BuildTarget.Switch, BuildTarget.XBOX360]) {
    await decodeTexture2D(rgba32({ platform }), { mip: 0 });
    await assert.rejects(
      decodeTexture2D(rgba32({ platform }), { mip: 1 }),
      (e: Error) =>
        e instanceof UnsupportedError &&
        e.kind === "texture platform" &&
        /mip levels past the first of a (Switch|Xbox 360) texture/.test(e.message),
      String(platform),
    );
  }
});
