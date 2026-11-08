// Ported from AssetStudio/Classes/AnimatorController.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";
import type { ObjectReader, Vector3 } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import {
  animationLayoutVersion,
  readBool,
  readFloat3,
  readFloat4,
  readFloats,
  readInts,
  readUInts,
  readValueArrayConstant,
  type OffsetPtr,
  type ValueArrayConstant,
} from "./animation.js";
import { readTOS } from "./Avatar.js";
import type { Vector2 } from "./Material.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray, type Vector4 } from "./Sprite.js";
import { atLeast } from "./version.js";

/** The humanoid body parts a layer masks, as three bit words (Unity's `HumanPoseMask`). */
export interface HumanPoseMask {
  word0: number;
  word1: number;
  word2: number;
}

/** A transform's weight in a layer's mask (Unity's `SkeletonMaskElement`). */
export interface SkeletonMaskElement {
  m_PathHash: number;
  m_Weight: number;
}

/** The transforms a layer masks (Unity's `SkeletonMask`). */
export interface SkeletonMask {
  m_Data: SkeletonMaskElement[];
}

/** A controller layer (Unity's `LayerConstant`). */
export interface LayerConstant {
  m_StateMachineIndex: number;
  m_StateMachineSynchronizedLayerIndex: number;
  m_BodyMask: HumanPoseMask;
  m_SkeletonMask: OffsetPtr<SkeletonMask>;
  m_Binding: number;
  /**
   * Unity's `AnimatorLayerBlendingMode`, 0 override, 1 additive. The key is
   * Unity's own node name, cast included, as `readTypeTree()` gives it.
   */
  "(int&)m_LayerBlendingMode": number;
  m_DefaultWeight: number;
  m_IKPass: boolean;
  m_SyncedLayerAffectsTiming: boolean;
}

/** A transition condition (Unity's `ConditionConstant`). */
export interface ConditionConstant {
  /** Unity's `AnimatorConditionMode`: 1 if, 2 if not, 3 greater, 4 less, 6 equals, 7 not equal. */
  m_ConditionMode: number;
  /** The parameter, as the CRC32 of its name. */
  m_EventID: number;
  m_EventThreshold: number;
  m_ExitTime: number;
}

/** A transition between states (Unity's `TransitionConstant`). */
export interface TransitionConstant {
  m_ConditionConstantArray: OffsetPtr<ConditionConstant>[];
  m_DestinationState: number;
  m_FullPathID: number;
  m_ID: number;
  m_UserID: number;
  m_TransitionDuration: number;
  m_TransitionOffset: number;
  m_ExitTime: number;
  m_HasExitTime: boolean;
  m_HasFixedDuration: boolean;
  /** Unity's `TransitionInterruptionSource`. */
  m_InterruptionSource: number;
  m_OrderedInterruption: boolean;
  m_CanTransitionToSelf: boolean;
}

/** The children of a 2D blend node an index refers to (Unity's `MotionNeighborList`). */
export interface MotionNeighborList {
  m_NeighborArray: number[];
}

/** The data of a 2D blend node (Unity's `Blend2dDataConstant`). */
export interface Blend2dDataConstant {
  m_ChildPositionArray: Vector2[];
  m_ChildMagnitudeArray: number[];
  m_ChildPairVectorArray: Vector2[];
  m_ChildPairAvgMagInvArray: number[];
  m_ChildNeighborListArray: MotionNeighborList[];
}

/** The data of a 1D blend node (Unity's `Blend1dDataConstant`). */
export interface Blend1dDataConstant {
  m_ChildThresholdArray: number[];
}

/** The data of a direct blend node (Unity's `BlendDirectDataConstant`). */
export interface BlendDirectDataConstant {
  m_ChildBlendEventIDArray: number[];
  m_NormalizedBlendValues: boolean;
}

/** A node of a blend tree: a blend or a clip (Unity's `BlendTreeNodeConstant`). */
export interface BlendTreeNodeConstant {
  /** Unity's `BlendTreeType`: 0 1D, 1 2D simple directional, 2 freeform directional, ... */
  m_BlendType: number;
  m_BlendEventID: number;
  m_BlendEventYID: number;
  m_ChildIndices: number[];
  m_Blend1dData: OffsetPtr<Blend1dDataConstant>;
  m_Blend2dData: OffsetPtr<Blend2dDataConstant>;
  m_BlendDirectData: OffsetPtr<BlendDirectDataConstant>;
  /** The clip's index in the controller's `m_AnimationClips`, for a leaf. */
  m_ClipID: number;
  m_Duration: number;
  m_CycleOffset: number;
  m_Mirror: boolean;
}

