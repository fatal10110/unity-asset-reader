# Changelog

This repo publishes its npm packages from `packages/`. Each has its own section below, newest
version first. How to release is in [RELEASING.md](RELEASING.md).

## Versioning policy

- **Every package versions on its own**: `unity-asset-reader`, `unity-asset-reader-texture`,
  `unity-asset-reader-node` and `texture2ddecoder-wasm` each have their own version, and a package
  is published only when its version changes. Changing the `version` in a package's
  `package.json` on `main` is the release.
- Each follows [semver](https://semver.org/). For the reader packages the public API is what the
  package's `dist/index.d.ts` exports. One exception, a maintainer decision (core 1.1.0, #232):
  an exported type that narrows only for input earlier versions refused, such as a field made
  optional because a newly supported layout lacks it, ships as a minor, with a **Type change**
  note in its entry. A second, also a maintainer decision (core 1.2.0, #235, #237): registering a
  hand-written reader for a class that was read through its type tree (`type: "Other"`) ships as
  a minor, with a **Behavior change** note listing what changes for that class: its `type`, the
  shape of its `data` and `obj.read()`, and every input that now throws.
- Between packages of this repo, ranges say what goes together. A feature package's
  `peerDependency` on `unity-asset-reader` is `^<major>` (for 1.x: `^1`) when any core of that
  major works with it, or `^<major>.<minor>.<patch>` naming the oldest core it works with (for
  example `^1.2.0`); a breaking core release moves the feature packages' peer range with it.
  The texture package's `^` range on `texture2ddecoder-wasm` names the oldest decoder it works
  with. A package is never published before a version its ranges need is on npm.
- Changes that are not on npm yet collect under a `### <next version> - Unreleased` heading in
  the package's section. The release replaces `Unreleased` with the publish date.

## unity-asset-reader

### 1.2.0 - Unreleased

- A hand-written `Mesh` reader, `readMesh`, for Unity 2019.1 to 6000.6 (#235), the supported
  floor (plan revision 2026-10-16): its fields equal `readTypeTree()` on the 12 fixture meshes
  and, through UnityPy's TPK type trees (`fixtures/tpk-trees.json`), on hand-built meshes at
  every layout change from 2019.1. Bundles built without type trees read their meshes too.
  `obj.read()` also decodes the vertices and triangles as AssetStudio does (`MeshData`:
  `vertexCount`, `vertices`, `normals`, `tangents`, `colors`, `uv`, `skin`, `indices`), from
  `m_VertexData`, the `.resS` `m_StreamData` names, or `m_CompressedMesh`.

  **Behavior change** for `Mesh` (in 1.1.0 it was read through its type tree):
  - `asset.type` is `"Mesh"`, not `"Other"`, so `env.assets("Other")` no longer yields meshes.
  - `asset.data` is a `MeshFields` (camelCase names, plus the decoded vertices and triangles),
    not the type tree.
  - `obj.read()` gives `MeshData`: the type tree's fields, with `m_StreamData.offset` a `number`
    (the type tree gives a `bigint` from 2020.1), plus the decoded vertices and triangles.
  - `obj.read()` and `asset.data` now throw where 1.1.0 returned the type tree:
    `UnsupportedError` for a mesh from Unity before 2019.1, a version-stripped file outside
    formats 18 to 21 (so every stripped file from Unity 2020.1 on), an editor file
    (`BuildTarget.NoTarget`), a submesh of lines or points, a vertex format Unity does not
    define, bone weights in an integer format, bone indices in a float one, or more than four
    bones per vertex; `CorruptError` for a layout the reader does not know (bytes left over or
    missing, such as a pre-release build) and for vertex data, indices or packed vectors that
    run past their bytes; `ResourceNotFoundError` for vertex data in a `.resS` that is not
    loaded, or read through a reader not built by `load()`.

  `obj.readTypeTree()` still reads every one of these, a mesh from before 2019.1 included.

- A hand-written `Shader` reader, `readShader`, for Unity 2019.1 to 6000.6 (#237): the parsed
  ShaderLab (`m_ParsedForm`: properties, sub-shaders, passes, render state, keywords, each
  variant's parameters) and the compiled programs of every platform (`compressedBlob`, still
  LZ4-compressed). Its fields equal `readTypeTree()` on the fixture shaders (2019.4.41f2,
  2020.3.30f1, 6000.3.26f1 and 6000.6.4f1, built for DX11, GLES3 and Vulkan, and for Metal by
  2020.3 and 6000.3) and UnityPy's read of a synthetic object of every
  Shader layout of Unity's type trees from 2019.1 (`fixtures/shader-layouts.json`). Bundles built
  without type trees read their shaders too. Unity 2023.1 and later, Unity 6 included, have no
  `m_EditorDataHash` or `m_Platforms` in a pass (#52).

  **Behavior change** for `Shader` (in 1.1.0 it was read through its type tree):
  - `asset.type` is `"Shader"`, not `"Other"`, so `env.assets("Other")` no longer yields shaders.
  - `asset.data` is a `ShaderFields` (camelCase names at every level), not the type tree.
  - `obj.read()` gives `Shader`: the type tree's fields, keys and values as `readTypeTree()` gives
    them.
  - `obj.read()` and `asset.data` now throw where 1.1.0 returned the type tree:
    `UnsupportedError` for a shader from Unity before 2019.1, the supported floor (plan revision
    2026-10-16, §4 M2), a
    version-stripped file outside format 21 (so every stripped file from Unity 2020.1 on), and an
    editor file (`BuildTarget.NoTarget`); `CorruptError` for a layout the reader does not know
    (bytes left over or missing, such as a pre-release build or a 6000.7 alpha).

  `obj.readTypeTree()` still reads every one of these, a shader from before 2019.1 included.

### 1.1.0 - 2026-10-16

- `readSpriteAtlas` reads Unity 6000.6's layout instead of refusing it: no `m_PackedSprites` or
  `m_PackedSpriteNamesToIndex`, and every `m_RenderDataMap` entry holds its sprite as
  `*spriteInstanceData` (`SpriteInstanceData`; `spriteInstanceData` in `SpriteAtlasFields`).
  Tested with `readSprite` on four Unity 6000.6.4f1 fixtures against UnityPy 1.25.4 (#155).
  **Type change (breaks type-checked code that reads these fields unchecked):**
  `SpriteAtlas.m_PackedSprites` / `m_PackedSpriteNamesToIndex` and
  `SpriteAtlasFields.packedSprites` / `packedSpriteNamesToIndex` are optional (absent from
  6000.6); `SpriteAtlasFields.renderDataMap` entries are `SpriteAtlasDataFields`. Released as a
  minor: the data read from atlases before 6000.6 is unchanged, and 6000.6 atlases were refused.

- Read SerializedFile format 23 metadata and generic type-tree dumps, tested against five
  Unity 6000.6.4f1 fixtures. Validate the bounded `mhtt` type-tree blobs and retain support
  for zero-length and disabled trees; format 24 remains unsupported (#223).

- Update repository metadata and documentation links after the GitHub repository rename to
  `fatal10110/unity-asset-reader` (#199).

- `load()` and `open()` accept a `unityVersion` fallback for version-stripped files and files
  below SerializedFile format 7. Recorded versions and usable enclosing-bundle revisions take
  precedence; without the option, unknown versions stay `[0, 0, 0, 0]` (#105).

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`. `require("unity-asset-reader")` needs a
  Node.js that can `require()` an ES module, because the LZMA decoder `lzma1` is published as ES
  modules only; Node.js 18 is end-of-life. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. The core: isomorphic, synchronous, no WASM.

- Containers: UnityFS bundles (LZ4/LZ4HC, LZMA, uncompressed blocks), legacy UnityWeb/UnityRaw,
  `UnityWebData` files, gzip-wrapped inputs, loose SerializedFiles, and `.resS`/`.resource`
  sidecars. `detectFileType()` and `detectContainer()` tell them apart; brotli, zip and
  UnityArchive are detected and refused with `UnsupportedError`.
- `load()` returns an `Env` over every file given: `env.files` lists every unpacked file,
  `env.objects` every object as an `ObjectReader`, `env.resolve()` follows a PPtr across files
  and `env.readResource()` reads a `.resS`/`.resource` range. It takes one input or an array,
  each as bytes or `{ name, data }`.
- High-level API: `open()` fetches URLs or reads `Blob`/`File`/`Response` input, then calls
  `load()`. `env.assets(...types)` yields every object as an `Asset`, plain data with a `type`
  that narrows its lazily read `data`, plus its `name` and container `path`. `env.get(path)` finds
  an asset by container path (#183).
- `asset.data` has TypeScript-style field names for every class with a hardcoded reader:
  camelCase without Unity's `m_` (`Texture2DFields.format`, `.width`, `.mipCount`), with
  `TextAsset`'s `text` and `bytes`, and `MonoBehaviour`'s `script` and `fields`. Each field's
  JSDoc names its Unity field. `obj.read()` keeps Unity's names; `toXFields()` maps its result
  (#184).
- SerializedFile header, metadata, type trees and object table. Fixtures cover Unity 2019.4,
  2020.3 and 6000.3 builds. `readTypeTree()` turns any object with a type tree into a plain JS
  object.
- Hardcoded readers for typetree-stripped files: `Object`, `EditorExtension`, `NamedObject`,
  `AssetBundle` (container map), `TextAsset` (with `textAssetString()` for its text),
  `MonoScript`, `MonoBehaviour` (header), `Material`, `Texture`, `Texture2D` (+ `StreamingInfo`),
  `Sprite`, `SpriteAtlas`, `AudioClip`, `Font`, `VideoClip` and `MovieTexture` (metadata and raw
  bytes out).
- Low-level building blocks: `readBundle()`, `readWebFile()` and `readSerializedFile()` for
  one container or file, `ObjectReader` and `BinaryReader`, the codecs (`decompressLz4()`,
  `lzmaDecompress()`, `gunzip()`, `unzlib()`), and the value tables `ClassID` (with
  `classIdName()`), `TextureFormat`, `BuildTarget`, `SerializedFileFormatVersion`, `NodeFlags` and
  `SpritePackingRotation`.
- 64-bit fields and path IDs are `bigint`. Unsupported input throws `UnsupportedError`, damaged
  input `CorruptError`, a missing sidecar `ResourceNotFoundError`.

## unity-asset-reader-texture

### 1.2.0 - Unreleased

- New `encodePng(image)`: an `RgbaImage` (RGBA8, top row first, as `decodeTexture2D` and
  `decodeSprite` return it; a `decodeImage` result as `{ data: rgba, width, height }`) to a PNG
  file, 8-bit RGBA, filter type 0. Sync, browser-safe and without a dependency: the zlib stream
  holds stored (uncompressed) deflate blocks, so the file is about as large as the pixels. A 0x0
  image, such as a dynamic font's "Font Texture", has no PNG and is refused with `RangeError`, as
  is data that is not `width * height * 4` bytes. Tested on every fixture Texture2D AssetStudio
  exports (88): the PNG's pixels equal AssetStudio c37af7d's PNG export's (#233, #234).

### 1.1.0 - 2026-10-16

- Decode the sprites a Unity 6000.6 `SpriteAtlas` holds itself
  (`SpriteAtlasFields.renderDataMap[i][1].spriteInstanceData`), which 6000.6 bundles have no
  `Sprite` objects for. New `packedSprites(atlas)` lists them as `PackedSprite`s (`[]` before
  6000.6); `imageInfo`, `decodeImage` and `decodeSprite` take one where they take a Sprite, and
  `images` yields them at their atlas' place. They are cut from the atlas entry (flip, split
  alpha and variant resize as for any atlas entry), with `tightMesh` masked by the instance
  data's mesh; a mesh whose indices are not 16-bit is refused with `UnsupportedError` (kind
  `"sprite index format"`). Tested on four Unity 6000.6.4f1 fixtures against UnityPy 1.25.4's
  crop, the fixtures' position-encoding pixels and AssetStudio's masks of the same sprites
  built by 6000.3 (#229). No 6000.6 fixture has an alpha texture: split alpha takes the same
  path as any atlas entry and is tested on a patched entry only. A `Sprite` object that points
  at a 6000.6 atlas, which no fixture has, is still refused with `UnsupportedError` (kind
  `"Unity version"`) (#155, #229).
- `decodeSprite`, `decodeImage` and `images` decode a sprite with an alpha texture (Android ETC1
  split alpha), with the alpha texture's red channel as its alpha, as UnityPy does; such sprites
  were refused. An alpha texture of another size than its texture is refused with
  `UnsupportedError` (kind `"sprite alpha texture size"`). Tested on a 2019.4.41f2 Android
  fixture (#152).
- Decode `R8`, `RG16`, `RG32`, `RGB48` and `RGBA64` to RGBA with AssetStudio's rounded
  16-bit channel conversion, tested on the existing 2019.4 and 6000.6 fixtures (#108).
- Add a caller-owned `decodedTextures` map to `decodeSprite`, `decodeImage` and `images`,
  so sequential sprite decodes reuse their atlas pixels. The demo retains textures for
  its "Decode all images" batch only (#154).
- `decodeSprite` decodes sprites of a variant SpriteAtlas (`downscaleMultiplier` other than 1)
  instead of refusing them with `UnsupportedError("sprite downscale")`: as AssetStudio does, the
  texture (with its alpha texture merged in) is resized by the multiplier with ImageSharp
  2.1.3's bicubic resampling before the sprite is cut, matching AssetStudio's image to the
  byte on the 2019.4 half-scale fixture. `imageInfo` reports such a sprite's resized size. A
  `decodedTextures` map keeps the texture as decoded (#153).
- Update repository metadata and documentation links after the GitHub repository rename to
  `fatal10110/unity-asset-reader` (#199).

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`. In Node.js, `initTexture()` loads
  `texture2ddecoder-wasm`'s ES-module glue code, which Node.js below 20.19 refuses (`Cannot use
  'import.meta' outside a module`), and `require()` needs the same Node.js as
  `unity-asset-reader`. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. Peer: `unity-asset-reader@^1`; depends on `texture2ddecoder-wasm@^1.2.3`.

- `initTexture()` and `decodeTexture2D()`: Texture2D to RGBA, for the plain formats in TypeScript
  and the block and Crunch formats through `texture2ddecoder-wasm`, with platform byte swaps and
  the vertical flip.
- `decodeSprite()`: crops a Sprite out of its texture or atlas, with optional tight-mesh masking.
- `convertPlain()` for the uncompressed formats without the decoder.
- Image API over `env.assets()`: `isImage()` narrows an asset to a Texture2D or Sprite;
  `imageInfo()` describes one without decoding it (size, format name and compression family,
  mips, colour space, filter and wrap modes, platform, whether its data is streamed, and for a
  Sprite its rects, pivot, border, packing, atlas and texture); `decodeImage()` decodes one to
  RGBA with that info, loading the WASM on first use, so `initTexture()` is optional; `images()`
  is an async iterator decoding every image of an env, and with `onError: "skip"` leaves out the
  ones that fail instead of stopping (#185).

## unity-asset-reader-node

### 1.1.0 - 2026-10-16

- `loadPath(file)` loads a loose serialized file's external dependencies from the same
  directory, transitively, with their sidecars and split parts. Missing externals are skipped;
  unreadable files throw Node's error. Metadata is parsed during the call to find externals (#165).

- Update repository metadata and documentation links after the GitHub repository rename to
  `fatal10110/unity-asset-reader` (#199).

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`, the same as `unity-asset-reader`, which
  `require()` needs. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. Peer: `unity-asset-reader@^1`.

- `loadPath(fileOrDir)`: loads a file or a directory tree from disk, merges `.split0..n` parts and
  picks up `.resS`/`.resource` sidecars.

## unity-asset-reader-mesh

Version 0.0.0 on disk until its first release, which the release workflow never publishes
(`scripts/check-release.mjs`).

### 1.0.0 - Unreleased

First release. Peer: `unity-asset-reader@^1.2.0`, the first core that decodes `MeshData`.

- `meshToObj(mesh)`: a decoded mesh as Wavefront OBJ text, byte for byte what AssetStudio's
  `ExportMesh` writes, floats written as .NET writes them under en-US. Equal to AssetStudio's OBJ
  for the 12 fixture meshes (#239).

## unity-asset-reader-audio

Version 0.0.0 on disk until its first release, which the release workflow never publishes
(`scripts/check-release.mjs`).

### 1.0.0 - Unreleased

First release. Peer: `unity-asset-reader@^1`.

- `fsb5ToWav()` converts an `AudioClip`'s FSB5 sound bank to WAV, as AssetStudio's
  `AudioClipConverter.ConvertToWav()` does, for PCM8, PCM16, PCM32, IMAADPCM (mono, stereo),
  FADPCM and GCADPCM (mono); `readFsb5()` parses the bank (#236). Pure TypeScript, sync,
  browser-safe. The PCM clips of the 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1 fixture bundles
  convert to AssetStudio's WAV byte for byte. Vorbis and the other codecs throw
  `UnsupportedError`.

## texture2ddecoder-wasm

### 1.2.6 - 2026-10-16

- Update repository metadata and documentation links after the GitHub repository rename to
  `fatal10110/unity-asset-reader` (#199). The npm package name stays `texture2ddecoder-wasm`.
- README: a table of the decode function per format, a live demo link, and acknowledgements
  (#207, #208, #209).

### 1.2.5 - 2026-09-29

- `initialize()` works in Node.js code that webpack bundles, such as a Next.js route handler built
  with `next build --webpack`. It failed with `TypeError: a is not a function`: webpack's wrapper
  around the `module` built-in has no `createRequire`, so the glue now also looks for it on the
  default export (#202).

### 1.2.4 - 2026-09-28

- Bundlers leave the browser `initialize({ wasmPath })` import alone, so it loads the glue from
  `wasmPath` at run time instead of failing with `Cannot find module ...` (webpack, Turbopack).
  The `browser` field of `package.json` keeps the Node.js glue out of browser bundles; its
  `import("module")` failed the build with `Can't resolve 'module'`. Next.js (Turbopack and
  webpack) bundles the package with no config (#171).
- A root-relative `wasmPath` (`"/wasm"`) is resolved against the page's or the Worker's location
  before the import. The Vite dev server failed to load it (#171).

### 1.2.3 - 2026-09-28

- BC3 (DXT5) colour blocks decode in 4-colour mode, as the S3TC spec requires. Before, blocks with
  `c0 <= c1` came out with index 3 black (#137).
- `initialize()` works inside a Web Worker; it used to throw "Unsupported environment" there
  (#149).
- `build:wasm` uses `emscripten/emsdk:4.0.7` pinned by digest, the toolchain of 1.2.2 (#57).

### 1.2.2 and earlier

See the [GitHub releases](https://github.com/fatal10110/unity-asset-reader/releases).
