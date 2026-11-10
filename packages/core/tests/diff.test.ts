import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../../../fixtures/helpers.js";
import { diff, load, type DiffEntry, type Env } from "../src/index.js";

// Two builds of one project (fixtures/BUILDING.md, the `diff` bundles): v2
// makes `changed.png` 64x32 RGB24 (was 32x32 RGBA32), repaints
// `repainted.png` at the same size, removes `removed.png`, adds `added.png`,
// and moves `moved.png` from the bundle `oldname` into `newname`. `same.png`
// and `note.txt` do not change, though `same.png`'s data moves within the
// `.resS`. The expected changes are known by construction (R12).
const DIR = "editor/2019.4.41f2/diff";
const DIRS = "assets/fixtures/diff/";

function build(version: string, bundles: string[]): Env {
  return load(bundles.map((name) => ({ name, data: loadFixture(`${DIR}/${version}/${name}`) })));
}

const v1 = (suffix = ""): Env => build(`v1${suffix}`, ["textures", "oldname"]);
const v2 = (suffix = ""): Env => build(`v2${suffix}`, ["textures", "newname"]);

/** One line per entry: change, class, and the container path or the bundle's file. */
function summary(entries: DiffEntry[]): string[] {
  return entries.map((e) => `${e.change} ${e.type} ${e.path ?? `${e.name} ${e.pathId}`}`).sort();
}

const EXPECTED = [
  "added AssetBundle newname 1",
  `added Texture2D ${DIRS}added.png`,
  // Its m_Container and m_PreloadTable list other textures.
  "modified AssetBundle textures 1",
  `modified Texture2D ${DIRS}changed.png`,
  `modified Texture2D ${DIRS}repainted.png`,
  "removed AssetBundle oldname 1",
  `removed Texture2D ${DIRS}removed.png`,
].sort();

function byPath(entries: DiffEntry[], name: string): DiffEntry {
  const found = entries.find((e) => e.path === DIRS + name);
  assert.ok(found, `no entry for ${name}`);
  return found;
}

/** A copy of `data` with every `from` (ASCII) replaced by `to`, of the same length. */
function replaceAscii(data: Uint8Array, from: string, to: string): Uint8Array {
  assert.equal(from.length, to.length);
  const out = data.slice();
  const f = new TextEncoder().encode(from);
  const t = new TextEncoder().encode(to);
  for (let i = 0; i + f.length <= out.length; i++) {
    if (f.every((b, j) => out[i + j] === b)) out.set(t, i);
  }
  return out;
}

test("diff lists the assets added, removed and modified between two builds", () => {
  const entries = diff(v1(), v2());
  assert.deepEqual(summary(entries), EXPECTED);
  for (const e of entries) {
    assert.equal(e.before === undefined, e.change === "added");
    assert.equal(e.after === undefined, e.change === "removed");
    assert.equal(e.pathId, (e.after ?? e.before)!.pathId);
  }
});

test("a resized, reformatted texture lists its changed fields and size delta", () => {
  const changed = byPath(diff(v1(), v2()), "changed.png");
  assert.equal(changed.change, "modified");
  assert.equal(changed.name, "changed");
  assert.equal(changed.file, "CAB-b6ec7271e16d6169fe23b363bfe34b24");
  // m_Height stays 32; the image data is in the .resS, so m_StreamData lists it.
  assert.deepEqual(changed.fields, [
    "m_Width",
    "m_CompleteImageSize",
    "m_TextureFormat",
    "m_StreamData",
  ]);
  // 64x32 RGB24 less 32x32 RGBA32, in the .resS; the object keeps its size.
  assert.equal(changed.sizeDelta, 64 * 32 * 3 - 32 * 32 * 4);
});

test("added and removed entries carry the whole size, streamed data included", () => {
  const entries = diff(v1(), v2());
  // 192 bytes of object, 16x16 RGBA32 in the .resS.
  assert.equal(byPath(entries, "added.png").sizeDelta, 192 + 16 * 16 * 4);
  assert.equal(byPath(entries, "removed.png").sizeDelta, -(192 + 16 * 16 * 4));
  assert.equal(entries.find((e) => e.name === "oldname")!.sizeDelta, -144);
});

test("unchanged assets are left out, even when their data moved within the .resS", () => {
  const before = v1();
  const after = v2();
  const entries = diff(before, after);
  for (const name of ["same.png", "note.txt", "moved.png"]) {
    assert.equal(entries.find((e) => e.path === DIRS + name), undefined, name);
  }
  // The case is real: v2's added texture comes first in the .resS, so the
  // same texture's StreamingInfo offset (in its object bytes) differs.
  const offset = (env: Env): number => {
    const asset = env.get(`${DIRS}same.png`)!;
    assert.equal(asset.type, "Texture2D");
    return (asset.reader.readTypeTree().m_StreamData as { offset: number }).offset;
  };
  assert.notEqual(offset(before), offset(after));
});

test("a texture moved into a renamed bundle matches by its container path", () => {
  const before = v1();
  const after = v2();
  const entries = diff(before, after);
  assert.equal(entries.find((e) => e.path === `${DIRS}moved.png`), undefined);
  // Another CAB, so its file and its StreamingInfo path differ.
  assert.notEqual(before.get(`${DIRS}moved.png`)!.file, after.get(`${DIRS}moved.png`)!.file);
});

