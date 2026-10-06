// Format-23 metadata and generic dumps use the independent UnityPy 1.25.4
// sidecar; the Sprite and SpriteAtlas class readers are checked against it in
// Sprite.test.ts, and texture conversion remains separate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { loadFixture, type Golden, type GoldenType } from "../../../fixtures/helpers.js";
import { readBundle } from "../src/bundle/BundleFile.js";
import { load } from "../src/env.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile } from "../src/serialized/SerializedFile.js";
import type { SerializedType } from "../src/serialized/TypeTree.js";

function asGolden(type: SerializedType): GoldenType {
  const hex = (bytes: Uint8Array | null) => bytes && Buffer.from(bytes).toString("hex");
  return {
    classId: type.classId,
    isStrippedType: type.isStrippedType,
    scriptTypeIndex: type.scriptTypeIndex,
    scriptId: hex(type.scriptId),
    oldTypeHash: hex(type.oldTypeHash),
    typeDependencies: type.typeDependencies,
    nodes: type.nodes?.map((n) => [n.level, n.type, n.name, n.byteSize, n.metaFlag]) ?? null,
  };
}

/** Plan §5 normalization, using the oracle's float tags to select bit width. */
function normalize(value: unknown, expected: unknown): unknown {
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString("hex")}`;
  if (typeof value === "number" && typeof expected === "string" && /^f(32|64):/.test(expected)) {
    const bytes = Buffer.alloc(expected.startsWith("f32:") ? 4 : 8);
    if (bytes.length === 4) bytes.writeFloatBE(value);
    else bytes.writeDoubleBE(value);
    return `${expected.substring(0, 4)}${bytes.toString("hex")}`;
  }
  if (Array.isArray(value)) {
    assert.ok(Array.isArray(expected));
    return value.map((item, i) => normalize(item, expected[i]));
  }
  if (value !== null && typeof value === "object") {
    const fields = expected as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, normalize(item, fields[key])],
    ));
  }
  return value;
}

test("RGB48 records AssetStudio's verdict and labels the conflicting UnityPy hash", () => {
  const candidates = JSON.parse(readFileSync(
    new URL("../../../fixtures/modern-goldens.json", import.meta.url), "utf8",
  ));
  const fixture = candidates.fixtures["editor/6000.6.4f1/more-plain/textures"];
  const serialized = Object.values(fixture.serialized)[0] as {
    textures: Record<string, {
      name: string; rgbaSha256: string; oracleNote?: string;
      assetStudioCrossCheck?: { verdict: string; rgbaSha256: string; firstPixel: number[] };
    }>;
  };
  const rgb48 = Object.values(serialized.textures).find((texture) => texture.name === "RGB48")!;
  assert.match(rgb48.oracleNote ?? "", /Verdict: AssetStudio/);
  assert.match(rgb48.oracleNote ?? "", /unsuitable for decoder acceptance/);
  assert.equal(rgb48.rgbaSha256,
    "fd817234260f3ee0ecb98fb3a62a963943b7bbc8cd5f525de91db3581a8a9cbd");
  assert.equal(rgb48.assetStudioCrossCheck?.verdict, "AssetStudio");
  assert.equal(rgb48.assetStudioCrossCheck?.rgbaSha256,
    "03d886e69c09698f9a1f94e48f2365c8470cbb730686af697ada98730e31db9d");
  assert.deepEqual(rgb48.assetStudioCrossCheck?.firstPixel, [48, 122, 196, 255]);
});

for (const folder of ["more-plain", "sprite", "variant", "sprite-v2", "sprite-v2-rect"]) {
  const name = `editor/6000.6.4f1/${folder}/${folder === "more-plain" ? "textures" : "sprites"}`;
  test(`${name}: format-23 metadata and type-tree dumps match UnityPy`, () => {
    const path = new URL("../../../fixtures/modern-goldens.json", import.meta.url);
    assert.ok(existsSync(path), "candidate oracle goldens must be generated");
    const candidates = JSON.parse(readFileSync(path, "utf8")) as {
      fixtures: Record<string, Golden>;
    };
    const expected = candidates.fixtures[name]!;
    assert.ok(expected, `no candidate golden for ${name}`);
    const { files } = readBundle(loadFixture(name));
    assert.deepEqual(files.map((file) => file.path).sort(), Object.keys(expected.files).sort());
    for (const file of files) {
      const golden = expected.files[file.path]!;
      assert.equal(file.data.length, golden.size);
      assert.equal(createHash("sha256").update(file.data).digest("hex"), golden.sha256);
      const serialized = expected.serialized![file.path];
      if (serialized) {
        const sf = readSerializedFile(file.data);
        assert.equal(sf.header.version, serialized.formatVersion);
        assert.equal(sf.header.version, 23);
        assert.equal(sf.header.fileSize, file.data.length);
        assert.equal(sf.unityVersion, serialized.unityVersion);
        assert.equal(sf.targetPlatform, serialized.targetPlatform);
        assert.equal(sf.bigEndian, serialized.bigEndian);
        assert.equal(sf.enableTypeTree, serialized.enableTypeTree);
        assert.deepEqual(sf.externals.map((external) => ({
          path: external.pathName,
          guid: external.guid && Buffer.from(external.guid).toString("hex"),
          type: external.type,
        })), serialized.externals);
        assert.deepEqual(sf.types.map(asGolden), serialized.types);
        assert.deepEqual(sf.refTypes, []);
        assert.deepEqual(serialized.refTypes, []);
        const table = sf.objects.map((object) => ({
          pathId: String(object.pathId), classId: object.classId, byteSize: object.byteSize,
        })).sort((a, b) => a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0);
        assert.deepEqual(table, expected.objects[file.path]);
        for (const object of sf.objects) {
          assert.ok(object.byteStart >= sf.header.dataOffset);
          assert.ok(object.byteStart + object.byteSize <= file.data.length);
          const dump = serialized.typetrees[String(object.pathId)];
          assert.ok(dump, `no oracle dump for ${object.pathId}`);
          const value = new ObjectReader(file.data, sf, object).readTypeTree();
          assert.deepEqual(normalize(value, dump.value), dump.value, `object ${object.pathId}`);
        }
      }
    }
    const env = load([{ name, data: loadFixture(name) }]);
    assert.equal(env.objects.length, Object.values(expected.objects).flat().length);
  });
}
