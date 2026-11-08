// sceneToGltf (#306) on the #305 scene bundles, against AssetStudio c37af7d's
// ModelConverter (the "models" of the export goldens, fixtures/BUILDING.md
// section 27), clipCurves() and the Khronos glTF validator.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as gltfValidator from "gltf-validator";
import type { Animator, Env, GameObject, ObjectReader } from "unity-asset-reader";
import { clipCurves, sceneToGltf } from "../src/index.js";
import { bits, fixtureEnv } from "./helpers.js";

/** What the harness dumped of new ModelConverter(Animator, Options, clips), floats as bits. */
interface ModelDump {
  root: string;
  frames: { path: string; translation: string; rotation: string; scale: string }[];
  meshes: { path: string; vertexCount: number; vertices: string; bones: { path: string; matrix: string }[] }[];
  morphs: {
    path: string;
    channels: {
      name: string;
      keyframes: { weight: string; hasNormals: boolean; hasTangents: boolean; vertices: string }[];
    }[];
  }[];
  clips: string[];
  animations?: {
    name: string;
    tracks: {
      path: string;
      translations: string;
      rotations: string;
      scalings: string;
      blendShape: { channel: string; keys: string } | null;
    }[];
  }[];
  unreadObjects?: Record<string, number>;
  verdict?: string;
  exportError?: string;
  animationsError?: string;
}

const models = (
  JSON.parse(
    readFileSync(
      new URL("../../../fixtures/assetstudio-export-goldens.json", import.meta.url),
      "utf8",
    ),
  ) as { models: Record<string, Record<string, Record<string, ModelDump>>> }
).models;

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
const VARIANTS = ["lz4", "lz4-notypetree"];
const fixture = (editor: string, variant: string) => `editor/${editor}/scene/${variant}/scene`;

/** The Animator on the GameObject `scene`, the ModelConverter dumps' root. */
function animatorOf(env: Env): ObjectReader {
  const animator = env.objects.find((o) => {
    if (o.type !== 95) return false;
    const go = env.resolve(o.read<Animator>().m_GameObject, o);
    return go.status === "found" && go.object.read<GameObject>().m_Name === "scene";
  });
  if (!animator) throw new Error("no Animator on the GameObject scene");
  return animator;
}

const clipsOf = (env: Env) => env.objects.filter((o) => o.type === 74);

interface Gltf {
  json: {
    nodes: { name: string; children?: number[]; mesh?: number; skin?: number; weights?: number[];
      translation: number[]; rotation: number[]; scale: number[] }[];
    meshes: { primitives: { attributes: Record<string, number>; targets?: Record<string, number>[] }[] }[];
    skins: { joints: number[]; inverseBindMatrices: number }[];
    animations: {
      name: string;
      channels: { sampler: number; target: { node: number; path: string } }[];
      samplers: { input: number; output: number; interpolation: string }[];
    }[];
    scenes: { nodes: number[] }[];
  };
  /** An accessor's components. */
  data: (accessor: number) => number[];
  /** Each node's names from the scene root joined with "/". */
  paths: string[];
}

function parse(glb: Uint8Array): Gltf {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  const bin = 20 + length + 8;
  const data = (index: number) => {
    const a = json.accessors[index];
    const v = json.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type as string]!;
    const out: number[] = [];
    for (let i = 0; i < a.count * width; i++) {
      const at = bin + v.byteOffset + i * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2);
      out.push(a.componentType === 5126 ? view.getFloat32(at, true)
        : a.componentType === 5123 ? view.getUint16(at, true) : view.getUint32(at, true));
    }
    return out;
  };
  const paths: string[] = [];
  const walk = (node: number, parent: string | undefined) => {
    const path = parent === undefined ? json.nodes[node].name : `${parent}/${json.nodes[node].name}`;
    paths[node] = path;
    for (const child of json.nodes[node].children ?? []) walk(child, path);
  };
  for (const root of json.scenes[0].nodes) walk(root, undefined);
  return { json, data, paths };
}

/** A hex string of float32 bits as 8-digit words. */
const words = (hex: string): string[] => hex.match(/.{8}/g) ?? [];
/** Bits with the sign of zero dropped: JSON numbers and C#'s sums of products carry none. */
const z = (b: string) => (b === "80000000" ? "00000000" : b);
const zs = (list: string[]) => list.map(z);
const hexOf = (values: number[]) => values.map(bits);