/** A blend tree, its nodes flattened (Unity's `BlendTreeConstant`). */
export interface BlendTreeConstant {
  m_NodeArray: OffsetPtr<BlendTreeNodeConstant>[];
}

/** A state (Unity's `StateConstant`). */
export interface StateConstant {
  m_TransitionConstantArray: OffsetPtr<TransitionConstant>[];
  m_BlendTreeConstantIndexArray: number[];
  m_BlendTreeConstantArray: OffsetPtr<BlendTreeConstant>[];
  m_NameID: number;
  m_PathID: number;
  m_FullPathID: number;
  m_TagID: number;
  m_SpeedParamID: number;
  m_MirrorParamID: number;
  m_CycleOffsetParamID: number;
  m_TimeParamID: number;
  m_Speed: number;
  m_CycleOffset: number;
  m_IKOnFeet: boolean;
  m_WriteDefaultValues: boolean;
  m_Loop: boolean;
  m_Mirror: boolean;
}

/** A transition of a selector state (Unity's `SelectorTransitionConstant`). */
export interface SelectorTransitionConstant {
  m_Destination: number;
  m_ConditionConstantArray: OffsetPtr<ConditionConstant>[];
}

/** The entry or exit of a (sub-)state machine (Unity's `SelectorStateConstant`). */
export interface SelectorStateConstant {
  m_TransitionConstantArray: OffsetPtr<SelectorTransitionConstant>[];
  m_FullPathID: number;
  m_IsEntry: boolean;
}

/** A layer's state machine, sub-state machines flattened (Unity's `StateMachineConstant`). */
export interface StateMachineConstant {
  m_StateConstantArray: OffsetPtr<StateConstant>[];
  m_AnyStateTransitionConstantArray: OffsetPtr<TransitionConstant>[];
  m_SelectorStateConstantArray: OffsetPtr<SelectorStateConstant>[];
  m_DefaultState: number;
  m_SynchronizedLayerCount: number;
  /** Unity 6000.4 and later. */
  m_EvaluateTransitionsOnStart?: boolean;
}

/** The default value of each parameter, by type (Unity's `ValueArray`). */
export interface ValueArray {
  m_PositionValues: Vector3[];
  m_QuaternionValues: Vector4[];
  m_ScaleValues: Vector3[];
  m_FloatValues: number[];
  m_IntValues: number[];
  m_BoolValues: boolean[];
  /**
   * Unity 6000.2 and later. Always empty here: the reader refuses an object
   * with entity ids (see {@link readAnimatorController}).
   */
  m_EntityIdValues?: never[];
}

/** The runtime form of a controller (Unity's `ControllerConstant`). */
export interface ControllerConstant {
  m_LayerArray: OffsetPtr<LayerConstant>[];
  m_StateMachineArray: OffsetPtr<StateMachineConstant>[];
  /** The parameters. */
  m_Values: OffsetPtr<ValueArrayConstant>;
  m_DefaultValues: OffsetPtr<ValueArray>;
}

/** Which state a range of behaviours belongs to (Unity's `StateKey`). */
export interface StateKey {
  m_StateID: number;
  m_LayerIndex: number;
}

/** A range of `m_StateMachineBehaviourIndices` (Unity's `StateRange`). */
export interface StateRange {
  m_StartIndex: number;
  m_Count: number;
}

/**
 * Where each state's `StateMachineBehaviour`s are (Unity's
 * `StateMachineBehaviourVectorDescription`), map entries as `[first, second]`
 * arrays as `readTypeTree()` gives them.
 */
export interface StateMachineBehaviourVectorDescription {
  m_StateMachineBehaviourRanges: [StateKey, StateRange][];
  /** Indices into the controller's `m_StateMachineBehaviours`. */
  m_StateMachineBehaviourIndices: number[];
}

/**
 * The fields of an `AnimatorController`, as a player build stores them,
 * under Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object, map entries and pairs as
 * `[first, second]` arrays as it gives them.
 */
