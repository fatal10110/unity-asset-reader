// A decoded Mesh as binary glTF 2.0 (.glb), written with core's GltfWriter.
// Not a port: AssetStudio exports models as FBX, so there is no upstream glTF
// to follow. The geometry is converted from Unity's left-handed space the way
// meshToObj (AssetStudio's OBJ export) converts it, so both formats hold the
// same vertices and faces.

import {
  CorruptError,
  GltfWriter,
  UnsupportedError,
  type GltfAccessorType,
  type MeshData,
} from "unity-asset-reader";

const VECTOR: GltfAccessorType[] = ["SCALAR", "VEC2", "VEC3", "VEC4"];

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
 * `m_IndexFormat` is, unless one is 65535 (glTF's primitive restart value)
 * or above (a submesh's `baseVertex` can take one there), else 32-bit.
 *
 * An attribute holding values glTF forbids is left out, for the whole mesh,
 * so the file stays valid (as the Khronos glTF validator checks it):
 * - `NORMAL` when a normal is not unit length, within 0.00674 (the
 *   validator's tolerance), a zero normal included;
 * - `TANGENT` when a tangent's xyz is not unit length within the same
 *   tolerance, or its w is not exactly 1 or -1, and whenever `NORMAL` is not
 *   written (a viewer must ignore tangents without normals);
 * - `COLOR_0` when a component is outside 0 to 1 (HDR colours).
 * Normals are never renormalised, so the ones written are the OBJ's.
 *
 * No materials, other UV channels, bones or blend shapes. Written with core's
 * `GltfWriter`.
 *
 * @param mesh a Mesh as `obj.read()` gives it (`MeshData`)
 * @returns the `.glb` file's bytes
 * @throws {UnsupportedError} when the mesh has no vertices, no positions or
 *   no triangles; when an attribute does not hold a number of floats per
 *   vertex glTF can take (positions and normals 3 or 4, tangents 4, colours 3
 *   or 4, UVs 2 to 4); or when a value of any attribute is NaN or infinite,
 *   which glTF does not allow
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

  // Every attribute converted first, so its values can be checked before any is written.
  const converted = new Map<string, { width: number; data: Float32Array }>();
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
    const data = new Float32Array(count * width);
    for (let v = 0; v < count; v++) {
      for (let d = 0; d < width; d++) {
        // Rounded to float32 as it will be stored.
        const value = Math.fround(convert(values, v * stride, d));
        if (!Number.isFinite(value)) {
          throw new UnsupportedError(
            `${what} value`,
            String(values[v * stride + d]),
            `Mesh "${name}" vertex ${v}: glTF holds finite floats only`,
          );
        }
        data[v * width + d] = value;
      }
    }
    converted.set(key, { width, data });
  }

  // Values glTF forbids in an attribute that Unity meshes do hold (zero
  // normals, tangents of w 0, HDR colours): the attribute is left out for the
  // whole mesh rather than written into a file viewers may refuse. A TANGENT
  // without a NORMAL must be ignored by viewers, so it goes with the normals.
  const normal = converted.get("NORMAL");
  if (normal && !everyVertex(normal.data, 3, isUnit)) {
    converted.delete("NORMAL");
  }
  const tangent = converted.get("TANGENT");
  // A unit xyz and a handedness (w) of exactly 1 or -1.
  const valid = (data: Float32Array, at: number): boolean =>
    isUnit(data, at) && Math.abs(data[at + 3]!) === 1;
  if (tangent && (!converted.has("NORMAL") || !everyVertex(tangent.data, 4, valid))) {
    converted.delete("TANGENT");
  }
  const color = converted.get("COLOR_0");
  if (color && !color.data.every((value) => value >= 0 && value <= 1)) {
    converted.delete("COLOR_0");
  }

  const gltf = new GltfWriter("unity-asset-reader-mesh");
  const attributes: Record<string, number> = {};
  for (const [key, { width, data }] of converted) {
    attributes[key] = gltf.addAccessor({
      data,
      type: VECTOR[width - 1]!,
      target: "ARRAY_BUFFER",
      // glTF requires the bounds of POSITION only.
      bounds: key === "POSITION",
    });
  }

  // A 16-bit index of 65535 is the primitive restart value, which glTF
  // forbids in indices (glTF 2.0 spec, Meshes), and one above would wrap, so
  // such a mesh goes 32-bit.
  const wide =
    mesh.m_IndexFormat !== 0 ||
    mesh.indices.some((part) => part.some((index) => index >= 0xffff));
  const primitives: { attributes: Record<string, number>; indices: number }[] = [];
  mesh.indices.forEach((triangles, i) => {
    // glTF has no empty accessor, so a submesh without triangles is left out.
    if (triangles.length === 0) return;
    if (triangles.length % 3 !== 0) {
      throw new CorruptError(
        `Mesh "${name}" submesh ${i}: ${triangles.length} indices are not whole triangles`,
      );
    }
    const indices = wide ? new Uint32Array(triangles.length) : new Uint16Array(triangles.length);
    for (let k = 0; k < triangles.length; k++) {
      // The winding reversed: each triangle (a, b, c) is written (c, b, a).
      const at = k - (k % 3) + 2 - (k % 3);
      const index = triangles[at]!;
      if (index >= count) {
        throw new CorruptError(
          `Mesh "${name}" submesh ${i}: index ${at} is ${index}, past the ${count} vertices`,
        );
      }
      indices[k] = index;
    }
    primitives.push({
      attributes,
      indices: gltf.addAccessor({ data: indices, type: "SCALAR", target: "ELEMENT_ARRAY_BUFFER" }),
    });
  });
  if (primitives.length === 0) {
    throw new UnsupportedError(
      "mesh for glTF",
      "no triangles",
      `Mesh "${name}": a glTF mesh needs a primitive`,
    );
  }

  gltf.addMesh({ name, primitives });
  gltf.addScene([gltf.addNode({ name, mesh: 0 })]);
  return gltf.toGlb();
}

/**
 * How far a normal or a tangent's xyz may be from unit length: the Khronos
 * glTF validator's tolerance (`ACCESSOR_VECTOR3_NON_UNIT`), as the spec gives none.
 */
const UNIT_TOLERANCE = 0.00674;

/** Whether the 3-vector at `at` is unit length, within {@link UNIT_TOLERANCE}. */
function isUnit(data: Float32Array, at: number): boolean {
  const [x, y, z] = [data[at]!, data[at + 1]!, data[at + 2]!];
  return Math.abs(Math.sqrt(x * x + y * y + z * z) - 1) <= UNIT_TOLERANCE;
}

/** Whether `test` holds for every vertex, `at` its first component. */
function everyVertex(
  data: Float32Array,
  width: number,
  test: (data: Float32Array, at: number) => boolean,
): boolean {
  for (let at = 0; at < data.length; at += width) if (!test(data, at)) return false;
  return true;
}