/** The scene fixtures ModelConverter has a dump for: 2019.4, 2020.3, 6000.3 (and what else c37af7d reads). */
const dumped = Object.keys(models).filter((key) => /^editor\/[^/]+\/scene\//.test(key));

const exported = new Map<string, Gltf>();
function exportOf(key: string): Gltf {
  let gltf = exported.get(key);
  if (!gltf) {
    const env = fixtureEnv(key);
    exported.set(key, (gltf = parse(sceneToGltf(env, animatorOf(env), { clips: clipsOf(env) }))));
  }
  return gltf;
}

function dumpOf(key: string): ModelDump {
  const files = Object.values(models[key]!);
  const dumps = files.flatMap((f) => Object.values(f));
  assert.equal(dumps.length, 1, `${key}: one ModelConverter dump`);
  assert.equal(dumps[0]!.exportError, undefined, `${key}: ${dumps[0]!.exportError}`);
  return dumps[0]!;
}

test("the oracle has a ModelConverter dump of the scene for 2019.4, 2020.3 and 6000.3, both builds", () => {
  for (const editor of EDITORS.slice(0, 3)) {
    for (const variant of VARIANTS) assert.ok(dumped.includes(fixture(editor, variant)), fixture(editor, variant));
  }
});

test("every scene bundle exports a .glb the Khronos validator finds no error in", async () => {
  for (const editor of EDITORS) {
    for (const variant of VARIANTS) {
      const env = fixtureEnv(fixture(editor, variant));
      const glb = sceneToGltf(env, animatorOf(env), { clips: clipsOf(env) });
      const report = await gltfValidator.validateBytes(glb);
      const errors = report.issues.messages.filter((m) => m.severity === 0);
      assert.deepEqual(errors, [], fixture(editor, variant));
    }
  }
});

test("node TRS equal ModelConverter's frames, float32 bits", () => {
  for (const key of dumped) {
    const { json, paths } = exportOf(key);
    const dump = dumpOf(key);
    assert.deepEqual(new Set(paths), new Set(dump.frames.map((f) => f.path)), key);
    for (const frame of dump.frames) {
      const node = json.nodes[paths.indexOf(frame.path)]!;
      assert.deepEqual(zs(hexOf(node.translation)), zs(words(frame.translation)), `${key} ${frame.path}`);
      assert.deepEqual(zs(hexOf(node.rotation)), zs(words(frame.rotation)), `${key} ${frame.path}`);
      assert.deepEqual(zs(hexOf(node.scale)), zs(words(frame.scale)), `${key} ${frame.path}`);
    }
  }
});

/** The node a ModelConverter path names: the node path it ends with. */
function nodeOf(gltf: Gltf, path: string): number {
  const found = gltf.paths.findIndex((p) => p === path || path.endsWith(`/${p}`) || p.endsWith(`/${path}`));
  assert.ok(found >= 0, `no node for ${path}`);
  return found;
}

test("skin joints, inverse bind matrices and vertices equal ModelConverter's, float32 bits", () => {
  let compared = 0;
  for (const key of dumped) {
    const dump = dumpOf(key);
    if (dump.verdict) {
      // 6000.3: c37af7d reads no renderer, so it converts no mesh (the verdict).
      assert.deepEqual(dump.meshes, [], key);
      continue;
    }
    const gltf = exportOf(key);
    for (const mesh of dump.meshes) {
      const node = gltf.json.nodes[nodeOf(gltf, mesh.path)]!;
      const primitive = gltf.json.meshes[node.mesh!]!.primitives[0]!;
      assert.deepEqual(hexOf(gltf.data(primitive.attributes.POSITION!)), words(mesh.vertices), key);
      compared++;
      if (mesh.bones.length === 0) {
        assert.equal(node.skin, undefined);
        continue;
      }
      const skin = gltf.json.skins[node.skin!]!;
      assert.deepEqual(
        skin.joints.map((j) => gltf.paths[j]),
        mesh.bones.map((b) => gltf.paths[nodeOf(gltf, b.path)]),
        `${key} joint order`,
      );
      const matrices = gltf.data(skin.inverseBindMatrices);
      mesh.bones.forEach((bone, i) => {
        // glTF column-major (c * 4 + r); the dump in Unity's order, eRC row by row.
        const want = words(bone.matrix);
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            assert.equal(z(bits(matrices[i * 16 + c * 4 + r]!)), z(want[r * 4 + c]!), `${key} bone ${i} e${r}${c}`);
          }
        }
      });
    }
  }
  assert.equal(compared, 2 * 2 * 2, "the Skin and the Prop mesh of 2019.4 and 2020.3, both builds");
});

