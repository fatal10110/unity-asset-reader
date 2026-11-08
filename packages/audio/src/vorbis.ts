// Ported from Fmod5Sharp/Fmod5Sharp/CodecRebuilders/FmodVorbisRebuilder.cs and Fmod5Sharp/Util/FmodVorbisData.cs (MIT, © 2021 Sam Byass)

import { CorruptError, UnsupportedError } from "unity-asset-reader";
import { Fsb5Codec, readFsb5 } from "./fsb5.js";
import { writeOggStream, type OggPacket } from "./ogg.js";

/**
 * A Vorbis setup header that FMOD left out of its banks, as a caller supplies
 * it to {@link fsb5ToOgg}, keyed by the CRC-32 an FSB5 sample's `VORBISDATA`
 * chunk names ({@link Fsb5Sample.vorbisCrc}). The shape of an entry of
 * Fmod5Sharp's `vorbis_headers_converted.json`, its base64 decoded.
 */
export interface VorbisSetupHeader {
  /** The whole setup header packet: type 5, `"vorbis"`, codebooks to modes, framing bit. */
  headerBytes: Uint8Array;
  /** The bit offset in `headerBytes` of the mode count (6 bits) that starts the mode list. */
  seekBit: number;
}

/** Our vendor string in the comment header. */
const VENDOR = "unity-asset-reader-audio";

/** Serial number of the one logical stream, as Fmod5Sharp writes it. */
const SERIAL = 1;

/** FMOD's block sizes: short 2^8, long 2^11 frames. */
const SHORT_BLOCK = 256;
const LONG_BLOCK = 2048;

/**
 * Rebuild the first sample of an FSB5 bank of codec `VORBIS` as an Ogg Vorbis
 * file, as Fmod5Sharp's `FmodVorbisRebuilder.RebuildOggFile()` does.
 *
 * FMOD strips the three Vorbis headers from its banks. The identification
 * header is rebuilt from the sample's channels and rate (block sizes 256 and
 * 2048, as FMOD encodes), the comment header holds only a vendor string, and
 * the setup header comes from `headers`, looked up by the CRC-32 in the
 * sample's `VORBISDATA` chunk. No table ships with this package: the headers
 * are bytes of FMOD's library. The audio packets are the sample's bytes, each
 * a 16-bit little-endian size and the packet (a size of 0 or 0xFFFF ends
 * them); each packet's granule position adds a quarter of its block size and
 * the previous one's, up to `sampleCount`, where the stream ends.
 *
 * Pages follow Vorbis I's rules: the identification header alone on the first
 * page, the comment and setup headers on the next, audio from the third, the
 * first audio packet alone on that page.
 *
 * Differences from Fmod5Sharp: our vendor string; the end-of-stream flag is on
 * the last packet written, also when the stream stops at `sampleCount` before
 * the sample's packets run out; the first audio packet gets a page of its own
 * (Fmod5Sharp's pages fill to 4096 bytes, so a short clip's audio is one page,
 * both first and last, which ffmpeg trims short); a packet's mode number is read in
 * `ilog(modes - 1)` bits, as Vorbis I section 4.3.1 says, where Fmod5Sharp
 * reads `modes - 1` bits (the same for the one or two modes FMOD's headers
 * have); malformed input is refused instead of read.
 *
 * @param bytes the sound bank, for example an `AudioClip`'s `audioData`
 * @param headers setup headers by CRC-32, see {@link VorbisSetupHeader}
 * @returns the Ogg file, a new array
 * @throws {UnsupportedError} for a codec other than Vorbis (kind `"FSB5
 *   codec"`), when the sample has no `VORBISDATA` chunk (kind `"FSB5 Vorbis
 *   sample"`), when `headers` is absent or lacks the sample's CRC (kind
 *   `"Vorbis setup header CRC"`, found `"0x8D00698D"` for example), and as
 *   {@link readFsb5} does
 * @throws {CorruptError} when the bank has no sample, a packet runs past the
 *   sample's data or names a mode the setup header lacks, or the header for
 *   the CRC is not a Vorbis setup header with its mode list at `seekBit`; and
 *   as {@link readFsb5} does
 */
