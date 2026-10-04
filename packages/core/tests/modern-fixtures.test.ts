// Format-23 fixtures are candidate data for #108, #153, #155 and #160.
// Check their container bytes against the independent UnityPy oracle while
// the SerializedFile reader still refuses the format (#155 prerequisite).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { loadFixture } from "../../../fixtures/helpers.js";
import { readBundle } from "../src/bundle/BundleFile.js";
import { UnsupportedError } from "../src/errors.js";
import { readSerializedFile } from "../src/serialized/SerializedFile.js";

interface CandidateGolden {
  files: Record<string, { size: number; sha256: string }>;
  serialized: Record<string, { formatVersion: number; unityVersion: string }>;
}

test("RGB48 records AssetStudio's verdict and labels the conflicting UnityPy hash", () => {
  const candidates = JSON.parse(readFileSync(
    new URL("../../../fixtures/modern-goldens.json", import.meta.url), "utf8",
  ));
  const fixture = candidates.fixtures["editor/6000.6.4f1/more-plain/textures"];
  const serialized = Object.values(fixture.serialized)[0] as {
    textures: Record<string, {
      name: string; rgbaSha256: string; oracleNote?: string;
      assetStudioCrossCheck?: { verdict: string; rgbaSha256: string; firstPixel: number[] };
    }>;
  };
  const rgb48 = Object.values(serialized.textures).find((texture) => texture.name === "RGB48")!;
  assert.match(rgb48.oracleNote ?? "", /Verdict: AssetStudio/);
  assert.match(rgb48.oracleNote ?? "", /unsuitable for decoder acceptance/);
  assert.equal(rgb48.rgbaSha256,
    "fd817234260f3ee0ecb98fb3a62a963943b7bbc8cd5f525de91db3581a8a9cbd");
  assert.equal(rgb48.assetStudioCrossCheck?.verdict, "AssetStudio");
  assert.equal(rgb48.assetStudioCrossCheck?.rgbaSha256,
    "03d886e69c09698f9a1f94e48f2365c8470cbb730686af697ada98730e31db9d");
  assert.deepEqual(rgb48.assetStudioCrossCheck?.firstPixel, [48, 122, 196, 255]);
});

for (const folder of ["more-plain", "sprite", "variant", "sprite-v2", "sprite-v2-rect"]) {
  const name = `editor/6000.6.4f1/${folder}/${folder === "more-plain" ? "textures" : "sprites"}`;
  test(`${name}: format-23 candidate unpacks to UnityPy's exact bytes`, () => {
    const path = new URL("../../../fixtures/modern-goldens.json", import.meta.url);
    assert.ok(existsSync(path), "candidate oracle goldens must be generated");
    const candidates = JSON.parse(readFileSync(path, "utf8")) as {
      fixtures: Record<string, CandidateGolden>;
    };
    const expected = candidates.fixtures[name]!;
    assert.ok(expected, `no candidate golden for ${name}`);
    const { files } = readBundle(loadFixture(name));
    assert.deepEqual(files.map((file) => file.path).sort(), Object.keys(expected.files).sort());
    for (const file of files) {
      const golden = expected.files[file.path]!;
      assert.equal(file.data.length, golden.size);
      assert.equal(createHash("sha256").update(file.data).digest("hex"), golden.sha256);
      const serialized = expected.serialized[file.path];
      if (serialized) {
        assert.equal(serialized.formatVersion, 23);
        assert.equal(serialized.unityVersion, "6000.6.4f1");
        assert.throws(() => readSerializedFile(file.data), UnsupportedError);
      }
    }
  });
}
