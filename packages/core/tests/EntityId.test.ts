// A childless `EntityId` node (Unity 6000.2 and later, #307): readTypeTree()
// reads it by its byteSize, and readAnimatorController() reads a controller's
// `m_EntityIdValues` the same way, in objects laid out from Unity's own player
// type trees (`fixtures/tpk-trees.json`, UnityPy's TPK data, R12) for 6000.3
// (4 bytes) and 6000.6 (8 bytes). No fixture controller has an entity id.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readAnimatorController } from "../src/classes/AnimatorController.js";
import { UnsupportedError } from "../src/errors.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { Template } from "./media.js";
import { filled, serializedOf, tpkReader, treeAt, versionOf } from "./tpk-layouts.js";

/** A fixture controller, for its file and type entry. */
const FROM: Template = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/animator/lz4/animator");
  return { sf, info: sf.objects.find((o) => o.classId === ClassID.AnimatorController)! };
})();

/** Each layout: its version, the `EntityId` node's size, and the values read. */
const LAYOUTS = [
  // An Int32: the second element's bytes are all 0xFF, so -1.
  ["6000.3.26f1", 4, [0x01010101, -1]],
  // A UInt64: 0xFF bytes are 2^64 - 1.
  ["6000.6.4f1", 8, [0x0101010101010101n, 0xffffffffffffffffn]],
] as const;

/**
 * A filled controller of `version` with two entity ids, the second's bytes
 * all 0xFF.
 */
function controller(text: string, size: number) {
  const version = versionOf(text);
  const nodes = treeAt(ClassID.AnimatorController, version.unity);
  const bytes = filled(nodes, 2);
  // The vector: a count of 2, then element 0 of 0x01 bytes and element 1 of 0x02.
  const at = bytes.findIndex((_, i) =>
    [2, 0, 0, 0, ...Array<number>(size).fill(1), ...Array<number>(size).fill(2)].every(
      (b, j) => bytes[i + j] === b,
    ),
  );
  assert.ok(at >= 0, "the entity ids are in the filled bytes");
  bytes.fill(0xff, at + 4 + size, at + 4 + 2 * size);
  return { reader: tpkReader(FROM, bytes, nodes, version), nodes, version };
}

for (const [text, size, values] of LAYOUTS) {
  test(`${text}: readTypeTree() reads a vector<EntityId> by its ${size}-byte node`, () => {
    const { reader, nodes } = controller(text, size);
    const entityId = nodes.find((n) => n[1] === "EntityId")!;
    assert.deepEqual([entityId[3], entityId[0] > 0], [size, true]);
    const tree = reader.readTypeTree() as {
      m_Controller: { m_DefaultValues: { data: { m_EntityIdValues: unknown } } };
    };
    assert.equal(reader.position, reader.byteSize);
    assert.deepStrictEqual(tree.m_Controller.m_DefaultValues.data.m_EntityIdValues, values);
  });

  test(`${text}: readAnimatorController() reads the entity ids as readTypeTree() does`, () => {
    const { reader } = controller(text, size);
    const tree = reader.readTypeTree();
    const data = readAnimatorController(reader);
    assert.equal(reader.position, reader.byteSize);
    assert.deepStrictEqual(data.m_Controller.m_DefaultValues.data.m_EntityIdValues, values);
    assert.deepStrictEqual(data, tree);
  });
}

test("readTypeTree() refuses a childless EntityId node of neither 4 nor 8 bytes", () => {
  const version = versionOf("6000.3.26f1");
  const nodes = treeAt(ClassID.AnimatorController, version.unity).map((n) =>
    n[1] === "EntityId" ? ([n[0], n[1], n[2], 2, n[4]] as typeof n) : n,
  );
  const reader = tpkReader(FROM, filled(nodes, 1), nodes, version);
  assert.throws(
    () => reader.readTypeTree(),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "EntityId size" && err.found === 2,
  );
});