export interface AnimatorController extends NamedObject {
  /** Unity 6000.4 and later. */
  m_EvaluateTransitionsOnStart?: boolean;
  /** The byte size of the runtime controller blob. */
  m_ControllerSize: number;
  m_Controller: ControllerConstant;
  /** Name hash (CRC32) to name, for every parameter, state and path. */
  m_TOS: [number, string][];
  /** Every clip the controller's states and blend trees play. */
  m_AnimationClips: PPtr[];
  m_StateMachineBehaviourVectorDescription: StateMachineBehaviourVectorDescription;
  /** The `MonoBehaviour`s of every `StateMachineBehaviour`. */
  m_StateMachineBehaviours: PPtr[];
  m_MultiThreadedStateMachine: boolean;
}

/**
 * Read an `AnimatorController` from the object's first byte: every field
 * Unity's own player type trees give for its version (as UnityPy's TPK data
 * records them), in their order. The object must end exactly there.
 *
 * Upstream reads through `m_AnimationClips` and stops, its gates all before
 * 2019.1. This reads what TPK adds: `m_StateMachineBehaviourVectorDescription`,
 * `m_StateMachineBehaviours` and `m_MultiThreadedStateMachine` after the clips;
 * `m_EntityIdValues` at the end of `m_DefaultValues` from 6000.2; and
 * `m_EvaluateTransitionsOnStart`, after `m_Name` and at the end of each state
 * machine, from 6000.4.
 *
 * An `EntityId` is 4 bytes in Unity 6000.2 to 6000.4 and 8 from 6000.5 (TPK),
 * and its type tree node has no children, so neither TPK nor the object's own
 * type tree says what it holds; no controller of Unity's writes one (a
 * parameter is a float, an int or a bool). A non-empty `m_EntityIdValues` is
 * refused rather than guessed (R9).
 *
 * ponytail: the gates compare release numbers only (see `atLeast`); a
 * pre-release before the one TPK records (6000.2.0b2, 6000.4.0a2) fails the
 * end-of-object check.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields after
 *   `m_Name` do not fit 2019's layout. Of kind `"build target"` for an editor
 *   file (`BuildTarget.NoTarget`). Of kind `"EntityId values"` when
 *   `m_EntityIdValues` is not empty
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field, with the version known; with it unknown, only inside `m_Name`
 */
export function readAnimatorController(reader: ObjectReader): AnimatorController {
  const version = animationLayoutVersion(reader, "AnimatorController");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<AnimatorController> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, OWNER, () => {
    // 6000.4+ (TPK; upstream does not read it).
    if (atLeast(version, 6000, 4)) {
      out.m_EvaluateTransitionsOnStart = readBool(reader);
      reader.align();
    }
    out.m_ControllerSize = reader.readUInt32();
    out.m_Controller = readControllerConstant(reader, version);
    out.m_TOS = readTOS(reader, OWNER);
    out.m_AnimationClips = readArray(reader, OWNER, "m_AnimationClips", readPPtr);
    // From here on not read by upstream (TPK).
    out.m_StateMachineBehaviourVectorDescription = {
      m_StateMachineBehaviourRanges: readArray(
        reader,
        OWNER,
        "m_StateMachineBehaviourRanges",
        (r) => [
          { m_StateID: r.readUInt32(), m_LayerIndex: r.readInt32() },
          { m_StartIndex: r.readUInt32(), m_Count: r.readUInt32() },
        ],
      ),
      m_StateMachineBehaviourIndices: readUInts(reader, OWNER, "m_StateMachineBehaviourIndices"),
    };
    out.m_StateMachineBehaviours = readArray(reader, OWNER, "m_StateMachineBehaviours", readPPtr);
    out.m_MultiThreadedStateMachine = readBool(reader);
    reader.align();
    endOfObject(reader, OWNER);
  });
  // Every required field was set above.
  return out as AnimatorController;
}

const OWNER = "AnimatorController";

/** An `Int32` count, then that many `OffsetPtr`s of `T`. */
function readOffsetPtrs<T>(
  reader: ObjectReader,
  what: string,
  element: (r: ObjectReader) => T,
): OffsetPtr<T>[] {
  return readArray(reader, OWNER, what, (r) => ({ data: element(r) }));
}

function readControllerConstant(reader: ObjectReader, version: UnityVersion): ControllerConstant {
  return {
    m_LayerArray: readOffsetPtrs(reader, "m_LayerArray", readLayerConstant),
    m_StateMachineArray: readOffsetPtrs(reader, "m_StateMachineArray", (r) =>
      readStateMachineConstant(r, version),
    ),
    m_Values: { data: readValueArrayConstant(reader, OWNER) },
    m_DefaultValues: { data: readValueArray(reader, version) },
  };
}

