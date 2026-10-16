// Ported from Fmod5Sharp/Fmod5Sharp/{FsbLoader.cs,FmodTypes,ChunkData} (MIT, © 2021 Sam Byass) and python-fsb5/fsb5/__init__.py (MIT, © 2016 Simon Pinfold)

import { BinaryReader, CorruptError, UnsupportedError } from "unity-asset-reader";

/**
 * The codec of every sample of an FSB5 sound bank (FMOD's `FMOD_SOUND_FORMAT`,
 * the header's `mode`). Only `PCM8`, `PCM16`, `PCM32`, `GCADPCM`, `IMAADPCM`
 * and `FADPCM` convert to WAV here.
 */
export const Fsb5Codec = {
  NONE: 0,
  PCM8: 1,
  PCM16: 2,
  PCM24: 3,
  PCM32: 4,
  PCMFLOAT: 5,
  GCADPCM: 6,
  IMAADPCM: 7,
  VAG: 8,
  HEVAG: 9,
  XMA: 10,
  MPEG: 11,
  CELT: 12,
  AT9: 13,
  XWMA: 14,
  VORBIS: 15,
  FADPCM: 16,
  OPUS: 17,
} as const;

/** A value of {@link Fsb5Codec}. */
export type Fsb5Codec = (typeof Fsb5Codec)[keyof typeof Fsb5Codec];

/** One sample (FMOD: subsound) of an FSB5 sound bank. */
export interface Fsb5Sample {
  /** From the bank's name table; absent when the bank has none (Unity writes none). */
  name?: string;
  /** Sample rate in Hz. */
  frequency: number;
  /** Interleaved channels. */
  channels: number;
  /** Sample frames (per channel), as FMOD reports the sound's length. */
  sampleCount: number;
  /**
   * The encoded bytes, from the sample's data offset to the next sample's (or
   * the end of the data section), padding included. A view, never a copy (R7).
   */
  data: Uint8Array;
  /**
   * `GCADPCM` only: the 16 decoder coefficients of each channel, from the
   * sample's `DSPCOEFF` chunk.
   */
  dspCoefficients?: Int16Array[];
}

/** An FSB5 sound bank, as Unity stores an `AudioClip`'s sound from Unity 5.0. */
export interface Fsb5 {
  /** The header's format version, 0 or 1. */
  version: number;
  /** The codec of every sample. */
  codec: Fsb5Codec;
  samples: Fsb5Sample[];
}

/**
 * FMOD's frequency ids. Fmod5Sharp's table, which fmod.dll (the build AssetStudio
 * ships) has too; python-fsb5 has no 0 or 10 and reads 3 as 11025.
 */
