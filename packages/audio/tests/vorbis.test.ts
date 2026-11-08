import assert from "node:assert/strict";
import { test } from "node:test";

import { CorruptError, load, UnsupportedError, type AudioClipFields } from "unity-asset-reader";
import { loadFixture } from "../../../fixtures/helpers.js";
import { Fsb5Codec, fsb5ToOgg, fsb5ToWav, readFsb5, type VorbisSetupHeader } from "../src/index.js";
import { concat, single, words } from "./bank.js";
import { readPages } from "./pages.js";

/** The section 11 audio bundles: three editors, each lz4, lz4-notypetree and stripped. */
const AUDIO_FIXTURES = ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"].flatMap((editor) =>
  ["lz4", "lz4-notypetree", "stripped"].map((variant) => `editor/${editor}/${variant}/audio`),
);

/** tone-vorbis's audioData in a section 11 bundle. */
function toneVorbis(fixture: string): Uint8Array {
  const env = load(loadFixture(fixture));
  const clip = [...env.assets("AudioClip")].find((a) => a.name === "tone-vorbis");
  assert.ok(clip, `${fixture}: no tone-vorbis`);
  return (clip.data as AudioClipFields).audioData;
}

function unsupported(kind: string, found: string | number, message?: RegExp) {
  return (e: unknown) => {
    assert.ok(e instanceof UnsupportedError, String(e));
    assert.equal(e.kind, kind);
    assert.equal(e.found, found);
    if (message) assert.match(e.message, message);
    return true;
  };
}

function corrupt(message: RegExp) {
  return (e: unknown) => {
    assert.ok(e instanceof CorruptError, String(e));
    assert.match(e.message, message);
    return true;
  };
}

// The CRC FMOD writes for Unity's mono 22050 Hz Vorbis clips (#241, python-fsb5's
// and Fmod5Sharp's tables name it); the table itself is not in the repository.
const TONE_CRC = 0x8d00698d;

test("tone-vorbis of every section 11 bundle: the VORBISDATA CRC, and no table means no Ogg", () => {
  for (const fixture of AUDIO_FIXTURES) {
    const audioData = toneVorbis(fixture);
    const { codec, samples } = readFsb5(audioData);
    assert.equal(codec, Fsb5Codec.VORBIS, fixture);
    assert.equal(samples[0]!.vorbisCrc, TONE_CRC, fixture);
    const refused = unsupported("Vorbis setup header CRC", "0x8D00698D", /Map from each CRC-32/);
    assert.throws(() => fsb5ToOgg(audioData), refused, fixture);
    assert.throws(() => fsb5ToOgg(audioData, new Map()), refused, fixture);
    const other = new Map([[TONE_CRC + 1, setupHeader([0, 1])]]);
    assert.throws(() => fsb5ToOgg(audioData, other), refused, fixture);
  }
});

test("fsb5ToWav refuses Vorbis and points to fsb5ToOgg", () => {
  const audioData = toneVorbis("editor/6000.3.25f1/lz4/audio");
  assert.throws(() => fsb5ToWav(audioData), unsupported("FSB5 codec", "VORBIS", /fsb5ToOgg/));
});

/** Bits, least significant first, as Vorbis packs them. */
class BitWriter {
  readonly bytes: number[] = [];
  bit = 0;
  write(value: number, count: number): this {
    for (let i = 0; i < count; i++, this.bit++) {
      if ((this.bit & 7) === 0) this.bytes.push(0);
      this.bytes[this.bytes.length - 1]! |= ((value >>> i) & 1) << (this.bit & 7);
    }
    return this;
  }
}

/**
 * A setup header that is valid as far as the rebuild reads it: type 5,
 * "vorbis", two filler bytes standing for the codebooks to mappings, then the
 * mode list (Vorbis I 4.2.4 step 5) at bit 72 and the framing bit.
 */
function setupHeader(blockFlags: number[], framing = 1): VorbisSetupHeader {
  const w = new BitWriter();
  for (const byte of [5, ..."vorbis"].map((c) => (typeof c === "number" ? c : c.charCodeAt(0)))) {
    w.write(byte, 8);
  }
  w.write(0xa5, 8).write(0x5a, 8);
  const seekBit = w.bit;
  w.write(blockFlags.length - 1, 6);
  for (const flag of blockFlags) w.write(flag, 1).write(0, 16).write(0, 16).write(0, 8);
  w.write(framing, 1);
  return { headerBytes: Uint8Array.from(w.bytes), seekBit };
}

