// Names from a legacy Animation component (#314): FindTOS's and FindRoots'
// Animation branches on the legacy-animation fixtures (fixtures/BUILDING.md
// section 25), whose root lists the Mecanim clip "walk" and nothing lists
// "unlisted"; no Avatar or Animator names their paths. The curves themselves
// are checked against AssetStudio's .anim in goldens.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnimationClip, GameObject } from "unity-asset-reader";
import { crc32 } from "../src/crc.js";
import { clipCurves } from "../src/index.js";
import { CLASS, findRoots, findTOS, Scene } from "../src/tos.js";
import { fixtureEnv } from "./helpers.js";

const FIXTURES = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"].flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map(
    (kind) => `editor/${editor}/legacy-animation/${kind}/legacy-animation`,
  ),
);

for (const fixture of FIXTURES) {
  test(`${fixture}: the Animation's hierarchy names the clip it lists, and only that one`, () => {
    const env = fixtureEnv(fixture);
    assert.equal(env.objects.filter((o) => o.type === CLASS.Avatar).length, 0);
    assert.equal(env.objects.filter((o) => o.type === CLASS.Animator).length, 0);
    const clip = (name: string) => [...env.assets("AnimationClip")].find((a) => a.name === name)!;
    const walk = clip("walk");
    const unlisted = clip("unlisted");
    const scene = new Scene(env);

    const tos = findTOS(scene, walk.reader, walk.reader.read<AnimationClip>());
    assert.deepEqual([...tos.values()].sort(), ["", "Body", "Body/Arm", "Skin"]);
    for (const [hash, path] of tos) assert.equal(hash, crc32(path));
    const roots = findRoots(scene, walk.reader);
    assert.deepEqual(
      roots.map((go) => scene.read<GameObject>(go).m_Name),
      ["legacy"],
    );
    const curves = clipCurves(env, walk.reader);
    assert.deepEqual([...new Set(curves.float.map((c) => `${c.path} ${c.attribute}`))].sort(), [
      "Body/Arm m_IsActive",
      "Skin blendShape.blink",
      "Skin blendShape.smile",
    ]);
    assert.deepEqual(curves.position.map((c) => c.path), ["Body"]);
    assert.deepEqual(curves.rotation.map((c) => c.path), ["Body/Arm"]);

    // The same curves in a clip nothing lists keep their hashes.
    const none = findTOS(scene, unlisted.reader, unlisted.reader.read<AnimationClip>());
    assert.deepEqual([...none], [[0, ""]]);
    assert.deepEqual(findRoots(scene, unlisted.reader), []);
    const hashed = clipCurves(env, unlisted.reader);
    assert.deepEqual(hashed.position.map((c) => c.path), [`path_${crc32("Body")}`]);
    assert.ok(
      hashed.float.every((c) => !c.attribute.startsWith("blendShape.") || /\.\d+$/.test(c.attribute)),
    );
  });
}
