// glTF 2.0 binary (.glb) writer: the building blocks (buffers, accessors,
// meshes, nodes, skins, morph targets, animations), nothing Unity-specific.
// Not a port: AssetStudio exports models as FBX, so it follows the Khronos
// glTF 2.0 specification. Feature packages decide what goes in (plan
// revision 2026-11-08d); unity-asset-reader-mesh's meshToGltf is built on it.

import { UnsupportedError } from "../errors.js";

/**
 * WHATWG `TextEncoder`, declared here because the package compiles with
 * `lib: ["ES2020"]` and no DOM or node types (R4). It is a platform global in
 * browsers, workers, Deno and Node >= 11.
 */
declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

// Buffer view targets (glTF 2.0 spec, bufferView.target).
const TARGETS = { ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963 } as const;

// Components per element of each accessor type.
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as const;

// Component type FLOAT (glTF 2.0 spec, accessor.componentType).
const FLOAT = 5126;

// The output type of each animation channel path (glTF 2.0 spec, Animations).
const PATH_TYPES = {
  translation: "VEC3",
  rotation: "VEC4",
  scale: "VEC3",
  weights: "SCALAR",
} as const;

// The GLB container (glTF 2.0 spec, GLB File Format): "glTF", version 2, chunks "JSON" and "BIN\0".
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** The typed arrays an accessor's components can come in; each is one glTF component type. */
export type GltfComponentArray =
  | Float32Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Uint32Array;

/** An accessor's element type: how many components make one element. */
export type GltfAccessorType = "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4";

/** One accessor for {@link GltfWriter.addAccessor}: its data gets a buffer view of its own. */
export interface GltfAccessor {
  /**
   * The components, element after element. The array's class picks the
   * component type: `Float32Array` FLOAT, `Uint32Array` UNSIGNED_INT,
   * `Uint16Array` UNSIGNED_SHORT, `Int16Array` SHORT, `Uint8Array`
   * UNSIGNED_BYTE, `Int8Array` BYTE.
   */
  data: GltfComponentArray;
  type: GltfAccessorType;
  /**
   * The buffer view's `target`: `ARRAY_BUFFER` for vertex attributes and
   * morph target deltas, `ELEMENT_ARRAY_BUFFER` for indices; left out for
   * other data (inverse bind matrices, animation keyframes).
   */
  target?: "ARRAY_BUFFER" | "ELEMENT_ARRAY_BUFFER";
  /**
   * 8- or 16-bit integer components stand for 0 to 1 (or -1 to 1), as
   * `WEIGHTS_0` or `COLOR_0` may.
   */
  normalized?: boolean;
  /**
   * Write the per-component `min` and `max`, which glTF requires of `POSITION`
   * (morph targets included) and of animation sampler inputs.
   */
  bounds?: boolean;
}

/** One primitive of a {@link GltfMesh}, drawn as triangles. Values are accessor indices. */
export interface GltfPrimitive {
  /** Semantic (`POSITION`, `NORMAL`, `JOINTS_0`, ...) to accessor. */
  attributes: Record<string, number>;
  indices?: number;
  /** Morph targets: semantic (`POSITION`, `NORMAL`, `TANGENT`) to the accessor of its deltas. */
  targets?: Record<string, number>[];
}

/** One mesh for {@link GltfWriter.addMesh}. */
export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
  /** The morph targets' default weights, one per target of each primitive. */
  weights?: number[];
}

/** One node for {@link GltfWriter.addNode}; its transform is translation, rotation, scale. */
export interface GltfNode {
  name?: string;
  /** Mesh index. */
  mesh?: number;
  /** Skin index; the node needs a mesh, whose primitives have `JOINTS_0` and `WEIGHTS_0`. */
  skin?: number;
  /** Node indices. */
  children?: number[];
  translation?: [number, number, number];
  /** A unit quaternion, x, y, z, w. */
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  /** Morph target weights overriding the mesh's. */
  weights?: number[];
}

/** One skin for {@link GltfWriter.addSkin}. */
export interface GltfSkin {
  name?: string;
  /** Accessor index: a MAT4 per joint, column-major. Identity matrices when left out. */
  inverseBindMatrices?: number;
  /** Node indices; `JOINTS_0` values index into this list. */
  joints: number[];
}

