// GltfWriter (#317). Nothing upstream writes glTF (AssetStudio exports FBX),
// so there is no golden: every file built here is checked by the Khronos glTF
// validator, and read back with a reader written from the glTF 2.0 spec (GLB
// container, accessors, buffer views), not from the writer. The inputs are
// built in the test, so the expected values are known without the writer.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as gltfValidator from "gltf-validator";

import { GltfWriter, UnsupportedError, type GltfComponentArray } from "../src/index.js";

// --- the validator ------------------------------------------------------------------

/** The part of the validator's report the tests read (it ships no types). */
interface Report {
  issues: {
    numErrors: number;
    numWarnings: number;
    messages: { code: string; message: string; severity: number; pointer?: string }[];
  };
}
const validator = gltfValidator as unknown as {
  validateBytes(data: Uint8Array, options: object): Promise<Report>;
};

/** Validate a .glb; fail with the validator's messages on any error or warning. */
async function assertValid(glb: Uint8Array): Promise<void> {
  const report = await validator.validateBytes(glb, {
    format: "glb",
    writeTimestamp: false,
    maxIssues: 0,
  });
  const { numErrors, numWarnings, messages } = report.issues;
  assert.deepEqual(
    { numErrors, numWarnings },
    { numErrors: 0, numWarnings: 0 },
    JSON.stringify(messages, null, 2),
  );
}

// --- reading the .glb back (glTF 2.0 spec: GLB container, accessors) ------------------

/** The file's JSON as parsed: `any`, as the tests read whatever the writer put there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The JSON and binary chunks of a .glb, checking its header and chunk layout. */
function readGlb(bytes: Uint8Array): { json: Json; bin: DataView | undefined } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, "magic glTF");
  assert.equal(view.getUint32(4, true), 2, "container version 2");
  assert.equal(view.getUint32(8, true), bytes.length, "length in the header");
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, "first chunk JSON");
  assert.equal(jsonLength % 4, 0, "JSON chunk 4-aligned");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binAt = 20 + jsonLength;
  if (binAt === bytes.length) return { json, bin: undefined };
  const binLength = view.getUint32(binAt, true);
  assert.equal(view.getUint32(binAt + 4, true), 0x004e4942, "second chunk BIN");
  assert.equal(binAt + 8 + binLength, bytes.length, "BIN chunk runs to the end");
  assert.equal(json.buffers[0].byteLength, binLength);
  return { json, bin: new DataView(bytes.buffer, bytes.byteOffset + binAt + 8, binLength) };
}

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GETTERS: Record<number, [number, (view: DataView, at: number) => number]> = {
  5120: [1, (v, at) => v.getInt8(at)],
  5121: [1, (v, at) => v.getUint8(at)],
  5122: [2, (v, at) => v.getInt16(at, true)],
  5123: [2, (v, at) => v.getUint16(at, true)],
  5125: [4, (v, at) => v.getUint32(at, true)],
  5126: [4, (v, at) => v.getFloat32(at, true)],
};

/** Every component of an accessor, as numbers, checking its buffer view's alignment. */
function accessor(doc: { json: Json; bin: DataView | undefined }, index: number): number[] {
  const a = doc.json.accessors[index];
  const bufferView = doc.json.bufferViews[a.bufferView];
  const start = (bufferView.byteOffset ?? 0) + (a.byteOffset ?? 0);
  assert.equal(start % 4, 0, `accessor ${index} 4-aligned`);
  const [size, get] = GETTERS[a.componentType]!;
  assert.equal(bufferView.byteLength, a.count * WIDTH[a.type]! * size, `accessor ${index} size`);
  const out: number[] = [];
  for (let i = 0; i < a.count * WIDTH[a.type]!; i++) out.push(get(doc.bin!, start + i * size));
  return out;
}

// --- inputs ---------------------------------------------------------------------------

/** A quad of two triangles in the xy plane, facing +z (counter-clockwise). */
const QUAD = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
const UP = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const TANGENTS = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);

