import assert from "node:assert/strict";
import { test } from "node:test";

import { CorruptError, load, UnsupportedError, type AudioClipFields } from "unity-asset-reader";
import { golden, loadFixture } from "../../../fixtures/helpers.js";
import { Fsb5Codec, readFsb5 } from "../src/index.js";
import { bank, concat, int16be, single, words } from "./bank.js";

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"];
const VARIANTS = ["lz4", "lz4-notypetree", "stripped"];

/** A float golden (`"f32:<hex>"`, plan §5) as a number. */
function f32(value: unknown): number {
  const hex = String(value).replace(/^f32:/, "");
  return new DataView(Uint8Array.from(Buffer.from(hex, "hex")).buffer).getFloat32(0);
}

// Unity's own banks (fixtures/BUILDING.md section 11): the header fields against
// the AudioClip fields UnityPy read from the same object, and the source WAV's
// 5512 frames (22050 // 4 in gen_media.py).
test("reads the FSB5 banks of every section 11 audio bundle", () => {
  for (const editor of EDITORS) {
    // The typed bundle's type tree goldens hold the clip fields.
    const [sf] = Object.values(golden(`editor/${editor}/lz4/audio`).serialized ?? {});
    const trees = Object.values(sf!.typetrees).map((t) => t.value as Record<string, unknown>);
    for (const variant of VARIANTS) {
      const fixture = `editor/${editor}/${variant}/audio`;
      const clips = [...load(loadFixture(fixture)).assets("AudioClip")];
      assert.equal(clips.length, 2, fixture);
      for (const clip of clips) {
        const data = clip.data as AudioClipFields;
        const tree = trees.find((t) => t.m_Name === data.name);
        assert.ok(tree, `${fixture}: no golden for ${data.name}`);
        const fsb = readFsb5(data.audioData);
        assert.equal(fsb.version, 1, fixture);
        assert.equal(fsb.codec, data.name === "tone-pcm" ? Fsb5Codec.PCM16 : Fsb5Codec.VORBIS);
        assert.equal(fsb.samples.length, 1);
        const [sample] = fsb.samples;
        assert.equal(sample!.frequency, tree.m_Frequency, `${fixture} ${data.name}`);
        assert.equal(sample!.channels, tree.m_Channels, `${fixture} ${data.name}`);
        assert.equal(sample!.sampleCount, 5512, `${fixture} ${data.name}`);
        assert.equal(Math.round(f32(tree.m_Length) * sample!.frequency), 5512);
        assert.equal(sample!.name, undefined);
        if (data.name === "tone-pcm") {
          // 5512 16-bit frames, padded to 32 bytes; the data section ends the bank.
          assert.equal(sample!.data.length, 11040);
          const end = data.audioData.byteOffset + data.audioData.length;
          assert.equal(sample!.data.byteOffset + 11040, end);
          assert.equal(sample!.data.buffer, data.audioData.buffer, "a view, not a copy (R7)");
        }
      }
    }
  }
});

test("version 0: a 0x40-byte header; samples, offsets, chunks and names", () => {
  const first = Uint8Array.from({ length: 40 }, (_, i) => i);
  const second = Uint8Array.from({ length: 8 }, (_, i) => 100 + i);
  const bytes = bank({
    version: 0,
    codec: Fsb5Codec.PCM8,
    names: ["first", "second"],
    samples: [
      {
        frequencyId: 3,
        channelBits: 1,
        sampleCount: 20,
        // LOOP (type 3) and an unknown type are skipped.
        chunks: [
          { type: 3, body: words(1, 19) },
          { type: 99, body: new Uint8Array(5) },
        ],
        data: first,
      },
      {
        frequencyId: 10,
        channelBits: 3,
        sampleCount: 1,
        // FREQUENCY gives Hz and CHANNELS overrides the header's channel bits.
        chunks: [
          { type: 2, body: words(12345) },
          { type: 1, body: Uint8Array.of(3) },
        ],
        data: second,
      },
    ],
  });
  const fsb = readFsb5(bytes);
  assert.equal(fsb.version, 0);
  assert.equal(fsb.codec, Fsb5Codec.PCM8);
  const [a, b] = fsb.samples;
  // Id 3 is 12000 Hz in FMOD's table (python-fsb5 says 11025).
  assert.deepEqual({ ...a!, data: [...a!.data] }, {
    name: "first",
    frequency: 12000,
    channels: 2,
    sampleCount: 20,
    data: [...first, ...new Uint8Array(24)], // up to the second sample's offset, 64
  });
  assert.deepEqual({ ...b!, data: [...b!.data] }, {
    name: "second",
    frequency: 12345,
    channels: 3,
    sampleCount: 1,
    data: [...second, ...new Uint8Array(24)], // to the end of the data section
  });
});

