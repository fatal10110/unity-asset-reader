import { readFileSync } from "node:fs";
import { load, type Env, type ObjectReader, type PPtr } from "unity-asset-reader";
import { loadFixture } from "../../../fixtures/helpers.js";
import type { ClipCurves, CurveKey } from "../src/index.js";

/** A curve as the export goldens record it: its keys' float32 bits as one hex string. */
export interface GoldenCurve {
  path: string;
  attribute?: string;
  classId?: number;
  keys: string | { time: string; value: { fileId: number; pathId: string } }[];
}

/** What AssetStudio's ExportAnimationClip wrote, and the clip it wrote it from. */
export interface GoldenAnim {
  size: number;
  sha256: string;
  compressedRotationCurves: number;
  curves: Record<"rotation" | "euler" | "position" | "scale" | "float" | "pptr", GoldenCurve[]>;
  events: Record<string, unknown>[];
}

export interface ExportEntry {
  class: string;
  input: { name: string };
  anim?: GoldenAnim;
  exportError?: string;
  verdict?: string;
}

/** fixture -> SerializedFile -> pathId -> entry, from AssetStudio c37af7d (#233, R12). */
export const exportGoldens = (
  JSON.parse(
    readFileSync(
      new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url),
      "utf8",
    ),
  ) as { fixtures: Record<string, Record<string, Record<string, ExportEntry>>> }
).fixtures;

const envs = new Map<string, Env>();
/** The fixture's env, loaded once. */
export function fixtureEnv(fixture: string): Env {
  let env = envs.get(fixture);
  if (!env) envs.set(fixture, (env = load(loadFixture(fixture))));
  return env;
}

/** The object `pathId` of the SerializedFile `file`. */
export function objectOf(env: Env, file: string, pathId: string): ObjectReader {
  const obj = env.objects.find((o) => o.fileName === file && o.pathId === BigInt(pathId));
  if (!obj) throw new Error(`no object ${file} ${pathId}`);
  return obj;
}

const view = new DataView(new ArrayBuffer(4));
/** A float32's bits as 8 hex digits, as the harness writes `BitConverter.SingleToInt32Bits`. */
export function bits(f: number): string {
  view.setFloat32(0, f);
  return view.getUint32(0).toString(16).padStart(8, "0");
}

const hexKeys = <T>(keys: CurveKey<T>[], parts: (v: T) => number[]) =>
  keys
    .map((k) =>
      [k.time, ...parts(k.value), ...parts(k.inSlope), ...parts(k.outSlope)].map(bits).join(""),
    )
    .join("");
const ptr = (p: PPtr) => ({ fileId: p.m_FileID, pathId: p.m_PathID.toString() });

/** `clipCurves()`'s result in the export goldens' form. */
export function asGolden(c: ClipCurves): Pick<GoldenAnim, "curves" | "events"> {
  const v3 = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z];
  const vectors = (list: ClipCurves["euler"]) =>
    list.map((curve) => ({ path: curve.path, keys: hexKeys(curve.keyframes, v3) }));
  return {
    curves: {
      rotation: c.rotation.map((curve) => ({
        path: curve.path,
        keys: hexKeys(curve.keyframes, (q) => [q.x, q.y, q.z, q.w]),
      })),
      euler: vectors(c.euler),
      position: vectors(c.position),
      scale: vectors(c.scale),
      float: c.float.map((curve) => ({
        path: curve.path,
        attribute: curve.attribute,
        classId: curve.classId,
        keys: hexKeys(curve.keyframes, (f) => [f]),
      })),
      pptr: c.pptr.map((curve) => ({
        path: curve.path,
        attribute: curve.attribute,
        classId: curve.classId,
        keys: curve.keyframes.map((k) => ({ time: bits(k.time), value: ptr(k.value) })),
      })),
    },
    events: c.events.map((e) => ({
      time: bits(e.time),
      functionName: e.functionName,
      data: e.data,
      objectReferenceParameter: ptr(e.objectReferenceParameter),
      floatParameter: bits(e.floatParameter),
      intParameter: e.intParameter,
      messageOptions: e.messageOptions,
    })),
  };
}
