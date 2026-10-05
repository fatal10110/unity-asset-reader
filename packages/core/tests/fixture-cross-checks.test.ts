import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { golden, sha256 } from "../../../fixtures/helpers.js";
import { readSprite } from "../src/classes/Sprite.js";
import { readSpriteAtlas } from "../src/classes/SpriteAtlas.js";
import { readTexture2D } from "../src/classes/Texture2D.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { normalize, objectsOf } from "./class-readers.js";

interface Pixels {
  width: number;
  height: number;
  imageSha256: string;
  rgbaSha256: string;
  rgbaHex: string;
  firstPixel: number[];
}

interface VariantPixels extends Pixels {
  textureWidth: number;
  textureHeight: number;
  textureRect: { x: number; y: number; width: number; height: number };
  textureRectOffset: { x: number; y: number };
  settingsRaw: number;
  downscaleMultiplier: number;
}

interface CrossChecks {
  verdict: string;
  revision: string;
  sourceBlobs: Record<string, string>;
  packages: Record<string, string>;
  nugetSource: string;
  packageSha512: Record<string, string>;
  plain: Record<string, Pixels & { format: number; method: string }>;
  variants: Record<string, Record<string, VariantPixels>>;
}

test("fixture references retain pinned independent oracle provenance", () => {
  const references = crossChecks();
  assert.equal(references.verdict, "AssetStudio");
  assert.equal(references.revision, "c37af7dfcdafee93e33b5da9f0285c97998d6ae3");
  assert.deepEqual(references.sourceBlobs, {
    "Texture2DConverter.cs": "91c659434c07d92ea1d6fbc634d222fc37222b4f",
    "SpriteHelper.cs": "2110b7100491417e337ed06aa155ab9bc3696edb",
    "AssetStudio.Utility.csproj": "328274d0428a262c9d6e351fc3d734a9d7f5fad4",
  });
  assert.deepEqual(references.packages, {
    "SixLabors.ImageSharp.Drawing": "1.0.0-beta15",
    "SixLabors.ImageSharp": "2.1.3",
    "SixLabors.Fonts": "1.0.0-beta18",
  });
  assert.equal(references.nugetSource, "https://api.nuget.org/v3/index.json");
  assert.deepEqual(Object.keys(references.packageSha512).sort(), [
    "Microsoft.NETCore.Platforms/5.0.0",
    "SixLabors.Fonts/1.0.0-beta18",
    "SixLabors.ImageSharp.Drawing/1.0.0-beta15",
    "SixLabors.ImageSharp/2.1.3",
    "System.Runtime.CompilerServices.Unsafe/5.0.0",
    "System.Text.Encoding.CodePages/5.0.0",
  ]);
  for (const hash of Object.values(references.packageSha512)) {
    assert.equal(Buffer.from(hash, "base64").length, 64);
  }
});

function crossChecks(): CrossChecks {
  const path = new URL("../../../fixtures/assetstudio-fixture-cross-checks.json", import.meta.url);
  assert.ok(existsSync(path), "independent AssetStudio references must be generated");
  return JSON.parse(readFileSync(path, "utf8")) as CrossChecks;
}

function checkPixels(reference: Pixels): void {
  const rgba = Buffer.from(reference.rgbaHex, "hex");
  assert.equal(rgba.length, reference.width * reference.height * 4);
  assert.equal(sha256(rgba), reference.rgbaSha256);
  assert.deepEqual([...rgba.subarray(0, 4)], reference.firstPixel);
}

