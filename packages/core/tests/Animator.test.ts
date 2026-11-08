// Animator, AnimatorController, AnimatorOverrideController and Avatar (#303):
// the hardcoded readers against readTypeTree() on every object of the
// animator fixtures (fixtures/BUILDING.md section 22), typed and not, and on
// objects laid out from Unity's own player type trees at every version TPK
// records (`fixtures/tpk-trees.json`, UnityPy's TPK data, R12), with every
// array filled; the shared structs of `animation.ts` the same way.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadFixture, type GoldenNode } from "../../../fixtures/helpers.js";
import { readHumanPose, readValueArrayConstant } from "../src/classes/animation.js";
import { readAnimator } from "../src/classes/Animator.js";
import { readAnimatorController } from "../src/classes/AnimatorController.js";
import { readAnimatorOverrideController } from "../src/classes/AnimatorOverrideController.js";
import { readAvatar } from "../src/classes/Avatar.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";
import type { TypeTreeNode } from "../src/serialized/TypeTree.js";
import { typedTwin } from "./class-readers.js";
import { readerOf, versionRefusal, withTail, Writer, type Template } from "./media.js";

type Reader = (reader: ObjectReader) => object;

/** The four classes, by class id, with their readers. */
const READERS = new Map<number, [string, Reader]>([
  [ClassID.Animator, ["Animator", readAnimator]],
  [ClassID.AnimatorController, ["AnimatorController", readAnimatorController]],
  [
    ClassID.AnimatorOverrideController,
    ["AnimatorOverrideController", readAnimatorOverrideController],
  ],
  [ClassID.Avatar, ["Avatar", readAvatar]],
]);

const EDITORS = ["2019.4.41f2", "2020.3.30f1", "6000.3.26f1", "6000.6.4f1"];
/** Every animator bundle: typed and not, per editor (6000.6.4f1's in modern-goldens.json). */
const FIXTURES = EDITORS.flatMap((editor) =>
  ["lz4", "lz4-notypetree"].map((kind) => `editor/${editor}/animator/${kind}/animator`),
);

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

/** The fixture's one SerializedFile, and each object's bytes. */
function serializedOf(name: string): { sf: SerializedFile; bytes: (pathId: bigint) => Uint8Array } {
  const env = loadName(name);
  const node = env.files.find((f) => !f.path.includes("."));
  assert.ok(node, `${name}: no SerializedFile`);
  const sf = readSerializedFile(node.data);
  return {
    sf,
    bytes: (pathId) => {
      const info = sf.objects.find((o) => o.pathId === pathId)!;
      return node.data.slice(info.byteStart, info.byteStart + info.byteSize);
    },
  };
}

/** `fixtures/tpk-trees.json`: Unity's player trees from UnityPy's TPK data, from 2019.1 on. */
const TPK = (
  JSON.parse(
    readFileSync(new URL("../../../fixtures/tpk-trees.json", import.meta.url), "utf8"),
  ) as { classes: Record<string, Record<string, GoldenNode[]>> }
).classes;

/** A TPK tree as the nodes a SerializedFile's type would hold. */
const typeTreeNodes = (nodes: GoldenNode[]): TypeTreeNode[] =>
  nodes.map(([level, type, name, byteSize, metaFlag], index) => ({
    level,
    type,
    name,
    byteSize,
    metaFlag,
    index,
    typeFlags: 0,
    version: 1,
    typeStrOffset: 0,
    nameStrOffset: 0,
    refTypeHash: 0n,
  }));

/** `2020.3.43f1` as a version, raised to 2019.1 (the floor) for an older tree's key. */
function versionOf(key: string): { unity: UnityVersion; text: string } {
  const [, a, b, c, type, n] = /^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)$/.exec(key)!;
  if (+a! < 2019) return { unity: [2019, 1, 0, 1], text: "2019.1.0f1" };
  return { unity: [+a!, +b!, +c!, +n!], text: `${a}.${b}.${c}${type}${n}` };
}

