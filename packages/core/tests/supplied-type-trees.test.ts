// Type trees supplied through `LoadOptions.typeTrees` (#339): the MonoBehaviours
// of a build without type trees, read with their typed twin's trees and checked
// against UnityPy's `read_typetree(nodes)` of the same stripped objects (R12).

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture, suppliedTypeTreeGoldens } from "../../../fixtures/helpers.js";
import { load, type Env, type LoadOptions } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { readTypeTreesOption, type TypeTreeNodeData } from "../src/serialized/supplied.js";
import { readTypeTree, setTypeTreeSupplier } from "../src/serialized/TypeTreeReader.js";
import { objectBytes, synthetic } from "./class-readers.js";

const STRIPPED = "editor/2019.4.41f2/spine/lz4-notypetree/skeletons";
const golden = suppliedTypeTreeGoldens()[STRIPPED]!;
const TYPED = golden.typedTwin;
const SKELETON = "Assembly-CSharp.dll:Spine.Unity.SkeletonDataAsset";
const ATLAS = "Assembly-CSharp.dll:Spine.Unity.SpineAtlasAsset";

type Row = [number, string, string, number, number];

const toData = (rows: Row[]): TypeTreeNodeData[] =>
  rows.map(([level, type, name, byteSize, metaFlag]) => ({ level, type, name, byteSize, metaFlag }));

/** Each script's golden tree, keyed by `key` (its name or its script id). */
function trees(key: "script" | "scriptId"): Record<string, TypeTreeNodeData[]> {
  const out: Record<string, TypeTreeNodeData[]> = {};
  for (const object of Object.values(golden.objects)) out[object[key]] = toData(object.nodes);
  return out;
}

const loadAs = (name: string, options?: LoadOptions): Env =>
  load([{ name, data: loadFixture(name) }], options);

const monoBehaviours = (env: Env) => [...env.assets("MonoBehaviour")];

// --- plan §5 normalization, driven by the golden's own node rows ----------------

interface Node {
  type: string;
  name: string;
  children: Node[];
}

function nest(rows: Row[]): Node {
  const stack: { node: Node; level: number }[] = [];
  let root: Node | undefined;
  for (const [level, type, name] of rows) {
    const node: Node = { type, name, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    if (stack.length === 0) root = node;
    else stack[stack.length - 1]!.node.children.push(node);
    stack.push({ node, level });
  }
  return root!;
}

const INT64 = new Set(["SInt64", "UInt64", "long long", "unsigned long long", "FileSize"]);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function bits(value: number, size: 4 | 8): string {
  const view = new DataView(new ArrayBuffer(size));
  if (size === 4) view.setFloat32(0, value);
  else view.setFloat64(0, value);
  return hex(new Uint8Array(view.buffer));
}

function normalize(node: Node, value: unknown): unknown {
  if (INT64.has(node.type)) return String(value);
  if (node.type === "float") return `f32:${bits(value as number, 4)}`;
  if (node.type === "double") return `f64:${bits(value as number, 8)}`;
  if (value instanceof Uint8Array) return `hex:${hex(value)}`;
  if (typeof value !== "object" || value === null) return value;
  if (node.type === "pair") {
    const [a, b] = value as unknown[];
    return [normalize(node.children[0]!, a), normalize(node.children[1]!, b)];
  }
  if (node.children[0]?.type === "Array") {
    return (value as unknown[]).map((v) => normalize(node.children[0]!.children[1]!, v));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, normalize(node.children.find((c) => c.name === k)!, v)]),
  );
}

// --- reads against the oracle ----------------------------------------------------

for (const key of ["script", "scriptId"] as const) {
  test(`${STRIPPED}: trees supplied by ${key} read as UnityPy reads them`, () => {
    const assets = monoBehaviours(loadAs(STRIPPED, { typeTrees: trees(key) }));
    assert.equal(assets.length, Object.keys(golden.objects).length);
    for (const asset of assets) {
      const expected = golden.objects[String(asset.pathId)];
      assert.ok(expected, `no golden for MonoBehaviour ${asset.pathId}`);
      const root = nest(expected.nodes);
      const value = asset.reader.readTypeTree();
      assert.deepEqual(normalize(root, value), expected.value, `${asset.pathId} readTypeTree()`);
      assert.deepEqual(asset.reader.read(), value, `${asset.pathId} read()`);
      const header = new Set(["m_GameObject", "m_Enabled", "m_Script", "m_Name"]);
      const fields = Object.fromEntries(Object.entries(value).filter(([k]) => !header.has(k)));
      assert.deepEqual(asset.data.fields, fields, `${asset.pathId} asset.data.fields`);
      assert.equal(asset.name, value.m_Name);
    }
  });
}

