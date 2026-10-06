// A sprite packed into a Unity 6000.6 SpriteAtlas (#155): the core reads that
// atlas layout, whose entries hold the packed sprites' meshes
// (`*spriteInstanceData`); cutting sprites out of it is not ported yet, so the
// lookup refuses it (R9) rather than cutting by a mesh it does not use.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClassID,
  load,
  UnsupportedError,
  type Sprite,
  type SpriteAtlas,
} from "unity-asset-reader";
import { loadFixture } from "../../../fixtures/helpers.js";
import { decodeImage, imageInfo } from "../src/image.js";
import { decodeSprite, findSpriteSource } from "../src/sprite.js";

const FIXTURE = "editor/6000.6.4f1/sprite/sprites";

/** Little-endian `UInt32`s. */
const words = (...values: number[]): Uint8Array => new Uint8Array(new Uint32Array(values).buffer);

test("a sprite packed into a 6000.6 SpriteAtlas is refused with UnsupportedError", async () => {
  const env = load([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
  const atlas = env.objects.find((o) => o.type === ClassID.SpriteAtlas)!;
  const [guid, id] = atlas.read<SpriteAtlas>().m_RenderDataMap[0]![0];
  // The fixture keeps no packed Sprite objects (6000.6 holds them in the
  // atlas), so point an unpacked one at the atlas' first entry.
  const obj = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === "sheet_a",
  )!;
  const sprite = obj.read<Sprite>();
  assert.equal(sprite.m_SpriteAtlas!.m_PathID, 0n);
  findSpriteSource(obj, env); // readable as it is: its own m_RD

  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  const bytes = file.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  const key = sprite.m_RenderDataKey![0];
  const at = [...bytes.keys()].filter((i) =>
    words(...[0, 1, 2, 3].map((w) => key[`data[${w}]`]!)).every((b, k) => bytes[i + k] === b),
  );
  assert.equal(at.length, 1);
  // m_RenderDataKey (GUID, Int64), m_AtlasTags (empty), then m_SpriteAtlas.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(words(...[0, 1, 2, 3].map((w) => guid[`data[${w}]`]!)), at[0]!);
  view.setBigInt64(at[0]! + 16, id, true);
  assert.equal(view.getInt32(at[0]! + 24, true), 0);
  view.setBigInt64(at[0]! + 32, atlas.pathId, true);
  const packed = obj.read<Sprite>();
  assert.equal(packed.m_SpriteAtlas!.m_PathID, atlas.pathId);
  assert.equal(packed.m_RenderDataKey![1], id);

  const refused = (err: unknown) =>
    err instanceof UnsupportedError &&
    err.kind === "Unity version" &&
    err.found === "6000.6.4f1" &&
    /6000\.6 SpriteAtlas is not implemented/.test(err.message);
  assert.throws(() => findSpriteSource(obj, env), refused);
  await assert.rejects(decodeSprite(obj, env), refused);
  const asset = [...env.assets("Sprite")].find((a) => a.pathId === obj.pathId)!;
  assert.throws(() => imageInfo(asset), refused);
  await assert.rejects(decodeImage(asset), refused);
});