/** The tree `nodes` holds for `version`: the last one starting at or before it. */
function treeAt(classId: number, version: UnityVersion): GoldenNode[] {
  let found: GoldenNode[] | undefined;
  for (const [key, nodes] of Object.entries(TPK[String(classId)]!)) {
    const { unity } = versionOf(key);
    const cmp = unity.slice(0, 3).findIndex((part, i) => part !== version[i]);
    if (cmp === -1 || unity[cmp]! < version[cmp]!) found = nodes;
  }
  return found!;
}

/** A reader over `bytes` as a `classId` object of `version`, its type tree `nodes`. */
function tpkReader(
  from: Template,
  bytes: Uint8Array,
  nodes: GoldenNode[],
  version: { unity: UnityVersion; text: string },
): ObjectReader {
  const serializedType = { ...from.info.serializedType!, nodes: typeTreeNodes(nodes) };
  const typed: Template = { ...from, info: { ...from.info, serializedType } };
  return readerOf(typed, bytes, version);
}

/** Every array's pairs as a sorted copy: a map Unity writes in no fixed order. */
const sortedTOS = (value: object): object =>
  "m_TOS" in value
    ? { ...value, m_TOS: [...(value.m_TOS as [number, string][])].sort((x, y) => x[0] - y[0]) }
    : value;

// --- the animator fixtures ------------------------------------------------------------

/** Per bundle (fixtures/BUILDING.md section 22): two prefabs, one controller of each kind, two avatars. */
const COUNTS = new Map<number, number>([
  [ClassID.Animator, 2],
  [ClassID.AnimatorController, 1],
  [ClassID.AnimatorOverrideController, 1],
  [ClassID.Avatar, 2],
]);

for (const name of FIXTURES) {
  const typed = !name.includes("/lz4-notypetree/");

  test(`${name}: every Animator, controller and Avatar reads as readTypeTree()`, () => {
    const env = loadName(name);
    const twin = typed ? env : loadName(typedTwin(name));
    const { sf, bytes } = serializedOf(name);
    for (const [classId, [owner, read]] of READERS) {
      const objects = env.objects.filter((o) => o.type === classId);
      assert.equal(objects.length, COUNTS.get(classId), `${owner} count`);
      const from: Template = { sf, info: sf.objects.find((o) => o.classId === classId)! };
      for (const reader of objects) {
        const where = `${owner} ${reader.pathId}`;
        const data = read(reader);
        assert.equal(reader.position, reader.byteSize, `${where}: byteSize not consumed exactly`);
        // obj.read() dispatches to the same reader.
        assert.deepStrictEqual(reader.read(), data, where);
        const twinTree = twin.objects.find((o) => o.pathId === reader.pathId)!.readTypeTree();
        if (typed) {
          // Every field, in Unity's order.
          assert.deepEqual(Object.keys(data), Object.keys(twinTree), where);
          assert.deepStrictEqual(data, twinTree, where);
          continue;
        }
        // The same bytes through Unity's own tree of the version (TPK).
        const version = { unity: reader.version, text: reader.unityVersion };
        const tree = tpkReader(
          from,
          bytes(reader.pathId),
          treeAt(classId, reader.version),
          version,
        );
        assert.deepStrictEqual(data, tree.readTypeTree(), `${where} (TPK tree)`);
        // The typed twin holds the same values; only m_TOS, a map, may come
        // in another order (a generic Avatar's does).
        assert.deepStrictEqual(sortedTOS(data), sortedTOS(twinTree), `${where} (typed twin)`);
      }
    }
  });
}

/** The arrays of each class that no fixture object fills, at any depth (the rest all do somewhere). */
const ALWAYS_EMPTY: Record<string, string[]> = {
  Animator: [],
  AnimatorOverrideController: [],
  // A generic avatar has no axes; neither has a root motion pose.
  Avatar: [
    ".m_Avatar.m_AvatarSkeleton.data.m_AxesArray",
    ".m_Avatar.m_RootMotionSkeleton.data.m_AxesArray",
    ".m_Avatar.m_RootMotionSkeletonPose.data.m_X",
  ],
  // No parameter is a position, rotation or scale; no Unity parameter is an entity id.
  AnimatorController: [
    ".m_Controller.m_DefaultValues.data.m_PositionValues",
    ".m_Controller.m_DefaultValues.data.m_QuaternionValues",
    ".m_Controller.m_DefaultValues.data.m_ScaleValues",
    ".m_Controller.m_DefaultValues.data.m_EntityIdValues",
  ],
};

