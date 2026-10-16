# unity-asset-reader-mesh

Mesh export for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
`meshToObj()` writes a Unity `Mesh` as Wavefront OBJ text, byte for byte what
[AssetStudio](https://github.com/Razviar/assetstudio)'s exporter writes for it. Synchronous, and
it runs anywhere `unity-asset-reader` does: browsers, Workers, Node.js.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-mesh
```

`unity-asset-reader` is a peer dependency (`^1.2.0`, the first core to decode a mesh's vertices),
so your app has exactly one copy of the parser.

## Usage

```js
import { load } from "unity-asset-reader";
import { meshToObj } from "unity-asset-reader-mesh";

const env = load(bytes);
for (const asset of env.assets("Mesh")) {
  const obj = meshToObj(asset.reader.read()); // MeshData, as obj.read() decodes it
  // The file AssetStudio writes is this text in UTF-8.
  const file = new TextEncoder().encode(obj);
}
```

`meshToObj` takes what `obj.read()` gives for a `Mesh` (`MeshData`, with Unity's field names),
not `asset.data`.

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

## Errors

- `UnsupportedError` when the mesh has no vertices or no positions (AssetStudio writes no file
  for it), or an attribute holds too few floats for the vertex count.
- `CorruptError` when the submeshes' index counts reach past the decoded triangles.
- Anything `obj.read()` throws for the mesh, before `meshToObj` is called.

## Requirements

Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), the same as `unity-asset-reader`,
or any browser `unity-asset-reader` runs in.

## API reference

| Export | What |
|---|---|
| `meshToObj(mesh)` | A `MeshData` as Wavefront OBJ text, as AssetStudio exports it. |

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
