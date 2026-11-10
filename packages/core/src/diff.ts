import type { Asset } from "./asset.js";
import { readAudioClip } from "./classes/AudioClip.js";
import { readCubemap } from "./classes/Cubemap.js";
import { readMesh } from "./classes/Mesh.js";
import { readTexture2D } from "./classes/Texture2D.js";
import { readTexture2DArray, readTexture3D } from "./classes/Texture2DArray.js";
import { readVideoClip } from "./classes/VideoClip.js";
import { containerOf, type Env, type ResourceRef } from "./env.js";
import { CorruptError } from "./errors.js";
import { ClassID } from "./serialized/ClassID.js";
import type { ObjectReader } from "./serialized/ObjectReader.js";
import { readTypeTree, typeTreeOf } from "./serialized/TypeTreeReader.js";

/** One asset that differs between two builds, as {@link diff} lists it. */
export interface DiffEntry {
  /** Only in the new build, only in the old one, or in both with other content. */
  change: "added" | "removed" | "modified";
  /** Class name (`Asset.typeName`): `"Texture2D"`, or `"class <id>"` for a class not named here. */
  type: string;
  /** Container path (`Asset.path`), or `undefined` when no container entry lists the asset. */
  path: string | undefined;
  /** `Asset.name`. */
  name: string;
  /** SerializedFile holding it (`Asset.file`): `"CAB-<hash>"` or a loose file's name. */
  file: string;
  /** Object id within {@link file} (D9). */
  pathId: bigint;
  /**
   * The asset in the old build; `undefined` when added. {@link type},
   * {@link path}, {@link name}, {@link file} and {@link pathId} are the new
   * build's, except for a removed asset.
   */
  before: Asset | undefined;
  /** The asset in the new build; `undefined` when removed. */
  after: Asset | undefined;
  /**
   * Bytes the asset takes in the new build less those it took in the old one:
   * the object's data plus its streamed data (`m_StreamData`, `m_Resource`,
   * `m_ExternalResources`) in a resource file. Negative for a removed asset.
   */
  sizeDelta: number;
  /**
   * For a modified asset whose two sides both have a type tree: the names of
   * the top-level fields whose values differ, in type tree order, a field one
   * side lacks included. A streamed-data field (`m_StreamData`, ...) is listed
   * when its bytes in the resource file differ, not when only its offset or
   * file name does. Empty when the object bytes differ but no top-level value
   * does (padding, NaN payload bits). `undefined` otherwise.
   */
  fields?: string[];
}

/** Classes whose streamed data a file without type trees has its hardcoded reader find. */
// ponytail: without type trees, the streamed data of CubemapArray is neither
// compared nor counted in sizeDelta (a same-size repaint at the same offset
// reads as unchanged). Add its class here when a CubemapArray reader lands.
const STREAM_READERS = new Map<number, [(reader: ObjectReader) => object, string]>([
  [ClassID.Texture2D, [readTexture2D, "m_StreamData"]],
  [ClassID.Cubemap, [readCubemap, "m_StreamData"]],
  [ClassID.Texture2DArray, [readTexture2DArray, "m_StreamData"]],
  [ClassID.Texture3D, [readTexture3D, "m_StreamData"]],
  [ClassID.Mesh, [readMesh, "m_StreamData"]],
  [ClassID.AudioClip, [readAudioClip, "m_Resource"]],
  [ClassID.VideoClip, [readVideoClip, "m_ExternalResources"]],
]);

/** An object's fields read for comparison, and which of them point into a resource file. */
interface Parsed {
  values: Record<string, unknown>;
  streams: string[];
  /** Read from its type tree, so its field names can be reported. */
  typeTree: boolean;
}