function readLayerConstant(reader: ObjectReader): LayerConstant {
  const layer: LayerConstant = {
    m_StateMachineIndex: reader.readUInt32(),
    m_StateMachineSynchronizedLayerIndex: reader.readUInt32(),
    m_BodyMask: {
      word0: reader.readUInt32(),
      word1: reader.readUInt32(),
      word2: reader.readUInt32(),
    },
    m_SkeletonMask: {
      data: {
        m_Data: readArray(reader, OWNER, "m_SkeletonMask", (r) => ({
          m_PathHash: r.readUInt32(),
          m_Weight: r.readFloat32(),
        })),
      },
    },
    m_Binding: reader.readUInt32(),
    "(int&)m_LayerBlendingMode": reader.readInt32(),
    m_DefaultWeight: reader.readFloat32(),
    m_IKPass: readBool(reader),
    m_SyncedLayerAffectsTiming: readBool(reader),
  };
  reader.align();
  return layer;
}

function readConditions(reader: ObjectReader): OffsetPtr<ConditionConstant>[] {
  return readOffsetPtrs(reader, "m_ConditionConstantArray", (r) => ({
    m_ConditionMode: r.readUInt32(),
    m_EventID: r.readUInt32(),
    m_EventThreshold: r.readFloat32(),
    m_ExitTime: r.readFloat32(),
  }));
}

function readTransitionConstant(reader: ObjectReader): TransitionConstant {
  const m_ConditionConstantArray = readConditions(reader);
  const m_DestinationState = reader.readUInt32();
  const m_FullPathID = reader.readUInt32();
  const m_ID = reader.readUInt32();
  const m_UserID = reader.readUInt32();
  const m_TransitionDuration = reader.readFloat32();
  const m_TransitionOffset = reader.readFloat32();
  const m_ExitTime = reader.readFloat32();
  const m_HasExitTime = readBool(reader);
  const m_HasFixedDuration = readBool(reader);
  reader.align();
  const m_InterruptionSource = reader.readInt32();
  const m_OrderedInterruption = readBool(reader);
  const m_CanTransitionToSelf = readBool(reader);
  reader.align();
  return {
    m_ConditionConstantArray,
    m_DestinationState,
    m_FullPathID,
    m_ID,
    m_UserID,
    m_TransitionDuration,
    m_TransitionOffset,
    m_ExitTime,
    m_HasExitTime,
    m_HasFixedDuration,
    m_InterruptionSource,
    m_OrderedInterruption,
    m_CanTransitionToSelf,
  };
}

function readBlendTreeNodeConstant(reader: ObjectReader): BlendTreeNodeConstant {
  const m_BlendType = reader.readUInt32();
  const m_BlendEventID = reader.readUInt32();
  const m_BlendEventYID = reader.readUInt32();
  const m_ChildIndices = readUInts(reader, OWNER, "m_ChildIndices");
  const m_Blend1dData = {
    data: { m_ChildThresholdArray: readFloats(reader, OWNER, "m_ChildThresholdArray") },
  };
  const m_Blend2dData = {
    data: {
      m_ChildPositionArray: readArray(reader, OWNER, "m_ChildPositionArray", readVector2),
      m_ChildMagnitudeArray: readFloats(reader, OWNER, "m_ChildMagnitudeArray"),
      m_ChildPairVectorArray: readArray(reader, OWNER, "m_ChildPairVectorArray", readVector2),
      m_ChildPairAvgMagInvArray: readFloats(reader, OWNER, "m_ChildPairAvgMagInvArray"),
      m_ChildNeighborListArray: readArray(reader, OWNER, "m_ChildNeighborListArray", (r) => ({
        m_NeighborArray: readUInts(r, OWNER, "m_NeighborArray"),
      })),
    },
  };
  const m_ChildBlendEventIDArray = readUInts(reader, OWNER, "m_ChildBlendEventIDArray");
  const m_NormalizedBlendValues = readBool(reader);
  reader.align();
  const node: BlendTreeNodeConstant = {
    m_BlendType,
    m_BlendEventID,
    m_BlendEventYID,
    m_ChildIndices,
    m_Blend1dData,
    m_Blend2dData,
    m_BlendDirectData: { data: { m_ChildBlendEventIDArray, m_NormalizedBlendValues } },
    m_ClipID: reader.readUInt32(),
    m_Duration: reader.readFloat32(),
    m_CycleOffset: reader.readFloat32(),
    m_Mirror: readBool(reader),
  };
  reader.align();
  return node;
}

