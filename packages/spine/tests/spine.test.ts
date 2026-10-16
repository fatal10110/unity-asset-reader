// spineSkeletons (#238) on the spine fixtures of fixtures/BUILDING.md section
// 19: the grouping against the table written there before the build, the
// TextAsset bytes and page pixels against AssetStudio's export goldens (#233,
// R12). AssetStudio has no Spine export, so there is no oracle for the
// grouping itself.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load, UnsupportedError, type Asset, type Env } from "unity-asset-reader";
import { convertPlain } from "unity-asset-reader-texture";
import { loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { spineSkeletons, type SpineSkeleton } from "../src/index.js";

const EDITOR = "editor/2019.4.41f2";
const EXPORT_GOLDENS = "../../../fixtures/assetstudio-export-goldens.json";

/** A fixture under `bundles/`, loaded alone. */
function env(fixture: string): Env {
  return load([{ name: fixture.split("/").pop()!, data: loadFixture(fixture) }]);
}

interface ExportEntry {
  class: string;
  png?: { width: number; height: number; rgbaSha256: string };
  bytes?: { size: number; sha256: string };
  exportError?: string;
}
const exportGoldens: {
  fixtures: Record<string, Record<string, Record<string, ExportEntry>>>;
} = JSON.parse(readFileSync(new URL(EXPORT_GOLDENS, import.meta.url), "utf8"));

/** AssetStudio's export of an asset of a fixture (section 17). */
function exported(fixture: string, asset: Asset): ExportEntry {
  const entry = exportGoldens.fixtures[`${EDITOR}/${fixture}`]?.[asset.file]?.[`${asset.pathId}`];
  assert.ok(entry, `no export golden for ${fixture} ${asset.file} ${asset.pathId}`);
  return entry;
}

interface Row {
  bundle: string;
  skeleton: string;
  data: string;
  atlas: string;
  pages: string[];
}

/** The grouping table of fixtures/BUILDING.md section 19, one row per atlas. */
function buildingTable(): Row[] {
  const doc = readFileSync(new URL("../../../fixtures/BUILDING.md", import.meta.url), "utf8");
  const section = doc.split(/^## 19\. /m)[1]?.split(/^## /m)[0];
  assert.ok(section, "fixtures/BUILDING.md has no section 19");
  const lines = section.split("\n").filter((line) => line.startsWith("| `"));
  assert.ok(lines.length > 0, "section 19 has no grouping table");
  return lines.map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const names = (cell: string) => cell.split(", ").map((name) => name.replace(/`/g, ""));
    const [bundle, skeleton, data, atlas, pages] = cells.map(names);
    return {
      bundle: bundle![0]!,
      skeleton: skeleton![0]!,
      data: data![0]!,
      atlas: atlas![0]!,
      pages: pages!,
    };
  });
}

/** `spineSkeletons` as rows of that table. */
function rows(bundle: string, skeletons: SpineSkeleton[]): Row[] {
  return skeletons.flatMap((s) =>
    s.atlases.map(({ atlas, pages }) => ({
      bundle,
      skeleton: s.name,
      data: s.skeleton.name,
      atlas: atlas.name,
      pages: pages.map((page) => page.name),
    })),
  );
}

const table = buildingTable();
const bundles = [...new Set(table.map((row) => row.bundle))];

test("every fixture skeleton is grouped as fixtures/BUILDING.md wrote it before the build", () => {
  assert.deepEqual(bundles, ["spine/lz4/skeletons"]);
  for (const bundle of bundles) {
    const skeletons = spineSkeletons(env(`${EDITOR}/${bundle}`));
    // Skeletons by name, as the table lists them; each skeleton's atlases in order.
    const actual = rows(bundle, skeletons).sort((a, b) => a.skeleton.localeCompare(b.skeleton));
    assert.deepEqual(
      actual,
      table.filter((row) => row.bundle === bundle),
    );
    // imp's atlasAssets is [imp_Atlas, null, imp-fx_Atlas]: the null entry is skipped.
    assert.deepEqual(
      skeletons.map((s) => [s.name, s.atlases.length]).sort(),
      [
        ["hero_SkeletonData", 1],
        ["imp_SkeletonData", 2],
      ],
    );
  }
});

test("the assets are the env's own, typed by class", () => {
  const fixture = env(`${EDITOR}/spine/lz4/skeletons`);
  const all = new Set<Asset>(fixture.assets());
  for (const skeleton of spineSkeletons(fixture)) {
    assert.equal(skeleton.skeleton.type, "TextAsset");
    assert.ok(all.has(skeleton.skeleton));
    for (const { atlas, pages } of skeleton.atlases) {
      assert.equal(atlas.type, "TextAsset");
      assert.ok(all.has(atlas));
      for (const page of pages) {
        assert.equal(page.type, "Texture2D");
        assert.ok(all.has(page));
      }
    }
  }
});

test("skeleton and atlas TextAsset bytes match AssetStudio's export", () => {
  const bundle = "spine/lz4/skeletons";
  let checked = 0;
  for (const skeleton of spineSkeletons(env(`${EDITOR}/${bundle}`))) {
    for (const text of [skeleton.skeleton, ...skeleton.atlases.map(({ atlas }) => atlas)]) {
      const golden = exported(bundle, text).bytes;
      assert.ok(golden, `${text.name}: no exported file`);
      const bytes = text.data.bytes;
      assert.deepEqual({ size: bytes.length, sha256: sha256(bytes) }, golden, text.name);
      checked++;
    }
  }
  assert.equal(checked, 5, "hero, hero.atlas, imp, imp.atlas, imp-fx.atlas");
});

test("page RGBA matches AssetStudio's exported PNG", () => {
  const bundle = "spine/lz4/skeletons";
  let checked = 0;
  for (const skeleton of spineSkeletons(env(`${EDITOR}/${bundle}`))) {
    for (const page of skeleton.atlases.flatMap(({ pages }) => pages)) {
      const golden = exported(bundle, page).png;
      assert.ok(golden, `${page.name}: no exported PNG`);
      const { width, height, format, imageData } = page.data;
      // convertPlain keeps Unity's row order, bottom row first; the PNG is top row first.
      const rgba = reverseRows(convertPlain(imageData, width, height, format).data, width);
      assert.deepEqual(
        { width, height, rgbaSha256: sha256(rgba) },
        { width: golden.width, height: golden.height, rgbaSha256: golden.rgbaSha256 },
        page.name,
      );
      checked++;
    }
  }
  assert.equal(checked, 4, "hero, hero2, imp, imp-fx");
});

test("an atlas that loads its textures on demand is refused", () => {
  // ghost_Atlas: textureLoadingMode OnDemand (spine-unity 4.1+), whose materials
  // hold placeholder textures rather than the pages.
  assert.throws(
    () => spineSkeletons(env(`${EDITOR}/spine/lz4/ondemand`)),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "Spine texture loading mode" &&
      error.found === "OnDemand" &&
      /ghost_Atlas/.test(error.message),
  );
});

test("a SkeletonDataAsset in a bundle without type trees is refused", () => {
  assert.throws(
    () => spineSkeletons(env(`${EDITOR}/spine/lz4-notypetree/skeletons`)),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "MonoBehaviour without type tree" &&
      /_SkeletonData/.test(String(error.found)),
  );
});

test("bundles without Spine objects have no skeletons, with type trees or without", () => {
  // `main` holds a ScriptableObject of another script: in lz4-notypetree it has
  // no type tree, and its script is not SkeletonDataAsset.
  for (const variant of ["lz4", "lz4-notypetree"]) {
    const fixture = env(`${EDITOR}/${variant}/main`);
    assert.ok([...fixture.assets("MonoBehaviour")].length > 0, variant);
    assert.deepEqual(spineSkeletons(fixture), [], variant);
  }
});
