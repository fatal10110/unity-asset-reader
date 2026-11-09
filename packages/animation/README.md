# unity-asset-reader-animation

AnimationClip curves for [`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md):
`clipCurves()` decodes a Unity `AnimationClip` into the curves
[AssetStudio](https://github.com/Razviar/assetstudio)'s `.anim` export holds, as plain data.
`sceneToGltf()` writes a GameObject's scene (its hierarchy, skinned meshes, blend shapes and those
curves) as a binary glTF 2.0 file. Synchronous, no dependencies, and it runs anywhere
`unity-asset-reader` does: browsers, Workers, Node.js.

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

`sceneToGltf(env, root, { clips })` writes the scene of `root` (a GameObject, or an Animator for
its GameObject) as a `.glb` (`Uint8Array`), animated by `clips` (`SceneToGltfOptions.clips`:
AnimationClip readers, each read with `clipCurves()`); see [glTF scene export](#gltf-scene-export).
It throws `UnsupportedError` for an optimized hierarchy (the Animator's `m_HasTransformHierarchy`
false, or a skinned renderer with bind poses but no `m_Bones`; upstream rebuilds those from the
Avatar and `m_BoneNameHashes`), a skin glTF cannot hold (bones not one per bind pose, or outside
the hierarchy) or a mesh without positions or triangles, `CorruptError` for indices past the data.

```js
import { sceneToGltf } from "unity-asset-reader-animation";

const animator = [...env.assets("Animator")][0].reader;
const clips = [...env.assets("AnimationClip")].map((asset) => asset.reader);
const glb = sceneToGltf(env, animator, { clips });
```

`muscleName(attribute)` names a humanoid muscle binding as AssetStudio does (`RootT.y`,
`Spine Front-Back`); `clipCurves()` uses it for every muscle curve.

## What it returns

The lists of AssetStudio's `.anim` (`AnimationClipExtensions.Convert`), in its order:

- `rotation` (quaternions), `euler`, `position` and `scale` (vectors): per curve the Transform's
  `path` below the animated GameObject (`""` for the GameObject itself) and its `keyframes`.
- `float`: per curve `path`, `attribute` and `classId` (the animated component's class), and its
  `keyframes`. Humanoid curves are named muscle attributes (`RootT.y`, `Spine Front-Back`,
  `LeftHand.Index.Spread`) on path `""` and class 95 (`Animator`), as the clip stores them;
  `sceneToGltf()` turns them into bone rotations. Blend shape weights are `blendShape.<name>`.
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
- A path hash is named from the loaded `Avatar`s' path tables, the hierarchy of each `Animator`
  that plays the clip and that of each legacy `Animation` component that lists it. A UI
  hierarchy's `RectTransform`s count as `Transform`s, as in AssetStudio. Load the bundle
  that holds them with the clip; a hash nothing names stays `path_<hash>`.
- Blend shape and material property hashes are named from the renderer at the curve's path, and
  stay numbers without it. Engine properties AssetStudio does not name are `typetree_<hash>`,
  script fields `script_<hash>`.

A legacy clip's curve arrays are merged after the decoded curves, as AssetStudio merges them.

## glTF scene export

`sceneToGltf()` converts what AssetStudio's FBX export (`ModelConverter`) converts, into a
validator-clean glTF 2.0 `.glb`, from Unity's left-handed space as AssetStudio and `meshToGltf`
(unity-asset-reader-mesh) convert it: positions, translations and blend shape deltas get x
negated, rotations y and z, bind poses are mirrored on both sides, triangles reverse winding.

- Nodes: the root's ancestors and its hierarchy, each GameObject's local position, rotation and
  scale. Inactive GameObjects are written too.
- Meshes: each SkinnedMeshRenderer's mesh, and each MeshRenderer's MeshFilter mesh, from the root
  down (the ancestors' renderers are left out, as upstream does), with
  `POSITION`, `NORMAL` and `TEXCOORD_0`; no materials, tangents, colours or other UV channels.
- Skins: joints from the renderer's `m_Bones`, in order, inverse bind matrices from the mesh's
  bind poses, `JOINTS_0` and `WEIGHTS_0` from its bone weights. A renderer without bones writes
  its mesh unskinned when the mesh has no bind poses, and throws when it has some.
- Blend shapes: a morph target per channel, from its last (full weight) frame; glTF has no
  in-between frames. Weights are Unity's over that full weight, so 1 is the full shape.
- Animations: `translation`, `rotation`, `scale` and blend shape `weights` channels, each a
  `CUBICSPLINE` sampler built from Unity's Hermite keys: samples at the union of the components'
  key times, tangents Unity's slopes (exact at the keys, and between them the same cubic Unity
  evaluates). A stepped key (an infinite slope) holds its value and jumps one float32 step before
  the next key, or the channel is `STEP` when every key is stepped. Weighted tangents fall back to
  plain Hermite. Euler curves are converted as `Quaternion.Euler` does; between keys glTF's spline
  only approximates them, and AssetStudio converts euler angles with the native FBX SDK, so that
  conversion has no oracle.
- Humanoid clips: when the root's Animator has a humanoid Avatar, a clip's muscle curves and
  `RootQ` become `rotation` channels on the human bones, see below. They replace any Transform
  curve on those bones. Without a humanoid Avatar the muscle curves are skipped.
- Skipped, since glTF has no channel for them: `m_IsActive` and every other float or object
  reference curve, curves whose path names no node. Of a humanoid clip: the body position
  (`RootT`, see below), the motion curves (`MotionT`, `MotionQ`), the IK goals (`LeftFootT`,
  ...), the finger muscles and the translation DoFs.

### Humanoid clips

AssetStudio has no muscle-to-bone conversion and no permissively licensed one exists, so this
one is derived from the Avatar's own data (`m_Avatar.m_Human`) and Unity's public documentation
([Muscle definitions](https://docs.unity3d.com/Manual/MuscleDefinitions.html),
[HumanPose](https://docs.unity3d.com/ScriptReference/HumanPose.html),
[HumanTrait](https://docs.unity3d.com/ScriptReference/HumanTrait.html),
[HumanLimit](https://docs.unity3d.com/ScriptReference/HumanLimit.html),
[HumanDescription](https://docs.unity3d.com/ScriptReference/HumanDescription.html)), and checked
against the poses the Unity editor makes from the same muscles (the oracle of plan §5,
`fixtures/humanoid-unity-goldens.json`):

1. Each muscle is an angle on one axis of one bone (`HumanTrait.MuscleFromBone`): 0 is the
   limit's centre, a positive value scales the axis' `m_Limit.m_Max`, a negative one its `m_Min`.
2. A bone's rotation in its human parent's space is `m_PreQ * swingTwist(m_Sgn * angles) *
   conj(m_PostQ)`: the X angle twists the bone about its own axis, then Y and Z swing it about an
   axis of the YZ plane, each entering as the tangent of its half angle.
3. Twist split: an upper arm, forearm, upper leg and lower leg keep the Avatar's share
   (`m_ArmTwist`, `m_ForeArmTwist`, `m_UpperLegTwist`, `m_LegTwist`) of their twist and pass the
   rest to the child bone.
4. An avatar without an UpperChest turns the Chest by the UpperChest muscles too, over Unity's
   default UpperChest range of ±20° (`HumanTrait.GetMuscleDefaultMax`), the one constant not from
   the Avatar: such an Avatar holds no limits for the bone.
5. The Hips turn so that the body has the clip's `RootQ`: the body frame's up runs from the middle
   of the upper legs to the middle of the upper arms, its right from the left upper leg and arm to
   the right ones (by it the T-pose body frame `m_RootX` is the identity).
6. The clip is sampled at its `m_SampleRate` and at every key, and written as `LINEAR` rotation
   channels (the conversion is not linear, so the curves' tangents do not carry over), each
   sample in the hemisphere of the one before, then mirrored as every rotation is.

On the fixture rig, in Unity 2019.4, 2020.3, 6000.3 and 6000.6, every bone's rotation is within
7e-7 rad of Unity's, the Hips' within 2.3e-5 rad (the owner's tolerance on #319: 1e-3 rad).

The body position (`RootT`, the body's centre of mass) is not converted: the Hips keep their
skeleton position. No centre of mass definition met the tolerance of 1e-4 × the human scale; the
closest (the bones' joints, each half its length along the bone, weighted by `m_HumanBoneMass`)
was off by 4.7e-3 × the human scale (about 5 mm on the fixture).

The fixture rig leaves these untested: a bind pose with rotated bones, bones between human bones
(rotations through them are corrected but unchecked), an Avatar with an UpperChest, twist shares
other than 0.5 (so which bone keeps which share), limits other than Unity's defaults, and fingers,
eyes and jaw (the fingers are not converted).

## Not included

- YAML (`.anim` text) output.
- A humanoid clip's body position, finger muscles and root motion (see Humanoid clips).
- `m_CompressedRotationCurves`, which AssetStudio leaves compressed too.

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
