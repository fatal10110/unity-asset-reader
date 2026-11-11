// The humanoid oracle's inputs (#318) are the fixture clips' own values:
// at every key time the golden's muscles and root equal the keys clipCurves()
// reads from the same committed bundle. The golden itself comes from the Unity
// editor (scripts/make-humanoid-goldens.py, R12), not from this package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipCurves } from "../src/index.js";
import { fixtureEnv } from "./helpers.js";

interface Clip {
  bundle: string;
  driven: number[];
  samples: {
    time: number;
    key: boolean;
    muscles: number[];
    bodyPosition: number[];
    bodyRotation: number[];
  }[];
}

/** The first rig's golden (#318) and the second rigs' (#325). */
const goldens = ["humanoid-unity-goldens.json", "humanoid2-unity-goldens.json"].map(
  (file) =>
    JSON.parse(readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8")) as {
      muscleNames: string[];
      editors: Record<string, { clips: Record<string, Clip> }>;
    },
);

/** A clip binds `Left Thumb 1 Stretched` as `LeftHand.Thumb.1 Stretched` (BUILDING.md section 28). */
const binding = (muscle: string) =>
  muscle.replace(/^(Left|Right) (Thumb|Index|Middle|Ring|Little) /, "$1Hand.$2.");

test("the oracle's inputs at the keys are the keys of the committed clips", () => {
  let checked = 0;
  for (const golden of goldens) for (const [editor, { clips }] of Object.entries(golden.editors)) {
    for (const [name, clip] of Object.entries(clips)) {
      const env = fixtureEnv(clip.bundle);
      const asset = [...env.assets("AnimationClip")].find((a) => a.name === name);
      assert.ok(asset, `${editor}: no clip ${name} in ${clip.bundle}`);
      const curves = new Map(clipCurves(env, asset.reader).float.map((c) => [c.attribute, c]));
      // The oracle rebuilds each curve from its keys with flat tangents, so its midpoint
      // inputs are the committed clip's only while every key's slopes are 0.
      for (const [attribute, curve] of curves) {
        for (const k of curve.keyframes) {
          assert.ok(k.inSlope === 0 && k.outSlope === 0, `${editor} ${name} ${attribute}: slopes at ${k.time}`);
        }
      }
      const root = ["RootT.x", "RootT.y", "RootT.z", "RootQ.x", "RootQ.y", "RootQ.z", "RootQ.w"];
      const muscles = clip.driven.map((i) => binding(golden.muscleNames[i]!));
      assert.deepEqual(
        [...curves.keys()].filter((a) => !root.includes(a)).sort(),
        [...muscles].sort(),
        `${editor} ${name}: the clip's muscle curves`,
      );
      for (const s of clip.samples.filter((x) => x.key)) {
        const at = `${editor} ${name} t=${s.time}`;
        // A curve without a key at this time (the muscle clip's two-key curves at
        // 0.5) is not compared; an absent curve is the oracle's default.
        const value = (attribute: string, absent: number) => {
          const curve = curves.get(attribute);
          if (!curve) return absent;
          return curve.keyframes.find((k) => k.time === s.time)?.value;
        };
        const check = (attribute: string, want: number, absent: number, within = 0) => {
          const got = value(attribute, absent);
          if (got === undefined) return;
          assert.ok(Math.abs(got - want) <= within, `${at} ${attribute}: ${got} vs ${want}`);
          checked++;
        };
        for (const i of clip.driven) check(binding(golden.muscleNames[i]!), s.muscles[i]!, 0);
        for (const [j, v] of s.bodyPosition.entries()) check(root[j]!, v, 0);
        // The oracle normalizes RootQ; at a key it is unit already, up to rounding.
        for (const [j, v] of s.bodyRotation.entries()) check(root[3 + j]!, v, j === 3 ? 1 : 0, 1e-6);
      }
    }
  }
  // pose and pose2: 102 curves at 3 keys. muscle: the keys of its three muscle curves (3, 2,
  // 2) and of RootT.y (2), and its absent RootT.x, RootT.z and RootQ at the 3 key times.
  // upperchest: three muscle curves at 3 keys, and its absent RootT and RootQ at the 3 key times.
  assert.equal(checked, 4 * (102 * 3 + (3 + 2 + 2) + 2 + 6 * 3) + 4 * (102 * 3 + 3 * 3 + 7 * 3));
});