const FREQUENCIES = [4000, 8000, 11000, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

/** The two channel-count bits of a sample header. */
const CHANNELS = [1, 2, 6, 8];

/** Sample header chunk types this parser reads; any other is skipped. */
const CHUNK_CHANNELS = 1;
const CHUNK_FREQUENCY = 2;
const CHUNK_DSPCOEFF = 7;

/** Bytes of one channel's `DSPCOEFF` entry: 16 coefficients, then 14 bytes this ignores. */
const DSP_CHANNEL_SIZE = 0x2e;

/**
 * Parse an FSB5 sound bank: the header, each sample's header and chunks, the
 * name table, and where each sample's bytes are.
 *
 * Header: `"FSB5"`, then little-endian `version`, sample count, sizes of the
 * sample headers, the name table and the data, and the codec, in a header of
 * 0x3C bytes (0x40 for version 0). Each sample header is a 64-bit word (bit 0:
 * chunks follow; bits 1-4: frequency id; 5-6: channels 1, 2, 6 or 8; 7-33:
 * data offset / 32; 34-63: sample frames), then its chunks, each a 32-bit word
 * (bit 0: another chunk follows; 1-24: size; 25-31: type) and its body. A
 * `FREQUENCY` chunk gives the rate in Hz and a `CHANNELS` chunk the channel
 * count, overriding the word's; `DSPCOEFF` holds `GCADPCM`'s coefficients,
 * big-endian.
 *
 * Differences from Fmod5Sharp: a `FREQUENCY` chunk's value is the rate itself
 * (as python-fsb5 reads it), not looked up as an id when it is 10 or below; a
 * `CHANNELS` chunk is applied (neither reference does); a version above 1, an
 * unknown frequency id and a sample whose data runs past the data section are
 * refused instead of read.
 *
 * @param bytes the bank, for example an `AudioClip`'s `audioData`
 * @returns the header and samples; sample data are views into `bytes`
 * @throws {UnsupportedError} when `bytes` does not start with `"FSB5"` (kind
 *   `"audio container"`, a pre-5.0 clip's Ogg or MP3 for example), for a
 *   version above 1 (`"FSB5 version"`), and for a frequency id above 10 with no
 *   `FREQUENCY` chunk (`"FSB5 frequency id"`)
 * @throws {CorruptError} when the bank is truncated, the sample headers run past
 *   their section's size, a chunk's size is not what its type needs, or a
 *   sample's data offset lies outside the data section or before the previous
 *   sample's
 */
export function readFsb5(bytes: Uint8Array): Fsb5 {
  const reader = new BinaryReader(bytes, "little");
  const magic = bytes.subarray(0, 4);
  if (magic.length < 4 || String.fromCharCode(...magic) !== "FSB5") {
    throw new UnsupportedError("audio container", signature(magic), "not an FSB5 sound bank");
  }
  reader.position = 4;
  const version = reader.readUInt32();
  if (version > 1) throw new UnsupportedError("FSB5 version", version);
  const count = reader.readUInt32();
  const sampleHeadersSize = reader.readUInt32();
  const nameTableSize = reader.readUInt32();
  const dataSize = reader.readUInt32();
  const codec = reader.readUInt32() as Fsb5Codec;
  // Version 0 has one more 32-bit field than 1; the rest (flags, a 128-bit
  // hash, 8 unknown bytes) is not needed.
  const headerSize = version === 0 ? 0x40 : 0x3c;
  const dataStart = headerSize + sampleHeadersSize + nameTableSize;
  if (dataStart + dataSize > bytes.length) {
    throw new CorruptError(
      `FSB5 needs ${dataStart + dataSize} bytes (header ${headerSize}, sample headers ` +
        `${sampleHeadersSize}, name table ${nameTableSize}, data ${dataSize}) ` +
        `but has ${bytes.length}`,
    );
  }

  // Sample headers and their chunks must stay inside their section.
  const headerSection = bytes.subarray(0, headerSize + sampleHeadersSize);
  const headerReader = new BinaryReader(headerSection, "little");
  headerReader.position = headerSize;
  const headers: SampleHeader[] = [];
  for (let i = 0; i < count; i++) headers.push(readSampleHeader(headerReader, i));

  const samples: Fsb5Sample[] = headers.map((header, i) => {
    const end = i + 1 < headers.length ? headers[i + 1]!.dataOffset : dataSize;
    if (header.dataOffset > end || end > dataSize) {
      throw new CorruptError(
        `FSB5 sample ${i} data runs from ${header.dataOffset} to ${end}, outside the ` +
          `${dataSize} bytes of data`,
      );
    }
    const { dataOffset: _, ...sample } = header;
    const data = bytes.subarray(dataStart + header.dataOffset, dataStart + end);
    return { ...sample, data };
  });

  if (nameTableSize > 0) {
    // One offset per sample, from the table's start, to a NUL-terminated name.
    const tableStart = headerSize + sampleHeadersSize;
    const tableSection = bytes.subarray(tableStart, tableStart + nameTableSize);
    const table = new BinaryReader(tableSection, "little");
    samples.forEach((sample, i) => {
      table.position = 4 * i;
      table.position = table.readUInt32();
      sample.name = table.readStringToNull();
    });
  }
  return { version, codec, samples };
}

/** A sample header with its chunks applied, and where its data starts. */
type SampleHeader = Omit<Fsb5Sample, "data"> & { dataOffset: number };

function readSampleHeader(reader: BinaryReader, index: number): SampleHeader {
  const lo = reader.readUInt32();
  const hi = reader.readUInt32();
  let more = (lo & 1) === 1;
  const frequencyId = (lo >>> 1) & 0xf;
  let channels = CHANNELS[(lo >>> 5) & 3]!;
  const dataOffset = ((lo >>> 7) + (hi & 3) * 2 ** 25) * 32;
  const sampleCount = hi >>> 2;

  let frequency: number | undefined;
  let dspCoefficients: Int16Array[] | undefined;
  while (more) {
    const at = reader.position;
    const word = reader.readUInt32();
    more = (word & 1) === 1;
    const size = (word >>> 1) & 0xffffff;
    const type = word >>> 25;
    const body = new BinaryReader(reader.readBytes(size), "little");
    const expect = (want: number) => {
      if (size !== want) {
        throw new CorruptError(
          `FSB5 sample ${index}: chunk type ${type} at offset ${at} is ${size} bytes, ` +
            `expected ${want}`,
        );
      }
    };
    if (type === CHUNK_FREQUENCY) {
      expect(4);
      frequency = body.readUInt32();
    } else if (type === CHUNK_CHANNELS) {
      expect(1);
      channels = body.readUInt8();
    } else if (type === CHUNK_DSPCOEFF) {
      // ponytail: sized by the channel count read so far, as Fmod5Sharp sizes
      // it; a CHANNELS chunk after DSPCOEFF would be misread. Unity writes none.
      expect(DSP_CHANNEL_SIZE * channels);
      body.endian = "big";
      dspCoefficients = [];
      for (let ch = 0; ch < channels; ch++) {
        body.position = DSP_CHANNEL_SIZE * ch;
        const coefficients = new Int16Array(16);
        for (let k = 0; k < 16; k++) coefficients[k] = body.readInt16();
        dspCoefficients.push(coefficients);
      }
    }
  }

  if (frequency === undefined) {
    frequency = FREQUENCIES[frequencyId];
    if (frequency === undefined) {
      const hint = `sample ${index}, no FREQUENCY chunk`;
      throw new UnsupportedError("FSB5 frequency id", frequencyId, hint);
    }
  }
  const header: SampleHeader = { frequency, channels, sampleCount, dataOffset };
  if (dspCoefficients) header.dspCoefficients = dspCoefficients;
  return header;
}

/** The first bytes of a non-FSB5 input, as text when printable and hex otherwise. */
function signature(bytes: Uint8Array): string {
  const printable = bytes.length > 0 && bytes.every((b) => b >= 0x20 && b < 0x7f);
  if (printable) return JSON.stringify(String.fromCharCode(...bytes));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
