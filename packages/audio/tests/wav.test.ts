import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CorruptError, load, UnsupportedError, type AudioClipFields } from "unity-asset-reader";
import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { Fsb5Codec, fsb5ToWav } from "../src/index.js";
import { bank, concat, int16be, single } from "./bank.js";

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

/** The 16-bit samples of a WAV's data chunk (after the 44-byte header). */
function samples16(wav: Uint8Array): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.length - 44);
  return Array.from({ length: view.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

/** The header fields of a WAV, as AssetStudio writes them. */
function header(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, 44);
  const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
  return {
    riff: text(0, 4),
    riffSize: view.getUint32(4, true),
    wave: text(8, 8),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36, 4),
    dataSize: view.getUint32(40, true),
  };
}

/** Expect an UnsupportedError of `kind` that found `found`. */
function unsupported(kind: string, found: string | number) {
  return (e: unknown) => {
    assert.ok(e instanceof UnsupportedError, String(e));
    assert.equal(e.kind, kind);
    assert.equal(e.found, found);
    return true;
  };
}

// Acceptance (#236): tone-pcm of every section 11 audio bundle, against
// AssetStudio's ConvertToWav() golden. The input is checked against the bytes
// the golden was made from, so a match means the same conversion.
test("tone-pcm converts to AssetStudio's ConvertToWav() WAV, byte for byte", () => {
  let checked = 0;
  for (const [fixture, files] of Object.entries(exportGoldens)) {
    if (!fixture.endsWith("/audio")) continue;
    const env = load(loadFixture(fixture));
    for (const [file, entries] of Object.entries(files)) {
      for (const [pathId, entry] of Object.entries(entries)) {
        if (entry.class !== "AudioClip" || entry.input.name !== "tone-pcm") continue;
        const asset = [...env.assets("AudioClip")].find(
          (a) => a.file === file && String(a.pathId) === pathId,
        );
        assert.ok(asset, `${fixture}: no AudioClip ${file} ${pathId}`);
        const { audioData } = asset.data as AudioClipFields;
        assert.equal(sha256(audioData), entry.input.dataSha256, `${fixture}: input`);
        const wav = fsb5ToWav(audioData);
        assert.equal(wav.length, entry.wav!.size, fixture);
        assert.equal(sha256(wav), entry.wav!.sha256, fixture);
        checked++;
      }
    }
  }
  // 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1, each lz4, lz4-notypetree and stripped.
  assert.equal(checked, 9);
});

test("tone-vorbis is refused: Vorbis is not converted to WAV", () => {
  const env = load(loadFixture("editor/6000.3.25f1/lz4/audio"));
  const vorbis = [...env.assets("AudioClip")].find((a) => a.name === "tone-vorbis");
  const { audioData } = vorbis!.data as AudioClipFields;
  assert.throws(() => fsb5ToWav(audioData), unsupported("FSB5 codec", "VORBIS"));
});

test("PCM16 stereo: AssetStudio's 44-byte header, then the frames without padding", () => {
  const data = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
  const wav = fsb5ToWav(
    single(Fsb5Codec.PCM16, { frequencyId: 8, channelBits: 1, sampleCount: 4, data }),
  );
  // 4 frames x 2 channels x 2 bytes = 16 bytes; the other 4 are padding.
  assert.deepEqual(
    [...wav.subarray(0, 44)],
    [
      ...[0x52, 0x49, 0x46, 0x46], // "RIFF"
      ...[52, 0, 0, 0], // 16 + 36
      ...[0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], // "WAVEfmt "
      ...[16, 0, 0, 0],
      ...[1, 0], // PCM
      ...[2, 0], // channels
      ...[0x44, 0xac, 0, 0], // 44100
      ...[0x10, 0xb1, 0x02, 0], // 44100 * 4 = 176400
      ...[4, 0], // block align
      ...[16, 0], // bits
      ...[0x64, 0x61, 0x74, 0x61], // "data"
      ...[16, 0, 0, 0],
    ],
  );
  assert.deepEqual([...wav.subarray(44)], [...data.subarray(0, 16)]);
});