// A stale reference for another input, missing format, or wrong channel order must fail.
test("pending plain formats have complete AssetStudio pixels bound to their fixture input", () => {
  const references = crossChecks().plain;
  assert.deepEqual(Object.keys(references).sort(), ["RG16", "RG32", "RGBA64"]);
  const fixture = "editor/2019.4.41f2/more-plain/textures";
  const textures = objectsOf(fixture, ClassID.Texture2D).map(({ reader }) => readTexture2D(reader));
  const firstPixels: Record<string, number[]> = {
    RG16: [11, 48, 0, 255],
    RG32: [48, 122, 0, 255],
    RGBA64: [48, 122, 196, 15],
  };
  const serialized = Object.values(golden(fixture).serialized!)[0]!;
  for (const [name, reference] of Object.entries(references)) {
    const texture = textures.find((texture) => texture.m_Name === name)!;
    assert.ok(texture, name);
    assert.equal(reference.format, texture.m_TextureFormat);
    assert.equal(reference.method, `Decode${name}`);
    assert.equal(reference.width, texture.m_Width);
    assert.equal(reference.height, texture.m_Height);
    assert.equal(reference.imageSha256, sha256(texture["image data"]));
    assert.deepEqual(reference.firstPixel, firstPixels[name]);
    checkPixels(reference);
    const oracle = Object.values(serialized.textures!).find((entry) => entry.name === name)!;
    const attached = oracle as typeof oracle & { assetStudioCrossCheck?: Pixels };
    assert.equal(attached.assetStudioCrossCheck?.rgbaSha256, reference.rgbaSha256);
  }
});

// A crop reference bound to the master instead of the half-scale atlas must fail.
test("half-scale variant reference pixels are bound to native atlas metadata and bytes", () => {
  const fixture = "editor/2019.4.41f2/variant/sprites";
  const references = crossChecks().variants[fixture]!;
  assert.ok(references);
  assert.deepEqual(Object.keys(references).sort(), ["r_a", "r_b"]);
  const sprites = objectsOf(fixture, ClassID.Sprite).map(({ reader }) => readSprite(reader));
  const { env, reader, atlas } = objectsOf(fixture, ClassID.SpriteAtlas)
    .map((entry) => ({ ...entry, atlas: readSpriteAtlas(entry.reader) }))
    .find(({ atlas }) => atlas.m_IsVariant)!;
  assert.equal(atlas.m_RenderDataMap.length, 2);
  const serialized = Object.values(golden(fixture).serialized!)[0]!;
  for (const [key, data] of atlas.m_RenderDataMap) {
    const sprite = sprites.find((sprite) =>
      JSON.stringify(normalize(sprite.m_RenderDataKey)) === JSON.stringify(normalize(key)))!;
    assert.ok(sprite);
    const reference = references[sprite.m_Name]!;
    assert.ok(reference, sprite.m_Name);
    assert.deepEqual(reference.textureRect, data.textureRect);
    assert.deepEqual(reference.textureRectOffset, data.textureRectOffset);
    assert.equal(reference.settingsRaw, data.settingsRaw);
    assert.equal(reference.downscaleMultiplier, 0.5);
    assert.equal(reference.downscaleMultiplier, data.downscaleMultiplier);
    const resolved = env.resolve(data.texture, reader);
    assert.equal(resolved.status, "found");
    if (resolved.status !== "found") assert.fail("missing variant atlas texture");
    const texture = readTexture2D(resolved.object);
    const raw = texture.m_StreamData?.size
      ? env.readResource(texture.m_StreamData, resolved.object)
      : texture["image data"];
    assert.equal(reference.imageSha256, sha256(raw));
    assert.equal(reference.textureWidth, texture.m_Width);
    assert.equal(reference.textureHeight, texture.m_Height);
    assert.deepEqual([reference.width, reference.height], sprite.m_Name === "r_a" ? [10, 8] : [34, 33]);
    checkPixels(reference);
    const oracle = Object.values(serialized.sprites!).find((entry) => entry.name === sprite.m_Name)!;
    const attached = oracle as typeof oracle & {
      assetStudioCrossCheck?: Pick<Pixels, "width" | "height" | "rgbaSha256">;
    };
    assert.equal(attached.assetStudioCrossCheck?.rgbaSha256, reference.rgbaSha256);
    assert.equal(attached.assetStudioCrossCheck?.width, reference.width);
    assert.equal(attached.assetStudioCrossCheck?.height, reference.height);
    assert.notEqual(oracle.rgbaSha256, reference.rgbaSha256, "UnityPy does not resize the variant");
  }
});