test("morph targets are ModelConverter's morph vertices of each channel's last frame", () => {
  let compared = 0;
  for (const key of dumped) {
    const dump = dumpOf(key);
    if (dump.verdict) continue;
    const gltf = exportOf(key);
    for (const morph of dump.morphs) {
      const node = gltf.json.nodes[nodeOf(gltf, morph.path)]!;
      const primitive = gltf.json.meshes[node.mesh!]!.primitives[0]!;
      const base = gltf.data(primitive.attributes.POSITION!);
      assert.equal(primitive.targets!.length, morph.channels.length);
      morph.channels.forEach((channel, t) => {
        const frame = channel.keyframes.at(-1)!;
        const target = primitive.targets![t]!;
        const delta = gltf.data(target.POSITION!);
        const normal = target.NORMAL === undefined ? undefined : gltf.data(target.NORMAL);
        assert.equal(frame.hasNormals, normal !== undefined);
        const listed = new Set<number>();
        for (const v of frame.vertices.match(/.{88}/g)!) {
          const index = parseInt(v.slice(0, 8), 16);
          listed.add(index);
          const [px, py, pz, nx, ny, nz] = words(v.slice(8));
          // ModelConverter keeps the morphed position, base + delta: so does float32 addition here.
          const sum = [0, 1, 2].map((d) => bits(Math.fround(base[index * 3 + d]! + delta[index * 3 + d]!)));
          assert.deepEqual(sum, [px, py, pz], `${key} ${channel.name} vertex ${index}`);
          if (normal) assert.deepEqual(hexOf(normal.slice(index * 3, index * 3 + 3)), [nx, ny, nz]);
        }
        // The vertices the frame does not list do not move.
        delta.forEach((d, i) => listed.has(Math.floor(i / 3)) || assert.equal(d, 0));
        // The node's weights are the renderer's over the full weight (fixtures/BUILDING.md section 24).
        assert.equal(frame.weight, bits(100));
      });
      assert.deepEqual(node.weights, [0.25, 0.6]);
      compared++;
    }
  }
  assert.equal(compared, 4, "the Skin of 2019.4 and 2020.3, both builds");
});

/** Our sampler of a channel: its times and each key's [in, value, out] components. */
function samplerOf(gltf: Gltf, animation: string, node: number, path: string, width: number) {
  const anim = gltf.json.animations.find((a) => a.name === animation)!;
  const channel = anim.channels.find((c) => c.target.node === node && c.target.path === path);
  assert.ok(channel, `${animation}: no ${path} channel on node ${gltf.paths[node]}`);
  const sampler = anim.samplers[channel.sampler]!;
  assert.equal(sampler.interpolation, "CUBICSPLINE");
  const times = gltf.data(sampler.input);
  const output = gltf.data(sampler.output);
  const keys = times.map((_, k) => ({
    inTangent: output.slice((3 * k) * width, (3 * k + 1) * width),
    value: output.slice((3 * k + 1) * width, (3 * k + 2) * width),
    outTangent: output.slice((3 * k + 2) * width, (3 * k + 3) * width),
  }));
  return { times, keys };
}

/** clipCurves' channels of a clip as glTF writes them: [path, glTF path, keys of converted components]. */
function expectedChannels(env: Env, clip: ObjectReader) {
  const c = clipCurves(env, clip);
  const out: { path: string; target: string; keys: { time: number; value: number[]; inSlope: number[]; outSlope: number[] }[] }[] = [];
  const conv = <T>(list: { path: string; keyframes: { time: number; value: T; inSlope: T; outSlope: T }[] }[],
    target: string, f: (v: T) => number[]) => {
    for (const curve of list) {
      out.push({ path: curve.path, target, keys: curve.keyframes.map((k) => ({
        time: k.time, value: f(k.value), inSlope: f(k.inSlope), outSlope: f(k.outSlope),
      })) });
    }
  };
  conv(c.position, "translation", (v) => [-v.x, v.y, v.z]);
  conv(c.rotation, "rotation", (q) => [q.x, -q.y, -q.z, q.w]);
  conv(c.scale, "scale", (v) => [v.x, v.y, v.z]);
  return { channels: out, float: c.float };
}