test(`${STRIPPED}: script id keys are matched in either case`, () => {
  const upper = Object.fromEntries(
    Object.entries(trees("scriptId")).map(([k, v]) => [k.toUpperCase(), v]),
  );
  for (const asset of monoBehaviours(loadAs(STRIPPED, { typeTrees: upper }))) {
    assert.ok(asset.data.fields, `${asset.pathId} has no fields`);
  }
});

// --- lookup order: own tree, then supplied, then header only -----------------------

test(`${TYPED}: a file's own type tree wins over a supplied one`, () => {
  // Every script given the wrong tree: the typed build must not notice.
  const wrong = toData(Object.values(golden.objects).find((o) => o.script === ATLAS)!.nodes);
  const typeTrees = { [SKELETON]: wrong, [ATLAS]: wrong };
  const plain = monoBehaviours(loadAs(TYPED));
  const supplied = monoBehaviours(loadAs(TYPED, { typeTrees }));
  assert.deepEqual(
    supplied.map((a) => a.data),
    plain.map((a) => a.data),
  );
});

test(`${STRIPPED}: without a supplied tree for its script, an object keeps its header only`, () => {
  const only = { [ATLAS]: trees("script")[ATLAS]! };
  for (const asset of monoBehaviours(loadAs(STRIPPED, { typeTrees: only }))) {
    const script = golden.objects[String(asset.pathId)]!.script;
    if (script === ATLAS) {
      assert.ok(asset.data.fields, `${asset.pathId} has no fields`);
      continue;
    }
    assert.equal(asset.data.fields, undefined, `${asset.pathId} (${script})`);
    assert.deepEqual(Object.keys(asset.reader.read()), [
      "m_GameObject",
      "m_Enabled",
      "m_Script",
      "m_Name",
    ]);
    assert.throws(() => asset.reader.readTypeTree(), UnsupportedError);
  }
});

// --- a tree that does not fit -------------------------------------------------------

test(`${STRIPPED}: a supplied tree of another script throws CorruptError naming the script`, () => {
  const atlas = trees("script")[ATLAS]!;
  const env = loadAs(STRIPPED, { typeTrees: { [SKELETON]: atlas } });
  const skeletons = monoBehaviours(env).filter(
    (a) => golden.objects[String(a.pathId)]!.script === SKELETON,
  );
  assert.ok(skeletons.length > 0);
  for (const asset of skeletons) {
    const message = new RegExp(`${SKELETON}.*object ${asset.pathId}`);
    assert.throws(() => asset.data, (e) => e instanceof CorruptError && message.test(e.message));
    assert.throws(() => asset.reader.readTypeTree(), CorruptError);
  }
});

test(`${STRIPPED}: a supplied tree that stops short throws CorruptError naming the script`, () => {
  // The root and the header fields only (the first 4 children and their subtrees).
  const full = trees("script")[SKELETON]!;
  const children = full.flatMap((node, i) => (node.level === 1 ? [i] : []));
  const short = full.slice(0, children[4]);
  const env = loadAs(STRIPPED, { typeTrees: { [SKELETON]: short } });
  const asset = monoBehaviours(env).find(
    (a) => golden.objects[String(a.pathId)]!.script === SKELETON,
  )!;
  assert.throws(
    () => asset.reader.readTypeTree(),
    (e) =>
      e instanceof CorruptError &&
      e.message.includes(SKELETON) &&
      /read \d+ bytes but expected \d+ bytes/.test(e.message),
  );
});

// --- [SerializeReference] data ------------------------------------------------------