test("frequency ids 0 to 10 come from FMOD's table; others need a FREQUENCY chunk", () => {
  const table = [4000, 8000, 11000, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
  table.forEach((hz, id) => {
    const fsb = readFsb5(
      single(2, { frequencyId: id, sampleCount: 1, data: new Uint8Array(2) }),
    );
    assert.equal(fsb.samples[0]!.frequency, hz, `id ${id}`);
  });
  for (const id of [11, 15]) {
    const bytes = single(2, { frequencyId: id, sampleCount: 1, data: new Uint8Array(2) });
    assert.throws(() => readFsb5(bytes), (e: unknown) => {
      assert.ok(e instanceof UnsupportedError);
      assert.equal(e.kind, "FSB5 frequency id");
      assert.equal(e.found, id);
      return true;
    });
  }
});

test("channel bits 0 to 3 are 1, 2, 6 and 8 channels", () => {
  [1, 2, 6, 8].forEach((channels, bits) => {
    const fsb = readFsb5(
      single(2, { channelBits: bits, sampleCount: 1, data: new Uint8Array(16) }),
    );
    assert.equal(fsb.samples[0]!.channels, channels);
  });
});

test("DSPCOEFF: 16 big-endian coefficients per channel, 0x2E bytes each", () => {
  const coefs = (base: number) => Array.from({ length: 16 }, (_, i) => base - i * 300);
  const entry = (base: number) => concat(int16be(...coefs(base)), new Uint8Array(14).fill(0x7f));
  const fsb = readFsb5(
    bank({
      codec: Fsb5Codec.GCADPCM,
      samples: [
        {
          channelBits: 1,
          sampleCount: 14,
          chunks: [{ type: 7, body: concat(entry(1000), entry(-50)) }],
          data: new Uint8Array(16),
        },
      ],
    }),
  );
  const [left, right] = fsb.samples[0]!.dspCoefficients!;
  assert.deepEqual([...left!], coefs(1000));
  assert.deepEqual([...right!], coefs(-50));
});

test("not an FSB5 bank: UnsupportedError naming the signature", () => {
  const cases: [Uint8Array, string][] = [
    [new TextEncoder().encode("OggS\0\0\0\0"), '"OggS"'],
    [Uint8Array.of(0xff, 0xfb, 0x90, 0x00), "0xfffb9000"],
    [new TextEncoder().encode("FS"), '"FS"'],
  ];
  for (const [bytes, found] of cases) {
    assert.throws(() => readFsb5(bytes), (e: unknown) => {
      assert.ok(e instanceof UnsupportedError);
      assert.equal(e.kind, "audio container");
      assert.equal(e.found, found);
      return true;
    });
  }
});

test("a version above 1 is refused", () => {
  const bytes = single(2, { sampleCount: 1, data: new Uint8Array(2) });
  new DataView(bytes.buffer).setUint32(4, 2, true);
  assert.throws(() => readFsb5(bytes), (e: unknown) => {
    assert.ok(e instanceof UnsupportedError);
    assert.equal(e.kind, "FSB5 version");
    assert.equal(e.found, 2);
    return true;
  });
});

test("truncated or inconsistent banks are corrupt", () => {
  const good = bank({
    codec: 2,
    samples: [{ sampleCount: 1, chunks: [{ type: 2, body: words(8000) }], data: new Uint8Array(2) }],
  });
  readFsb5(good);
  // Cut into the data section, and into the header.
  assert.throws(() => readFsb5(good.subarray(0, good.length - 1)), CorruptError);
  assert.throws(() => readFsb5(good.subarray(0, 20)), CorruptError);

  // A FREQUENCY chunk of 2 bytes instead of 4.
  const shortChunk = bank({
    codec: 2,
    samples: [{ sampleCount: 1, chunks: [{ type: 2, body: new Uint8Array(2) }], data: new Uint8Array(2) }],
  });
  assert.throws(() => readFsb5(shortChunk), /chunk type 2 at offset 68 is 2 bytes, expected 4/);

  // A DSPCOEFF chunk sized for one channel on a stereo sample.
  const dsp = bank({
    codec: Fsb5Codec.GCADPCM,
    samples: [
      { channelBits: 1, sampleCount: 1, chunks: [{ type: 7, body: new Uint8Array(0x2e) }], data: new Uint8Array(2) },
    ],
  });
  assert.throws(() => readFsb5(dsp), CorruptError);

  // A data offset past the data section: the header's offset field set to 64 bytes.
  const offset = single(2, { sampleCount: 1, data: new Uint8Array(2) });
  const view = new DataView(offset.buffer);
  view.setUint32(0x3c, view.getUint32(0x3c, true) | (2 << 7), true);
  assert.throws(() => readFsb5(offset), /sample 0 data runs from 64 to 32/);

  // A sample header cut short by the sample header size.
  const headers = single(2, { sampleCount: 1, data: new Uint8Array(2) });
  new DataView(headers.buffer).setUint32(8, 2, true); // two samples, one header
  assert.throws(() => readFsb5(headers), CorruptError);
});
