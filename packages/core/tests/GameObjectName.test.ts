// `asset.name` of a GameObject in a bundle built without type trees (#308):
// its m_Name, read from the header upstream's GameObject reader reads,
// against UnityPy's names (R12) for every animator lz4-notypetree fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { golden, loadFixture, type Golden } from "../../../fixtures/helpers.js";
import { makeAsset } from "../src/asset.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { readerOf, withTail } from "./media.js";
import { serializedOf } from "./tpk-layouts.js";

/** `fixtures/modern-goldens.json`: 6000.6.4f1's fixtures are not in the main golden set. */
const MODERN = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/modern-goldens.json", import.meta.url), "utf8"),
  ) as { fixtures: Record<string, Golden> }
).fixtures;

for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"]) {
  const name = `editor/${editor}/animator/lz4-notypetree/animator`;
  test(`${name}: every GameObject's name is UnityPy's`, () => {
    const g = MODERN[name] ?? golden(name);
    const env = load([{ name, data: loadFixture(name) }]);
    const objects = [...env.assets()].filter((asset) => asset.classId === ClassID.GameObject);
    assert.ok(objects.length > 0, `${name} holds GameObjects`);
    for (const asset of objects) {
      const where = `${asset.file} ${asset.pathId}`;
      assert.equal(asset.reader.serializedType?.nodes?.length ?? 0, 0, `${where} has no type tree`);
      const expected = g.serialized![asset.file]!.names[String(asset.pathId)];
      assert.ok(expected, `${where} has a name in the golden`);
      assert.equal(asset.name, expected, where);
    }
  });
}

test("a GameObject its reader refuses is named \"\"; a corrupt one throws", () => {
  // Built without type trees, so `name` reads the header.
  const name = "editor/2019.4.41f2/animator/lz4-notypetree/animator";
  const env = load([{ name, data: loadFixture(name) }]);
  const { sf, bytes: bytesOf } = serializedOf(name);
  const info = sf.objects.find((o) => o.classId === ClassID.GameObject)!;
  const from = { sf, info };
  const bytes = bytesOf(info.pathId);
  const containers = () => ({ pathOf: new Map(), byPath: new Map() });
  const nameOf = (reader: ObjectReader) => makeAsset(reader, "test", containers, env).name;
  const unity: UnityVersion = [2019, 4, 41, 2];
  // A known version reads the name, so "" below is the fallback, not the data.
  const known = nameOf(readerOf(from, bytes, { unity }));
  assert.notEqual(known, "");
  const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
  const refused: ObjectReader[] = [
    readerOf(from, bytes, { unity: [2018, 4, 36, 1] }),
    readerOf(from, bytes, { ...stripped, format: 22 }),
    readerOf(from, bytes, { unity, platform: BuildTarget.NoTarget }),
  ];
  for (const reader of refused) assert.equal(nameOf(reader), "", reader.unityVersion);
  // Stripped in format 21 reads as 2019, which only the header has to fit.
  assert.equal(nameOf(readerOf(from, bytes, { ...stripped, format: 21 })), known);
  assert.equal(nameOf(readerOf(from, withTail(bytes, 0, 0, 0, 0), { ...stripped, format: 21 })),
    known);
  // Cut inside the components array, with the version known: corrupt, not "".
  assert.throws(() => nameOf(readerOf(from, bytes.slice(0, 8), { unity })), CorruptError);
});
