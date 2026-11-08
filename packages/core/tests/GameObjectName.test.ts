// `asset.name` of a GameObject in a bundle built without type trees (#308):
// its m_Name, read from the header upstream's GameObject reader reads,
// against UnityPy's names (R12) for every animator lz4-notypetree fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { golden, loadFixture, type Golden } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { ClassID } from "../src/serialized/ClassID.js";

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