test("the fixtures fill every array but those the TPK layouts below fill instead", () => {
  const empty = new Map<string, Set<string>>();
  const full = new Set<string>();
  const walk = (owner: string, value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length) full.add(`${owner}${path}`);
      else {
        if (!empty.has(owner)) empty.set(owner, new Set());
        empty.get(owner)!.add(path);
      }
      for (const item of value) walk(owner, item, path);
    } else if (value && typeof value === "object" && !("m_FileID" in value)) {
      for (const [key, item] of Object.entries(value)) walk(owner, item, `${path}.${key}`);
    }
  };
  for (const name of FIXTURES.filter((n) => n.includes("/lz4/"))) {
    for (const reader of loadName(name).objects) {
      const entry = READERS.get(reader.type);
      if (entry) walk(entry[0], entry[1](reader), "");
    }
  }
  for (const [owner, paths] of Object.entries(ALWAYS_EMPTY)) {
    const never = [...(empty.get(owner) ?? [])].filter((p) => !full.has(`${owner}${p}`));
    assert.deepStrictEqual(never.sort(), [...paths].sort(), owner);
  }
  // The 6000.x controllers have m_EntityIdValues, empty (see readAnimatorController).
  assert.ok(
    empty.get("AnimatorController")!.has(".m_Controller.m_DefaultValues.data.m_EntityIdValues"),
  );
});

test("the fixtures hold a humanoid and a generic Avatar, and the controller's parts", () => {
  for (const editor of EDITORS) {
    const env = loadName(`editor/${editor}/animator/lz4/animator`);
    const avatars = env.objects.filter((o) => o.type === ClassID.Avatar).map(readAvatar);
    const human = avatars.find((a) => a.m_Name === "human")!;
    const generic = avatars.find((a) => a.m_Name === "generic")!;
    // BuildHumanAvatar: 27 mapped bones, hands, translation DoF, the custom limit.
    assert.equal(human.m_HumanDescription.m_Human.length, 27, editor);
    assert.equal(human.m_HumanDescription.m_Skeleton.length, 28, editor);
    assert.equal(human.m_HumanDescription.m_Human.filter((b) => b.m_Limit.m_Modified).length, 1);
    assert.equal(human.m_HumanDescription.m_HasTranslationDoF, true);
    assert.equal(human.m_Avatar.m_Human.data.m_HasLeftHand, true, editor);
    assert.ok(human.m_Avatar.m_Human.data.m_Skeleton.data.m_AxesArray.length > 0, editor);
    assert.ok(human.m_Avatar.m_Human.data.m_LeftHand.data.m_HandBoneIndex.some((i) => i >= 0));
    // BuildGenericAvatar(root, "Body"): no human part, Body the root motion bone.
    assert.equal(generic.m_HumanDescription.m_Human.length, 0, editor);
    assert.equal(generic.m_HumanDescription.m_RootMotionBoneName, "Body", editor);
    assert.equal(generic.m_Avatar.m_Human.data.m_Skeleton.data.m_Node.length, 0, editor);

    const [controller] = env.objects
      .filter((o) => o.type === ClassID.AnimatorController)
      .map(readAnimatorController);
    const c = controller!.m_Controller;
    assert.equal(c.m_LayerArray.length, 2, editor);
    assert.equal(c.m_LayerArray[1]!.data["(int&)m_LayerBlendingMode"], 1, "additive");
    assert.ok(c.m_LayerArray[1]!.data.m_SkeletonMask.data.m_Data.length > 0, "the AvatarMask");
    assert.equal(c.m_Values.data.m_ValueArray.length, 6, "a parameter of each type");
    const states = c.m_StateMachineArray.flatMap((m) => m.data.m_StateConstantArray);
    // idle, locomotion, strafe, aim, direct, jump, the sub-state machine's two; rest, wave.
    assert.equal(states.length, 10, editor);
    const nodes = states
      .flatMap((s) => s.data.m_BlendTreeConstantArray)
      .flatMap((t) => t.data.m_NodeArray);
    // 1D (0), freeform directional (2), freeform cartesian (3), direct (4).
    assert.deepEqual(
      [
        ...new Set(
          nodes.filter((n) => n.data.m_ChildIndices.length).map((n) => n.data.m_BlendType),
        ),
      ].sort(),
      [0, 2, 3, 4],
    );
    assert.ok(
      c.m_StateMachineArray[0]!.data.m_SelectorStateConstantArray.length >= 2,
      "sub-state machine",
    );
    assert.equal(controller!.m_StateMachineBehaviours.length, 2, editor);
    // One range per state a behaviour applies to, as Unity builds them.
    const ranges =
      controller!.m_StateMachineBehaviourVectorDescription.m_StateMachineBehaviourRanges;
    assert.equal(ranges.length, 4, editor);
  }
});

