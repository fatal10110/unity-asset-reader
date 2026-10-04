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