/**
 * Compare two loaded builds and list the assets added, removed or modified
 * between them. Assets that are the same in both are left out.
 *
 * Matching, for each asset of `oldEnv` in turn:
 *
 * 1. By container path, class and name, for assets a loaded `AssetBundle`
 *    lists in its `m_Container`. This survives a renamed bundle.
 * 2. The rest by class, path id and the bundle they are in: the
 *    `m_AssetBundleName` of the `AssetBundle` object in the same
 *    SerializedFile, so a bundle whose CAB name changed between builds still
 *    matches, or the file name where there is none (a loose file, the
 *    manifest bundle). Path ids are stable across builds: Unity derives them
 *    from the source asset.
 *
 * Several candidates for one key pair up in load order.
 *
 * Content: two matched assets are the same when their object bytes are
 * equal and so are the bytes of their streamed data in a resource file
 * (`.resS`, `.resource`), read with `Env.readResource`. Different object
 * bytes make an asset modified, except for an object with a streamed-data
 * field (`StreamingInfo`, `StreamedResource`): its fields are compared
 * instead, the streamed data by its bytes, so a texture whose data only moved
 * within its `.resS`, or whose CAB name changed, is not modified. Fields come
 * from the type tree, or without one from the hardcoded reader of
 * `Texture2D`, `Cubemap`, `Texture2DArray`, `Texture3D`, `Mesh`, `AudioClip`
 * and `VideoClip`. In a file without type trees the streamed data of
 * `CubemapArray` is neither compared nor counted in `sizeDelta`.
 *
 * Entries are the removed and modified assets in `oldEnv`'s object order, then
 * the added ones in `newEnv`'s. Both envs stay usable; nothing is copied.
 *
 * @example
 * for (const e of diff(load(oldFiles), load(newFiles))) {
 *   console.log(e.change, e.type, e.path ?? `${e.file}/${e.pathId}`, e.sizeDelta, e.fields);
 * }
 *
 * @param oldEnv the earlier build, made by `load()`
 * @param newEnv the later build, made by `load()`
 * @returns the differences, see {@link DiffEntry}
 * @throws {ResourceNotFoundError} when an object's streamed data is in a
 *   resource file that was not loaded
 * @throws {UnsupportedError} / {CorruptError} as `Env.objects`,
 *   `Env.readResource`, `readTypeTree` and the class readers named above throw
 *   for an object they compare
 */
export function diff(oldEnv: Env, newEnv: Env): DiffEntry[] {
  const olds = [...oldEnv.assets()];
  const news = [...newEnv.assets()];
  const pairs = new Map<Asset, Asset>();
  const matched = new Set<Asset>();
  const pair = (keyOf: (asset: Asset) => string | undefined): void => {
    const candidates = new Map<string, Asset[]>();
    for (const asset of news) {
      const key = matched.has(asset) ? undefined : keyOf(asset);
      if (key === undefined) continue;
      const list = candidates.get(key);
      if (list) list.push(asset);
      else candidates.set(key, [asset]);
    }
    for (const asset of olds) {
      const key = pairs.has(asset) ? undefined : keyOf(asset);
      const found = key === undefined ? undefined : candidates.get(key)?.shift();
      if (!found) continue;
      pairs.set(asset, found);
      matched.add(found);
    }
  };
  pair((a) => (a.path === undefined ? undefined : `${a.path}\0${a.classId}\0${a.name}`));
  const oldBundles = bundleNames(oldEnv, olds);
  const newBundles = bundleNames(newEnv, news);
  pair((a) => {
    const files = a.env === oldEnv ? oldBundles : newBundles;
    const bundle = files.get(fileId(a.env, a));
    return `${bundle === undefined ? `f${a.file}` : `b${bundle}`}\0${a.classId}\0${a.pathId}`;
  });

  const out: DiffEntry[] = [];
  for (const before of olds) {
    const after = pairs.get(before);
    if (!after) {
      const size = sizeOf(before, streamedOnly(before));
      out.push(entry("removed", before, undefined, -size, undefined));
      continue;
    }
    const change = compare(before, after);
    if (change) out.push(entry("modified", before, after, change.sizeDelta, change.fields));
  }
  for (const after of news) {
    if (matched.has(after)) continue;
    out.push(entry("added", undefined, after, sizeOf(after, streamedOnly(after)), undefined));
  }
  return out;
}

function entry(
  change: DiffEntry["change"],
  before: Asset | undefined,
  after: Asset | undefined,
  sizeDelta: number,
  fields: string[] | undefined,
): DiffEntry {
  const a = (after ?? before)!;
  const out: DiffEntry = {
    change,
    type: a.typeName,
    path: a.path,
    name: a.name,
    file: a.file,
    pathId: a.pathId,
    before,
    after,
    sizeDelta,
  };
  if (fields) out.fields = fields;
  return out;
}

/** A SerializedFile of an env: its container and its name. */
function fileId(env: Env, asset: Asset): string {
  return `${containerOf(env, asset.reader)}\0${asset.file}`;
}

/** Each SerializedFile holding a named `AssetBundle` object, to that name. */
function bundleNames(env: Env, assets: readonly Asset[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const asset of assets) {
    if (asset.type !== "AssetBundle") continue;
    const name = asset.data.assetBundleName;
    if (name) out.set(fileId(env, asset), name);
  }
  return out;
}