test("the 2020.3.30f1 Animator predates the 2020.3.43 fields; 6000.x has the 2023.1 ones", () => {
  const animatorOf = (editor: string) =>
    loadName(`editor/${editor}/animator/lz4/animator`)
      .objects.filter((o) => o.type === ClassID.Animator)
      .map(readAnimator);
  for (const animator of animatorOf("2020.3.30f1")) {
    assert.equal("m_StabilizeFeet" in animator, false);
    assert.equal("m_KeepAnimatorStateOnDisable" in animator, false);
    assert.equal(typeof animator.m_KeepAnimatorControllerStateOnDisable, "boolean");
  }
  for (const editor of ["6000.3.26f1", "6000.6.4f1"]) {
    for (const animator of animatorOf(editor)) {
      for (const key of ["m_StabilizeFeet", "m_AnimatePhysics", "m_KeepAnimatorStateOnDisable"]) {
        assert.ok(key in animator, `${editor} ${key}`);
      }
      assert.equal(typeof animator.m_WriteDefaultValuesOnDisable, "boolean");
    }
  }
});

// --- hand-built layouts at every TPK version ---------------------------------------------

/**
 * Little-endian bytes for a TPK tree, every value distinct and every array of
 * two elements, laid out as `readTypeTree()` reads them. An `EntityId` vector
 * gets `entityIds` elements of the node's size (0 by default: its node has no
 * children, so its bytes say nothing a tree can read).
 */
function filled(nodes: GoldenNode[], entityIds = 0): Uint8Array {
  const w = new Writer();
  let n = 0;
  const end = (i: number): number => {
    let j = i + 1;
    while (j < nodes.length && nodes[j]![0] > nodes[i]![0]) j++;
    return j;
  };
  const value = (i: number): void => {
    const [, type, , , flag] = nodes[i]!;
    n++;
    switch (type) {
      case "bool":
        w.bool(n % 3 !== 0);
        break;
      case "UInt8":
        w.u8(n);
        break;
      case "int":
        w.i32(n % 2 ? -n : n);
        break;
      case "unsigned int":
        w.u32(n * 7919);
        break;
      case "float":
        w.f32(n / 8);
        break;
      case "SInt64":
        w.u64(BigInt(n) << 33n);
        break;
      case "string":
        w.str(`s${n}`);
        break;
      default: {
        const child = i + 1;
        if (child < end(i) && nodes[child]![1] === "Array") {
          const element = end(child + 1);
          const entityId = nodes[element]![1] === "EntityId";
          const count = entityId ? entityIds : 2;
          w.i32(count);
          for (let k = 0; k < count; k++) {
            if (entityId) w.raw(...new Array<number>(nodes[element]![3]).fill(k + 1));
            else value(element);
          }
          if ((nodes[child]![4] & 0x4000) !== 0) w.align();
        } else {
          for (let c = child; c < end(i); c = end(c)) value(c);
        }
      }
    }
    if ((flag & 0x4000) !== 0) w.align();
  };
  value(0);
  return w.data;
}

/** A fixture object of each class, for its file and type entry. */
const TEMPLATE = (() => {
  const { sf } = serializedOf("editor/2019.4.41f2/animator/lz4/animator");
  return (classId: number): Template => ({
    sf,
    info: sf.objects.find((o) => o.classId === classId)!,
  });
})();

