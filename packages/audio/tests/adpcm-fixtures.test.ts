import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { load, type AudioClipFields } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { Fsb5Codec, fsb5ToWav, readFsb5 } from "../src/index.js";

interface ExportEntry {
  class: string;
  input: { name?: string; dataSha256?: string };
  wav?: { size: number; sha256: string };
}

/** fixture -> SerializedFile -> pathId -> entry, from AssetStudio c37af7d (#233, R12). */
const exportGoldens = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url), {
      encoding: "utf8",
    }),
  ) as { fixtures: Record<string, Record<string, Record<string, ExportEntry>>> }
).fixtures;

/**
 * Convert the clip `name` of every `adpcm` bundle (fixtures/BUILDING.md section 11,
 * "ADPCM clips") and compare it with AssetStudio's ConvertToWav() golden, which is
 * FMOD's own IMA ADPCM decode. Returns how many clips were checked.
 */
function checkAgainstGoldens(name: string, channels: number, frames: number): number {
  let checked = 0;
  for (const [fixture, files] of Object.entries(exportGoldens)) {
    if (!fixture.endsWith("/adpcm")) continue;
    const env = load(loadFixture(fixture));
    for (const [file, entries] of Object.entries(files)) {
      for (const [pathId, entry] of Object.entries(entries)) {
        if (entry.class !== "AudioClip" || entry.input.name !== name) continue;
        const where = `${fixture} ${name}`;
        const asset = [...env.assets("AudioClip")].find(
          (a) => a.file === file && String(a.pathId) === pathId,
        );
        assert.ok(asset, `${where}: no AudioClip ${file} ${pathId}`);
        const { audioData } = asset.data as AudioClipFields;
        // The input is the one the golden was made from, so a match is the same conversion.
        assert.equal(sha256(audioData), entry.input.dataSha256, `${where}: input`);
        const fsb = readFsb5(audioData);
        assert.equal(fsb.codec, Fsb5Codec.IMAADPCM, where);
        assert.equal(fsb.samples[0]!.channels, channels, where);
        assert.equal(fsb.samples[0]!.sampleCount, frames, where);
        const wav = fsb5ToWav(audioData);
        // Exactly the bank header's frame count of 16-bit samples.
        assert.equal(wav.length, 44 + frames * channels * 2, where);
        assert.ok(entry.wav, `${where}: no WAV golden`);
        assert.equal(wav.length, entry.wav.size, where);
        assert.equal(sha256(wav), entry.wav.sha256, where);
        checked++;
      }
    }
  }
  return checked;
}

// Acceptance (#251): the IMAADPCM clips of every adpcm bundle, 2019.4.41f2,
// 2020.3.30f1 and 6000.3.26f1, each lz4, lz4-notypetree and stripped.
test("mono IMAADPCM tone-adpcm converts to AssetStudio's ConvertToWav() WAV, byte for byte", () => {
  // tone.wav of section 11 has 5512 frames; Unity encodes 87 whole IMA ADPCM
  // frames of 64 samples and the bank header says 5568.
  assert.equal(checkAgainstGoldens("tone-adpcm", 1, 5568), 9);
});

test("stereo IMAADPCM stereo-adpcm converts to AssetStudio's ConvertToWav() WAV, byte for byte", () => {
  // A different sine per channel. 4000 frames in the WAV, 63 whole IMA ADPCM
  // frames (4032) in the bank.
  assert.equal(checkAgainstGoldens("stereo-adpcm", 2, 4032), 9);
});
