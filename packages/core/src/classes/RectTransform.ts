// Ported from AssetStudio/Classes/RectTransform.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Transform.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { animationLayoutVersion } from "./animation.js";
import { readEditorExtension } from "./EditorExtension.js";
import type { Vector2 } from "./Material.js";
import { assumingLayout, endOfObject } from "./Sprite.js";
import { readTransformFields, type Transform } from "./Transform.js";

/**
 * The fields of a `RectTransform` component (class 224), the `Transform` of a
 * UI element, as a player build stores them, under Unity's names: the keys,
 * their order and their values agree with `readTypeTree()` on the same object.
 */
export interface RectTransform extends Transform {
  /** The anchor of the lower left corner, as a fraction of the parent's rectangle. */
  m_AnchorMin: Vector2;
  /** The anchor of the upper right corner, as a fraction of the parent's rectangle. */
  m_AnchorMax: Vector2;
  /** The pivot's position relative to the anchors' reference point. */
  m_AnchoredPosition: Vector2;
  /** The size relative to the distances between the anchors. */
  m_SizeDelta: Vector2;
  /** The point it rotates and scales around, as a fraction of its own rectangle. */
  m_Pivot: Vector2;
}

/**
 * Read a `RectTransform` from the object's first byte: the `Transform` fields
 * (`m_GameObject`, the local rotation, position and scale, the children and
 * the parent), then `m_AnchorMin`, `m_AnchorMax`, `m_AnchoredPosition`,
 * `m_SizeDelta` and `m_Pivot`. The object must end exactly there.
 *
 * Upstream's `RectTransform` reads only the `Transform` fields and leaves the
 * rest of the object unread; the five anchor fields and their order come from
 * Unity's player type trees (as UnityPy's TPK data records them), which keep
 * this one layout from 2019.1 to 6000.6 (later keys change only flags).
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
export function readRectTransform(reader: ObjectReader): RectTransform {
  animationLayoutVersion(reader, "RectTransform");
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<RectTransform> = readEditorExtension(reader);
  assumingLayout(reader, "RectTransform", () => {
    readTransformFields(reader, "RectTransform", out);
    out.m_AnchorMin = readVector2(reader);
    out.m_AnchorMax = readVector2(reader);
    out.m_AnchoredPosition = readVector2(reader);
    out.m_SizeDelta = readVector2(reader);
    out.m_Pivot = readVector2(reader);
    endOfObject(reader, "RectTransform");
  });
  // Every field was set above.
  return out as RectTransform;
}

function readVector2(reader: ObjectReader): Vector2 {
  return { x: reader.readFloat32(), y: reader.readFloat32() };
}
