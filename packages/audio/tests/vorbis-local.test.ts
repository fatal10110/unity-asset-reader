// Local only: the Ogg of a real FMOD Vorbis clip, decoded by ffmpeg and checked
// against AssetStudio's WAV. Nothing here is in the repository or in CI: the
// setup header table is bytes of FMOD's library (#241, no table ships), and the
// WAVs and ffmpeg come from the developer's machine. Each test skips when its
// environment variables are absent:
//
//   UAR_VORBIS_TABLE    Fmod5Sharp's Fmod5Sharp/Util/vorbis_headers_converted.json at 28951c6
//   UAR_FFMPEG          an ffmpeg executable (fixtures/BUILDING.md section 11's imageio-ffmpeg)
//   UAR_VORBIS_WAV_DIR  AssetStudio's ConvertToWav() output for tone-vorbis, one file per
//                       section 11 bundle, named after its fixture with "/" as "_"
//                       ("editor_6000.3.25f1_lz4_audio.wav"), from the #233 harness

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { load, type AudioClipFields } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { fsb5ToOgg, readFsb5, type VorbisSetupHeader } from "../src/index.js";

const TABLE = process.env.UAR_VORBIS_TABLE;
const FFMPEG = process.env.UAR_FFMPEG;
const WAV_DIR = process.env.UAR_VORBIS_WAV_DIR;

/** sha256 of the table file the tests were written against (161 entries). */
const TABLE_SHA256 = "89d72238f9f1746aee6a82de6db48b5c7f6ed8174cb1d63570bae9ffe245d095";

/**
 * Largest difference allowed between a sample ffmpeg decodes and AssetStudio's
 * (FMOD's), in 16-bit LSB. Two Vorbis decoders differ by rounding; the measured
 * maximum over the nine clips is in the PR.
 */
const TOLERANCE = 2;

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

/** Fmod5Sharp's JSON (CRC in decimal -> base64 header, seekBit) as fsb5ToOgg takes it. */
function loadTable(path: string): Map<number, VorbisSetupHeader> {
  const text = readFileSync(path);
  assert.equal(sha256(text), TABLE_SHA256, `${path} is not the pinned table`);
  const json = JSON.parse(text.toString("utf8")) as Record<
    string,
    { headerBytes: string; seekBit: number }
  >;
  return new Map(
    Object.entries(json).map(([crc, { headerBytes, seekBit }]) => [
      Number(crc),
      { headerBytes: new Uint8Array(Buffer.from(headerBytes, "base64")), seekBit },
    ]),
  );
}

/** Each section 11 bundle's tone-vorbis: its audioData and AssetStudio's WAV golden. */
function toneVorbisClips() {
  const clips: { fixture: string; audioData: Uint8Array; wav: { size: number; sha256: string } }[] =
    [];
  for (const [fixture, files] of Object.entries(exportGoldens)) {
    if (!fixture.endsWith("/audio")) continue;
    const env = load(loadFixture(fixture));
    for (const [file, entries] of Object.entries(files)) {
      for (const [pathId, entry] of Object.entries(entries)) {
        if (entry.class !== "AudioClip" || entry.input.name !== "tone-vorbis") continue;
        const asset = [...env.assets("AudioClip")].find(
          (a) => a.file === file && String(a.pathId) === pathId,
        );
        assert.ok(asset, `${fixture}: no AudioClip ${file} ${pathId}`);
        const { audioData } = asset.data as AudioClipFields;
        assert.equal(sha256(audioData), entry.input.dataSha256, `${fixture}: input`);
        clips.push({ fixture, audioData, wav: entry.wav! });
      }
    }
  }
  // 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1, each lz4, lz4-notypetree and stripped.
  assert.equal(clips.length, 9);
  return clips;
}

/** ffmpeg's decode of an Ogg stream to interleaved 16-bit PCM, any CRC or stream error fatal. */
function decode(ogg: Uint8Array, what: string): Int16Array {
  const args = ["-v", "error", "-err_detect", "crccheck", "-xerror", "-f", "ogg", "-i", "pipe:0"];
  const run = spawnSync(FFMPEG!, [...args, "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], {
    input: ogg,
    maxBuffer: 1 << 26,
  });
  assert.equal(run.status, 0, `${what}: ffmpeg exited ${run.status}: ${run.stderr}`);
  assert.equal(run.stderr.toString(), "", `${what}: ffmpeg reported errors`);
  const out = run.stdout;
  return new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
}

test(
  "with the pinned table, tone-vorbis of every bundle is an Ogg ffmpeg decodes to sampleCount frames",
  { skip: !TABLE || !FFMPEG ? "UAR_VORBIS_TABLE and UAR_FFMPEG not set" : false },
  () => {
    const table = loadTable(TABLE!);
    for (const { fixture, audioData } of toneVorbisClips()) {
      const { channels, sampleCount } = readFsb5(audioData).samples[0]!;
      const pcm = decode(fsb5ToOgg(audioData, table), fixture);
      assert.equal(pcm.length, sampleCount * channels, fixture);
    }
  },
);

test(
  `the decoded PCM is within ${TOLERANCE} LSB of AssetStudio's ConvertToWav() WAV`,
  {
    skip:
      !TABLE || !FFMPEG || !WAV_DIR
        ? "UAR_VORBIS_TABLE, UAR_FFMPEG and UAR_VORBIS_WAV_DIR not set"
        : false,
  },
  (t) => {
    const table = loadTable(TABLE!);
    let worst = 0;
    for (const { fixture, audioData, wav } of toneVorbisClips()) {
      const file = readFileSync(join(WAV_DIR!, `${fixture.replaceAll("/", "_")}.wav`));
      assert.equal(file.length, wav.size, `${fixture}: WAV size`);
      assert.equal(sha256(file), wav.sha256, `${fixture}: not AssetStudio's WAV`);
      const expected = new Int16Array(file.buffer.slice(file.byteOffset + 44, file.byteOffset + file.length));
      const pcm = decode(fsb5ToOgg(audioData, table), fixture);
      assert.equal(pcm.length, expected.length, fixture);
      let max = 0;
      pcm.forEach((v, i) => (max = Math.max(max, Math.abs(v - expected[i]!))));
      worst = Math.max(worst, max);
      assert.ok(max <= TOLERANCE, `${fixture}: max difference ${max} LSB`);
    }
    t.diagnostic(`largest difference: ${worst} LSB`);
  },
);
