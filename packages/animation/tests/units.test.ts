// The ported pieces on their own (#304): CRC-32, muscle names, the path tables,
// the streamed frames, and the discrete-curve offset no fixture reaches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CorruptError, type AnimationClip, type GenericBinding } from "unity-asset-reader";
import { convertMuscleClip } from "../src/converter.js";
import { crc32 } from "../src/crc.js";
import { clipCurves, muscleName } from "../src/index.js";
import { readStreamedFrames } from "../src/streamed.js";
import { buildTOS, CLASS, findTOS, Scene } from "../src/tos.js";
import { fixtureEnv } from "./helpers.js";

const SCENE = "editor/2019.4.41f2/scene/lz4/scene";
const nullPtr = { m_FileID: 0, m_PathID: 0n };

test("crc32 is the CRC-32 of the UTF-8 bytes, as Unity hashes names", () => {
  assert.equal(crc32(""), 0);
  assert.equal(crc32("123456789"), 0xcbf43926);
  // The scene's `move` clip binds GameObject.m_IsActive by this hash.
  assert.equal(crc32("m_IsActive"), 2086281974);
  // Non-ASCII through UTF-8; a lone surrogate as U+FFFD, as .NET encodes it.
  assert.equal(crc32("é"), crc32("é"));
  assert.equal(crc32("\ud800"), crc32("�"));
});

test("muscleName names each range of AssetStudio's HumanoidMuscleType", () => {
  assert.equal(muscleName(0), "MotionT.x");
  assert.equal(muscleName(8), "RootT.y");
  assert.equal(muscleName(13), "RootQ.w");
  assert.equal(muscleName(14), "LeftFootT.x");
  assert.equal(muscleName(41), "RightHandQ.w");
  assert.equal(muscleName(42), "Spine Front-Back");
  assert.equal(muscleName(81), "Left Arm Down-Up");
  assert.equal(muscleName(96), "Right Hand In-Out");
  assert.equal(muscleName(97), "LeftHand.Thumb.1 Stretched");
  assert.equal(muscleName(118), "RightHand.Thumb.Spread");
  assert.equal(muscleName(120), "RightHand.Thumb.3 Stretched");
  assert.equal(muscleName(136), "RightHand.Little.3 Stretched");
  assert.equal(muscleName(137), "SpineTDOF.x");
  assert.equal(muscleName(199), "RightHandTDOF.z");
  assert.throws(() => muscleName(200), /past the last one/);
});

test("buildTOS names an Animator's hierarchy by the CRC-32 of each child path", () => {
  const env = fixtureEnv(SCENE);
  const scene = new Scene(env);
  const paths = new Set<string>();
  for (const go of env.objects.filter((o) => o.type === CLASS.GameObject)) {
    for (const [hash, path] of buildTOS(scene, go)) {
      assert.equal(hash, crc32(path), path);
      paths.add(path);
    }
  }
  assert.ok(paths.has(""));
  assert.ok(paths.has("Armature/Hips/Spine/Chest"), [...paths].join(", "));
});

test("findTOS names the move clip's child paths and stops at one path per binding", () => {
  const env = fixtureEnv(SCENE);
  const clip = [...env.assets("AnimationClip")].find((a) => a.name === "move")!;
  const data = clip.reader.read<AnimationClip>();
  const tos = findTOS(new Scene(env), clip.reader, data);
  // Four bindings, so the search ends with four paths ({0: ""} among them),
  // before the m_IsActive binding's path is named: upstream counts bindings.
  assert.equal(data.m_ClipBindingConstant.genericBindings.length, 4);
  assert.equal(tos.size, 4);
  assert.deepEqual([...tos.values()].sort(), [
    "",
    "Armature/Hips",
    "Armature/Hips/Spine",
    "Armature/Hips/Spine/Chest",
  ]);
  const curves = clipCurves(env, clip.reader);
  assert.match(curves.float[0]!.path, /^path_\d+$/);
});

test("clipCurves refuses an object of another class", () => {
  const env = fixtureEnv(SCENE);
  const go = env.objects.find((o) => o.type === CLASS.GameObject)!;
  assert.throws(() => clipCurves(env, go), TypeError);
});

/** Little-endian words of a streamed clip: per frame its time, key count and keys. */
function streamWords(frames: [number, [number, number, number, number, number][]][]): number[] {
  const view = new DataView(new ArrayBuffer(4096));
  let pos = 0;
  for (const [time, keys] of frames) {
    view.setFloat32(pos, time, true);
    view.setInt32(pos + 4, keys.length, true);
    pos += 8;
    for (const [index, ...coeff] of keys) {
      view.setInt32(pos, index, true);
      coeff.forEach((c, i) => view.setFloat32(pos + 4 + i * 4, c, true));
      pos += 20;
    }
  }
  return Array.from({ length: pos / 4 }, (_, i) => view.getUint32(i * 4, true));
}

test("readStreamedFrames refuses words that end inside a frame", () => {
  const words = streamWords([[0, [[0, 0, 0, 1, 2]]]]);
  assert.equal(readStreamedFrames(words, "clip").length, 1);
  assert.throws(() => readStreamedFrames(words.slice(0, -1), "clip"), CorruptError);
});

const binding = (
  typeID: number,
  attribute: number,
  customType = 0,
  isPPtrCurve = 0,
): GenericBinding => ({
  path: 0,
  attribute,
  script: nullPtr,
  typeID,
  customType,
  isPPtrCurve,
});

test("dense curves follow the streamed discrete curves of a split curveCount (6000.x)", () => {
  // A float curve and a sprite swap streamed (curveCount 1 + discreteCurveCount 1),
  // then one dense float curve. Upstream's single UInt32 count, 1 + (1 << 16), would
  // put the dense curve past the bindings.
  const sprite = { m_FileID: 0, m_PathID: 7n };
  const data = streamWords([
    [
      -3.4028234663852886e38,
      [
        [0, 0, 0, 0, 0.25],
        [1, 0, 0, 0, 0],
      ],
    ],
    [
      0,
      [
        [0, 0, 0, 0, 0.5],
        [1, 0, 0, 0, 1],
      ],
    ],
    [Infinity, []],
  ]);
  const clip = {
    m_Name: "synthetic",
    m_MuscleClip: {
      m_Clip: {
        data: {
          m_StreamedClip: { data, curveCount: 1, discreteCurveCount: 1 },
          m_DenseClip: {
            m_FrameCount: 2,
            m_CurveCount: 1,
            m_SampleRate: 2,
            m_BeginTime: 0,
            m_SampleArray: [3, 4],
          },
          m_ConstantClip: { data: [] },
        },
      },
    },
    m_ClipBindingConstant: {
      genericBindings: [binding(114, 11), binding(212, 0, 23, 1), binding(114, 22)],
      pptrCurveMapping: [nullPtr, sprite],
    },
  } as unknown as AnimationClip;
  const curves = convertMuscleClip(clip, new Map([[0, ""]]), (type, attribute) => {
    assert.deepEqual([type, attribute], [23, 0]);
    return "m_Sprite";
  });
  assert.deepEqual(
    curves.float.map((c) => [c.attribute, c.keyframes.map((k) => [k.time, k.value])]),
    [
      ["script_11", [[0, 0.5]]],
      [
        "script_22",
        [
          [0, 3],
          [0.5, 4],
        ],
      ],
    ],
  );
  assert.deepEqual(curves.pptr[0]!.keyframes, [
    { time: 0, value: nullPtr },
    { time: 0, value: sprite },
  ]);
});
