# unity-asset-reader-audio

AudioClip to WAV and Ogg for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md).
From Unity 5.0 on, an `AudioClip`'s sound is an FMOD sound bank (FSB5). This package reads the
bank and writes a WAV file for the PCM and ADPCM codecs, and an Ogg Vorbis file for Vorbis when
you supply its setup header ([Vorbis to Ogg](#vorbis-to-ogg)), in TypeScript, synchronously, in
browsers and Node.js. No WASM, no FMOD.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-audio
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser.

## Usage

```js
import { load } from "unity-asset-reader";
import { fsb5ToWav } from "unity-asset-reader-audio";

const env = load(bytes); // the bundle, with its .resource file inside or passed alongside
for (const clip of env.assets("AudioClip")) {
  const wav = fsb5ToWav(clip.data.audioData); // a Uint8Array holding a .wav file
}
```

In a browser, `new Blob([wav], { type: "audio/wav" })` plays in an `<audio>` element; in Node.js,
write it to a file. `readFsb5()` gives the bank's codec and samples (rate, channels, frame count,
bytes) without converting anything.

## What it converts

The WAV is the one AssetStudio's `AudioClipConverter.ConvertToWav()` writes: the bank's first
sample, a 44-byte header, then the sample frames, interleaved, little-endian.

| FSB5 codec | WAV |
|---|---|
| `PCM16` | 16-bit, the bytes as stored (Unity's PCM compression format) |
| `PCM8`, `PCM32` | 8-bit and 32-bit, the bytes as stored, unconverted, as Fmod5Sharp and python-fsb5 copy them |
| `IMAADPCM` | 16-bit, decoded |
| `FADPCM` | 16-bit, decoded |
| `GCADPCM` (mono) | 16-bit, decoded |

Tested on editor-built bundles (with and without type trees, and version-stripped), which convert
to AssetStudio's WAV byte for byte: the PCM clip of Unity **2019.4.41f2**, **2020.3.30f1** and
**6000.3.25f1** bundles, and a mono and a stereo IMAADPCM clip of **2019.4.41f2**, **2020.3.30f1**
and **6000.3.26f1** bundles. Also on lz4 bundles of the same three editors, the FSB5 header paths
Unity writes for other clips: a 37800 Hz clip (frequency chunk), 4-channel clips (channels chunk)
and 5.1 clips (six channels in the header), PCM16 and IMAADPCM. Unity writes whole IMAADPCM frames
only, so a partial last frame is tested on hand-built banks, as are FADPCM, GCADPCM, `PCM8` and
`PCM32`: Unity writes `PCM16` for 8-bit, 24-bit, 32-bit integer and 32-bit float source WAVs alike
(checked on the same three editors).

## Vorbis to Ogg

Unity's default compression format, Vorbis, is stored by FMOD without the three Vorbis headers.
`fsb5ToOgg(bytes, headers)` rebuilds them, as Fmod5Sharp's `FmodVorbisRebuilder` does, and
returns an Ogg Vorbis file (a `Uint8Array`) of the bank's first sample. Two of the headers are
rebuilt from the sample. The third, the setup header, is one of a fixed set FMOD's encoder uses,
named by a CRC-32 in the sample (`readFsb5(bytes).samples[0].vorbisCrc`). **No table of them
ships with this package**: they are bytes of FMOD's library, which no licence lets us
redistribute. You supply the table, as a `Map` from the CRC to `{ headerBytes, seekBit }`:
`headerBytes` the whole setup header packet, `seekBit` the bit offset of its mode list.

That is the shape of Fmod5Sharp's `Fmod5Sharp/Util/vorbis_headers_converted.json` (CRCs in
decimal, `headerBytes` in base64), which you obtain yourself. In Node.js:

```js
import { readFileSync } from "node:fs";
import { fsb5ToOgg } from "unity-asset-reader-audio";

const json = JSON.parse(readFileSync("vorbis_headers_converted.json", "utf8"));
const headers = new Map(
  Object.entries(json).map(([crc, { headerBytes, seekBit }]) => [
    Number(crc),
    { headerBytes: new Uint8Array(Buffer.from(headerBytes, "base64")), seekBit },
  ]),
);
const ogg = fsb5ToOgg(clip.data.audioData, headers); // a Uint8Array holding a .ogg file
```

The package itself parses no JSON and decodes no base64; in a browser, build the same `Map` with
`Uint8Array.from(atob(headerBytes), (c) => c.charCodeAt(0))`. Without `headers`, or when they
lack the sample's CRC, `fsb5ToOgg()` throws `UnsupportedError` naming the CRC (`0x8D00698D` for
Unity's mono 22050 Hz clips, for example).

The Ogg has an identification header with FMOD's block sizes (256 and 2048), a comment header
with only the vendor string `unity-asset-reader-audio`, the setup header, and the sample's
packets, ending at its frame count. Tested locally only, since the table cannot be in the
repository or CI: the Vorbis clip of the 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1 bundles
decodes (ffmpeg, with CRC checks) to its exact frame count, within 2 LSB of AssetStudio's WAV.

## Not supported

Each of these throws `UnsupportedError`, naming what it found:

- In `fsb5ToWav()`, Vorbis (`fsb5ToOgg()` converts it), and in both, every other codec (MPEG,
  ATRAC9, XMA, VAG, HEVAG, Opus, CELT, XWMA, `PCM24`, `PCMFLOAT`).
- In `fsb5ToOgg()`, a Vorbis sample whose setup header the caller did not supply, or with no
  `VORBISDATA` chunk.
- GCADPCM of more than one channel.
- An FSB5 header version above 1; a frequency id above 10 with no frequency chunk.
- Sound that is not an FSB5 bank: an `AudioClip` from before Unity 5.0 holds its file (Ogg,
  MP3, WAV, ...) as it is, in `audioData`.

## Errors

- `UnsupportedError`: the cases above.
- `CorruptError`: the bank is truncated, a sample header or chunk does not fit, a sample's data
  is shorter than its frame count needs, the bank has no sample, a GCADPCM sample has no
  coefficients or a predictor above 7, a Vorbis packet runs past the sample or names a mode its
  setup header lacks, or a supplied setup header is not one (no type 5 and `"vorbis"`, or no
  mode list at `seekBit`). The message names the offset, the sizes or the CRC.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), like `unity-asset-reader`, for
