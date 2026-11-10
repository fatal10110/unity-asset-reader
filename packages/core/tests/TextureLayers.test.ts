// The Cubemap, Texture2DArray and Texture3D readers (#331). On the
// cube-array-3d bundles of the four fixture editors (fixtures/BUILDING.md
// section 31), each against UnityPy's read_typetree() dump (goldens.json and,
// for 6000.6, modern-goldens.json) and the object's own type tree; and on
// objects laid out from Unity's own player type trees at every version TPK
// records from 2019.1 (fixtures/tpk-trees.json), R12.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadFixture, type Golden, type GoldenSerialized } from "../../../fixtures/helpers.js";
import { readCubemap } from "../src/classes/Cubemap.js";
import { GraphicsFormat, textureFormatOfGraphicsFormat } from "../src/classes/GraphicsFormat.js";
import {
  readObjectData,
  type CubemapData,
  type Texture2DArrayData,
  type Texture3DData,
} from "../src/classes/registry.js";
import { readTexture2DArray, readTexture3D } from "../src/classes/Texture2DArray.js";
import { TextureFormat } from "../src/classes/TextureFormat.js";
import { load } from "../src/env.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import {
  goldenForm,
  nest,
  readerOf,
  template,
  versionRefusal,
  withTail,
  type Template,
} from "./media.js";
import { filled, serializedOf, TPK, tpkReader, versionOf } from "./tpk-layouts.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const BUNDLES = EDITORS.flatMap((v) => ["windows", "android"].map((b) => `editor/${v}/cube-array-3d/${b}`));
const WINDOWS_2019 = "editor/2019.4.41f2/cube-array-3d/windows";
const CLASSES = [ClassID.Cubemap, ClassID.Texture2DArray, ClassID.Texture3D];
const CLASS_NAMES: Record<number, string> = {
  [ClassID.Cubemap]: "Cubemap",
  [ClassID.Texture2DArray]: "Texture2DArray",
  [ClassID.Texture3D]: "Texture3D",
};
const READERS: Record<number, (reader: ObjectReader) => Record<string, unknown>> = {
  [ClassID.Cubemap]: (r) => readCubemap(r) as unknown as Record<string, unknown>,
  [ClassID.Texture2DArray]: (r) => readTexture2DArray(r) as unknown as Record<string, unknown>,
  [ClassID.Texture3D]: (r) => readTexture3D(r) as unknown as Record<string, unknown>,
};

const json = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8")) as T;
const GOLDENS: Record<string, Golden> = {
  ...json<{ fixtures: Record<string, Golden> }>("goldens.json").fixtures,
  ...json<{ fixtures: Record<string, Golden> }>("modern-goldens.json").fixtures,
};

/** The bundle's one SerializedFile golden. */
function serialized(name: string): GoldenSerialized {
  const golden = GOLDENS[name];
  assert.ok(golden, `no golden for ${name}`);
  const [sf] = Object.values(golden.serialized ?? {});
  assert.ok(sf, `${name}: no serialized golden`);
  return sf;
}

/** The layered texture objects of a bundle. */
function objects(name: string): ObjectReader[] {
  return load([{ name, data: loadFixture(name) }]).objects.filter((o) => CLASSES.includes(o.type));
}

for (const name of BUNDLES) {
  test(`${name}: each reader equals UnityPy's dump and readTypeTree()`, () => {
    const sf = serialized(name);
    const readers = objects(name);
    // Every object but the AssetBundle is one of the three classes.
    assert.equal(readers.length, Object.keys(sf.typetrees).length - 1);
    for (const reader of readers) {
      const dump = sf.typetrees[String(reader.pathId)]!.value as Record<string, unknown>;
      const nodes = sf.types.find((t) => t.classId === reader.type)!.nodes!;
      const data = READERS[reader.type]!(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(data), Object.keys(dump), `${name} ${reader.pathId}`);
      assert.deepEqual(goldenForm(nest(nodes), data), dump, `${name} ${reader.pathId}`);
      // The same object through its type tree: only the offset's type differs.
      const tree = reader.readTypeTree() as Record<string, unknown>;
      const stream = tree.m_StreamData as { offset: bigint | number };
      assert.deepEqual(data, { ...tree, m_StreamData: { ...stream, offset: Number(stream.offset) } });
    }
  });
}

test("the bundles hold every class, Texture3D compressed from 2020.3 only", () => {
  const counts = (name: string) =>
    CLASSES.map((id) => objects(name).filter((o) => o.type === id).length);
  for (const v of EDITORS) {
    // Cubemap, Texture2DArray, Texture3D: 2019.4 refuses a compressed Texture3D.
    const old = v === "2019.4.41f2";
    assert.deepEqual(counts(`editor/${v}/cube-array-3d/windows`), [3, 6, old ? 1 : 3], v);
    assert.deepEqual(counts(`editor/${v}/cube-array-3d/android`), [2, 4, old ? 0 : 2], v);
  }
});

