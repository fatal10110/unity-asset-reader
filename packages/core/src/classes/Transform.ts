// Ported from AssetStudio/Classes/Transform.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader, Quaternion, Vector3 } from "../serialized/ObjectReader.js";
import { animationLayoutVersion, readFloat3, readFloat4 } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray } from "./Sprite.js";

/**
 * The fields of a `Transform` component, as a player build stores them, under
 * Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object.
 */
export interface Transform extends EditorExtension {
  /** The GameObject it is attached to. */
  m_GameObject: PPtr;
  /** Rotation relative to the parent. */
  m_LocalRotation: Quaternion;
  /** Position relative to the parent. */
  m_LocalPosition: Vector3;
  /** Scale relative to the parent. */
  m_LocalScale: Vector3;
  /** The child Transforms, in hierarchy order. */
  m_Children: PPtr[];
  /** The parent Transform; a null pointer for a root. */
  m_Father: PPtr;
}

/**
 * Read a `Transform` from the object's first byte: the `Component` field
 * `m_GameObject`, the local rotation, position and scale, the children and
 * the parent. Unity's player type trees (as UnityPy's TPK data records them)
 * keep this one layout from 2019.1 to 6000.6, as upstream reads it. The
 * object must end exactly there.
 *
 * A `RectTransform` (class 224) is read by `readRectTransform`.
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
export function readTransform(reader: ObjectReader): Transform {
  animationLayoutVersion(reader, "Transform");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Transform> = readEditorExtension(reader);
  assumingLayout(reader, "Transform", () => {
    readTransformFields(reader, "Transform", out);
    endOfObject(reader, "Transform");
  });
  // Every field was set above.
  return out as Transform;
}

/**
 * Read the `Transform` fields after the `EditorExtension` ones into `out`, in
 * Unity's order: `m_GameObject` to `m_Father` (a `RectTransform` reads them
 * too, then its own).
 *
 * @param owner the class named in errors
 * @throws {CorruptError} when the object ends early
 */
export function readTransformFields(
  reader: ObjectReader,
  owner: string,
  out: Partial<Transform>,
): void {
  out.m_GameObject = readPPtr(reader);
  out.m_LocalRotation = readFloat4(reader);
  out.m_LocalPosition = readFloat3(reader);
  out.m_LocalScale = readFloat3(reader);
  out.m_Children = readArray(reader, owner, "m_Children", readPPtr);
  out.m_Father = readPPtr(reader);
}
