// Objects laid out from Unity's own player type trees (`fixtures/tpk-trees.json`,
// UnityPy's TPK data, R12), for the animation class readers' tests (#303, #302):
// a TPK tree at a version, a reader over bytes laid out for it with every
// array filled, a subtree of it, and a fixture's objects as bytes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadFixture, type GoldenNode } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";
import type { TypeTreeNode } from "../src/serialized/TypeTree.js";
import { readerOf, Writer, type Template } from "./media.js";

/** `fixtures/tpk-trees.json`: Unity's player trees from UnityPy's TPK data, from 2019.1 on. */
export const TPK = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/tpk-trees.json", import.meta.url), "utf8"),
  ) as { classes: Record<string, Record<string, GoldenNode[]>> }
).classes;

/** A TPK tree as the nodes a SerializedFile's type would hold. */
export const typeTreeNodes = (nodes: GoldenNode[]): TypeTreeNode[] =>
  nodes.map(([level, type, name, byteSize, metaFlag], index) => ({
    level,
    type,
    name,
    byteSize,
    metaFlag,
    index,
    typeFlags: 0,
    version: 1,
    typeStrOffset: 0,
    nameStrOffset: 0,
    refTypeHash: 0n,
  }));

/** `2020.3.43f1` as a version, raised to 2019.1 (the floor) for an older tree's key. */
export function versionOf(key: string): { unity: UnityVersion; text: string } {
  const [, a, b, c, type, n] = /^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)$/.exec(key)!;
  if (+a! < 2019) return { unity: [2019, 1, 0, 1], text: "2019.1.0f1" };
  return { unity: [+a!, +b!, +c!, +n!], text: `${a}.${b}.${c}${type}${n}` };
}

/** The tree `nodes` holds for `version`: the last one starting at or before it. */
export function treeAt(classId: number, version: UnityVersion): GoldenNode[] {
  let found: GoldenNode[] | undefined;
  for (const [key, nodes] of Object.entries(TPK[String(classId)]!)) {
    const { unity } = versionOf(key);
    const cmp = unity.slice(0, 3).findIndex((part, i) => part !== version[i]);
    if (cmp === -1 || unity[cmp]! < version[cmp]!) found = nodes;
  }
  return found!;
}

/** A reader over `bytes` as a `classId` object of `version`, its type tree `nodes`. */
export function tpkReader(
  from: Template,
  bytes: Uint8Array,
  nodes: GoldenNode[],
  version: { unity: UnityVersion; text: string },
): ObjectReader {
  const serializedType = { ...from.info.serializedType!, nodes: typeTreeNodes(nodes) };
  const typed: Template = { ...from, info: { ...from.info, serializedType } };
  return readerOf(typed, bytes, version);
}


/**
 * Little-endian bytes for a TPK tree, every value distinct and every array of
 * two elements, laid out as `readTypeTree()` reads them. An `EntityId` vector
 * gets `entityIds` elements of the node's size (0 by default: its node has no
 * children, so its bytes say nothing a tree can read).
 */
export function filled(nodes: GoldenNode[], entityIds = 0): Uint8Array {
  const w = new Writer();
  let n = 0;
  const end = (i: number): number => {
    let j = i + 1;
    while (j < nodes.length && nodes[j]![0] > nodes[i]![0]) j++;
    return j;
  };
  const value = (i: number): void => {
    const [, type, , , flag] = nodes[i]!;
    n++;
    switch (type) {
      case "bool":
        w.bool(n % 3 !== 0);
        break;
      case "UInt8":
        w.u8(n);
        break;
      case "UInt16":
        w.u16(n * 97);
        break;
      case "int":
        w.i32(n % 2 ? -n : n);
        break;
      case "unsigned int":
      case "Type*":
        w.u32(n * 7919);
        break;
      case "float":
        w.f32(n / 8);
        break;
      case "SInt64":
        w.u64(BigInt(n) << 33n);
        break;
      case "string":
        w.str(`s${n}`);
        break;
      default: {
        const child = i + 1;
        if (child < end(i) && nodes[child]![1] === "Array") {
          const element = end(child + 1);
          const entityId = nodes[element]![1] === "EntityId";
          const count = entityId ? entityIds : 2;
          w.i32(count);
          for (let k = 0; k < count; k++) {
            if (entityId) w.raw(...new Array<number>(nodes[element]![3]).fill(k + 1));
            else value(element);
          }
          if ((nodes[child]![4] & 0x4000) !== 0) w.align();
        } else {
          for (let c = child; c < end(i); c = end(c)) value(c);
        }
      }
    }
    if ((flag & 0x4000) !== 0) w.align();
  };
  value(0);
  return w.data;
}


/** The subtree of the first node of `type` in a tree, as a tree of its own. */
export function subtree(nodes: GoldenNode[], type: string): GoldenNode[] {
  const at = nodes.findIndex((node) => node[1] === type);
  assert.ok(at >= 0, `no ${type}`);
  const level = nodes[at]![0];
  let end = at + 1;
  while (end < nodes.length && nodes[end]![0] > level) end++;
  return nodes.slice(at, end).map(([l, ...rest]) => [l - level, ...rest] as GoldenNode);
}

/** The fixture's one SerializedFile, and each object's bytes. */
export function serializedOf(name: string): { sf: SerializedFile; bytes: (pathId: bigint) => Uint8Array } {
  const env = load([{ name, data: loadFixture(name) }]);
  const node = env.files.find((f) => !f.path.includes("."));
  assert.ok(node, `${name}: no SerializedFile`);
  const sf = readSerializedFile(node.data);
  return {
    sf,
    bytes: (pathId) => {
      const info = sf.objects.find((o) => o.pathId === pathId)!;
      return node.data.slice(info.byteStart, info.byteStart + info.byteSize);
    },
  };
}
