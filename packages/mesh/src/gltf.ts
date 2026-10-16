// glTF 2.0 binary (.glb) writer for a decoded Mesh. Not a port: AssetStudio
// exports models as FBX, so there is no upstream glTF to follow. The geometry
// is converted from Unity's left-handed space the way meshToObj (AssetStudio's
// OBJ export) converts it, so both formats hold the same vertices and faces.

import { CorruptError, UnsupportedError, type MeshData } from "unity-asset-reader";

/**
 * WHATWG `TextEncoder`, declared here because the package compiles with
 * `lib: ["ES2020"]` and no DOM or node types (R4). It is a platform global in
 * browsers, workers, Deno and Node >= 11.
 */
declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

// glTF enums (glTF 2.0 spec, 5.11 and 5.1).
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const VECTOR = ["SCALAR", "VEC2", "VEC3", "VEC4"];

// GLB container (glTF 2.0 spec, 4.4): "glTF", version 2, chunks "JSON" and "BIN\0".
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface BufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target: number;
}

/** A vertex attribute: where it comes from and how its components are converted. */
interface Attribute {
  /** The glTF attribute semantic. */
  key: string;
  /** What error messages call it. */
  what: string;
  values: Float32Array | undefined;
  /** Floats per vertex the source may hold; glTF takes the first `width` of them. */
  strides: number[];
  /** Components per vertex in glTF; `0` keeps the source's stride. */
  width: number;
  /** Component `d` of the vertex whose source floats start at `at`. */
  convert: (values: Float32Array, at: number, d: number) => number;
}

/**
 * Write a decoded mesh as a binary glTF 2.0 file (`.glb`): one scene with one
 * node holding one mesh named after it, a triangle primitive per submesh that
 * has triangles. Self-contained, so it opens as is in any glTF viewer.
 *
 * Vertex attributes: `POSITION`, and when the mesh has them `NORMAL`,
 * `TANGENT`, `TEXCOORD_0` (UV channel 0) and `COLOR_0`, all float. Unity's
 * left-handed space becomes glTF's right-handed one as `meshToObj` converts
 * it: x of positions, normals and tangents negated and every triangle's
 * winding reversed, so positions, normals and indices are the OBJ's. Also
 * converted: the tangent's handedness (w) is negated, as the mirror flips it,
 * and UV v becomes `1 - v`, since glTF's UV origin is the top left of the
 * image and Unity's (and OBJ's) the bottom left. Colours are copied as they
 * are, RGB or RGBA. Indices are unsigned 16-bit when the mesh's
 * `m_IndexFormat` is, unless one is 65535 (glTF's primitive restart value),
 * else 32-bit; as in `MeshData` and the OBJ, they are not offset by the
 * submesh's `baseVertex`.
 *
 * No materials, other UV channels, bones or blend shapes.
 *
 * @param mesh a Mesh as `obj.read()` gives it (`MeshData`)
 * @returns the `.glb` file's bytes
 * @throws {UnsupportedError} when the mesh has no vertices, no positions or
 *   no triangles; when an attribute does not hold a number of floats per
 *   vertex glTF can take (positions and normals 3 or 4, tangents 4, colours 3
 *   or 4, UVs 2 to 4); or when a value is NaN or infinite, which glTF does
 *   not allow
 * @throws {CorruptError} when a submesh's index count is not a whole number of
 *   triangles, or an index is past the vertex count
 * @example
 * const glb = meshToGltf(env.objects.find((o) => o.type === ClassID.Mesh)!.read<MeshData>());
 */