/** A `ManagedReferencesRegistry` version 1 tree under a root, as Unity 2019.4 writes it. */
const REGISTRY: TypeTreeNodeData[] = (
  [
    [0, "MonoBehaviour", "Base", -1, 0x8000],
    [1, "ManagedReferencesRegistry", "references", -1, 0x8001],
    [2, "int", "version", 4, 1],
    [2, "ReferencedObject", "00000000", -1, 0x8001],
    [3, "ReferencedManagedType", "type", -1, 0x208001],
    ...["class", "ns", "asm"].flatMap((name): Row[] => [
      [4, "string", name, -1, 0x208001],
      [5, "Array", "Array", -1, 0x204001],
      [6, "int", "size", 4, 0x200001],
      [6, "char", "data", 1, 0x200001],
    ]),
    [3, "ReferencedObjectData", "data", -1, 0x8001],
  ] as Row[]
).map(([level, type, name, byteSize, metaFlag]) => ({ level, type, name, byteSize, metaFlag }));

/** Little-endian bytes of a version 1 registry holding one entry of class `cls`. */
function registryBytes(cls: string, ns: string, asm: string): Uint8Array {
  const out: number[] = [1, 0, 0, 0];
  for (const text of [cls, ns, asm]) {
    const bytes = new TextEncoder().encode(text);
    out.push(bytes.length & 0xff, bytes.length >> 8, 0, 0, ...bytes);
    while (out.length % 4) out.push(0);
  }
  return new Uint8Array(out);
}

/** A stripped object over `bytes`, read with {@link REGISTRY} supplied for script `"A:B"`. */
function withRegistry(bytes: Uint8Array) {
  const reader = synthetic(objectBytes(STRIPPED, ClassID.MonoBehaviour), bytes, [2019, 4, 41, 0]);
  const nodes = readTypeTreesOption({ "A:B": REGISTRY }).get("A:B")!;
  setTypeTreeSupplier(reader, () => ({ nodes, script: "A:B" }));
  return reader;
}

test("a supplied tree reaching [SerializeReference] data throws UnsupportedError", () => {
  const reader = withRegistry(registryBytes("Item", "Game", "Assembly-CSharp"));
  assert.throws(
    () => readTypeTree(reader),
    (e) =>
      e instanceof UnsupportedError &&
      e.kind === "[SerializeReference] data without a type tree" &&
      e.found === "A:B",
  );
});

test("a supplied tree reads a [SerializeReference] registry with no entries", () => {
  const reader = withRegistry(registryBytes("Terminus", "UnityEngine.DMAT", "FAKE_ASM"));
  assert.deepEqual(readTypeTree(reader), { references: { version: 1 } });
});

// --- the option -------------------------------------------------------------------

test("load() rejects a typeTrees option it cannot use", () => {
  const data = loadFixture(STRIPPED);
  const node = { type: "MonoBehaviour", name: "Base", level: 0, byteSize: -1, metaFlag: 0 };
  const bad = (typeTrees: unknown, kind: typeof TypeError | typeof RangeError) =>
    assert.throws(() => load(data, { typeTrees } as LoadOptions), kind, JSON.stringify(typeTrees));
  bad(null, TypeError);
  bad([], TypeError);
  bad({ "A:B": node }, TypeError);
  bad({ "A:B": [{ ...node, level: "0" }] }, TypeError);
  bad({ "A:B": [{ ...node, metaFlag: undefined }] }, TypeError);
  bad({ "A:B": [{ ...node, name: 1 }] }, TypeError);
  bad({ "A:B": [{ ...node, typeFlags: 0.5 }] }, TypeError);
  bad({ "A:B": [] }, RangeError);
  bad({ NoAssembly: [node] }, RangeError);
  bad({ ["ab".repeat(16)]: [node], ["AB".repeat(16)]: [node] }, RangeError);
  bad({ "A:B": [{ ...node, level: 1 }] }, RangeError);
  bad({ "A:B": [node, { ...node, level: 2 }] }, RangeError);
  bad({ "A:B": [node, { ...node, level: 0 }] }, RangeError);
  // A TypeTreeNode[] of the file's own is accepted as it is.
  const own = loadAs(TYPED).objects.find((o) => o.type === ClassID.MonoBehaviour)!;
  assert.doesNotThrow(() => load(data, { typeTrees: { "A:B": own.serializedType!.nodes! } }));
});
