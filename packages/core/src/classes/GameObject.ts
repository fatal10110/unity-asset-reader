// Ported from AssetStudio/Classes/GameObject.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { animationLayoutVersion, readBool } from "./animation.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { assumingLayout, endOfObject, readArray } from "./Sprite.js";
import { readStringField } from "./strings.js";

/** One entry of a GameObject's `m_Component`: Unity's `ComponentPair`. */
export interface ComponentPair {
  /** The component: a `Transform` first, then the rest in the inspector's order. */
  component: PPtr;
}

/**
 * The fields of a `GameObject`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object.
 */
export interface GameObject extends EditorExtension {
  m_Component: ComponentPair[];
  /** The layer, 0 to 31. */
  m_Layer: number;
  m_Name: string;
  /** An index into the project's tags: 0 `Untagged`, then Unity's own and the project's. */
  m_Tag: number;
  /** The GameObject's own active flag (`activeSelf`). */
  m_IsActive: boolean;
}

/**
 * Read a `GameObject` from the object's first byte: its components, layer,
 * name, tag and active flag, as Unity's own player type trees give them from
 * 2019.1 (as UnityPy's TPK data records them; one layout to 6000.6). The
 * object must end exactly there.
 *
 * Upstream reads the components, the layer and the name and stops; TPK adds
 * `m_Tag` and `m_IsActive`, which follow. Its pre-5.5 extra `int` per
 * component is below the 2019.1 floor.
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
export function readGameObject(reader: ObjectReader): GameObject {
  animationLayoutVersion(reader, "GameObject");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<GameObject> = readEditorExtension(reader);
  assumingLayout(reader, "GameObject", () => {
    readHeader(reader, out);
    out.m_Tag = reader.readUInt16();
    out.m_IsActive = readBool(reader);
    endOfObject(reader, "GameObject");
  });
  // Every field was set above.
  return out as GameObject;
}

/**
 * A `GameObject`'s `m_Name` without a type tree: its header only, as
 * upstream's reader goes (the components, the layer, the name), so nothing
 * after the name has to fit. Internal: `asset.name`'s reader for a bundle
 * built without type trees (#308).
 *
 * @param reader the object's reader, rewound first and left just past `m_Name`
 * @throws {UnsupportedError} as {@link readGameObject} refuses a version or an
 *   editor file, and of kind `"Unity version"` when an unknown version's
 *   header does not fit 2019's layout
 * @throws {CorruptError} when the object ends before its name, with the
 *   version known
 */
export function readGameObjectName(reader: ObjectReader): string {
  animationLayoutVersion(reader, "GameObject");
  const out: Partial<GameObject> = readEditorExtension(reader);
  assumingLayout(reader, "GameObject", () => readHeader(reader, out));
  return out.m_Name!;
}

/** `m_Component`, `m_Layer` and `m_Name`, the fields upstream reads, into `out`. */
function readHeader(reader: ObjectReader, out: Partial<GameObject>): void {
  out.m_Component = readArray(reader, "GameObject", "m_Component", (r) => ({
    component: readPPtr(r),
  }));
  out.m_Layer = reader.readUInt32();
  out.m_Name = readStringField(reader, "GameObject", "m_Name");
}
