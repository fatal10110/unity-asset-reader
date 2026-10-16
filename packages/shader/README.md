# unity-asset-reader-shader

Shader inspection text for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
`shaderToText()` turns a Unity `Shader` into the text
[AssetStudio](https://github.com/Razviar/assetstudio) exports for it, byte for byte: the ShaderLab
as Unity parsed it, with each pass's compiled programs in it. OpenGL and Metal programs are their
stored source; Vulkan programs are SPIR-V disassembly. Pure TypeScript and synchronous: it runs
anywhere `unity-asset-reader` does, browsers, Workers, Node.js.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-shader
```

`unity-asset-reader` is a peer dependency (`^1.2.0`, the first core with a `Shader` reader), so
your app has exactly one copy of the parser.

## Usage

```js
import { load } from "unity-asset-reader";
import { shaderToText } from "unity-asset-reader-shader";

const env = load(bytes);
for (const asset of env.assets("Shader")) {
  const text = shaderToText(asset.reader.read()); // Shader, as obj.read() reads it
  // The .shader file AssetStudio writes is this text in UTF-8.
  const file = new TextEncoder().encode(text);
}
```

`shaderToText` takes what `obj.read()` gives for a `Shader` (Unity's field names), not
`asset.data`.

## What the text holds

As AssetStudio's `ShaderConverter.Convert()` writes it:

- A banner saying the text is not a valid shader file, then `Shader "<name>" {`, the `Properties`
  block, each `SubShader` with its tags, LOD and passes, `Fallback` and `CustomEditor`.
- Per pass: its name, tags and the render state that differs from ShaderLab's defaults (blend,
  color mask, depth, culling, offset, stencil, fog), then a `Program` block per stage (`vp`, `fp`,
  `gp`, `hp`, `dp`, `rtp`) with a `SubProgram "<platform> [hw_tierNN] "` per variant, its
  keywords, and the program in quotes after a `// hash:` line:
  - OpenGL, OpenGL ES and OpenGL Core (`openGL`, `gles`, `gles3`, `glcore`): the GLSL source.
  - Metal (`metal`): the Metal source.
  - Vulkan (`vulkan`): each stage decoded from SMOL-V and disassembled to SPIR-V assembly, as
    AssetStudio's CSspv disassembler prints it. Where AssetStudio cannot decode or disassemble a
    program, the text has the `// disassembly error <message>` line AssetStudio writes. Unity
    2020.3 stores SMOL-V in a newer format (header version `0x01010000`) than AssetStudio's
    decoder reads, so its Vulkan programs read `// disassembly error Unable to decode SMOL-V
    shader`; those of Unity 2019.4 are disassembled.
  - Console programs: their bytes as UTF-8.
- `UsePass "<name>"` and `GrabPass { "<texture>" }` passes.
- Lines end with `\n`; there is no final newline. Floats are written as .NET writes a `float`
  under the en-US culture (`0.5`, `1E-05`).

## Errors

- `UnsupportedError`:
  - a Direct3D program (DX9, DX10 level 9, DX11): AssetStudio turns them into text with
    Windows' D3DCompiler or HLSLDecompiler, which do not run here;
  - a shader that lists its variants in `m_PlayerSubPrograms` (Unity 2021.3.10, 2022.1.13,
    2022.2 and later, so every Unity 6 build), which AssetStudio's converter does not read:
    the text would have none of its programs;
  - a property of type `Int` (5, Unity 2021.1's `Integer`), on which AssetStudio fails;
  - a platform AssetStudio does not know (NaCl, Flash, PSM, or a number it has no name for).
- `CorruptError` when a platform's part of the blob does not decompress to its size, or a
  program's entry or bytes run past it.
- Anything `obj.read()` throws for the shader, before `shaderToText` is called.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), the same as `unity-asset-reader`,
or any browser `unity-asset-reader` runs in.

## API reference

| Export | What |
|---|---|
| `shaderToText(shader)` | A `Shader` as the inspection text AssetStudio exports. |

Full JSDoc is in the bundled `index.d.ts`.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `shaderToText()` is hand-ported from its `AssetStudio.Utility/ShaderConverter.cs` and
  `SpirVShaderConverter.cs`, and the SMOL-V decoder from its `AssetStudio.Utility/Smolv/`; the
  output is tested against AssetStudio's own `.shader` files.
- [CSspv](https://github.com/Anteru/csspv) (BSD-2-Clause, © 2017 Matthäus G. Chajdas): the SPIR-V
  disassembler is hand-ported from it, as AssetStudio vendors it in `AssetStudio.Utility/CSspv/`.
- [smol-v](https://github.com/aras-p/smol-v) (MIT or public domain, © 2016-2018 Aras Pranckevicius): the
  SMOL-V format AssetStudio's decoder reads.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): the oracle that names the
  inputs of the test goldens.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements),
and a comparison with similar npm packages in [COMPARISON.md](https://github.com/fatal10110/unity-asset-reader/blob/main/COMPARISON.md).

## License

MIT AND BSD-2-Clause: the SPIR-V disassembler, ported from CSspv, is under the BSD 2-Clause
License ([`LICENSE-BSD`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/shader/LICENSE-BSD));
the rest is MIT ([`LICENSE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/shader/LICENSE)).
See [`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/shader/NOTICE).