/** A sample's bytes: each packet after its 16-bit little-endian size, then `end`. */
function packetData(packets: Uint8Array[], end: number[] = [0, 0]): Uint8Array {
  return concat(
    ...packets.map((p) => concat(Uint8Array.of(p.length & 0xff, p.length >> 8), p)),
    Uint8Array.from(end),
  );
}

/** A mono 22050 Hz Vorbis bank whose VORBISDATA chunk names `crc`. */
function vorbisBank(sampleCount: number, data: Uint8Array, crc = 0x1234abcd): Uint8Array {
  const chunks = [{ type: 11, body: words(crc, 0) }];
  return single(Fsb5Codec.VORBIS, { sampleCount, chunks, data });
}

// Audio packets: bit 0 clear, then the mode number in ilog(modes - 1) bits.
// With modes [short, long]: 0x00 is mode 0 (256), 0x02 mode 1 (2048).
const SHORT = Uint8Array.of(0x00, 0xaa);
const LONG = Uint8Array.of(0x02, 0xbb, 0xcc);

test("the three headers, then audio packets at Fmod5Sharp's granule positions", () => {
  const header = setupHeader([0, 1]);
  const headers = new Map([[0x1234abcd, header]]);
  const data = packetData([SHORT, LONG, LONG, SHORT]);
  const pages = readPages(fsb5ToOgg(vorbisBank(5000, data), headers));

  // The identification header alone on the first page (Vorbis I A.2).
  assert.deepEqual(pages[0]!.packets, [
    Uint8Array.of(
      1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, // 1, "vorbis"
      0, 0, 0, 0, // version 0
      1, // channels
      0x22, 0x56, 0, 0, // 22050 Hz
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // bitrates
      0xb8, // block sizes 2^8 and 2^11
      1, // framing
    ),
  ]);
  assert.equal(pages[0]!.flags, 2);
  assert.equal(pages[0]!.granule, 0n);

  // Comment and setup headers on the second page, which they end.
  const [comment, setup] = pages[1]!.packets;
  const vendor = "unity-asset-reader-audio";
  const expected = concat(
    Uint8Array.of(3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, vendor.length, 0, 0, 0),
    new TextEncoder().encode(vendor),
    Uint8Array.of(0, 0, 0, 0, 1),
  );
  assert.deepEqual(comment, expected);
  assert.deepEqual(setup, header.headerBytes);
  assert.equal(pages[1]!.packets.length, 2);
  assert.equal(pages[1]!.granule, 0n);

  // The first audio packet alone, at 0; then (256 + 2048) / 4 = 576,
  // + (2048 + 2048) / 4 = 1600, + (2048 + 256) / 4 = 2176.
  assert.equal(pages.length, 4);
  assert.deepEqual(pages[2]!.packets, [SHORT]);
  assert.equal(pages[2]!.granule, 0n);
  assert.deepEqual(pages[3]!.packets, [LONG, LONG, SHORT]);
  assert.equal(pages[3]!.granule, 2176n);
  assert.deepEqual(pages.map((p) => p.flags), [2, 0, 0, 4]);
  assert.deepEqual(pages.map((p) => p.serial), [1, 1, 1, 1]);
});

test("the stream ends at sampleCount, the last packet written flagged end of stream", () => {
  const headers = new Map([[0x1234abcd, setupHeader([0, 1])]]);
  const data = packetData([SHORT, LONG, LONG, SHORT]);

  const clamped = readPages(fsb5ToOgg(vorbisBank(2000, data), headers)).at(-1)!;
  assert.deepEqual(clamped.packets, [LONG, LONG, SHORT]);
  assert.equal(clamped.granule, 2000n);
  assert.equal(clamped.flags, 4);

  const early = readPages(fsb5ToOgg(vorbisBank(1600, data), headers)).at(-1)!;
  assert.deepEqual(early.packets, [LONG, LONG]);
  assert.equal(early.granule, 1600n);
  assert.equal(early.flags, 4);
});

