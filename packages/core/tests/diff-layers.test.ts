import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { ClassID, diff, load, type Env } from "../src/index.js";

// diff() on Cubemap, Texture2DArray and Texture3D objects whose image data is
// streamed into a `.resS`, in a SerializedFile without type trees, so only the
// hardcoded readers in diff.ts's STREAM_READERS find the streamed bytes
// (#331, note from #342). The cube-array-3d bundles (fixtures/BUILDING.md)
// keep their image data inline, so the objects are rebuilt here: each one's
// bytes with its "image data" emptied and its m_StreamData pointing at the
// same bytes in a `.resS`. The rest of each object is the editor's.
const BUNDLE = "editor/2019.4.41f2/cube-array-3d/windows";
const CAB = "CAB-layers";
const RESS = `${CAB}.resS`;
const NAMES = ["cube_4_RGBA32", "array_4_RGBA32", "volume_4_RGBA32"];

interface Streamed {
  classId: number;
  pathId: bigint;
  name: string;
  /** The object's bytes, its m_StreamData naming `size` bytes at `offset` of the `.resS`. */
  bytes: Uint8Array;
  offset: number;
  size: number;
}

const le32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
const pad4 = (n: number): number => (n + 3) & ~3;

/** The three RGBA32 objects of the 2019.4 bundle, rebuilt with streamed data, and their `.resS`. */
function streamedObjects(): { objects: Streamed[]; resS: Uint8Array } {
  const env = load([{ name: BUNDLE, data: loadFixture(BUNDLE) }]);
  const file = env.files.find((f) => f.path.startsWith("CAB-") && !f.path.includes("."))!;
  const chunks: Uint8Array[] = [];
  let at = 0;
  const objects = NAMES.map((name) => {
    const reader = env.objects.find(
      (o) =>
        [ClassID.Cubemap, ClassID.Texture2DArray, ClassID.Texture3D].includes(o.type) &&
        o.read<{ m_Name: string }>().m_Name === name,
    )!;
    const image = reader.read<{ "image data": Uint8Array }>()["image data"];
    const bytes = file.data.subarray(reader.byteStart, reader.byteStart + reader.byteSize);
    // "image data": an int32 length, the bytes, aligned to 4; then the empty
    // m_StreamData (UInt32 offset, UInt32 size, empty path) and, for a
    // Cubemap, m_SourceTextures.
    const p = findImage(bytes, image);
    assert.deepEqual([...bytes.subarray(p, p + 4)], le32(image.length), name);
    const after = p + 4 + pad4(image.length);
    assert.deepEqual([...bytes.subarray(after, after + 12)], new Array(12).fill(0), name);
    const path = [...new TextEncoder().encode(`archive:/${CAB}/${RESS}`)];
    const stream = [...le32(at), ...le32(image.length), ...le32(path.length), ...path];
    while (stream.length % 4) stream.push(0);
    const rebuilt = new Uint8Array([
      ...bytes.subarray(0, p),
      ...le32(0),
      ...stream,
      ...bytes.subarray(after + 12),
    ]);
    chunks.push(image);
    const object = { classId: reader.type, pathId: reader.pathId, name, bytes: rebuilt, offset: at, size: image.length };
    at += image.length;
    return object;
  });
  const resS = new Uint8Array(at);
  let o = 0;
  for (const c of chunks) {
    resS.set(c, o);
    o += c.length;
  }
  return { objects, resS };
}

/** Where the int32 length of `image`, followed by its bytes, starts in `bytes`. */
function findImage(bytes: Uint8Array, image: Uint8Array): number {
  const head = le32(image.length);
  for (let p = 0; p + 4 + image.length <= bytes.length; p++) {
    if (head.every((b, i) => bytes[p + i] === b) && image.every((b, i) => bytes[p + 4 + i] === b)) return p;
  }
  throw new Error("image data not found");
}

/**
 * A format-21 (2019.4) SerializedFile without type trees holding `objects`,
 * little-endian, for StandaloneWindows64.
 */
function serializedFile(objects: Streamed[]): Uint8Array {
  const classes = [...new Set(objects.map((o) => o.classId))];
  const meta: number[] = [...new TextEncoder().encode("2019.4.41f2"), 0, ...le32(19), 0];
  meta.push(...le32(classes.length));
  for (const id of classes) meta.push(...le32(id), 0, 0xff, 0xff, ...new Array(16).fill(0));
  meta.push(...le32(objects.length));
  const starts: number[] = [];
  let data = 0;
  for (const o of objects) {
    starts.push(data);
    data = (data + o.bytes.length + 7) & ~7;
  }
  objects.forEach((o, i) => {
    while ((20 + meta.length) % 4) meta.push(0);
    const id = o.pathId;
    meta.push(...le32(Number(id & 0xffffffffn)), ...le32(Number(id >> 32n)));
    meta.push(...le32(starts[i]!), ...le32(o.bytes.length), ...le32(classes.indexOf(o.classId)));
  });
  meta.push(...le32(0), ...le32(0), ...le32(0), 0); // script types, externals, ref types, user info
  const dataOffset = (20 + meta.length + 15) & ~15;
  const out = new Uint8Array(dataOffset + data);
  const view = new DataView(out.buffer);
  view.setUint32(0, meta.length);
  view.setUint32(4, out.length);
  view.setUint32(8, 21);
  view.setUint32(12, dataOffset);
  out.set(meta, 20);
  objects.forEach((o, i) => out.set(o.bytes, dataOffset + starts[i]!));
  return out;
}

function build(objects: Streamed[], resS: Uint8Array): Env {
  return load([
    { name: CAB, data: serializedFile(objects) },
    { name: RESS, data: resS },
  ]);
}

test("the rebuilt objects read their image data from the .resS, without a type tree", () => {
  const { objects, resS } = streamedObjects();
  const env = build(objects, resS);
  assert.equal(env.objects.length, 3);
  env.objects.forEach((reader, i) => {
    assert.equal(reader.serializedType?.nodes ?? null, null);
    const data = reader.read<{ imageData: Uint8Array; m_StreamData: { size: number } }>();
    const o = objects[i]!;
    assert.equal(data.m_StreamData.size, o.size);
    assert.deepEqual(data.imageData, resS.subarray(o.offset, o.offset + o.size), o.name);
  });
});

test("a same-size repaint in the .resS is reported, for each of the three classes", () => {
  const { objects, resS } = streamedObjects();
  assert.deepEqual(diff(build(objects, resS), build(objects, resS.slice())), []);
  for (const o of objects) {
    const repainted = resS.slice();
    repainted[o.offset + 5] = repainted[o.offset + 5]! ^ 0xff;
    const entries = diff(build(objects, resS), build(objects, repainted));
    assert.deepEqual(
      entries.map((e) => [e.change, e.name, e.sizeDelta, e.fields]),
      [["modified", o.name, 0, undefined]],
      o.name,
    );
  }
});

test("sizeDelta counts the streamed bytes of a removed or added one", () => {
  const { objects, resS } = streamedObjects();
  const removed = diff(build(objects, resS), build([], new Uint8Array(0)));
  assert.deepEqual(
    removed.map((e) => [e.change, e.type, e.sizeDelta]),
    objects.map((o) => ["removed", ["Cubemap", "Texture2DArray", "Texture3D"][NAMES.indexOf(o.name)], -(o.bytes.length + o.size)]),
  );
  const added = diff(build([], new Uint8Array(0)), build(objects, resS));
  assert.deepEqual(
    added.map((e) => e.sizeDelta),
    objects.map((o) => o.bytes.length + o.size),
  );
});
