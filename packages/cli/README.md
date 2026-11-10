# unity-asset-reader-cli

Look inside Unity AssetBundles from your terminal, and pull their assets out as ordinary files:
PNG images, WAV audio, OBJ or glTF models, text. No code to write, and no Unity, .NET or native
tool to install.

```bash
npx unity-asset-reader-cli ls ui.bundle
npx unity-asset-reader-cli extract ui.bundle -o out/
```

It is a thin front end over the
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md)
packages, which do the reading and converting. Use those directly when you want the assets in
your own program instead.

## Install

Run it once through `npx`, as above, or install it:

```bash
npm install --global unity-asset-reader-cli
unity-asset-reader-cli --help
```

It needs Node.js 20.19 or later. The command is `unity-asset-reader-cli`, not
`unity-asset-reader`: that name is the parser library, which has no command.

## What it reads

Every command takes **one file or one directory**:

- a file: an AssetBundle, a `.assets` file, a WebGL `.data` file. Its `.resS` and `.resource`
  sidecars, and for a `.assets` file the files it depends on, are loaded from the same directory.
- a directory: every file below it, loaded together. Pointers from one bundle into another and
  the bundles' resource files resolve.

To read several bundles together, put them in one directory and pass the directory. Several
paths and glob patterns are refused. The loading is
[`loadPath()`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/node/README.md)'s.

## Commands

### `ls`: list the objects

```bash
npx unity-asset-reader-cli ls ui.bundle
```

```text
Type         Name     Path                                 PathID                Size  File
Texture2D    checker  assets/fixtures/texture/checker.png  -2731902148048136883  204   CAB-f04fab77212e693fb63bdad7458f66fe
AssetBundle  texture                                       1                     148   CAB-f04fab77212e693fb63bdad7458f66fe
```

One row per object: its class, its name, the path it had in the Unity project (from the bundle's
container, empty when it has none), its path id, its size in bytes and the file holding it.

- `--type Texture2D,Sprite` lists only those classes.
- `--json` prints a JSON array of `{ type, name, path, pathId, size, file }` objects instead,
  with the path id as a decimal string.

### `info`: what is in it

```bash
npx unity-asset-reader-cli info ui.bundle
```

Prints:

- each input file's container (`UnityFS`, `UnityWeb`, ...), format version and Unity version, and
  for a `UnityWeb` or `UnityRaw` file from before format 6 its compression (`LZMA` or
  `uncompressed`);
- each file unpacked from it, with the Unity version, platform and object count of the serialized
  ones;
- the Unity versions and platforms found;
- the number of objects of each class.

### `extract`: write the assets as files

```bash
npx unity-asset-reader-cli extract ui.bundle -o out/
npx unity-asset-reader-cli extract ui.bundle -o out/ --type Texture2D,AudioClip
```

Writes each asset to `out/<class>/<name>.<ext>`, and prints each file it wrote.

| Class | File | Written by |
|---|---|---|
| `Texture2D`, `Sprite` (and the sprites of a Unity 6000.6 `SpriteAtlas`) | `.png` | `decodeImage()` and `encodePng()` of `unity-asset-reader-texture` |
| `TextAsset` | `.txt` when its bytes are UTF-8 text, `.bytes` otherwise; the bytes as stored | `unity-asset-reader` |
| `AudioClip` | `.wav`; `.ogg` for Vorbis, with `--vorbis-headers` | `fsb5ToWav()`, `fsb5ToOgg()` of `unity-asset-reader-audio` |
| `Mesh` | `.obj`, or `.glb` with `--mesh glb` | `meshToObj()`, `meshToGltf()` of `unity-asset-reader-mesh` |
| `Shader` | `.txt` | `shaderToText()` of `unity-asset-reader-shader` |
| any other class named with `--type` | `.json` | the object's type tree, as `dump` prints it |

- Without `--type`, it writes the six classes with a converter: `Texture2D`, `Sprite`,
  `TextAsset`, `AudioClip`, `Mesh` and `Shader`.
- `--type MonoBehaviour` (or any class) writes those objects as JSON. That needs the bundle's
  type trees: a bundle built with `DisableWriteTypeTree` has none.
- Two assets with the same name get the path id added to the second one: `logo.png`,
  `logo_-2731902148048136883.png`. Characters a file name cannot hold become `_`.

**When an asset fails**, for example a Direct3D shader or an MPEG clip, which the packages do not
convert, `extract` says so on standard error and goes on with the next one. It exits with status 1
at the end, so a script or a CI job notices:

```text
failed: Shader "UAR/ShaderFixture" (CAB-1dc8d26be8722a766953ce9d8a444e8c, path id 7231929552649350263): unsupported shader program type: DX11VertexSM40 (...)
extract: 11 written, 1 skipped, 1 failed (out/)
```

An asset it cannot write by design is **skipped** instead, which does not change the exit status:
a Vorbis clip without `--vorbis-headers`, and an empty texture (a dynamic font's, 0 x 0 pixels).

#### Vorbis audio: `--vorbis-headers`

FMOD leaves each Vorbis clip's setup header out of the bank, and none ships with these packages.
Pass a JSON file that maps each header's CRC-32, in decimal, to the header:

```text
{ "<CRC-32>": { "headerBytes": "<the header, base64>", "seekBit": <bit offset of its mode list> } }
```

That is the shape of Fmod5Sharp's `vorbis_headers_converted.json`, which you obtain yourself; see
[Vorbis to Ogg](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/audio/README.md)
in the audio package. A clip whose CRC is not in the file fails.

### `dump`: one object as JSON

```bash
npx unity-asset-reader-cli dump ui.bundle --path-id -2731902148048136883
```

Prints the object's fields as its type tree describes them (`readTypeTree()`), as JSON:

- 64-bit integers are decimal strings;
- byte arrays are hex strings;
- `NaN` and infinities are `null`, as `JSON.stringify` writes them.

A directory of several bundles can hold the same path id more than once (each bundle's
`AssetBundle` object is path id 1). Then name the file with `--file`, as `ls` shows it:
`--file CAB-f04fab77212e693fb63bdad7458f66fe`.

## Exit status

| Status | When |
|---|---|
| 0 | Done. Skipped assets do not count as failures. |
| 1 | The input could not be read, or an asset failed. |
| 2 | The command line is wrong: an unknown command or option, a missing `-o` or `--path-id`, several inputs. |

Messages go to standard error; results (the table, JSON, the files written) to standard output.

## License

MIT. The reading and converting is done by the `unity-asset-reader` packages, which carry their
own notices; see the
[project README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).
