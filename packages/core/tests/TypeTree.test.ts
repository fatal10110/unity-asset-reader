import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture, type GoldenType } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { BinaryReader } from "../src/io/BinaryReader.js";
import { commonString } from "../src/serialized/CommonString.js";
import { readSerializedFile, type SerializedFile } from "../src/serialized/SerializedFile.js";
import { readSerializedType, type SerializedType } from "../src/serialized/TypeTree.js";

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

/** Every fixture whose golden describes at least one SerializedFile. */
const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);

/** Every SerializedFile node of every fixture, parsed, with its golden. */
const FILES = SERIALIZED_FIXTURES.flatMap((name) => {
  const nodes = load([{ name, data: loadFixture(name) }]).files;
  return Object.entries(golden(name).serialized!).map(([path, expected]) => {
    const data = nodes.find((f) => f.path === path)?.data;
    assert.ok(data, `${name} has no node ${path}`);
    return { name, path, sf: readSerializedFile(data), expected };
  });
});

/** A parsed type in the shape of its golden; ref type names only where Unity wrote them. */
function asGolden(t: SerializedType): GoldenType {
  const out: GoldenType = {
    classId: t.classId,
    isStrippedType: t.isStrippedType,
    scriptTypeIndex: t.scriptTypeIndex,
    scriptId: hex(t.scriptId),
    oldTypeHash: hex(t.oldTypeHash),
    typeDependencies: t.typeDependencies,
    nodes: t.nodes && t.nodes.map((n) => [n.level, n.type, n.name, n.byteSize, n.metaFlag]),
  };
  if (t.className !== null) out.className = t.className;
  if (t.namespace !== null) out.namespace = t.namespace;
  if (t.assemblyName !== null) out.assembly = t.assemblyName;
  return out;
}

// --- every editor-built fixture against the oracle goldens -------------------

for (const { name, path, sf, expected } of FILES) {
  test(`${name}: types of ${path} match the golden, nodes included`, () => {
    assert.deepEqual(sf.types.map(asGolden), expected.types);
  });

  test(`${name}: ref types of ${path} match the golden, nodes included`, () => {
    assert.deepEqual(sf.refTypes.map(asGolden), expected.refTypes);
  });
}

/** Files of one format, with type trees or without. */
function filesOf(format: number, enableTypeTree: boolean): SerializedFile[] {
  return FILES.filter(
    (f) => f.sf.header.version === format && f.expected.enableTypeTree === enableTypeTree,
  ).map((f) => f.sf);
}

for (const format of [21, 22]) {
  test(`format ${format}: the goldens cover type and ref type nodes`, () => {
    const files = filesOf(format, true);
    assert.ok(files.some((sf) => sf.types.some((t) => (t.nodes?.length ?? 0) > 0)));
    assert.ok(files.some((sf) => sf.refTypes.some((t) => (t.nodes?.length ?? 0) > 0)));
  });

  test(`format ${format}: names come from both the file's buffer and the common strings`, () => {
    const nodes = filesOf(format, true).flatMap((sf) =>
      [...sf.types, ...sf.refTypes].flatMap((t) => t.nodes ?? []),
    );
    const common = nodes.filter((n) => n.typeStrOffset >= 0x80000000);
    const local = nodes.filter((n) => n.typeStrOffset < 0x80000000);
    assert.ok(common.length > 0 && local.length > 0);
    // A resolved common string never falls back to its offset as text.
    for (const n of common) assert.doesNotMatch(n.type, /^\d+$/);
  });

  test(`format ${format}: files built without type trees have no nodes`, () => {
    const files = filesOf(format, false);
    assert.ok(files.length > 0);
    for (const sf of files) {
      for (const t of [...sf.types, ...sf.refTypes]) {
        assert.equal(t.nodes, null);
        assert.equal(t.stringBuffer, null);
        assert.equal(t.typeDependencies, null);
        assert.equal(t.className, null);
      }
    }
  });
}

// --- common strings -----------------------------------------------------------

test("commonString looks up Unity's built-in strings by offset", () => {
  assert.equal(commonString(0), "AABB");
  assert.equal(commonString(263), "MonoBehaviour");
  assert.equal(commonString(840), "string");
  assert.equal(commonString(1161), "Hash128");
});

// Past AssetStudio's table: newer editors, with the names UnityPy 1.25.3 gives them.
for (const [offset, name] of [
  [1169, "RenderingLayerMask"],
  [1188, "fixed_array"],
  [1200, "EntityId"],
  [1209, "LoadableObjectId"],
  [1226, "LoadableSceneId"],
] as const) {
  test(`commonString resolves ${offset} to UnityPy's ${name}`, () => {
    assert.equal(commonString(offset), name);
  });
}