/**
 * TPK's Animator trees from 2022.2.0a13 and of the 2023.1 pre-releases before
 * b7: the gates compare release numbers only (the ponytail in `readAnimator`),
 * so the reader reads them as 2022.2.0f1's and 2023.1's layouts.
 */
const PRE_RELEASES = new Set([
  "95 2022.2.0a13",
  "95 2023.1.0a1",
  "95 2023.1.0a5",
  "95 2023.1.0a8",
  "95 2023.1.0a11",
]);

test("TPK has a tree at every gate the readers know, from 2019.1 to 6000.6", () => {
  const keys = (id: number) => Object.keys(TPK[String(id)]!);
  assert.deepEqual(keys(ClassID.Avatar), ["2019.1.0a14", "6000.6.0a5"]);
  assert.deepEqual(keys(ClassID.AnimatorOverrideController), ["2018.3.0b1", "6000.6.0a5"]);
  assert.deepEqual(keys(ClassID.AnimatorController), [
    "2018.3.0b1",
    "6000.2.0b2", // m_EntityIdValues
    "6000.4.0a2", // m_EvaluateTransitionsOnStart, twice
    "6000.5.0b1", // EntityId 8 bytes
    "6000.6.0a5",
  ]);
  assert.deepEqual(keys(ClassID.Animator), [
    "2018.3.0b1",
    "2020.3.43f1",
    "2020.3.46f1",
    "2021.1.0a2",
    "2021.2.0b1",
    "2021.3.16f1",
    "2021.3.20f1",
    "2022.1.0a7",
    "2022.1.24f1",
    "2022.2.0a13",
    "2022.2.0f1",
    "2022.2.9f1",
    "2023.1.0a1",
    "2023.1.0a5",
    "2023.1.0a8",
    "2023.1.0a11",
    "2023.1.0b7",
    "6000.6.0a5",
  ]);
});

for (const [classId, [owner, read]] of READERS) {
  for (const [key, nodes] of Object.entries(TPK[String(classId)]!)) {
    test(`TPK ${owner} ${key}: a filled object reads the same through Unity's type tree`, () => {
      const version = versionOf(key);
      const reader = tpkReader(TEMPLATE(classId), filled(nodes), nodes, version);
      const tree = reader.readTypeTree() as object;
      assert.equal(reader.position, reader.byteSize);
      let same: boolean;
      try {
        const data = read(reader);
        assert.equal(reader.position, reader.byteSize);
        assert.deepEqual(Object.keys(data), Object.keys(tree));
        assert.deepStrictEqual(data, tree);
        same = true;
      } catch (error) {
        if (!PRE_RELEASES.has(`${classId} ${key}`)) throw error;
        same = false;
      }
      assert.equal(same, !PRE_RELEASES.has(`${classId} ${key}`), "a listed pre-release reads");
    });
  }
}

test("the Animator gates between TPK's: 2020.3.42, 2021.3.15, 2022.1.23, 2022.2.8, 2022.3", () => {
  for (const [text, from] of [
    ["2020.3.42f1", "2018.3.0b1"],
    ["2021.3.15f1", "2021.2.0b1"],
    ["2021.3.19f1", "2021.3.16f1"],
    ["2022.1.23f1", "2022.1.0a7"],
    ["2022.2.8f1", "2022.2.0f1"],
    ["2022.3.62f1", "2022.2.9f1"],
  ] as const) {
    const nodes = TPK[String(ClassID.Animator)]![from]!;
    const reader = tpkReader(TEMPLATE(ClassID.Animator), filled(nodes), nodes, versionOf(text));
    const tree = reader.readTypeTree();
    assert.deepStrictEqual(readAnimator(reader), tree, text);
  }
});

test("a controller's EntityId values are refused, not guessed (6000.3 and 6000.6 layouts)", () => {
  for (const key of ["6000.2.0b2", "6000.6.0a5"]) {
    const nodes = TPK[String(ClassID.AnimatorController)]![key]!;
    const from = TEMPLATE(ClassID.AnimatorController);
    const reader = tpkReader(from, filled(nodes, 1), nodes, versionOf(key));
    assert.throws(
      () => readAnimatorController(reader),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "EntityId values",
    );
  }
});

// --- the shared structs (animation.ts) ------------------------------------------------

