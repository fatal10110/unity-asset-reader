// Ported from Fmod5Sharp/Fmod5Sharp/CodecRebuilders/FmodGcadPcmRebuilder.cs, FmodImaAdPcmRebuilder.cs and FmodFadPcmRebuilder.cs (MIT, © 2021 Sam Byass)

import { CorruptError, UnsupportedError } from "unity-asset-reader";
import type { Fsb5Sample } from "./fsb5.js";

// Every decoder here returns exactly `sampleCount` frames, interleaved, the
// length FMOD reports and so the length of AssetStudio's WAV. Fmod5Sharp sizes
// its output otherwise (from the byte count, or whole frames only); that is
// the one deliberate difference, besides refusing what it would misdecode.

/** GCADPCM (Nintendo DSP ADPCM) frames: one predictor/scale byte, then 14 nibbles. */
const DSP_FRAME_BYTES = 8;
const DSP_FRAME_SAMPLES = 14;

/**
 * Decode a mono GCADPCM sample: each 8-byte frame starts with a byte whose
 * high nibble picks a coefficient pair and whose low nibble is a power-of-two
 * scale, then 14 signed nibbles, high nibble first. History starts at 0.
 *
 * @throws {UnsupportedError} for more than one channel, whose interleave
 *   Fmod5Sharp does not decode either
 * @throws {CorruptError} without `dspCoefficients`, when the data holds fewer
 *   frames than `sampleCount` needs, or for a frame whose predictor is above 7
 *   (there are 8 coefficient pairs)
 */
export function decodeGcAdpcm(sample: Fsb5Sample): Int16Array {
  const { data, sampleCount, channels } = sample;
  if (channels !== 1) {
    throw new UnsupportedError("GCADPCM channel count", channels, "only mono is decoded");
  }
  const coefficients = sample.dspCoefficients?.[0];
  if (!coefficients) throw new CorruptError("GCADPCM sample has no DSPCOEFF chunk");
  const frames = Math.ceil(sampleCount / DSP_FRAME_SAMPLES);
  // The last frame only needs its header byte and the nibbles still to decode.
  const last = sampleCount - (frames - 1) * DSP_FRAME_SAMPLES;
  const need = frames === 0 ? 0 : (frames - 1) * DSP_FRAME_BYTES + 1 + Math.ceil(last / 2);
  checkSize("GCADPCM", data, need, sampleCount);

  const out = new Int16Array(sampleCount);
  let hist1 = 0;
  let hist2 = 0;
  let n = 0;
  for (let frame = 0; frame < frames; frame++) {
    let at = frame * DSP_FRAME_BYTES;
    const header = data[at++]!;
    const scale = 1 << (header & 0xf);
    const predictor = header >> 4;
    if (predictor > 7) {
      throw new CorruptError(
        `GCADPCM frame ${frame} at offset ${at - 1}: predictor ${predictor} > 7`,
      );
    }
    const coef1 = coefficients[predictor * 2]!;
    const coef2 = coefficients[predictor * 2 + 1]!;
    const todo = Math.min(DSP_FRAME_SAMPLES, sampleCount - n);
    for (let s = 0; s < todo; s++) {
      const byte = data[at]!;
      const nibble = s % 2 === 0 ? signedNibble(byte >> 4) : signedNibble(byte & 0xf);
      if (s % 2 === 1) at++;
      // `>>` takes the sum to int32 first, as C#'s unchecked int arithmetic does.
      const sum = ((nibble * scale) << 11) + 1024 + coef1 * hist1 + coef2 * hist2;
      const value = clamp16(sum >> 11);
      hist2 = hist1;
      hist1 = value;
      out[n++] = value;
    }
  }
  return out;
}

/** IMA ADPCM step sizes. */
const IMA_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/** IMA ADPCM step index change per nibble. */
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** Bytes of one channel's IMAADPCM frame, and the frames it decodes to. */
const IMA_FRAME_BYTES = 0x24;
const IMA_FRAME_SAMPLES = 0x40;

/**
 * Decode a mono or stereo IMAADPCM sample (FSB's Xbox IMA layout). A frame is
 * 0x24 bytes per channel: first each channel's 4-byte header (`Int16` first
 * sample, `UInt8` step index, a spare byte), then 4-byte groups of 8 nibbles,
 * low nibble first, one group per channel in turn. A frame decodes to 64
 * samples per channel: the header's, then 63 nibbles (the 64th is unused).
 *
 * @throws {UnsupportedError} for more than two channels, which Fmod5Sharp does
 *   not decode either
 * @throws {CorruptError} when the data holds fewer frames than `sampleCount`
 *   needs
 */