export function meshToGltf(mesh: MeshData): Uint8Array {
  const name = mesh.m_Name;
  const count = mesh.vertexCount;
  if (count <= 0 || !mesh.vertices || mesh.vertices.length === 0) {
    throw new UnsupportedError(
      "mesh for glTF",
      count <= 0 ? `${count} vertices` : "no positions",
      `Mesh "${name}": glTF needs the vertices' positions`,
    );
  }

  const accessors: Accessor[] = [];
  const bufferViews: BufferView[] = [];
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  /** Append bytes to the buffer, 4-aligned, and return their buffer view. */
  const addView = (bytes: Uint8Array, target: number): number => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    chunks.push(bytes);
    byteLength += bytes.length;
    const pad = -bytes.length & 3;
    if (pad > 0) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    return bufferViews.length - 1;
  };

  const negateX = (values: Float32Array, at: number, d: number): number =>
    d === 0 ? -values[at]! : values[at + d]!;
  const vertexAttributes: Attribute[] = [
    {
      key: "POSITION",
      what: "position",
      values: mesh.vertices,
      strides: [3, 4],
      width: 3,
      convert: negateX,
    },
    {
      key: "NORMAL",
      what: "normal",
      values: mesh.normals,
      strides: [3, 4],
      width: 3,
      convert: negateX,
    },
    {
      key: "TANGENT",
      what: "tangent",
      values: mesh.tangents,
      strides: [4],
      width: 4,
      convert: (values, at, d) => (d === 0 || d === 3 ? -values[at + d]! : values[at + d]!),
    },
    {
      key: "TEXCOORD_0",
      what: "UV0",
      values: mesh.uv[0],
      strides: [2, 3, 4],
      width: 2,
      convert: (values, at, d) => (d === 1 ? 1 - values[at + 1]! : values[at]!),
    },
    {
      key: "COLOR_0",
      what: "color",
      values: mesh.colors,
      strides: [3, 4],
      width: 0,
      convert: (values, at, d) => values[at + d]!,
    },
  ];

  const attributes: Record<string, number> = {};
  for (const { key, what, values, strides, width: fixed, convert } of vertexAttributes) {
    if (!values || values.length === 0) continue;
    const stride = values.length / count;
    if (!strides.includes(stride)) {
      throw new UnsupportedError(
        `${what} layout`,
        `${values.length} floats for ${count} vertices`,
        `Mesh "${name}": glTF takes ${strides.join(" or ")} per vertex`,
      );
    }
    const width = fixed || stride;
    const bytes = new Uint8Array(count * width * 4);
    const view = new DataView(bytes.buffer);
    const min = new Array<number>(width).fill(Infinity);
    const max = new Array<number>(width).fill(-Infinity);
    for (let v = 0; v < count; v++) {
      for (let d = 0; d < width; d++) {
        // Rounded to float32 here, so the bounds below are the stored values.
        const value = Math.fround(convert(values, v * stride, d));
        if (!Number.isFinite(value)) {
          throw new UnsupportedError(
            `${what} value`,
            String(values[v * stride + d]),
            `Mesh "${name}" vertex ${v}: glTF holds finite floats only`,
          );
        }
        view.setFloat32((v * width + d) * 4, value, true);
        if (value < min[d]!) min[d] = value;
        if (value > max[d]!) max[d] = value;
      }
    }
    accessors.push({
      bufferView: addView(bytes, ARRAY_BUFFER),
      componentType: FLOAT,
      count,
      type: VECTOR[width - 1]!,
      // glTF requires the bounds of POSITION only.
      ...(key === "POSITION" && { min, max }),
    });
    attributes[key] = accessors.length - 1;
  }

  // A 16-bit index of 65535 is the primitive restart value, which glTF
  // forbids in a triangle list (spec 3.7.2.1), so such a mesh goes 32-bit.
  const wide = mesh.m_IndexFormat !== 0 || mesh.indices.some((part) => part.includes(0xffff));
  const size = wide ? 4 : 2;
  const primitives: { attributes: Record<string, number>; indices: number }[] = [];
  mesh.indices.forEach((triangles, i) => {
    // glTF has no empty accessor, so a submesh without triangles is left out.
    if (triangles.length === 0) return;
    if (triangles.length % 3 !== 0) {
      throw new CorruptError(
        `Mesh "${name}" submesh ${i}: ${triangles.length} indices are not whole triangles`,
      );
    }
    const bytes = new Uint8Array(triangles.length * size);
    const view = new DataView(bytes.buffer);
    for (let k = 0; k < triangles.length; k++) {
      // The winding reversed: each triangle (a, b, c) is written (c, b, a).
      const at = k - (k % 3) + 2 - (k % 3);
      const index = triangles[at]!;
      if (index >= count) {
        throw new CorruptError(
          `Mesh "${name}" submesh ${i}: index ${at} is ${index}, past the ${count} vertices`,
        );
      }
      if (wide) view.setUint32(k * 4, index, true);
      else view.setUint16(k * 2, index, true);
    }
    accessors.push({
      bufferView: addView(bytes, ELEMENT_ARRAY_BUFFER),
      componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
      count: triangles.length,
      type: "SCALAR",
    });
    primitives.push({ attributes, indices: accessors.length - 1 });
  });
  if (primitives.length === 0) {
    throw new UnsupportedError(
      "mesh for glTF",
      "no triangles",
      `Mesh "${name}": a glTF mesh needs a primitive`,
    );
  }

  const json = {
    asset: { version: "2.0", generator: "unity-asset-reader-mesh" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  return glb(new TextEncoder().encode(JSON.stringify(json)), chunks, byteLength);
}

/**
 * The GLB container: a 12-byte header, the JSON chunk padded with spaces to
 * 4 bytes, then the binary chunk (already 4-aligned).
 */
function glb(json: Uint8Array, chunks: Uint8Array[], binLength: number): Uint8Array {
  const jsonLength = json.length + (-json.length & 3);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  let at = 20 + jsonLength;
  view.setUint32(at, binLength, true);
  view.setUint32(at + 4, CHUNK_BIN, true);
  at += 8;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