test("PCM8 and PCM32 are copied at 8 and 32 bits", () => {
  const data = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
  const pcm8 = fsb5ToWav(single(Fsb5Codec.PCM8, { sampleCount: 3, data }));
  assert.deepEqual(header(pcm8), {
    riff: "RIFF", riffSize: 39, wave: "WAVEfmt ", fmtSize: 16, format: 1, channels: 1,
    rate: 22050, byteRate: 22050, blockAlign: 1, bits: 8, data: "data", dataSize: 3,
  });
  assert.deepEqual([...pcm8.subarray(44)], [0x80, 0x81, 0x82]);

  const pcm32 = fsb5ToWav(
    single(Fsb5Codec.PCM32, { channelBits: 1, sampleCount: 2, data }),
  );
  assert.deepEqual(header(pcm32), {
    riff: "RIFF", riffSize: 52, wave: "WAVEfmt ", fmtSize: 16, format: 1, channels: 2,
    rate: 22050, byteRate: 176400, blockAlign: 8, bits: 32, data: "data", dataSize: 16,
  });
  assert.deepEqual([...pcm32.subarray(44)], [...data.subarray(0, 16)]);
});

test("PCM data shorter than its frames is corrupt", () => {
  const bytes = single(Fsb5Codec.PCM16, { sampleCount: 17, data: new Uint8Array(32) });
  assert.throws(() => fsb5ToWav(bytes), /PCM sample of 17 frames needs 34 bytes of data but has 32/);
});

test("other codecs are refused with their name", () => {
  for (const [name, codec] of Object.entries(Fsb5Codec)) {
    if (["PCM8", "PCM16", "PCM32", "GCADPCM", "IMAADPCM", "FADPCM"].includes(name)) continue;
    const bytes = bank({ codec, samples: [{ sampleCount: 1, data: new Uint8Array(4) }] });
    assert.throws(() => fsb5ToWav(bytes), unsupported("FSB5 codec", name));
  }
  const unknown = single(42, { sampleCount: 1, data: new Uint8Array(4) });
  assert.throws(() => fsb5ToWav(unknown), unsupported("FSB5 codec", 42));
});

test("a bank without samples, or with 0 channels, is corrupt", () => {
  assert.throws(() => fsb5ToWav(bank({ codec: Fsb5Codec.PCM16, samples: [] })), /has no sample/);
  const silent = bank({
    codec: Fsb5Codec.PCM16,
    samples: [{ sampleCount: 1, chunks: [{ type: 1, body: Uint8Array.of(0) }], data: new Uint8Array(4) }],
  });
  assert.throws(() => fsb5ToWav(silent), CorruptError);
});

// The ADPCM expectations below are worked out by hand from each format's
// definition (the step and coefficient tables, the nibble order), one sample
// at a time, in the comments next to them.

test("IMAADPCM mono: header sample, then nibbles low first, frame by frame", () => {
  const data = new Uint8Array(0x48);
  data.set([0xe8, 0x03, 10, 0, 0x87, 0x03]); // frame 0: hist 1000, index 10; nibbles 7, 8, 3
  data.set([0xfe, 0xff, 0, 0, 0x0c], 0x24); // frame 1: hist -2, index 0; nibble 12
  const wav = fsb5ToWav(
    single(Fsb5Codec.IMAADPCM, { frequencyId: 8, sampleCount: 66, data }),
  );
  assert.equal(header(wav).bits, 16);
  assert.equal(header(wav).dataSize, 132);
  const pcm = samples16(wav);
  // step 19 (index 10): nibble 7 = 19>>3 + 19>>2 + 19>>1 + 19 = 2+4+9+19 = +34 -> 1034, index 18
  // step 41: nibble 8 = -(41>>3) = -5 -> 1029, index 17
  // step 37: nibble 3 = 37>>3 + 37>>2 + 37>>1 = 4+9+18 = +31 -> 1060
  assert.deepEqual(pcm.slice(0, 4), [1000, 1034, 1029, 1060]);
  // Frame 1 starts at sample 64: its header, then step 7: nibble 12 = -(7>>3 + 7) = -7 -> -9
  assert.deepEqual(pcm.slice(64), [-2, -9]);
});

