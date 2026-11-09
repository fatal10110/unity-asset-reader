# texture2ddecoder-wasm

[![npm version](https://img.shields.io/npm/v/texture2ddecoder-wasm.svg)](https://www.npmjs.com/package/texture2ddecoder-wasm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)

Decode compressed GPU textures (BC, ETC, EAC, ASTC, PVRTC, ATC and Crunch) to plain pixels in
JavaScript. It is a WebAssembly build, so it runs in the browser and in Node.js with no native
toolchain. Use it for Unity textures, game assets, or any raw block-compressed data.

```bash
npm install texture2ddecoder-wasm
```

Try it now. Save this as `decode.mjs` and run `node decode.mjs`.

```javascript
import { decode_bc1 } from "texture2ddecoder-wasm";

// One BC1 block representing a solid red 4 x 4 texture; no input file needed.
const data = new Uint8Array([0, 248, 0, 0, 0, 0, 0, 0]);
const decoded = await decode_bc1(data, 4, 4);
if (!decoded) throw new Error("Texture decoding failed");
console.log(decoded.length); // 64 bytes: 4 x 4 pixels x 4 channels
console.log([...decoded.slice(0, 4)]); // [0, 0, 255, 255] — BGRA, not RGBA
```

**Live demo:** [fatal10110.github.io/unity-asset-reader/decoder.html](https://fatal10110.github.io/unity-asset-reader/decoder.html)

For real assets, pass the compressed texture payload with its width, height and format. Browser
setup (where the WASM files live) is in the [Quick Start Guide](QUICK_START.md).

The codecs are the same as in
[Perfare's Texture2DDecoder](https://github.com/Perfare/AssetStudio/tree/master/Texture2DDecoderNative)
(AssetStudio) and cover the formats of
[K0lb3/texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) (Python + native). This
package ships them as WASM, so you can decode in the browser and in Node.js without native
dependencies.

## Features

- **No native dependencies.** Pure WebAssembly, works on any platform.
- **Browser and Node.js.** The same API in both.
- **Many formats.** BC1-7, ETC1/2, PVRTC, ASTC, ATC, EAC and Crunch.
- **TypeScript types** are included.
- **Unity textures.** Decodes the payloads of Unity `Texture2D` assets.
- **Compiled codecs.** Runs the compiled Texture2DDecoder codecs in JavaScript.

## Supported Formats

One function per format family. Each takes the raw block data and the image size and resolves to
BGRA, 4 bytes per pixel, or `null` when the data does not decode. The two Crunch functions
unpack to the block data underneath, which you then pass to that format's decoder.

| Format | Function | Notes |
|---|---|---|
| BC1 (DXT1) | `decode_bc1` | |
| BC3 (DXT5) | `decode_bc3` | Colour always decodes in 4-colour mode, per S3TC ([#137](https://github.com/fatal10110/unity-asset-reader/issues/137)), so on c0 <= c1 blocks it differs from AssetStudio and K0lb3/texture2ddecoder |
| BC4 | `decode_bc4` | One channel |
| BC5 | `decode_bc5` | Two channels |
| BC6H | `decode_bc6` | |
| BC7 | `decode_bc7` | |
| ETC1 | `decode_etc1` | |
| ETC2 RGB | `decode_etc2` | |
| ETC2 RGB A1 | `decode_etc2a1` | 1-bit alpha |
| ETC2 RGBA8 | `decode_etc2a8` | 8-bit alpha |
| EAC R11 | `decode_eacr` | |
| EAC R11 signed | `decode_eacr_signed` | |
| EAC RG11 | `decode_eacrg` | |
| EAC RG11 signed | `decode_eacrg_signed` | |
| PVRTC 2 bpp and 4 bpp | `decode_pvrtc` | `is2bpp` picks the mode |
| ASTC | `decode_astc` | The block size is `blockWidth` x `blockHeight` |
| ATC RGB4 | `decode_atc_rgb4` | |
| ATC RGBA8 | `decode_atc_rgba8` | |
| Crunch | `unpack_crunch` | Unpacks to the block data it wraps |
| Unity Crunch (Unity 2017.3+) | `unpack_unity_crunch` | Unpacks to the block data it wraps |

## Installation

```bash
npm install texture2ddecoder-wasm
```

or

```bash
yarn add texture2ddecoder-wasm
```

- New to this library? The [Quick Start Guide](QUICK_START.md) is the fastest way to get running.
- Need bundler setup? See the [Complete Bundler Guide](BUNDLER_GUIDE.md).

## Usage

Complete working setups for popular frameworks are in the [examples/](examples/) directory.

### Node.js Usage

In Node.js the WASM module loads on first use, so you can call a decode function directly.

```typescript
import { decode_astc } from "texture2ddecoder-wasm";
import * as fs from "fs";

// Load compressed texture data
const data = fs.readFileSync("texture.astc");

// Decode ASTC texture
const width = 512;
const height = 512;
const blockWidth = 4;
const blockHeight = 4;

const decoded = await decode_astc(data, width, height, blockWidth, blockHeight);

if (decoded) {
  // decoded is a Uint8Array containing BGRA pixel data
  // Use with image libraries like sharp, jimp, etc.
  console.log("Decoded successfully!");
}
```

### Browser Usage with Modern Bundlers (Webpack, Vite, etc.)

In a browser the library needs to know where the WASM files are. Call `initialize` once with
`wasmPath`. Use the CDN for a quick start or local files for production.

#### Quick Start - Using CDN (Recommended for Development)

Point `wasmPath` at jsDelivr. There is nothing to copy.

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Load and decode texture
const response = await fetch("texture.bin");
const data = new Uint8Array(await response.arrayBuffer());
const decoded = await decode_bc1(data, 512, 512);
```

Why use it:

- No manual file copying.
- Fastest setup.
- The CDN caches the files globally.
- Good for prototyping and development.

#### Production Setup - Using Local Files

For production, copy the WASM files into your public directory, then point `wasmPath` at them:

```bash
npx texture2ddecoder-copy-wasm public/wasm
```

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with local path
await initialize({ wasmPath: "/wasm" });

const decoded = await decode_bc1(data, 512, 512);
```

Why use it:

- Faster loading (same domain).
- Works offline.
- No external dependencies.

**Framework-specific examples** (the same two calls in each; choose by environment):

**Vite + React:**

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

**Next.js:**

```typescript
// In a 'use client' component
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

**Webpack 5:**

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

### CDN Usage (jsDelivr)

You can use the library from the jsDelivr CDN with no installation and no build step:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Texture Decoder - CDN Example</title>
  </head>
  <body>
    <h1>Decode Textures from CDN</h1>
    <div id="status">Loading...</div>

    <script type="module">
      // Import from jsDelivr CDN
      import {
        initialize,
        decode_bc1,
      } from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/dist/index.mjs";

      // Initialize with CDN path for WASM files
      await initialize({
        wasmPath:
          "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
      });

      document.getElementById("status").textContent = "✓ Ready to decode!";

      // Now you can use any decode function
      // const decoded = await decode_bc1(textureData, width, height);
    </script>
  </body>
</html>
```

Why use it:

- No build setup.
- No `npm install`.
- jsDelivr caches the files globally.
- Good for quick prototypes.

**Production tip:** Pin a specific version (for example `@1.2.6`) instead of `@latest`, so an
update cannot change your behavior.

For a full interactive demo, open [examples/cdn-example.html](examples/cdn-example.html).

### Manual Initialization

All the ways to call `initialize`, from Node.js to a custom `locateFile`:

```typescript
import { initialize, decode_bc3 } from "texture2ddecoder-wasm";

// Node.js - no parameter needed (auto-detects module location)
await initialize();

// Browser - provide path to WASM files
await initialize({ wasmPath: "/wasm" });

// Browser with CDN - provide full CDN URL
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Browser with custom locateFile for advanced use cases
await initialize({
  wasmPath: "/wasm",
  locateFile: (path) => `/custom-path/${path}`,
});

// Now decode functions will use the already-initialized module
const result = await decode_bc3(data, width, height);
```

## API Reference

Every decode function takes `Uint8Array | ArrayBuffer` and returns
`Promise<Uint8Array | null>`. The result holds BGRA pixel data, 4 bytes per pixel.

In Node.js you can pass `Buffer` objects (they extend `Uint8Array`). The `Uint8Array` you get back
works with Buffer operations.

### BC Decoders

#### `decode_bc1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC1 (DXT1) compressed texture to BGRA.

#### `decode_bc3(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC3 (DXT5) compressed texture to BGRA.

#### `decode_bc4(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC4 compressed texture to BGRA.

#### `decode_bc5(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC5 compressed texture to BGRA.

#### `decode_bc6(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC6 compressed texture to BGRA.

#### `decode_bc7(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC7 compressed texture to BGRA.

### ETC Decoders

#### `decode_etc1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC1 compressed texture to BGRA.

#### `decode_etc2(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 compressed texture to BGRA.

#### `decode_etc2a1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 with 1-bit alpha compressed texture to BGRA.

#### `decode_etc2a8(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 with 8-bit alpha compressed texture to BGRA.

### EAC Decoders

#### `decode_eacr(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC R11 compressed texture to BGRA.

#### `decode_eacr_signed(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC R11 signed compressed texture to BGRA.

#### `decode_eacrg(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC RG11 compressed texture to BGRA.

#### `decode_eacrg_signed(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC RG11 signed compressed texture to BGRA.

### Other Format Decoders

#### `decode_pvrtc(data: Uint8Array | ArrayBuffer, width: number, height: number, is2bpp: boolean = false): Promise<Uint8Array | null>`

Decodes PVRTC compressed texture to BGRA.

- `is2bpp`: Set to `true` for 2 bits-per-pixel mode, `false` for 4 bits-per-pixel (default)

#### `decode_astc(data: Uint8Array | ArrayBuffer, width: number, height: number, blockWidth: number, blockHeight: number): Promise<Uint8Array | null>`

Decodes ASTC compressed texture to BGRA.

- `blockWidth`: Block width (typically 4, 5, 6, 8, 10, or 12)
- `blockHeight`: Block height (typically 4, 5, 6, 8, 10, or 12)

#### `decode_atc_rgb4(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ATC RGB4 compressed texture to BGRA.

#### `decode_atc_rgba8(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ATC RGBA8 compressed texture to BGRA.

### Crunch Decoders

#### `unpack_crunch(data: Uint8Array | ArrayBuffer): Promise<Uint8Array | null>`

Unpacks Crunch compressed data.

#### `unpack_unity_crunch(data: Uint8Array | ArrayBuffer): Promise<Uint8Array | null>`

Unpacks Unity Crunch compressed data.

### Initialization

#### `initialize(options?: { wasmPath?: string; locateFile?: (path: string, prefix: string) => string }): Promise<void>`

Loads the WebAssembly module. In Node.js the first decode call does this for you. In a browser,
including a Web Worker, you must call it yourself.

**Parameters:**

- `options.wasmPath` - (Browser and Web Worker required) Path or URL to the directory containing WASM files
- `options.locateFile` - (Optional) Custom function to locate WASM binary files for advanced use cases

**Node.js Example:**

```typescript
await initialize(); // Auto-detects and loads from dist/wasm/
```

**Browser Examples:**

```typescript
// Basic usage - local path
await initialize({ wasmPath: "/wasm" });

// With CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// With custom locateFile for advanced scenarios
await initialize({
  wasmPath: "/wasm",
  locateFile: (path) => `https://cdn.example.com/custom/${path}`,
});
```

**Web Workers:** the same `initialize({ wasmPath })` call works inside a Web Worker (classic or
module), which has no `window`. Decode large textures there to keep the page responsive.

**Framework integration.** This approach works with:

- React / Next.js
- Vue / Nuxt
- Svelte / SvelteKit
- Webpack 5 / Vite / Rollup
- Server-side rendering (SSR): call `initialize()` in client-side code only

## Building from Source

### Prerequisites

- **Node.js** ≥14.0.0
- **Docker** - Required for building the WebAssembly module (no local Emscripten installation needed)

Install Docker from https://www.docker.com/get-started.

### Build Steps

```bash
# Clone the repository
git clone https://github.com/fatal10110/unity-asset-reader.git
cd unity-asset-reader

# Install dependencies
npm install

# Build WebAssembly module (uses Docker + Emscripten)
npm run build:wasm

# Build TypeScript
npm run build:ts

# Or build both at once
npm run build

# Run tests
npm test
```

### Build Scripts

- `npm run build:wasm` - Build the WebAssembly module using Docker and Emscripten
- `npm run build:ts` - Compile TypeScript
- `npm run build` - Build both WASM and TypeScript
- `npm test` - Run tests

### About the Docker Build

The WebAssembly build runs in the official Emscripten SDK Docker image. That gives you:

- No local Emscripten install.
- The same build environment on every platform.
- Automatic compiler toolchain setup.
- Support for Windows, macOS and Linux.

The build script ([scripts/build-wasm.sh](scripts/build-wasm.sh)):

1. Checks if Docker is installed
2. Pulls the pinned Emscripten SDK image (`emscripten/emsdk:4.0.7`)
3. Compiles the C++ texture decoders to WebAssembly
4. Generates optimized WASM and JavaScript glue code

## License & Credits

This project is licensed under MIT.

The decoders are the C++ sources of [K0lb3's texture2ddecoder](https://github.com/K0lb3/texture2ddecoder)
(MIT, © K0lb3), included as a git submodule and compiled to WebAssembly with
[Emscripten](https://github.com/emscripten-core/emscripten) (MIT or University of Illinois/NCSA),
which also generates the JavaScript loader in `wasm/`.

The texture compression codecs were derived from the following sources:

| Codec          | License       | Source                                                                                                                                |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ATC            | MIT           | [Perfare/AssetStudio - Texture2DDecoderNative/atc.cpp](https://github.com/Perfare/AssetStudio/blob/master/Texture2DDecoderNative/atc.cpp) |
| ASTC           | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/astc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/astc.c)   |
| BCn            | MIT           | [Perfare/AssetStudio - Texture2DDecoderNative/bcn.cpp](https://github.com/Perfare/AssetStudio/blob/master/Texture2DDecoderNative/bcn.cpp) |
| ETC            | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/etc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/etc.c)     |
| f16            | MIT           | [Maratyszcza/FP16](https://github.com/Maratyszcza/FP16)                                                                               |
| PVRTC          | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/pvrtc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/pvrtc.c) |
| Crunch         | PUBLIC DOMAIN | [BinomialLLC/crunch](https://github.com/BinomialLLC/crunch)                                                                           |
| Crunch (Unity) | ZLIB          | [Unity-Technologies/crunch](https://github.com/Unity-Technologies/crunch)                                                             |

## Related Projects

- [texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) - the C++ decoders this package compiles, with Python bindings
- [AssetStudio](https://github.com/Perfare/AssetStudio) - Original C++ texture decoders
- [UnityPy](https://github.com/K0lb3/UnityPy) - Unity asset extraction tool
- [unity-asset-reader-texture](https://www.npmjs.com/package/unity-asset-reader-texture) - decodes Unity `Texture2D` and `Sprite` assets with this package; [COMPARISON.md](https://github.com/fatal10110/unity-asset-reader/blob/main/COMPARISON.md) compares it with similar npm packages

## Contributing

Contributions are welcome. Read the [Contributing Guide](https://github.com/fatal10110/unity-asset-reader/blob/main/CONTRIBUTING.md) for the development process, how to propose fixes and improvements, and how to build and test
your changes.

### Quick Start for Contributors

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/unity-asset-reader.git`
3. Initialize submodules: `git submodule update --init --recursive`
4. Install dependencies: `npm install`
5. Build the project: `npm run build`
6. Run tests: `npm test`
7. Create a branch, make your changes, and submit a Pull Request

Details are in [CONTRIBUTING.md](https://github.com/fatal10110/unity-asset-reader/blob/main/CONTRIBUTING.md).

## Platform Support

- **Node.js**: ≥14.0.0
- **Browsers**: Modern browsers with WebAssembly support (Chrome, Firefox, Safari, Edge)
- **Operating Systems**: Windows, macOS, Linux (WebAssembly is platform-independent)

### Browser Compatibility

The package works in modern browsers that support:

- WebAssembly
- ES6 Modules (or use a bundler like Webpack/Vite)
- Typed Arrays (Uint8Array)

Tested and working in:

- Chrome/Edge 57+
- Firefox 52+
- Safari 11+
- Opera 44+

## Examples

For a complete browser example, see [examples/cdn-example.html](examples/cdn-example.html). More
setups (Node.js CommonJS and ESM, Vite, React, Next.js) are in [examples/](examples/).
