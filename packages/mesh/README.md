# unity-asset-reader-mesh

Mesh export for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
`meshToObj()` writes a Unity `Mesh` as Wavefront OBJ text, byte for byte what
[AssetStudio](https://github.com/Razviar/assetstudio)'s exporter writes for it, and `meshToGltf()`
as a binary glTF 2.0 file (`.glb`). Synchronous, and it runs anywhere `unity-asset-reader` does:
browsers, Workers, Node.js.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-mesh
```

`unity-asset-reader` is a peer dependency (`^1.2.0`, the first core to decode a mesh's vertices),
so your app has exactly one copy of the parser.

## Usage

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

Both take what `obj.read()` gives for a `Mesh` (`MeshData`, with Unity's field names), not
`asset.data`.

## What the OBJ holds

As AssetStudio's `ExportMesh` writes it:

- `g <name>`, then a `v` line per vertex (position, with x negated), a `vt` line per vertex from
  UV channel 0 when the mesh has one, and a `vn` line per vertex (normal, x negated) when it has
  normals.
- Per submesh, `g <name>_<i>` and its triangles as `f a/a/a b/b/b c/c/c`, 1-based, the winding
  reversed. Strips and quads are already turned into triangles by `obj.read()`.
- Lines end with `\r\n`. Floats are written as .NET writes a `float` under the en-US culture:
  the shortest digits that read back as the same value, `-0` for negative zero, scientific
  notation (`1E-05`, `1.5E+10`) below 0.0001 and from 10^9 on, `∞` for infinity. Every `NaN`
  in the text becomes `0`, as AssetStudio replaces it (the mesh name included).

No materials, tangents, colours, other UV channels, bones or blend shapes: AssetStudio's OBJ has
none of them.

## What the glTF holds

AssetStudio exports models as FBX, not glTF, so `meshToGltf()` follows no upstream; its geometry
is the OBJ's, and the tests check it against `meshToObj()` and the Khronos glTF validator.

- One `.glb` file (glTF 2.0, binary): one scene, one node and one mesh, each named after the
  `Mesh`, its data in the file's own binary chunk.
- A triangle primitive per submesh, sharing the vertices. A submesh without triangles has no
  primitive.
- `POSITION`, and when the mesh has them `NORMAL`, `TANGENT`, `TEXCOORD_0` (UV channel 0) and
  `COLOR_0` (RGB or RGBA), all float.
- Converted to glTF's right-handed space as the OBJ is: positions, normals and indices are the
  OBJ's (x negated, each triangle's winding reversed). The tangent's x and its handedness (w)
  are negated too, and UV v becomes `1 - v`, since a glTF texture's origin is its top left.
- An attribute holding values glTF forbids is left out, for the whole mesh, so the file stays
  valid and opens in any glTF viewer: `NORMAL` when a normal is not unit length (within
  0.00674, the Khronos validator's tolerance; a zero normal included); `TANGENT` when a
  tangent's xyz is not unit length or its w is not exactly 1 or -1, and whenever `NORMAL` is
  left out or missing (viewers must ignore tangents without normals); `COLOR_0` when a
  component is outside 0 to 1 (HDR colours). Normals are never renormalised.
- Indices are 16-bit when the `Mesh`'s are, else 32-bit; a 16-bit mesh that uses index 65535
  (glTF's primitive restart value) or above is written 32-bit. As in the OBJ, they are not
  offset by a submesh's `baseVertex`.

No materials, other UV channels, bones or blend shapes.

## Errors

`meshToObj()`:

- `UnsupportedError` when the mesh has no vertices or no positions (AssetStudio writes no file
  for it), or an attribute holds too few floats for the vertex count.
- `CorruptError` when the submeshes' index counts reach past the decoded triangles.

`meshToGltf()`:

- `UnsupportedError` when the mesh has no vertices, positions or triangles; when an attribute
  holds a number of floats per vertex glTF cannot take (positions and normals 3 or 4, tangents
  4, colours 3 or 4, UVs 2 to 4); or when a value of any attribute is NaN or infinite, which
  glTF does not allow.
- `CorruptError` when a submesh's indices are not whole triangles, or one is past the vertex
  count.

Both: anything `obj.read()` throws for the mesh, before they are called.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), the same as `unity-asset-reader`,
or any browser `unity-asset-reader` runs in.

## API reference

| Export | What |
|---|---|
| `meshToObj(mesh)` | A `MeshData` as Wavefront OBJ text, as AssetStudio exports it. |
| `meshToGltf(mesh)` | A `MeshData` as a binary glTF 2.0 file (`.glb`), as a `Uint8Array`. |

Full JSDoc is in the bundled `index.d.ts`.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `meshToObj()` is hand-ported from `ExportMesh` in its `AssetStudio.CLI/Exporter.cs`, and its
  output is tested against AssetStudio's own OBJ files.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements),
and a comparison with similar npm packages in [COMPARISON.md](https://github.com/fatal10110/unity-asset-reader/blob/main/COMPARISON.md).

## License

MIT. `meshToObj()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/mesh/NOTICE).
