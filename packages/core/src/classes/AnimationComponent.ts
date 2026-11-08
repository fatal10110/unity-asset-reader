// Ported from AssetStudio/Classes/Animation.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Behaviour.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { animationLayoutVersion, readBool } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray } from "./Sprite.js";
import { atLeast } from "./version.js";

/**
 * The fields of a legacy `Animation` component, as a player build stores
 * them, under Unity's names: the keys, their order and their values agree
 * with `readTypeTree()` on the same object.
 */
export interface Animation extends EditorExtension {
  /** The GameObject it is attached to. */
  m_GameObject: PPtr;
  /** A `UInt8`, 1 when enabled, kept as the number the file holds. */
  m_Enabled: number;
  /** The default clip (`Animation.clip`). */
  m_Animation: PPtr;
  /** The clips it can play (`AnimationUtility.SetAnimationClips`). */
  m_Animations: PPtr[];
  /** Unity's `WrapMode`: 0 default, 1 once, 2 loop, 4 ping-pong, 8 clamp forever. */
  m_WrapMode: number;
  m_PlayAutomatically: boolean;
  m_AnimatePhysics: boolean;
  /** Unity 2023.1 and later. */
  m_UpdateMode?: number;
  /** Unity's `AnimationCullingType`: 0 always animate, 1 based on renderers. */
  m_CullingType: number;
}

/**
 * Read an `Animation` from the object's first byte: the `Component` field
 * `m_GameObject`, the `Behaviour` field `m_Enabled` and its padding, then
 * every field Unity's own player type trees give for its version (as UnityPy's
 * TPK data records them), in their order. The object must end exactly there.
 *
 * Upstream reads `m_Animation` (and discards it) and `m_Animations`, and
 * stops; the rest comes from TPK: `m_WrapMode`, `m_PlayAutomatically`,
 * `m_AnimatePhysics` and `m_CullingType` from 2019.1, and `m_UpdateMode`
 * before `m_CullingType` from 2023.1.
 *
 * ponytail: the gate compares release numbers only (see `atLeast`). TPK
 * records `m_UpdateMode` from 2023.1.0a5, so a 2023.1 alpha before a5 fails
 * the end-of-object check.
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
export function readAnimation(reader: ObjectReader): Animation {
  const version = animationLayoutVersion(reader, "Animation");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Animation> = readEditorExtension(reader);
  assumingLayout(reader, "Animation", () => readAnimationFields(reader, version, out));
  // Every required field was set above.
  return out as Animation;
}

function readAnimationFields(reader: ObjectReader, version: UnityVersion, out: Partial<Animation>) {
  out.m_GameObject = readPPtr(reader);
  out.m_Enabled = reader.readUInt8();
  reader.align();
  out.m_Animation = readPPtr(reader);
  out.m_Animations = readArray(reader, "Animation", "m_Animations", readPPtr);
  out.m_WrapMode = reader.readInt32();
  out.m_PlayAutomatically = readBool(reader);
  out.m_AnimatePhysics = readBool(reader);
  reader.align();
  // 2023.1+: m_UpdateMode.
  if (atLeast(version, 2023, 1)) out.m_UpdateMode = reader.readInt32();
  out.m_CullingType = reader.readInt32();
  endOfObject(reader, "Animation");
}