/** What differs between two matched assets, or `undefined` when nothing does. */
function compare(
  before: Asset,
  after: Asset,
): { sizeDelta: number; fields?: string[] } | undefined {
  const a = before.reader;
  const b = after.reader;
  const sameBytes = bytesEqual(objectBytes(a), objectBytes(b));
  const pa = sameBytes ? streamedOnly(before) : parse(before);
  const pb = sameBytes ? streamedOnly(after) : parse(after);
  const sizeDelta = sizeOf(after, pb) - sizeOf(before, pa);
  // Equal bytes and no streamed data to read on one side: nothing else to compare.
  if (sameBytes && (pa === undefined || pb === undefined)) return undefined;
  if (pa === undefined || pb === undefined) {
    // Bytes differ and at least one side has no fields to compare.
    return { sizeDelta };
  }
  const names = [...Object.keys(pa.values)];
  for (const key of Object.keys(pb.values)) if (!(key in pa.values)) names.push(key);
  const fields = names.filter((key) => {
    const streamA = pa.streams.includes(key);
    const streamB = pb.streams.includes(key);
    if (streamA || streamB) {
      if (!streamA || !streamB) return true;
      return !bytesEqual(streamed(before, pa.values[key]), streamed(after, pb.values[key]));
    }
    return !(key in pa.values && key in pb.values && same(pa.values[key], pb.values[key]));
  });
  // Only streamed data can make different bytes the same asset: its offset and
  // resource file name change with the build, not with the asset.
  const streams = pa.streams.length > 0 || pb.streams.length > 0;
  if (fields.length === 0 && (sameBytes || streams)) return undefined;
  return pa.typeTree && pb.typeTree ? { sizeDelta, fields } : { sizeDelta };
}

/** {@link parse}, for an object that has streamed data; `undefined` for one that cannot. */
function streamedOnly(asset: Asset): Parsed | undefined {
  const nodes = typeTreeOf(asset.reader)?.nodes;
  const streams = nodes
    ? nodes.some((n) => n.level === 1 && isStreamType(n.type))
    : STREAM_READERS.has(asset.classId);
  return streams ? parse(asset) : undefined;
}

/**
 * The object's top-level fields, from its type tree or, for a class in
 * {@link STREAM_READERS}, its hardcoded reader; `undefined` without either.
 */
function parse(asset: Asset): Parsed | undefined {
  const reader = asset.reader;
  const nodes = typeTreeOf(reader)?.nodes;
  if (nodes) {
    const streams = nodes.filter((n) => n.level === 1 && isStreamType(n.type)).map((n) => n.name);
    return { values: readTypeTree(reader), streams, typeTree: true };
  }
  const known = STREAM_READERS.get(asset.classId);
  if (!known) return undefined;
  const [read, field] = known;
  const values = read(reader) as Record<string, unknown>;
  return { values, streams: field in values ? [field] : [], typeTree: false };
}

function isStreamType(type: string): boolean {
  return type === "StreamingInfo" || type === "StreamedResource";
}

/** The object's data plus its streamed data, in bytes. */
function sizeOf(asset: Asset, parsed: Parsed | undefined): number {
  let size = asset.byteSize;
  for (const key of parsed?.streams ?? []) size += toRef(parsed!.values[key])?.size ?? 0;
  return size;
}

/** The bytes a streamed-data field names, or an empty array when the data is inline. */
function streamed(asset: Asset, value: unknown): Uint8Array {
  const ref = toRef(value);
  return ref ? asset.env.readResource(ref, asset.reader) : new Uint8Array(0);
}

/**
 * A `StreamingInfo` (`offset`, `size`, `path`) or `StreamedResource`
 * (`m_Source`, `m_Offset`, `m_Size`) as a {@link ResourceRef}; `undefined`
 * when it names no file or no bytes.
 */
function toRef(value: unknown): ResourceRef | undefined {
  const v = value as Record<string, unknown>;
  const path = v.path ?? v.m_Source;
  const size = toNumber(v.size ?? v.m_Size);
  if (typeof path !== "string" || path === "" || size === 0) return undefined;
  return { path, offset: toNumber(v.offset ?? v.m_Offset), size };
}

function toNumber(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new CorruptError(
      `streamed data offset or size ${String(value)} is not a byte count below 2^53`,
    );
  }
  return n;
}

/** The object's data, a view into its file (R7). */
function objectBytes(reader: ObjectReader): Uint8Array {
  const saved = reader.position;
  reader.position = 0;
  const bytes = reader.readBytes(reader.length);
  reader.position = saved;
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deep equality of two read values; NaN equals NaN, 0 does not equal -0. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) {
      return false;
    }
    const x = a as unknown as ArrayLike<unknown>;
    const y = b as unknown as ArrayLike<unknown>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((key, i) => key === kb[i] && same(ra[key], rb[key]));
}
