// Ported from AssetStudio/Classes/AnimatorOverrideController.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { animationLayoutVersion } from "./animation.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray } from "./Sprite.js";

/** One clip an override controller replaces (Unity's `AnimationClipOverride`). */
export interface AnimationClipOverride {
  /** The clip of the base controller. */
  m_OriginalClip: PPtr;
  /** The clip played instead; a null pointer when not overridden. */
  m_OverrideClip: PPtr;
}

/**
 * The fields of an `AnimatorOverrideController`, as a player build stores
 * them, under Unity's names: the keys, their order and their values agree
 * with `readTypeTree()` on the same object.
 */
export interface AnimatorOverrideController extends NamedObject {
  /** The controller whose clips it overrides. */
  m_Controller: PPtr;
  m_Clips: AnimationClipOverride[];
}

/**
 * Read an `AnimatorOverrideController` from the object's first byte:
 * `m_Name`, `m_Controller` and `m_Clips`, the same in every Unity version
 * from 2019.1 (TPK). The object must end exactly there.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: before 2019.1, for an unknown version unless
 *   the format is 18 to 21, and in those formats when the fields after
 *   `m_Name` do not fit 2019's layout. Of kind `"build target"` for an editor
 *   file (`BuildTarget.NoTarget`)
 * @throws {CorruptError} when the object ends early, a count is negative or
 *   runs past its end, or bytes are left over after the last field, with the
 *   version known; with it unknown, only inside `m_Name`
 */
export function readAnimatorOverrideController(reader: ObjectReader): AnimatorOverrideController {
  animationLayoutVersion(reader, "AnimatorOverrideController");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<AnimatorOverrideController> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "AnimatorOverrideController", () => {
    out.m_Controller = readPPtr(reader);
    out.m_Clips = readArray(reader, "AnimatorOverrideController", "m_Clips", (r) => ({
      m_OriginalClip: readPPtr(r),
      m_OverrideClip: readPPtr(r),
    }));
    endOfObject(reader, "AnimatorOverrideController");
  });
  // Every required field was set above.
  return out as AnimatorOverrideController;
}