test("a packet size of 0 or 0xFFFF ends the packets", () => {
  const headers = new Map([[0x1234abcd, setupHeader([0, 1])]]);
  for (const end of [[0, 0], [0xff, 0xff]]) {
    const data = concat(packetData([SHORT, LONG], end), packetData([LONG]));
    const last = readPages(fsb5ToOgg(vorbisBank(5000, data), headers)).at(-1)!;
    assert.deepEqual(last.packets, [LONG]);
    assert.equal(last.granule, 576n);
  }
});

test("one mode: no mode bits, every block short", () => {
  const headers = new Map([[0x1234abcd, setupHeader([0])]]);
  const data = packetData([Uint8Array.of(0x00), Uint8Array.of(0xfe), Uint8Array.of(0x00)]);
  const last = readPages(fsb5ToOgg(vorbisBank(5000, data), headers)).at(-1)!;
  assert.equal(last.granule, 256n); // 0, 128, 256
});

test("the mode number is ilog(modes - 1) bits wide, as Vorbis I 4.3.1 reads it", () => {
  // Four modes: 2 bits. 0x06 is mode 3 (long), its bit 3 clear; 0x0e is mode 3
  // with bit 3 set, which a modes - 1 = 3 bit read would take for mode 7.
  const headers = new Map([[0x1234abcd, setupHeader([0, 0, 0, 1])]]);
  const data = packetData([Uint8Array.of(0x00), Uint8Array.of(0x0e), Uint8Array.of(0x06)]);
  const last = readPages(fsb5ToOgg(vorbisBank(5000, data), headers)).at(-1)!;
  assert.equal(last.granule, 576n + 1024n); // 0, (256 + 2048) / 4, + 2048 / 2
});

test("Vorbis input the rebuild cannot use is refused", () => {
  const headers = new Map([[0x1234abcd, setupHeader([0, 1, 0])]]);
  const notVorbis = single(Fsb5Codec.PCM16, { sampleCount: 1, data: new Uint8Array(2) });
  assert.throws(() => fsb5ToOgg(notVorbis, headers), unsupported("FSB5 codec", "PCM16"));

  const noChunk = single(Fsb5Codec.VORBIS, { sampleCount: 1, data: packetData([SHORT]) });
  const noCrc = unsupported("FSB5 Vorbis sample", "no VORBISDATA chunk");
  assert.throws(() => fsb5ToOgg(noChunk, headers), noCrc);

  // Three modes take 2 bits: 0x06 names mode 3.
  const badMode = vorbisBank(5000, packetData([SHORT, Uint8Array.of(0x06)]));
  assert.throws(() => fsb5ToOgg(badMode, headers), corrupt(/packet 1 names mode 3 .* has 3/));

  // The sample's data runs to the bank's end, 32 bytes with padding.
  const truncated = vorbisBank(5000, concat(packetData([SHORT], []), Uint8Array.of(0, 1, 1, 2)));
  const short = corrupt(/packet 1 at offset 4 is 256 bytes but the sample has 26 left/);
  assert.throws(() => fsb5ToOgg(truncated, headers), short);
});

test("a setup header entry that is not one is refused, naming the CRC", () => {
  const bank = vorbisBank(5000, packetData([SHORT]));
  const good = setupHeader([0, 1]);
  const entries: [VorbisSetupHeader, RegExp][] = [
    [{ ...good, headerBytes: good.headerBytes.map((b, i) => (i === 0 ? 1 : b)) }, /type 5/],
    [{ ...good, seekBit: good.headerBytes.length * 8 }, /seekBit \d+ is outside/],
    [{ ...good, seekBit: 1.5 }, /seekBit 1.5 is outside/],
    [{ ...good, seekBit: good.seekBit + 1 }, /no framing bit after/],
    [setupHeader([0, 1], 0), /no framing bit after 2 modes/],
  ];
  for (const [entry, message] of entries) {
    const headers = new Map([[0x1234abcd, entry]]);
    assert.throws(() => fsb5ToOgg(bank, headers), corrupt(/CRC 0x1234ABCD/));
    assert.throws(() => fsb5ToOgg(bank, headers), corrupt(message));
  }
});
