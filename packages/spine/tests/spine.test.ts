// spineSkeletons (#238) on the spine fixtures of fixtures/BUILDING.md section
// 19: the grouping against the table written there before the build, the
// TextAsset bytes and page pixels against AssetStudio's export goldens (#233,
// R12). AssetStudio has no Spine export, so there is no oracle for the
// grouping itself.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  load,
  ResourceNotFoundError,
  UnsupportedError,
  type Asset,
  type Env,
} from "unity-asset-reader";
import { convertPlain } from "unity-asset-reader-texture";
import { loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { spineSkeletons, type SpineSkeleton } from "../src/index.js";

const EDITOR = "editor/2019.4.41f2";
const EXPORT_GOLDENS = "../../../fixtures/assetstudio-export-goldens.json";

/** Fixtures under `bundles/`, loaded together. */
function env(...fixtures: string[]): Env {
  return load(
    fixtures.map((fixture) => ({ name: fixture.split("/").pop()!, data: loadFixture(fixture) })),
  );
}

/** The bundles a table bundle needs loaded with it (section 19: the split build). */
const DEPENDENCIES: Record<string, string[]> = { "spine/lz4/split": ["spine/lz4/splitatlas"] };

/** A section 19 bundle with the bundles it depends on. */
function withDependencies(bundle: string): Env {
  return env(...[bundle, ...(DEPENDENCIES[bundle] ?? [])].map((name) => `${EDITOR}/${name}`));
}

/** The one asset of a type and name a fixture holds. */
function only(fixture: Env, type: string, name: string): Asset {
  const found = [...fixture.assets()].filter((a) => a.type === type && a.name === name);
  assert.equal(found.length, 1, `${type} ${name}`);
  return found[0]!;
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

/** A TextAsset's bytes against AssetStudio's export of it. */
function checkText(fixture: string, text: Asset<"TextAsset">): void {
  const golden = exported(fixture, text).bytes;
  assert.ok(golden, `${text.name}: no exported file`);
  const bytes = text.data.bytes;
  assert.deepEqual({ size: bytes.length, sha256: sha256(bytes) }, golden, text.name);
}

/** A page's RGBA against AssetStudio's exported PNG of it. */
function checkPage(fixture: string, page: Asset<"Texture2D">): void {
  const golden = exported(fixture, page).png;
  assert.ok(golden, `${page.name}: no exported PNG`);
  const { width, height, format, imageData } = page.data;
  // convertPlain keeps Unity's row order, bottom row first; the PNG is top row first.
  const rgba = reverseRows(convertPlain(imageData, width, height, format).data, width);
  assert.deepEqual(
    { width, height, rgbaSha256: sha256(rgba) },
    { width: golden.width, height: golden.height, rgbaSha256: golden.rgbaSha256 },
    page.name,
  );
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
  assert.deepEqual(bundles, ["spine/lz4/skeletons", "spine/lz4/split"]);
  for (const bundle of bundles) {
    const skeletons = spineSkeletons(withDependencies(bundle));
    // Skeletons by name, as the table lists them; each skeleton's atlases in order.
    const actual = rows(bundle, skeletons).sort((a, b) => a.skeleton.localeCompare(b.skeleton));
    assert.deepEqual(
      actual,
      table.filter((row) => row.bundle === bundle),
    );
  }
  // imp's atlasAssets is [imp_Atlas, null, imp-fx_Atlas]: the null entry is skipped.
  assert.deepEqual(
    spineSkeletons(env(`${EDITOR}/spine/lz4/skeletons`))
      .map((s) => [s.name, s.atlases.length])
      .sort(),
    [
      ["hero_SkeletonData", 1],
      ["imp_SkeletonData", 2],
    ],
  );
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
      checkText(bundle, text);
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
      checkPage(bundle, page);
      checked++;
    }
  }
  assert.equal(checked, 4, "hero, hero2, imp, imp-fx");
});

test("a split skeleton loaded without its atlas bundle names that bundle's SerializedFile", () => {
  // wisp_SkeletonData is in `split`, its atlas asset wisp_Atlas in `splitatlas`.
  const atlasFile = only(env(`${EDITOR}/spine/lz4/splitatlas`), "MonoBehaviour", "wisp_Atlas").file;
  const split = env(`${EDITOR}/spine/lz4/split`);
  assert.notEqual(only(split, "MonoBehaviour", "wisp_SkeletonData").file, atlasFile);
  assert.throws(
    () => spineSkeletons(split),
    (error: unknown) =>
      error instanceof ResourceNotFoundError &&
      error.fileName === atlasFile &&
      error.path === atlasFile &&
      error.message.includes(`atlasAssets[0] (path id `) &&
      error.message.includes(`is in ${atlasFile}, which is not loaded`) &&
      /wisp_SkeletonData/.test(error.message),
  );
});

test("a split skeleton's TextAssets and page match AssetStudio's export of the bundle holding each", () => {
  const [wisp, ...others] = spineSkeletons(withDependencies("spine/lz4/split"));
  assert.equal(others.length, 0);
  // The skeleton JSON stays with the skeleton in `split`; the atlas asset took
  // its atlas text, Material and page to `splitatlas`.
  checkText("spine/lz4/split", wisp!.skeleton);
  assert.equal(wisp!.atlases.length, 1);
  const { atlas, pages } = wisp!.atlases[0]!;
  checkText("spine/lz4/splitatlas", atlas);
  assert.equal(pages.length, 1);
  checkPage("spine/lz4/splitatlas", pages[0]!);
});

test("an atlas asset of another type than SpineAtlasAsset is refused, naming it", () => {
  // shade_Atlas is UarOtherAtlasAsset: neither atlasFile nor materials.
  const fixture = env(`${EDITOR}/spine/lz4/otheratlas`);
  const atlas = only(fixture, "MonoBehaviour", "shade_Atlas");
  assert.throws(
    () => spineSkeletons(fixture),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "Spine atlas asset" &&
      error.found === `shade_Atlas (path id ${atlas.pathId})` &&
      /not a SpineAtlasAsset/.test(error.message),
  );
});

test("an atlas asset without type tree, from a skeleton with one, is refused, naming it", () => {
  // `split` with type trees, `splitatlas` built without: both name the
  // SerializedFile after the bundle, so the skeleton's pointer finds wisp_Atlas.
  const fixture = env(`${EDITOR}/spine/lz4/split`, `${EDITOR}/spine/lz4-notypetree/splitatlas`);
  const atlas = only(fixture, "MonoBehaviour", "wisp_Atlas");
  assert.throws(
    () => spineSkeletons(fixture),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "MonoBehaviour without type tree" &&
      error.found === `wisp_Atlas (path id ${atlas.pathId})` &&
      /atlas asset in a file built without type trees/.test(error.message),
  );
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