both `import` and `require`. Browsers and Web Workers: ES2020.

## API reference

| Export | What |
|---|---|
| `fsb5ToWav(bytes)` | The first sample of an FSB5 bank (an `AudioClip`'s `audioData`) as a WAV file, a new `Uint8Array`. |
| `fsb5ToOgg(bytes, headers)` | The first sample of an FSB5 Vorbis bank as an Ogg Vorbis file, a new `Uint8Array`; `headers` maps each setup header CRC-32 to a `VorbisSetupHeader`. |
| `VorbisSetupHeader` | `{ headerBytes, seekBit }`: one setup header the caller supplies to `fsb5ToOgg()`. |
| `readFsb5(bytes)` | Parse an FSB5 bank: `{ version, codec, samples }`. Sample bytes are views into `bytes`. |
| `Fsb5` | What `readFsb5()` returns. |
| `Fsb5Sample` | One sample: `frequency`, `channels`, `sampleCount` (frames), `data`, and `name`, `dspCoefficients` and `vorbisCrc` when the bank has them. |
| `Fsb5Codec` | The codec numbers (`Fsb5Codec.PCM16`, `Fsb5Codec.VORBIS`, ...), and their type. |

Full JSDoc is in the bundled `index.d.ts`.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar): the
  WAV it writes (`AudioClipConverter.cs`), and the oracle of the test goldens.
- [Fmod5Sharp](https://github.com/SamboyCoding/Fmod5Sharp) (MIT, © 2021 Sam Byass): the FSB5
  parser, the ADPCM decoders and the Vorbis to Ogg rebuild are hand-ported from it.
- [python-fsb5](https://github.com/HearthSim/python-fsb5) (MIT, © 2016 Simon Pinfold): second
  reference for the FSB5 parser.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): names the inputs of the test
  goldens.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

MIT. The FSB5 parser, decoders and Vorbis rebuild port parts of Fmod5Sharp and python-fsb5 (MIT),
the WAV header AssetStudio's (MIT); the Ogg page writer follows RFC 3533; see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/audio/NOTICE).