export function fsb5ToOgg(
  bytes: Uint8Array,
  headers?: ReadonlyMap<number, VorbisSetupHeader>,
): Uint8Array {
  const { codec, samples } = readFsb5(bytes);
  if (codec !== Fsb5Codec.VORBIS) {
    const names = Object.keys(Fsb5Codec) as (keyof typeof Fsb5Codec)[];
    const name = names.find((key) => Fsb5Codec[key] === codec);
    const hint = "Ogg is written for Vorbis only; fsb5ToWav converts PCM and ADPCM";
    throw new UnsupportedError("FSB5 codec", name ?? codec, hint);
  }
  const sample = samples[0];
  if (!sample) throw new CorruptError("FSB5 sound bank has no sample");
  const { vorbisCrc: crc, channels, frequency, sampleCount, data } = sample;
  if (crc === undefined) {
    const hint = "its setup header cannot be looked up without the CRC that chunk holds";
    throw new UnsupportedError("FSB5 Vorbis sample", "no VORBISDATA chunk", hint);
  }
  const crcHex = `0x${crc.toString(16).toUpperCase().padStart(8, "0")}`;
  const header = headers?.get(crc);
  if (!header) {
    const hint =
      `${headers ? "not in the headers passed" : "no setup headers passed"} to fsb5ToOgg; ` +
      "pass a Map from each CRC-32 to { headerBytes, seekBit }, for example from " +
      "Fmod5Sharp's vorbis_headers_converted.json (see the README)";
    throw new UnsupportedError("Vorbis setup header CRC", crcHex, hint);
  }
  const blockFlags = modeBlockFlags(header, crcHex);
  const modeBits = ilog(blockFlags.length - 1);

  const packets: OggPacket[] = [
    { data: identificationHeader(channels, frequency), granule: 0, flush: true },
    { data: commentHeader(), granule: 0 },
    { data: header.headerBytes, granule: 0, flush: true },
  ];
  let granule = 0;
  let previousBlock = 0;
  let index = 0;
  for (let at = 0; at + 2 < data.length; index++) {
    const size = data[at]! | (data[at + 1]! << 8);
    if (size === 0 || size === 0xffff) break;
    at += 2;
    if (at + size > data.length) {
      throw new CorruptError(
        `Vorbis packet ${index} at offset ${at - 2} is ${size} bytes but the sample has ` +
          `${data.length - at} left`,
      );
    }
    const packet = data.subarray(at, at + size);
    at += size;

    // An audio packet starts with bit 0 clear, then its mode number.
    let block = 0;
    if ((packet[0]! & 1) === 0) {
      const mode = readBits(packet, 1, modeBits);
      const flag = blockFlags[mode];
      if (flag === undefined) {
        throw new CorruptError(
          `Vorbis packet ${index} names mode ${mode} but the setup header for ${crcHex} has ` +
            `${blockFlags.length}`,
        );
      }
      block = flag ? LONG_BLOCK : SHORT_BLOCK;
    }
    // Fmod5Sharp's granule positions: the first packet (and one after a
    // non-audio packet) at 0, then a quarter of both blocks further each.
    granule = previousBlock === 0 ? 0 : Math.min(sampleCount, granule + (block + previousBlock) / 4);
    previousBlock = block;
    // The first audio packet decodes to no samples: alone on its page, at
    // granule 0, it keeps that page from reading as a start trim when the
    // stream's end trim is on the same page (Vorbis I A.2).
    packets.push({ data: packet, granule, flush: index === 0 });
    if (granule === sampleCount) break;
  }
  return writeOggStream(SERIAL, packets);
}

/** Vorbis I's `ilog`: the bits needed to hold `value`, 0 for 0. */
function ilog(value: number): number {
  let bits = 0;
  for (let v = value; v > 0; v >>>= 1) bits++;
  return bits;
}

/** `count` bits of `bytes` from bit `at`, least significant first, as Vorbis packs them. */
function readBits(bytes: Uint8Array, at: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bit = at + i;
    const byte = bytes[bit >>> 3];
    if (byte === undefined) return -1;
    value |= ((byte >>> (bit & 7)) & 1) << i;
  }
  return value;
}

/**
 * The block flag of each mode of a setup header (Vorbis I section 4.2.4, step
 * 5: 6 bits of mode count - 1, then per mode a 1-bit block flag, 16-bit window
 * type, 16-bit transform type and 8-bit mapping), read from `seekBit`.
 */
function modeBlockFlags({ headerBytes, seekBit }: VorbisSetupHeader, crcHex: string): number[] {
  const corrupt = (why: string) =>
    new CorruptError(`Vorbis setup header for CRC ${crcHex}: ${why}`);
  const magic = String.fromCharCode(...headerBytes.subarray(1, 7));
  if (headerBytes[0] !== 5 || magic !== "vorbis") {
    throw corrupt("does not start with packet type 5 and \"vorbis\"");
  }
  const end = headerBytes.length * 8;
  if (!Number.isInteger(seekBit) || seekBit < 56 || seekBit + 6 > end) {
    throw corrupt(`seekBit ${seekBit} is outside its ${end} bits`);
  }
  const modes = readBits(headerBytes, seekBit, 6) + 1;
  // The mode list ends the header: its framing bit follows.
  const framing = seekBit + 6 + modes * 41;
  if (readBits(headerBytes, framing, 1) !== 1) {
    throw corrupt(`no framing bit after ${modes} modes from seekBit ${seekBit}`);
  }
  return Array.from({ length: modes }, (_, m) => readBits(headerBytes, seekBit + 6 + m * 41, 1));
}

/** The identification header: Vorbis I section 4.2.2, FMOD's block sizes. */
function identificationHeader(channels: number, frequency: number): Uint8Array {
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out[0] = 1;
  ascii(out, 1, "vorbis");
  // version 0 at 7; bitrates (maximum, nominal, minimum) 0 at 16: unknown
  out[11] = channels;
  view.setUint32(12, frequency, true);
  out[28] = (Math.log2(LONG_BLOCK) << 4) | Math.log2(SHORT_BLOCK);
  out[29] = 1; // framing
  return out;
}

/** The comment header: Vorbis I section 5.2.1, our vendor string, no comments. */
function commentHeader(): Uint8Array {
  const out = new Uint8Array(7 + 4 + VENDOR.length + 4 + 1);
  const view = new DataView(out.buffer);
  out[0] = 3;
  ascii(out, 1, "vorbis");
  view.setUint32(7, VENDOR.length, true);
  ascii(out, 11, VENDOR);
  // comment count 0, then the framing bit
  out[out.length - 1] = 1;
  return out;
}

function ascii(out: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
}
