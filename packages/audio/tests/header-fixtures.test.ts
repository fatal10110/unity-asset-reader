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

/** What a clip's bank says, and the raw header bits that show which path it takes. */
interface Expected {
  codec: Fsb5Codec;
  frequency: number;
  channels: number;
  frames: number;
  /** The sample header's frequency id and channel bits, and whether chunks follow. */
  frequencyId: number;
  channelBits: number;
  chunks: boolean;
}

/**
 * Convert the clip `name` of every `audiohdr` bundle (fixtures/BUILDING.md
 * section 11, "Header paths") and compare it with AssetStudio's ConvertToWav()
 * golden, FMOD's own decode. Returns how many clips were checked.
 */
function checkAgainstGoldens(name: string, want: Expected): number {
  let checked = 0;
  for (const [fixture, files] of Object.entries(exportGoldens)) {
    if (!fixture.endsWith("/audiohdr")) continue;
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

        // The first sample header (after a version 1 header of 0x3C bytes) takes
        // the path this clip is here for.
        const view = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
        assert.equal(view.getUint32(4, true), 1, `${where}: FSB5 version`);
        const word = view.getUint32(0x3c, true);
        assert.equal((word >>> 1) & 0xf, want.frequencyId, `${where}: frequency id`);
        assert.equal((word >>> 5) & 3, want.channelBits, `${where}: channel bits`);
        assert.equal((word & 1) === 1, want.chunks, `${where}: chunks`);

        const fsb = readFsb5(audioData);
        assert.equal(fsb.codec, want.codec, where);
        assert.equal(fsb.samples.length, 1, where);
        const sample = fsb.samples[0]!;
        assert.equal(sample.frequency, want.frequency, where);
        assert.equal(sample.channels, want.channels, where);
        assert.equal(sample.sampleCount, want.frames, where);

        const wav = fsb5ToWav(audioData);
        assert.equal(wav.length, 44 + want.frames * want.channels * 2, where);
        assert.ok(entry.wav, `${where}: no WAV golden`);
        assert.equal(wav.length, entry.wav.size, where);
        assert.equal(sha256(wav), entry.wav.sha256, where);
        checked++;
      }
    }
  }
  return checked;
}

// Acceptance (#289): every clip of the audiohdr bundles of 2019.4.41f2,
// 2020.3.30f1 and 6000.3.26f1 (lz4) converts to AssetStudio's WAV byte for byte.

test("a 37800 Hz clip's FREQUENCY chunk gives its rate, and it converts byte for byte", () => {
  // 37800 Hz is not in FMOD's frequency-id table: Unity writes id 0 and a
  // FREQUENCY chunk holding the rate.
  const want = { codec: Fsb5Codec.PCM16, frequency: 37800, channels: 1, frames: 4000 };
  const raw = { frequencyId: 0, channelBits: 0, chunks: true };
  assert.equal(checkAgainstGoldens("mono37800-pcm", { ...want, ...raw }), 3);
});

test("a 4-channel clip's CHANNELS chunk gives its channel count, PCM16 and IMAADPCM", () => {
  // 4 is not one of the channel bits' 1, 2, 6 or 8: Unity writes 0 (mono) and a
  // CHANNELS chunk.
  const raw = { frequency: 22050, channels: 4, frequencyId: 5, channelBits: 0, chunks: true };
  const pcm = { codec: Fsb5Codec.PCM16, frames: 4000 };
  assert.equal(checkAgainstGoldens("quad-pcm", { ...raw, ...pcm }), 3);
  // IMA ADPCM pads to whole 64-sample frames: 4032.
  const adpcm = { codec: Fsb5Codec.IMAADPCM, frames: 4032 };
  assert.equal(checkAgainstGoldens("quad-adpcm", { ...raw, ...adpcm }), 3);
});

test("a 5.1 clip's channel bits give 6 channels, PCM16 and IMAADPCM", () => {
  const raw = { frequency: 22050, channels: 6, frequencyId: 5, channelBits: 2, chunks: false };
  const pcm = { codec: Fsb5Codec.PCM16, frames: 4000 };
  assert.equal(checkAgainstGoldens("surround-pcm", { ...raw, ...pcm }), 3);
  const adpcm = { codec: Fsb5Codec.IMAADPCM, frames: 4032 };
  assert.equal(checkAgainstGoldens("surround-adpcm", { ...raw, ...adpcm }), 3);
});