/** The subtree of the first node of `type` in a tree, as a tree of its own. */
function subtree(nodes: GoldenNode[], type: string): GoldenNode[] {
  const at = nodes.findIndex((node) => node[1] === type);
  assert.ok(at >= 0, `no ${type}`);
  const level = nodes[at]![0];
  let end = at + 1;
  while (end < nodes.length && nodes[end]![0] > level) end++;
  return nodes.slice(at, end).map(([l, ...rest]) => [l - level, ...rest] as GoldenNode);
}

test("readHumanPose reads an AnimationClip's HumanPose at every TPK AnimationClip tree", () => {
  for (const [key, clip] of Object.entries(TPK[String(ClassID.AnimationClip)]!)) {
    const nodes = subtree(clip, "HumanPose");
    const reader = tpkReader(TEMPLATE(ClassID.Animator), filled(nodes), nodes, versionOf(key));
    const tree = reader.readTypeTree();
    reader.position = 0;
    assert.deepStrictEqual(readHumanPose(reader, "AnimationClip"), tree, key);
    assert.equal(reader.position, reader.byteSize, key);
  }
});

test("readValueArrayConstant reads a controller's m_Values at every TPK tree", () => {
  for (const [key, controller] of Object.entries(TPK[String(ClassID.AnimatorController)]!)) {
    const nodes = subtree(controller, "ValueArrayConstant");
    const reader = tpkReader(TEMPLATE(ClassID.Animator), filled(nodes), nodes, versionOf(key));
    const tree = reader.readTypeTree();
    reader.position = 0;
    assert.deepStrictEqual(readValueArrayConstant(reader, "AnimatorController"), tree, key);
    assert.equal(reader.position, reader.byteSize, key);
  }
});

// --- refusals --------------------------------------------------------------------------

/** One fixture object of each class: its file, entry and bytes. */
function fixtureObject(classId: number): { from: Template; bytes: Uint8Array } {
  const { sf, bytes } = serializedOf("editor/2019.4.41f2/animator/lz4/animator");
  const info = sf.objects.find((o) => o.classId === classId)!;
  return { from: { sf, info }, bytes: bytes(info.pathId) };
}

for (const [classId, [owner, read]] of READERS) {
  test(`${owner}: older than 2019.1, unknown outside 2019's formats, or an editor file is refused`, () => {
    const { from, bytes } = fixtureObject(classId);
    const older = readerOf(from, bytes, { unity: [2018, 4, 36, 1] });
    assert.throws(() => read(older), versionRefusal("2018.4.36"));
    const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0" };
    assert.throws(
      () => read(readerOf(from, bytes, { ...stripped, format: 22 })),
      versionRefusal("0.0.0"),
    );
    const editor = readerOf(from, bytes, {
      unity: [2019, 4, 41, 2],
      platform: BuildTarget.NoTarget,
    });
    assert.throws(
      () => read(editor),
      (err: unknown) => err instanceof UnsupportedError && err.kind === "build target",
    );
  });

  test(`${owner}: an unknown version in format 21 reads as 2019; a misfit is refused`, () => {
    const { from, bytes } = fixtureObject(classId);
    const known = read(readerOf(from, bytes, { unity: [2019, 4, 41, 2] }));
    const stripped = { unity: [0, 0, 0, 0] as UnityVersion, text: "0.0.0", format: 21 };
    assert.deepStrictEqual(read(readerOf(from, bytes, stripped)), known);
    // A byte too many is not 2019's layout, which the file cannot tell from corruption.
    assert.throws(
      () => read(readerOf(from, withTail(bytes, 0, 0, 0, 0), stripped)),
      versionRefusal("0.0.0"),
    );
  });

  test(`${owner}: a truncated object or bytes left over are corrupt`, () => {
    const { from, bytes } = fixtureObject(classId);
    const unity: UnityVersion = [2019, 4, 41, 2];
    assert.throws(
      () => read(readerOf(from, bytes.slice(0, bytes.length - 4), { unity })),
      CorruptError,
    );
    assert.throws(() => read(readerOf(from, withTail(bytes, 0, 0, 0, 0), { unity })), CorruptError);
  });
}