/** One keyframe sampler of a {@link GltfAnimation}. Values are accessor indices. */
export interface GltfAnimationSampler {
  /** Keyframe times in seconds: FLOAT SCALAR, strictly increasing, written with `bounds`. */
  input: number;
  /**
   * `LINEAR` (the default) and `STEP` take one output value per keyframe;
   * `CUBICSPLINE` three (in-tangent, value, out-tangent) and at least 2 keyframes.
   */
  interpolation?: "LINEAR" | "STEP" | "CUBICSPLINE";
  /**
   * The values, as many per keyframe as the channel's path takes: one FLOAT
   * VEC3 for translation or scale, one VEC4 for rotation, one SCALAR per
   * morph target of the node's mesh for weights. Rotation and weights may
   * also be normalized 8- or 16-bit integers.
   */
  output: number;
}

/** One animated property of a {@link GltfAnimation}. */
export interface GltfAnimationChannel {
  /** Index into the animation's samplers. */
  sampler: number;
  target: { node: number; path: "translation" | "rotation" | "scale" | "weights" };
}

/** One animation for {@link GltfWriter.addAnimation}. */
export interface GltfAnimation {
  name?: string;
  channels: GltfAnimationChannel[];
  samplers: GltfAnimationSampler[];
}

interface AccessorJson {
  bufferView: number;
  componentType: number;
  normalized?: true;
  count: number;
  type: GltfAccessorType;
  min?: number[];
  max?: number[];
}

interface BufferViewJson {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

/**
 * Builds a binary glTF 2.0 file (`.glb`), one buffer in the file's own binary
 * chunk. Add accessors, then the meshes, skins, nodes and animations that
 * refer to them by the indices the `add` methods return, then the scene's root
 * nodes; {@link GltfWriter.toGlb} checks the references and writes the file.
 * The JSON holds what was added, in the order added, and leaves out what was
 * not. Sync and isomorphic.
 *
 * @example
 * const gltf = new GltfWriter("my-tool");
 * const position = gltf.addAccessor({
 *   data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
 *   type: "VEC3",
 *   target: "ARRAY_BUFFER",
 *   bounds: true,
 * });
 * const mesh = gltf.addMesh({ primitives: [{ attributes: { POSITION: position } }] });
 * gltf.addScene([gltf.addNode({ name: "triangle", mesh })]);
 * const glb = gltf.toGlb();
 */
export class GltfWriter {
  private readonly generator: string;
  private readonly accessors: AccessorJson[] = [];
  private readonly bufferViews: BufferViewJson[] = [];
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private readonly meshes: GltfMesh[] = [];
  private readonly nodes: GltfNode[] = [];
  private readonly skins: GltfSkin[] = [];
  private readonly animations: GltfAnimation[] = [];
  private readonly scenes: number[][] = [];

  /** @param generator the file's `asset.generator`: what wrote it */
  constructor(generator: string) {
    this.generator = generator;
  }

  /**
   * Append an accessor and its data, in a buffer view of its own starting on
   * a 4-byte boundary, components little-endian.
   *
   * @returns the accessor's index
   * @throws {UnsupportedError} when `data` holds no element or not a whole
   *   number of them, is not one of the {@link GltfComponentArray} classes, or
   *   holds a NaN or infinite float; when `normalized` is set on float or
   *   32-bit components; when an `ARRAY_BUFFER` element is not a multiple of
   *   4 bytes (glTF aligns vertex attributes to 4 bytes, so a VEC3 of 8-bit
   *   or 16-bit components, for one, needs padding this writer does not add)
   */
  addAccessor(accessor: GltfAccessor): number {
    const { data, type } = accessor;
    const width = WIDTHS[type];
    const count = data.length / width;
    if (data.length === 0 || !Number.isInteger(count)) {
      throw new UnsupportedError(
        "glTF accessor size",
        `${data.length} components`,
        `a ${type} accessor needs a whole number of elements, at least one`,
      );
    }
    const bytes = new Uint8Array(data.length * data.BYTES_PER_ELEMENT);
    const view = new DataView(bytes.buffer);
    let componentType: number;
    let set: (at: number, value: number, littleEndian: boolean) => void;
    if (data instanceof Float32Array) {
      componentType = FLOAT;
      set = view.setFloat32;
      const bad = data.findIndex((value) => !Number.isFinite(value));
      if (bad >= 0) {
        throw new UnsupportedError(
          "glTF accessor value",
          String(data[bad]),
          `component ${bad}: glTF holds finite floats only`,
        );
      }
    } else if (data instanceof Uint32Array) {
      componentType = 5125;
      set = view.setUint32;
    } else if (data instanceof Uint16Array) {
      componentType = 5123;
      set = view.setUint16;
    } else if (data instanceof Int16Array) {
      componentType = 5122;
      set = view.setInt16;
    } else if (data instanceof Uint8Array) {
      componentType = 5121;
      set = view.setUint8;
    } else if (data instanceof Int8Array) {
      componentType = 5120;
      set = view.setInt8;
    } else {
      throw new UnsupportedError(
        "glTF accessor data",
        Object.prototype.toString.call(data),
        "glTF takes float32, uint32, (u)int16 or (u)int8 components",
      );
    }
    const size = data.BYTES_PER_ELEMENT;
    if (accessor.normalized && size > 2) {
      throw new UnsupportedError(
        "glTF accessor normalized",
        `${size * 8}-bit components`,
        "only 8- and 16-bit integer components can be normalized",
      );
    }
    if (accessor.target === "ARRAY_BUFFER" && (width * size) % 4 !== 0) {
      throw new UnsupportedError(
        "glTF accessor alignment",
        `${type} of ${size * 8}-bit components, ${width * size} bytes`,
        "an ARRAY_BUFFER element needs a multiple of 4 bytes",
      );
    }
    for (let i = 0; i < data.length; i++) set.call(view, i * size, data[i]!, true);

    this.accessors.push({
      bufferView: this.addView(bytes, accessor.target && TARGETS[accessor.target]),
      componentType,
      normalized: accessor.normalized || undefined,
      count,
      type,
      ...(accessor.bounds && bounds(data, width)),
    });
    return this.accessors.length - 1;
  }