function readStateConstant(reader: ObjectReader): StateConstant {
  const state: StateConstant = {
    m_TransitionConstantArray: readOffsetPtrs(
      reader,
      "m_TransitionConstantArray",
      readTransitionConstant,
    ),
    m_BlendTreeConstantIndexArray: readInts(reader, OWNER, "m_BlendTreeConstantIndexArray"),
    m_BlendTreeConstantArray: readOffsetPtrs(reader, "m_BlendTreeConstantArray", (r) => ({
      m_NodeArray: readOffsetPtrs(r, "m_NodeArray", readBlendTreeNodeConstant),
    })),
    m_NameID: reader.readUInt32(),
    m_PathID: reader.readUInt32(),
    m_FullPathID: reader.readUInt32(),
    m_TagID: reader.readUInt32(),
    m_SpeedParamID: reader.readUInt32(),
    m_MirrorParamID: reader.readUInt32(),
    m_CycleOffsetParamID: reader.readUInt32(),
    m_TimeParamID: reader.readUInt32(),
    m_Speed: reader.readFloat32(),
    m_CycleOffset: reader.readFloat32(),
    m_IKOnFeet: readBool(reader),
    m_WriteDefaultValues: readBool(reader),
    m_Loop: readBool(reader),
    m_Mirror: readBool(reader),
  };
  reader.align();
  return state;
}

function readSelectorStateConstant(reader: ObjectReader): SelectorStateConstant {
  const state: SelectorStateConstant = {
    m_TransitionConstantArray: readOffsetPtrs(reader, "m_TransitionConstantArray", (r) => ({
      m_Destination: r.readUInt32(),
      m_ConditionConstantArray: readConditions(r),
    })),
    m_FullPathID: reader.readUInt32(),
    m_IsEntry: readBool(reader),
  };
  reader.align();
  return state;
}

function readStateMachineConstant(
  reader: ObjectReader,
  version: UnityVersion,
): StateMachineConstant {
  const machine: StateMachineConstant = {
    m_StateConstantArray: readOffsetPtrs(reader, "m_StateConstantArray", readStateConstant),
    m_AnyStateTransitionConstantArray: readOffsetPtrs(
      reader,
      "m_AnyStateTransitionConstantArray",
      readTransitionConstant,
    ),
    m_SelectorStateConstantArray: readOffsetPtrs(
      reader,
      "m_SelectorStateConstantArray",
      readSelectorStateConstant,
    ),
    m_DefaultState: reader.readUInt32(),
    m_SynchronizedLayerCount: reader.readUInt32(),
  };
  // 6000.4+ (TPK; upstream does not read it).
  if (atLeast(version, 6000, 4)) {
    machine.m_EvaluateTransitionsOnStart = readBool(reader);
    reader.align();
  }
  return machine;
}

function readValueArray(reader: ObjectReader, version: UnityVersion): ValueArray {
  const values: ValueArray = {
    m_PositionValues: readArray(reader, OWNER, "m_PositionValues", readFloat3),
    m_QuaternionValues: readArray(reader, OWNER, "m_QuaternionValues", readFloat4),
    m_ScaleValues: readArray(reader, OWNER, "m_ScaleValues", readFloat3),
    m_FloatValues: readFloats(reader, OWNER, "m_FloatValues"),
    m_IntValues: readInts(reader, OWNER, "m_IntValues"),
    m_BoolValues: readArray(reader, OWNER, "m_BoolValues", readBool),
  };
  reader.align();
  // 6000.2+ (TPK; upstream does not read it).
  if (atLeast(version, 6000, 2)) {
    const count = readCount(reader, `${OWNER} ${reader.pathId} m_EntityIdValues`);
    if (count !== 0) {
      throw new UnsupportedError(
        "EntityId values",
        String(count),
        `object ${reader.pathId}: m_EntityIdValues holds ${count} entity ids, whose layout ` +
          "no type tree gives",
      );
    }
    values.m_EntityIdValues = [];
  }
  return values;
}

function readVector2(reader: ObjectReader): Vector2 {
  return { x: reader.readFloat32(), y: reader.readFloat32() };
}
