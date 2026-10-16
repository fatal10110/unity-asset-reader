// Ported from AssetStudio.CLI/Exporter.cs (MIT, © Perfare / RazTools / Razviar)

import {
  CorruptError,
  GfxPrimitiveType,
  UnsupportedError,
  type MeshData,
} from "unity-asset-reader";

import { formatSingle } from "./float.js";

/**
 * Upstream writes each line with `AppendLine` or an explicit `\r\n`; on
 * Windows, where AssetStudio runs, `AppendLine` ends lines with `\r\n` too.
 */
const EOL = "\r\n";

/**
 * Write a decoded mesh as Wavefront OBJ text, byte for byte what AssetStudio's
 * `ExportMesh` writes: a `g <name>` group, `v` positions with x negated, `vt`
 * from UV channel 0 (u, v), `vn` normals with x negated, then per submesh a
 * `g <name>_<i>` group of `f i/i/i j/j/j k/k/k` faces, 1-based, with the
 * winding reversed. Lines end with `\r\n`; floats are written as .NET writes
 * them under en-US (shortest round trip, `-0` for negative zero), and every
 * `NaN` in the text, the name included, becomes `0`.
 *
 * Encode the text as UTF-8 (`TextEncoder`) for the file AssetStudio writes.
 *
 * @param mesh a Mesh as `obj.read()` gives it (`MeshData`)
 * @returns the OBJ text
 * @throws {UnsupportedError} when the mesh has no vertices or no positions
 *   (upstream writes no file), or an attribute holds too few floats for the
 *   vertex count (upstream fails reading past them)
 * @throws {CorruptError} when the submeshes' index counts run past their
 *   decoded triangles (upstream fails there too)
 * @example
 * const obj = meshToObj(env.objects.find((o) => o.type === ClassID.Mesh)!.read<MeshData>());
 */
export function meshToObj(mesh: MeshData): string {
  const name = mesh.m_Name;
  const count = mesh.vertexCount;
  const positions = mesh.vertices;
  if (count <= 0 || !positions || positions.length === 0) {
    throw new UnsupportedError(
      "mesh for OBJ",
      count <= 0 ? `${count} vertices` : "no positions",
      `Mesh "${name}": AssetStudio writes no OBJ for it`,
    );
  }
  const out: string[] = [`g ${name}${EOL}`];
  const read = (array: Float32Array, what: string, at: number): number => {
    if (at >= array.length) {
      throw new UnsupportedError(
        `${what} layout`,
        `${array.length} floats for ${count} vertices`,
        `Mesh "${name}": AssetStudio's OBJ export reads past them`,
      );
    }
    return array[at]!;
  };

  // Components per vertex, as upstream guesses them from the array length.
  // `c` carries over from one attribute to the next, as upstream's does.
  let c = positions.length === count * 4 ? 4 : 3;
  for (let v = 0; v < count; v++) {
    const x = read(positions, "position", v * c);
    const y = read(positions, "position", v * c + 1);
    const z = read(positions, "position", v * c + 2);
    out.push(`v ${formatSingle(-x)} ${formatSingle(y)} ${formatSingle(z)}${EOL}`);
  }

  const uv = mesh.uv[0];
  if (uv && uv.length > 0) {
    c = uv.length === count * 2 ? 2 : uv.length === count * 3 ? 3 : 4;
    for (let v = 0; v < count; v++) {
      const u = read(uv, "UV0", v * c);
      const w = read(uv, "UV0", v * c + 1);
      out.push(`vt ${formatSingle(u)} ${formatSingle(w)}${EOL}`);
    }
  }

  const normals = mesh.normals;
  if (normals && normals.length > 0) {
    if (normals.length === count * 3) c = 3;
    else if (normals.length === count * 4) c = 4;
    for (let v = 0; v < count; v++) {
      const x = read(normals, "normal", v * c);
      const y = read(normals, "normal", v * c + 1);
      const z = read(normals, "normal", v * c + 2);
      out.push(`vn ${formatSingle(-x)} ${formatSingle(y)} ${formatSingle(z)}${EOL}`);
    }
  }

  // Upstream walks one index list of every submesh's triangles in turn, each
  // submesh taking `indexCount / 3` faces. Its triangulation rewrote the
  // `indexCount` of a strip (to the triangles kept) and of quads (to
  // `indexCount / 2 * 3`); `MeshData` keeps Unity's, so it is redone here. A
  // triangle list whose count is not a multiple of 3 leaves its last
  // triangle to the next submesh, as upstream's does.
  const indices = flatten(mesh.indices);
  let sum = 0;
  mesh.m_SubMeshes.forEach((subMesh, i) => {
    out.push(`g ${name}_${i}${EOL}`);
    const { indexCount, topology } = subMesh;
    let taken = indexCount;
    if (topology === GfxPrimitiveType.TriangleStrip) taken = mesh.indices[i]?.length ?? 0;
    else if (topology === GfxPrimitiveType.Quads) taken = Math.floor(indexCount / 2) * 3;
    const end = sum + Math.floor(taken / 3);
    if (end * 3 > indices.length) {
      throw new CorruptError(
        `Mesh "${name}" submesh ${i}: faces ${sum} to ${end} run past the ` +
          `${indices.length / 3} triangles of its submeshes`,
      );
    }
    for (let f = sum; f < end; f++) {
      const a = indices[f * 3 + 2]! + 1;
      const b = indices[f * 3 + 1]! + 1;
      const d = indices[f * 3]! + 1;
      out.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${d}/${d}/${d}${EOL}`);
    }
    sum = end;
  });

  return out.join("").split("NaN").join("0");
}

/** Every submesh's triangles in one list, upstream's `m_Indices`. */
function flatten(parts: Uint32Array[]): Uint32Array {
  const all = new Uint32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}
