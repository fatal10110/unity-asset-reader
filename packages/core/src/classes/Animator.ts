// Ported from AssetStudio/Classes/Animator.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Behaviour.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { animationLayoutVersion, readBool } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject } from "./Sprite.js";
import { atLeast } from "./version.js";

/**
 * The fields of an `Animator` component, as a player build stores them,
 * under Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object.
 *
 * Unity renamed `m_KeepAnimatorControllerStateOnDisable` to
 * `m_KeepAnimatorStateOnDisable` (same byte): an object has one of the two.
 */
export interface Animator extends EditorExtension {
  /** The GameObject it is attached to. */
  m_GameObject: PPtr;
  /** A `UInt8`, 1 when enabled, kept as the number the file holds. */
  m_Enabled: number;
  m_Avatar: PPtr;
  /** The `AnimatorController` or `AnimatorOverrideController`. */
  m_Controller: PPtr;
  /** Unity's `AnimatorCullingMode`: 0 always animate, 1 cull update transforms, 2 cull completely. */
  m_CullingMode: number;
  /** Unity's `AnimatorUpdateMode`: 0 normal, 1 animate physics (`Fixed`), 2 unscaled time. */
  m_UpdateMode: number;
  m_ApplyRootMotion: boolean;
  m_LinearVelocityBlending: boolean;
  /** Unity 2020.3.43 to 2020.3, and 2021.2 and later. */
  m_StabilizeFeet?: boolean;
  /** Unity 2023.1 and later. */
  m_AnimatePhysics?: boolean;
  m_HasTransformHierarchy: boolean;
  m_AllowConstantClipSamplingOptimization: boolean;
  /** Before the rename: see {@link m_KeepAnimatorStateOnDisable}. */
  m_KeepAnimatorControllerStateOnDisable?: boolean;
  /**
   * `m_KeepAnimatorControllerStateOnDisable` renamed: Unity 2020.3.43 to
   * 2020.3, 2021.3.16 to 2021.3, 2022.1.24 to 2022.1, and 2022.2 and later.
   */
  m_KeepAnimatorStateOnDisable?: boolean;
  /** Unity 2020.3.46 to 2020.3, 2021.3.20 to 2021.3, and 2022.2.9 and later. */
  m_WriteDefaultValuesOnDisable?: boolean;
}

/**
 * Read an `Animator` from the object's first byte: the `Component` field
 * `m_GameObject`, the `Behaviour` field `m_Enabled` and its padding, then
 * every field Unity's own player type trees give for its version (as UnityPy's
 * TPK data records them), in their order. The object must end exactly there.
 *
 * Upstream reads the 2019.1 fields and `m_StabilizeFeet` from 2021.2; it
 * lacks what TPK adds, at the patch release TPK first records it:
 * `m_StabilizeFeet` also from 2020.3.43, the rename of
 * `m_KeepAnimatorControllerStateOnDisable` to `m_KeepAnimatorStateOnDisable`
 * (2020.3.43, 2021.3.16, 2022.1.24, 2022.2), `m_WriteDefaultValuesOnDisable`
 * (2020.3.46, 2021.3.20, 2022.2.9) and `m_AnimatePhysics` (2023.1).
 * Upstream's game-specific fields (`m_FBIKAvatar`, `m_MotionSkeletonMode`)
 * are not Unity's and are not read.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). TPK
 * records 2022.2.0a13 and 2023.1.0a1 to a5 with the old name, and 2023.1
 * alphas and betas before b7 without some of the 2023.1 fields; such a
 * pre-release gets the wrong key name or fails the end-of-object check.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields do not fit
 *   2019's layout. Of kind `"build target"` for an editor file
 *   (`BuildTarget.NoTarget`)
 * @throws {CorruptError} when the object ends early or bytes are left over
 *   after the last field, with the version known
 */
export function readAnimator(reader: ObjectReader): Animator {
  const version = animationLayoutVersion(reader, "Animator");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Animator> = readEditorExtension(reader);
  assumingLayout(reader, "Animator", () => readAnimatorFields(reader, version, out));
  // Every required field was set above.
  return out as Animator;
}

function readAnimatorFields(reader: ObjectReader, version: UnityVersion, out: Partial<Animator>) {
  out.m_GameObject = readPPtr(reader);
  out.m_Enabled = reader.readUInt8();
  reader.align();
  out.m_Avatar = readPPtr(reader);
  out.m_Controller = readPPtr(reader);
  out.m_CullingMode = reader.readInt32();
  out.m_UpdateMode = reader.readInt32();
  out.m_ApplyRootMotion = readBool(reader);
  out.m_LinearVelocityBlending = readBool(reader);
  if (patchFrom(version, 2020, 3, 43) || atLeast(version, 2021, 2)) {
    out.m_StabilizeFeet = readBool(reader);
  }
  if (atLeast(version, 2023, 1)) out.m_AnimatePhysics = readBool(reader);
  reader.align();
  out.m_HasTransformHierarchy = readBool(reader);
  out.m_AllowConstantClipSamplingOptimization = readBool(reader);
  const renamed =
    patchFrom(version, 2020, 3, 43) ||
    patchFrom(version, 2021, 3, 16) ||
    patchFrom(version, 2022, 1, 24) ||
    atLeast(version, 2022, 2);
  if (renamed) out.m_KeepAnimatorStateOnDisable = readBool(reader);
  else out.m_KeepAnimatorControllerStateOnDisable = readBool(reader);
  if (
    patchFrom(version, 2020, 3, 46) ||
    patchFrom(version, 2021, 3, 20) ||
    atLeast(version, 2022, 2, 9)
  ) {
    out.m_WriteDefaultValuesOnDisable = readBool(reader);
  }
  reader.align();
  endOfObject(reader, "Animator");
}

/** Whether the version is `major.minor.patch` or a later patch of that same `major.minor`. */
function patchFrom(version: UnityVersion, major: number, minor: number, patch: number): boolean {
  return version[0] === major && version[1] === minor && version[2] >= patch;
}
