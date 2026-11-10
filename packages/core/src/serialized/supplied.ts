// Type trees the caller supplies for the MonoBehaviours of a file built
// without them (#339): checked once by `load()`, then found per object by its
// script, so `asset.data`, `obj.read()` and `obj.readTypeTree()` read the
// script's fields. The trees are made elsewhere (from the game's assemblies);
// reading assemblies here is out of scope (plan §7).

import { readMonoBehaviour } from "../classes/MonoBehaviour.js";
import { readMonoScript } from "../classes/MonoScript.js";
import type { PPtr, PPtrResolution } from "../classes/PPtr.js";
import { CorruptError, UnsupportedError } from "../errors.js";
import { ClassID } from "./ClassID.js";
import type { ObjectReader } from "./ObjectReader.js";
import type { TypeTreeNode } from "./TypeTree.js";
import { setTypeTreeSupplier, type SuppliedTypeTree } from "./TypeTreeReader.js";

/**
 * One node of a type tree supplied through `LoadOptions.typeTrees`: the part
 * of {@link TypeTreeNode} that reading needs, which is plain JSON (no
 * `bigint`), so a `TypeTreeNode[]` is accepted as it is. Nodes are listed in
 * pre-order, a node's children following it one `level` deeper, the root
 * (`level` 0, the `MonoBehaviour` itself) first.
 *
 * From UnityPy's `TypeTreeNode` (a `TypeTreeGenerator` result, for one):
 * `[{"type": d["m_Type"], "name": d["m_Name"], "level": d["m_Level"],
 * "byteSize": d["m_ByteSize"], "metaFlag": d["m_MetaFlag"]} for d in
 * node.to_dict_list()]`.
 */
export interface TypeTreeNodeData {
  /** Type name, e.g. `"int"`, `"string"`, `"PPtr<Object>"` (UnityPy `m_Type`). */
  type: string;
  /** Field name, e.g. `"m_Name"` (UnityPy `m_Name`). */
  name: string;
  /** Depth; the root is 0 (UnityPy `m_Level`). */
  level: number;
  /** Serialized size in bytes, -1 when variable (UnityPy `m_ByteSize`). */
  byteSize: number;
  /** Meta flags; `0x4000` aligns to 4 bytes after the value (UnityPy `m_MetaFlag`). */
  metaFlag: number;
  /** Upstream `m_TypeFlags`; 0 when absent. Not needed to read. */
  typeFlags?: number;
  /** Node version; 0 when absent. Not needed to read. */
  version?: number;
}

/** A script id key: the 16 bytes of `SerializedType.scriptId` as hex. */
const SCRIPT_ID = /^[0-9a-f]{32}$/i;

/**
 * Check `LoadOptions.typeTrees` and copy it into full nodes, by key. Script id
 * keys are lower-cased.
 *
 * @throws {TypeError} when it is not an object of node arrays, or a node
 *   field has the wrong type
 * @throws {RangeError} for a key that is neither `"<assembly>:<class>"` nor a
 *   32-digit hex script id, a key given twice, an empty node list, or levels
 *   that do not form one tree under a level-0 root
 */
export function readTypeTreesOption(option: unknown): Map<string, TypeTreeNode[]> {
  if (option === null || typeof option !== "object" || Array.isArray(option)) {
    throw new TypeError("typeTrees must be an object of type tree node arrays");
  }
  const out = new Map<string, TypeTreeNode[]>();
  for (const [given, list] of Object.entries(option)) {
    const what = `typeTrees[${JSON.stringify(given)}]`;
    const isId = SCRIPT_ID.test(given);
    const key = isId ? given.toLowerCase() : given;
    if (!isId && !given.includes(":")) {
      throw new RangeError(
        `${what}: a key is "<assembly>:<namespace>.<class>" or a 32-digit hex script id`,
      );
    }
    if (out.has(key)) throw new RangeError(`${what}: the same script id is given twice`);
    if (!Array.isArray(list)) throw new TypeError(`${what} must be an array of nodes`);
    if (list.length === 0) throw new RangeError(`${what} is empty`);
    out.set(key, list.map((node: unknown, i) => toNode(node, i, list as unknown[], what)));
  }
  return out;
}

