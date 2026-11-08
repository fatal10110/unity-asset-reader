// clipCurves() against AssetStudio c37af7d's ExportAnimationClip (#304): the curve
// lists and events the harness dumps from each clip after Convert(), float32 bit
// for bit (scripts/make-export-goldens.py, fixtures/BUILDING.md section 17, R12).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "../src/crc.js";
import { clipCurves, type ClipCurves } from "../src/index.js";
import { asGolden, exportGoldens, fixtureEnv, objectOf, type GoldenAnim } from "./helpers.js";

const clips = Object.entries(exportGoldens).flatMap(([fixture, files]) =>
  Object.entries(files).flatMap(([file, entries]) =>
    Object.entries(entries)
      .filter(([, e]) => e.class === "AnimationClip" && e.anim)
      .map(([pathId, e]) => ({
        fixture,
        file,
        pathId,
        name: e.input.name,
        anim: e.anim!,
        verdict: e.verdict,
      })),
  ),
);
/**
 * The verdict next to a golden (fixtures/BUILDING.md section 17): AssetStudio could
 * not read the SkinnedMeshRenderer, so it left each blend shape attribute as its
 * CRC-32 where clipCurves() names it. Returns the curves with the names hashed back.
 */
function asAssetStudioWithoutRenderer(curves: ClipCurves): ClipCurves {
  const float = curves.float.map((c) => {
    const name = /^blendShape\.(.*)$/.exec(c.attribute)?.[1];
    assert.ok(name === undefined || !/^\d+$/.test(name), `${c.attribute} is named`);
    return name === undefined ? c : { ...c, attribute: `blendShape.${crc32(name)}` };
  });
  return { ...curves, float };
}

const has = (kind: keyof GoldenAnim["curves"], pick = (_: GoldenAnim) => true) =>
  clips.some((c) => c.anim.curves[kind].length > 0 && pick(c.anim));

test("every AnimationClip AssetStudio exports converts to the curves and events of its .anim", () => {
  // Every clip of 2019.4, 2020.3 and 6000.3, typed and not; two of 6000.6 (BUILDING.md, 17).
  // And the three typed `pose` clips of the humanoid oracle's bundles (BUILDING.md, 27).
  assert.equal(clips.length, 119);
  for (const c of clips) {
    const env = fixtureEnv(c.fixture);
    const curves = clipCurves(env, objectOf(env, c.file, c.pathId));
    const got = asGolden(c.verdict ? asAssetStudioWithoutRenderer(curves) : curves);
    const where = `${c.fixture} ${c.name}`;
    if (c.verdict)
      assert.ok(
        curves.float.some((x) => x.attribute.startsWith("blendShape.")),
        where,
      );
    assert.deepEqual(got.curves, c.anim.curves, where);
    assert.deepEqual(got.events, c.anim.events, where);
    // Written to the .anim as they are: clipCurves() leaves them out.
    assert.equal(c.anim.compressedRotationCurves, 0, where);
  }
});

test("the goldens cover streamed, dense, constant and legacy data, named paths and muscles", () => {
  const names = new Set(clips.map((c) => c.name));
  for (const name of [
    "mecanim",
    "dense",
    "dense60",
    "constant",
    "mixed",
    "legacy",
    "move",
    "muscle",
    "smile",
  ]) {
    assert.ok(names.has(name), name);
  }
  for (const kind of ["rotation", "euler", "position", "scale", "float", "pptr"] as const) {
    assert.ok(has(kind), `a golden with ${kind} curves`);
  }
  // Child paths named through an Avatar's m_TOS or an Animator's hierarchy.
  assert.ok(has("rotation", (a) => a.curves.rotation.some((x) => x.path.includes("/"))));
  // Humanoid muscles, on path "" of the Animator.
  assert.ok(
    has("float", (a) => a.curves.float.some((x) => x.attribute === "RootT.y" && x.classId === 95)),
  );
  // Blend shapes named from the SkinnedMeshRenderer's mesh.
  assert.ok(
    has("float", (a) => a.curves.float.some((x) => /^blendShape\.[a-z]/.test(x.attribute!))),
  );
  // An infinite in slope (a stepped segment) somewhere.
  const words = (keys: unknown) => (typeof keys === "string" ? (keys.match(/.{8}/g) ?? []) : []);
  assert.ok(
    clips.some((c) =>
      Object.values(c.anim.curves).some((l) => l.some((x) => words(x.keys).includes("7f800000"))),
    ),
  );
});
