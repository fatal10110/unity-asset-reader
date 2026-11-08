// Ported from AssetStudio/Classes/MeshFilter.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { animationLayoutVersion } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject } from "./Sprite.js";

/**
 * The fields of a `MeshFilter` component, as a player build stores them,
 * under Unity's names: the keys, their order and their values agree with
 * `readTypeTree()` on the same object.
 */
export interface MeshFilter extends EditorExtension {
  /** The GameObject it is attached to. */
  m_GameObject: PPtr;
  /** The `Mesh` its GameObject's `MeshRenderer` draws. */
  m_Mesh: PPtr;
}

/**
 * Read a `MeshFilter` from the object's first byte: the `Component` field
 * `m_GameObject`, then `m_Mesh`. Unity's player type trees (as UnityPy's TPK
 * data records them) keep this one layout from 2019.1 to 6000.6, as upstream
 * reads it. The object must end exactly there.
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
export function readMeshFilter(reader: ObjectReader): MeshFilter {
  animationLayoutVersion(reader, "MeshFilter");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<MeshFilter> = readEditorExtension(reader);
  assumingLayout(reader, "MeshFilter", () => {
    out.m_GameObject = readPPtr(reader);
    out.m_Mesh = readPPtr(reader);
    endOfObject(reader, "MeshFilter");
  });
  // Every field was set above.
  return out as MeshFilter;
}