test("sampler values at the keys equal clipCurves() and ModelConverter's tracks, float32 bits", () => {
  let tracks = 0;
  for (const key of dumped) {
    const env = fixtureEnv(key);
    const gltf = exportOf(key);
    const dump = dumpOf(key);
    for (const clip of clipsOf(env)) {
      const name = clip.read<{ m_Name: string }>().m_Name;
      const { channels, float } = expectedChannels(env, clip);
      for (const ch of channels) {
        const node = nodeOf(gltf, ch.path);
        const width = ch.keys[0]!.value.length;
        const ours = samplerOf(gltf, name, node, ch.target, width);
        assert.deepEqual(ours.times, ch.keys.map((k) => k.time), `${key} ${name} ${ch.path}`);
        ch.keys.forEach((k, i) => {
          const at = ours.keys[i]!;
          assert.deepEqual(hexOf(at.value), hexOf(k.value), `${key} ${name} ${ch.path} key ${i}`);
          // Tangents are Unity's slopes; one no segment uses or an infinite one (a held segment) is 0.
          const prev = ch.keys[i - 1];
          const next = ch.keys[i + 1];
          for (let d = 0; d < width; d++) {
            const held = (a: typeof k, b: typeof k) =>
              !Number.isFinite(a.outSlope[d]!) || !Number.isFinite(b.inSlope[d]!);
            const wantIn = !prev || held(prev, k) ? 0 : k.inSlope[d]!;
            const wantOut = !next || held(k, next) ? 0 : k.outSlope[d]!;
            assert.equal(bits(at.inTangent[d]!), bits(wantIn), `${key} ${name} ${ch.path} key ${i} in ${d}`);
            assert.equal(bits(at.outTangent[d]!), bits(wantOut), `${key} ${name} ${ch.path} key ${i} out ${d}`);
          }
        });
        // ModelConverter's track of the path: the same values at the same times.
        const animation = dump.animations?.find((a) => a.name === name);
        if (!animation) {
          // 6000.6 without type trees: c37af7d reads its clips only in part, and
          // ModelConverter fails on them.
          assert.ok(dump.unreadObjects?.AnimationClip, `${key}: no ModelConverter animation ${name}`);
          continue;
        }
        const track = animation.tracks.find((t) => t.blendShape === null && nodeOf(gltf, t.path) === node)!;
        const field = { translation: "translations", rotation: "rotations", scale: "scalings" }[ch.target] as
          "translations" | "rotations" | "scalings";
        const theirs = words(track[field]);
        const stride = 1 + width;
        assert.equal(theirs.length, ours.times.length * stride, `${key} ${name} ${ch.path} ${field}`);
        ours.times.forEach((t, i) => {
          assert.deepEqual([bits(t), ...hexOf(ours.keys[i]!.value)], theirs.slice(i * stride, (i + 1) * stride));
        });
        tracks++;
      }
      // Blend shape weights: one channel on the Skin node, over the full weight 100.
      const shapes = float.filter((f) => f.classId === 137 && f.attribute.startsWith("blendShape."));
      if (shapes.length > 0) {
        const node = nodeOf(gltf, shapes[0]!.path);
        const ours = samplerOf(gltf, name, node, "weights", 2);
        const order = ["smile", "blink"];
        for (const curve of shapes) {
          const t = order.indexOf(curve.attribute.slice("blendShape.".length));
          for (const k of curve.keyframes) {
            const i = ours.times.indexOf(k.time);
            assert.ok(i >= 0, `${key} ${curve.attribute} key at ${k.time}`);
            assert.equal(bits(ours.keys[i]!.value[t]!), bits(Math.fround(k.value / 100)));
          }
          const animation = dump.animations?.find((a) => a.name === name);
          const track = animation?.tracks.find((tr) => tr.blendShape?.channel === order[t]);
          if (dump.verdict) {
            // 6000.3: no renderer read, so no morph channel names the curve's hash.
            assert.equal(track, undefined);
            continue;
          }
          const theirs = words(track!.blendShape!.keys);
          for (let j = 0; j < theirs.length; j += 2) {
            const time = new Float32Array(new Uint32Array([parseInt(theirs[j]!, 16)]).buffer)[0]!;
            const value = new Float32Array(new Uint32Array([parseInt(theirs[j + 1]!, 16)]).buffer)[0]!;
            const i = ours.times.indexOf(time);
            assert.ok(i >= 0);
            assert.equal(bits(ours.keys[i]!.value[t]!), bits(Math.fround(value / 100)));
          }
          tracks++;
        }
      }
    }
  }
  // 2019.4 and 2020.3: 5 tracks per build; 6000.3: the 3 transform tracks per build.
  assert.ok(tracks >= 4 * 5 + 2 * 3, `${tracks} tracks compared`);
});

/** Unity's Hermite segment, written out independently of src/cubic.ts. */
function unityHermite(t0: number, v0: number, out0: number, t1: number, v1: number, in1: number, t: number) {
  if (!Number.isFinite(out0) || !Number.isFinite(in1)) return v0;
  const dt = t1 - t0;
  const s = (t - t0) / dt;
  const a = 2 * v0 - 2 * v1 + (out0 + in1) * dt;
  const b = -3 * v0 + 3 * v1 - (2 * out0 + in1) * dt;
  return ((a * s + b) * s + out0 * dt) * s + v0;
}

