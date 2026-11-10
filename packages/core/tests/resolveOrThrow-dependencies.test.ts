import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, loadFixture } from "../../../fixtures/helpers.js";
import {
  ClassID,
  CorruptError,
  load,
  readAssetBundle,
  resolveOrThrow,
  ResourceNotFoundError,
  type ObjectReader,
} from "../src/index.js";

const WHAT = "the pointer";
/** Every object of these fixtures points into the file of external 1, never loaded here. */
const EXTERNAL = { m_FileID: 1, m_PathID: 1n };

/** The `m_Dependencies` the oracle dumped for the fixture's AssetBundle object. */
function declared(name: string): string[] {
  const found: string[][] = [];
  for (const file of Object.values(golden(name).serialized ?? {})) {
    for (const { value } of Object.values(file.typetrees)) {
      const dependencies = (value as { m_Dependencies?: unknown }).m_Dependencies;
      if (Array.isArray(dependencies)) found.push(dependencies as string[]);
    }
  }
  assert.equal(found.length, 1, `${name}: expected one AssetBundle in the golden`);
  return found[0]!;
}

/** The message `resolveOrThrow` throws for `EXTERNAL` from `from`, as a ResourceNotFoundError. */
function messageFor(env: ReturnType<typeof load>, from: ObjectReader): string {
  let message: string | undefined;
  assert.throws(
    () => resolveOrThrow(env, EXTERNAL, from, WHAT),
    (error: unknown) => {
      assert.ok(error instanceof ResourceNotFoundError, `got ${String(error)}`);
      message = error.message;
      return true;
    },
  );
  return message!;
}

function objectOf(env: ReturnType<typeof load>, cab: string): ObjectReader {
  const object = env.objects.find((o) => o.fileName === cab);
  assert.ok(object, `no object in ${cab}`);
  return object;
}

for (const name of [
  "editor/2019.4.41f2/lz4/main",
  "editor/2019.4.41f2/material/lz4/material",
  "editor/2019.4.41f2/scene/lz4/scene",
  "editor/2019.4.41f2/spine/lz4/split",
]) {
  test(`${name} without its dependency: the message names its declared dependencies`, () => {
    const dependencies = declared(name);
    assert.ok(dependencies.length > 0, `${name} declares no dependencies`);
    const env = load([{ name, data: loadFixture(name) }]);
    const [cab] = Object.keys(golden(name).serialized ?? {});
    const external = golden(name).serialized![cab!]!.externals[0]!.path.split("/").at(-1);
    assert.equal(
      messageFor(env, objectOf(env, cab!)),
      `${WHAT} (path id 1) is in ${external}, which is not loaded: pass it to load() too ` +
        `(this bundle declares dependencies: ${dependencies.join(", ")})`,
    );
  });
}

test("an AssetBundle declaring no dependencies adds no hint, nor does another bundle's", () => {
  const font = "editor/2019.4.41f2/lz4/font";
  const main = "editor/2019.4.41f2/lz4/main";
  assert.deepEqual(declared(font), []);
  assert.ok(declared(main).length > 0);
  // main's AssetBundle declares dependencies, but it is not in font's file.
  const env = load([font, main].map((name) => ({ name, data: loadFixture(name) })));
  const [cab] = Object.keys(golden(font).serialized ?? {});
  assert.equal(
    messageFor(env, objectOf(env, cab!)),
    `${WHAT} (path id 1) is in unity default resources, which is not loaded: ` +
      "pass it to load() too",
  );
});

/**
 * A copy of the uncompressed main bundle, and where its `m_Dependencies` (count
 * 1, then one string, as the bundle stores it uncompressed) starts in it.
 */
function uncompressedMain(): { name: string; dependency: string; data: Uint8Array; at: number } {
  const name = "editor/2019.4.41f2/uncompressed/main";
  const [dependency, ...rest] = declared(name);
  assert.ok(dependency !== undefined && rest.length === 0);
  const pattern = [1, 0, 0, 0, dependency.length, 0, 0, 0, ...new TextEncoder().encode(dependency)];
  const data = loadFixture(name).slice();
  const at: number[] = [];
  for (let i = 0; i + pattern.length <= data.length; i++) {
    if (pattern.every((byte, j) => data[i + j] === byte)) at.push(i);
  }
  assert.equal(at.length, 1, "m_Dependencies not found once in the bundle");
  return { name, dependency, data, at: at[0]! };
}