export function decodeImaAdpcm(sample: Fsb5Sample): Int16Array {
  const { data, sampleCount, channels } = sample;
  if (channels > 2) {
    const hint = "only mono and stereo are decoded";
    throw new UnsupportedError("IMAADPCM channel count", channels, hint);
  }
  const frameBytes = IMA_FRAME_BYTES * channels;
  const frames = Math.ceil(sampleCount / IMA_FRAME_SAMPLES);
  checkSize("IMAADPCM", data, frames * frameBytes, sampleCount);

  const out = new Int16Array(sampleCount * channels);
  for (let ch = 0; ch < channels; ch++) {
    for (let frame = 0; frame < frames; frame++) {
      const base = frame * frameBytes;
      const first = frame * IMA_FRAME_SAMPLES;
      const todo = Math.min(IMA_FRAME_SAMPLES, sampleCount - first);
      const head = base + 4 * ch;
      let hist = ((data[head]! | (data[head + 1]! << 8)) << 16) >> 16;
      let index = Math.min(data[head + 2]!, 88);
      out[first * channels + ch] = hist;
      for (let s = 1; s < todo; s++) {
        const k = s - 1;
        const at = base + 4 * channels + 4 * ch + 4 * channels * (k >> 3) + ((k & 7) >> 1);
        const nibble = (data[at]! >> ((k & 1) * 4)) & 0xf;
        const step = IMA_STEPS[index]!;
        let delta = step >> 3;
        if (nibble & 1) delta += step >> 2;
        if (nibble & 2) delta += step >> 1;
        if (nibble & 4) delta += step;
        if (nibble & 8) delta = -delta;
        // Saturated, not wrapped, to 16 bits.
        hist = clamp16(hist + delta);
        index = Math.min(Math.max(index + IMA_INDEX[nibble]!, 0), 88);
        out[(first + s) * channels + ch] = hist;
      }
    }
  }
  return out;
}

/** FADPCM coefficient pairs; an index above 7 repeats them (index % 7). */
const FADPCM_COEFS = [
  [0, 0],
  [60, 0],
  [122, 60],
  [115, 52],
  [98, 55],
  [0, 0],
  [0, 0],
  [0, 0],
];

/** Bytes of one FADPCM frame (one channel), and the samples it decodes to. */
const FADPCM_FRAME_BYTES = 0x8c;
const FADPCM_FRAME_SAMPLES = (FADPCM_FRAME_BYTES - 0x0c) * 2;

/**
 * Decode an FADPCM sample (FMOD's own ADPCM). Frames of 0x8C bytes take turns
 * between the channels. A frame starts with 8 coefficient indices and 8 shifts
 * (one nibble each, as two `UInt32`s) and the history (`Int16` hist1, hist2),
 * then 8 groups of 32 nibbles, each group with its own coefficients and shift,
 * read as `UInt32`s, low nibble first: 256 samples.
 *
 * @throws {CorruptError} when the data holds fewer frames than `sampleCount`
 *   needs for every channel
 */
export function decodeFadpcm(sample: Fsb5Sample): Int16Array {
  const { data, sampleCount, channels } = sample;
  const framesPerChannel = Math.ceil(sampleCount / FADPCM_FRAME_SAMPLES);
  checkSize("FADPCM", data, framesPerChannel * channels * FADPCM_FRAME_BYTES, sampleCount);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Int16Array(sampleCount * channels);
  for (let frame = 0; frame < framesPerChannel * channels; frame++) {
    const ch = frame % channels;
    const first = Math.floor(frame / channels) * FADPCM_FRAME_SAMPLES;
    const base = frame * FADPCM_FRAME_BYTES;
    const coefLookup = view.getUint32(base, true);
    const shiftLookup = view.getUint32(base + 4, true);
    let hist1 = view.getInt16(base + 8, true);
    let hist2 = view.getInt16(base + 10, true);
    for (let group = 0; group < 8; group++) {
      const [coef1, coef2] = FADPCM_COEFS[((coefLookup >>> (group * 4)) & 0xf) % 7]!;
      const shift = 22 - ((shiftLookup >>> (group * 4)) & 0xf);
      for (let word = 0; word < 4; word++) {
        const nibbles = view.getUint32(base + 0x0c + 0x10 * group + 4 * word, true);
        for (let k = 0; k < 8; k++) {
          const n = first + group * 32 + word * 8 + k;
          // Sign-extend the nibble from the top of an int32, then scale it.
          const scaled = (((nibbles >>> (k * 4)) & 0xf) << 28) >> shift;
          const value = clamp16((scaled - hist2 * coef2! + hist1 * coef1!) >> 6);
          if (n < sampleCount) out[n * channels + ch] = value;
          hist2 = hist1;
          hist1 = value;
        }
      }
    }
  }
  return out;
}

/** Refuse data shorter than the frames `sampleCount` needs. */
function checkSize(codec: string, data: Uint8Array, need: number, sampleCount: number): void {
  if (data.length < need) {
    throw new CorruptError(
      `${codec} sample of ${sampleCount} frames needs ${need} bytes of data but has ${data.length}`,
    );
  }
}

/** A 4-bit two's complement value. */
function signedNibble(nibble: number): number {
  return nibble >= 8 ? nibble - 16 : nibble;
}

/** Saturate to a signed 16-bit sample. */
function clamp16(value: number): number {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : value;
}
