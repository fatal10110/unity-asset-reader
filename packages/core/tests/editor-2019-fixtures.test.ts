import assert from "node:assert/strict";
import { test } from "node:test";
import { readSpriteAtlas } from "../src/classes/SpriteAtlas.js";
import { readTexture2D } from "../src/classes/Texture2D.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { objectsOf } from "./class-readers.js";

const PREFIX = "editor/2019.4.41f2";

test("2019 half-scale variant has two native downscaled entries", () => {
  const atlases = objectsOf(`${PREFIX}/variant/sprites`, ClassID.SpriteAtlas);
  assert.equal(atlases.length, 2);
  const variant = atlases.map(({ reader }) => readSpriteAtlas(reader))
    .find((atlas) => atlas.m_IsVariant)!;
  assert.ok(variant);
  assert.equal(variant.m_RenderDataMap.length, 2);
  for (const [, data] of variant.m_RenderDataMap) {
    assert.equal(data.downscaleMultiplier, 0.5);
  }
});

test("2019 Android split alpha points to distinct ETC1 textures", () => {
  const atlases = objectsOf(`${PREFIX}/split-alpha/sprites`, ClassID.SpriteAtlas);
  assert.equal(atlases.length, 2);
  let entries = 0;
  for (const { env, reader } of atlases) {
    for (const [, data] of readSpriteAtlas(reader).m_RenderDataMap) {
      assert.notEqual(data.alphaTexture.m_PathID, 0n);
      assert.notEqual(data.alphaTexture.m_PathID, data.texture.m_PathID);
      const color = env.resolve(data.texture, reader);
      const alpha = env.resolve(data.alphaTexture, reader);
      assert.equal(color.status, "found");
      assert.equal(alpha.status, "found");
      if (color.status !== "found" || alpha.status !== "found") assert.fail("missing atlas texture");
      const ct = readTexture2D(color.object), at = readTexture2D(alpha.object);
      assert.equal(ct.m_TextureFormat, 34); // ETC_RGB4
      assert.equal(at.m_TextureFormat, 34);
      assert.equal(ct.m_Width, at.m_Width);
      assert.equal(ct.m_Height, at.m_Height);
      entries++;
    }
  }
  assert.equal(entries, 17);
});

test("2019 more-plain fixture contains all five requested unsigned formats", () => {
  const textures = objectsOf(`${PREFIX}/more-plain/textures`, ClassID.Texture2D)
    .map(({ reader }) => readTexture2D(reader));
  assert.deepEqual(textures.map((texture) => texture.m_TextureFormat).sort((a, b) => a - b),
    [62, 63, 72, 73, 74]);
  for (const texture of textures) {
    assert.equal(texture.m_Width, 8);
    assert.equal(texture.m_Height, 5);
    assert.equal(texture.m_MipCount, 1);
  }
});