/** A unit quaternion turning `angle` radians around z. */
function aroundZ(angle: number): [number, number, number, number] {
  return [0, 0, Math.fround(Math.sin(angle / 2)), Math.fround(Math.cos(angle / 2))];
}

/** A writer holding the quad: its POSITION and indices accessors. */
function quad(gltf: GltfWriter): { POSITION: number; indices: number } {
  return {
    POSITION: gltf.addAccessor({
      data: QUAD,
      type: "VEC3",
      target: "ARRAY_BUFFER",
      bounds: true,
    }),
    indices: gltf.addAccessor({
      data: QUAD_INDICES,
      type: "SCALAR",
      target: "ELEMENT_ARRAY_BUFFER",
    }),
  };
}

// --- tests ----------------------------------------------------------------------------

test("a mesh on a node with translation, rotation and scale is valid and reads back", async () => {
  const gltf = new GltfWriter("test-generator");
  // Three indices: 6 bytes, so the next view starts after 2 bytes of padding.
  const position = gltf.addAccessor({
    data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    type: "VEC3",
    target: "ARRAY_BUFFER",
    bounds: true,
  });
  const indices = gltf.addAccessor({
    data: new Uint16Array([0, 1, 2]),
    type: "SCALAR",
    target: "ELEMENT_ARRAY_BUFFER",
  });
  const normal = gltf.addAccessor({
    data: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    type: "VEC3",
    target: "ARRAY_BUFFER",
  });
  const mesh = gltf.addMesh({
    name: "triangle",
    primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices }],
  });
  const node = gltf.addNode({
    name: "node",
    mesh,
    translation: [1, 2, 3],
    rotation: aroundZ(Math.PI / 2),
    scale: [2, 2, 2],
  });
  assert.equal(gltf.addScene([node]), 0);
  const glb = gltf.toGlb();
  await assertValid(glb);

  const doc = readGlb(glb);
  const { json } = doc;
  assert.deepEqual(json.asset, { version: "2.0", generator: "test-generator" });
  assert.equal(json.scene, 0);
  assert.deepEqual(json.scenes, [{ nodes: [0] }]);
  assert.deepEqual(json.nodes, [
    {
      name: "node",
      mesh: 0,
      translation: [1, 2, 3],
      rotation: aroundZ(Math.PI / 2),
      scale: [2, 2, 2],
    },
  ]);
  assert.deepEqual(json.meshes, [
    { name: "triangle", primitives: [{ attributes: { POSITION: 0, NORMAL: 2 }, indices: 1 }] },
  ]);
  // Lists nothing was added to are left out (the spec forbids empty arrays).
  for (const key of ["skins", "animations", "materials"]) assert.equal(json[key], undefined);

  assert.deepEqual(json.accessors[0], {
    bufferView: 0,
    componentType: 5126,
    count: 3,
    type: "VEC3",
    min: [0, 0, 0],
    max: [1, 1, 0],
  });
  assert.deepEqual(json.accessors[1], {
    bufferView: 1,
    componentType: 5123,
    count: 3,
    type: "SCALAR",
  });
  assert.deepEqual(
    json.bufferViews.map((v: Json) => [v.byteOffset, v.byteLength, v.target]),
    [
      [0, 36, 34962],
      [36, 6, 34963],
      [44, 36, 34962],
    ],
  );
  assert.equal(json.buffers[0].byteLength, 80);
  assert.deepEqual(accessor(doc, 0), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(accessor(doc, 1), [0, 1, 2]);
  assert.deepEqual(accessor(doc, 2), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  // The padding is zeros.
  assert.equal(doc.bin!.getUint16(42, true), 0);
});

test("a writer with nothing in its buffer writes no BIN chunk", async () => {
  const gltf = new GltfWriter("empty");
  gltf.addScene([gltf.addNode({ name: "root", translation: [0, 1, 0] })]);
  const glb = gltf.toGlb();
  await assertValid(glb);
  const { json, bin } = readGlb(glb);
  assert.equal(bin, undefined);
  assert.equal(json.buffers, undefined);
  assert.deepEqual(json.nodes, [{ name: "root", translation: [0, 1, 0] }]);
});

