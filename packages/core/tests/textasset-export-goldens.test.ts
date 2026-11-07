// Every fixture TextAsset against AssetStudio's ExportTextAsset (#276): the
// reader's data.bytes against the exported file's size and SHA-256 in the
// export goldens (fixtures/BUILDING.md section 17, R12), no-type-tree and
// stripped builds included.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { load, type Asset } from "../src/index.js";

const EXPORT_GOLDENS = "../../../fixtures/assetstudio-export-goldens.json";

/** The number of TextAssets the export goldens hold; a new one must raise it. */
const TEXT_ASSETS = 32;

interface TextAssetEntry {
  class: string;
  input: { name: string; scriptSize: number; scriptSha256: string };
  bytes?: { size: number; sha256: string };
  exportError?: string;
}
const exportGoldens: {
  fixtures: Record<string, Record<string, Record<string, TextAssetEntry>>>;
} = JSON.parse(readFileSync(new URL(EXPORT_GOLDENS, import.meta.url), "utf8"));

/** A golden TextAsset entry with where it lives. */
interface Golden {
  bundle: string;
  file: string;
  pathId: string;
  entry: TextAssetEntry;
}

/** Every TextAsset entry of the export goldens, grouped by its fixture bundle. */
function goldenTextAssets(): Map<string, Golden[]> {
  const byBundle = new Map<string, Golden[]>();
  for (const [bundle, files] of Object.entries(exportGoldens.fixtures)) {
    for (const [file, objects] of Object.entries(files)) {
      for (const [pathId, entry] of Object.entries(objects)) {
        if (entry.class !== "TextAsset") continue;
        const list = byBundle.get(bundle) ?? [];
        list.push({ bundle, file, pathId, entry });
        byBundle.set(bundle, list);
      }
    }
  }
  return byBundle;
}

const goldens = goldenTextAssets();

test("the export goldens hold every fixture TextAsset", () => {
  const count = [...goldens.values()].reduce((sum, list) => sum + list.length, 0);
  assert.equal(count, TEXT_ASSETS);
});

test("each golden was exported from the m_Script it lists", () => {
  for (const list of goldens.values()) {
    for (const { bundle, file, pathId, entry } of list) {
      const where = `${bundle} ${file} ${pathId}`;
      assert.equal(entry.exportError, undefined, where);
      assert.ok(entry.bytes, `${where}: no exported file`);
      assert.deepEqual(
        { size: entry.input.scriptSize, sha256: entry.input.scriptSha256 },
        entry.bytes,
        where,
      );
    }
  }
});

for (const [bundle, list] of goldens) {
  test(`${bundle}: TextAsset bytes equal AssetStudio's ExportTextAsset`, () => {
    const env = load([{ name: bundle.split("/").pop()!, data: loadFixture(bundle) }]);
    const texts = new Map<string, Asset<"TextAsset">>();
    for (const asset of env.assets()) {
      if (asset.type === "TextAsset") {
        texts.set(`${asset.file}/${asset.pathId}`, asset as Asset<"TextAsset">);
      }
    }
    assert.equal(texts.size, list.length, `${bundle}: TextAssets loaded vs golden`);
    for (const { file, pathId, entry } of list) {
      const text = texts.get(`${file}/${pathId}`);
      assert.ok(text, `${bundle}: no TextAsset ${file} ${pathId}`);
      assert.equal(text.name, entry.input.name, `${bundle} ${pathId}`);
      const bytes = text.data.bytes;
      assert.deepEqual(
        { size: bytes.length, sha256: sha256(bytes) },
        entry.bytes,
        `${bundle} ${text.name}`,
      );
    }
  });
}