test("two bundles with the same CAB name: each message names its own bundle's dependencies", () => {
  const { name, dependency, data: original, at } = uncompressedMain();
  // The same bundle, its one dependency renamed in place (same length).
  const renamed = dependency.slice(0, -1) + (dependency.endsWith("x") ? "y" : "x");
  const data = original.slice();
  data.set(new TextEncoder().encode(renamed), at + 8);

  const env = load([
    { name: "first/main", data: original },
    { name: "second/main", data },
  ]);
  const [cab] = Object.keys(golden(name).serialized ?? {});
  const external = golden(name).serialized![cab!]!.externals[0]!.path.split("/").at(-1);
  // Objects come in load order: the first bundle's, then the second's.
  const inCab = env.objects.filter((o) => o.fileName === cab);
  assert.equal(inCab.length % 2, 0);
  const prefix = `${WHAT} (path id 1) is in ${external}, which is not loaded: pass it to load() too`;
  assert.equal(
    messageFor(env, inCab[0]!),
    `${prefix} (this bundle declares dependencies: ${dependency})`,
  );
  assert.equal(
    messageFor(env, inCab.at(-1)!),
    `${prefix} (this bundle declares dependencies: ${renamed})`,
  );
});

test("SerializedFiles passed in on their own: each gets only its own file's dependencies", () => {
  const font = "editor/2019.4.41f2/lz4/font";
  const main = "editor/2019.4.41f2/lz4/main";
  assert.deepEqual(declared(font), []);
  const mainDependencies = declared(main);
  assert.ok(mainDependencies.length > 0);
  // Each bundle's SerializedFile, taken out and passed to load() as a loose input.
  const loose = (name: string): { name: string; data: Uint8Array } => {
    const [cab] = Object.keys(golden(name).serialized ?? {});
    const file = load([{ name, data: loadFixture(name) }]).files.find(
      (f) => f.path.split("/").at(-1) === cab,
    );
    assert.ok(file, `${name}: no ${cab} in the bundle`);
    return { name: cab!, data: file.data };
  };
  const fontFile = loose(font);
  const mainFile = loose(main);
  const env = load([fontFile, mainFile]);

  // main's AssetBundle is loaded next to font's file, but in another file.
  assert.equal(
    messageFor(env, objectOf(env, fontFile.name)),
    `${WHAT} (path id 1) is in unity default resources, which is not loaded: ` +
      "pass it to load() too",
  );
  const external = golden(main).serialized![mainFile.name]!.externals[0]!.path.split("/").at(-1);
  assert.equal(
    messageFor(env, objectOf(env, mainFile.name)),
    `${WHAT} (path id 1) is in ${external}, which is not loaded: pass it to load() too ` +
      `(this bundle declares dependencies: ${mainDependencies.join(", ")})`,
  );
});

test("an AssetBundle that cannot be read adds no hint and keeps the ResourceNotFoundError", () => {
  const { name, data, at } = uncompressedMain();
  // A count far past the object's end: readAssetBundle throws a CorruptError.
  new DataView(data.buffer).setInt32(at, 0x7fffffff, true);

  const env = load([{ name, data }]);
  const [cab] = Object.keys(golden(name).serialized ?? {});
  const external = golden(name).serialized![cab!]!.externals[0]!.path.split("/").at(-1);
  const bundle = env.objects.find((o) => o.type === ClassID.AssetBundle);
  assert.ok(bundle);
  assert.throws(() => readAssetBundle(bundle), CorruptError);
  assert.equal(
    messageFor(env, objectOf(env, cab!)),
    `${WHAT} (path id 1) is in ${external}, which is not loaded: pass it to load() too`,
  );
});
