// brotliDecompress/lzhamDecompress stay internal: neither is reachable from a
// stock bundle, so two always-throwing symbols are not public API.
export { NodeFlags, readBundle } from "./bundle/BundleFile.js";
export type { BundleFile, BundleHeader, StreamFile } from "./bundle/BundleFile.js";
export { detectContainer, detectFileType } from "./bundle/detect.js";
export type { FileType, SupportedFileType } from "./bundle/detect.js";
export { readWebFile } from "./bundle/WebFile.js";
export type { WebFile } from "./bundle/WebFile.js";
export { gunzip, unzlib } from "./codec/inflate.js";
export { decompressLz4 } from "./codec/lz4.js";
export { lzmaDecompress } from "./codec/lzma.js";
export { diff } from "./diff.js";
export type { DiffEntry } from "./diff.js";
export { load } from "./env.js";
export { formatSingle, formatSingleInvariant } from "./float.js";
export { GltfWriter } from "./gltf/writer.js";
export type {
  GltfAccessor,
  GltfAccessorType,
  GltfAnimation,
  GltfAnimationChannel,
  GltfAnimationSampler,
  GltfComponentArray,
  GltfMesh,
  GltfNode,
  GltfPrimitive,
  GltfSkin,
} from "./gltf/writer.js";
export type { Env, LoadedFile, LoadInput, LoadOptions, LoadSource } from "./env.js";
export { open } from "./open.js";
export type {
  BlobLike,
  OpenOptions,
  OpenSource,
  RequestLike,
  ResponseLike,
  URLLike,
} from "./open.js";
export type { Asset, AssetDataMap, AssetType, KnownAssetType } from "./asset.js";
export { CorruptError, ResourceNotFoundError, UnsupportedError } from "./errors.js";
export { BinaryReader, type Endian } from "./io/BinaryReader.js";
export { BuildTarget } from "./serialized/BuildTarget.js";
export { SerializedFileFormatVersion } from "./serialized/FormatVersion.js";
export { readSerializedFile } from "./serialized/SerializedFile.js";
export type {
  FileIdentifier,
  LocalSerializedObjectIdentifier,
  ObjectInfo,
  SerializedFile,
  SerializedFileHeader,
  UnityVersion,
} from "./serialized/SerializedFile.js";
export type { SerializedType, TypeTreeNode } from "./serialized/TypeTree.js";
export type { TypeTreeNodeData } from "./serialized/supplied.js";
export { ClassID, classIdName } from "./serialized/ClassID.js";
export { ObjectReader } from "./serialized/ObjectReader.js";
export type { PPtr, PPtrResolution } from "./classes/PPtr.js";
export { resolveOrThrow } from "./resolve.js";
export { readTypeTree } from "./serialized/TypeTreeReader.js";
export type { TypeTreeObject, TypeTreeValue } from "./serialized/TypeTreeReader.js";
export type { Quaternion, Vector3, XForm } from "./serialized/ObjectReader.js";
export { readObject } from "./classes/Object.js";
export type { UnityObject } from "./classes/Object.js";
export { readEditorExtension } from "./classes/EditorExtension.js";
export type { EditorExtension } from "./classes/EditorExtension.js";
export { readNamedObject } from "./classes/NamedObject.js";
export type { NamedObject } from "./classes/NamedObject.js";
export type { ResourceRef } from "./env.js";
export { readTexture } from "./classes/Texture.js";
export type { Texture } from "./classes/Texture.js";
export { readTexture2D } from "./classes/Texture2D.js";
export type { GLTextureSettings, StreamingInfo, Texture2D } from "./classes/Texture2D.js";
export { TextureFormat } from "./classes/TextureFormat.js";
export { readCubemap } from "./classes/Cubemap.js";
export type { Cubemap } from "./classes/Cubemap.js";
export { readTexture2DArray, readTexture3D } from "./classes/Texture2DArray.js";
export type { Texture2DArray, Texture3D } from "./classes/Texture2DArray.js";
export { GraphicsFormat, textureFormatOfGraphicsFormat } from "./classes/GraphicsFormat.js";
export type {
  CubemapData,
  ObjectData,
  ObjectDataMap,
  Texture2DArrayData,
  Texture2DData,
  Texture3DData,
} from "./classes/registry.js";
export {
  toAnimationClipFields,
  toAnimationFields,
  toCubemapFields,
  toTexture2DArrayFields,
  toTexture3DFields,
  toAnimatorControllerFields,
  toAnimatorFields,
  toAnimatorOverrideControllerFields,
  toAssetBundleFields,
  toAudioClipFields,
  toAvatarFields,
  toFontFields,
  toGameObjectFields,
  toMaterialFields,
  toMeshFields,
  toMeshFilterFields,
  toMeshRendererFields,
  toMonoBehaviourFields,
  toMonoScriptFields,
  toMovieTextureFields,
  toShaderFields,
  toSkinnedMeshRendererFields,
  toSpriteAtlasFields,
  toSpriteFields,
  toTextAssetFields,
  toTexture2DFields,
  toTransformFields,
  toRectTransformFields,
  toVideoClipFields,
} from "./classes/fields.js";
export type {
  AABBFields,
  AnimationClipFields,
  AnimationClipOverrideFields,
  AnimationCurveFields,
  ClipFields,
  ClipMuscleConstantFields,
  CompressedAnimationCurveFields,
  DenseClipFields,
  FloatCurveFields,
  HandPoseFields,
  HumanGoalFields,
  HumanPoseFields,
  PackedQuatVectorFields,
  QuaternionCurveFields,
  ValueDeltaFields,
  Vector3CurveFields,
  AnimationFields,
  AnimatorControllerFields,
  AnimatorFields,
  AnimatorOverrideControllerFields,
  AssetBundleFields,
  AvatarFields,
  GameObjectFields,
  MeshFilterFields,
  MeshRendererFields,
  RendererFields,
  SkinnedMeshRendererFields,
  TransformFields,
  RectTransformFields,
  AvatarConstantFields,
  AxesFields,
  Blend1dDataConstantFields,
  Blend2dDataConstantFields,
  BlendDirectDataConstantFields,
  BlendTreeConstantFields,
  BlendTreeNodeConstantFields,
  ConditionConstantFields,
  ControllerConstantFields,
  HandFields,
  HumanFields,
  HumanBoneFields,
  HumanDescriptionFields,
  LayerConstantFields,
  LimitFields,
  MotionNeighborListFields,
  SelectorStateConstantFields,
  SelectorTransitionConstantFields,
  SkeletonFields,
  SkeletonBoneFields,
  SkeletonBoneLimitFields,
  SkeletonMaskFields,
  SkeletonMaskElementFields,
  SkeletonNodeFields,
  SkeletonPoseFields,
  StateConstantFields,
  StateKeyFields,
  StateMachineBehaviourVectorDescriptionFields,
  StateMachineConstantFields,
  StateRangeFields,
  TransitionConstantFields,
  ValueArrayFields,
  ValueArrayConstantFields,
  ValueConstantFields,
  AudioClipFields,
  BindingFields,
  BufferBindingFields,
  ConstantBufferFields,
  EditorExtensionFields,
  FontFields,
  GLTextureSettingsFields,
  MaterialFields,
  MatrixParameterFields,
  MeshFields,
  MeshLodInfoFields,
  MinMaxAABBFields,
  CompressedMeshFields,
  PackedFloatVectorFields,
  PackedIntVectorFields,
  MonoBehaviourFields,
  MonoScriptFields,
  MovieTextureFields,
  NamedObjectFields,
  ProgramParametersFields,
  SamplerParameterFields,
  SerializedPassFields,
  SerializedPlayerSubProgramFields,
  SerializedProgramFields,
  SerializedPropertyFields,
  SerializedShaderFields,
  SerializedShaderStateFields,
  SerializedSubProgramFields,
  SerializedSubShaderFields,
  ShaderFields,
  SpriteAtlasDataFields,
  SpriteAtlasFields,
  SpriteFields,
  SpriteInstanceDataFields,
  SpriteRenderDataFields,
  StreamedResourceFields,
  StructParameterFields,
  SubMeshFields,
  TextAssetFields,
  Texture2DFields,
  Texture2DArrayFields,
  Texture3DFields,
  CubemapFields,
  TextureFields,
  TextureParameterFields,
  UAVParameterFields,
  UnityPropertySheetFields,
  UnityTexEnvFields,
  VectorParameterFields,
  VertexDataFields,
  VideoClipFields,
} from "./classes/fields.js";
export { readAssetBundle } from "./classes/AssetBundle.js";
export type { AssetBundle, AssetBundleScriptInfo, AssetInfo } from "./classes/AssetBundle.js";
export { readTextAsset, textAssetString } from "./classes/TextAsset.js";
export type { TextAsset } from "./classes/TextAsset.js";
export { readMonoScript } from "./classes/MonoScript.js";
export type { Hash128, MonoScript } from "./classes/MonoScript.js";
export { readMonoBehaviour } from "./classes/MonoBehaviour.js";
export type { MonoBehaviour } from "./classes/MonoBehaviour.js";
export type { MonoBehaviourData } from "./classes/registry.js";
export { readMaterial } from "./classes/Material.js";
export type {
  BuildTextureStackReference,
  Color,
  Material,
  UnityPropertySheet,
  UnityTexEnv,
  Vector2,
} from "./classes/Material.js";
export { readShader } from "./classes/Shader.js";
export type {
  Binding,
  BufferBinding,
  ConstantBuffer,
  MatrixParameter,
  ParserBindChannels,
  ProgramParameters,
  SamplerParameter,
  SerializedPass,
  SerializedPlayerSubProgram,
  SerializedProgram,
  SerializedProperty,
  SerializedShader,
  SerializedShaderFloatValue,
  SerializedShaderRTBlendState,
  SerializedShaderState,
  SerializedShaderVectorValue,
  SerializedStencilOp,
  SerializedSubProgram,
  SerializedSubShader,
  SerializedTagMap,
  SerializedTextureProperty,
  Shader,
  ShaderBindChannel,
  StructParameter,
  TextureParameter,
  UAVParameter,
  VectorParameter,
} from "./classes/Shader.js";
export { readAudioClip } from "./classes/AudioClip.js";
export type { AudioClip, AudioClipData } from "./classes/AudioClip.js";
export { readFont } from "./classes/Font.js";
export type { CharacterInfo, Font, Rectf } from "./classes/Font.js";
export { readVideoClip } from "./classes/VideoClip.js";
export type { StreamedResource, VideoClip, VideoClipData } from "./classes/VideoClip.js";
export { readMovieTexture } from "./classes/MovieTexture.js";
export type { MovieTexture } from "./classes/MovieTexture.js";
export { readSprite, SpritePackingRotation } from "./classes/Sprite.js";
export type {
  AABB,
  BlendShapeData,
  BlendShapeVertex,
  BoneWeights4,
  ChannelInfo,
  GUID,
  Matrix4x4,
  MeshBlendShape,
  MeshBlendShapeChannel,
  SecondarySpriteTexture,
  Sprite,
  SpriteBone,
  SpriteRenderData,
  SpriteVertex,
  SubMesh,
  Vector4,
  VertexData,
} from "./classes/Sprite.js";
export { GfxPrimitiveType, readMesh } from "./classes/Mesh.js";
export type {
  CompressedMesh,
  LodSelectionCurve,
  Mesh,
  MeshData,
  MeshLodInfo,
  MeshLodRange,
  MinMaxAABB,
  PackedFloatVector,
  PackedIntVector,
  VariableBoneCountWeights,
  VertexBoneWeights,
} from "./classes/Mesh.js";
export { readSpriteAtlas } from "./classes/SpriteAtlas.js";
export type { SpriteAtlas, SpriteAtlasData, SpriteInstanceData } from "./classes/SpriteAtlas.js";
export { readHumanPose, readValueArrayConstant } from "./classes/animation.js";
export type {
  HandPose,
  HumanGoal,
  HumanPose,
  OffsetPtr,
  ValueArrayConstant,
  ValueConstant,
} from "./classes/animation.js";
export { readAnimationClip } from "./classes/AnimationClip.js";
export type {
  AnimationClip,
  AnimationClipBindingConstant,
  AnimationCurve,
  AnimationEvent,
  Clip,
  ClipMuscleConstant,
  CompressedAnimationCurve,
  ConstantClip,
  DenseClip,
  FloatCurve,
  GenericBinding,
  Keyframe,
  PackedQuatVector,
  PPtrCurve,
  PPtrKeyframe,
  QuaternionCurve,
  StreamedClip,
  ValueDelta,
  Vector3Curve,
} from "./classes/AnimationClip.js";
export { readAnimation } from "./classes/AnimationComponent.js";
export type { Animation } from "./classes/AnimationComponent.js";
export { readAnimator } from "./classes/Animator.js";
export type { Animator } from "./classes/Animator.js";
export { readAnimatorController } from "./classes/AnimatorController.js";
export type {
  AnimatorController,
  Blend1dDataConstant,
  Blend2dDataConstant,
  BlendDirectDataConstant,
  BlendTreeConstant,
  BlendTreeNodeConstant,
  ConditionConstant,
  ControllerConstant,
  HumanPoseMask,
  LayerConstant,
  MotionNeighborList,
  SelectorStateConstant,
  SelectorTransitionConstant,
  SkeletonMask,
  SkeletonMaskElement,
  StateConstant,
  StateKey,
  StateMachineBehaviourVectorDescription,
  StateMachineConstant,
  StateRange,
  TransitionConstant,
  ValueArray,
} from "./classes/AnimatorController.js";
export { readAnimatorOverrideController } from "./classes/AnimatorOverrideController.js";
export type {
  AnimationClipOverride,
  AnimatorOverrideController,
} from "./classes/AnimatorOverrideController.js";
export { readAvatar } from "./classes/Avatar.js";
export type {
  Avatar,
  AvatarConstant,
  Axes,
  Hand,
  Human,
  HumanBone,
  HumanDescription,
  Limit,
  Skeleton,
  SkeletonBone,
  SkeletonBoneLimit,
  SkeletonNode,
  SkeletonPose,
} from "./classes/Avatar.js";
export { readGameObject } from "./classes/GameObject.js";
export type { ComponentPair, GameObject } from "./classes/GameObject.js";
export { readTransform } from "./classes/Transform.js";
export type { Transform } from "./classes/Transform.js";
export { readRectTransform } from "./classes/RectTransform.js";
export type { RectTransform } from "./classes/RectTransform.js";
export { readMeshFilter } from "./classes/MeshFilter.js";
export type { MeshFilter } from "./classes/MeshFilter.js";
export { readMeshRenderer, readSkinnedMeshRenderer } from "./classes/Renderer.js";
export type {
  MeshRenderer,
  Renderer,
  SkinnedMeshRenderer,
  StaticBatchInfo,
} from "./classes/Renderer.js";