test("between the keys the glTF cubic spline matches Unity's Hermite curve within 1e-6", () => {
  // The glTF 2.0 spec's spline (Appendix C) on the file's float32 data, against the
  // Hermite cubic of clipCurves' keys: both evaluated in double, so they differ only by
  // the rounding of the blend shape weights to float32 after the division by 100.
  const TOLERANCE = 1e-6;
  let compared = 0;
  for (const key of [fixture("2019.4.41f2", "lz4"), fixture("6000.6.4f1", "lz4")]) {
    const env = fixtureEnv(key);
    const gltf = exportOf(key);
    for (const clip of clipsOf(env)) {
      const name = clip.read<{ m_Name: string }>().m_Name;
      for (const ch of expectedChannels(env, clip).channels) {
        const width = ch.keys[0]!.value.length;
        const ours = samplerOf(gltf, name, nodeOf(gltf, ch.path), ch.target, width);
        for (let i = 0; i + 1 < ch.keys.length; i++) {
          const [a, b] = [ch.keys[i]!, ch.keys[i + 1]!];
          for (const s of [0.25, 0.5, 0.75]) {
            const t = a.time + s * (b.time - a.time);
            const td = b.time - a.time;
            for (let d = 0; d < width; d++) {
              const p0 = ours.keys[i]!;
              const p1 = ours.keys[i + 1]!;
              const gl = (2 * s ** 3 - 3 * s ** 2 + 1) * p0.value[d]! + td * (s ** 3 - 2 * s ** 2 + s) * p0.outTangent[d]! +
                (-2 * s ** 3 + 3 * s ** 2) * p1.value[d]! + td * (s ** 3 - s ** 2) * p1.inTangent[d]!;
              const unity = unityHermite(a.time, a.value[d]!, a.outSlope[d]!, b.time, b.value[d]!, b.inSlope[d]!, t);
              assert.ok(Math.abs(gl - unity) <= TOLERANCE, `${key} ${name} ${ch.path} d${d} at ${t}: ${gl} vs ${unity}`);
              compared++;
            }
          }
        }
      }
    }
  }
  assert.ok(compared > 0);
});

/**
 * What a file holds, accessor indices replaced by their data and animations
 * by name: the editors store the clips in another order, so the accessors
 * come in another order too.
 */
function semantic(g: Gltf) {
  const { nodes, meshes, skins, animations } = g.json;
  return {
    nodes: nodes.map((n, i) => ({ ...n, path: g.paths[i] })),
    meshes: meshes.map((m) => m.primitives.map((p) => ({
      attributes: Object.entries(p.attributes).map(([k, v]) => [k, g.data(v)]),
      targets: p.targets?.map((t) => Object.entries(t).map(([k, v]) => [k, g.data(v)])),
    }))),
    skins: skins.map((s) => ({ joints: s.joints, inverseBindMatrices: g.data(s.inverseBindMatrices) })),
    animations: Object.fromEntries(animations.map((a) => [a.name, a.channels.map((c) => {
      const sampler = a.samplers[c.sampler]!;
      return { target: [g.paths[c.target.node], c.target.path], interpolation: sampler.interpolation,
        input: g.data(sampler.input), output: g.data(sampler.output) };
    })])),
  };
}

test("the four editors' scenes export the same glTF, typed and not, 6000.6 included", () => {
  const reference = semantic(exportOf(fixture("2019.4.41f2", "lz4")));
  for (const editor of EDITORS) {
    for (const variant of VARIANTS) {
      assert.deepEqual(semantic(exportOf(fixture(editor, variant))), reference, fixture(editor, variant));
    }
  }
});

test("muscle curves and m_IsActive are skipped: the humanoid clip writes no animation", () => {
  const gltf = exportOf(fixture("2019.4.41f2", "lz4"));
  const names = gltf.json.animations.map((a) => a.name);
  assert.deepEqual(names.sort(), ["move", "smile"]);
  const move = gltf.json.animations.find((a) => a.name === "move")!;
  // Hips translation, Spine rotation, Chest scale; the Prop's m_IsActive has no channel.
  assert.deepEqual(
    move.channels.map((c) => `${gltf.paths[c.target.node]} ${c.target.path}`),
    ["scene/Armature/Hips translation", "scene/Armature/Hips/Spine rotation", "scene/Armature/Hips/Spine/Chest scale"],
  );
});
