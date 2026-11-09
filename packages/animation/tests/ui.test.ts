// Names from a UI hierarchy (#315): FindTOS's Animator branch without an
// Avatar, BuildTOS and FindChild through RectTransforms, on the ui-animation
// fixtures (fixtures/BUILDING.md section 26), a Canvas "ui" whose Animator
// plays "ui", with curves on its children's paths; no Avatar anywhere. The
// curves are checked against AssetStudio's .anim, float32 bit for bit, here
// for this set and in goldens.test.ts with every other clip.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnimationClip, GameObject } from "unity-asset-reader";
import { crc32 } from "../src/crc.js";
import { clipCurves } from "../src/index.js";
import { CLASS, findRoots, findTOS, Scene } from "../src/tos.js";
import {
  asAssetStudioWithoutHierarchy,
  asGolden,
  exportGoldens,
  fixtureEnv,
  objectOf,
} from "./helpers.js";

const FIXTURES = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"].flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map((kind) => `editor/${editor}/ui-animation/${kind}/ui-animation`),
);

for (const fixture of FIXTURES) {
  test(`${fixture}: the Animator's RectTransform hierarchy names the clip's paths`, () => {
    const env = fixtureEnv(fixture);
    assert.equal(env.objects.filter((o) => o.type === CLASS.Avatar).length, 0);
    assert.equal(env.objects.filter((o) => o.type === CLASS.Transform).length, 0);
    assert.equal(env.objects.filter((o) => o.type === CLASS.RectTransform).length, 4);
    const clip = [...env.assets("AnimationClip")].find((a) => a.name === "ui")!;
    const scene = new Scene(env);

    const tos = findTOS(scene, clip.reader, clip.reader.read<AnimationClip>());
    assert.deepEqual([...tos.values()].sort(), ["", "Panel", "Panel/Button", "Panel/Label"]);
    for (const [hash, path] of tos) assert.equal(hash, crc32(path));
    assert.deepEqual(
      findRoots(scene, clip.reader).map((go) => scene.read<GameObject>(go).m_Name),
      ["ui"],
    );
    const curves = clipCurves(env, clip.reader);
    assert.deepEqual(
      curves.float.map((c) => `${c.path} ${c.attribute}`),
      [
        "Panel m_AnchoredPosition.x",
        "Panel m_AnchoredPosition.y",
        "Panel/Button m_SizeDelta.x",
        "Panel/Button m_AnchorMin.y",
        "Panel/Button m_Pivot.x",
        "Panel/Label m_IsActive",
      ],
    );
    assert.deepEqual(curves.scale.map((c) => c.path), ["Panel/Label"]);
  });
}

test("the ui clips convert to AssetStudio's .anim curves, float32 bit for bit", () => {
  // 2019.4, 2020.3 and 6000.3, typed and not: c37af7d cannot load 6000.6's
  // (BUILDING.md section 17); cross-editor.test.ts holds those to the others.
  // c37af7d misreads 6000.3's Animator (m_AnimatePhysics, 2023.1+, read as
  // m_HasTransformHierarchy), so it names no path there: those goldens carry
  // the verdict and are compared with the names hashed back (section 26).
  const goldens = Object.entries(exportGoldens)
    .filter(([fixture]) => fixture.includes("/ui-animation/"))
    .flatMap(([fixture, files]) =>
      Object.entries(files).flatMap(([file, entries]) =>
        Object.entries(entries)
          .filter(([, e]) => e.class === "AnimationClip" && e.anim)
          .map(([pathId, e]) => ({ fixture, file, pathId, entry: e })),
      ),
    );
  assert.equal(goldens.length, 6);
  for (const { fixture, file, pathId, entry } of goldens) {
    const misread = fixture.includes("/6000.3.");
    if (misread) assert.match(entry.verdict ?? "", /^c37af7d's Animator reader lacks/, fixture);
    else assert.equal(entry.verdict, undefined, fixture);
    const env = fixtureEnv(fixture);
    const curves = clipCurves(env, objectOf(env, file, pathId));
    const got = asGolden(misread ? asAssetStudioWithoutHierarchy(curves) : curves);
    assert.deepEqual(got.curves, entry.anim!.curves, fixture);
    assert.deepEqual(got.events, entry.anim!.events, fixture);
    // AssetStudio named every path too, where it read the Animator right.
    const paths = Object.values(entry.anim!.curves).flatMap((list) => list.map((c) => c.path));
    assert.ok(paths.every((p) => p.startsWith("path_") === misread), fixture);
  }
});
