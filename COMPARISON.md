# Unity library comparison

Feature and format checklist based on the package documentation collected for the original
README comparison on **2026-09-29**; the rows for Unity 6000.6, variant atlases, 16-bit formats,
the Unity version override and external dependencies were checked on **2026-10-16**; the
animation and skinned-model rows on **2026-11-09** (`unityfs-js` 0.2.9, `node-asset-studio-mod-js`
0.1.7). This is a documentation snapshot, not a compatibility test.

**✓** = documented support. **✗** = unsupported or not documented in the cited sources.
A ✗ does not prove that an undocumented feature is absent.

The **Our library** column covers this project as one library: `unity-asset-reader`,
`unity-asset-reader-texture`, `unity-asset-reader-node`, `unity-asset-reader-mesh`,
`unity-asset-reader-audio`, `unity-asset-reader-spine`, `unity-asset-reader-shader`,
`unity-asset-reader-animation` and `texture2ddecoder-wasm`.
CLI features include those provided by its required AssetStudioMod application.

## Libraries and sources

| Column | Library | Documentation |
|---|---|---|
| Our library | `unity-asset-reader` | [Core](packages/core/README.md), [textures](packages/texture/README.md), [Node.js](packages/node/README.md), [meshes](packages/mesh/README.md), [audio](packages/audio/README.md), [Spine](packages/spine/README.md), [shaders](packages/shader/README.md), [animation](packages/animation/README.md), [decoder](packages/decoder/README.md) |
| unity-js | `@arkntools/unity-js` | [npm README](https://www.npmjs.com/package/@arkntools/unity-js), [tools README](https://www.npmjs.com/package/@arkntools/unity-js-tools) |
| unityfs-js | `unityfs-js` | [npm README](https://www.npmjs.com/package/unityfs-js) |
| Studio JS | `node-asset-studio-mod-js` | [npm README](https://www.npmjs.com/package/node-asset-studio-mod-js) |
| Studio CLI | `node-asset-studio-mod` | [npm README](https://www.npmjs.com/package/node-asset-studio-mod), [AssetStudioMod](https://github.com/aelurum/AssetStudio) |
| unity-asset | `@tootallnate/unity-asset` | [Changelog](https://github.com/TooTallNate/switch-tools/blob/main/packages/unity-asset/CHANGELOG.md) |
| Studio Web | `@lego-fan9/asset-studio-web` | [npm README](https://www.npmjs.com/package/@lego-fan9/asset-studio-web) |
| decoder.js | `texture2ddecoder.js` | [npm README](https://www.npmjs.com/package/texture2ddecoder.js) |

## Runtime and requirements

| Feature | Our library | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Browser support | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Node.js support | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Synchronous Unity parsing | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Uses WebAssembly | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| Requires .NET | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Requires a browser Buffer polyfill | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Unity parsing uses no WASM; its compressed texture decoder does.

## Containers and compression

| Format | Our library | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| UnityFS | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| UnityWeb | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| UnityRaw | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| WebGL UnityWebData | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Loose SerializedFiles (.assets) | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Resource sidecars (.resS / .resource) | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| LZ4 / LZ4HC bundles | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| LZMA bundles | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Gzip-wrapped input | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| SerializedFile format 23 (Unity 6000.6) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## Asset features

| Feature | Our library | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Read objects through type trees | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Hand-written readers for objects without type trees | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Unity version override for version-stripped files | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Load a loose file's external dependencies from disk | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Read TextAsset | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Read MonoBehaviour data through type trees | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Decode Texture2D | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Extract Sprite images | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Merge separate sprite alpha textures | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Extract sprites of a variant (scaled) SpriteAtlas | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Extract sprites packed in a Unity 6000.6 SpriteAtlas | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Encode PNG images | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Decode audio to WAV / OGG / MP3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Export meshes or models | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Export skinned models (bones and skin weights) | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Read AnimationClip curves as data | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Export models with their animation clips | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Convert humanoid (muscle) clips to bone rotations | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Export Live2D | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Export Spine | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Export shader inspection text | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit assets and repack bundles | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Decode raw compressed texture blocks | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

Our library converts PCM and ADPCM clips to WAV, and Vorbis clips to Ogg when the caller supplies
the Vorbis setup header table, of which none ships (`unity-asset-reader-audio`); it converts no
other codec. It exposes raw video and font bytes and does not decode video.
Our library exports a Mesh as Wavefront OBJ through `unity-asset-reader-mesh`'s `meshToObj()`,
byte for byte AssetStudio's OBJ for every fixture mesh, and as binary glTF 2.0 (`.glb`) through
`meshToGltf()`; it writes no FBX.
Our library's skinned and animated models come from `unity-asset-reader-animation`'s
`sceneToGltf()`: a GameObject's hierarchy, skinned meshes and blend shapes with its clips, as
glTF 2.0. Its `clipCurves()` returns a clip's decoded keyframes (streamed, dense and constant),
paths and events as data; it writes no `.anim` YAML. Humanoid clips become bone rotations, checked
against the Unity editor; their body position (`RootT`), finger muscles and root motion are not
converted. Studio JS and Studio CLI export animated models as FBX (Studio JS's `fbxAnimation`,
the CLI's `--fbx-animation`); Studio JS lists humanoid muscle retargeting as unsupported, and
AssetStudioMod does not document it. unityfs-js exports a `SkinnedMeshRenderer` as a `.glb`
skeleton model and names no animation clip.
Exporting Spine means grouping each spine-unity skeleton's data, atlas text and page textures
(`unity-asset-reader-spine`), from files built with type trees.
Our library writes a Shader as AssetStudio's inspection text through `unity-asset-reader-shader`'s
`shaderToText()`: OpenGL and Metal source and SPIR-V disassembly, byte for byte AssetStudio's
`.shader` file for the fixture shaders. It also writes the variant lists of Unity 2021.3.10+ /
2022.2+ / 6000 builds (`m_PlayerSubPrograms`), which AssetStudio's converter does not read, and
disassembles Unity 2020.3's newer SMOL-V encoding. It refuses Direct3D programs, which need
Windows' D3DCompiler.
AssetStudioMod documents Unity 1.7 to 6000.2; none of the others names Unity 6000.6. Loading
external dependencies means a loose SerializedFile's `m_Externals`, through
`unity-asset-reader-node`'s `loadPath()`; `.resS` / `.resource` sidecars are a separate row
under containers. The Studio JS version override is documented in its `COMPATIBILITY.md`, the
Studio CLI one in AssetStudioMod's CLI README (`--unity-version`).

## Texture formats

These rows compare documented decoding support, including decoders used internally.
Studio JS inherits the formats documented by unityfs-js.

| Format | Our library | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BC1 / DXT1 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC2 / DXT3 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC3 / DXT5 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC4 / BC5 | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC6H | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC7 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ETC1 / ETC2 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| EAC | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| PVRTC | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ASTC | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ATC | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Crunch | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| 16-bit unsigned (R16, RG32, RGB48, RGBA64) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

For our library's exact formats, platform restrictions and tested Unity versions, see the
[texture README](packages/texture/README.md) and [core README](packages/core/README.md).

## Licenses

Our packages and the other listed libraries declare MIT, except `@arkntools/unity-js`
(AGPL-3.0) and our texture package (MIT AND Apache-2.0).
See each package's license and notices for its included components.
This repository does not copy, import or test against `@arkntools/unity-js`;
its comparison entries use only package metadata and documentation.