test("a change in the streamed data alone reports the asset modified", () => {
  // From the builds: repainted keeps its size, so only its .resS bytes differ.
  const repainted = byPath(diff(v1(), v2()), "repainted.png");
  assert.equal(repainted.change, "modified");
  assert.deepEqual(repainted.fields, ["m_StreamData"]);
  assert.equal(repainted.sizeDelta, 0);

  // And by hand: one byte flipped in the .resS slice of removed.png.
  const base = v1();
  const removed = base.get(`${DIRS}removed.png`)!;
  assert.equal(removed.type, "Texture2D");
  const stream = removed.reader.readTypeTree().m_StreamData as { offset: number; size: number };
  assert.ok(stream.size > 0);
  const files = base.files.map((f) => ({ name: f.path, data: f.data.slice() }));
  const resS = files.find((f) => f.name.endsWith(".resS") && f.name.includes(removed.file))!;
  const at = stream.offset + 7;
  resS.data[at] = resS.data[at]! ^ 0xff;
  const entries = diff(v1(), load(files));
  assert.deepEqual(summary(entries), [`modified Texture2D ${DIRS}removed.png`]);
  assert.deepEqual(entries[0]!.fields, ["m_StreamData"]);
  assert.equal(entries[0]!.sizeDelta, 0);
});

test("a bundle whose CAB name changed still matches by its bundle name", () => {
  // Unity's BuildPipeline names the CAB after the bundle name alone (BUILDING.md),
  // so a build cannot keep the name and change the CAB; Addressables can. Rename
  // it here: same length, in the node names and in the StreamingInfo paths.
  const from = "CAB-b6ec7271e16d6169fe23b363bfe34b24";
  const to = "CAB-0123456789abcdef0123456789abcdef";
  const renamed = load(
    build("v1", ["textures"]).files.map((f) => ({
      name: f.path.replace(from, to),
      data: replaceAscii(f.data, from, to),
    })),
  );
  // The AssetBundle object has no container path: it matches as the bundle
  // "textures", path id 1, not by its file name.
  const bundle = [...renamed.assets("AssetBundle")].find((a) => a.name === "textures")!;
  assert.equal(bundle.file, to);
  assert.equal(bundle.path, undefined);
  const changed = renamed.get(`${DIRS}changed.png`)!;
  assert.equal(changed.type, "Texture2D");
  assert.ok((changed.reader.readTypeTree().m_StreamData as { path: string }).path.includes(to));
  assert.deepEqual(diff(build("v1", ["textures"]), renamed), []);
});

test("without type trees, entries are the same and list no fields", () => {
  const entries = diff(v1("-notypetree"), v2("-notypetree"));
  assert.deepEqual(summary(entries), EXPECTED);
  for (const e of entries) assert.equal(e.fields, undefined, `${e.change} ${e.name}`);
  // The streamed data still counts, read by the Texture2D reader.
  assert.equal(byPath(entries, "changed.png").sizeDelta, 64 * 32 * 3 - 32 * 32 * 4);
  assert.equal(byPath(entries, "repainted.png").change, "modified");
});

test("a build compared with itself has no differences", () => {
  const env = v1();
  assert.deepEqual(diff(env, env), []);
  assert.deepEqual(diff(v1(), v1()), []);
});

/**
 * `data`, a SerializedFile, with its `AssetBundle` type (class 142, not
 * stripped, no script) renamed to an unknown class, so no object of it names
 * a bundle: the file then stands for a loose file without one.
 */
function withoutAssetBundle(data: Uint8Array): Uint8Array {
  const out = data.slice();
  const pattern = [142, 0, 0, 0, 0, 0xff, 0xff];
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const dataOffset = view.getUint32(12, false);
  const hits: number[] = [];
  for (let i = 0; i + pattern.length <= dataOffset; i++) {
    if (pattern.every((b, j) => out[i + j] === b)) hits.push(i);
  }
  assert.equal(hits.length, 1, "one AssetBundle type entry in the metadata");
  out[hits[0]! + 1] = 0x7f; // class 32654, which Unity does not have
  return out;
}

test("a SerializedFile without an AssetBundle object matches by its file name", () => {
  const files = v1().files;
  const cab = files.find((f) => !f.path.endsWith(".resS") && f.path.startsWith("CAB-"))!;
  const resS = files.filter((f) => f.path.startsWith(`${cab.path}.`));
  const loose = (data: Uint8Array): Env =>
    load([{ name: cab.path, data }, ...resS.map((f) => ({ name: f.path, data: f.data }))]);
  const plain = withoutAssetBundle(cab.data);
  const before = loose(plain);
  assert.ok(![...before.assets()].some((a) => a.type === "AssetBundle"));
  assert.ok([...before.assets()].every((a) => a.path === undefined));

  assert.deepEqual(diff(before, loose(plain.slice())), []);

  // One byte of an object's own data: the first letter of changed.png's m_Name.
  const target = [...before.assets()].find((a) => a.name === "changed")!;
  const edited = plain.slice();
  const at = target.reader.byteStart + 4;
  assert.equal(String.fromCharCode(edited[at]!), "c");
  edited[at] = "C".charCodeAt(0);
  const entries = diff(before, loose(edited));
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e!.change, "modified");
  assert.equal(e!.file, cab.path);
  assert.equal(e!.pathId, target.pathId);
  assert.equal(e!.name, "Changed");
  assert.equal(e!.path, undefined);
  assert.deepEqual(e!.fields, ["m_Name"]);
  assert.equal(e!.sizeDelta, 0);
});