test("commonString falls back to the offset as text, like upstream", () => {
  assert.equal(commonString(1), "1"); // inside "AABB", not the start of a string
  // Past the end of every known table: UnityPy's last entry, 1226, is 16 bytes.
  assert.equal(commonString(1300), "1300");
});

/** A format-22 `m_Types` entry with one blob node, no hashes beyond the old type hash. */
function blobType(typeStrOffset: number, nameStrOffset: number, strings: string): Uint8Array {
  const buffer = new TextEncoder().encode(strings);
  const bytes = new Uint8Array(4 + 1 + 2 + 16 + 8 + 32 + buffer.length + 4);
  const view = new DataView(bytes.buffer);
  let at = 0;
  view.setInt32(at, 1, true); // classId: Object
  at += 4 + 1; // isStrippedType
  view.setInt16(at, -1, true); // scriptTypeIndex
  at += 2 + 16; // oldTypeHash
  view.setInt32(at, 1, true); // node count
  view.setInt32(at + 4, buffer.length, true); // string buffer size
  at += 8;
  // version u16, level u8, typeFlags u8, type and name offsets, byteSize,
  // index, metaFlag, refTypeHash u64
  view.setUint32(at + 4, typeStrOffset, true);
  view.setUint32(at + 8, nameStrOffset, true);
  view.setInt32(at + 12, -1, true);
  at += 32;
  bytes.set(buffer, at);
  at += buffer.length;
  view.setInt32(at, 0, true); // no type dependencies
  return bytes;
}

test("a blob node resolves high-bit offsets through the common strings", () => {
  const data = blobType(0x80000000 + 263, 0, "Base\0");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["MonoBehaviour", "Base"]],
  );
});

test("a blob node resolves a common string newer than AssetStudio's table", () => {
  const data = blobType(0x80000000 + 1200, 0x80000000 + 55, "");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["EntityId", "Base"]],
  );
});

test("a blob node keeps an unknown common-string offset as text", () => {
  const data = blobType(0x80000000 + 5000, 0x80000000 + 55, "");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["5000", "Base"]],
  );
});

test("a blob node offset past its string buffer throws CorruptError", () => {
  const data = blobType(9, 0, "Base\0");
  assert.throws(
    () => readSerializedType(new BinaryReader(data, "little"), 22, true, false),
    CorruptError,
  );
});

/** Format-23 type: hashes, blob byte length, mhtt header, one node, then dependencies/names. */
function blobType23(little = true, isRefType = false, withBlob = true): Uint8Array {
  const strings = new TextEncoder().encode("Base\0");
  const blobSize = withBlob ? 16 + 32 + strings.length : 0;
  const suffix = isRefType ? new TextEncoder().encode("Example\0Tests\0Assembly\0") : null;
  const data = new Uint8Array(43 + blobSize + (suffix?.length ?? 8));
  const view = new DataView(data.buffer);
  view.setInt32(0, 1, little); // classId
  view.setInt16(5, -1, little); // scriptTypeIndex
  data.fill(0x42, 7, 23); // oldTypeHash
  data.fill(0xa5, 23, 39); // XXH3 content hash
  view.setInt32(39, blobSize, little);
  if (withBlob) {
    data.set(new TextEncoder().encode("mhtt"), 43);
    view.setInt32(47, 23, little);
    view.setInt32(51, 1, little); // node count
    view.setInt32(55, strings.length, little);
    view.setUint16(59, 1, little); // node version
    view.setUint32(63, 0x80000000 + 263, little); // common MonoBehaviour
    view.setInt32(71, -1, little); // byteSize
    view.setInt32(79, 0x8000, little); // metaFlag
    view.setBigUint64(83, 0xfedcba9876543210n, little);
    data.set(strings, 91);
  }
  const tail = 43 + blobSize;
  if (suffix) data.set(suffix, tail);
  else {
    view.setInt32(tail, 1, little); // one dependency
    view.setInt32(tail + 4, 7, little);
  }
  return data;
}

for (const endian of ["little", "big"] as const) {
  test(`format 23 reads the bounded mhtt blob in ${endian}-endian metadata`, () => {
    const data = blobType23(endian === "little");
    const reader = new BinaryReader(data, endian);
    const type = readSerializedType(reader, 23, true, false);
    assert.deepEqual(type.nodes!.map((node) => [
      node.type, node.name, node.version, node.byteSize, node.metaFlag, node.refTypeHash,
    ]), [["MonoBehaviour", "Base", 1, -1, 0x8000, 0xfedcba9876543210n]]);
    assert.deepEqual(type.typeDependencies, [7]);
    assert.equal(reader.remaining, 0);
    assert.equal(type.stringBuffer!.buffer, data.buffer, "string bytes remain a view (R7)");
  });
}

