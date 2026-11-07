import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, loadFixture } from "../../../fixtures/helpers.js";
import {
  ClassID,
  CorruptError,
  load,
  resolveOrThrow,
  ResourceNotFoundError,
  type Env,
  type ObjectReader,
  type PPtr,
} from "../src/index.js";

const MAIN = "editor/6000.3.25f1/lz4/main";
const SHARED = "editor/6000.3.25f1/lz4/shared";
const MAIN_CAB = "CAB-ba01e3c16ba268ec36e9543a39dc83ad";
const SHARED_CAB = "CAB-71fca072df859359e7a6b09ff7151c53";
const WHAT = "the behaviour's textRef";

function loadFixtures(...names: string[]): Env {
  return load(names.map((name) => ({ name, data: loadFixture(name) })));
}

/** The env's only MonoBehaviour, which main holds. */
function behaviourOf(env: Env): ObjectReader {
  const object = env.objects.find((o) => o.type === ClassID.MonoBehaviour);
  assert.ok(object, "no MonoBehaviour");
  return object;
}

/** The behaviour's `textRef`, from the oracle's dump: a TextAsset in shared. */
function textRef(behaviour: ObjectReader): PPtr {
  const entry = golden(MAIN).serialized?.[MAIN_CAB]?.typetrees[String(behaviour.pathId)];
  assert.ok(entry, `${MAIN} has no typetree dump for object ${behaviour.pathId}`);
  const dumped = entry.value as { textRef: { m_FileID: number; m_PathID: string } };
  const { m_FileID, m_PathID } = dumped.textRef;
  return { m_FileID, m_PathID: BigInt(m_PathID) };
}

/** `fn` throws a `CorruptError` with exactly `message`. */
function throwsCorrupt(fn: () => unknown, message: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CorruptError, `expected a CorruptError, got ${String(error)}`);
    assert.equal(error.message, message);
    return true;
  });
}

test("found: the object, with or without a class to check", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = behaviourOf(env);
  const pointer = textRef(behaviour);
  const text = resolveOrThrow(env, pointer, behaviour, WHAT, ClassID.TextAsset);
  assert.equal(text.type, ClassID.TextAsset);
  assert.equal(text.pathId, pointer.m_PathID);
  assert.equal(resolveOrThrow(env, pointer, behaviour, WHAT), text);
});

test("found, of the wrong class: CorruptError naming both classes", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = behaviourOf(env);
  const pointer = textRef(behaviour);
  throwsCorrupt(
    () => resolveOrThrow(env, pointer, behaviour, WHAT, ClassID.Texture2D),
    `${WHAT} (path id ${pointer.m_PathID}) is class ${ClassID.TextAsset}, ` +
      `not ${ClassID.Texture2D}`,
  );
});

test("a null pointer: CorruptError", () => {
  const env = loadFixtures(MAIN);
  const behaviour = behaviourOf(env);
  throwsCorrupt(
    () => resolveOrThrow(env, { m_FileID: 0, m_PathID: 0n }, behaviour, WHAT),
    `${WHAT} is a null pointer`,
  );
});

test("a file id past the file's externals: CorruptError with the file id", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = behaviourOf(env);
  // main has one external, so 2 is the first id out of range.
  throwsCorrupt(
    () => resolveOrThrow(env, { m_FileID: 2, m_PathID: 1n }, behaviour, WHAT, ClassID.TextAsset),
    `${WHAT} has file id 2, past the file's externals`,
  );
});

test("a file not loaded: ResourceNotFoundError naming the file", () => {
  const env = loadFixtures(MAIN);
  const behaviour = behaviourOf(env);
  const pointer = textRef(behaviour);
  assert.throws(
    () => resolveOrThrow(env, pointer, behaviour, WHAT, ClassID.TextAsset),
    (error: unknown) => {
      assert.ok(error instanceof ResourceNotFoundError, `got ${String(error)}`);
      assert.equal(error.path, SHARED_CAB);
      assert.equal(error.fileName, SHARED_CAB);
      assert.equal(
        error.message,
        `${WHAT} (path id ${pointer.m_PathID}) is in ${SHARED_CAB}, which is not loaded: ` +
          "pass it to load() too",
      );
      return true;
    },
  );
});

test("an object its file does not hold: CorruptError naming the file", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = behaviourOf(env);
  const missing = 1234567890123n;
  throwsCorrupt(
    () => resolveOrThrow(env, { m_FileID: 1, m_PathID: missing }, behaviour, WHAT),
    `${WHAT} (path id ${missing}) is not in ${SHARED_CAB}`,
  );
  throwsCorrupt(
    () => resolveOrThrow(env, { m_FileID: 0, m_PathID: missing }, behaviour, WHAT),
    `${WHAT} (path id ${missing}) is not in ${MAIN_CAB}`,
  );
});