  /** Add a mesh. @returns its index (references are checked by {@link GltfWriter.toGlb}) */
  addMesh(mesh: GltfMesh): number {
    return this.meshes.push(mesh) - 1;
  }

  /** Add a node. @returns its index (references are checked by {@link GltfWriter.toGlb}) */
  addNode(node: GltfNode): number {
    return this.nodes.push(node) - 1;
  }

  /** Add a skin. @returns its index (references are checked by {@link GltfWriter.toGlb}) */
  addSkin(skin: GltfSkin): number {
    return this.skins.push(skin) - 1;
  }

  /** Add an animation. @returns its index (references are checked by {@link GltfWriter.toGlb}) */
  addAnimation(animation: GltfAnimation): number {
    return this.animations.push(animation) - 1;
  }

  /**
   * Add a scene; the first one added is the file's default `scene`.
   *
   * @param nodes the scene's root nodes
   * @returns its index
   */
  addScene(nodes: number[]): number {
    return this.scenes.push(nodes) - 1;
  }

  /**
   * Write the file: the 12-byte GLB header, the JSON chunk padded with spaces
   * to 4 bytes, then the binary chunk, left out when no accessor was added.
   *
   * @returns the `.glb` file's bytes
   * @throws {UnsupportedError} when the file would break a rule of the glTF
   *   2.0 spec: an index past what was added; an empty list (primitives,
   *   joints, channels, samplers, scene nodes); a node skin without a mesh;
   *   morph target counts differing between a mesh's primitives, or from the
   *   length of its or its node's `weights`; node `weights` without a mesh;
   *   a skin whose inverse bind matrices are not one per joint; an animation
   *   sampler whose input is not FLOAT SCALAR written with `bounds`, or a
   *   `CUBICSPLINE` one with fewer than 2 keyframes; a channel whose sampler
   *   output does not fit its path (see {@link GltfAnimationSampler.output}):
   *   the wrong type or component type, or not exactly that many values per
   *   keyframe (3 times as many for `CUBICSPLINE`); a weights channel on a
   *   node whose mesh has no morph targets; a NaN or infinite TRS or weight
   */
  toGlb(): Uint8Array {
    this.check();
    const list = <T>(items: T[]): T[] | undefined => (items.length > 0 ? items : undefined);
    const json = {
      asset: { version: "2.0", generator: this.generator },
      scene: this.scenes.length > 0 ? 0 : undefined,
      scenes: list(this.scenes.map((nodes) => ({ nodes }))),
      nodes: list(
        this.nodes.map((n) => ({
          name: n.name,
          mesh: n.mesh,
          skin: n.skin,
          children: n.children,
          translation: n.translation,
          rotation: n.rotation,
          scale: n.scale,
          weights: n.weights,
        })),
      ),
      meshes: list(
        this.meshes.map((m) => ({
          name: m.name,
          primitives: m.primitives.map((p) => ({
            attributes: p.attributes,
            indices: p.indices,
            targets: p.targets,
          })),
          weights: m.weights,
        })),
      ),
      skins: list(
        this.skins.map((s) => ({
          name: s.name,
          inverseBindMatrices: s.inverseBindMatrices,
          joints: s.joints,
        })),
      ),
      animations: list(
        this.animations.map((a) => ({
          name: a.name,
          channels: a.channels.map((c) => ({
            sampler: c.sampler,
            target: { node: c.target.node, path: c.target.path },
          })),
          samplers: a.samplers.map((s) => ({
            input: s.input,
            interpolation: s.interpolation,
            output: s.output,
          })),
        })),
      ),
      accessors: list(this.accessors),
      bufferViews: list(this.bufferViews),
      buffers: this.byteLength > 0 ? [{ byteLength: this.byteLength }] : undefined,
    };
    return glb(new TextEncoder().encode(JSON.stringify(json)), this.chunks, this.byteLength);
  }