test("a skinned mesh: joints, inverse bind matrices, JOINTS_0 and WEIGHTS_0", async () => {
  for (const [joints, weights, normalized] of [
    // Unsigned bytes and float weights...
    [
      new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      false,
    ],
    // ...and unsigned shorts with normalized unsigned byte weights.
    [
      new Uint16Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      new Uint8Array([255, 0, 0, 0, 128, 127, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
      true,
    ],
  ] as [GltfComponentArray, GltfComponentArray, boolean][]) {
    const gltf = new GltfWriter("skin");
    const { POSITION, indices } = quad(gltf);
    const JOINTS_0 = gltf.addAccessor({ data: joints, type: "VEC4", target: "ARRAY_BUFFER" });
    const WEIGHTS_0 = gltf.addAccessor({
      data: weights,
      type: "VEC4",
      target: "ARRAY_BUFFER",
      normalized,
    });
    // Column-major: the root joint at the origin, its child one unit up, so
    // the child's inverse bind matrix translates by -1 in y.
    const matrices = gltf.addAccessor({
      data: new Float32Array([
        ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1],
      ]),
      type: "MAT4",
    });
    const mesh = gltf.addMesh({
      primitives: [{ attributes: { POSITION, JOINTS_0, WEIGHTS_0 }, indices }],
    });
    const skin = gltf.addSkin({ name: "skin", inverseBindMatrices: matrices, joints: [2, 3] });
    const skinned = gltf.addNode({ name: "skinned", mesh, skin });
    const root = gltf.addNode({ name: "root", children: [2] });
    assert.equal(gltf.addNode({ name: "hip", children: [3] }), 2);
    gltf.addNode({ name: "spine", translation: [0, 1, 0] });
    gltf.addScene([skinned, root]);
    const glb = gltf.toGlb();
    await assertValid(glb);

    const doc = readGlb(glb);
    assert.deepEqual(doc.json.skins, [{ name: "skin", inverseBindMatrices: 4, joints: [2, 3] }]);
    assert.deepEqual(doc.json.nodes[0], { name: "skinned", mesh: 0, skin: 0 });
    assert.deepEqual(doc.json.nodes[2], { name: "hip", children: [3] });
    const [jointsJson, weightsJson, matricesJson] = [2, 3, 4].map((i) => doc.json.accessors[i]);
    assert.equal(jointsJson.componentType, joints instanceof Uint8Array ? 5121 : 5123);
    assert.equal(weightsJson.componentType, normalized ? 5121 : 5126);
    assert.equal(weightsJson.normalized, normalized ? true : undefined);
    assert.equal(jointsJson.normalized, undefined);
    assert.deepEqual([matricesJson.type, matricesJson.count], ["MAT4", 2]);
    // Inverse bind matrices are no vertex data: their view has no target.
    assert.equal(doc.json.bufferViews[matricesJson.bufferView].target, undefined);
    assert.deepEqual(accessor(doc, 2), Array.from(joints));
    assert.deepEqual(accessor(doc, 3), Array.from(weights));
    assert.deepEqual(accessor(doc, 4).slice(16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]);
  }
});

/** The quad with two morph targets of POSITION, NORMAL and TANGENT deltas. */
function morphed(gltf: GltfWriter, weights: number[]): number {
  const { POSITION, indices } = quad(gltf);
  const NORMAL = gltf.addAccessor({ data: UP, type: "VEC3", target: "ARRAY_BUFFER" });
  const TANGENT = gltf.addAccessor({ data: TANGENTS, type: "VEC4", target: "ARRAY_BUFFER" });
  const target = (dz: number): Record<string, number> => ({
    POSITION: gltf.addAccessor({
      data: new Float32Array([0, 0, dz, 0, 0, 0, 0, 0, dz, 0, 0, 0]),
      type: "VEC3",
      target: "ARRAY_BUFFER",
      bounds: true,
    }),
    NORMAL: gltf.addAccessor({ data: new Float32Array(12), type: "VEC3", target: "ARRAY_BUFFER" }),
    // Tangent deltas have no handedness: VEC3.
    TANGENT: gltf.addAccessor({
      data: new Float32Array(12),
      type: "VEC3",
      target: "ARRAY_BUFFER",
    }),
  });
  return gltf.addMesh({
    name: "morphed",
    primitives: [
      { attributes: { POSITION, NORMAL, TANGENT }, indices, targets: [target(1), target(-1)] },
    ],
    weights,
  });
}

test("morph targets: POSITION, NORMAL and TANGENT deltas, default weights", async () => {
  const gltf = new GltfWriter("morph");
  const mesh = morphed(gltf, [0.25, 0]);
  gltf.addScene([gltf.addNode({ name: "morphed", mesh, weights: [0.5, 0.5] })]);
  const glb = gltf.toGlb();
  await assertValid(glb);

  const doc = readGlb(glb);
  const [primitive] = doc.json.meshes[0].primitives;
  assert.deepEqual(primitive.targets, [
    { POSITION: 4, NORMAL: 5, TANGENT: 6 },
    { POSITION: 7, NORMAL: 8, TANGENT: 9 },
  ]);
  assert.deepEqual(doc.json.meshes[0].weights, [0.25, 0]);
  assert.deepEqual(doc.json.nodes[0].weights, [0.5, 0.5]);
  // glTF requires the bounds of a POSITION target, and no others.
  assert.deepEqual(doc.json.accessors[7].min, [0, 0, -1]);
  assert.deepEqual(doc.json.accessors[7].max, [0, 0, 0]);
  assert.equal(doc.json.accessors[5].min, undefined);
  assert.deepEqual(accessor(doc, 4), [0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
});

test("animations: LINEAR, STEP and CUBICSPLINE samplers on TRS and weights", async () => {
  const gltf = new GltfWriter("animation");
  const mesh = morphed(gltf, [0, 0]);
  const times = gltf.addAccessor({
    data: new Float32Array([0, 0.5, 1]),
    type: "SCALAR",
    bounds: true,
  });
  const translation = gltf.addAccessor({
    data: new Float32Array([0, 0, 0, 0, 1, 0, 0, 2, 0]),
    type: "VEC3",
  });
  const scale = gltf.addAccessor({
    data: new Float32Array([1, 1, 1, 2, 2, 2, 1, 1, 1]),
    type: "VEC3",
  });
  const none = [0, 0, 0, 0];
  // CUBICSPLINE: in-tangent, value, out-tangent per keyframe.
  const rotation = gltf.addAccessor({
    data: new Float32Array(
      [0, Math.PI / 2, Math.PI].flatMap((angle) => [...none, ...aroundZ(angle), ...none]),
    ),
    type: "VEC4",
  });
  // Two morph targets: two weights per keyframe.
  const weights = gltf.addAccessor({ data: new Float32Array([0, 0, 1, 0, 0, 1]), type: "SCALAR" });
  const node = gltf.addNode({ name: "morphed", mesh });
  gltf.addScene([node]);
  gltf.addAnimation({
    name: "take",
    channels: [
      { sampler: 0, target: { node, path: "translation" } },
      { sampler: 1, target: { node, path: "scale" } },
      { sampler: 2, target: { node, path: "rotation" } },
      { sampler: 3, target: { node, path: "weights" } },
    ],
    samplers: [
      { input: times, output: translation },
      { input: times, interpolation: "STEP", output: scale },
      { input: times, interpolation: "CUBICSPLINE", output: rotation },
      { input: times, interpolation: "LINEAR", output: weights },
    ],
  });
  const glb = gltf.toGlb();
  await assertValid(glb);

  const doc = readGlb(glb);
  const [animation] = doc.json.animations;
  assert.equal(animation.name, "take");
  assert.deepEqual(animation.channels[2], { sampler: 2, target: { node: 0, path: "rotation" } });
  assert.deepEqual(
    animation.samplers.map((s: Json) => s.interpolation),
    [undefined, "STEP", "CUBICSPLINE", "LINEAR"],
  );
  // The keyframe times carry their bounds; no keyframe view has a target.
  assert.deepEqual([doc.json.accessors[times].min, doc.json.accessors[times].max], [[0], [1]]);
  for (const i of [times, translation, scale, rotation, weights]) {
    assert.equal(doc.json.bufferViews[doc.json.accessors[i].bufferView].target, undefined);
  }
  assert.equal(doc.json.accessors[rotation].count, 9);
  assert.deepEqual(accessor(doc, rotation).slice(16, 20), aroundZ(Math.PI / 2));
});

test("accessor data glTF cannot hold throws UnsupportedError", () => {
  const gltf = new GltfWriter("bad");
  assert.throws(() => gltf.addAccessor({ data: new Float32Array(0), type: "SCALAR" }), {
    name: "UnsupportedError",
    message: /0 components.*at least one/,
  });
  assert.throws(() => gltf.addAccessor({ data: new Float32Array(4), type: "VEC3" }), {
    message: /4 components.*whole number of elements/,
  });
  assert.throws(() => gltf.addAccessor({ data: new Float32Array([0, NaN]), type: "VEC2" }), {
    message: /NaN.*component 1/,
  });
  const clamped = new Uint8ClampedArray(4) as unknown as Uint8Array;
  assert.throws(() => gltf.addAccessor({ data: clamped, type: "VEC4" }), {
    message: /Uint8ClampedArray/,
  });
  assert.throws(
    () => gltf.addAccessor({ data: new Float32Array(4), type: "VEC4", normalized: true }),
    { message: /32-bit components.*only 8- and 16-bit integer components/ },
  );
  // Vertex attributes are 4-byte aligned: 3-byte and 6-byte elements need padding.
  assert.throws(
    () => gltf.addAccessor({ data: new Uint8Array(6), type: "VEC3", target: "ARRAY_BUFFER" }),
    { message: /VEC3 of 8-bit components, 3 bytes.*multiple of 4 bytes/ },
  );
  assert.throws(
    () => gltf.addAccessor({ data: new Int16Array(3), type: "VEC3", target: "ARRAY_BUFFER" }),
    { message: /VEC3 of 16-bit components, 6 bytes/ },
  );
  // 4-byte elements, and index data, are fine.
  gltf.addAccessor({ data: new Uint8Array(8), type: "VEC4", target: "ARRAY_BUFFER" });
  gltf.addAccessor({ data: new Uint16Array(3), type: "SCALAR", target: "ELEMENT_ARRAY_BUFFER" });
});

test("a rotation channel of normalized 16-bit quaternions is valid", async () => {
  const gltf = new GltfWriter("normalized");
  const node = gltf.addNode({ name: "spun" });
  gltf.addScene([node]);
  const input = gltf.addAccessor({ data: new Float32Array([0, 1]), type: "SCALAR", bounds: true });
  const output = gltf.addAccessor({
    data: new Int16Array([0, 0, 0, 32767, 0, 0, 23170, 23170]),
    type: "VEC4",
    normalized: true,
  });
  gltf.addAnimation({
    channels: [{ sampler: 0, target: { node, path: "rotation" } }],
    samplers: [{ input, output }],
  });
  const glb = gltf.toGlb();
  await assertValid(glb);
  assert.deepEqual(readGlb(glb).json.accessors[output].normalized, true);
});

test("a file breaking a glTF rule throws UnsupportedError from toGlb()", () => {
  type Build = (gltf: GltfWriter, a: { POSITION: number; indices: number }) => void;
  const cases: [string, Build, RegExp][] = [
    [
      "an accessor past the added ones",
      (g, a) => g.addMesh({ primitives: [{ attributes: { POSITION: 9 }, indices: a.indices }] }),
      /mesh 0 primitive 0 POSITION: 9 \(2 accessors were added\)/,
    ],
    [
      "a mesh without primitives",
      (g) => g.addMesh({ primitives: [] }),
      /mesh 0 primitives: empty list/,
    ],
    [
      "a skin on a node without a mesh",
      (g) => {
        g.addSkin({ joints: [0] });
        g.addNode({ skin: 0 });
      },
      /node 0 skin: 0 \(a node with a skin needs a mesh\)/,
    ],
    [
      "a skin without joints",
      (g) => g.addSkin({ joints: [] }),
      /skin 0 joints: empty list/,
    ],
    [
      "inverse bind matrices not one per joint",
      (g) => {
        const matrices = g.addAccessor({ data: new Float32Array(16), type: "MAT4" });
        g.addNode({});
        g.addSkin({ joints: [0, 0], inverseBindMatrices: matrices });
      },
      /skin 0 inverseBindMatrices: 1 matrices \(one per joint, 2\)/,
    ],
    [
      "mesh weights not one per morph target",
      (g, a) =>
        g.addMesh({
          primitives: [
            { attributes: { POSITION: a.POSITION }, targets: [{ POSITION: a.POSITION }] },
          ],
          weights: [0, 0],
        }),
      /mesh 0 weights: 2 \(one per morph target, 1\)/,
    ],
    [
      "primitives with different morph target counts",
      (g, a) =>
        g.addMesh({
          primitives: [
            { attributes: { POSITION: a.POSITION }, targets: [{ POSITION: a.POSITION }] },
            { attributes: { POSITION: a.POSITION } },
          ],
        }),
      /mesh 0: 1 and 0 \(every primitive needs as many morph targets\)/,
    ],
    [
      "node weights not one per morph target",
      (g, a) => {
        g.addMesh({ primitives: [{ attributes: { POSITION: a.POSITION } }] });
        g.addNode({ mesh: 0, weights: [1] });
      },
      /node 0 weights: 1 \(one per morph target of mesh 0\)/,
    ],
    [
      "a NaN translation",
      (g) => g.addNode({ translation: [0, NaN, 0] }),
      /node 0 translation: NaN/,
    ],
    [
      "a scene node past the added ones",
      (g) => g.addScene([0]),
      /scene 0 node: 0 \(0 nodes were added\)/,
    ],
    [
      "a sampler input without bounds",
      (g) => {
        const t = g.addAccessor({ data: new Float32Array([0, 1]), type: "SCALAR" });
        g.addNode({});
        g.addAnimation({
          channels: [{ sampler: 0, target: { node: 0, path: "scale" } }],
          samplers: [{ input: t, output: a(g, 6) }],
        });
      },
      /sampler 0 input: accessor 2 \(written without bounds\)/,
    ],
    [
      "a LINEAR output not one per keyframe",
      (g) => animate(g, "LINEAR", 2, 9),
      /channel 0 scale output: 3 values for 2 keyframes \(one per keyframe, 2\)/,
    ],
    [
      "a TRS output of a multiple of the keyframes",
      (g) => animate(g, "LINEAR", 2, 12),
      /channel 0 scale output: 4 values for 2 keyframes \(one per keyframe, 2\)/,
    ],
    [
      "a CUBICSPLINE output not 3 per keyframe",
      (g) => animate(g, "CUBICSPLINE", 2, 12),
      /channel 0 scale output: 4 values for 2 keyframes \(3 times one per keyframe .*, 6\)/,
    ],
    [
      "a CUBICSPLINE sampler with one keyframe",
      (g) => animate(g, "CUBICSPLINE", 1, 9),
      /sampler 0 input: 1 keyframes \(CUBICSPLINE needs 2\)/,
    ],
    [
      "a weights output not one per keyframe and morph target",
      (g, a) => {
        const targets = [{ POSITION: a.POSITION }, { POSITION: a.POSITION }];
        g.addMesh({ primitives: [{ attributes: { POSITION: a.POSITION }, targets }] });
        g.addNode({ mesh: 0 });
        const weights = g.addAccessor({ data: new Float32Array(2), type: "SCALAR" });
        channel(g, "weights", weights);
      },
      /channel 0 weights output: 2 values for 2 keyframes \(2 \(one per morph target\) per keyframe, 4\)/,
    ],
    [
      "a weights channel on a mesh without morph targets",
      (g, a) => {
        g.addMesh({ primitives: [{ attributes: { POSITION: a.POSITION } }] });
        g.addNode({ mesh: 0 });
        channel(g, "weights", g.addAccessor({ data: new Float32Array(2), type: "SCALAR" }));
      },
      /channel 0 node: 0 \(a weights channel needs a node whose mesh has morph targets\)/,
    ],
    [
      "a rotation output of VEC3",
      (g) => {
        g.addNode({});
        channel(g, "rotation", a(g, 6));
      },
      /channel 0 rotation output: VEC3 \(rotation takes VEC4\)/,
    ],
    [
      "a translation output of normalized integers",
      (g) => {
        g.addNode({});
        const shorts = new Int16Array(6);
        channel(g, "translation", g.addAccessor({ data: shorts, type: "VEC3", normalized: true }));
      },
      /channel 0 translation output: component type 5122 \(translation takes FLOAT\)/,
    ],
    [
      "a rotation output of integers not normalized",
      (g) => {
        g.addNode({});
        channel(g, "rotation", g.addAccessor({ data: new Int16Array(8), type: "VEC4" }));
      },
      /rotation output: component type 5122 \(rotation takes FLOAT or normalized/,
    ],
    [
      "sampler input not FLOAT",
      (g) => {
        const t = g.addAccessor({ data: new Uint16Array([0, 1]), type: "SCALAR", bounds: true });
        g.addNode({});
        g.addAnimation({
          channels: [{ sampler: 0, target: { node: 0, path: "scale" } }],
          samplers: [{ input: t, output: a(g, 6) }],
        });
      },
      /sampler 0 input: accessor 2 \(keyframe times are FLOAT SCALAR\)/,
    ],
    [
      "node weights without a mesh",
      (g) => g.addNode({ weights: [1] }),
      /node 0 weights: 1 \(a node with weights needs a mesh\)/,
    ],
    [
      "an animation without samplers",
      (g) => {
        g.addNode({});
        g.addAnimation({
          channels: [{ sampler: 0, target: { node: 0, path: "scale" } }],
          samplers: [],
        });
      },
      /animation 0 samplers: empty list/,
    ],
  ];
  for (const [what, build, message] of cases) {
    const gltf = new GltfWriter("bad");
    build(gltf, quad(gltf));
    assert.throws(() => gltf.toGlb(), (error: unknown) => {
      assert.ok(error instanceof UnsupportedError, what);
      assert.match(error.message, message, what);
      return true;
    });
  }
});

/** A VEC3 float accessor of `floats` components (zeros). */
function a(gltf: GltfWriter, floats: number): number {
  return gltf.addAccessor({ data: new Float32Array(floats), type: "VEC3" });
}

/** An animation of node 0's `path` from `output`, over 2 LINEAR keyframes. */
function channel(
  gltf: GltfWriter,
  path: "translation" | "rotation" | "scale" | "weights",
  output: number,
): void {
  const input = gltf.addAccessor({ data: new Float32Array([0, 1]), type: "SCALAR", bounds: true });
  gltf.addAnimation({
    channels: [{ sampler: 0, target: { node: 0, path } }],
    samplers: [{ input, output }],
  });
}

/** An animation of one scale sampler: `keys` keyframes, `floats` output components. */
function animate(
  gltf: GltfWriter,
  interpolation: "LINEAR" | "CUBICSPLINE",
  keys: number,
  floats: number,
): void {
  const times = Float32Array.from({ length: keys }, (_, i) => i);
  const input = gltf.addAccessor({ data: times, type: "SCALAR", bounds: true });
  gltf.addNode({});
  gltf.addAnimation({
    channels: [{ sampler: 0, target: { node: 0, path: "scale" } }],
    samplers: [{ input, interpolation, output: a(gltf, floats) }],
  });
}
