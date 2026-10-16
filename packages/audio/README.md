# unity-asset-reader-audio

AudioClip to WAV for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md).
From Unity 5.0 on, an `AudioClip`'s sound is an FMOD sound bank (FSB5). This package reads the
bank and writes a WAV file for the PCM and ADPCM codecs, in TypeScript, synchronously, in
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
| `IMAADPCM` (mono, stereo) | 16-bit, decoded |
| `FADPCM` | 16-bit, decoded |
| `GCADPCM` (mono) | 16-bit, decoded |

Tested on editor-built bundles: the PCM clip of Unity **2019.4.41f2**, **2020.3.30f1** and
**6000.3.25f1** bundles (with and without type trees, and version-stripped) converts to
AssetStudio's WAV byte for byte. The ADPCM codecs are tested on hand-built banks only: no fixture
holds an ADPCM clip yet ([#251](https://github.com/fatal10110/unity-asset-reader/issues/251)).

## Not supported

Each of these throws `UnsupportedError`, naming what it found:

- Vorbis ([#241](https://github.com/fatal10110/unity-asset-reader/issues/241)) and every other codec (MPEG, ATRAC9, XMA, VAG, HEVAG,
  Opus, CELT, XWMA, `PCM24`, `PCMFLOAT`).
- IMAADPCM of more than two channels, GCADPCM of more than one.
- An FSB5 header version above 1; a frequency id above 10 with no frequency chunk.
- Sound that is not an FSB5 bank: an `AudioClip` from before Unity 5.0 holds its file (Ogg,
  MP3, WAV, ...) as it is, in `audioData`.

## Errors

- `UnsupportedError`: the cases above.
- `CorruptError`: the bank is truncated, a sample header or chunk does not fit, a sample's data
  is shorter than its frame count needs, the bank has no sample, or a GCADPCM sample has no
  coefficients or a predictor above 7. The message names the offset or the sizes.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), like `unity-asset-reader`, for
both `import` and `require`. Browsers and Web Workers: ES2020.

## API reference

| Export | What |
|---|---|
| `fsb5ToWav(bytes)` | The first sample of an FSB5 bank (an `AudioClip`'s `audioData`) as a WAV file, a new `Uint8Array`. |
| `readFsb5(bytes)` | Parse an FSB5 bank: `{ version, codec, samples }`. Sample bytes are views into `bytes`. |
| `Fsb5` | What `readFsb5()` returns. |
| `Fsb5Sample` | One sample: `frequency`, `channels`, `sampleCount` (frames), `data`, and `name` and `dspCoefficients` when the bank has them. |
| `Fsb5Codec` | The codec numbers (`Fsb5Codec.PCM16`, `Fsb5Codec.VORBIS`, ...), and their type. |

Full JSDoc is in the bundled `index.d.ts`.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar): the
  WAV it writes (`AudioClipConverter.cs`), and the oracle of the test goldens.
- [Fmod5Sharp](https://github.com/SamboyCoding/Fmod5Sharp) (MIT, © 2021 Sam Byass): the FSB5
  parser and the ADPCM decoders are hand-ported from it.
- [python-fsb5](https://github.com/HearthSim/python-fsb5) (MIT, © 2016 Simon Pinfold): second
  reference for the FSB5 parser.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): names the inputs of the test
  goldens.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

MIT. The FSB5 parser and decoders port parts of Fmod5Sharp and python-fsb5 (MIT), the WAV header
AssetStudio's (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/audio/NOTICE).
