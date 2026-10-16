// Builds FSB5 sound banks for the tests, field by field from the layout that
// readFsb5's JSDoc documents (Fmod5Sharp's FmodAudioHeader / FmodSampleMetadata
// / FmodSampleChunk). Nothing here calls the code under test; the layout itself
// is checked against Unity's own banks in fsb5.test.ts.

/** One sample header chunk: its type and body. */
export interface ChunkSpec {
  type: number;
  body: Uint8Array;
}

/** One sample of a bank to build. */
export interface SampleSpec {
  /** Frequency id, bits 1-4 of the sample header. Default 5 (22050 Hz). */
  frequencyId?: number;
  /** Channel bits 5-6: 0 mono, 1 stereo, 2 six, 3 eight. Default 0. */
  channelBits?: number;
  sampleCount: number;
  chunks?: ChunkSpec[];
  /** The sample's bytes; padded with zeros to a multiple of 32 in the data section. */
  data: Uint8Array;
}

/** A bank to build. */
export interface BankSpec {
  version?: number;
  codec: number;
  samples: SampleSpec[];
  /** One name per sample, written to a name table when given. */
  names?: string[];
}

/** Little-endian bytes of 32-bit words. */
export function words(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
  return out;
}

/** Big-endian bytes of 16-bit values, as a `DSPCOEFF` chunk stores coefficients. */
export function int16be(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v, false));
  return out;
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Build an FSB5 bank. */
export function bank({ version = 1, codec, samples, names }: BankSpec): Uint8Array {
  const offsets: number[] = [];
  let dataSize = 0;
  for (const sample of samples) {
    offsets.push(dataSize);
    dataSize += Math.ceil(sample.data.length / 32) * 32;
  }

  const sampleHeaders = concat(
    ...samples.map((sample, i) => {
      const chunks = sample.chunks ?? [];
      const unit = offsets[i]! / 32;
      const lo =
        (chunks.length > 0 ? 1 : 0) |
        ((sample.frequencyId ?? 5) << 1) |
        ((sample.channelBits ?? 0) << 5) |
        ((unit & 0x1ffffff) << 7);
      const hi = Math.floor(unit / 2 ** 25) | (sample.sampleCount << 2);
      return concat(
        words(lo, hi),
        ...chunks.map((chunk, k) => {
          const more = k + 1 < chunks.length ? 1 : 0;
          const word = (more | (chunk.body.length << 1) | (chunk.type << 25)) >>> 0;
          return concat(words(word), chunk.body);
        }),
      );
    }),
  );

  let nameTable: Uint8Array = new Uint8Array(0);
  if (names) {
    const encoded = names.map((name) => concat(new TextEncoder().encode(name), new Uint8Array(1)));
    const starts: number[] = [];
    let at = names.length * 4;
    for (const name of encoded) {
      starts.push(at);
      at += name.length;
    }
    nameTable = concat(words(...starts), ...encoded);
  }

  const data = new Uint8Array(dataSize);
  samples.forEach((sample, i) => data.set(sample.data, offsets[i]!));

  const fields = [
    version,
    samples.length,
    sampleHeaders.length,
    nameTable.length,
    dataSize,
    codec,
    0, // 0x1C
    ...(version === 0 ? [0] : []), // version 0's extra field
    0, // flags
    0x11111111, // hash
    0x22222222,
    0x33333333,
    0x44444444,
    0, // unknown
    0,
  ];
  return concat(new TextEncoder().encode("FSB5"), words(...fields), sampleHeaders, nameTable, data);
}

/** Build an FSB5 bank of one sample. */
export function single(codec: number, sample: SampleSpec): Uint8Array {
  return bank({ codec, samples: [sample] });
}
