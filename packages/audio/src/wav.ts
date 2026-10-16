// Ported from AssetStudio.Utility/AudioClipConverter.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "unity-asset-reader";
import { decodeFadpcm, decodeGcAdpcm, decodeImaAdpcm } from "./adpcm.js";
import { Fsb5Codec, readFsb5, type Fsb5Sample } from "./fsb5.js";

/** Bytes per sample of the PCM codecs, which go into the WAV as they are stored. */
const PCM_WIDTH: Partial<Record<Fsb5Codec, number>> = {
  [Fsb5Codec.PCM8]: 1,
  [Fsb5Codec.PCM16]: 2,
  [Fsb5Codec.PCM32]: 4,
};

/** The ADPCM codecs, decoded to 16-bit PCM. */
const ADPCM: Partial<Record<Fsb5Codec, (sample: Fsb5Sample) => Int16Array>> = {
  [Fsb5Codec.GCADPCM]: decodeGcAdpcm,
  [Fsb5Codec.IMAADPCM]: decodeImaAdpcm,
  [Fsb5Codec.FADPCM]: decodeFadpcm,
};

/**
 * Convert an FSB5 sound bank, such as an `AudioClip`'s `audioData` from Unity
 * 5.0 on, to a WAV file, as AssetStudio's `AudioClipConverter.ConvertToWav()`
 * does: its first sample only, as a 44-byte RIFF/`WAVE` header (`fmt ` chunk of
 * 16 bytes, format 1, channels, rate, byte rate, block align, bits) followed by
 * `sampleCount` frames of interleaved little-endian samples.
 *
 * PCM8, PCM16 and PCM32 samples are copied as the bank stores them, at 8, 16
 * and 32 bits (PCM8 too, unconverted, as Fmod5Sharp and python-fsb5 copy it).
 * GCADPCM, IMAADPCM and FADPCM are decoded to 16 bits.
 *
 * @param bytes the sound bank
 * @returns the WAV file, a new array
 * @throws {UnsupportedError} for any other codec (kind `"FSB5 codec"`, with
 *   its name: Vorbis, MPEG, ...), for a GCADPCM sample of more than one channel
 *   or an IMAADPCM one of more than two, and as {@link readFsb5} does
 * @throws {CorruptError} when the bank has no sample, its first sample has no
 *   channels, or its data is shorter than its frames need; and as
 *   {@link readFsb5} does
 */
export function fsb5ToWav(bytes: Uint8Array): Uint8Array {
  const { codec, samples } = readFsb5(bytes);
  const sample = samples[0];
  if (!sample) throw new CorruptError("FSB5 sound bank has no sample");
  const { channels, sampleCount, data } = sample;
  if (channels === 0) throw new CorruptError("FSB5 sample 0 has 0 channels");

  const width = PCM_WIDTH[codec];
  if (width !== undefined) {
    const size = sampleCount * channels * width;
    if (data.length < size) {
      throw new CorruptError(
        `PCM sample of ${sampleCount} frames needs ${size} bytes of data but has ${data.length}`,
      );
    }
    const wav = header(sample, width * 8, size);
    wav.set(data.subarray(0, size), 44);
    return wav;
  }

  const decode = ADPCM[codec];
  if (decode === undefined) {
    const names = Object.keys(Fsb5Codec) as (keyof typeof Fsb5Codec)[];
    const name = names.find((key) => Fsb5Codec[key] === codec);
    const hint = "WAV is written for PCM and ADPCM only";
    throw new UnsupportedError("FSB5 codec", name ?? codec, hint);
  }
  const pcm = decode(sample);
  const wav = header(sample, 16, pcm.length * 2);
  const view = new DataView(wav.buffer);
  pcm.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return wav;
}

/** A WAV file of `dataSize` bytes of samples, its header written and its data zeroed. */
function header({ channels, frequency }: Fsb5Sample, bits: number, dataSize: number): Uint8Array {
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, dataSize + 36, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, frequency, true);
  view.setUint32(28, (frequency * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return wav;
}