test("IMAADPCM saturates to 16 bits instead of wrapping", () => {
  const data = new Uint8Array(0x24);
  data.set([0xf8, 0x7f, 88, 0, 0xf7]); // hist 32760, index 88; nibbles 7, 15
  const wav = fsb5ToWav(single(Fsb5Codec.IMAADPCM, { sampleCount: 3, data }));
  // step 32767: nibble 7 = 4095+8191+16383+32767 = 61436 -> 32767 (clamped), index stays 88;
  // nibble 15 = -61436 -> -28669
  assert.deepEqual(samples16(wav), [32760, 32767, -28669]);
});

test("IMAADPCM stereo: two headers, then 4-byte nibble groups per channel in turn", () => {
  const data = new Uint8Array(0x48);
  data.set([100, 0, 0, 0, 0x9c, 0xff, 0, 0]); // left hist 100, right hist -100, index 0
  data[8] = 0x21; // left nibbles 1, 2
  data[12] = 0x94; // right nibbles 4, 9
  const wav = fsb5ToWav(
    single(Fsb5Codec.IMAADPCM, { channelBits: 1, sampleCount: 3, data }),
  );
  assert.equal(header(wav).channels, 2);
  // left, step 7: nibble 1 = 0 + 1 -> 101 (index 0); nibble 2 = 0 + 3 -> 104
  // right, step 7: nibble 4 = 0 + 7 -> -93 (index 2, step 9); nibble 9 = -(1 + 2) -> -96
  assert.deepEqual(samples16(wav), [100, -100, 101, -93, 104, -96]);
});

test("IMAADPCM of more than two channels is refused; short data is corrupt", () => {
  const six = bank({
    codec: Fsb5Codec.IMAADPCM,
    samples: [{ channelBits: 2, sampleCount: 1, data: new Uint8Array(6 * 0x24) }],
  });
  assert.throws(() => fsb5ToWav(six), unsupported("IMAADPCM channel count", 6));
  const short = single(Fsb5Codec.IMAADPCM, { sampleCount: 65, data: new Uint8Array(0x24) });
  assert.throws(() => fsb5ToWav(short), /IMAADPCM sample of 65 frames needs 72 bytes of data but has 64/);
});

/** A one-channel DSPCOEFF chunk: coefficient pair 1 is (2048, -1024), the rest 0. */
const DSPCOEFF = {
  type: 7,
  body: concat(int16be(0, 0, 2048, -1024, ...new Array(12).fill(0)), new Uint8Array(14)),
};

test("GCADPCM mono: predictor and scale byte, then nibbles high first", () => {
  // Header 0x12: coefficient pair 1, scale 1 << 2 = 4. Nibbles 3, -1, 7.
  const data = Uint8Array.of(0x12, 0x3f, 0x70, 0, 0, 0, 0, 0);
  const wav = fsb5ToWav(
    single(Fsb5Codec.GCADPCM, { sampleCount: 3, chunks: [DSPCOEFF], data }),
  );
  // (3*4 << 11) + 1024 + 2048*0 - 1024*0 = 25600 >> 11 = 12
  // (-1*4 << 11) + 1024 + 2048*12 - 1024*0 = 17408 >> 11 = 8
  // (7*4 << 11) + 1024 + 2048*8 - 1024*12 = 62464 >> 11 = 30
  assert.deepEqual(samples16(wav), [12, 8, 30]);
});

