# unity-asset-reader-spine

Takes [Spine](https://esotericsoftware.com/) skeletons out of Unity files read by
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md).

It finds each skeleton as [spine-unity](https://esotericsoftware.com/spine-unity) stores it, and
groups the files that skeleton needs:

- the skeleton data (`.json` or `.skel.bytes`),
- the atlas text (`.atlas.txt`),
- the atlas page textures.

Those are the files the Spine runtimes load, so you can take a skeleton out of a built game and
open it again.

It works anywhere `unity-asset-reader` does, browsers and Node.js alike, and takes no WASM.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-spine
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser. For
the page pixels, add
[`unity-asset-reader-texture`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/texture/README.md).

## Quick start

Write every skeleton's files to disk, in Node.js:

```js
import { writeFileSync } from "node:fs";
import { load } from "unity-asset-reader";
import { decodeImage, encodePng } from "unity-asset-reader-texture";
import { spineSkeletons } from "unity-asset-reader-spine";

const env = load(bundleBytes);
for (const { name, skeleton, atlases } of spineSkeletons(env)) {
  console.log(name); // "hero_SkeletonData"
  writeFileSync(`${skeleton.name}.json`, skeleton.data.bytes); // or .skel.bytes: binary export
  for (const { atlas, pages } of atlases) {
    writeFileSync(`${atlas.name}.txt`, atlas.data.bytes); // "hero.atlas" -> hero.atlas.txt
    for (const page of pages) {
      const { rgba, width, height } = await decodeImage(page); // RGBA8, top row first
      // The atlas text names its pages by file name: "hero.png".
      writeFileSync(`${page.name}.png`, encodePng({ data: rgba, width, height }));
    }
  }
}
```

`skeleton`, `atlas` and the `pages` are the env's own assets (`env.assets()`), so everything in
the core README applies to them: `name`, `path`, `data`. A TextAsset's `data.bytes` is the file
as Spine exported it, byte for byte.

## Common tasks

### Load a skeleton split across bundles

Pointers are followed across files. When a skeleton's atlases or textures are in other bundles,
load those bundles together with it:

```js
const env = load([
  { name: "hero.bundle", data: heroBytes },
  { name: "hero_atlas.bundle", data: atlasBytes },
]);
const skeletons = spineSkeletons(env);
```

If a pointer leads into a file that is not loaded, `spineSkeletons` throws
`ResourceNotFoundError`, naming the SerializedFile it needs (usually `CAB-<hash>`, the file
inside the other bundle).

## API reference

- `spineSkeletons(env)` returns every skeleton of an env as a `SpineSkeleton`, in
  `env.assets()` order. It throws:
  - `UnsupportedError` for what [Not supported](#not-supported) lists;
  - `ResourceNotFoundError` when a pointer leads into a file that is not loaded (naming it);
  - `CorruptError` for a null or dangling `skeletonJSON`, `atlasFile`, material or `_MainTex`,
    or one that points at an object of another class.
- `SpineSkeleton`:
  - `name`: the `SkeletonDataAsset`'s `m_Name`;
  - `skeleton`: the skeleton data TextAsset (`skeletonJSON`);
  - `atlases`: a `SpineAtlas` per non-null `atlasAssets` entry.
- `SpineAtlas`:
  - `atlas`: the atlas text TextAsset (`atlasFile`);
  - `pages`: the Texture2D assets, each material's `_MainTex`.

## How skeletons are found

spine-unity (3.8 to 4.2) keeps a skeleton in two kinds of ScriptableObject:

- `SkeletonDataAsset`: `skeletonJSON`, a TextAsset holding the skeleton data, and
  `atlasAssets`, its atlases.
- `SpineAtlasAsset`: `atlasFile`, a TextAsset holding the atlas text, and `materials`, whose
  `_MainTex` textures are the atlas pages.

These objects are recognized by those field names in their type trees, not by their script's
class name, so copies of the classes under other names are found too. (A type tree is the list
of field names and types that Unity can store in a file for each object type.)

- A null entry in `atlasAssets` is skipped, as spine-unity does.
- A skeleton's pages come in the order of its atlas asset's `materials`. spine-unity matches
  them to the pages the atlas text names by texture name.

## Not supported

- **Files built without type trees**, such as bundles built with `DisableWriteTypeTree`: a
  script's fields have no names there. Reading them would take the game's script assemblies,
  which this library does not do. A `SkeletonDataAsset` in such a file throws
  `UnsupportedError`, found through its script's class name; other scripts are skipped.
- **On-demand texture loading** (spine-unity 4.1+, `textureLoadingMode` `OnDemand`): the
  materials hold placeholder textures, and the pages are loaded at run time from elsewhere.
  Such an atlas throws `UnsupportedError`.
- **Other atlas types**, such as `SpineSpriteAtlasAsset` (an atlas made from a Unity
  SpriteAtlas): an `atlasAssets` entry without `atlasFile` and `materials` throws
  `UnsupportedError`.
- The skeleton data and atlas text are returned as stored, not parsed.

## How it is tested

- The test bundles are built with Unity 2019.4.41f2. No spine-unity package is involved: the
  fixture project holds stub scripts of our own that serialize the same fields as spine-unity's
  assets, following spine-unity's 3.8, 4.0, 4.1 and 4.2 layouts.
- The grouping is checked against a table written before the build, in section 19 of
  [`fixtures/BUILDING.md`](https://github.com/fatal10110/unity-asset-reader/blob/main/fixtures/BUILDING.md).
  AssetStudio has no Spine export, so nothing upstream checks the grouping itself.
- The skeleton and atlas TextAsset bytes, and the page pixels, are checked against
  AssetStudio's export of the same bundles.
- The fixtures include a skeleton split across two bundles, and the refused cases above: another
  atlas type, on-demand texture loading, and a skeleton or an atlas asset in a bundle built
  without type trees.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), for both `import` and
`require`, the same as `unity-asset-reader`; any browser that runs it.

## Acknowledgements

- [spine-unity](https://esotericsoftware.com/spine-unity): this package looks objects up by the
  names of the fields spine-unity serializes (`skeletonJSON`, `atlasAssets`, `atlasFile`,
  `materials`, `textureLoadingMode`). It holds no Spine Runtimes code. Spine is a product and
  trademark of Esoteric Software.
- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  the Unity format handling this package relies on is in `unity-asset-reader`, a derivative of
  AssetStudio. AssetStudio's export is also the test oracle for the TextAssets and pages.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

MIT. See [NOTICE](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/spine/NOTICE):
this package holds no Spine Runtimes code, and is not affiliated with Esoteric Software.