for (const isRefType of [false, true]) {
  test(`format 23 reads fields after a zero-length ${isRefType ? "ref " : ""}type tree`, () => {
    const reader = new BinaryReader(blobType23(true, isRefType, false), "little");
    const type = readSerializedType(reader, 23, true, isRefType);
    assert.equal(type.nodes, null);
    assert.equal(type.stringBuffer, null);
    if (isRefType) {
      assert.deepEqual([type.className, type.namespace, type.assemblyName],
        ["Example", "Tests", "Assembly"]);
    } else assert.deepEqual(type.typeDependencies, [7]);
    assert.equal(reader.remaining, 0);
  });
}

test("format 23 reads ref-type names after a non-empty blob", () => {
  const reader = new BinaryReader(blobType23(true, true), "little");
  const type = readSerializedType(reader, 23, true, true);
  assert.equal(type.nodes![0]!.name, "Base");
  assert.deepEqual([type.className, type.namespace, type.assemblyName],
    ["Example", "Tests", "Assembly"]);
  assert.equal(type.typeDependencies, null);
  assert.equal(reader.remaining, 0);
});

test("format 23 without type trees consumes neither the blob nor its new hash", () => {
  const data = blobType23();
  const reader = new BinaryReader(data, "little");
  const type = readSerializedType(reader, 23, false, false);
  assert.equal(type.nodes, null);
  assert.equal(type.typeDependencies, null);
  assert.equal(reader.position, 23);
  assert.equal(reader.readUInt8(), 0xa5, "the content hash was not consumed");
});

for (const [what, mutate, message] of [
  ["bad magic", (data: Uint8Array) => { data[43] = 0; }, /magic.*mhtt/],
  ["inconsistent format", (data: Uint8Array) => {
    new DataView(data.buffer).setInt32(47, 22, true);
  }, /format.*22.*23/],
  ["negative length", (data: Uint8Array) => {
    new DataView(data.buffer).setInt32(39, -1, true);
  }, /size.*negative/],
  ["length past the input", (data: Uint8Array) => {
    new DataView(data.buffer).setInt32(39, data.length, true);
  }, /size.*bytes left/],
  ["blob truncated inside the string buffer", (data: Uint8Array) => {
    new DataView(data.buffer).setInt32(39, 52, true);
  }, /type tree.*read of 5 bytes.*4 of 52/],
  ["blob with trailing bytes", (data: Uint8Array) => {
    new DataView(data.buffer).setInt32(39, 54, true);
  }, /type tree.*53.*54/],
] as const) {
  test(`format 23 refuses ${what} with CorruptError`, () => {
    const data = blobType23();
    mutate(data);
    assert.throws(() => readSerializedType(new BinaryReader(data, "little"), 23, true, false),
      (error: unknown) => error instanceof CorruptError && message.test(error.message));
  });
}

// --- the pre-5.0 inline layout --------------------------------------------------

/** A pre-blob (format 8) node written depth-first, as Unity stores it. */
interface LegacyNode {
  type: string;
  name: string;
  children?: LegacyNode[];
}

/** A format-8 `m_Types` entry: class id, then the inline tree, nothing after. */
function legacyType(root: LegacyNode): Uint8Array {
  const bytes: number[] = [];
  const i32 = (v: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    bytes.push(...b);
  };
  const str = (v: string): void => {
    bytes.push(...new TextEncoder().encode(v), 0);
  };
  const write = (node: LegacyNode): void => {
    str(node.type);
    str(node.name);
    // byteSize, index, typeFlags, version, metaFlag
    for (const v of [-1, 0, 0, 1, 0]) i32(v);
    i32(node.children?.length ?? 0);
    for (const child of node.children ?? []) write(child);
  };
  i32(1); // classId: Object
  write(root);
  return Uint8Array.from(bytes);
}

test("the inline layout returns to a sibling after a nested subtree", () => {
  const data = legacyType({
    type: "Root",
    name: "Base",
    children: [
      { type: "A", name: "a", children: [{ type: "A1", name: "a1" }] },
      { type: "B", name: "b" },
    ],
  });
  const reader = new BinaryReader(data, "little");
  const type = readSerializedType(reader, 8, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.level, n.type, n.name]),
    [
      [0, "Root", "Base"],
      [1, "A", "a"],
      [2, "A1", "a1"],
      [1, "B", "b"],
    ],
  );
  assert.equal(reader.remaining, 0);
});