  /** Append bytes to the buffer, 4-aligned, and return their buffer view. */
  private addView(bytes: Uint8Array, target: number | undefined): number {
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.length,
      target,
    });
    this.chunks.push(bytes);
    this.byteLength += bytes.length;
    const pad = -bytes.length & 3;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    return this.bufferViews.length - 1;
  }

  /** The spec rules {@link GltfWriter.toGlb} lists, checked on what was added. */
  private check(): void {
    const fail = (where: string, found: string, rule: string): never => {
      throw new UnsupportedError(`glTF ${where}`, found, rule);
    };
    const ref = (where: string, index: number | undefined, length: number, kind: string): void => {
      if (index !== undefined && !(Number.isInteger(index) && index >= 0 && index < length)) {
        fail(where, String(index), `${length} ${kind} were added`);
      }
    };
    const accessor = (where: string, index: number | undefined): void =>
      ref(where, index, this.accessors.length, "accessors");
    const nonEmpty = (where: string, items: unknown[]): void => {
      if (items.length === 0) fail(where, "empty list", "glTF needs at least one");
    };
    const finite = (where: string, values: number[] | undefined): void => {
      const bad = values?.find((value) => !Number.isFinite(value));
      if (bad !== undefined) fail(where, String(bad), "glTF holds finite numbers only");
    };
    /** The morph target count of a mesh, the same in every primitive. */
    const targetCount = (m: GltfMesh, where: string): number => {
      const counts = new Set(m.primitives.map((p) => p.targets?.length ?? 0));
      if (counts.size > 1) {
        fail(where, [...counts].join(" and "), "every primitive needs as many morph targets");
      }
      return m.primitives[0]?.targets?.length ?? 0;
    };

    this.meshes.forEach((m, i) => {
      const where = `mesh ${i}`;
      nonEmpty(`${where} primitives`, m.primitives);
      m.primitives.forEach((p, k) => {
        for (const [key, index] of Object.entries(p.attributes)) {
          accessor(`${where} primitive ${k} ${key}`, index);
        }
        accessor(`${where} primitive ${k} indices`, p.indices);
        p.targets?.forEach((t, j) => {
          for (const [key, index] of Object.entries(t)) {
            accessor(`${where} primitive ${k} target ${j} ${key}`, index);
          }
        });
      });
      const targets = targetCount(m, where);
      finite(`${where} weights`, m.weights);
      if (m.weights && m.weights.length !== targets) {
        fail(`${where} weights`, `${m.weights.length}`, `one per morph target, ${targets}`);
      }
    });
    this.nodes.forEach((n, i) => {
      const where = `node ${i}`;
      ref(`${where} mesh`, n.mesh, this.meshes.length, "meshes");
      ref(`${where} skin`, n.skin, this.skins.length, "skins");
      if (n.skin !== undefined && n.mesh === undefined) {
        fail(`${where} skin`, String(n.skin), "a node with a skin needs a mesh");
      }
      n.children?.forEach((child) => ref(`${where} child`, child, this.nodes.length, "nodes"));
      for (const key of ["translation", "rotation", "scale", "weights"] as const) {
        finite(`${where} ${key}`, n[key]);
      }
      if (n.weights && n.mesh === undefined) {
        fail(`${where} weights`, `${n.weights.length}`, "a node with weights needs a mesh");
      }
      const mesh = n.mesh === undefined ? undefined : this.meshes[n.mesh];
      if (n.weights && mesh && n.weights.length !== targetCount(mesh, `mesh ${n.mesh}`)) {
        fail(`${where} weights`, `${n.weights.length}`, `one per morph target of mesh ${n.mesh}`);
      }
    });
    this.skins.forEach((s, i) => {
      const where = `skin ${i}`;
      nonEmpty(`${where} joints`, s.joints);
      s.joints.forEach((joint) => ref(`${where} joint`, joint, this.nodes.length, "nodes"));
      accessor(`${where} inverseBindMatrices`, s.inverseBindMatrices);
      const matrices = s.inverseBindMatrices;
      if (matrices !== undefined && this.accessors[matrices]!.count !== s.joints.length) {
        fail(
          `${where} inverseBindMatrices`,
          `${this.accessors[matrices]!.count} matrices`,
          `one per joint, ${s.joints.length}`,
        );
      }
    });
    this.animations.forEach((a, i) => {
      const where = `animation ${i}`;
      nonEmpty(`${where} channels`, a.channels);
      nonEmpty(`${where} samplers`, a.samplers);
      a.samplers.forEach((s, k) => {
        accessor(`${where} sampler ${k} input`, s.input);
        accessor(`${where} sampler ${k} output`, s.output);
        const input = this.accessors[s.input]!;
        if (input.componentType !== FLOAT || input.type !== "SCALAR") {
          fail(
            `${where} sampler ${k} input`,
            `accessor ${s.input}`,
            "keyframe times are FLOAT SCALAR",
          );
        }
        if (!input.min) {
          fail(`${where} sampler ${k} input`, `accessor ${s.input}`, "written without bounds");
        }
        if (s.interpolation === "CUBICSPLINE" && input.count < 2) {
          fail(`${where} sampler ${k} input`, `${input.count} keyframes`, "CUBICSPLINE needs 2");
        }
      });
      a.channels.forEach((c, k) => {
        ref(`${where} channel ${k} sampler`, c.sampler, a.samplers.length, "samplers");
        ref(`${where} channel ${k} node`, c.target.node, this.nodes.length, "nodes");
        const { path } = c.target;
        const s = a.samplers[c.sampler]!;
        const input = this.accessors[s.input]!;
        const output = this.accessors[s.output]!;
        const at = `${where} channel ${k} ${path} output`;
        let per = 1;
        if (path === "weights") {
          const node = this.nodes[c.target.node]!;
          const mesh = node.mesh === undefined ? undefined : this.meshes[node.mesh];
          per = mesh ? targetCount(mesh, `mesh ${node.mesh}`) : 0;
          if (per === 0) {
            fail(
              `${where} channel ${k} node`,
              String(c.target.node),
              "a weights channel needs a node whose mesh has morph targets",
            );
          }
        }
        const type = PATH_TYPES[path];
        if (output.type !== type) fail(at, output.type, `${path} takes ${type}`);
        const float = output.componentType === FLOAT;
        if (!float && (path === "translation" || path === "scale" || !output.normalized)) {
          fail(
            at,
            `component type ${output.componentType}`,
            path === "translation" || path === "scale"
              ? `${path} takes FLOAT`
              : `${path} takes FLOAT or normalized 8- or 16-bit integers`,
          );
        }
        const cubic = s.interpolation === "CUBICSPLINE";
        const expected = input.count * per * (cubic ? 3 : 1);
        if (output.count !== expected) {
          const each = per > 1 ? `${per} (one per morph target)` : "one";
          fail(
            at,
            `${output.count} values for ${input.count} keyframes`,
            cubic
              ? `3 times ${each} per keyframe (in-tangent, value, out-tangent), ${expected}`
              : `${each} per keyframe, ${expected}`,
          );
        }
      });
    });
    this.scenes.forEach((nodes, i) => {
      nonEmpty(`scene ${i} nodes`, nodes);
      nodes.forEach((node) => ref(`scene ${i} node`, node, this.nodes.length, "nodes"));
    });
  }
}

/** The per-component bounds of an accessor, as glTF's `min` and `max`. */
function bounds(data: GltfComponentArray, width: number): { min: number[]; max: number[] } {
  const min = new Array<number>(width).fill(Infinity);
  const max = new Array<number>(width).fill(-Infinity);
  for (let i = 0; i < data.length; i++) {
    const [value, d] = [data[i]!, i % width];
    if (value < min[d]!) min[d] = value;
    if (value > max[d]!) max[d] = value;
  }
  return { min, max };
}

/** The GLB container around the JSON and the binary chunks (already 4-aligned). */
function glb(json: Uint8Array, chunks: Uint8Array[], binLength: number): Uint8Array {
  const jsonLength = json.length + (-json.length & 3);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  if (binLength === 0) return out;
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
