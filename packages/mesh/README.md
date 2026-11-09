# unity-asset-reader-mesh

Turns Unity `Mesh` objects, read by
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md),
into 3D model files:

- **`meshToObj()`** writes Wavefront OBJ text, byte for byte what
  [AssetStudio](https://github.com/Razviar/assetstudio)'s exporter writes for the mesh.
- **`meshToGltf()`** writes a binary glTF 2.0 file (`.glb`) that opens in any glTF viewer.

Both are synchronous, and run anywhere `unity-asset-reader` does: browsers, Workers, Node.js.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-mesh
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser. This
package needs `^1.3.0`, the first core with the shared glTF writer and `formatSingle`.

## Quick start

```js
import { load } from "unity-asset-reader";
import { meshToGltf, meshToObj } from "unity-asset-reader-mesh";

const env = load(bytes);
for (const asset of env.assets("Mesh")) {
  const mesh = asset.reader.read(); // MeshData, as obj.read() decodes it
  // The file AssetStudio writes is this text in UTF-8.
  const obj = new TextEncoder().encode(meshToObj(mesh));
  // A .glb file's bytes.
  const glb = meshToGltf(mesh);
}
```

Both functions take what `obj.read()` gives for a `Mesh` (`MeshData`, with Unity's field
names), not `asset.data`.

## Common tasks

### Save every mesh as files in Node.js

Write each mesh as an `.obj` and a `.glb` file next to each other:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { load } from "unity-asset-reader";
import { meshToGltf, meshToObj } from "unity-asset-reader-mesh";

const env = load({ name: "models.bundle", data: readFileSync("models.bundle") });
for (const asset of env.assets("Mesh")) {
  const mesh = asset.reader.read();
  writeFileSync(`${asset.name}.obj`, meshToObj(mesh)); // written as UTF-8
  writeFileSync(`${asset.name}.glb`, meshToGltf(mesh));
}
```

### Choose between OBJ and glTF

| | OBJ (`meshToObj`) | glTF (`meshToGltf`) |
|---|---|---|
| Output | Text (`string`) | Binary `.glb` (`Uint8Array`) |
| Matches AssetStudio | Yes, byte for byte | No upstream: AssetStudio exports models as FBX |
| Positions, UV channel 0, normals | Yes | Yes |
| Tangents, vertex colors | No | Yes, when valid for glTF |
| One part per submesh | `g <name>_<i>` group | One triangle primitive |

See [What the OBJ holds](#what-the-obj-holds) and [What the glTF holds](#what-the-gltf-holds)
for the details.

## API reference

| Export | What |
|---|---|
| `meshToObj(mesh)` | A `MeshData` as Wavefront OBJ text, as AssetStudio exports it. |
| `meshToGltf(mesh)` | A `MeshData` as a binary glTF 2.0 file (`.glb`), as a `Uint8Array`. |

Full JSDoc is in the bundled `index.d.ts`.

## What the OBJ holds

It is written as AssetStudio's `ExportMesh` writes it:

- `g <name>`, then one `v` line per vertex: the position, with x negated.
- One `vt` line per vertex, from UV channel 0, when the mesh has one.
- One `vn` line per vertex (the normal, x negated) when the mesh has normals.
- Per submesh, `g <name>_<i>` and its triangles as `f a/a/a b/b/b c/c/c`: 1-based, with the
  winding reversed. `obj.read()` has already turned strips and quads into triangles.
- Lines end with `\r\n`.

Floats are written as .NET writes a `float` under the en-US culture:

- the shortest digits that read back as the same value;
- `-0` for negative zero;
- scientific notation (`1E-05`, `1.5E+10`) below 0.0001 and from 10^9 on;
- `∞` for infinity.

Every `NaN` in the text becomes `0`, as AssetStudio replaces it (the mesh name included).

## What the glTF holds

AssetStudio exports models as FBX, not glTF, so `meshToGltf()` follows no upstream. Its geometry
is the OBJ's. The file is written with `unity-asset-reader`'s `GltfWriter`.

- One `.glb` file (glTF 2.0, binary): one scene, one node and one mesh, each named after the
  `Mesh`. Its data is in the file's own binary chunk.
- One triangle primitive per submesh, all sharing the vertices. A submesh without triangles has
  no primitive.
- `POSITION`, and when the mesh has them `NORMAL`, `TANGENT`, `TEXCOORD_0` (UV channel 0) and
  `COLOR_0` (RGB or RGBA). All are floats.
- Indices are 16-bit when the `Mesh`'s are, else 32-bit. A 16-bit mesh that uses index 65535
  (glTF's primitive restart value) or above is written 32-bit. A submesh's `baseVertex` can
  lead to that.

### Coordinate conversion

The mesh is converted to glTF's right-handed space the same way the OBJ is:

- Positions, normals and indices are the OBJ's: x negated, each triangle's winding reversed.
- The tangent's x and its handedness (w) are negated too.
- UV v becomes `1 - v`, since a glTF texture's origin is its top left.

### Attributes left out

An attribute that holds values glTF forbids is left out for the whole mesh. That keeps the file
valid, so it opens in any glTF viewer. Normals are never renormalised.

- `NORMAL`, when a normal is not unit length (within 0.00674, the Khronos validator's
  tolerance), a zero normal included.
- `TANGENT`, when a tangent's xyz is not unit length or its w is not exactly 1 or -1.
- `TANGENT`, whenever `NORMAL` is left out or missing: viewers must ignore tangents without
  normals.
- `COLOR_0`, when a component is outside 0 to 1 (HDR colours).

## Errors

`meshToObj()` throws:

- `UnsupportedError` when the mesh has no vertices or no positions (AssetStudio writes no file
  for it), or an attribute holds too few floats for the vertex count.
- `CorruptError` when the submeshes' index counts reach past the decoded triangles.

`meshToGltf()` throws:

- `UnsupportedError` when:
  - the mesh has no vertices, positions or triangles;
  - an attribute holds a number of floats per vertex glTF cannot take (positions and normals 3
    or 4, tangents 4, colours 3 or 4, UVs 2 to 4);
  - a value of any attribute is NaN or infinite, which glTF does not allow.
- `CorruptError` when a submesh's indices are not whole triangles, or one is past the vertex
  count.

Before either function runs, `obj.read()` throws whatever it throws for the mesh.

## Limitations

- **OBJ:** no materials, tangents, colours, other UV channels, bones or blend shapes.
  AssetStudio's OBJ has none of them.
- **glTF:** no materials, other UV channels, bones or blend shapes.
- `GltfWriter` can build nodes, skins, morph targets and animations too, but this package
  writes none of those yet.

## How it is tested

- **OBJ:** the output is tested against AssetStudio's own OBJ files, from meshes built by Unity
  2019.4, 2020.3 and 6000.3. Among them is a skinned mesh with blend shapes, tangents, colours
  and two UV channels.
- **glTF:** nothing upstream writes glTF, so the tests check the file with the Khronos glTF
  validator, and compare its geometry with `meshToObj()`'s.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), the same as `unity-asset-reader`,
or any browser `unity-asset-reader` runs in.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `meshToObj()` is hand-ported from `ExportMesh` in its `AssetStudio.CLI/Exporter.cs`, and its
  output is tested against AssetStudio's own OBJ files, from meshes built by Unity 2019.4, 2020.3
  and 6000.3, a skinned one with blend shapes, tangents, colours and two UV channels among them.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements),
and a comparison with similar npm packages in [COMPARISON.md](https://github.com/fatal10110/unity-asset-reader/blob/main/COMPARISON.md).

## License

MIT. `meshToObj()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/mesh/NOTICE).