test("obj.read() and asset.data of each class: the reader, the image data and the platform", () => {
  const name = "editor/6000.3.26f1/cube-array-3d/windows";
  const env = load([{ name, data: loadFixture(name) }]);
  const types = new Set<string>();
  for (const asset of env.assets()) {
    if (!CLASSES.includes(asset.classId)) continue;
    types.add(asset.type);
    assert.equal(asset.type, asset.typeName);
    assert.notEqual(asset.name, "");
    const data = asset.reader.read<CubemapData | Texture2DArrayData | Texture3DData>();
    assert.deepEqual(data.imageData, data["image data"]);
    assert.ok(data.imageData.length > 0);
    assert.equal(data.platform, BuildTarget.StandaloneWindows64);
    const fields = asset.data as { name: string; imageData: Uint8Array; width: number };
    assert.equal(fields.name, asset.name);
    assert.deepEqual(fields.imageData, data.imageData);
    assert.equal(fields.width, data.m_Width);
    if (asset.type === "Cubemap") {
      const cube = asset.data as { sourceTextures: unknown[]; imageCount: number };
      assert.equal(cube.imageCount, 6);
      assert.equal(cube.sourceTextures.length, (data as CubemapData).m_SourceTextures.length);
    } else {
      const layered = asset.data as { depth: number; format: number; dataSize: number };
      assert.equal(layered.depth, (data as Texture3DData).m_Depth);
      assert.equal(layered.format, (data as Texture3DData).m_Format);
      assert.equal(layered.dataSize, data.imageData.length);
    }
  }
  assert.deepEqual([...types].sort(), ["Cubemap", "Texture2DArray", "Texture3D"]);
});

test("the image data's layout: six faces, slices of m_DataSize / m_Depth, levels with their slices", () => {
  for (const name of BUNDLES) {
    for (const reader of objects(name)) {
      if (reader.type === ClassID.Cubemap) {
        const cube = readCubemap(reader);
        // m_CompleteImageSize is one face, all its levels.
        assert.equal(cube["image data"].length, 6 * cube.m_CompleteImageSize, cube.m_Name);
        assert.equal(cube.m_ImageCount, 6);
      } else {
        const t = reader.type === ClassID.Texture3D ? readTexture3D(reader) : readTexture2DArray(reader);
        assert.equal(t["image data"].length, t.m_DataSize, t.m_Name);
        assert.equal(t.m_DataSize % t.m_Depth, 0, t.m_Name);
      }
    }
  }
});

// --- GraphicsFormat ----------------------------------------------------------------------

test("each GraphicsFormat in the fixtures maps to the format the editor reports", () => {
  // The editor's own Texture2DArray.format / Texture3D.format for each fixture
  // (BUILDING.md section 31's names: <TextureFormat>_<name>).
  const seen = new Set<number>();
  for (const name of BUNDLES) {
    for (const reader of objects(name)) {
      if (reader.type === ClassID.Cubemap) continue;
      const t = reader.type === ClassID.Texture3D ? readTexture3D(reader) : readTexture2DArray(reader);
      const editorFormat = Number(t.m_Name.split("_")[1]);
      assert.equal(textureFormatOfGraphicsFormat(t.m_Format), editorFormat, `${name} ${t.m_Name}`);
      // The sRGB ones are named so, and only they hold an sRGB GraphicsFormat.
      const srgb = Object.entries(GraphicsFormat).find(([, v]) => v === t.m_Format)![0];
      assert.equal(srgb.endsWith("_SRGB"), t.m_Name.endsWith("_sRGB"), t.m_Name);
      seen.add(t.m_Format);
    }
  }
  // Every mapped value is one a fixture holds.
  assert.deepEqual([...seen].sort((a, b) => a - b), Object.values(GraphicsFormat).sort((a, b) => a - b));
});

test("any other GraphicsFormat is refused, naming the value", () => {
  for (const value of [0, 5, 59, 98, 101, 145, 999]) {
    assert.throws(
      () => textureFormatOfGraphicsFormat(value),
      (err: unknown) =>
        err instanceof UnsupportedError && err.kind === "graphics format" && err.found === value,
    );
  }
  assert.equal(textureFormatOfGraphicsFormat(GraphicsFormat.RGBA_ASTC4X4_SRGB), TextureFormat.ASTC_RGB_4x4);
});

// --- hand-built layouts at every TPK version ---------------------------------------------

/**
 * TPK keys whose layout no release has: interim alphas the readers' release
 * gates misread (the ponytail on `readTexture`). Each is checked to differ.
 */
const INTERIM: Record<number, string[]> = {
  [ClassID.Cubemap]: [
    "2020.1.0a3",
    "2020.1.0a8",
    "2020.1.0a15",
    "2020.1.0a17",
    "2020.1.0a19",
    "2020.2.0a11",
    "2023.1.0a1",
  ],
  [ClassID.Texture2DArray]: ["2020.2.0a11", "2023.2.0a10", "2023.2.0a14"],
  [ClassID.Texture3D]: ["2020.2.0a11"],
};

