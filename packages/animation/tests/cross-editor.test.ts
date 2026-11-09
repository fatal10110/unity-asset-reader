// Each fixture clip converts to the same curves under every editor that built it
// (#304): 2019.4, 2020.3, 6000.3 and 6000.6, typed and not. AssetStudio c37af7d
// cannot read 6000.6 (format 23), so this is its only check against the oracle's
// algorithm (fixtures/BUILDING.md sections 22 to 26 build the same clips each time).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env, ObjectReader, PPtr } from "unity-asset-reader";
import { clipCurves } from "../src/index.js";
import { fixtureEnv } from "./helpers.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const SETS = ["animation", "animator", "scene", "legacy-animation", "ui-animation"];

/**
 * The differences the editors' own data has, by clip, editor prefix and leaf:
 * 6000.x fits the `mixed` clip's position curve with coefficients a few ulps
 * from 2019.4's and 2020.3's (-15.625 for -15.624999), so one in slope differs
 * by a float32 rounding step. The values and times agree.
 */
const DOCUMENTED: Record<string, { editors: RegExp; leaves: string[] }> = {
  "animation/mixed": { editors: /^6000\./, leaves: ["position.0.keyframes.1.inSlope.x"] },
};

/** A pointer as the name of the object it reaches, which the editors agree on. */
function named(env: Env, from: ObjectReader, p: PPtr): string {
  const found = env.resolve(p, from);
  if (found.status !== "found") return found.status;
  const asset = [...env.assets()].find((a) => a.reader === found.object);
  return `${found.object.type}:${asset?.name}`;
}

/** Every leaf of a JSON value, by dotted path. */
function leaves(value: unknown, path = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}

test("every fixture clip has the same curves under 2019.4, 2020.3, 6000.3 and 6000.6", () => {
  let compared = 0;
  for (const set of SETS) {
    const byEditor = new Map<string, Map<string, Map<string, unknown>>>();
    for (const editor of EDITORS) {
      for (const variant of ["lz4", "lz4-notypetree"]) {
        const env = fixtureEnv(`editor/${editor}/${set}/${variant}/${set}`);
        const clips = new Map<string, Map<string, unknown>>();
        for (const asset of env.assets("AnimationClip")) {
          const c = clipCurves(env, asset.reader);
          const plain = {
            ...c,
            pptr: c.pptr.map((p) => ({
              ...p,
              keyframes: p.keyframes.map((k) => ({
                time: k.time,
                value: named(env, asset.reader, k.value),
              })),
            })),
            events: c.events.map((e) => ({
              ...e,
              objectReferenceParameter: named(env, asset.reader, e.objectReferenceParameter),
            })),
          };
          clips.set(asset.name, leaves(plain));
        }
        byEditor.set(`${editor}/${variant}`, clips);
      }
    }
    const base = byEditor.get("2019.4.41f2/lz4")!;
    assert.ok(base.size > 0, set);
    for (const [editor, clips] of byEditor) {
      assert.deepEqual([...clips.keys()].sort(), [...base.keys()].sort(), `${set} ${editor}`);
      for (const [name, want] of base) {
        const got = clips.get(name)!;
        const documented = DOCUMENTED[`${set}/${name}`];
        const allowed = documented?.editors.test(editor) ? documented.leaves : [];
        const differing = [...new Set([...want.keys(), ...got.keys()])].filter(
          (k) => !Object.is(want.get(k), got.get(k)),
        );
        assert.deepEqual(differing, allowed, `${set}/${name} under ${editor}`);
        for (const leaf of allowed) {
          // A rounding step of a slope near 0, nothing more.
          assert.ok(Math.abs(Number(want.get(leaf)) - Number(got.get(leaf))) < 1e-6, leaf);
        }
        compared++;
      }
    }
  }
  assert.equal(compared, 20 * EDITORS.length * 2);
});
