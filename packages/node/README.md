# unity-asset-reader-node

Load Unity files and folders from disk in Node.js. This is the Node.js adapter for
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
it adds `loadPath()`, which reads a Unity file or a whole folder from disk and unpacks it.

`loadPath()` also finds the files that belong together:

- each file's `.resS` / `.resource` **sidecars**, the resource files Unity writes next to a file
  to hold its bulk data (texture pixels, audio);
- a loose serialized file's **external dependencies** from the same folder;
- **split files** (`.split0`, `.split1`, ...), which it merges.

`unity-asset-reader` itself takes bytes (`Uint8Array`) and works anywhere. Use this package only
when the files are on a local disk.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-node
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser.

## Quick start

```js
import { ClassID, classIdName } from "unity-asset-reader";
import { loadPath } from "unity-asset-reader-node";

// A folder: every file below it, recursively.
const env = loadPath("Build/StreamingAssets/bundles");
for (const obj of env.objects) {
  console.log(classIdName(obj.type), obj.pathId);
}

// Or one file, with its externals and sidecars from the same folder
// (here sharedassets0.assets.resS and sharedassets0.resource, when they exist).
const level = loadPath("Game_Data/sharedassets0.assets");
const textures = level.objects.filter((obj) => obj.type === ClassID.Texture2D);
```

`loadPath()` returns the same `Env` as `load()`, so everything in the
[`unity-asset-reader` README](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md)
applies: `env.files`, `env.objects`, `obj.read()`, `env.resolve()`. Add
[`unity-asset-reader-texture`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/texture/README.md)
for pixels.

## What `loadPath()` reads

### A folder

A folder is scanned recursively.

- Every regular file in it is loaded, whatever its name.
- A symbolic link to a file is read. A link to a folder is not followed.
- Sockets, FIFOs and devices are not files, and are left out.
- An empty folder gives an empty `Env`, as `load([])` does.

### A file

A file is loaded with its sidecars from the same folder: `<name>.resS` and `<stem>.resource`. For
`sharedassets0.assets`, those are `sharedassets0.assets.resS` and `sharedassets0.resource`.

A loose serialized file also loads the files its `m_Externals` reference (the other files its
pointers lead into), along with their sidecars and split parts.

- This follows further external references, skipping names already loaded.
- External and sidecar names are matched ignoring case.
- Only neighboring files are considered, never subfolders. Unrelated files are not read.
- Missing externals are skipped, and pointers into them remain `fileNotLoaded`.

### Split files

Unity splits large files for Android into `<name>.split0` ... `<name>.splitN`. `loadPath()`
merges the parts in memory into one input named `<name>`. Nothing is written to disk.

- A path to any one part loads the whole file.
- When the merged `<name>` already sits next to its parts, it is used and the parts are skipped.

### How the files are named

Each file is passed to `load()` under its path relative to the folder you gave (for a file: its
own folder), with `/` as the separator on every platform, for example `bundles/main`. That is the
`path` a loose file gets in `env.files`.

### Two builds in one folder

All the files of one call share one container. If one folder holds two builds that both have,
for example, a `sharedassets0.assets.resS`, the first one (in name order) serves both. Load each
build with its own call to keep them apart.

### Synchronous, like `load()`

`loadPath()` is synchronous, like `load()`: it reads with `readFileSync`.

## Errors

`loadPath()` throws:

- Node.js's own file system error (`ENOENT`, `EACCES`, ...) when the path does not exist, or when
  any file or folder in the scan cannot be read. A dangling symbolic link counts too. The scan
  never skips what it cannot read.
- `Error` when the path is neither a file nor a folder (a socket, a device).
- `CorruptError` when the parts of a split file have a gap. The message names the file and the
  first missing part.
- Anything `load()` or `readSerializedFile()` throws: `UnsupportedError`, `CorruptError`.

Loading a single loose serialized file parses its metadata to find its externals. So invalid
metadata fails during `loadPath()`, rather than on the first access to `env.objects`.

## API reference

| Export | What |
|---|---|
| `loadPath(fileOrDir)` | Read a file with its externals and sidecars, or every file below a folder, and `load()` them. Returns the `Env`. |

Full JSDoc is in the bundled `index.d.ts`.

## Not supported

- Looking up a bundle node's externals on disk. Automatic external lookup applies to loose
  serialized files only. Pass all dependency bundles to `load()`, or pass their folder to
  `loadPath()`.
- Streaming, or reading a large `.resS` in pieces: every file is read into memory whole.
- Browsers. Use `unity-asset-reader`'s `load()` with the bytes of a `File` or `fetch` response.

## How it is tested

The tests build folders in a temporary directory from the committed fixture bundles, which the
Unity editor built: split bundles and sidecars, loose serialized files with their externals,
symbolic links and unreadable files. What `loadPath()` loads is compared with the same files
passed to `load()` in memory, and with the UnityPy goldens of those fixtures.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), for both `import` and
`require`.

- `require()` needs a Node.js that can `require()` an ES module, because `unity-asset-reader`'s
  LZMA dependency is published as ES modules only.
- CI tests on 20.19.0 and 22.12.0.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `loadPath()`'s file handling (split files, sidecar lookup) is hand-ported from its
  `AssetsManager.cs`, `ImportHelper.cs` and `ResourceReader.cs`.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): generates the test goldens.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements),
and a comparison with similar npm packages in [COMPARISON.md](https://github.com/fatal10110/unity-asset-reader/blob/main/COMPARISON.md).

## License

MIT. `loadPath()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/node/NOTICE).