/** One checked node, with the fields reading does not need filled in. */
function toNode(node: unknown, i: number, list: unknown[], what: string): TypeTreeNode {
  const at = `${what}[${i}]`;
  if (node === null || typeof node !== "object") throw new TypeError(`${at} is not a node`);
  const n = node as Record<string, unknown>;
  for (const field of ["type", "name"]) {
    if (typeof n[field] !== "string") throw new TypeError(`${at}.${field} must be a string`);
  }
  for (const field of ["level", "byteSize", "metaFlag", "typeFlags", "version"]) {
    const optional = field === "typeFlags" || field === "version";
    if ((n[field] !== undefined || !optional) && !Number.isInteger(n[field])) {
      throw new TypeError(`${at}.${field} must be an integer`);
    }
  }
  const level = n.level as number;
  const previous = i > 0 ? ((list[i - 1] as { level: number }).level) : -1;
  if (i === 0 ? level !== 0 : level < 1 || level > previous + 1) {
    throw new RangeError(
      `${at}.level is ${level}; the root is level 0 and each node at most one deeper than ` +
        "the one before",
    );
  }
  return {
    type: n.type as string,
    name: n.name as string,
    byteSize: n.byteSize as number,
    index: i,
    typeFlags: (n.typeFlags as number | undefined) ?? 0,
    version: (n.version as number | undefined) ?? 0,
    metaFlag: n.metaFlag as number,
    level,
    typeStrOffset: 0,
    nameStrOffset: 0,
    refTypeHash: 0n,
  };
}

/**
 * Give every MonoBehaviour without a type tree of its own the supplied tree
 * of its script, found when first needed: by the key
 * `"<m_AssemblyName>:<m_Namespace>.<m_ClassName>"` of the MonoScript its
 * `m_Script` points at (`"<m_AssemblyName>:<m_ClassName>"` in the global
 * namespace; UnityPy's `generate_monobehaviour_node` names it the same way),
 * then by its type's script id, for when that MonoScript is not loaded or
 * cannot be read. Neither found: the object keeps its header only.
 *
 * @param resolve the env's `resolve`
 */
export function supplyTypeTrees(
  objects: readonly ObjectReader[],
  trees: Map<string, TypeTreeNode[]>,
  resolve: (pptr: PPtr, from: ObjectReader) => PPtrResolution,
): void {
  for (const reader of objects) {
    if (reader.type !== ClassID.MonoBehaviour) continue;
    const own = reader.serializedType?.nodes;
    if (own && own.length > 0) continue;
    let found: SuppliedTypeTree | null | undefined;
    setTypeTreeSupplier(reader, () => {
      if (found === undefined) found = lookUp(reader, trees, resolve);
      return found;
    });
  }
}

function lookUp(
  reader: ObjectReader,
  trees: Map<string, TypeTreeNode[]>,
  resolve: (pptr: PPtr, from: ObjectReader) => PPtrResolution,
): SuppliedTypeTree | null {
  const name = scriptName(reader, resolve);
  const byName = name === undefined ? undefined : trees.get(name);
  if (byName) return { nodes: byName, script: name! };
  const id = reader.serializedType?.scriptId;
  if (!id) return null;
  const hex = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
  const byId = trees.get(hex);
  return byId ? { nodes: byId, script: name === undefined ? hex : `${name} (${hex})` } : null;
}

/**
 * The key of the script an object's `m_Script` points at, or `undefined`
 * when it points at nothing loaded or readable as a MonoScript (a
 * version-stripped file without `unityVersion`, for one).
 */
function scriptName(
  reader: ObjectReader,
  resolve: (pptr: PPtr, from: ObjectReader) => PPtrResolution,
): string | undefined {
  try {
    const target = resolve(readMonoBehaviour(reader).m_Script, reader);
    if (target.status !== "found" || target.object.type !== ClassID.MonoScript) return undefined;
    const script = readMonoScript(target.object);
    const ns = script.m_Namespace ? `${script.m_Namespace}.` : "";
    return `${script.m_AssemblyName}:${ns}${script.m_ClassName}`;
  } catch (error) {
    if (error instanceof UnsupportedError || error instanceof CorruptError) return undefined;
    throw error;
  }
}
