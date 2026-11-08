# Changelog

This repo publishes its npm packages from `packages/`. Each has its own section below, newest
version first. How to release is in [RELEASING.md](RELEASING.md).

## Versioning policy

- **Every package versions on its own**: `unity-asset-reader`, `unity-asset-reader-texture`,
  `unity-asset-reader-node`, `unity-asset-reader-mesh`, `unity-asset-reader-audio`,
  `unity-asset-reader-spine`, `unity-asset-reader-shader` and `texture2ddecoder-wasm` each have
  their own version, and a package is published only when its version changes. Changing the `version` in a package's
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

### 1.3.0 - Unreleased

- A hand-written reader for the legacy `Animation` component (`readAnimation`), Unity 2019.1 to
  6000.6 (#314), with its `asset.data` shape (`toAnimationFields`, `AnimationFields`). AssetStudio
  reads `m_Animation` and `m_Animations` only; the rest comes from Unity's own type trees:
  `m_WrapMode`, `m_PlayAutomatically`, `m_AnimatePhysics`, `m_CullingType` and, from 2023.1,
  `m_UpdateMode`.
- A hand-written reader for `RectTransform` (`readRectTransform`), Unity 2019.1 to 6000.6 (#315),
  with its `asset.data` shape (`toRectTransformFields`, `RectTransformFields`). AssetStudio reads
  only the `Transform` fields; `m_AnchorMin`, `m_AnchorMax`, `m_AnchoredPosition`, `m_SizeDelta`
  and `m_Pivot` come from Unity's own type trees.
  **Behavior change:** `RectTransform` was `"Other"` in `env.assets()`, with `asset.data` and
  `obj.read()` the type tree's result. Now `asset.type` is `"RectTransform"` and `asset.data`
  its friendly shape; `obj.read()` gives the same object as before for a file with type trees,
  and now also reads one without (it threw `UnsupportedError`). It throws `UnsupportedError` for
  a Unity version before 2019.1 (use `readTypeTree()`) and for an editor file.
- `GltfWriter`: a sync, dependency-free writer of binary glTF 2.0 files (`.glb`), moved from
  `unity-asset-reader-mesh` and extended (#317). It writes accessors, meshes, nodes with
  translation, rotation and scale, skins (joints, inverse bind matrices, `JOINTS_0` /
  `WEIGHTS_0`), morph targets (`POSITION`, `NORMAL`, `TANGENT` deltas, default weights) and
  animations (`LINEAR`, `STEP` and `CUBICSPLINE` samplers), checks the references and the
  spec's counting rules (`UnsupportedError`), and knows nothing about Unity. Types:
  `GltfAccessor`, `GltfAccessorType`, `GltfComponentArray`, `GltfMesh`, `GltfPrimitive`,
  `GltfNode`, `GltfSkin`, `GltfAnimation`, `GltfAnimationChannel`, `GltfAnimationSampler`.
- `asset.name` of a GameObject in a bundle built without type trees is its `m_Name`, read
  from the GameObject header (components, layer, name) as upstream reads it (#308). It was
  `""`, and stays `""` for a GameObject the GameObject reader refuses (before Unity 2019.1, an
  unknown version it cannot fit, an editor file).
- `readTypeTree()` reads a childless `EntityId` node (Unity 6000.2 and later) by its
  `byteSize`: an `Int32` (`number`) when it is 4 bytes (6000.2 to 6000.4), a `UInt64`
  (`bigint`) when it is 8 (6000.5 on), and refuses any other size (`UnsupportedError`, kind
  `"EntityId size"`) (#307). It read as `{}` of 0 bytes, as UnityPy reads it, so a non-empty
  `vector<EntityId>` failed the end-of-object check. `readAnimatorController()` reads a
  controller's `m_EntityIdValues` the same way instead of refusing a non-empty one (kind
  `"EntityId values"` is gone), and `m_EntityIdValues` / `entityIdValues` are typed
  `number[] | bigint[]`.
- A hand-written `AnimationClip` reader (`readAnimationClip`), Unity 2019.1 to 6000.6 (#302),
  with its `asset.data` shape (`toAnimationClipFields`, `AnimationClipFields`). It returns the
  curves raw: a legacy clip's curve arrays, a Mecanim clip's streamed words, dense samples and
  constants, its bindings and its events; it decodes no curve. Beyond AssetStudio it reads
  what Unity's own type trees add: `GenericBinding`'s `isSerializeReferenceCurve` (2022.2) and
  `metaData` (6000.5), and `StreamedClip`'s `curveCount` split into two `UInt16`s with
  `discreteCurveCount` (2022.3.19, 2023.2.8 and 2023.3 on, not 2023.1). New fixtures
  (`animation/`) for 2019.4, 2020.3, 6000.3 and 6000.6.
- `MeshData.indices` adds each submesh's `baseVertex` to its indices, so they point into
  `vertices` as Unity draws them (#257). AssetStudio and UnityPy leave it out; every fixture
  mesh but the new `basevertex` one has a `baseVertex` of 0 and decodes as before. An index the
  offset takes past the vertex count throws `CorruptError`.
- `formatSingle(value)` and `formatSingleInvariant(value)` write a float32 as .NET 8's
  `float.ToString()` does under en-US and invariant culture. They moved here from the mesh and
  shader packages, which both need them (#261).
- `formatSingle` and `formatSingleInvariant` are about ten times faster: most floats are
  settled with doubles, and only the rare float on an end of its interval or halfway between
  two decimals takes the exact search. The output is unchanged, checked against .NET 8 on 2.7
  million floats (#252).
- `resolveOrThrow(env, pptr, from, what, classId?)` follows a pointer that must lead somewhere:
  the object, checked to be of class `classId` when given, or an error naming the field:
  `ResourceNotFoundError` for a file that is not loaded, `CorruptError` for a null or dangling
  pointer or the wrong class. The texture and spine packages had a copy each (#255).
- `obj.read()` of a `Mesh` is checked against editor-built skinned meshes from 2019.4, 2020.3,
  6000.3 and 6000.6, plain and compressed (#285): `skin` against UnityPy's and AssetStudio's
  decoding, `m_Shapes` (two blend shapes) against `readTypeTree()`. For a compressed vertex
  whose fourth weight Unity leaves out, the reader agrees with AssetStudio, `(31 - sum) / 31`;
  UnityPy gets it wrong. No code change.
- Hand-written readers for `Avatar`, `AnimatorController`, `Animator` and
  `AnimatorOverrideController` (`readAvatar`, `readAnimatorController`, `readAnimator`,
  `readAnimatorOverrideController`), Unity 2019.1 to 6000.6 (#303), with their `asset.data`
  shapes (`AvatarFields`, ...). Every field Unity writes, as `readTypeTree()` gives it, checked
  on editor-built bundles from 2019.4, 2020.3, 6000.3 and 6000.6, typed and not, and at every
  layout change from 2019.1 through UnityPy's TPK type trees: past AssetStudio, the avatar's
  `m_HumanDescription`, the controller's behaviours and its 6000.2 and 6000.4 fields, and the
  Animator's fields of 2023.1 with their patch-release backports (2020.3.43, 2021.3.16,
  2022.1.24, 2022.2.9). Curves and muscle values are returned raw, not decoded. The structs
  the animation classes share (`HumanPose`, `ValueArrayConstant`, `OffsetPtr`, ...) are
  exported with `readHumanPose` and `readValueArrayConstant`.
  **Behavior change:** these four classes were `"Other"` in `env.assets()`, with `asset.data`
  and `obj.read()` the type tree's result. Now `asset.type` is their class name and `asset.data`
  their friendly shape; `obj.read()` gives the same object as before for a file with type
  trees, and now also reads one without (it threw `UnsupportedError`). It throws
  `UnsupportedError` for a Unity version before 2019.1 (use `readTypeTree()`), and for a
  6000.2+ controller with entity id parameter defaults, which no Unity version writes.
- Hand-written readers for `GameObject`, `Transform`, `MeshFilter`, `MeshRenderer` and
  `SkinnedMeshRenderer` (`readGameObject`, `readTransform`, `readMeshFilter`,
  `readMeshRenderer`, `readSkinnedMeshRenderer`), Unity 2019.1 to 6000.6 (#305), with their
  `asset.data` shapes (`GameObjectFields`, `TransformFields`, `MeshFilterFields`,
  `MeshRendererFields`, `SkinnedMeshRendererFields`, the shared `RendererFields`). Every field
  Unity writes, as `readTypeTree()` gives it, checked on editor-built bundles from 2019.4,
  2020.3, 6000.3 and 6000.6, typed and not (new `scene/` fixtures, which also hold the clips
  and avatars #304 needs, and the animator fixtures' GameObjects and Transforms), and at every
  layout change from 2019.1 through UnityPy's TPK type trees: past AssetStudio, a
  GameObject's `m_Tag` and `m_IsActive`, a renderer's `m_SortingLayer`, its ray tracing,
  small mesh culling, mesh LOD and mask interaction fields (2023.2 to 6000.3), a
  `MeshRenderer`'s `m_EnlightenVertexStream` (2020.1) and a `SkinnedMeshRenderer`'s
  `m_RootBone`, `m_AABB` and `m_DirtyAABB`.
  **Behavior change:** these five classes were `"Other"` in `env.assets()`, with `asset.data`
  and `obj.read()` the type tree's result. Now `asset.type` is their class name and
  `asset.data` their friendly shape; `obj.read()` gives the same object as before for a file
  with type trees, and now also reads one without (it threw `UnsupportedError`). It throws
  `UnsupportedError` for a Unity version before 2019.1 (use `readTypeTree()`) and for an editor
  file. `RectTransform` stays `"Other"`, and `asset.name` of a `GameObject` in a bundle without
  type trees is still `""`.

### 1.2.0 - 2026-10-29

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
  - `asset.name` is the parsed form's name (`m_ParsedForm.m_Name`, `"UAR/ShaderFixture"`), by
    AssetStudio's `Shader.Name` formula, not the empty `m_Name` (#244); AssetStudio `c37af7d`
    applies it only before Unity 6000, whose shaders it does not parse. It reads the whole shader.
    A shader the reader refuses or cannot fit keeps its `m_Name`, usually `""`.
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

### 1.3.0 - Unreleased

- `decodeSprite`'s new `preferMasterAtlas` option cuts a sprite of a variant `SpriteAtlas` from
  the loaded atlas AssetStudio's loader moves it to, its master atlas, so the result equals
  AssetStudio's `ExportSprite` PNG (#294). Off by default: without it the sprite is cut from its
  own variant atlas, as before. `decodeImage` and `imageInfo` do not take it.

- Sprites follow their texture and atlas pointers with core's `resolveOrThrow`; the errors and
  their messages are unchanged (#255). Needs `unity-asset-reader` 1.3.0.
- Tests only, no code change: every 2019.4 and 6000.3 fixture Sprite is compared with
  AssetStudio's executed `ExportSprite` PNG (#275). Split-alpha sprites (whose alpha texture
  `decodeSprite` merges and AssetStudio ignores) and variant-atlas sprites (which AssetStudio
  moves to their master atlas) are compared through `cutSprite`, the difference recorded as a
  verdict next to the golden.
- Tests only, no code change: `EAC_R_SIGNED` and `EAC_RG_SIGNED` are decoded from editor-built
  fixtures (2019.4, 2020.3, 6000.3, 6000.6), made by an editor script from etc2comp's blocks,
  and compared with UnityPy's RGBA and AssetStudio's `ExportTexture2D` PNG (#288).

### 1.2.0 - 2026-10-29

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

### 1.0.1 - Unreleased

- `meshToGltf` is written with core's new `GltfWriter` instead of the package's own glTF code;
  its output is unchanged byte for byte on every fixture mesh. Needs the next core (1.3.0), and
  the peer range is raised at release (#317).
- `meshToObj` and `meshToGltf` draw a submesh with a `baseVertex` on the vertices it offsets
  its indices to, through core's `MeshData.indices` (#257); a 16-bit mesh that offset takes to
  index 65535 or above is written with 32-bit glTF indices. The OBJ equals AssetStudio's for
  the new fixture meshes with UV0, normals, scientific-notation floats, two submeshes and mesh
  compression (#253).
- Floats are written through core's `formatSingle` instead of the package's own copy; the output
  is unchanged. Needs the next core (1.3.0), and the peer range is raised at release (#261).
- `meshToObj` writes floats about seven times faster through the next core's `formatSingle`
  (a 100k-vertex mesh with UV0 and normals: 0.5 s instead of 3.5 s); the output is unchanged
  (#252).
- The OBJ equals AssetStudio's for skinned fixture meshes with two blend shapes, tangents,
  colours, UV0 and UV1 and 32-bit indices, plain and compressed (#285). No code change.

### 1.0.0 - 2026-10-29

First release. Peer: `unity-asset-reader@^1.2.0`, the first core that decodes `MeshData`.

- `meshToObj(mesh)`: a decoded mesh as Wavefront OBJ text, byte for byte what AssetStudio's
  `ExportMesh` writes, floats written as .NET writes them under en-US. Equal to AssetStudio's OBJ
  for the 12 fixture meshes (#239).
- `meshToGltf(mesh)`: a decoded mesh as a binary glTF 2.0 file (`.glb`): positions, normals,
  tangents, UV0 and colours, a triangle primitive per submesh, 16- or 32-bit indices. Its
  positions, normals and indices are the OBJ's; the Khronos glTF validator accepts it for the 12
  fixture meshes and for meshes built in the tests (#240). An attribute holding values glTF
  forbids is left out for the whole mesh: `NORMAL` with a non-unit normal, `TANGENT` with a
  non-unit tangent, a w other than ±1 or no normals, `COLOR_0` with a component outside 0 to 1.

## unity-asset-reader-audio

### 1.1.0 - Unreleased

- `fsb5ToOgg(bytes, headers)` rebuilds an FSB5 Vorbis sample as an Ogg Vorbis file, as
  Fmod5Sharp's `FmodVorbisRebuilder` does. FMOD leaves the Vorbis setup header out of its banks
  and no table of them ships with the package (they are bytes of FMOD's library): the caller
  passes a `Map` from CRC-32 to `{ headerBytes, seekBit }`, the shape of Fmod5Sharp's
  `vorbis_headers_converted.json`. Without it, or without the sample's CRC, `UnsupportedError`
  names the CRC. `readFsb5()` gives the CRC from the `VORBISDATA` chunk as
  `Fsb5Sample.vorbisCrc`, and `fsb5ToWav()`'s Vorbis refusal points to `fsb5ToOgg()`. Checked
  locally only, with the table: the tone-vorbis clip of the 2019.4.41f2, 2020.3.30f1 and
  6000.3.25f1 bundles decodes (ffmpeg, CRC checks on) to its frame count and within 2 LSB of
  AssetStudio's WAV (#241).

- The IMAADPCM decode is checked against editor-built clips: a mono and a stereo clip of
  2019.4.41f2, 2020.3.30f1 and 6000.3.26f1 bundles convert to AssetStudio's WAV byte for byte
  (#251).
- IMAADPCM of more than two channels converts to WAV instead of throwing `UnsupportedError`,
  in FMOD's layout for it (first samples, then step indices, then 2-byte nibble groups per
  channel in turn), which Fmod5Sharp does not decode. Checked with editor-built clips of
  2019.4.41f2, 2020.3.30f1 and 6000.3.26f1 that reach the FSB5 header paths Unity writes besides
  the plain one: a 37800 Hz clip (frequency chunk), 4-channel (channels chunk) and 5.1 clips,
  PCM16 and IMAADPCM, each converting to AssetStudio's WAV byte for byte (#289).
- The README records that Unity writes `PCM16` for 8-bit, 24-bit, 32-bit integer and 32-bit
  float source WAVs alike (probed on 2019.4.41f2, 2020.3.30f1 and 6000.3.26f1), so `PCM8` and
  `PCM32` stay tested on hand-built banks and `PCM24` and `PCMFLOAT` stay unsupported (#296).

### 1.0.0 - 2026-10-29

First release. Peer: `unity-asset-reader@^1`.

- `fsb5ToWav()` converts an `AudioClip`'s FSB5 sound bank to WAV, as AssetStudio's
  `AudioClipConverter.ConvertToWav()` does, for PCM8, PCM16, PCM32, IMAADPCM (mono, stereo),
  FADPCM and GCADPCM (mono); `readFsb5()` parses the bank (#236). Pure TypeScript, sync,
  browser-safe. The PCM clips of the 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1 fixture bundles
  convert to AssetStudio's WAV byte for byte. Vorbis and the other codecs throw
  `UnsupportedError`.

## unity-asset-reader-spine

### 1.0.1 - Unreleased

- Tests for a split build (atlas asset, Material and page in a second bundle) and for an atlas
  asset of another type; no code change (#254).
- Skeleton data follows its pointers with core's `resolveOrThrow`; the errors and their messages
  are unchanged (#255). Needs `unity-asset-reader` 1.3.0.

### 1.0.0 - 2026-10-29

First release. Peer: `unity-asset-reader@^1`.

- `spineSkeletons(env)`: every Spine skeleton spine-unity (3.8 to 4.2) stores in the env, with
  its skeleton data TextAsset (`skeletonJSON`) and, per atlas (`atlasAssets`), the atlas text
  TextAsset (`atlasFile`) and the page Texture2Ds (each material's `_MainTex`). Found by field
  names through type trees; a skeleton in a file without type trees, an atlas that loads its
  textures on demand (4.1+) and an atlas type without `atlasFile` throw `UnsupportedError` (#238).

## unity-asset-reader-shader

### 1.0.1 - Unreleased

- Floats are written through core's `formatSingle` instead of the package's own copy; the output
  is unchanged. Needs the next core (1.3.0), and the peer range is raised at release (#261).
- Writing floats is faster through the next core's `formatSingle`; the output is unchanged
  (#252).
- Vulkan programs of Unity 2020.3 and later, stored in SMOL-V encoding version 1, are now decoded
  (as aras-p/smol-v decodes them) and disassembled, where the text used to read
  `// disassembly error Unable to decode SMOL-V shader`. The text of such shaders changes;
  Unity 2019.4 text is unchanged (#260).
- Shaders that list their variants in `m_PlayerSubPrograms` (Unity 2021.3.10, 2022.1.13, 2022.2
  and later, so every Unity 6 build) are now written instead of refused with
  `UnsupportedError("shader variant list")`: one `SubProgram` per distinct blob index and
  program type, without `hw_tierNN`, checked against a composite oracle (UnityPy's type tree in
  AssetStudio's converter, plan section 5 revision 2026-11-08a). Older shaders are unchanged
  (#259).
- Tests: the composite oracle now also checks stages with several keyword variants, repeated
  across `m_PlayerSubPrograms` groups, byte for byte, on new Unity 6000.3 and 6000.6 fixture
  bundles (`shader-variants`); the output is unchanged (#283).

### 1.0.0 - 2026-10-29

First release. Peer: `unity-asset-reader@^1.2.0`, the first core with a `Shader` reader.
License: MIT AND BSD-2-Clause (the SPIR-V disassembler is ported from CSspv).

- `shaderToText()` turns a `Shader` into the inspection text AssetStudio's
  `ShaderConverter.Convert()` writes (#242): the ShaderLab with each pass's programs, OpenGL and
  Metal programs as their stored source, Vulkan programs decoded from SMOL-V and disassembled to
  SPIR-V as CSspv prints them. Pure TypeScript, sync, browser-safe. The OpenGL ES, Vulkan and
  Metal shaders of the 2019.4.41f2 and 2020.3.30f1 fixture bundles convert to AssetStudio's
  `.shader` file byte for byte. Direct3D programs, variants listed in `m_PlayerSubPrograms`
  (2021.3.10+, 2022.2+, Unity 6), and `Int` properties throw `UnsupportedError`.

## unity-asset-reader-animation

### 1.0.0 - Unreleased

First release (version 0.0.0 until then: plan revision 2026-11-08c). Peer:
`unity-asset-reader@^1.3.0`, the first core with the `AnimationClip`, `Avatar`, `Animator` and
scene readers.

- `clipCurves(env, clip)` decodes an `AnimationClip` into the curves AssetStudio's `.anim` export
  holds (#304): rotation, euler, position, scale, float and object reference curves, each with
  its path (and attribute and class id) and keyframes (time, value, in and out slope), and the
  clip's events. A Mecanim clip's streamed, dense and constant data is decoded as AssetStudio's
  `AnimationClipConverter` does, its path hashes named from the loaded Avatars, Animators and
  legacy Animation components (#314), through `RectTransform` hierarchies too (#315),
  humanoid curves as muscle attributes; legacy curves are merged as `Convert()` merges them.
  Pure TypeScript, sync, browser-safe, no dependencies. Every fixture clip of Unity 2019.4,
  2020.3 and 6000.3 matches AssetStudio's curves float32 bit for bit. The dense and constant
  curves of a clip with discrete curves (Unity 2022.3.19+, 2023.2.8+, 6000) follow all of the
  streamed ones, where AssetStudio's single `curveCount` would put them past the bindings.
- `sceneToGltf(env, root, { clips })` writes a GameObject's scene as a binary glTF 2.0 file
  (#306), with core's `GltfWriter`: its Transform hierarchy as nodes, each SkinnedMeshRenderer's
  mesh with a skin (joints from `m_Bones`, inverse bind matrices from the bind poses) and its
  blend shapes as morph targets, MeshRenderer meshes, and the clips' curves (`clipCurves()`) as
  `CUBICSPLINE` translation, rotation, scale and weights channels from Unity's Hermite keys
  (stepped keys held, weighted tangents as plain Hermite). Converted to glTF's right-handed space
  as AssetStudio's `ModelConverter` converts it: the nodes and the values at the keys match its
  output float32 bit for bit on the Unity 2019.4, 2020.3 and 6000.3 scene fixtures, the skin and
  morph targets on 2019.4 and 2020.3 (AssetStudio reads no Unity 6000 renderer), and every editor
  up to 6000.6 exports the same file. Humanoid muscle curves and `m_IsActive` are skipped.
- Oracle for the humanoid muscle-to-bone conversion to come (#318, no API change): Unity's own
  `HumanPoseHandler.SetHumanPose` poses for the fixture humanoid, every muscle driven, at each
  clip key and midpoint in all four fixture editors, recorded by
  `scripts/make-humanoid-goldens.py` in `fixtures/humanoid-unity-goldens.json` (plan revision
  2026-11-08e).

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
