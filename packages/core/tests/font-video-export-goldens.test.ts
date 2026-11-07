// Every fixture Font and VideoClip against AssetStudio's ExportFont and
// ExportVideoClip (#277): the reader's data.fontData (m_FontData, inline) and
// data.videoData (resolved from the bundle's .resource node) against the
// exported file's size and SHA-256 in the export goldens (fixtures/BUILDING.md
// section 17, R12), no-type-tree and stripped builds included.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { load, type Asset } from "../src/index.js";

const EXPORT_GOLDENS = "../../../fixtures/assetstudio-export-goldens.json";

/** The number of Fonts and VideoClips the export goldens hold; a new one must raise it. */
const FONTS = 9;
const VIDEO_CLIPS = 9;

type Exported = { size: number; sha256: string; extension: string };
interface Entry {
  class: string;
  input: { name: string; dataSize?: number; dataSha256?: string };
  font?: Exported;
  video?: Exported;
  exportError?: string;
}
const exportGoldens: {
  fixtures: Record<string, Record<string, Record<string, Entry>>>;
} = JSON.parse(readFileSync(new URL(EXPORT_GOLDENS, import.meta.url), "utf8"));

/** The classes this file checks, with the output field of their golden. */
const OUTPUT = { Font: "font", VideoClip: "video" } as const;
type Cls = keyof typeof OUTPUT;

/** A golden entry with where it lives. */
interface Golden {
  cls: Cls;
  file: string;
  pathId: string;
  entry: Entry;
}

/** Every Font and VideoClip entry of the export goldens, grouped by its fixture bundle. */
function goldenEntries(): Map<string, Golden[]> {
  const byBundle = new Map<string, Golden[]>();
  for (const [bundle, files] of Object.entries(exportGoldens.fixtures)) {
    for (const [file, objects] of Object.entries(files)) {
      for (const [pathId, entry] of Object.entries(objects)) {
        if (entry.class !== "Font" && entry.class !== "VideoClip") continue;
        const list = byBundle.get(bundle) ?? [];
        list.push({ cls: entry.class, file, pathId, entry });
        byBundle.set(bundle, list);
      }
    }
  }
  return byBundle;
}

const goldens = goldenEntries();
const all = [...goldens.values()].flat();

test("the export goldens hold every fixture Font and VideoClip", () => {
  assert.equal(all.filter((g) => g.cls === "Font").length, FONTS);
  assert.equal(all.filter((g) => g.cls === "VideoClip").length, VIDEO_CLIPS);
});

test("each golden is AssetStudio's export of the data it lists, with no exportError", () => {
  for (const { cls, file, pathId, entry } of all) {
    const where = `${file} ${pathId}`;
    assert.equal(entry.exportError, undefined, where);
    const out = entry[OUTPUT[cls]];
    assert.ok(out, `${where}: no exported file`);
    // ExportFont writes m_FontData as is (.otf after "OTTO", else .ttf);
    // ExportVideoClip writes the video bytes with m_OriginalPath's extension.
    assert.deepEqual(
      { size: out.size, sha256: out.sha256 },
      { size: entry.input.dataSize, sha256: entry.input.dataSha256 },
      where,
    );
    assert.equal(out.extension, cls === "Font" ? ".ttf" : ".webm", where);
  }
});

for (const [bundle, list] of goldens) {
  test(`${bundle}: font and video bytes equal AssetStudio's ExportFont and ExportVideoClip`, () => {
    const env = load([{ name: bundle.split("/").pop()!, data: loadFixture(bundle) }]);
    const assets = new Map<string, Asset<"Font"> | Asset<"VideoClip">>();
    for (const asset of env.assets()) {
      if (asset.type === "Font" || asset.type === "VideoClip") {
        assets.set(`${asset.file}/${asset.pathId}`, asset as Asset<"Font"> | Asset<"VideoClip">);
      }
    }
    assert.equal(assets.size, list.length, `${bundle}: Fonts and VideoClips loaded vs golden`);
    for (const { cls, file, pathId, entry } of list) {
      const asset = assets.get(`${file}/${pathId}`);
      assert.ok(asset, `${bundle}: no ${cls} ${file} ${pathId}`);
      assert.equal(asset.type, cls, `${bundle} ${pathId}`);
      assert.equal(asset.name, entry.input.name, `${bundle} ${pathId}`);
      const bytes =
        asset.type === "Font"
          ? (asset as Asset<"Font">).data.fontData
          : (asset as Asset<"VideoClip">).data.videoData;
      const out = entry[OUTPUT[cls]]!;
      assert.deepEqual(
        { size: bytes.length, sha256: sha256(bytes) },
        { size: out.size, sha256: out.sha256 },
        `${bundle} ${asset.name}`,
      );
    }
  });
}