/** A template object of a class, from the 2019.4 windows bundle. */
const templateOf = (classId: number): Template => template(WINDOWS_2019, classId);

for (const classId of CLASSES) {
  for (const [key, nodes] of Object.entries(TPK[String(classId)]!)) {
    const interim = INTERIM[classId]!.includes(key);
    test(`TPK ${CLASS_NAMES[classId]} ${key}: ${interim ? "an interim alpha is misread" : "a filled object reads the same through Unity's type tree"}`, () => {
      const reader = tpkReader(templateOf(classId), filled(nodes), nodes, versionOf(key));
      const tree = reader.readTypeTree() as Record<string, unknown>;
      assert.equal(reader.position, reader.byteSize);
      const stream = tree.m_StreamData as { offset: bigint | number };
      const want = { ...tree, m_StreamData: { ...stream, offset: Number(stream.offset) } };
      if (interim) {
        let got: unknown;
        try {
          got = READERS[classId]!(reader);
        } catch (error) {
          assert.ok(error instanceof CorruptError, String(error));
          return;
        }
        assert.notDeepEqual(got, want);
        return;
      }
      const data = READERS[classId]!(reader);
      assert.equal(reader.position, reader.byteSize);
      assert.deepEqual(Object.keys(data), Object.keys(tree));
      assert.deepEqual(data, want);
    });
  }
}

test("TPK holds every class from 2019.1, the interim keys among them", () => {
  for (const classId of CLASSES) {
    const keys = Object.keys(TPK[String(classId)]!);
    for (const key of INTERIM[classId]!) assert.ok(keys.includes(key), key);
    assert.ok(keys.length > INTERIM[classId]!.length);
  }
});

// --- refusals ------------------------------------------------------------------------------

/** The first object of a class in a bundle, with its bytes, for a reader at another origin. */
function fixtureObject(classId: number): { from: Template; bytes: Uint8Array } {
  const from = template(WINDOWS_2019, classId);
  return { from, bytes: serializedOf(WINDOWS_2019).bytes(from.info.pathId) };
}

for (const classId of CLASSES) {
  const what = CLASS_NAMES[classId];
  test(`${what}: older than 2019.1, of an unknown version or an editor file is refused`, () => {
    const { from, bytes } = fixtureObject(classId);
    const read = READERS[classId]!;
    const at = (unity: UnityVersion, platform?: BuildTarget) =>
      readerOf(from, bytes, platform === undefined ? { unity } : { unity, platform });
    assert.throws(() => read(at([2018, 4, 36, 1])), versionRefusal("2018.4.36"));
    assert.throws(
      () => read(readerOf(from, bytes, { unity: [0, 0, 0, 0], text: "0.0.0" })),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "Unity version",
    );
    assert.throws(
      () => read(at([2019, 4, 41, 2], BuildTarget.NoTarget)),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
    );
  });

  test(`${what}: a truncated object or one with bytes left over is corrupt`, () => {
    const { from, bytes } = fixtureObject(classId);
    const read = READERS[classId]!;
    const origin = { unity: [2019, 4, 41, 2] as UnityVersion };
    assert.ok(read(readerOf(from, bytes, origin)));
    assert.throws(() => read(readerOf(from, bytes.subarray(0, bytes.length - 2), origin)), CorruptError);
    assert.throws(
      () => read(readerOf(from, withTail(bytes, 0, 0, 0, 0), origin)),
      (err: unknown) => err instanceof CorruptError && /ends at/.test(err.message),
    );
  });
}

test("with no image data inline or in a .resS, obj.read() is corrupt; a .resS not loaded is missing", () => {
  // The 2019.4 windows Texture3D (RGBA32, 4692 bytes, no padding), its image
  // data cut out by hand: the count 0, then m_StreamData (2019: 32-bit
  // offset, size, path) empty or naming a .resS.
  const { from, bytes } = fixtureObject(ClassID.Texture3D);
  const origin = { unity: [2019, 4, 41, 2] as UnityVersion };
  const texture = readTexture3D(readerOf(from, bytes, origin));
  assert.equal(texture["image data"].length % 4, 0);
  const head = bytes.subarray(0, bytes.length - 12 - texture["image data"].length - 4);
  const path = new TextEncoder().encode("archive:/CAB-0/CAB-0.resS");
  const object = (stream: number[]) => new Uint8Array([...head, 0, 0, 0, 0, ...stream]);
  const empty = object([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(
    () => readObjectData(readerOf(from, empty, origin), undefined),
    (err: unknown) => err instanceof CorruptError && /Texture3D .* has no image data/.test(err.message),
  );
  const pad = new Array<number>((4 - (path.length % 4)) % 4).fill(0);
  const streamed = object([0, 0, 0, 0, 16, 0, 0, 0, path.length, 0, 0, 0, ...path, ...pad]);
  assert.throws(
    () => readObjectData(readerOf(from, streamed, origin), undefined),
    (err: unknown) => err instanceof ResourceNotFoundError && err.fileName === "CAB-0.resS",
  );
});
