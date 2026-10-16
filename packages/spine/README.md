# unity-asset-reader-spine

Spine export for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md).
It finds the [Spine](https://esotericsoftware.com/) skeletons in Unity files, as
[spine-unity](https://esotericsoftware.com/spine-unity) stores them, and groups what each one
needs: the skeleton data (`.json` or `.skel.bytes`), the atlas text (`.atlas.txt`) and the atlas
page textures. Those are the files the Spine runtimes load, so a skeleton can be taken out of a
built game and opened again.

It works anywhere `unity-asset-reader` does, browsers and Node.js alike, and takes no WASM.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-spine
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser. For
the page pixels, add
[`unity-asset-reader-texture`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/texture/README.md).

## Usage

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

## What it finds

spine-unity (3.8 to 4.2) keeps a skeleton in two kinds of ScriptableObject:

- `SkeletonDataAsset`: `skeletonJSON`, a TextAsset holding the skeleton data, and
  `atlasAssets`, its atlases.
- `SpineAtlasAsset`: `atlasFile`, a TextAsset holding the atlas text, and `materials`, whose
  `_MainTex` textures are the atlas pages.

They are recognized by those field names in their type trees, not by their script's class name, so
copies of the classes under other names are found too. Pointers are followed across files:
load a skeleton's dependency bundles together with it when its atlases or textures are there.

A null entry in `atlasAssets` is skipped, as spine-unity does. A skeleton's pages come in the
order of its atlas asset's `materials`; spine-unity matches them to the pages the atlas text
names by texture name.

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

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), for both `import` and
`require`, the same as `unity-asset-reader`; any browser that runs it.

## API reference

- `spineSkeletons(env)` returns every skeleton of an env as a `SpineSkeleton`, in
  `env.assets()` order. Throws `UnsupportedError` for what is listed above,
  `ResourceNotFoundError` when a pointer leads into a file that is not loaded (naming it), and
  `CorruptError` for a null or dangling `skeletonJSON`, `atlasFile`, material or `_MainTex`, or
  one that points at an object of another class.
- `SpineSkeleton`: `name`, the `SkeletonDataAsset`'s `m_Name`; `skeleton`, the skeleton data
  TextAsset (`skeletonJSON`); `atlases`, a `SpineAtlas` per non-null `atlasAssets` entry.
- `SpineAtlas`: `atlas`, the atlas text TextAsset (`atlasFile`); `pages`, the Texture2D assets,
  each material's `_MainTex`.

## License

MIT. See [NOTICE](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/spine/NOTICE):
this package holds no Spine Runtimes code, and is not affiliated with Esoteric Software.