test("GCADPCM: stereo is refused; no coefficients, predictor > 7 or short data is corrupt", () => {
  const stereo = bank({
    codec: Fsb5Codec.GCADPCM,
    samples: [{ channelBits: 1, sampleCount: 1, data: new Uint8Array(16) }],
  });
  assert.throws(() => fsb5ToWav(stereo), unsupported("GCADPCM channel count", 2));
  const bare = single(Fsb5Codec.GCADPCM, { sampleCount: 1, data: new Uint8Array(8) });
  assert.throws(() => fsb5ToWav(bare), /no DSPCOEFF chunk/);
  const predictor = bank({
    codec: Fsb5Codec.GCADPCM,
    samples: [{ sampleCount: 1, chunks: [DSPCOEFF], data: Uint8Array.of(0x80, 0) }],
  });
  assert.throws(() => fsb5ToWav(predictor), /predictor 8 > 7/);
  // 61 samples: 4 full frames (32 bytes), then a header byte and 3 bytes for 5 nibbles.
  const short = bank({
    codec: Fsb5Codec.GCADPCM,
    samples: [{ sampleCount: 61, chunks: [DSPCOEFF], data: new Uint8Array(32) }],
  });
  assert.throws(() => fsb5ToWav(short), /GCADPCM sample of 61 frames needs 36 bytes of data but has 32/);
});

/** An FADPCM frame: coefficient indices, shifts, hist1, hist2, then the first nibble word. */
function fadpcmFrame(coefs: number, shifts: number, hist1: number, hist2: number, nibbles: number) {
  const frame = new Uint8Array(0x8c);
  const view = new DataView(frame.buffer);
  view.setUint32(0, coefs, true);
  view.setUint32(4, shifts, true);
  view.setInt16(8, hist1, true);
  view.setInt16(10, hist2, true);
  view.setUint32(12, nibbles, true);
  return frame;
}

test("FADPCM mono: per-group coefficients and shift, nibbles low first", () => {
  // Group 0: coefficient index 2 = (122, 60), shift 10; hist1 100, hist2 50; nibbles 1, 15, 0.
  const data = fadpcmFrame(2, 10, 100, 50, 0xf1);
  const wav = fsb5ToWav(single(Fsb5Codec.FADPCM, { sampleCount: 3, data }));
  // (1 << 28) >> 12 = 65536: (65536 - 50*60 + 100*122) >> 6 = 74736 >> 6 = 1167
  // (15 << 28) >> 12 = -65536: (-65536 - 100*60 + 1167*122) >> 6 = 70838 >> 6 = 1106
  // 0: (0 - 1167*60 + 1106*122) >> 6 = 64912 >> 6 = 1014
  assert.deepEqual(samples16(wav), [1167, 1106, 1014]);
});

test("FADPCM stereo: frames alternate between channels; index 8 repeats index 1", () => {
  // Shift 0 scales a nibble n to n << 6.
  const left = fadpcmFrame(1, 0, 64, 0, 1); // (60, 0): (64 + 64*60) >> 6 = 61
  const right = fadpcmFrame(8, 0, 64, 0, 2); // 8 % 7 = 1, (60, 0): (128 + 64*60) >> 6 = 62
  const wav = fsb5ToWav(
    single(Fsb5Codec.FADPCM, { channelBits: 1, sampleCount: 1, data: concat(left, right) }),
  );
  assert.deepEqual(samples16(wav), [61, 62]);
});

test("FADPCM data shorter than its frames is corrupt", () => {
  const bytes = bank({
    codec: Fsb5Codec.FADPCM,
    samples: [{ channelBits: 1, sampleCount: 1, data: new Uint8Array(0x8c) }],
  });
  assert.throws(() => fsb5ToWav(bytes), /FADPCM sample of 1 frames needs 280 bytes of data but has 160/);
});

test("the WAV is a new array, not a view into the bank", () => {
  const data = Uint8Array.from({ length: 4 }, (_, i) => i);
  const bytes = single(Fsb5Codec.PCM16, { sampleCount: 2, data });
  const wav = fsb5ToWav(bytes);
  assert.notEqual(wav.buffer, bytes.buffer);
  assert.equal(wav.byteOffset, 0);
});
