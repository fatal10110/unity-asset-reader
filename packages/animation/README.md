# unity-asset-reader-animation

AnimationClip curves for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
`clipCurves()` decodes a Unity `AnimationClip` into the curves
[AssetStudio](https://github.com/Razviar/assetstudio)'s `.anim` export holds, as plain data.
Synchronous, no dependencies, and it runs anywhere `unity-asset-reader` does: browsers, Workers,
Node.js.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-animation
```

`unity-asset-reader` is a peer dependency (`^1.3.0`, the first core to read `AnimationClip`,
`Avatar`, `Animator` and the scene objects), so your app has exactly one copy of the parser.

## Usage

```js
import { load } from "unity-asset-reader";
import { clipCurves } from "unity-asset-reader-animation";

const env = load(bytes);
for (const asset of env.assets("AnimationClip")) {
  const { rotation, position, float, events } = clipCurves(env, asset.reader);
  for (const curve of position) {
    console.log(curve.path, curve.keyframes.map((k) => [k.time, k.value]));
  }
}
```

## API reference

`clipCurves(env, clip)` returns a `ClipCurves`: the `Curves` lists below and `events`. A
`TransformCurve` has `path` and `keyframes`; a `FloatCurve` and a `PPtrCurve` also `attribute`
and `classId`. A `CurveKey` holds `time`, `value`, `inSlope` and `outSlope`, a `PPtrKey` `time`
and `value` (a `PPtr`). `clip` is the clip's object reader (`asset.reader`), one of
`env.objects`; it throws a `TypeError` for an object of another class, an `Error` where
AssetStudio's conversion fails (a curve without a binding, an object reference index outside the
clip's table), and what reading the objects throws.

`muscleName(attribute)` names a humanoid muscle binding as AssetStudio does (`RootT.y`,
`Spine Front-Back`); `clipCurves()` uses it for every muscle curve.

## What it returns

The lists of AssetStudio's `.anim` (`AnimationClipExtensions.Convert`), in its order:

- `rotation` (quaternions), `euler`, `position` and `scale` (vectors): per curve the Transform's
  `path` below the animated GameObject (`""` for the GameObject itself) and its `keyframes`.
- `float`: per curve `path`, `attribute` and `classId` (the animated component's class), and its
  `keyframes`. Humanoid curves are named muscle attributes (`RootT.y`, `Spine Front-Back`,
  `LeftHand.Index.Spread`) on path `""` and class 95 (`Animator`); they are not converted to bone
  rotations. Blend shape weights are `blendShape.<name>`.
- `pptr`: object reference curves (a sprite swap), per key a time and a `PPtr`.
- `events`: the clip's `m_Events`.

Each keyframe holds `time`, `value`, `inSlope` and `outSlope`, every number a float32 value
computed as AssetStudio computes it.

A Mecanim clip stores its curves in `m_MuscleClip` as streamed keys, dense samples and constants,
bound to paths and properties by CRC-32 hashes. They are decoded as AssetStudio's
`AnimationClipConverter` does:

- Streamed keys keep their out slopes, and their in slopes are computed from the key before (a
  stepped segment gives `Infinity`). Float curves get no slopes, as in AssetStudio.
- Dense samples become a key per frame, constants a key at time 0 and one at the clip's last frame,
  without slopes.
- A path hash is named from the loaded `Avatar`s' path tables and the hierarchy of each `Animator`
  that plays the clip. Load the bundle that holds them with the clip; a hash nothing names stays
  `path_<hash>`.
- Blend shape and material property hashes are named from the renderer at the curve's path, and
  stay numbers without it. Engine properties AssetStudio does not name are `typetree_<hash>`,
  script fields `script_<hash>`.

A legacy clip's curve arrays are merged after the decoded curves, as AssetStudio merges them.

## Not included

- YAML (`.anim` text) output.
- Muscle-to-bone conversion of humanoid clips.
- `m_CompressedRotationCurves`, which AssetStudio leaves compressed too.
- Names from a legacy `Animation` component's hierarchy, and from `RectTransform` hierarchies:
  core reads neither class yet.

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar):
  `clipCurves()` is hand-ported from its `AnimationClipConverter.cs`, `AnimationClipExtensions.cs`,
  `CustomCurveResolver.cs` and `MuscleHelper.cs` (`AssetStudio.Utility/YAML/`), `StreamedClip.ReadData`
  and its CRC-32, and it is tested against the curves of AssetStudio's own `.anim` export, from
  clips built by Unity 2019.4, 2020.3 and 6000.3.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): names the fixture objects the tests
  convert.

The full list is in the [repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

MIT. `clipCurves()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/animation/NOTICE).
