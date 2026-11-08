# Building the editor fixtures

How `bundles/editor/**` was made, and how to make it again. Everything needed
is on this page: **the Unity project is never committed** (R2: no `.cs` in the
repo), so the two C# files below live only in a local project you create.

## Editors

| Editor | UnityFS | SerializedFile | `[SerializeReference]` registry |
|---|---|---|---|
| 2019.4.41f2 | v7 | **21** | version 1 |
| 2020.3.30f1 | v7 | **22** | version 1 |
| 6000.3.25f1 | v8 | **22** | version 2 |

Windows, build target `StandaloneWindows64`, no extra modules. Format 20 and
older (Unity 2019.2 and earlier) have no fixture.

## 1. Create the project (once per editor)

A `Library/` folder is editor-specific, so use one project folder per editor,
each holding the same four files:

```
<project>/Assets/Fixtures/shared/hello.txt
<project>/Assets/Fixtures/texture/checker.png
<project>/Assets/Scripts/FixtureData.cs
<project>/Assets/Editor/BuildFixtures.cs
```

Unity creates `ProjectSettings/`, `Packages/` and the `.meta` files on first open.

`hello.txt` is UTF-8 without a BOM, LF line endings, 58 bytes. Create it
byte-exact rather than in an editor:

```bash
printf 'Hello from unity-asset-reader fixtures.\nLine 2: \xc3\xa9\xe2\x82\xac\xf0\x9f\x98\x80\n' > hello.txt
```

`checker.png` is a 4x4 RGBA PNG, 136 bytes, sha256
`bd768da6b1b22a5518559a0a9bd29665de8f20a3393e0ce8479f132cda410063`. Every pixel
differs and alpha varies, so the importer keeps an alpha channel. Generate it
(stored deflate, so the bytes do not depend on the zlib version):

```python
import struct, zlib
# 4x4 RGBA, every pixel distinct, alpha varies so the importer keeps RGBA.
px = [[(r * 64, g * 64, 255 - 16 * (4 * r + g), 255 - 32 * g) for g in range(4)] for r in range(4)]
raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 0)) + chunk(b"IEND", b"")
open("checker.png", "wb").write(png)
```

`Assets/Scripts/FixtureData.cs` - one field per value shape the typetree reader
has to get right:

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;

public enum FixtureKind { None, Alpha, Beta = 7 }

[Serializable]
public struct Nested { public int a; public string b; public Vector3 v; }

[Serializable] public class RefBase { public int id; }
[Serializable] public class RefChild : RefBase { public string label; }

[CreateAssetMenu]
public class FixtureData : ScriptableObject
{
    public int i32 = -123456;
    public long i64 = -9007199254740993L;          // > 2^53: must survive as bigint
    public ulong u64 = 18446744073709551615UL;
    public float f32 = -0.0f;
    public float fInf = float.PositiveInfinity;
    public float fNaN = float.NaN;
    public double f64 = 0.1;
    public bool flag = true;
    public byte u8 = 200;
    public string text = "héllo €";
    public FixtureKind kind = FixtureKind.Beta;
    public List<int> ints = new List<int> { 1, 2, 3 };
    public byte[] bytes = { 0, 1, 2, 255 };
    public Nested nested = new Nested { a = 42, b = "nested", v = new Vector3(1, 2, 3) };
    public List<Nested> nestedList = new List<Nested> { new Nested { a = 1, b = "x" } };
    public TextAsset textRef;                       // PPtr -> other bundle (externals)
    [SerializeReference] public RefBase polymorphic = new RefChild { id = 9, label = "ref" }; // ref types (v20+)
}
```

`Assets/Editor/BuildFixtures.cs` - creates `Assets/Fixtures/main/`, the
ScriptableObject asset and a one-triangle Mesh in it on first run, points the
asset at `hello.txt`, imports `checker.png` as uncompressed RGBA32 without
mips, and builds every variant:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildFixtures
{
    const string Data = "Assets/Fixtures/main/data.asset";
    const string Tex = "Assets/Fixtures/texture/checker.png";
    const string Tri = "Assets/Fixtures/main/tri.asset";

    public static void Build()
    {
        var text = AssetDatabase.LoadAssetAtPath<TextAsset>("Assets/Fixtures/shared/hello.txt");
        // CreateAsset does not create folders, and a fresh project has no main/.
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures/main")) AssetDatabase.CreateFolder("Assets/Fixtures", "main");
        var data = AssetDatabase.LoadAssetAtPath<FixtureData>(Data);
        if (data == null) { data = ScriptableObject.CreateInstance<FixtureData>(); AssetDatabase.CreateAsset(data, Data); }
        data.textRef = text;
        // A Mesh keeps its vertex data inline as TypelessData; a texture's goes to .resS.
        if (AssetDatabase.LoadAssetAtPath<Mesh>(Tri) == null)
        {
            var tri = new Mesh { name = "tri", vertices = new[] { Vector3.zero, Vector3.up, Vector3.right }, triangles = new[] { 0, 1, 2 } };
            AssetDatabase.CreateAsset(tri, Tri);
        }
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();

        // Plain RGBA32, one mip: every byte of the image is predictable.
        var imp = (TextureImporter)AssetImporter.GetAtPath(Tex);
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.mipmapEnabled = false;
        imp.SaveAndReimport();

        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "shared", assetNames = new[] { "Assets/Fixtures/shared/hello.txt" } },
            new AssetBundleBuild { assetBundleName = "main",   assetNames = new[] { Data, Tri } },
            new AssetBundleBuild { assetBundleName = "texture", assetNames = new[] { Tex } },
        };
        Emit("lz4",          BuildAssetBundleOptions.ChunkBasedCompression, builds);
        Emit("lzma",         BuildAssetBundleOptions.None, builds);
        Emit("uncompressed", BuildAssetBundleOptions.UncompressedAssetBundle, builds);
        Emit("lz4-notypetree", BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK " + name + " -> " + dir);
    }
}
```

Do not add `BuildAssetBundleOptions.DeterministicAssetBundle`: Unity 6 marks it
obsolete as an error, and it has been the default since 5.0 anyway.

## 2. Build (batch mode, no GUI)

```
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildFixtures.Build -logFile <project>\build.log
```

`Unity.exe` is under `<Unity Hub editors dir>\<version>\Editor\`. The editor
uses the licence Unity Hub already activated. A run takes 1-2 minutes; the log
must contain four `FIXTURE-OK` lines. From WSL, call the same `Unity.exe`
through `/mnt/c/...` and pass Windows paths (`C:\...`) to `-projectPath`.

Output, per variant: `Build/<variant>/{shared, main, <variant>}` plus a
`.manifest` text file next to each. `<variant>` (the file named like its
folder) is the AssetBundleManifest bundle Unity writes for the build.

## 3. Copy into the repo

Only the bundles, never the `.manifest` text files:

```
Build/<variant>/<file>  ->  fixtures/bundles/editor/<editor version>/<variant>/<file>
```

for `<file>` in `shared`, `main`, `texture` and `<variant>`, and `<variant>` in
`lz4`, `lzma`, `uncompressed`, `lz4-notypetree`: 16 files per editor, 48 in
total, about 150 KB.

## 4. Goldens

```bash
.venv-oracle/bin/python scripts/make-goldens.py
npm test
```

A rebuild does not reproduce the committed bytes: a fresh project gets new
asset GUIDs, so object IDs (pathIDs, SerializeReference rids) change, and with
them the order of objects and types, the order of the AssetBundle preload
table, the bundle hashes in the AssetBundleManifest and a few bytes of padding.
Everything else - headers, externals, type trees, object classes and sizes,
all other typetree values - is the same (checked for all 48 bundles against
projects made from this page alone). So if you rebuild, replace all of an
editor's bundles together, regenerate the goldens and commit both.

Build every variant in one run, as `BuildFixtures.Build` does. In the first
run after the asset is created, the first variant built (`lz4`) serializes the
in-memory `float.NaN` as `0xFFC00000` and the rest get `0x7FC00000` (read back
from the saved asset). A second run writes `0x7FC00000` everywhere, which
changes the `lz4` NaN golden.

The oracle cannot fully read the version 1 `[SerializeReference]` registry
(2019.4, 2020.3); `make-goldens.py` handles that one case and records an
`oracleNote` on the object (see #25).

## 5. The `registry` bundle (#96)

One more bundle per editor, `registry/refs`: a ScriptableObject whose
`[SerializeReference]` list holds 13 entries, so a version 1 registry has
entry keys past `00000009`, and whose first entry is a ref type with a
`[SerializeReference]` field of its own, so its type tree carries a nested
`ManagedReferencesRegistry` node. It is built by a separate method into its own
folder, so the bundles of sections 1-3 and their manifests stay as they are.

Add two files to the same project:

`Assets/Scripts/RegistryData.cs`:

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;

[Serializable] public class RefLeaf { public int n; }
[Serializable] public class RefHolder : RefLeaf { [SerializeReference] public RefLeaf inner; }

// 13 [SerializeReference] entries (v1 keys past 9) and a ref type with a
// [SerializeReference] field of its own (a nested registry node), #96.
public class RegistryData : ScriptableObject
{
    [SerializeReference] public List<RefLeaf> refs = new List<RefLeaf>();
}
```

`Assets/Editor/BuildRegistry.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildRegistry
{
    const string Asset = "Assets/Fixtures/registry/registry.asset";

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures/registry")) AssetDatabase.CreateFolder("Assets/Fixtures", "registry");
        var data = AssetDatabase.LoadAssetAtPath<RegistryData>(Asset);
        if (data == null) { data = ScriptableObject.CreateInstance<RegistryData>(); AssetDatabase.CreateAsset(data, Asset); }
        // The holder first: UnityPy reads only the first v1 entry, so the oracle walks its ref type.
        data.refs.Clear();
        data.refs.Add(new RefHolder { n = 0, inner = new RefLeaf { n = 100 } });
        for (int i = 1; i <= 11; i++) data.refs.Add(new RefLeaf { n = i });
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "registry");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "refs", assetNames = new[] { Asset } } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: registry");
        Debug.Log("FIXTURE-OK registry -> " + dir);
    }
}
```

Build with `-executeMethod BuildRegistry.Build` (same command as section 2;
the log must contain one `FIXTURE-OK registry` line), then copy only
`Build/registry/refs` to `fixtures/bundles/editor/<editor version>/registry/refs`
and rerun `make-goldens.py`.

The oracle reads only the first of the 13 version 1 entries, so the rest,
and the names Unity gives them, are checked against the asset's YAML
(`Assets/Fixtures/registry/registry.asset`), which the test copies by hand.
In 2019.4.41f2 and 2020.3.30f1 it names the entries `00000000` to
`00000009`, then `0000000A`, `0000000B`, `0000000C`: the id in 8 uppercase
hex digits. If you rebuild, check the YAML still says so.

## 6. The `plain` texture bundle (#31)

One bundle, `plain/textures`, built with **6000.3.25f1** only: an 8x5
Texture2D, no mips, in each plain (non-block) format the texture package
converts in TS - Alpha8, ARGB4444, RGB24, RGBA32, ARGB32, RGB565, R16,
RGBA4444, BGRA32, RHalf, RGHalf, RGBAHalf, RFloat, RGFloat, RGBAFloat, YUY2 and
RGB9e5Float. Pixel conversion does not depend on the editor version, so one
editor is enough. All 17 formats can be created on Windows, YUY2 included.

The textures are made by script, not imported, so their bytes are exactly what
the script writes: a byte ramp for the 8-bit and packed formats, `k/16` for
every half and float channel (checkable by hand, and `8/16` hits the 127.5
rounding tie), and exponents 14 and 15 for RGB9e5 (every value below 1). A
readable texture made by script keeps its pixels inline in `image data`, so
this bundle has no `.resS` node; the `texture` bundles of sections 1-3 cover
that path.

It needs none of the other assets, so any project will do; the committed
bundle came from a fresh, empty one. Add `Assets/Editor/BuildPlainTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// One small Texture2D per plain (non-block) format, pixels written raw (#31).
public static class BuildPlainTextures
{
    const string Dir = "Assets/Fixtures/plain";
    // Not square and an odd height, so a transposed or row-shifted decode shows.
    const int W = 8, H = 5;

    static readonly TextureFormat[] Formats = {
        TextureFormat.Alpha8, TextureFormat.ARGB4444, TextureFormat.RGB24, TextureFormat.RGBA32,
        TextureFormat.ARGB32, TextureFormat.RGB565, TextureFormat.R16, TextureFormat.RGBA4444,
        TextureFormat.BGRA32, TextureFormat.RHalf, TextureFormat.RGHalf, TextureFormat.RGBAHalf,
        TextureFormat.RFloat, TextureFormat.RGFloat, TextureFormat.RGBAFloat, TextureFormat.YUY2,
        TextureFormat.RGB9e5Float,
    };

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "plain");
        var paths = new List<string>();
        foreach (var format in Formats)
        {
            try
            {
                var tex = new Texture2D(W, H, format, false) { name = format.ToString() };
                var size = tex.GetRawTextureData().Length;
                tex.LoadRawTextureData(Pixels(format, size));
                tex.Apply(false, false); // stays readable, so the pixels are kept as written
                var path = Dir + "/" + format + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + format + " " + size + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + format + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "plain");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "textures", assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new Exception("build failed: plain");
        Debug.Log("FIXTURE-OK plain -> " + dir);
    }

    // Values a reader can check by hand: halves and floats are k/16, RGB9e5 has
    // exponent 14 or 15 (every value below 1), everything else is a byte ramp.
    static byte[] Pixels(TextureFormat format, int size)
    {
        var raw = new byte[size];
        switch (format)
        {
            case TextureFormat.RHalf:
            case TextureFormat.RGHalf:
            case TextureFormat.RGBAHalf:
                for (int j = 0; j < size / 2; j++)
                {
                    ushort h = Mathf.FloatToHalf((j % 17) / 16f);
                    raw[2 * j] = (byte)h;
                    raw[2 * j + 1] = (byte)(h >> 8);
                }
                break;
            case TextureFormat.RFloat:
            case TextureFormat.RGFloat:
            case TextureFormat.RGBAFloat:
                for (int j = 0; j < size / 4; j++)
                    Buffer.BlockCopy(BitConverter.GetBytes((j % 17) / 16f), 0, raw, 4 * j, 4);
                break;
            case TextureFormat.RGB9e5Float:
                for (int i = 0; i < size / 4; i++)
                {
                    uint e = (uint)(14 + i % 2);
                    uint r = (uint)(3 * i * 29 % 512), g = (uint)((3 * i + 1) * 29 % 512), b = (uint)((3 * i + 2) * 29 % 512);
                    Buffer.BlockCopy(BitConverter.GetBytes(e << 27 | b << 18 | g << 9 | r), 0, raw, 4 * i, 4);
                }
                break;
            default:
                for (int k = 0; k < size; k++) raw[k] = (byte)((k * 37 + 11) & 0xFF);
                break;
        }
        return raw;
    }
}
```

Build with `-executeMethod BuildPlainTextures.Build` (same command as section
2; `-nographics` is fine). The log must hold 17 `FIXTURE-TEX` lines, no
`FIXTURE-SKIP` and one `FIXTURE-OK plain`. Copy only `Build/plain/textures` to
`fixtures/bundles/editor/6000.3.25f1/plain/textures` and rerun
`make-goldens.py`.

UnityPy 1.25.3 decodes only 8 of the 17 formats, and 2 of those differently
from AssetStudio; the goldens record which (`oracleError`, `oracleNote`), see
[`README.md`](README.md#oracle-notes).

## 7. The `stripped` bundles (#104)

Two bundles per editor, built with **6000.3.25f1** and **2020.3.30f1** only:
`stripped/lz4` and `stripped/uncompressed`. Each holds `hello.txt` (the
section 1 file, byte-exact) and is built with `AssetBundleStripUnityVersion`.
Unity then writes `"0.0.0"` as the bundle header's `unityRevision` and as the
SerializedFile's editor version. 6000.3.25f1 also sets archive flag 0x200
(`BlockInfoNeedPaddingAtStart`, flags `0x243`), the bit an editor before
2020.3.34 wrote for encryption. 2020.3.30f1 does not set it (`0x43`), so its
pair is the control.

Any project will do. The committed bundles came from fresh ones holding only
`Assets/Fixtures/strip/hello.txt` and `Assets/Editor/BuildStripped.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// One TextAsset, built with AssetBundleStripUnityVersion, so the UnityFS header's
// unityRevision is "0.0.0" (#104).
public static class BuildStripped
{
    public static void Build()
    {
        Emit("lz4", BuildAssetBundleOptions.ChunkBasedCompression);
        Emit("uncompressed", BuildAssetBundleOptions.UncompressedAssetBundle);
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", "stripped-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = name, assetNames = new[] { "Assets/Fixtures/strip/hello.txt" } } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: stripped " + name);
        Debug.Log("FIXTURE-OK stripped " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildStripped.Build` (same command as section 2).
The log must hold two `FIXTURE-OK stripped` lines. Copy only
`Build/stripped-lz4/lz4` and `Build/stripped-uncompressed/uncompressed` to
`fixtures/bundles/editor/<editor version>/stripped/`, then rerun
`make-goldens.py`. UnityPy has to be told the editor for these bundles. The
script takes it from the folder name and records an `oracleNote`
([`README.md`](README.md#oracle-notes)).

## 8. The `block` bundles (#32)

Two bundles built with **6000.3.25f1**, `block/windows` and `block/android`:
one 32x16 Texture2D with a full mip chain per block and Crunch format that the
editor compresses, made by script from the same RGBA32 pixels and compressed
with `EditorUtility.CompressTexture`. A readable texture keeps its image data
inline, as in section 6. Pixel decoding does not depend on the editor, so one
editor is enough; PVRTC is the exception (section 9).

The editor only compresses a texture with mips when its sides are powers of
two, hence 32x16; that is still not a whole number of 6x6, 10x10 or 12x12 ASTC
blocks, so partial blocks are covered. A StandaloneWindows64 build refuses ETC
Crunch, so the mobile formats go into an Android bundle (the editor needs the
Android module). The editor does not compress to signed EAC (section 21 makes
those textures by script) and has no ATC; see
[`README.md`](README.md#oracle-notes) for how ATC is covered.

Any project will do; the committed bundles came from one holding only
`Assets/Editor/BuildBlockTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// One small Texture2D per block / Crunch format, compressed by the editor (#32).
public static class BuildBlockTextures
{
    const string Dir = "Assets/Fixtures/block";
    // Power of two (the editor only compresses those when there are mips), not
    // square, and not a whole number of 6x6, 10x10 or 12x12 ASTC blocks.
    const int W = 32, H = 16;

    // By value: several of these names are obsolete in Unity 6, some as errors.
    // Desktop formats go into a StandaloneWindows64 bundle; the mobile ones into
    // an Android bundle, since a Standalone build refuses ETC Crunch.
    static readonly int[] Windows = {
        10, 12, 26, 27, 24, 25,         // DXT1 DXT5 BC4 BC5 BC6H BC7
        28, 29,                         // DXT1Crunched DXT5Crunched
    };
    static readonly int[] Android = {
        34, 45, 46, 47,                 // ETC_RGB4 ETC2_RGB ETC2_RGBA1 ETC2_RGBA8
        41, 43,                         // EAC_R EAC_RG
        64, 65,                         // ETC_RGB4Crunched ETC2_RGBA8Crunched
        48, 49, 50, 51, 52, 53,         // ASTC 4x4 5x5 6x6 8x8 10x10 12x12
        66, 71,                         // ASTC_HDR_4x4 ASTC_HDR_12x12
    };

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "block");
        Emit("windows", Windows, BuildTarget.StandaloneWindows64);
        Emit("android", Android, BuildTarget.Android);
    }

    static void Emit(string bundle, int[] formats, BuildTarget target)
    {
        var paths = new List<string>();
        foreach (var value in formats)
        {
            var format = (TextureFormat)value;
            var name = value + "_" + format;
            try
            {
                int w = W, h = H;
                var tex = new Texture2D(w, h, TextureFormat.RGBA32, true) { name = name };
                tex.SetPixels32(Pixels(w, h));
                tex.Apply(true, false);
                EditorUtility.CompressTexture(tex, format, 100);
                if (tex.format != format) throw new Exception("came out as " + tex.format);
                tex.Apply(false, false); // stays readable, so the image data stays inline
                var path = Dir + "/" + name + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + name + " " + w + "x" + h + " mips " + tex.mipmapCount + " " + tex.GetRawTextureData().Length + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + name + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "block-" + bundle);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = bundle, assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle, target);
        if (m == null) throw new Exception("build failed: block " + bundle);
        Debug.Log("FIXTURE-OK block " + bundle + " -> " + dir);
    }

    // Smooth ramps (what block encoders are made for) plus a hard diagonal edge,
    // and alpha that varies, so the alpha formats keep an alpha channel.
    static Color32[] Pixels(int w, int h)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte r = (byte)(x * 255 / (w - 1));
                byte g = (byte)(y * 255 / (h - 1));
                byte b = (byte)(x + y < (w + h) / 2 ? 40 : 220);
                byte a = (byte)(255 - (x * 7 + y * 11) % 256);
                px[y * w + x] = new Color32(r, g, b, a);
            }
        return px;
    }
}
```

Build with `-executeMethod BuildBlockTextures.Build` (same command as section
2). The log must hold 24 `FIXTURE-TEX` lines, no `FIXTURE-SKIP`, and two
`FIXTURE-OK block` lines. Copy only `Build/block-windows/windows` and
`Build/block-android/android` to `fixtures/bundles/editor/6000.3.25f1/block/`
and rerun `make-goldens.py`.

## 9. The PVRTC bundle (#32)

Unity 6 no longer compresses PVRTC ("PVRTC compression is obsolete and no
longer supported"), so `block/ios` is built with **2019.4.41f2**, which needs
the iOS module: one 32x32 Texture2D (PVRTC wants a square power of two) with a
full mip chain in each of PVRTC_RGB2, PVRTC_RGBA2, PVRTC_RGB4 and PVRTC_RGBA4,
same pixels as section 8, for BuildTarget iOS. The script tries ATC too;
2019.4's editor leaves it RGBA32 and skips it, and no fixture editor has it.

The committed bundle came from a project holding only
`Assets/Editor/BuildMobileTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// PVRTC and ATC, which Unity 6 no longer compresses (#32).
public static class BuildMobileTextures
{
    const string Dir = "Assets/Fixtures/mobile";
    // PVRTC wants a square power of two.
    const int W = 32, H = 32;

    static readonly int[] Ios = { 30, 31, 32, 33 };   // PVRTC_RGB2 PVRTC_RGBA2 PVRTC_RGB4 PVRTC_RGBA4
    static readonly int[] Android = { 35, 36 };       // ATC_RGB4 ATC_RGBA8

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "mobile");
        Emit("ios", Ios, BuildTarget.iOS);
        Emit("android", Android, BuildTarget.Android);
    }

    static void Emit(string bundle, int[] formats, BuildTarget target)
    {
        var paths = new List<string>();
        foreach (var value in formats)
        {
            var format = (TextureFormat)value;
            var name = value + "_" + format;
            try
            {
                var tex = new Texture2D(W, H, TextureFormat.RGBA32, true) { name = name };
                tex.SetPixels32(Pixels(W, H));
                tex.Apply(true, false);
                EditorUtility.CompressTexture(tex, format, 100);
                if (tex.format != format) throw new Exception("came out as " + tex.format);
                tex.Apply(false, false);
                var path = Dir + "/" + name + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + name + " " + W + "x" + H + " mips " + tex.mipmapCount + " " + tex.GetRawTextureData().Length + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + name + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();
        if (paths.Count == 0) { Debug.Log("FIXTURE-SKIP bundle " + bundle); return; }

        var dir = Path.Combine("Build", "mobile-" + bundle);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = bundle, assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle, target);
        if (m == null) throw new Exception("build failed: mobile " + bundle);
        Debug.Log("FIXTURE-OK mobile " + bundle + " -> " + dir);
    }

    static Color32[] Pixels(int w, int h)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte r = (byte)(x * 255 / (w - 1));
                byte g = (byte)(y * 255 / (h - 1));
                byte b = (byte)(x + y < (w + h) / 2 ? 40 : 220);
                byte a = (byte)(255 - (x * 7 + y * 11) % 256);
                px[y * w + x] = new Color32(r, g, b, a);
            }
        return px;
    }
}
```

Build with `-executeMethod BuildMobileTextures.Build` (same command as
section 2). The log holds four `FIXTURE-TEX` lines for PVRTC, one
`FIXTURE-OK mobile ios`, and `FIXTURE-SKIP` for the two ATC formats and the
Android bundle. Copy only `Build/mobile-ios/ios` to
`fixtures/bundles/editor/2019.4.41f2/block/ios` and rerun `make-goldens.py`.

A rebuild of either section gives new pathIDs (section 4) and may give other
compressed bytes. Then regenerate the goldens and the AssetStudio cross-check
hashes of `decode.test.ts` together
([`README.md`](README.md#assetstudio-block-cross-check)).

## 10. The `material` bundles (#40)

Three bundles per editor, all three editors: `material/lz4`,
`material/lz4-notypetree` and `material/lz4-stripped`, each holding one bundle
file `material`. It holds one Material whose serialized fields are set to
values other than their defaults, except three:
`m_BuildTextureStacks` stays empty (it needs virtual texturing), the
`_BumpMap` slot has no texture (it is the shader's second slot, left null), and
`_NegZero` is saved as `+0` although the script sets `-0f` (see the end of this
section). The elements of `m_BuildTextureStacks` are covered only by the
hand-built layouts in `packages/core/tests/Material.test.ts`. The shader and
the texture it uses go into a second
bundle, `matdeps`, which is not committed: the material bundle then holds only
the Material and its AssetBundle, and `m_Shader` and the `_MainTex` slot point
at an external file. (With the built-in Standard shader, Unity copies the whole
compiled shader, about 74 KB, into the bundle.)

Any project will do; the committed bundles came from a fresh one per editor
holding only these files:

```
<project>/Assets/Fixtures/material/checker.png   (section 1)
<project>/Assets/Fixtures/material/uar.shader
<project>/Assets/Editor/BuildMaterial.cs
```

`uar.shader` declares each kind of property the Material saves. Replace
`INT_TYPE` with `Integer` for 6000.3.25f1 (Unity 2021.1 added the type; its
values go to `m_Ints`) and with `Int` for 2019.4.41f2 and 2020.3.30f1 (a float,
saved in `m_Floats`):

```shaderlab
// Properties of every kind a Material saves (#40). INT_TYPE is Integer from
// Unity 2021.1 (saved in m_Ints), Int (a float, saved in m_Floats) before.
Shader "UAR/Fixture"
{
    Properties
    {
        _MainTex ("Main", 2D) = "white" {}
        _BumpMap ("Bump", 2D) = "bump" {}
        _Color ("Color", Color) = (1, 1, 1, 1)
        _EmissionColor ("Emission", Color) = (0, 0, 0, 1)
        _Glossiness ("Gloss", Range(0, 1)) = 0.5
        _NegZero ("NegZero", Float) = 0
        _UarInt ("Int", INT_TYPE) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature _EMISSION
            #pragma shader_feature _NORMALMAP
            #include "UnityCG.cginc"
            sampler2D _MainTex;
            fixed4 _Color;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return _Color; }
            ENDCG
        }
        Pass
        {
            Tags { "LightMode" = "ShadowCaster" }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return 0; }
            ENDCG
        }
    }
}
```

`Assets/Editor/BuildMaterial.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// One Material with the fields Unity serializes set to values other than
// their defaults (#40): a shader and a texture in another bundle, scale and offset, floats,
// colors, keywords, tags, a disabled pass, a render queue, instancing, GI flags.
public static class BuildMaterial
{
    const string Dir = "Assets/Fixtures/material";
    const string Mat = Dir + "/uar.mat";
    const string Tex = Dir + "/checker.png";
    const string Shd = Dir + "/uar.shader";

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "material");
        var imp = (TextureImporter)AssetImporter.GetAtPath(Tex);
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.mipmapEnabled = false;
        imp.SaveAndReimport();

        AssetDatabase.DeleteAsset(Mat);
        var mat = new Material(AssetDatabase.LoadAssetAtPath<Shader>(Shd)) { name = "uar" };
        mat.SetTexture("_MainTex", AssetDatabase.LoadAssetAtPath<Texture2D>(Tex));
        mat.SetTextureScale("_MainTex", new Vector2(2f, 3f));
        mat.SetTextureOffset("_MainTex", new Vector2(0.25f, -0.5f));
        mat.SetColor("_Color", new Color(0.1f, 0.2f, 0.3f, 0.4f));
        mat.SetColor("_EmissionColor", new Color(2f, 0.5f, 0f, 1f));
        mat.SetFloat("_Glossiness", 0.75f);
        mat.SetFloat("_NegZero", -0f);
#if UNITY_2021_1_OR_NEWER
        mat.SetInteger("_UarInt", -7);
#else
        mat.SetFloat("_UarInt", -7f);
#endif
        mat.EnableKeyword("_EMISSION");
        mat.EnableKeyword("_NORMALMAP");
        mat.EnableKeyword("UAR_NOT_IN_SHADER");
        mat.SetOverrideTag("RenderType", "TransparentCutout");
        mat.SetShaderPassEnabled("ShadowCaster", false);
        mat.renderQueue = 2450;
        mat.enableInstancing = true;
        mat.doubleSidedGI = true;
        mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.BakedEmissive;
        AssetDatabase.CreateAsset(mat, Mat);
        AssetDatabase.SaveAssets();

        // The shader and the texture go into a bundle of their own, so m_Shader and
        // m_TexEnvs point at another file and the material bundle holds only the
        // Material (and its AssetBundle).
        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "material", assetNames = new[] { Mat } },
            new AssetBundleBuild { assetBundleName = "matdeps", assetNames = new[] { Shd, Tex } },
        };
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4, builds);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
        Emit("lz4-stripped", lz4 | BuildAssetBundleOptions.AssetBundleStripUnityVersion, builds);
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", "material-" + name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: material " + name);
        Debug.Log("FIXTURE-OK material " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildMaterial.Build` (same command as section 2).
The log must hold three `FIXTURE-OK material` lines. Copy only
`Build/material-<variant>/material` to
`fixtures/bundles/editor/<editor version>/material/<variant>/material` for
`<variant>` in `lz4`, `lz4-notypetree` and `lz4-stripped`, then rerun
`make-goldens.py`; it dumps the Material's type tree (class 21).

Unity drops properties the shader does not declare, and saved `_NegZero`'s
`-0f` as `+0`. The keywords come out as the script enabled them:
`_EMISSION` and `_NORMALMAP` are declared, `UAR_NOT_IN_SHADER` is not, so from
2021.2.18 it lands in `m_InvalidKeywords`. `SetShaderPassEnabled` stores the
pass's `LightMode` upper-cased (`SHADOWCASTER`).

## 11. The media bundles (#41)

Three more bundles per editor, `audio`, `font` and `video`, built with
**2019.4.41f2**, **2020.3.30f1** and **6000.3.25f1** into three variants:
`lz4`, `lz4-notypetree` (`DisableWriteTypeTree`) and `stripped`
(`AssetBundleStripUnityVersion`, so the SerializedFile says `"0.0.0"`). They go
into the variant folders of sections 3 and 7 next to the bundles already there;
the manifest bundle of this build is not copied. A fourth bundle, `adpcm`, came
later from projects of its own, with 6000.3.26f1 in place of 6000.3.25f1 (see
[ADPCM clips](#adpcm-clips-251)), and a fifth, `audiohdr`, lz4 only, for the
FSB5 header paths of other clips (see [Header paths](#header-paths-289)).

| Bundle | Objects | Where the bytes are |
|---|---|---|
| `audio` | two AudioClips from one WAV: `tone-pcm` (PCM) and `tone-vorbis` (Vorbis, load in background) | an FMOD sound bank (FSB5) each, in the bundle's `.resource` node |
| `font` | one Font (dynamic, font data included), with the Material and the 0x0 "Font Texture" the importer makes | the TrueType file, inline in `m_FontData` |
| `video` | one VideoClip, imported without transcoding | the WebM file as it went in, in the bundle's `.resource` node |
| `adpcm` | two IMA ADPCM AudioClips: `tone-adpcm` (mono) and `stereo-adpcm` | an FSB5 bank each, in the bundle's `.resource` node |
| `audiohdr` | five AudioClips: `mono37800-pcm`, `quad-pcm`, `quad-adpcm`, `surround-pcm` and `surround-adpcm` | an FSB5 bank each, in the bundle's `.resource` node |

The dynamic font's "Font Texture" has no image data at all (0x0, no `.resS`),
so it gets no texture golden; see [`README.md`](README.md#oracle-notes).

### Source assets

All three are generated, so every byte is ours (R11): a sine tone, a font whose
three glyphs are rectangles drawn by the script below, and a solid-colour clip
with a sine tone made by ffmpeg's own `lavfi` sources. No third-party media is
involved, and no tool's license extends to what it outputs; the font is part of
this repository's fixtures under its MIT license.

| File | Bytes | sha256 |
|---|---|---|
| `tone.wav` | 11068 | `8edec60ce5b7c3c12eaec3a6cece2e442b4b12f47c77cbc8857a2be8118c4fac` |
| `glyphs.ttf` | 672 | `f69124a81f4347a08c2d0f68bd970fb755d7d6dda8003976b51ad8274e8045ab` |
| `clip.webm` | 4860 | `3772a3e4275b99ebeecba8d52b90cc9192cce137af06c6889459107b460e7459` |

`tone.wav` and `glyphs.ttf` are byte-exact from the script below with Python
3.12 and fontTools 4.60.1. `clip.webm` came from ffmpeg 7.0.2, the static build
`imageio-ffmpeg` 0.6.0 ships (libvpx, libvorbis), with the bitexact flags, so
no encoder version or random UID is in it; another ffmpeg or libvpx build may
encode other bytes. The goldens hold whatever the editor put in the bundle, and
the font and video goldens hash to the two files above, since Unity stores both
as they are.

```bash
python3 -m venv .venv-media && .venv-media/bin/pip install fonttools==4.60.1 imageio-ffmpeg==0.6.0
.venv-media/bin/python gen_media.py <project>/Assets/Fixtures/media "$(.venv-media/bin/python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
cp <project>/Assets/Fixtures/media/tone.wav <project>/Assets/Fixtures/media/tone-pcm.wav
mv <project>/Assets/Fixtures/media/tone.wav <project>/Assets/Fixtures/media/tone-vorbis.wav
```

`gen_media.py`:

```python
import hashlib, math, pathlib, struct, subprocess, sys, wave
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)

# tone.wav: 0.25 s of a 440 Hz sine, mono, 16-bit PCM, 22050 Hz.
rate, n = 22050, 22050 // 4
frames = b"".join(struct.pack("<h", round(12000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))
with wave.open(str(out / "tone.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(frames)

# glyphs.ttf: .notdef, space and a rectangle "A".
def square(size):
    pen = TTGlyphPen(None)
    pen.moveTo((100, 0)); pen.lineTo((100, size)); pen.lineTo((size, size)); pen.lineTo((size, 0))
    pen.closePath()
    return pen.glyph()

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder([".notdef", "space", "A"])
fb.setupCharacterMap({0x20: "space", 0x41: "A"})
fb.setupGlyf({".notdef": square(500), "space": TTGlyphPen(None).glyph(), "A": square(700)})
fb.setupHorizontalMetrics({".notdef": (600, 100), "space": (300, 0), "A": (800, 100)})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "UarFixture", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.updateHead(created=3_000_000_000, modified=3_000_000_000)  # fixed, not the clock
fb.font.recalcTimestamp = False
fb.save(str(out / "glyphs.ttf"))

# clip.webm: 0.5 s of a 16x16 solid colour at 10 fps (VP8) with a 440 Hz tone (Vorbis).
subprocess.run([sys.argv[2], "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x3080c0:s=16x16:r=10:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=0.5",
    "-c:v", "libvpx", "-b:v", "50k", "-c:a", "libvorbis", "-ac", "1",
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-threads", "1", str(out / "clip.webm")], check=True)

for name in ("tone.wav", "glyphs.ttf", "clip.webm"):
    data = (out / name).read_bytes()
    print(name, len(data), hashlib.sha256(data).hexdigest())
```

### Build

Any project will do; the committed bundles came from fresh ones, one per
editor, holding only `Assets/Fixtures/media/` (the four files above) and
`Assets/Editor/BuildMedia.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// One AudioClip pair, one Font and one VideoClip per bundle, from generated
// source files (#41). Their data goes to a .resource node (audio, video) or
// stays inline (font).
public static class BuildMedia
{
    const string Dir = "Assets/Fixtures/media";

    public static void Build()
    {
        // Two clips from the same WAV: PCM, and Vorbis loaded in the background.
        Audio(Dir + "/tone-pcm.wav", AudioCompressionFormat.PCM, false);
        Audio(Dir + "/tone-vorbis.wav", AudioCompressionFormat.Vorbis, true);

        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "audio", assetNames = new[] { Dir + "/tone-pcm.wav", Dir + "/tone-vorbis.wav" } },
            new AssetBundleBuild { assetBundleName = "font",  assetNames = new[] { Dir + "/glyphs.ttf" } },
            new AssetBundleBuild { assetBundleName = "video", assetNames = new[] { Dir + "/clip.webm" } },
        };
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4, builds);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
        Emit("stripped", lz4 | BuildAssetBundleOptions.AssetBundleStripUnityVersion, builds);
    }

    static void Audio(string path, AudioCompressionFormat format, bool background)
    {
        var imp = (AudioImporter)AssetImporter.GetAtPath(path);
        var s = imp.defaultSampleSettings;
        s.compressionFormat = format;
        s.loadType = AudioClipLoadType.DecompressOnLoad;
        imp.defaultSampleSettings = s;
        imp.loadInBackground = background;
        imp.SaveAndReimport();
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", "media-" + name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: media " + name);
        Debug.Log("FIXTURE-OK media " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildMedia.Build` (same command as section 2). The
log must hold three `FIXTURE-OK media` lines. Copy only the bundles,
`Build/media-<variant>/{audio,font,video}` to
`fixtures/bundles/editor/<editor version>/<variant>/`, for `<variant>` in
`lz4`, `lz4-notypetree` and `stripped`: 27 files, about 130 KB. Then rerun
`make-goldens.py`; it dumps these classes' type trees and hashes the bytes
each object carries (`rawData`).

No fixture holds a MovieTexture: from 2019.3 Unity's type tree for it has only
the `Texture` fields, and none of these editors imports a movie as one. Its
reader is checked against hand-built layouts from UnityPy's TPK data instead.

### ADPCM clips (#251)

The `adpcm` bundle holds two AudioClips imported as `AudioCompressionFormat.ADPCM`
(FSB5 codec IMAADPCM), `DecompressOnLoad`: `tone-adpcm`, mono, from `tone.wav`
above, and `stereo-adpcm`, from a generated stereo WAV with a different sine per
channel, so a channel swap or mix shows. It is a bundle of its own so the
`audio` bundles and their goldens stay as they are. Editors: 2019.4.41f2,
2020.3.30f1 and 6000.3.26f1 (6000.3.25f1 is no longer installed, as in section
18), each into `lz4`, `lz4-notypetree` and `stripped`.

| File | Bytes | sha256 |
|---|---|---|
| `tone-adpcm.wav` | 11068 | `8edec60ce5b7c3c12eaec3a6cece2e442b4b12f47c77cbc8857a2be8118c4fac` |
| `stereo-adpcm.wav` | 16044 | `0708d364c2440356e0aebc24bbceb3e833332c8914d9103fcb23e5533725a7b2` |

Both are byte-exact from `gen_adpcm.py` with Python 3.12 (standard library
only); `tone-adpcm.wav` is `tone.wav` of `gen_media.py` under another name.

```bash
python3 gen_adpcm.py <project>/Assets/Fixtures/adpcm
```

`gen_adpcm.py`:

```python
import hashlib, math, pathlib, struct, sys, wave

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
rate = 22050

def write(name, channels, frames):
    with wave.open(str(out / name), "wb") as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate); w.writeframes(frames)

def sine(amp, hz, i):
    return round(amp * math.sin(2 * math.pi * hz * i / rate))

# tone-adpcm.wav: tone.wav of section 11, 0.25 s of a 440 Hz sine, mono,
# 5512 frames = 86 full IMA ADPCM frames of 64 samples + 8.
write("tone-adpcm.wav", 1, b"".join(struct.pack("<h", sine(12000, 440, i)) for i in range(rate // 4)))

# stereo-adpcm.wav: 4000 frames (62 full frames + 32), 440 Hz left at 12000,
# 660 Hz right at 6000, so a channel swap or mix shows in the output.
write("stereo-adpcm.wav", 2, b"".join(
    struct.pack("<hh", sine(12000, 440, i), sine(6000, 660, i)) for i in range(4000)))

for name in ("tone-adpcm.wav", "stereo-adpcm.wav"):
    data = (out / name).read_bytes()
    print(name, len(data), hashlib.sha256(data).hexdigest())
```

Create a project per editor named `uar-251-adpcm-<editor version>`, with
`ProjectSettings/` and `Packages/` copied from one of the projects above, and
only the two WAVs and this file under `Assets/`.

`Assets/Editor/BuildAdpcm.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// Two IMA ADPCM AudioClips, mono and stereo, from generated WAVs (#251).
// Each clip's FSB5 bank goes to the bundle's .resource node.
public static class BuildAdpcm
{
    const string Dir = "Assets/Fixtures/adpcm";

    public static void Build()
    {
        Audio(Dir + "/tone-adpcm.wav");
        Audio(Dir + "/stereo-adpcm.wav");

        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "adpcm", assetNames = new[] { Dir + "/tone-adpcm.wav", Dir + "/stereo-adpcm.wav" } },
        };
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4, builds);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
        Emit("stripped", lz4 | BuildAssetBundleOptions.AssetBundleStripUnityVersion, builds);
    }

    static void Audio(string path)
    {
        var imp = (AudioImporter)AssetImporter.GetAtPath(path);
        var s = imp.defaultSampleSettings;
        s.compressionFormat = AudioCompressionFormat.ADPCM;
        s.loadType = AudioClipLoadType.DecompressOnLoad;
        imp.defaultSampleSettings = s;
        imp.SaveAndReimport();
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", "adpcm-" + name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: adpcm " + name);
        Debug.Log("FIXTURE-OK adpcm " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildAdpcm.Build` (same command as section 2), once
per project. The log must hold three `FIXTURE-OK adpcm` lines. Copy only
`Build/adpcm-<variant>/adpcm` to `fixtures/bundles/editor/<editor
version>/<variant>/`, for `<variant>` in `lz4`, `lz4-notypetree` and
`stripped`: 9 files, about 72 KB. Then rerun `make-goldens.py` and
`make-export-goldens.py` (section 17).

What the banks hold, the same in all three editors: 22050 Hz, and whole IMA
ADPCM frames only. Unity pads the source to a multiple of 64 samples per
channel, so the bank header says 5568 frames for `tone-adpcm` (87 frames of
0x24 bytes, from 5512) and 4032 for `stereo-adpcm` (63 frames of 0x48 bytes,
from 4000). AssetStudio's WAV (FMOD's decode) has exactly that many frames of
16-bit samples, and `fsb5ToWav()` equals it byte for byte
(`packages/audio/tests/adpcm-fixtures.test.ts`). Two IMA ADPCM details these
clips cannot reach stay covered by the hand-built banks only: a partial last
frame, since Unity writes none, and a step index byte above 88 (read as u8 and
clamped to 88, where vgmstream reads it signed), since Unity's encoder writes
only 0 to 88.

### Header paths (#289)

The `audiohdr` bundle holds five AudioClips whose FSB5 sample headers take
paths the `audio` and `adpcm` clips do not: a `FREQUENCY` chunk, a `CHANNELS`
chunk and the six-channel value of the header's channel bits, each read by
`readFsb5()` and checked against AssetStudio's WAV
(`packages/audio/tests/header-fixtures.test.ts`). Editors: 2019.4.41f2,
2020.3.30f1 and 6000.3.26f1, `lz4` only (the issue's choice; the header does
not depend on the type tree), so 3 files, about 170 KB.

A probe came first, in a 6000.3.26f1 project (`uar-289-probe-6000.3.26f1`)
holding eight clips: the five below and `mono12000-pcm`, `mono12000-adpcm` and
`mono37800-adpcm`, built once into one `lz4` bundle and read with UnityPy
1.25.3. What Unity writes, `Preserve Sample Rate`, `DecompressOnLoad`, every
bank FSB5 version 1 with one sample:

| Clip | Codec | Header | Kept |
|---|---|---|---|
| `mono12000-pcm`, `mono12000-adpcm` | PCM16, IMAADPCM | frequency id 3, no chunk: 12000 Hz is in FMOD's id table | no, the id table is reached already |
| `mono37800-pcm` | PCM16 | frequency id 0 and a `FREQUENCY` chunk of 37800 | yes |
| `mono37800-adpcm` | IMAADPCM | the same header as `mono37800-pcm` | no, nothing new |
| `quad-pcm`, `quad-adpcm` | PCM16, IMAADPCM | channel bits 0 (mono) and a `CHANNELS` chunk of 4 | yes |
| `surround-pcm`, `surround-adpcm` | PCM16, IMAADPCM | channel bits 2 (6 channels), no chunk | yes |

So Unity writes a `FREQUENCY` chunk only for a rate outside the id table, a
`CHANNELS` chunk only for a channel count other than 1, 2, 6 or 8, and no other
chunk for PCM16 or IMAADPCM. The three editors write the same headers.

IMA ADPCM of four and six channels is not laid out as mono and stereo are
(each channel's 4-byte header, then 4-byte groups taking turns between the
channels). A frame is still 0x24 bytes per channel, but it holds first every
channel's `Int16` first sample, then every channel's step index as a 16-bit
word, then 2-byte groups of 4 nibbles taking turns between the channels.
Fmod5Sharp refuses more than two channels; this layout is read off the bytes
and FMOD's decode, and `decodeImaAdpcm()` follows it. AssetStudio's WAV for
every clip is FMOD's decode,
4000 frames for PCM16 and 4032 (63 whole IMA ADPCM frames) for IMAADPCM, and
`fsb5ToWav()` equals it byte for byte. What Unity does not write for these
clips stays on the hand-built banks: FADPCM, GCADPCM, `PCM8` and `PCM32` (Unity
writes `PCM16` whatever the source depth, see
[Source bit depth](#source-bit-depth-296)), a partial last IMA ADPCM frame, a
step index above 88, and a `CHANNELS` chunk before a `DSPCOEFF` one.

| File | Bytes | sha256 |
|---|---|---|
| `mono37800-pcm.wav` | 8044 | `4ae80bf7d99019c8f6501cb5cfa12274ea122fe93cf2f6b0155251a05af0d7ba` |
| `quad-pcm.wav` | 32044 | `3dfca246a3cdc242df9da8771cc87b380710298822b786c0212a15d943a3ea89` |
| `quad-adpcm.wav` | 32044 | `3dfca246a3cdc242df9da8771cc87b380710298822b786c0212a15d943a3ea89` |
| `surround-pcm.wav` | 48044 | `4cfd28eed6cf47512117999d4bf9ac7758414f01a5f66deff1b91f6a6a43f4b1` |
| `surround-adpcm.wav` | 48044 | `4cfd28eed6cf47512117999d4bf9ac7758414f01a5f66deff1b91f6a6a43f4b1` |

Each WAV is 4000 frames of 16-bit sines, channel `k` at 440 + 110 `k` Hz and
amplitude 12000 - 1500 `k`, so a channel swap or mix shows; a `-pcm` and an
`-adpcm` WAV of the same layout are the same bytes. They are byte-exact from
`gen_audiohdr.py` with Python 3.12 (standard library only):

```bash
python3 gen_audiohdr.py <project>/Assets/Fixtures/audiohdr
```

The probe passed the eight names as arguments.

`gen_audiohdr.py`:

```python
import hashlib, math, pathlib, struct, sys, wave

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
# Without names: the five clips the bundles hold (section 11, "Header paths").
names = sys.argv[2:] or ["mono37800-pcm", "quad-pcm", "quad-adpcm", "surround-pcm", "surround-adpcm"]
FRAMES = 4000

# name -> (rate, channel count); channel k is a sine of 440 + 110 k Hz at
# amplitude 12000 - 1500 k, so a channel swap or mix shows in the output.
CLIPS = {
    "mono12000": (12000, 1),
    "mono37800": (37800, 1),
    "quad": (22050, 4),
    "surround": (22050, 6),
}

def frames(rate, channels):
    return b"".join(
        struct.pack("<%dh" % channels, *(
            round((12000 - 1500 * k) * math.sin(2 * math.pi * (440 + 110 * k) * i / rate))
            for k in range(channels)))
        for i in range(FRAMES))

for name in names:
    rate, channels = CLIPS[name.rsplit("-", 1)[0]]
    with wave.open(str(out / (name + ".wav")), "wb") as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(frames(rate, channels))
    data = (out / (name + ".wav")).read_bytes()
    print(name + ".wav", len(data), hashlib.sha256(data).hexdigest())
```

Create a project per editor named `uar-289-audio-<editor version>`, with
`ProjectSettings/` and `Packages/` copied from the `uar-251-adpcm-<editor
version>` project above, and only the five WAVs and this file under `Assets/`.

`Assets/Editor/BuildAudioHdr.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// AudioClips for the FSB5 header paths of #289: an odd sample rate and more
// than two channels, PCM and IMA ADPCM, from generated WAVs.
public static class BuildAudioHdr
{
    const string Dir = "Assets/Fixtures/audiohdr";

    public static void Build()
    {
        var paths = Directory.GetFiles(Dir, "*.wav");
        System.Array.Sort(paths, System.StringComparer.Ordinal);
        for (int i = 0; i < paths.Length; i++)
        {
            paths[i] = paths[i].Replace('\\', '/');
            Audio(paths[i]);
        }
        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "audiohdr", assetNames = paths },
        };
        var dir = Path.Combine("Build", "audiohdr-lz4");
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds,
            BuildAssetBundleOptions.ChunkBasedCompression, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: audiohdr lz4");
        Debug.Log("FIXTURE-OK audiohdr lz4 -> " + dir);
    }

    static void Audio(string path)
    {
        var imp = (AudioImporter)AssetImporter.GetAtPath(path);
        var s = imp.defaultSampleSettings;
        s.compressionFormat = path.EndsWith("-adpcm.wav")
            ? AudioCompressionFormat.ADPCM : AudioCompressionFormat.PCM;
        s.loadType = AudioClipLoadType.DecompressOnLoad;
        s.sampleRateSetting = AudioSampleRateSetting.PreserveSampleRate;
        imp.defaultSampleSettings = s;
        imp.forceToMono = false;
        imp.SaveAndReimport();
        var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
        Debug.Log("FIXTURE-CLIP " + path + " " + clip.channels + " ch " + clip.frequency
            + " Hz " + clip.samples + " frames");
    }
}
```

Build with `-executeMethod BuildAudioHdr.Build` (same command as section 2),
once per project. The log must hold one `FIXTURE-OK audiohdr lz4` line and a
`FIXTURE-CLIP` line per clip with its channels, rate and frames. Copy only
`Build/audiohdr-lz4/audiohdr` to `fixtures/bundles/editor/<editor
version>/lz4/`. Then rerun `make-goldens.py` and `make-export-goldens.py`
(section 17).

### Source bit depth (#296)

`fsb5ToWav()` writes FSB5 `PCM8` and `PCM32` as stored, but every PCM clip
above came from a 16-bit WAV. A probe checked whether Unity keeps another
source depth when a clip uses `AudioCompressionFormat.PCM`. It does not: no
bundle is kept, and `PCM8` and `PCM32` stay on hand-built banks
(`packages/audio/tests/wav.test.ts`).

Four mono 22050 Hz WAVs of 4000 frames each, a 440 Hz sine at about half
scale (0.78 for the 8-bit file), were imported with `PCM`, `DecompressOnLoad` and `Preserve Sample Rate`
and built once into one `lz4` bundle per editor, in projects
`uar-296-probe-<editor version>` for 2019.4.41f2, 2020.3.30f1 and 6000.3.26f1.
Read with UnityPy 1.25.3, the three editors write the same thing:

| Source WAV | `m_BitsPerSample` | `m_CompressionFormat` | FSB5 codec (header `mode`) | Samples |
|---|---|---|---|---|
| `mono-u8`, 8-bit unsigned | 16 | 0 (PCM) | `PCM16` (2) | (v - 128) << 8, exactly |
| `mono-s24`, 24-bit | 16 | 0 (PCM) | `PCM16` (2) | the top 16 bits, exactly |
| `mono-s32`, 32-bit integer | 16 | 0 (PCM) | `PCM16` (2) | the top 16 bits, exactly |
| `mono-f32`, 32-bit float | 16 | 0 (PCM) | `PCM16` (2) | trunc(v * 32767), exactly |

Every bank is FSB5 version 1, one sample, 8032 data bytes (4000 frames of
16-bit, padded to 32). So Unity writes neither `PCM8`, `PCM24`, `PCM32` nor
`PCMFLOAT` for these sources, and `fsb5ToWav()` keeps refusing `PCM24` and
`PCMFLOAT` as before. The WAVs are byte-exact from `gen_audiodepth.py` with
Python 3.12 (standard library only):

```bash
python3 gen_audiodepth.py <project>/Assets/Fixtures/audiodepth
```

| File | Bytes | sha256 |
|---|---|---|
| `mono-u8.wav` | 4044 | `7c9f3c71fb08228c29fed1e7131facc38479b59498f53e462f475b02d3588893` |
| `mono-s24.wav` | 12044 | `79b3085839109e53c3d31d89f555d094e89ee8adcc087fa925ebb91b9ac33778` |
| `mono-s32.wav` | 16044 | `546764a29340b0a0b53e90c075a2d1111dfd744ebef4ca96a5397f876ab14761` |
| `mono-f32.wav` | 16044 | `80ac5c8556bb42201fa34db863f54183dbce3681777017314b921cb89d06643c` |

`gen_audiodepth.py`:

```python
import hashlib, math, pathlib, struct, sys

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
names = sys.argv[2:] or ["mono-u8", "mono-s24", "mono-s32", "mono-f32"]
RATE, FRAMES = 22050, 4000

def sample(name, s):
    # s is a 440 Hz sine in [-1, 1]; each depth stores it its own way (8-bit at 0.78, the rest near 0.5).
    if name.endswith("-u8"):
        return struct.pack("<B", 128 + round(100 * s))
    if name.endswith("-s24"):
        return struct.pack("<i", round(4000000 * s))[:3]
    if name.endswith("-s32"):
        return struct.pack("<i", round(1000000000 * s))
    return struct.pack("<f", 0.5 * s)

# name -> (format tag, bits): 1 integer PCM, 3 IEEE float.
FORMATS = {"u8": (1, 8), "s24": (1, 24), "s32": (1, 32), "f32": (3, 32)}

for name in names:
    tag, bits = FORMATS[name.rsplit("-", 1)[1]]
    data = b"".join(sample(name, math.sin(2 * math.pi * 440 * i / RATE)) for i in range(FRAMES))
    fmt = struct.pack("<HHIIHH", tag, 1, RATE, RATE * bits // 8, bits // 8, bits)
    riff = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt \
        + b"data" + struct.pack("<I", len(data)) + data
    blob = b"RIFF" + struct.pack("<I", len(riff)) + riff
    (out / (name + ".wav")).write_bytes(blob)
    print(name + ".wav", len(blob), hashlib.sha256(blob).hexdigest())
```

Each probe project has `ProjectSettings/` and `Packages/` copied from the
`uar-289-*` project of its editor, these four WAVs, and
`Assets/Editor/BuildAudioDepth.cs`: `BuildAudioHdr.cs` above with the class
`BuildAudioDepth`, the folder `Assets/Fixtures/audiodepth`, the bundle name
`audiodepth` and `AudioCompressionFormat.PCM` for every clip. Build with
`-executeMethod BuildAudioDepth.Build` (section 2); each log held one
`FIXTURE-OK audiodepth lz4` line and four `FIXTURE-CLIP` lines of 1 channel,
22050 Hz, 4000 frames. To read the codec, take each AudioClip's `m_Resource`
bytes (UnityPy's `get_resource_data`) and the little-endian `UInt32` at byte
24 of the bank, the codec field `readFsb5()` reads.

## 12. The `sprite` bundles (#34)

One LZ4 bundle per editor, `sprite/sprites`, built with **2019.4.41f2**
(format 21) and **6000.3.25f1** (format 22): Sprites and SpriteAtlases
(Sprite Atlas V1). Every source image is made by script, and each of its
pixels says where it is: R = 5x + 3, G = 5y + 5 (y from the bottom, as Unity
stores rows), B = 16 id + 7, all mod 256, where `id` names the image. Alpha is
255 inside the image's shape and 0 outside, and the colour is kept outside
too, so a crop, flip or mask that goes wrong shows in the pixels themselves.

- `sheet` (`id` 1): one 64x48 texture made by script, kept inline, and four
  sprites cut from it by `Sprite.Create` at rectangles off the origin:
  `sheet_a`, `sheet_b` (pivot at the corner, a border), `sheet_c` (pivot
  0.25/0.75), all full-rect, and `sheet_d` (tight mesh, over a diamond).
- `tight` (`id` 2): one 40x36 PNG imported as a single tight-mesh sprite.
- `packed`: a tight-packed atlas with rotation allowed, 15 sprites of
  triangles, L shapes, diamonds and bars (`p_*`, `id` 1 to 15). Its packer
  flipped some of them (`SpritePackingRotation` FlipHorizontal, FlipVertical
  and Rotate180; neither editor's packer writes Rotate90), and trimmed the
  transparent margin of `p_margin`, so its `textureRect` is not whole pixels
  and `textureRectOffset` is not 0.
- `rect`: a rectangle-packed atlas without rotation, `r_a` and `r_b`.

The atlas textures and `tight` live in the bundle's `.resS` node. Unity only
gives a sprite a tight mesh from 32x32 up, hence the sizes.

Any project will do; the committed bundles came from fresh ones holding only
`Assets/Editor/BuildSprites.cs`:

```csharp
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.U2D;
using UnityEngine;
using UnityEngine.U2D;

// Sprites and SpriteAtlases (#34): a sheet of sprites cut from one texture, a
// tight-mesh sprite, and two V1 atlases, one tight-packed with rotation allowed
// and one rectangle-packed. Every pixel encodes where it is, so a crop, rotation
// or flip that goes wrong shows.
public static class BuildSprites
{
    const string Dir = "Assets/Fixtures/sprite";

    public static void Build()
    {
#pragma warning disable 618 // Unity 6 marks the V1 packer modes obsolete; they still pack.
        EditorSettings.spritePackerMode = SpritePackerMode.AlwaysOnAtlas;
#pragma warning restore 618
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "sprite");
        var assets = new List<string>();

        // 1. A sheet: sprites cut out of one texture made by script, at rects off
        // the origin, with different pivots, a border and both mesh types.
        var sheetPath = Dir + "/sheet.asset";
        AssetDatabase.DeleteAsset(sheetPath);
        // Opaque, except a diamond in the rect of sheet_d, the tight one (Unity only
        // gives a sprite a tight mesh from 32x32 up).
        var sheet = new Texture2D(64, 48, TextureFormat.RGBA32, false) { name = "sheet", filterMode = FilterMode.Point };
        sheet.SetPixels32(Pixels(64, 48, 1, Shape.Diamond, 44, 29, 36, 34, new RectInt(26, 12, 36, 34)));
        sheet.Apply(false, false);
        AssetDatabase.CreateAsset(sheet, sheetPath);
        AddSprite(sheet, sheetPath, "sheet_a", new Rect(0, 0, 8, 6), new Vector2(0.5f, 0.5f), SpriteMeshType.FullRect, Vector4.zero);
        AddSprite(sheet, sheetPath, "sheet_b", new Rect(10, 4, 12, 9), new Vector2(0f, 0f), SpriteMeshType.FullRect, new Vector4(1, 2, 3, 4));
        AddSprite(sheet, sheetPath, "sheet_c", new Rect(2, 30, 11, 15), new Vector2(0.25f, 0.75f), SpriteMeshType.FullRect, Vector4.zero);
        AddSprite(sheet, sheetPath, "sheet_d", new Rect(26, 12, 36, 34), new Vector2(0.3f, 0.6f), SpriteMeshType.Tight, Vector4.zero);
        assets.Add(sheetPath);

        // 2. A tight-mesh sprite on its own texture, imported, not packed.
        assets.Add(Png("tight", 40, 36, 2, Shape.Diamond, SpriteMeshType.Tight, new Vector2(0.5f, 0.5f)));

        // 3. A tight-packed atlas that may rotate and flip what it packs.
        var packed = new List<Object>();
        packed.Add(Sprite("p_tall", 8, 40, 3, Shape.Full, SpriteMeshType.FullRect));
        packed.Add(Sprite("p_wide", 40, 8, 4, Shape.Full, SpriteMeshType.FullRect));
        packed.Add(Sprite("p_tri", 36, 36, 5, Shape.Triangle, SpriteMeshType.Tight));
        packed.Add(Sprite("p_tri2", 36, 36, 6, Shape.Triangle, SpriteMeshType.Tight));
        packed.Add(Sprite("p_tri3", 32, 40, 7, Shape.TriangleFlipped, SpriteMeshType.Tight));
        packed.Add(Sprite("p_ell", 40, 32, 8, Shape.Ell, SpriteMeshType.Tight));
        packed.Add(Sprite("p_diamond", 34, 40, 9, Shape.Diamond, SpriteMeshType.Tight));
        packed.Add(Sprite("p_tri4", 32, 32, 10, Shape.Triangle, SpriteMeshType.Tight));
        packed.Add(Sprite("p_tri5", 32, 32, 11, Shape.TriangleFlipped, SpriteMeshType.Tight));
        packed.Add(Sprite("p_ell2", 32, 32, 12, Shape.Ell, SpriteMeshType.Tight));
        packed.Add(Sprite("p_ell3", 32, 40, 13, Shape.Ell, SpriteMeshType.Tight));
        packed.Add(Sprite("p_bar", 36, 6, 14, Shape.Full, SpriteMeshType.FullRect));
        packed.Add(Sprite("p_bar2", 6, 36, 15, Shape.Full, SpriteMeshType.FullRect));
        packed.Add(Sprite("p_tri6", 40, 32, 1, Shape.Triangle, SpriteMeshType.Tight));
        // Transparent margins, which the packer trims: textureRect is smaller
        // than m_Rect and textureRectOffset is not zero.
        packed.Add(Sprite("p_margin", 40, 40, 2, Shape.Inset, SpriteMeshType.Tight));
        assets.Add(Atlas("packed", packed, true, true));

        // 4. A rectangle-packed atlas without rotation.
        var rect = new List<Object>();
        rect.Add(Sprite("r_a", 10, 8, 11, Shape.Full, SpriteMeshType.FullRect));
        rect.Add(Sprite("r_b", 34, 33, 12, Shape.Diamond, SpriteMeshType.Tight));
        assets.Add(Atlas("rect", rect, false, false));

        AssetDatabase.SaveAssets();
        SpriteAtlasUtility.PackAllAtlases(BuildTarget.StandaloneWindows64);
        foreach (var path in assets) Debug.Log("FIXTURE-ASSET " + path);

        var dir = Path.Combine("Build", "sprite");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "sprites", assetNames = assets.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.ChunkBasedCompression,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: sprite");
        Debug.Log("FIXTURE-OK sprite -> " + dir);
    }

    enum Shape { Full, Diamond, Triangle, TriangleFlipped, Ell, Inset }

    // R and G count x and y (from the bottom, as Unity stores rows), B names the
    // image, alpha is 255 inside the shape and 0 outside; colour stays outside
    // too, so a mask that clears it shows.
    static Color32[] Pixels(int w, int h, int id, Shape shape, float cx, float cy, float sw, float sh, RectInt? region = null)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                bool inside = shape == Shape.Full || (region.HasValue && !region.Value.Contains(new Vector2Int(x, y)));
                float u = (x + 0.5f) / w, v = (y + 0.5f) / h;
                if (shape == Shape.Diamond && !inside) inside = Mathf.Abs(x + 0.5f - cx) / (sw / 2) + Mathf.Abs(y + 0.5f - cy) / (sh / 2) <= 1f;
                if (shape == Shape.Triangle) inside = v <= u;
                if (shape == Shape.TriangleFlipped) inside = v >= u;
                if (shape == Shape.Ell) inside = u < 0.4f || v < 0.4f;
                if (shape == Shape.Inset) inside = Mathf.Abs(x + 0.5f - cx) + Mathf.Abs(y + 0.5f - cy) <= Mathf.Min(sw, sh) / 2 - 8;
                px[y * w + x] = new Color32((byte)(x * 5 + 3), (byte)(y * 5 + 5), (byte)(id * 16 + 7), (byte)(inside ? 255 : 0));
            }
        return px;
    }

    static void AddSprite(Texture2D tex, string path, string name, Rect r, Vector2 pivot, SpriteMeshType mesh, Vector4 border)
    {
        var s = UnityEngine.Sprite.Create(tex, r, pivot, 4f, 0, mesh, border, true);
        s.name = name;
        AssetDatabase.AddObjectToAsset(s, path);
    }

    // A PNG imported as one uncompressed RGBA32 sprite, colour kept under alpha 0.
    static string Png(string name, int w, int h, int id, Shape shape, SpriteMeshType mesh, Vector2 pivot)
    {
        var path = Dir + "/" + name + ".png";
        var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
        tex.SetPixels32(Pixels(w, h, id, shape, w / 2f, h / 2f, w, h));
        File.WriteAllBytes(path, tex.EncodeToPNG());
        AssetDatabase.ImportAsset(path);
        var imp = (TextureImporter)AssetImporter.GetAtPath(path);
        imp.textureType = TextureImporterType.Sprite;
        imp.spriteImportMode = SpriteImportMode.Single;
        imp.alphaIsTransparency = false;
        imp.mipmapEnabled = false;
        imp.filterMode = FilterMode.Point;
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.spritePixelsPerUnit = 8f;
        var settings = new TextureImporterSettings();
        imp.ReadTextureSettings(settings);
        settings.spriteMeshType = mesh;
        settings.spriteAlignment = (int)SpriteAlignment.Custom;
        settings.spritePivot = pivot;
        settings.spriteExtrude = 1;
        imp.SetTextureSettings(settings);
        imp.SetPlatformTextureSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true, format = TextureImporterFormat.RGBA32, maxTextureSize = 256 });
        imp.SaveAndReimport();
        return path;
    }

    static Object Sprite(string name, int w, int h, int id, Shape shape, SpriteMeshType mesh)
    {
        var path = Png(name, w, h, id, shape, mesh, new Vector2(0.5f, 0.5f));
        return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
    }

    static string Atlas(string name, List<Object> sprites, bool tight, bool rotate)
    {
        var path = Dir + "/" + name + ".spriteatlas";
        AssetDatabase.DeleteAsset(path);
        var atlas = new SpriteAtlas();
        atlas.SetPackingSettings(new SpriteAtlasPackingSettings { enableRotation = rotate, enableTightPacking = tight, padding = 2, blockOffset = 1 });
        atlas.SetTextureSettings(new SpriteAtlasTextureSettings { readable = false, generateMipMaps = false, sRGB = true, filterMode = FilterMode.Point });
        atlas.SetPlatformSettings(new TextureImporterPlatformSettings { name = "DefaultTexturePlatform", maxTextureSize = 256, textureCompression = TextureImporterCompression.Uncompressed, format = TextureImporterFormat.Automatic });
        atlas.SetPlatformSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true, maxTextureSize = 256, format = TextureImporterFormat.RGBA32 });
        atlas.SetIncludeInBuild(true);
        AssetDatabase.CreateAsset(atlas, path);
        atlas.Add(sprites.ToArray());
        return path;
    }
}
```

Build with `-executeMethod BuildSprites.Build` (same command as section 2).
The log must hold four `FIXTURE-ASSET` lines and one `FIXTURE-OK sprite`.
Copy only `Build/sprite/sprites` to
`fixtures/bundles/editor/<editor version>/sprite/sprites` for 2019.4.41f2 and
6000.3.25f1, about 70 KB each, then rerun `make-goldens.py`: it dumps the
Sprite and SpriteAtlas type trees and hashes UnityPy's image of every sprite
(`sprites`, see [`README.md`](README.md#oracle-notes)).

A 2019.4 editor crashes in `SpriteAtlasUtility.PackAtlases` right after an
atlas is created, hence one `PackAllAtlases` once every atlas is saved. Where
the packer puts and flips each sprite depends on the editor (2019.4 packs into
256x128, 6000.3 into 128x128), so a rebuild may flip other sprites or none;
check the test that the fixtures still cover FlipHorizontal, FlipVertical and
Rotate180, and regenerate the AssetStudio sprite cross-check hashes with the
goldens.

## 13. Unity 6000.6.4f1 candidate fixtures (#108, #153, #155, #160, #229)

Scope: Unity 2019 and newer. Unity 5.x layouts are outside this fixture task.
The existing 2019.4, 2020.3 and 6000.3 bundles are preserved.

These Windows64 builds write **SerializedFile format 23**, even for plain
textures. Core reads their metadata and generic type-tree dumps (#223).
UnityPy **1.25.4** reads these files; 1.25.3 fails in the type-tree metadata.
They are therefore candidate fixtures, with independent goldens in
`modern-goldens.json`, separate from the supported-fixture `goldens.json`.
`scripts/make-goldens.py` excludes the sidecar's candidate keys; it continues
using UnityPy 1.25.3 for the existing fixtures. The core reads their Sprite and
SpriteAtlas layouts and compares them with these dumps (#155), and the texture
package cuts the sprites a 6000.6 atlas holds out of it (#229).

They stay out of the main golden set (decided on #229): the signed plain
formats of `more-plain` are still not converted, and `goldens.json` is made by
UnityPy 1.25.3, which cannot read format 23; moving the sprite bundles alone
would mix two oracle versions in one file for no extra check.

| Folder / bundle | Content | Evidence / remaining work |
|---|---|---|
| `more-plain/textures` | 13 textures, 8x5, no mips, raw byte ramp | R8, RG16, RG32, RGB48, RGBA64 tested by #108; eight signed variants remain unsupported |
| `sprite/sprites` | Section 12 source, Atlas V1 | #155: atlas drops packed sprite arrays and embeds `*spriteInstanceData` in every render-data entry; the core reads it (`Sprite.test.ts`). #229: its 17 packed sprites (RGBA32) are cut to UnityPy's crop, every opaque pixel of its own image lands where section 12's recipe drew it, and their tight masks equal AssetStudio's images of the same sprites in the 6000.3 build |
| `variant/sprites` | `rect` master plus `half` variant, scale 0.5 | #153: two real entries have `downscaleMultiplier = 0.5`; the resize is checked to the byte on the 2019.4 variant (section 14). #229: this variant's half-scale sprites are cut at AssetStudio's size; their pixels differ from 2019.4's. #230: they are checked to the byte against AssetStudio's executed `CutImage` of this atlas' own entries (section 15, `--modern`) |
| `sprite-v2/sprites` | Section 12 shapes, native Atlas V2, packed with the importer defaults (tight, see below) | #160 probe: flips observed, no rotation value 4. #229: DXT5 atlas, its packed sprites checked against UnityPy's crop with the WASM decoder; their tight masks (all tight-packed) against `sprite/sprites`' masks, without it |
| `sprite-v2-rect/sprites` | Same shapes, native Atlas V2. Its builder asks for rectangle packing of the `packed` atlas, but the request never reached Unity: same importer defaults, every entry tight-packed (see below) | #160 probe: flips and Rotate180 observed, no rotation value 4. #229: as `sprite-v2` |

The 6000.6 atlas holds the imported sprites' names, rects, pivots, border,
vertex data and indices inside `*spriteInstanceData`; individual packed Sprite
objects are no longer necessary in the bundle. The sheet and unpacked tight
sprite are still individual Sprite objects. Inspect the oracle type-tree dumps,
not only the old `sprites` image map, when implementing #160.

UnityPy 1.25.4 exports Sprite objects only, so it has no image of a packed
sprite of its own. `make-modern-goldens.py` gives its `get_image_from_sprite`
a stand-in sprite that names only the atlas and the entry's render-data key,
which is all that function reads with the packing mode forced to Rectangle
(as `make-goldens.py`'s `rgbaSha256`): `serialized.<file>.packedSprites`, by
atlas path id, in `m_RenderDataMap` order, each with that `oracleNote`. It has
no tight image (UnityPy's differs from AssetStudio's anyway, section 12's
notes), and a variant entry's hash ignores the downscale (`variantOracleNote`).

### Prepare and build

Create an empty project outside the repository (R2) with the installed editor,
then run:

```text
python scripts/prepare-modern-fixtures.py <project>
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildMorePlain.Build -logFile <project>/plain.log
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildSprites.Build -logFile <project>/sprite.log
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildVariantSprites.Build -logFile <project>/variant.log
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildV2Sprites.Build -logFile <project>/v2.log
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildV2Rects.Build -logFile <project>/v2-rect.log
```

Run sequentially; the methods select their packer mode. The plain build must
log 13 `FIXTURE-TEX` lines and `FIXTURE-OK more-plain`. Each sprite builder
must log `FIXTURE-OK sprite`, followed by its `Build/<folder>` output path.
Copy only the five bundle files listed above from `Build/<folder>` to
`fixtures/bundles/editor/6000.6.4f1/<folder>`. The binary `.resS` data is embedded
in each bundle; do not copy text manifests or any C# into the repository.

The preparer takes the section 12 `BuildSprites` source, writes it into the
local project, and derives the variant and V2 builders from it. It uses native
packing throughout and never forces `settingsRaw`.

**The V2 atlases were packed with the importer defaults, not section 12's
settings (#292).** The V2 builders keep section 12's `Atlas()` calls, now on a
`SpriteAtlasAsset`. In 6000.6 its `SetPackingSettings`, `SetTextureSettings`,
`SetPlatformSettings` and `SetIncludeInBuild` are obsolete (the compiler warns
"SetPackingSettings is no longer supported and will be removed. Use
SpriteAtlasImporter.SetPackingSettings instead", and the same for the other
three) and empty (UnityCsReference
`Editor/Mono/2D/SpriteAtlas/SpriteAtlasAsset.bindings.cs`:
`public void SetPackingSettings(SpriteAtlasPackingSettings src) { }`). Section
16's settings check shows the first three change nothing; `SetIncludeInBuild(true)`
asks for the default anyway. The settings that applied to both bundles' atlases
are the `.spriteatlasv2` importer defaults that check read back from the
6000.6.4f1 editor:

| Setting | Section 12 asks for | Applied (importer default) |
|---|---|---|
| Packing | `packed` atlas: tight with rotation (`sprite-v2-rect`: rectangle with rotation); `rect` atlas: rectangle, no rotation | tight, rotation enabled |
| Padding / block offset | 2 / 1 | 4 / 1 |
| Filter | point | bilinear |
| Standalone format, maximum size | RGBA32, 256 | Automatic compressed (the atlases are DXT5), 2048 |
| Include in build | yes | yes |

The committed data agrees: all 17 + 17 `packedSprites` entries of the two V2
bundles in `modern-goldens.json` have `settingsRaw` bit 1 (packing mode) 0,
tight, while the V1 `sprite/sprites` has `r_a` and `r_b` rectangle-packed; and
the V2 atlas textures are DXT5 (format 12) where V1's are RGBA32 (format 4). The
two V2 bundles thus differ only by their packer run, not by their settings:
`sprite-v2`'s packed page is 256x128 and `sprite-v2-rect`'s 128x256, with
different rotations. They are kept as built; every result above stands.

The plain builder writes `(k * 37 + 11) & 255` into every byte. This exercises
both signs of the signed channels and distinct high/low bytes of 16-bit
channels. `R16_Alt` has no editor enum; it is an AssetStudio-only alias and has
no separate Unity fixture.

`Assets/Editor/BuildMorePlain.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildMorePlain
{
    public static void Build()
    {
        Directory.CreateDirectory("Assets/Fixtures/more-plain");
        AssetDatabase.Refresh();
        var paths = new List<string>();
        var formats = new[] { TextureFormat.R8, TextureFormat.RG16, TextureFormat.RG32,
            TextureFormat.RGB48, TextureFormat.RGBA64, TextureFormat.R8_SIGNED,
            TextureFormat.RG16_SIGNED, TextureFormat.RGB24_SIGNED, TextureFormat.RGBA32_SIGNED,
            TextureFormat.R16_SIGNED, TextureFormat.RG32_SIGNED, TextureFormat.RGB48_SIGNED,
            TextureFormat.RGBA64_SIGNED };
        foreach (var format in formats)
        {
            var tex = new Texture2D(8, 5, format, false) { name = format.ToString() };
            var raw = new byte[tex.GetRawTextureData().Length];
            for (int k = 0; k < raw.Length; k++) raw[k] = (byte)((k * 37 + 11) & 255);
            tex.LoadRawTextureData(raw);
            tex.Apply(false, false);
            var path = "Assets/Fixtures/more-plain/" + format + ".asset";
            AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(tex, path);
            paths.Add(path);
            Debug.Log("FIXTURE-TEX " + format + " " + raw.Length);
        }
        AssetDatabase.SaveAssets();
        Directory.CreateDirectory("Build/more-plain");
        var builds = new[] { new AssetBundleBuild { assetBundleName = "textures", assetNames = paths.ToArray() } };
        if (BuildPipeline.BuildAssetBundles("Build/more-plain", builds,
            BuildAssetBundleOptions.UncompressedAssetBundle, BuildTarget.StandaloneWindows64) == null)
            throw new Exception("more-plain build failed");
        Debug.Log("FIXTURE-OK more-plain");
    }
}

```

### Independent goldens and validation

Use a separate virtual environment:

```text
python3 -m venv <modern-oracle>
<modern-oracle>/bin/pip install UnityPy==1.25.4
<modern-oracle>/bin/python scripts/make-modern-goldens.py
npm ci
npm run verify
```

The sidecar includes raw node hashes, object tables, type trees and texture
RGBA hashes wherever UnityPy supports the format. Oracle limitations remain
explicit `oracleError`/`oracleNote` fields. The core's candidate tests compare
all unpacked nodes with the oracle and assert that SerializedFile parsing
refuses format 23. This proves container integrity, not pixel decoder support.

### Remaining blockers

- #152 ETC1 split alpha: this 6000.6 installation has Windows and WebGL
  modules, but no Android module, so no 6000.6 Android fixture was generated.
  The Android fixture is the 2019.4.41f2 `split-alpha/sprites` of section 14.
- #160: none of the three native packer configurations above produced
  rotation value 4. The probe bundles are reproducible evidence, not acceptance
  of Rotate90. Its UV0-derived direction and source-image comparison remain open.
- #153: the variant's type-tree bytes are validated; UnityPy ignores its
  downscale field for sprite export. The resampler is chosen and checked to the
  byte against the AssetStudio bicubic cross-check of the 2019.4 variant
  (sections 14 and 15). This 6000.6 variant's sprites are cut since #229, and
  checked to the byte against AssetStudio's executed `CutImage` of them since
  #230 (section 15, `--modern`).
- #229: a Sprite object that points at a 6000.6 atlas is still refused with
  `UnsupportedError`: no fixture has one, to show whether its own `m_RD` or the
  atlas' `*spriteInstanceData` holds its mesh. The V2 atlases' tight masks do
  not depend on their DXT5 pixels: over an opaque stand-in texture, all 32 but
  `r_b` equal the masks of the same sprites in `sprite/sprites`, which are
  pinned to AssetStudio's and UnityPy's images (including the only masks over
  a FlipHorizontal packing). `r_b` has no reference: it is rectangle-packed in
  the V1 and 6000.3 builds, so its 8-vertex V2 mask is only checked to keep its
  whole diamond. No 6000.6 fixture has an alpha texture; a packed sprite's
  split alpha is tested on a patched entry only.
- Format 23 is read since #223.

### RGB48 AssetStudio verdict (PR #221 review)

RGB48's UnityPy 1.25.4 export is incorrect for AssetStudio's required
conversion. Keep its original `rgbaSha256` for oracle provenance, but do not
use that hash as decoder acceptance. Its generated `oracleNote` records
**Verdict: AssetStudio**, and `assetStudioCrossCheck.rgbaSha256` is the expected
RGB48 result. R8's unsigned UnityPy image hash is unqualified. RG16, RG32 and
RGBA64 now use the executed references in section 15.

`fixtures/assetstudio-rgb48.json` was generated by executing the unmodified
`DecodeRGB48` and `DownScaleFrom16BitTo8Bit` methods from
`AssetStudio.Utility/Texture2DConverter.cs` at revision
`c37af7dfcdafee93e33b5da9f0285c97998d6ae3` (Git blob
`91c659434c07d92ea1d6fbc634d222fc37222b4f`) in a .NET 8 console harness
outside the repository. It runs the actual methods, rather than a Python/TS
translation. The full AssetStudio application was not executed. Its BGRA
output is swapped to RGBA once and hashed bottom row first. The first pixel
is `[48, 122, 196, 255]`, and the RGBA SHA-256 is
`03d886e69c09698f9a1f94e48f2365c8470cbb730686af697ada98730e31db9d`.

To reproduce, retrieve that exact source outside the repository and use
UnityPy 1.25.4 to extract the fixture's RGB48 bytes into `<raw-input>`:

```python
import pathlib, UnityPy
bundle = "fixtures/bundles/editor/6000.6.4f1/more-plain/textures"
for obj in UnityPy.load(bundle).objects:
    if obj.type.name == "Texture2D":
        texture = obj.read()
        if texture.m_Name == "RGB48":
            pathlib.Path("<raw-input>").write_bytes(bytes(texture.get_image_data()))
```

Then, using Python with access to the installed .NET 8 SDK:

```text
python scripts/cross-check-rgb48.py --source <external-Texture2DConverter.cs> --input <raw-input> --project <external-harness> --output fixtures/assetstudio-rgb48.json --dotnet <dotnet-executable>
<modern-oracle>/bin/python scripts/make-modern-goldens.py
```

The harness checks the source blob before extracting the methods. The golden
generator verifies the cross-check's source blob, verdict and input hash
against the fixture. It never replaces the original UnityPy image hash.
C# is generated only in the external harness project, preserving R2.

## 14. Unity 2019.4.41f2 acceptance fixtures and rotation probes

These bundles complement section 13's Unity 6000.6 candidates. They contain
SerializedFile format 21, so the current reader can load and compare their
class fields. Install the Windows standalone and Android build modules.
Create a separate local Unity project outside this repository, then run:

```text
python scripts/prepare-2019-fixtures.py <external-2019-project>
```

The script derives five builders from sections 12 and 13. It excludes the
signed formats and SpriteAtlas V2 APIs unavailable in 2019. Run Unity in
batch mode with the external project and each of these execute methods:

| Execute method | Output under the project | Committed bundle |
| --- | --- | --- |
| `BuildMorePlain.Build` | `Build/more-plain/textures` | `editor/2019.4.41f2/more-plain/textures` |
| `BuildVariantSprites.Build` | `Build/variant/sprites` | `editor/2019.4.41f2/variant/sprites` |
| `BuildSplitAlpha.Build` | `Build/split-alpha/sprites` | `editor/2019.4.41f2/split-alpha/sprites` |
| `BuildRotationProbe.Build` | `Build/rotation-probe/sprites` | `editor/2019.4.41f2/rotation-probe/sprites` |
| `BuildLegacyProbe.Build` | `Build/legacy-probe/sprites` | `editor/2019.4.41f2/legacy-probe/sprites` |

For example, on Windows (substitute the external project and log paths):

```powershell
& 'C:\Program Files\Unity\Hub\Editor\2019.4.41f2\Editor\Unity.exe' -batchmode -nographics -quit -projectPath <external-2019-project> -executeMethod BuildSplitAlpha.Build -logFile <external-log>
```

Copy only the five named bundles into `fixtures/bundles/`, then regenerate
canonical goldens using UnityPy 1.25.3 and run `npm run verify`.

The plain fixture contains R8, RG16, RG32, RGB48 and RGBA64, each 8 by 5 with
one mip and the section 13 byte ramp. Its RGB48 input hash matches the executed
AssetStudio converter cross-check exactly. The golden retains UnityPy's
conflicting image hash with an explicit AssetStudio verdict.

The variant has two native render-data entries with `downscaleMultiplier = 0.5`.
UnityPy ignores this multiplier when exporting sprites. Its hashes are labeled
unsuitable for #153 resize acceptance. The executed AssetStudio bicubic reference
pixels are available through section 15; the texture package's sprite tests check
its resize (#153) against them to the byte.

The Android atlases use ETC_RGB4 with `allowsAlphaSplitting = true`. All 17
atlas sprite entries resolve to distinct, non-null ETC1 color and alpha textures.
It is #152's fixture: its sprite goldens are UnityPy's `get_image`, which takes
the alpha texture's red channel as alpha.

The rotation probe uses rectangular packing with rotation enabled and a
64-pixel atlas maximum. The legacy probe uses
`TightRotateEnabledSpritePackerPolicy` and a shared packing tag. Read back
through UnityPy, the rectangle probe has rotation 0, and the legacy probe has
0, 1 and 2. Neither contains native Rotate90 (4). These are negative probes,
not #160 acceptance evidence. Do not force a settings flag to claim native
coverage. A future successful probe must supply UV0/position direction evidence
and an AssetStudio pixel result as required by #160.

## 15. Complete plain-format and variant pixel references (no Unity rebuild)

PR #221's existing 2019 bundles contain all inputs needed for RG16, RG32,
RGBA64 and the half-scale variant's rectangle output. No Unity installation,
license activation or new editor build is needed to generate these references.
Use UnityPy 1.25.3 to extract input bytes and native atlas metadata, then execute
pinned AssetStudio methods with an installed .NET 8 SDK.

Clone the MIT reference outside this repository and check out revision
`c37af7dfcdafee93e33b5da9f0285c97998d6ae3`. From this repository's root:

```text
git clone https://github.com/Razviar/assetstudio.git <external-source>
git -C <external-source> checkout --detach c37af7dfcdafee93e33b5da9f0285c97998d6ae3
.venv-oracle/bin/python scripts/cross-check-fixture-oracles.py --source <external-source> --project <external-harness> --output fixtures/assetstudio-fixture-cross-checks.json --dotnet <dotnet-executable>
<modern-oracle>/bin/python scripts/cross-check-fixture-oracles.py --modern --source <external-source> --project <external-harness> --output fixtures/assetstudio-modern-cross-checks.json --dotnet <dotnet-executable>
.venv-oracle/bin/python scripts/make-goldens.py
<modern-oracle>/bin/python scripts/make-modern-goldens.py
npm run verify
```

Use the separate UnityPy 1.25.4 environment from section 13 for modern goldens.
`--modern` (#230) runs the same harness on the section 13 6000.6
`variant/sprites` bundle, which only UnityPy 1.25.4 reads: its `half` atlas
holds `r_a` and `r_b` itself, with no Sprite objects, so the inputs (texture
bytes, `textureRect`, `textureRectOffset`, `settingsRaw`,
`downscaleMultiplier`) come from each `m_RenderDataMap` entry. Its report is
`assetstudio-modern-cross-checks.json`, kept apart so that the 2019.4 report
and its UnityPy 1.25.3 inputs stay as they are; `make-modern-goldens.py`
attaches its summaries to the variant entries of `packedSprites`, matched on
those inputs, and stops if one does not match. A Windows `dotnet.exe` run from
WSL works: the generator hands it Windows paths (`wslpath -w`) and names its
variables in `WSLENV`. On 2026-11-01 the first `dotnet.exe` call from WSL
sometimes failed with no output and a `UtilAcceptVsock` line; rerun it.
The generator rejects source/harness paths inside this checkout, validates the
source Git blobs before extracting methods, and places C#, project files,
NuGet packages, the lock file and raw temporary output only in the external harness directory.
Network access is needed for its first NuGet restore. Output JSON is the only
new committed pixel artifact; the fixture bundle bytes are unchanged.

| Pinned source file | Git blob SHA-1 |
| --- | --- |
| `Texture2DConverter.cs` | `91c659434c07d92ea1d6fbc634d222fc37222b4f` |
| `SpriteHelper.cs` | `2110b7100491417e337ed06aa155ab9bc3696edb` |
| `AssetStudio.Utility.csproj` | `328274d0428a262c9d6e351fc3d734a9d7f5fad4` |

The source project pins ImageSharp.Drawing **1.0.0-beta15**. Its NuGet
dependencies are explicitly pinned in the harness: ImageSharp **2.1.3**, Fonts
**1.0.0-beta18**. Transitive packages are pinned to exact versions too; the only
restore source is nuget.org, and every downloaded archive is checked against
the SHA-512 recorded in the script/report before compilation. Subsequent runs
use locked restore. All three SixLabors package manifests declare Apache-2.0. They are
external oracle tooling, not package/runtime dependencies or fixture content.
NuGet reports known vulnerabilities in this old ImageSharp release: run this
isolated oracle only on our known fixture bytes, not arbitrary third-party
images. Do not upgrade the resampler silently and rebaseline its pixels.

The unmodified `DecodeRG16`, `DecodeRG32`, `DecodeRGBA64`, `DecodeRGBA32`,
`DownScaleFrom16BitTo8Bit` and `CutImage` methods are executed. Minimal metadata
and texture-loading shims replace the application readers. Tight packing is
rejected before `CutImage`, so no tight-mask or full-app equivalence is claimed.
`CutImage` calls ImageSharp's default [bicubic resize without companding](https://github.com/SixLabors/ImageSharp/blob/v2.1.3/src/ImageSharp/Processing/Extensions/Transforms/ResizeExtensions.cs),
resizing the entire atlas before cropping/undoing native packing. Its top-down
result is flipped back to stored rows; BGRA becomes RGBA exactly once.
The harness runs with `DOTNET_EnableFMA=0`: on a CPU with AVX2 and FMA,
ImageSharp 2.1.3 sums a resize kernel with fused multiply-adds, and on this
host that moved channels of the 2019.4 and 6000.6 `r_b` by 1 (42 pixels of the
6000.6 one). The committed 2019.4 report holds the scalar sums; with FMA off
the same host reproduces it byte for byte, and the 6000.6 report is made the
same way (#230).

The report stores complete RGBA bytes, not just hashes, for future per-channel
tolerance tests. Golden generators attach summaries only when the input hash,
dimensions and relevant native metadata match. Original UnityPy pixel hashes
and export errors are preserved with an explicit AssetStudio verdict. This
prepares #108/#153 acceptance inputs; it does not implement either behavior.

### Native Rotate90 remains unavailable

A fresh UnityPy scan of these ten additional bundles (including atlas entries
and legacy Sprite render data) found no native rotation value 4. The probes are
negative evidence, not #160 acceptance fixtures. [Unity's public 2019 enum](https://github.com/Unity-Technologies/UnityCsReference/blob/2019.4/Runtime/2D/Common/ScriptBindings/Sprites.bindings.cs)
contains 0, 1, 2, 3 and Any=15; the [Unity 6 API](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/SpritePackingRotation.html)
also has no named Rotate90. This does not prove serialized flag 4 is impossible,
but provides no verified editor recipe for generating it.

No new native probe was built during this oracle run. Keep #160 open until an
owned Unity build actually contains flag 4 and includes UV0/position direction
evidence and an independent AssetStudio pixel cross-check. Never force a flag
or relabel the existing synthetic rotation tests as native coverage.

## 16. Bounded native Rotate90 experiment (#160)

The [PR #221 instruction](https://github.com/fatal10110/unity-asset-reader/pull/221#issuecomment-5983270269)
requires native flag 4 before any direction verdict. On 2026-10-05 the installed
2019.4.41f2 legacy/V1 and 6000.6.4f1 V1/V2 packers were each run through these
six probe cases (24 total; some legacy settings repeat):

| Case | Requested atlas maximum (V1; V2 not applied) | Packing / imported mesh | Order |
| --- | --- | --- | --- |
| c0 | 64 | rectangle / FullRect | forward |
| c1 | 64 | tight / Tight | forward |
| c2 | 128 | tight / Tight | forward |
| c3 | 128 | tight / Tight | reverse |
| c4 | 256 | tight / Tight | forward |
| c5 | 256 | rectangle / FullRect | reverse |

For legacy packing, all cases use `TightRotateEnabledSpritePackerPolicy` and
separate case-specific packing tags. The rectangle/tight column describes the
imported mesh setting there; it does not select a different legacy policy.
V1 requests the listed atlas maximum and packing (rectangle for c0 and c5,
tight for the rest), with rotation enabled and padding 2, through `SpriteAtlas`'s
setters, and Unity applied them: V1 produced pages within the requested limits,
and 6000.6 V1's c0 and c5 entries are rectangle-packed (`settingsRaw` 3075).
The V2 builder (`AtlasV2` in the preparer) makes the same calls on a
`SpriteAtlasAsset`, where they do nothing in 6000.6 (#292, see the settings
check below). All six V2 cases were therefore packed with the same importer
defaults: tight packing, rotation enabled, padding 4, maximum size 2048,
Automatic compressed format, bilinear filtering. That is why V2 produced 128x256
or 256x128 pages even for the 64/128 requests, and why V2's c0 and c5 entries
are tight-packed (`settingsRaw` 3073, packing-mode bit 0). The V2 rows are six
image sets under one setting, not six settings.
Legacy uses the built-in policy without overriding its atlas maximum or padding:
the size in its case name is only a label. Its c1, c2 and c4 repeat the same
Tight/forward settings with separately imported images.
All image imports use Windows RGBA32, point filtering and no mipmaps.

Each case imports twelve asymmetric non-square images with dimensions
13x47, 47x13, 19x37, 37x19, 23x41, 41x23, 33x49, 49x33, 35x43, 43x35,
7x53 and 53x7. Pixels use section 12's coordinate-color recipe: R identifies
x, G identifies y, B identifies the image, and all corners have distinct R/G.
Rectangular cases are opaque; tight cases alternate opaque, Triangle and Ell
alpha shapes by image ID. Reverse cases reverse the import/add order. Image
imports allow 1024 pixels so the atlas experiment does not shrink inputs first.

Reproduce outside the repository (R2/R11), using the matching installed editor:

```text
python scripts/prepare-rotate90-experiment.py <external-unity-project>
Unity.exe -batchmode -nographics -quit -projectPath <external-unity-project> -executeMethod BuildRotationMatrix.Build -probeMode <legacy-or-v1-or-v2> -logFile <external-log>
```

Run legacy and V1 in 2019; V1 and V2 in 6000.6. The preparer guards the legacy
API removed in Unity 6 and does not change any serialized rotation flag.
It creates `Build/rotate-matrix-<mode>/sprites` and procedural source PNGs in
each external project. This is an experiment, **not a verified Rotate90 recipe**.

Read all four outputs through the independent oracle:

```text
<UnityPy-1.25.4-python> scripts/inspect-rotate90-experiment.py <external-2019-project> <external-6000-project>
```

`fixtures/rotate90-experiment.json` records every case and native entry's
`settingsRaw`, packed bit and rotation, plus editor versions, source dimensions,
builder hashes, bundle hashes and serialized formats. All four editor builds
completed successfully. The report also records each native atlas texture's actual dimensions. All
288 inspected entries were genuinely packed:

| Editor / packer | Rotation counts |
| --- | --- |
| 2019 legacy | 0:69, 1:1, 2:2 |
| 2019 V1 | 0:71, 2:1 |
| 6000.6 V1 | 0:70, 2:2 |
| 6000.6 V2 | 0:66, 1:1, 2:2, 3:3 |

No native flag 4 was found. The unsuccessful bundles remain external experiment
outputs, rather than being added as Rotate90 acceptance fixtures. No UV turn
verdict, AssetStudio Rotate90 pixel cross-check, or decoder direction change is
justified by these results. #160 stays open with its native-fixture requirement
unchanged. Existing forced-flag tests remain synthetic coverage. The public
rotation enum's lack of a named Rotate90 does not establish that native flag 4
is impossible; this result applies only to the bounded configurations above
(for V2, the importer defaults).

The separate [`codex/fixture-oracle-references` branch at `be60685`](https://github.com/fatal10110/unity-asset-reader/tree/be60685)
contains the prepared plain and half-scale variant pixel references. Those
references do not settle Rotate90. Its rectangle-only variant harness must not
be used as a tight-mask oracle.

### V2 atlas settings check (#292)

On 2026-11-08 a fresh 6000.6.4f1 project (`ProjectSettings/` and `Packages/` of
an empty project, one editor script, no images) saved four empty
`.spriteatlasv2` assets with `SpriteAtlasAsset.Save` and `ImportAsset`, then
logged each one's `SpriteAtlasImporter.packingSettings`, `textureSettings`,
`includeInBuild` and `GetPlatformSettings("DefaultTexturePlatform")` /
`("Standalone")`:

| Atlas | Set up with | Importer settings read back |
|---|---|---|
| A | nothing | rotation on, tight on, padding 4, block offset 1; bilinear, no mips, sRGB, aniso 1; include in build; both platforms not overridden, 2048, AutomaticCompressed |
| B | `AtlasV2`'s four `SpriteAtlasAsset` setters (c0: rectangle, padding 2, point, Standalone RGBA32 64) | identical to A |
| C | the V2 fixture builders' setters (`Atlas("packed", packed, false, true)`: also DefaultTexturePlatform Uncompressed 256, Standalone RGBA32 256) | identical to A |
| D | B's values through `SpriteAtlasImporter` (as the custom packer below) | tight off, padding 2, point, Standalone overridden RGBA32 64 |

So the `SpriteAtlasAsset` setters were no-ops and the route that applies is
`SpriteAtlasImporter`, set after the first import and followed by
`SaveAndReimport()`. No committed bundle was rebuilt.

### Custom ScriptablePacker (maintainer-approved route, 2026-11-08)

After the 24 configurations above, the
[maintainer decision on #160](https://github.com/fatal10110/unity-asset-reader/issues/160)
approved one more route: a custom Sprite Atlas V2 `ScriptablePacker` whose
`Pack()` returns `SpritePack.rot = (PackTransform)4`. The public
`PackTransform` enum ends at `Rotate180 = 3`, so 4 is a value it does not
list; Unity's own native code still blits the atlas and writes `settingsRaw`,
so nothing is edited after the build. On 2026-11-08 it was built once in a
fresh 6000.3.26f1 project and once in a fresh 6000.6.4f1 project, each holding
only these two files in `Assets/Editor/` (plus `ProjectSettings/` and
`Packages/` of an empty project of the same editor):

```csharp
using UnityEditor.U2D;
using UnityEngine;

// #160: a custom Sprite Atlas V2 packer. Each sprite gets its own 128x128 cell,
// its origin at the cell's centre, so it stays inside the cell whichever way
// Unity turns it about any of its corners. Sprites taller than wide are returned
// with PackTransform 4, a value the public enum does not list (it ends at
// Rotate180 = 3; SpritePackingRotation names 4 Rotate90). The wide ones are the
// control: the listed values FlipHorizontal, FlipVertical and Rotate180 (and
// None for 49x33). Unity's native code then blits the atlas, writes the UVs and
// writes settingsRaw; nothing is edited after the build.
public class Rotate90Packer : ScriptablePacker
{
    public const int Cell = 128;

    public override bool Pack(SpriteAtlasPackingSettings config, SpriteAtlasTextureSettings setting, PackerData input)
    {
        for (int i = 0; i < input.spriteData.Length; i++)
        {
            var sprite = input.spriteData[i];
            var rot = sprite.rect.height > sprite.rect.width ? (PackTransform)4 : Control(sprite.rect.width);
            sprite.output = new SpritePack { x = (i % 4) * Cell + Cell / 2, y = (i / 4) * Cell + Cell / 2, page = 0, rot = rot };
            input.spriteData[i] = sprite;
            Debug.Log("PACKER-OUT " + sprite.guid + " rect=" + sprite.rect + " tex=" + sprite.texIndex
                      + " -> " + sprite.output.x + "," + sprite.output.y + " rot=" + (int)rot);
        }
        return true;
    }

    static PackTransform Control(int width)
    {
        switch (width)
        {
            case 47: case 43: return PackTransform.FlipHorizontal;
            case 37: case 53: return PackTransform.FlipVertical;
            case 41: return PackTransform.Rotate180;
            default: return PackTransform.None;
        }
    }
}
```

```csharp
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.U2D;
using UnityEngine;
using UnityEngine.U2D;

// #160: twelve asymmetric self-describing images (section 12 recipe and
// section 16 dimensions) in one Sprite Atlas V2 packed by Rotate90Packer.
public static class BuildPackerProbe
{
    const string Dir = "Assets/Fixtures/packer";

    public static void Build()
    {
        EditorSettings.spritePackerMode = SpritePackerMode.SpriteAtlasV2;
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "packer");
        var packerPath = Dir + "/Rotate90Packer.asset";
        AssetDatabase.DeleteAsset(packerPath);
        var packer = ScriptableObject.CreateInstance<Rotate90Packer>();
        AssetDatabase.CreateAsset(packer, packerPath);

        var dimensions = new int[,] { { 13, 47 }, { 47, 13 }, { 19, 37 }, { 37, 19 }, { 23, 41 }, { 41, 23 },
                                      { 33, 49 }, { 49, 33 }, { 35, 43 }, { 43, 35 }, { 7, 53 }, { 53, 7 } };
        var sprites = new List<Object>();
        for (int id = 0; id < 12; id++)
        {
            var shape = id % 3 == 0 ? Shape.Full : id % 3 == 1 ? Shape.Triangle : Shape.Ell;
            var path = Png("t" + id.ToString("D2"), dimensions[id, 0], dimensions[id, 1], id + 1, shape,
                           shape == Shape.Full ? SpriteMeshType.FullRect : SpriteMeshType.Tight, new Vector2(0.3f, 0.6f));
            sprites.Add(AssetDatabase.LoadAssetAtPath<Texture2D>(path));
        }

        var atlasPath = Dir + "/turned.spriteatlasv2";
        AssetDatabase.DeleteAsset(atlasPath);
        var atlas = new SpriteAtlasAsset();
        atlas.Add(sprites.ToArray());
        atlas.SetScriptablePacker(packer);
        SpriteAtlasAsset.Save(atlas, atlasPath);
        AssetDatabase.ImportAsset(atlasPath);
        var importer = (SpriteAtlasImporter)AssetImporter.GetAtPath(atlasPath);
        importer.packingSettings = new SpriteAtlasPackingSettings { enableRotation = true, enableTightPacking = true, padding = 2, blockOffset = 1 };
        importer.textureSettings = new SpriteAtlasTextureSettings { readable = false, generateMipMaps = false, sRGB = true, filterMode = FilterMode.Point };
        importer.SetPlatformSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true, maxTextureSize = 1024, format = TextureImporterFormat.RGBA32 });
        importer.includeInBuild = true;
        importer.SaveAndReimport();

        AssetDatabase.SaveAssets();
        SpriteAtlasUtility.PackAllAtlases(BuildTarget.StandaloneWindows64);
        Debug.Log("FIXTURE-ASSET " + atlasPath);

        var dir = Path.Combine("Build", "packer");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "sprites", assetNames = new[] { atlasPath } } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.ChunkBasedCompression,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: packer");
        Debug.Log("FIXTURE-OK sprite -> " + dir);
    }

    enum Shape { Full, Triangle, Ell }

    // Section 12's recipe: R = 5x + 3, G = 5y + 5 (y from the bottom), B = 16 id + 7,
    // alpha 255 inside the shape and 0 outside, colour kept outside too.
    static Color32[] Pixels(int w, int h, int id, Shape shape)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                float u = (x + 0.5f) / w, v = (y + 0.5f) / h;
                bool inside = shape == Shape.Full || (shape == Shape.Triangle ? v <= u : u < 0.4f || v < 0.4f);
                px[y * w + x] = new Color32((byte)(x * 5 + 3), (byte)(y * 5 + 5), (byte)(id * 16 + 7), (byte)(inside ? 255 : 0));
            }
        return px;
    }

    // A PNG imported as one uncompressed RGBA32 sprite, as section 12's Png does.
    static string Png(string name, int w, int h, int id, Shape shape, SpriteMeshType mesh, Vector2 pivot)
    {
        var path = Dir + "/" + name + ".png";
        var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
        tex.SetPixels32(Pixels(w, h, id, shape));
        File.WriteAllBytes(path, tex.EncodeToPNG());
        AssetDatabase.ImportAsset(path);
        var imp = (TextureImporter)AssetImporter.GetAtPath(path);
        imp.textureType = TextureImporterType.Sprite;
        imp.spriteImportMode = SpriteImportMode.Single;
        imp.alphaIsTransparency = false;
        imp.mipmapEnabled = false;
        imp.filterMode = FilterMode.Point;
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.spritePixelsPerUnit = 8f;
        var settings = new TextureImporterSettings();
        imp.ReadTextureSettings(settings);
        settings.spriteMeshType = mesh;
        settings.spriteAlignment = (int)SpriteAlignment.Custom;
        settings.spritePivot = pivot;
        settings.spriteExtrude = 1;
        imp.SetTextureSettings(settings);
        imp.SetPlatformTextureSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true, format = TextureImporterFormat.RGBA32, maxTextureSize = 1024 });
        imp.SaveAndReimport();
        return path;
    }
}
```

The twelve images are the dimensions and pixel recipe listed above, named
`t00` to `t11` by `id`, with Full/FullRect, Triangle/Tight and Ell/Tight
alternating by `id % 3`. The packer returns 4 for the six tall ones and the
listed values as a control for the wide ones (47x13 and 43x35 FlipHorizontal,
37x19 and 53x7 FlipVertical, 41x23 Rotate180, 49x33 None). The atlas settings
go through `SpriteAtlasImporter`, the route that applies; `SpriteAtlasAsset`'s
setters do nothing (settings check above).

```text
Unity.exe -batchmode -nographics -quit -projectPath <external-unity-project> -executeMethod BuildPackerProbe.Build -logFile <external-log>
<UnityPy-1.25.4-python> scripts/inspect-rotate90-experiment.py --scriptable-packer <external-6000.3-project> <external-6000.6-project>
```

The second command checks that each project's two files equal the blocks
above, reads `Build/packer/sprites` and writes `scriptablePackerProbes` in
`fixtures/rotate90-experiment.json`, leaving the 24 probes above unchanged.

**Result: negative in both editors.** Unity neither rejected the packer nor
warned: `Pack()` ran (twice per build, at import and in `PackAllAtlases`), the
build logged `FIXTURE-OK sprite`, and every sprite sits at the `x`/`y` the
packer returned. But the native side dropped the transform for every sprite,
including the listed control values: its own placement log prints rotation 0
for all twelve right after `Pack()`, all 24 built entries have `settingsRaw`
rotation 0, and every opaque atlas pixel inside each `textureRect` holds its
own source position (`everyOpaquePixelUnturned`), so nothing was turned or
flipped. A first 6000.3.26f1 build, whose packer returned 4 for the tall
images and None for the wide ones (no control), gave the same all-zero result.
In these editors `SpritePack.rot` is not applied at all, so a custom packer
cannot produce a native Rotate90 (or any packing transform). No bundle is
committed, `unpack` in `sprite.ts` keeps AssetStudio's Rotate90 direction, and the
forced-flag tests remain the only Rotate90 coverage.

## 17. Export goldens: the AssetStudio harness (#233)

Export output (Texture2D and Sprite PNGs, OBJ, WAV, TextAsset files, shader text, font and
video files, animation curves) has its own oracle: AssetStudio
itself, the behavior source of truth, at revision
`c37af7dfcdafee93e33b5da9f0285c97998d6ae3`, executed outside the repository
(plan section 5, R12). UnityPy stays the oracle for parsing and names the
inputs. One command regenerates `fixtures/assetstudio-export-goldens.json` from
a clean clone; no Unity, no fixture rebuild:

```text
git clone https://github.com/Razviar/assetstudio.git <external-source>
git clone https://github.com/aras-p/smol-v.git <external-smolv>
python3 -m venv .venv-oracle && .venv-oracle/bin/pip install UnityPy==1.25.3
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
npm run verify
```

`<modern-oracle>` is section 13's UnityPy 1.25.4 environment; it reads the type
trees of the shaders of step 4c (#259).
`<external-source>` needs only to hold the revision (any checkout state: the
script extracts the revision's tree with `git archive` and checks its tree id).
`<external-smolv>` likewise needs to hold aras-p/smol-v
`6303e979b59153ee7007fd14e06d3fed8687b64c` (MIT or Unlicense); the script takes
`source/smolv.cpp` and `smolv.h` from that revision's tree, checked by its id.
`<external-harness>` is a scratch directory outside this checkout; the script
refuses one inside it (R2). It takes about a minute, and needs network access
for the first NuGet restore.

Requirements: the `.venv-oracle` (UnityPy 1.25.3, created above), `<modern-oracle>`
(UnityPy 1.25.4), `g++` (C++11,
in the shell running the script; WSL's does) and a **Windows .NET 8 SDK**. AssetStudio's texture decoder package
(`Kyaru.Texture2DDecoder.Windows`) and the FMOD library it ships are Windows
builds. From WSL, pass the Windows `dotnet.exe`, for example
`--dotnet "/mnt/c/Program Files/dotnet/dotnet.exe"`, and a `--project` under
`/mnt/c/...`; paths are handed over with `wslpath`.

What it does, all inside `<external-harness>`:

1. Extracts the AssetStudio tree, writes a small C# console project that
   references the unmodified `AssetStudio.CLI` project (and through it
   `AssetStudio`, `AssetStudio.Utility`), restores it from nuget.org only into
   its own package folder, checks every restored `.nupkg` against the SHA-512
   pinned in the script, and builds the `net8.0-windows` side.
2. Copies FMOD from the tree (`AssetStudio.GUI/Libraries/x64/fmod.dll`, sha256
   pinned in the script) to where the GUI ships it, `x64/fmod.dll` next to the
   executable. FMOD is under FMOD's own license; it stays in the external
   directory and is never committed. No FMOD account or download is involved.
3. Lists every Texture2D, Mesh, Shader, TextAsset, AnimationClip, AudioClip, Sprite, Font and VideoClip of
   `goldens.json` and
   `modern-goldens.json`, with the input metadata UnityPy recorded for it, and
   copies each bundle into its own folder (AssetStudio scans the folder of what
   it loads).
4. Runs the harness twice. Per bundle it loads the file with AssetStudio's
   `AssetsManager` (`SpecifyUnityVersion`, the CLI's `--unity_version`, set to
   the editor in the fixture's path, which the version-stripped bundles need),
   then for each object: Texture2D `Exporter.ExportTexture2D(item, dir,
   ImageFormat.Png)` of `AssetStudio.CLI`, PNG decoded back to RGBA8; Sprite
   `Exporter.ExportSprite(item, dir, ImageFormat.Png)`, which writes
   `Sprite.GetImage()` (#275), PNG decoded back the same way; Mesh
   `Exporter.ExportMesh(item, dir)`, the `.obj` file; AudioClip
   `AudioClipConverter.ConvertToWav()`; TextAsset
   `Exporter.ExportTextAsset(item, dir)`, the file it writes (`m_Script` as
   is); Shader `Exporter.ExportShader(item, dir)`, the `.shader` file
   `ShaderConverter.Convert()` writes (#242), except for a shader with Direct3D
   programs (D3D9, D3D11, D3D11_9x): ShaderConverter turns those into text
   with Windows' D3DCompiler or the GUI's native HLSLDecompiler, which the
   harness does not ship, so the text would depend on the host, and
   unity-asset-reader-shader refuses them; Font `Exporter.ExportFont(item, dir)`,
   `m_FontData` as is, `.otf` when it starts with `OTTO`, else `.ttf` (#277);
   VideoClip `Exporter.ExportVideoClip(item, dir)`, the video bytes as is,
   read from the `.resource` node of the same bundle that `m_ExternalResources`
   names, with the extension of `m_OriginalPath` (#277); AnimationClip
   `Exporter.ExportAnimationClip(item, dir)` (#304), which calls
   `AnimationClipExtensions.Convert()`: it decodes `m_MuscleClip`, names the
   path hashes through `FindTOS` over the loaded files (this bundle's Avatars
   and Animators), merges the legacy curves into the clip's curve lists and
   writes those as YAML. The `.anim`'s size and sha256 are a check only; the
   harness then dumps the clip's curve lists and `m_Events` as Convert() left
   them, every float as its float32 bits (the YAML is not parsed: .NET 8 under
   en-US writes an infinite slope as the infinity sign), and the objects of
   the clip's file AssetStudio failed to read. The exporters run on
   en-US, the culture the GUI's export thread sets
   (the CLI would use the host's, which changes the OBJ's numbers).
   Vulkan programs in SMOL-V encoding version 1 get the hybrid text of step 4b.
4b. Vulkan programs (#260, plan section 5 revision 2026-11-07c). Unity 2020.3
   writes SMOL-V encoding version 1 (header version word `0x01010000`), which
   AssetStudio's decoder (a C# port of smol-v's 2016-08-31 code) predates: its
   text for those programs is `// disassembly error Unable to decode SMOL-V
   shader`. Before the two runs, a dump run of the harness writes each Vulkan
   stage's SMOL-V bytes to `<external-harness>/stages`, with the words
   AssetStudio's `SmolvDecoder` gives for encoding version 0. The script builds
   smol-v's decoder with `g++ -O2 -std=c++11` (`smolv.cpp` and a small `main`
   the script writes, in `<external-harness>/smolv`) and runs it: encoding 0
   with `kDecodeFlagUse20160831AsZeroVersion`, which must give AssetStudio's
   words for every stage or the run stops (all 11 distinct 2019.4 stages
   agree); later encodings with no flags. In the two runs, after
   `ExportShader`, each SPIR-V program with a stage of version 1 gets its text
   from AssetStudio's own CSspv disassembler (`SpirV.Module.ReadFrom`,
   `Disassembler`) on smol-v's words, framed as `SpirVShaderConverter.Convert`
   and `ShaderSubProgram.Export` frame it, in place of AssetStudio's error
   line. A stage CSspv cannot read keeps its `// disassembly error` line; no
   fixture stage hits one.
4c. Shaders with variants in `m_PlayerSubPrograms` (#259, plan section 5
   revision 2026-11-08a): `c37af7d` skips every 6000+ Shader and its
   converter reads only `m_SubPrograms`, so these get the composite oracle
   instead of `ExportShader`, in the same runs. The script's
   `--player-programs` mode, under `<modern-oracle>`, reads each Shader's type
   tree; the harness fills AssetStudio's own `SerializedShader` with it by
   field name, turns each distinct (`m_BlobIndex`, `m_GpuProgramType`) of a
   stage's `m_PlayerSubPrograms` (its groups in order, where it first
   appears) into one `SerializedSubProgram` of tier 0 after `m_SubPrograms`,
   reads the blob entries those name with `ShaderSubProgram(reader, false)`
   (the others are parameter entries, `m_ParameterBlobIndices`), and calls
   `ShaderConverter.ConvertSerializedShader`; Vulkan programs then get step
   4b's text. The entry carries `oracle`, and its `input` is UnityPy 1.25.4's.
   The `shader-variants` bundles (section 18, #283) give it stages with
   several variants, repeated across groups.
5. Keeps an object's output only if AssetStudio read the same input as UnityPy:
   name, object size, the object bytes' sha256 (UnityPy 1.25.3, where it reads
   the fixture), texture format, size and image data hash, audio, font and video
   data size and hash (where `goldens.json` records the raw data), TextAsset
   script size and hash (from the type tree dump, where there is one).

Each entry in the JSON is keyed like the goldens (fixture, SerializedFile,
pathId) and holds `input` (the metadata it was matched on) and one of `png`
(`width`, `height`, `rgbaSha256` of the decoded pixels in the PNG's row order,
**top row first**, plus the PNG file's own size and hash), `obj`, `wav`,
`bytes` or `shader` (`size`, `sha256` of the file; for a shader with Vulkan
programs also `spirv`, each stage by the sha256 of its SMOL-V bytes with its
`encoding` version and the `size` and `sha256` of its SPIR-V, or the `error`
that stops it), `font` or `video` (`size`,
`sha256` and `extension` of the file), `anim` (`size` and `sha256` of the
`.anim` file; `curves`, by kind `rotation`, `euler`, `position`, `scale`,
`float` and `pptr`, each curve's `path`, a float or PPtr curve's `attribute`
and `classId`, and its `keys`: for a PPtr curve each key's `time` bits and
`value` pointer, otherwise one hex string, per key its time, then the value's,
the in slope's and the out slope's components, each float32's bits as 8 hex
digits; `compressedRotationCurves`, their count, written to the `.anim` as they
are; `events`, each field of `m_Events`, floats as bits), or `exportError`. An
AnimationClip entry has `unreadObjects` when AssetStudio failed to read objects
of its file (by class). A skinned Mesh also
has `skin`: the `boneWeights` (float32 bits) and `boneIndices` of each vertex
in c37af7d's `m_Skin`:

| Objects | Golden | Why not |
| --- | --- | --- |
| 53 Mesh (`main` bundles; `mesh` bundles, section 20; the `scene` skinned mesh and the `legacy-animation` quad, sections 24 and 25) | 43 OBJ; the skinned ones also their decoded `m_Skin` (`skin`, #285) | 4 in the typed 6000.6 `mesh-skinned`, `scene` and `legacy-animation` bundles: `c37af7d` cannot read SerializedFile format 23's type trees. 6 `basevertex` (section 20): `ExportMesh` writes the indices without their submesh's `baseVertex`, which unity-asset-reader adds (#257). Not a golden, so the entry holds an `exportError` and that OBJ's size and hash as `objWithoutBaseVertex` |
| 51 AudioClip (`audio`, `adpcm` and `audiohdr` bundles, section 11) | 51 WAV | |
| 32 TextAsset | 32 files | |
| 9 Font (`font` bundles, section 11) | 9 `.ttf` files, each `glyphs.ttf` to the byte | |
| 9 VideoClip (`video` bundles, section 11) | 9 `.webm` files, each `clip.webm` to the byte | |
| 160 AnimationClip (`animation`, `animator`, `scene`, `legacy-animation` and `ui-animation` bundles, sections 22 to 26) | 122 curve dumps: every clip of 2019.4, 2020.3 and 6000.3.26f1, typed and not; 6 with a `verdict` (below); and 6000.6.4f1's `legacy` and `dense` without type trees | The other 38 of the 40 in the 6000.6 bundles: with type trees `c37af7d` cannot read format 23; without them it reads the clips without `GenericBinding.metaData` (6000.5), so the bindings come out misread and `Convert()` throws (`ArgumentException`), or the object does not load. The two it exports have no binding or one whose misreading changes nothing, and match |
| 42 Shader (`shader` and `shader-variants` bundles, section 18) | 23 `.shader` texts: 12 by `ExportShader`, the 2019.4 and 2020.3 Android and iOS ones; 11 by the composite of step 4c, `UAR/ShaderFixtureSecond` of the 6000.3.26f1 Android and iOS and the 6000.6.4f1 Android `shader` bundles, and both shaders of the three `shader-variants` bundles (#283). The Vulkan programs of the 2020.3 and 6000.x Android ones from the hybrid of step 4b | 14 Windows ones: Direct3D 11, not exported (see step 4). 5 `UAR/ShaderFixture` of 6000.x Android and iOS: its `Int` property `_Count` makes `ConvertSerializedShader` throw `ArgumentOutOfRangeException` |
| 127 Sprite (section 12's `sprite` and the `legacy-probe`, `rotation-probe`, `split-alpha` and `variant` bundles of section 14) | 112 PNG, every 2019.4.41f2 and 6000.3.25f1 one; 19 with a `verdict` (below) | 15 in the 6000.6 bundles: SerializedFile format 23 |
| 148 Texture2D | 105 PNG | 29 in the 6000.6 bundles: `c37af7d` cannot read SerializedFile format 23 at all. 9 dynamic-font "Font Texture"s: 0x0, no image data (`ExportTexture2D` returns false). 5 in formats 66 to 74 (ASTC_HDR_4x4, ASTC_HDR_12x12, RG32, RGB48, RGBA64): AssetStudio's `TextureFormat` enum has an extra `R16_Alt` at 66, so from there on it names and decodes the next format (Unity's RG32, 72, as ASTC_HDR_12x12) |

For RG32, RGB48 and RGBA64 the method-level references of sections 13 and 15,
which call the right `Decode*` method by name, stay the AssetStudio verdict.
The harness also exports every texture and sprite twice, over a decode buffer
filled with 0x00 and then with 0xFF (`ConvertToImage` decodes into a pooled
buffer; for a sprite, the buffer of the texture `GetImage()` cuts it from), and
compares the two runs: pixels a decoder leaves unwritten, or output that
changes between runs, get an `exportError` instead of a golden. On these
fixtures that only ever hit the misnumbered ASTC_HDR_4x4 (decoded as `R16_Alt`).

`packages/texture/tests/sprite-export.test.ts` compares each Sprite PNG with
`decodeSprite(..., { tightMesh: true })`, which is `GetImage()`. Where
unity-asset-reader-texture differs from `GetImage()` by design, the script
writes a `verdict` next to the golden, and the test compares the golden with
what `GetImage()` cuts instead and asserts the difference:

| Sprites | `GetImage()` | `decodeSprite` | Compared with the golden |
| --- | --- | --- | --- |
| 17 of `split-alpha`, cut from an ETC1 texture with an alpha texture (`alphaTexture` in the entry) | cuts the texture alone, never reads its alpha texture (`SpriteHelper.cs:15-34`) | merges the alpha texture first (#152): same red, green and blue, the alpha texture's red as alpha | `cutSprite` of the base texture alone |
| `r_a`, `r_b` of `variant`, whose own `m_SpriteAtlas` is the variant atlas `half` (`variantAtlas`) | `AssetsManager` moves the sprite to the master atlas `rect` that packs it (`AssetsManager.cs:1060-1085`), so it cuts the full-size master texture | follows the sprite's own pointer and cuts the variant, resized as `CutImage` resizes it (#153; section 15's `CutImage` of the variant entries is its reference) | `cutSprite` of the master atlas entry |

`packages/animation/tests/goldens.test.ts` compares each AnimationClip's dump
with `clipCurves()`, float32 bit for bit. The 6000.3.26f1 `scene` bundles'
`smile` clips and `legacy-animation` bundles' `walk` clips, typed and not, have
a `verdict`: `c37af7d`'s Renderer reader
lacks fields Unity 6000 writes and fails on their SkinnedMeshRenderer
(`unreadObjects`), so `CustomCurveResolver` finds no renderer and writes the
blend shape attributes as their CRC-32 (`blendShape.42599183`), where
unity-asset-reader reads the renderer and names them (`blendShape.smile`); the
test hashes the names back and compares the rest. Every 2019.4 and 2020.3
`smile` and `walk` names them as unity-asset-reader does. A clip nothing plays
gets no verdict: its curves keep `path_<hash>`, and their attributes stay
CRC-32s with the renderer read too (the `legacy-animation` bundles' `unlisted`).
The 6000.3.26f1 `ui-animation` bundles' `ui` clips have the other `verdict`:
`c37af7d` misreads their Avatar-less `Animator` as having no transform
hierarchy (section 26), so it names none of their paths; the test hashes the
names back. 6000.6.4f1 has no other oracle:
`packages/animation/tests/cross-editor.test.ts` holds each of its clips to the
2019.4 one, as it does the 2020.3 and 6000.3 ones (object references compared
by the name of the object they reach; the one documented difference is the
`mixed` clip's 6000.x coefficients, a float32 step off 2019.4's, which change
one in slope).

Checks that need no AssetStudio run, in `scripts/tests/export-goldens.test.ts`:
every PCM clip exports to `tone.wav` of section 11 to the byte, every `hello`
TextAsset to `hello.txt` of section 1, and the RG16
PNG equals section 15's executed `DecodeRG16`, turned top-down.

Section 15's script stays as it is: it executes single pinned methods
(`CutImage`'s rectangle path, the plain decoders by name) that the full
exporter cannot reach or misnumbers.

## 18. The `shader` bundles (#237)

Two shaders of our own, built by **2019.4.41f2**, **2020.3.30f1**,
**6000.3.26f1** and **6000.6.4f1**, each target with and without type trees:
`shader/lz4/<target>` and `shader/lz4-notypetree/<target>`, `<target>` being:

| Target | Build target | Graphics APIs (`platforms`) | Editors |
|---|---|---|---|
| `windows` | `StandaloneWindows64` | Direct3D 11 (`D3D11`, 4) | all four |
| `android` | `Android` | OpenGL ES 3 and Vulkan (`GLES3Plus`, 9; `Vulkan`, 18) | all four |
| `ios` | `iOS` | Metal (`Metal`, 14) | 2020.3.30f1, 6000.3.26f1 |

Each bundle holds `UAR/ShaderFixture`, `UAR/ShaderFixtureSecond` and the
AssetBundle. The first shader declares every kind of property and attribute,
two sub-shaders (the second a fallback for hardware without geometry
shaders), render state of every kind, a `GrabPass`, a `UsePass`, keywords
(`multi_compile`, `shader_feature_local`, instancing), a geometry stage,
constant buffers, an instancing buffer (whose array of structs is the struct
parameter), a structured buffer, a UAV, separate and inline samplers, a
`Dependency`, a `CustomEditor` and a `Fallback`. The second is the first's
fallback, dependency and `UsePass` target.

Metal comes from the editors that have the iOS module, 2020.3.30f1 and
6000.3.26f1; 2019.4.41f2 and 6000.6.4f1 have none and log `FIXTURE-SKIP` for
`ios`. No editor here has the macOS module, so `osx` is skipped everywhere.
The Unity 6000.3 build is **6000.3.26f1**, not the 6000.3.25f1 of the other
fixtures: 6000.3.25f1 was no longer installed. Both write SerializedFile
format 22 and the same Shader layout (TPK: 6000.3.0b6 to 6000.5.0a5).

What a build holds differs by editor: 2019.4 and 2020.3 list every variant
with its parameters in each stage's `m_SubPrograms`; 6000.3 and 6000.6 leave
those empty and list the variants a player uses in `m_PlayerSubPrograms`,
their parameters in the blob. 2020.3 is the one fixture editor whose passes
carry `m_EditorDataHash`, `m_Platforms` and the two keyword masks (#52).

Any project will do; the committed bundles came from a fresh one per editor
holding only these files:

```
<project>/Assets/Fixtures/shader/uar-fixture.shader
<project>/Assets/Fixtures/shader/uar-second.shader
<project>/Assets/Editor/BuildShaders.cs
```

`uar-fixture.shader` is the template below with three lines filled in per
editor. For 2019.4.41f2: `INT_TYPE` is `Int` (a float property; Unity 2021.1
added `Integer`), and the `CONSERVATIVE` and `RP_EDITOR` lines are deleted.
For 2020.3.30f1: `INT_TYPE` is `Int`, `CONSERVATIVE` is `Conservative True`
(2020.1+), and the `RP_EDITOR` line is deleted. For 6000.3.26f1 and
6000.6.4f1: `INT_TYPE` is `Integer`, `CONSERVATIVE` is
`Conservative True` (2020.1+), and `RP_EDITOR` is
`CustomEditorForRenderPipeline "UarUrpShaderGUI" "UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset"`
(2021.1+; Unity leaves it out of the bundle, as the project has no such
pipeline).

```shaderlab
// Shader reader fixture (#237): every kind of property, attributes, two
// subshaders, render state, a GrabPass, a UsePass, keywords, instancing, a
// geometry stage, constant buffers, an instancing buffer (a struct), buffers,
// a UAV, separate and inline samplers, a dependency, a custom editor and a
// fallback.
// INT_TYPE, CONSERVATIVE and RP_EDITOR are filled in per editor.
Shader "UAR/ShaderFixture"
{
    Properties
    {
        [MainTexture] _MainTex ("Main", 2D) = "white" {}
        [NoScaleOffset] _Detail ("Detail", 2D) = "gray" {}
        [Normal] _BumpMap ("Bump", 2D) = "bump" {}
        _Volume ("Volume", 3D) = "" {}
        _Cube ("Cube", Cube) = "" {}
        _Layers ("Layers", 2DArray) = "" {}
        [MainColor] _Color ("Color", Color) = (1, 0.5, 0.25, 1)
        [HDR] _Emission ("Emission", Color) = (2, 1, 0, 1)
        _Offsets ("Offsets", Vector) = (1, 2, 3, 4)
        _Gloss ("Gloss", Range(0, 1)) = 0.5
        [Header(Options)] [Toggle(UAR_FEATURE)] _Feature ("Feature", Float) = 0
        [HideInInspector] _Hidden ("Hidden", Float) = -1.5
        [PerRendererData] _PerRenderer ("PerRenderer", Float) = 2
        [Gamma] _GammaVal ("Gamma", Float) = 0.25
        _Count ("Count", INT_TYPE) = 3
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 2
        _StencilRef ("Stencil Ref", Range(0, 255)) = 7
    }
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" }
        LOD 300
        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "ForwardBase" }
            Blend SrcAlpha OneMinusSrcAlpha, One Zero
            BlendOp Add, Max
            ColorMask RGB
            ZWrite Off
            ZTest LEqual
            Cull [_Cull]
            Offset -1, -2
            AlphaToMask On
            Stencil
            {
                Ref [_StencilRef]
                ReadMask 15
                WriteMask 240
                Comp Always
                Pass Replace
                Fail Keep
                ZFail IncrSat
            }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.5
            #pragma multi_compile __ UAR_MULTI_A
            #pragma shader_feature_local UAR_FEATURE
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"

            UNITY_DECLARE_TEX2D(_MainTex);
            float4 _MainTex_ST;
            UNITY_DECLARE_TEX2D_NOSAMPLER(_Detail);
            sampler3D _Volume;
            samplerCUBE _Cube;
            UNITY_DECLARE_TEX2DARRAY(_Layers);
            fixed4 _Color;
            half4 _Emission;
            float4 _Offsets;
            float _Gloss;
            float4x4 _UarMatrix;
            float4 _UarArray[3];
            UNITY_INSTANCING_BUFFER_START(UarProps)
                UNITY_DEFINE_INSTANCED_PROP(float4, _UarInstColor)
                UNITY_DEFINE_INSTANCED_PROP(float4x4, _UarInstXform)
            UNITY_INSTANCING_BUFFER_END(UarProps)

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float3 normal : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 normal : TEXCOORD1;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            v2f vert(appdata v)
            {
                UNITY_SETUP_INSTANCE_ID(v);
                v2f o;
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                float4x4 m = mul(_UarMatrix, UNITY_ACCESS_INSTANCED_PROP(UarProps, _UarInstXform));
                o.pos = UnityObjectToClipPos(mul(m, v.vertex));
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                o.normal = UnityObjectToWorldNormal(v.normal);
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);
                fixed4 c = UNITY_SAMPLE_TEX2D(_MainTex, i.uv) * _Color;
                c *= UNITY_ACCESS_INSTANCED_PROP(UarProps, _UarInstColor);
                c += UNITY_SAMPLE_TEX2D_SAMPLER(_Detail, _MainTex, i.uv) * _Gloss;
                c += tex3D(_Volume, i.normal) + texCUBE(_Cube, i.normal);
                c += UNITY_SAMPLE_TEX2DARRAY(_Layers, float3(i.uv, _Offsets.w));
            #if UAR_MULTI_A
                c.rgb += _Emission.rgb;
            #endif
            #ifdef UAR_FEATURE
                c *= _Offsets;
            #endif
                c += _UarArray[(int)_Offsets.x];
                return c;
            }
            ENDCG
        }
        GrabPass { "_UarGrab" }
        Pass
        {
            Name "Geometry"
            Tags { "LightMode" = "Always" }
            Blend 0 One One
            Blend 1 Zero SrcColor
            ZClip False
            CONSERVATIVE
            CGPROGRAM
            #pragma vertex vert
            #pragma geometry geom
            #pragma fragment frag
            #pragma target 5.0
            #include "UnityCG.cginc"

            cbuffer UarLights
            {
                float4x4 _UarXform;
                float4 _UarColors[2];
                float4 _UarTint;
            };
            StructuredBuffer<float4> _UarPoints;
            RWStructuredBuffer<float4> _UarOut : register(u1);
            Texture2D _UarGrab;
            SamplerState sampler_point_clamp;

            struct v2g
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            v2g vert(appdata_base v)
            {
                v2g o;
                o.pos = UnityObjectToClipPos(mul(_UarXform, v.vertex));
                o.uv = v.texcoord.xy;
                return o;
            }

            [maxvertexcount(3)]
            void geom(triangle v2g input[3], inout TriangleStream<v2g> stream)
            {
                for (int k = 0; k < 3; k++)
                {
                    v2g o = input[k];
                    o.pos.xy += _UarPoints[k].xy;
                    stream.Append(o);
                }
            }

            float4 frag(v2g i) : SV_Target
            {
                float4 c = _UarGrab.Sample(sampler_point_clamp, i.uv) * _UarColors[1] * _UarTint;
                _UarOut[0] = c;
                return c;
            }
            ENDCG
        }
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        LOD 100
        Pass
        {
            Tags { "LightMode" = "ForwardBase" }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            fixed4 _Color;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return _Color; }
            ENDCG
        }
        UsePass "UAR/ShaderFixtureSecond/UNLIT"
    }
    Dependency "UarDependency" = "UAR/ShaderFixtureSecond"
    CustomEditor "UarShaderGUI"
    RP_EDITOR
    Fallback "UAR/ShaderFixtureSecond"
}
```

`uar-second.shader`:

```shaderlab
// The second shader of the #237 fixture: the first one's fallback, dependency
// and UsePass target.
Shader "UAR/ShaderFixtureSecond"
{
    Properties
    {
        _Color ("Color", Color) = (0, 1, 0, 1)
    }
    SubShader
    {
        Pass
        {
            Name "Unlit"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            fixed4 _Color;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return _Color; }
            ENDCG
        }
    }
    Fallback Off
}
```

`Assets/Editor/BuildShaders.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

// The two fixture shaders (#237), built once per target and graphics API set:
// with type trees, and without for the targets the reader must handle alone.
// A target whose build module is not installed is skipped and logged.
public static class BuildShaders
{
    const string Dir = "Assets/Fixtures/shader";
    static readonly string[] Shaders = { Dir + "/uar-fixture.shader", Dir + "/uar-second.shader" };

    public static void Build()
    {
        // Keep the instancing variants, whose instancing buffer is the one place
        // a struct parameter appears; no material asks for instancing here.
        var graphics = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset")[0]);
        graphics.FindProperty("m_InstancingStripping").intValue = 2; // Keep All
        graphics.ApplyModifiedProperties();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        var noTree = lz4 | BuildAssetBundleOptions.DisableWriteTypeTree;
        var dx11 = new[] { GraphicsDeviceType.Direct3D11 };
        var mobile = new[] { GraphicsDeviceType.OpenGLES3, GraphicsDeviceType.Vulkan };
        var metal = new[] { GraphicsDeviceType.Metal };
        Emit("windows", BuildTarget.StandaloneWindows64, dx11, lz4);
        Emit("windows-notypetree", BuildTarget.StandaloneWindows64, dx11, noTree);
        Emit("android", BuildTarget.Android, mobile, lz4);
        Emit("android-notypetree", BuildTarget.Android, mobile, noTree);
        Emit("ios", BuildTarget.iOS, metal, lz4);
        Emit("ios-notypetree", BuildTarget.iOS, metal, noTree);
        Emit("osx", BuildTarget.StandaloneOSX, metal, lz4);
        Emit("osx-notypetree", BuildTarget.StandaloneOSX, metal, noTree);
    }

    static void Emit(string name, BuildTarget target, GraphicsDeviceType[] apis, BuildAssetBundleOptions opts)
    {
        var group = BuildPipeline.GetBuildTargetGroup(target);
        if (!BuildPipeline.IsBuildTargetSupported(group, target))
        {
            Debug.Log("FIXTURE-SKIP shader " + name + ": no " + target + " build module");
            return;
        }
        PlayerSettings.SetUseDefaultGraphicsAPIs(target, false);
        PlayerSettings.SetGraphicsAPIs(target, apis);
        var dir = Path.Combine("Build", "shader-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "shaders", assetNames = Shaders } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, target);
        if (m == null) throw new System.Exception("build failed: shader " + name);
        Debug.Log("FIXTURE-OK shader " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildShaders.Build` (same command as section 2).
The log must hold a `FIXTURE-OK shader` line for each target the editor
can build (six with the iOS module, four without) and no `Shader error`;
a target without its module logs `FIXTURE-SKIP`. Copy only the
bundle named `shaders`:

```
Build/shader-<target>/shaders             ->  fixtures/bundles/editor/<editor version>/shader/lz4/<target>
Build/shader-<target>-notypetree/shaders  ->  fixtures/bundles/editor/<editor version>/shader/lz4-notypetree/<target>
```

Then rerun the goldens. `make-goldens.py` (UnityPy 1.25.3) adds the format
21 and 22 bundles to `goldens.json`: their metadata, names and container, no
Shader dump. Format 23 (6000.6) is UnityPy 1.25.4's, as for the other 6000.6
fixtures (section 13): `make-goldens.py` skips those bundles, and
`make-modern-goldens.py` puts the typed ones in `modern-goldens.json`, with a
`read_typetree()` dump of every object, Shaders included, which
`packages/core/tests/modern-fixtures.test.ts` compares with `readTypeTree()`.
The Shader reader's own check is `readTypeTree()` on every bundle
(`packages/core/tests/Shader.test.ts`).

### The `shader-variants` bundles (#283)

One more pair of shaders for the composite oracle of section 17 step 4c:
`UAR/ShaderFixture` has an `Int` property, which `c37af7d`'s converter
throws on, so its Unity 6 builds, the only ones whose stages hold several
variants in `m_PlayerSubPrograms`, have no golden. `UAR/ShaderVariants` is
the same shader with `_Count` a `Float`, no `Int` property, and a
`multi_compile` of two keywords: the first pass's stages list six variants
per program type (three keyword states, instancing off and on) in four
groups, three of them equal, so the golden checks the layout rule of plan
section 5 revision 2026-11-08a (each distinct blob index and type, groups in
order, at its first appearance) byte for byte. `UAR/ShaderVariantsSecond` is
its fallback, dependency and `UsePass` target, as `UAR/ShaderFixtureSecond`
is the first's.

| Bundle | Editors |
|---|---|
| `shader-variants/lz4/android` (OpenGL ES 3 and Vulkan) | 6000.3.26f1, 6000.6.4f1 |
| `shader-variants/lz4/ios` (Metal) | 6000.3.26f1 (6000.6.4f1 has no iOS module) |

With type trees only, and no Windows build: Direct3D 11 programs never get
text (section 17 step 4). Each editor built a fresh copy of the section 18
project (`Assets/`, `ProjectSettings/`, `Packages/`, not `Library/`) holding
only these files:

```
<project>/Assets/Fixtures/shader-variants/uar-variants.shader
<project>/Assets/Fixtures/shader-variants/uar-variants-second.shader
<project>/Assets/Editor/BuildShaderVariants.cs
```

`uar-variants.shader` is the `uar-fixture.shader` template above with the
6000.x `CONSERVATIVE` and `RP_EDITOR` lines and these changes:

- the header comment is
  `// Shader variants fixture (#283): the #237 fixture shader under a new name,`
  `// with _Count a Float (no Int property) and a multi_compile of two keywords,`
  `// so a Unity 6 stage lists several blob indices in m_PlayerSubPrograms.`;
- `Shader "UAR/ShaderVariants"`;
- `_Count ("Count", Float) = 3`;
- `#pragma multi_compile __ UAR_MULTI_A UAR_MULTI_B`;
- in the first pass's `frag`, `#elif UAR_MULTI_B` with
  `c.rgb -= _Emission.rgb;` before the `#endif` of `#if UAR_MULTI_A`;
- `UAR/ShaderVariantsSecond` instead of `UAR/ShaderFixtureSecond` in the
  `UsePass`, the `Dependency` and the `Fallback`.

`uar-variants-second.shader`:

```shaderlab
// The second shader of the #283 fixture: the first one's fallback, dependency
// and UsePass target.
Shader "UAR/ShaderVariantsSecond"
{
    Properties
    {
        _Color ("Color", Color) = (0, 1, 0, 1)
    }
    SubShader
    {
        Pass
        {
            Name "Unlit"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            fixed4 _Color;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return _Color; }
            ENDCG
        }
    }
    Fallback Off
}
```

`Assets/Editor/BuildShaderVariants.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

// The shader variants fixture (#283), built once per target with type trees.
// A target whose build module is not installed is skipped and logged.
public static class BuildShaderVariants
{
    const string Dir = "Assets/Fixtures/shader-variants";
    static readonly string[] Shaders = { Dir + "/uar-variants.shader", Dir + "/uar-variants-second.shader" };

    public static void Build()
    {
        // Keep the instancing variants; no material asks for instancing here.
        var graphics = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset")[0]);
        graphics.FindProperty("m_InstancingStripping").intValue = 2; // Keep All
        graphics.ApplyModifiedProperties();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("android", BuildTarget.Android, new[] { GraphicsDeviceType.OpenGLES3, GraphicsDeviceType.Vulkan }, lz4);
        Emit("ios", BuildTarget.iOS, new[] { GraphicsDeviceType.Metal }, lz4);
    }

    static void Emit(string name, BuildTarget target, GraphicsDeviceType[] apis, BuildAssetBundleOptions opts)
    {
        var group = BuildPipeline.GetBuildTargetGroup(target);
        if (!BuildPipeline.IsBuildTargetSupported(group, target))
        {
            Debug.Log("FIXTURE-SKIP shader-variants " + name + ": no " + target + " build module");
            return;
        }
        PlayerSettings.SetUseDefaultGraphicsAPIs(target, false);
        PlayerSettings.SetGraphicsAPIs(target, apis);
        var dir = Path.Combine("Build", "shader-variants-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "shaders", assetNames = Shaders } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, target);
        if (m == null) throw new System.Exception("build failed: shader-variants " + name);
        Debug.Log("FIXTURE-OK shader-variants " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildShaderVariants.Build` (section 2's command).
The log must hold `FIXTURE-OK shader-variants android`, and for 6000.3.26f1
`FIXTURE-OK shader-variants ios` (6000.6.4f1 logs `FIXTURE-SKIP`), and no
`Shader error`. Copy only the bundle named `shaders`:

```
Build/shader-variants-<target>/shaders  ->  fixtures/bundles/editor/<editor version>/shader-variants/lz4/<target>
```

Before the committed builds, a throwaway 6000.3.26f1 build of the same files
went through the composite oracle: every Shader got text, the GrabPass, the
geometry stage and the stencil and blend state included, so the shader needed
no simplifying. Then rerun the goldens in order: `make-goldens.py` adds the
6000.3.26f1 bundles to `goldens.json`; `make-modern-goldens.py` adds the
6000.6.4f1 one to `modern-goldens.json`, Shaders dumped; `make-export-goldens.py`
(section 17) writes their composite text.

### `shader-layouts.json`

```bash
.venv-oracle/bin/python scripts/make-shader-layouts.py
```

One synthetic Shader object per layout in UnityPy's TPK type tree data, from
2019.1 (the oldest version the reader supports) to 6000.6, plus the
2020.3.30f1 and 6000.3.25f1 fixture editors. The script fills every field of the TPK type
tree with a distinct value, writes the object with UnityPy's
`write_typetree`, reads it back with `read_typetree`, and records the bytes
and the sha256 of the read-back value in the form the test hashes (see the
script's docstring). The two fixture builds above have exactly the TPK layout
of their editor (2019.3.0b1's and 6000.6.0a7's entries), node for node.

## 19. The `spine` bundles (#238)

Spine skeletons as spine-unity stores them, for `unity-asset-reader-spine`,
built with **2019.4.41f2** only (format 21, which AssetStudio `c37af7d` reads,
so the TextAssets and pages get export goldens, section 17). No spine-unity
package is involved: the project holds stub scripts of our own that serialize
the same fields as spine-unity's assets, and a skeleton JSON and atlas text
written for it.

What the stubs reproduce of spine-unity (EsotericSoftware/spine-runtimes,
`spine-unity/Assets/Spine/Runtime/spine-unity/Asset Types/`, branches `3.8`,
`4.0`, `4.1` and `4.2`, read outside the repository) is its serialized layout
only: the field names, their kinds and their order, and the class names
`SkeletonDataAsset` and `SpineAtlasAsset` in the namespace `Spine.Unity`, as a
build records them in its MonoScripts (`Spine.Unity.OnDemand` is our own
name). No code, default values or attributes; the types the fields need (a
base class, a blend-modes record, a loader) are declared under our own names
(`Uar*`), and an enum field is an `int`, which is what Unity writes for
one. That code is under the Spine Runtimes License; none of it is in this
repository.

`SkeletonDataAsset.cs`, `SpineAtlasAsset.cs` and `BlendModeMaterials.cs`
declare the same serialized fields on all four branches. `AtlasAssetBase.cs`
adds two, `textureLoadingMode` (an enum: `Normal` = 0, `OnDemand` = 1) and
`onDemandTextureLoader`, before the atlas' own fields, when
`SPINE_OPTIONAL_ON_DEMAND_LOADING` is defined. 4.1 and 4.2 define it at the
top of that file, so a stock 4.1+ project writes them; 3.8 and 4.0 have
neither, nor does a 4.1+ project that removed the define. The project has both
atlas layouts: `Spine.Unity.SpineAtlasAsset` (3.8 and 4.0) and
`Spine.Unity.OnDemand.SpineAtlasAsset` (4.1+ as shipped).

What `spineSkeletons(env)` must return for each bundle, one row per atlas, in
order (`packages/spine/tests/spine.test.ts` reads this table):

| Bundle | Skeleton | Skeleton data | Atlas | Pages |
|---|---|---|---|---|
| `spine/lz4/skeletons` | `hero_SkeletonData` | `hero` | `hero.atlas` | `hero`, `hero2` |
| `spine/lz4/skeletons` | `imp_SkeletonData` | `imp` | `imp.atlas` | `imp` |
| `spine/lz4/skeletons` | `imp_SkeletonData` | `imp` | `imp-fx.atlas` | `imp-fx` |
| `spine/lz4/split` | `wisp_SkeletonData` | `wisp` | `wisp.atlas` | `wisp` |

- `hero_SkeletonData` (4.1+ atlas layout): one atlas, `hero_Atlas`, with two pages,
  `textureLoadingMode` `Normal`.
- `imp_SkeletonData` (3.8 and 4.0 atlas layout): `atlasAssets` is `imp_Atlas`, a null
  entry, `imp-fx_Atlas`. spine-unity skips the null entry
  (`SkeletonDataAsset.GetAtlasArray`), so the skeleton has two atlases.
- `spine/lz4/split` and `spine/lz4/splitatlas` (#254): a split build.
  `wisp_SkeletonData` (and its JSON) is in `split`; its atlas asset `wisp_Atlas`
  (4.1+ layout, `Normal`) is in `splitatlas`, and takes its atlas text,
  Material and page with it. The row above is `split` loaded together with
  `splitatlas`; `split` alone has the skeleton but not its atlas.
- `spine/lz4/otheratlas` (#254): `shade_SkeletonData`, whose one atlas asset
  `shade_Atlas` is `Spine.Unity.UarOtherAtlasAsset`, our own atlas type with
  neither `atlasFile` nor `materials` (as spine-unity's other atlas types, such
  as `SpineSpriteAtlasAsset`, are not `SpineAtlasAsset`s): `spineSkeletons`
  refuses it, naming `shade_Atlas`.
- `spine/lz4-notypetree/splitatlas` (#254): `splitatlas` built with
  `DisableWriteTypeTree`. Both builds name a bundle's SerializedFile after the
  bundle's name, so `split` (with type trees) loaded with it finds its atlas
  asset there, without a type tree: `spineSkeletons` refuses it, naming
  `wisp_Atlas`.
- `spine/lz4/ondemand`: `ghost_SkeletonData`, whose atlas `ghost_Atlas` has
  `textureLoadingMode` `OnDemand`, which spine-unity builds with placeholder
  textures in the materials: `spineSkeletons` refuses it.
- `spine/lz4-notypetree/skeletons`: the `skeletons` bundle built with
  `DisableWriteTypeTree`, which has no field names to go by: `spineSkeletons`
  refuses it, naming the `SkeletonDataAsset` script.

Names are `m_Name`s: Unity names a TextAsset after its file without the last
extension (`hero.atlas.txt` is `hero.atlas`) and a texture after its file.
A page is the `_MainTex` of each of the atlas asset's `materials`
(`<page>_Material`), in that order; the shader those Materials use goes into a
bundle of its own, `spinedeps`, which is not committed.

### Source assets

Under `<project>/Assets/Fixtures/spine/`. The JSON and atlas files are written
byte-exact (LF, no BOM):

```bash
printf '{"skeleton":{"hash":"uarhero","spine":"4.2.00","x":-4,"y":0,"width":8,"height":16},"bones":[{"name":"root"}],"slots":[{"name":"head","bone":"root","attachment":"head"},{"name":"body","bone":"root","attachment":"body"}],"skins":[{"name":"default","attachments":{"head":{"head":{"y":12,"width":8,"height":8}},"body":{"body":{"y":4,"width":8,"height":8}}}}],"animations":{"idle":{}}}\n' > hero.json
printf 'hero.png\nsize:8,8\nfilter:Linear,Linear\nhead\nbounds:0,0,8,8\n\nhero2.png\nsize:8,8\nfilter:Linear,Linear\nbody\nbounds:0,0,8,8\n' > hero.atlas.txt
printf '{"skeleton":{"hash":"uarimp","spine":"3.8.99","width":8,"height":8},"bones":[{"name":"root"}],"slots":[{"name":"body","bone":"root","attachment":"body"},{"name":"spark","bone":"root","attachment":"spark"}],"skins":[{"name":"default","attachments":{"body":{"body":{"width":8,"height":8}},"spark":{"spark":{"width":8,"height":8}}}}],"animations":{"idle":{}}}\n' > imp.json
printf '\nimp.png\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nbody\n  rotate: false\n  xy: 0, 0\n  size: 8, 8\n  orig: 8, 8\n  offset: 0, 0\n  index: -1\n' > imp.atlas.txt
printf '\nimp-fx.png\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nspark\n  rotate: false\n  xy: 0, 0\n  size: 8, 8\n  orig: 8, 8\n  offset: 0, 0\n  index: -1\n' > imp-fx.atlas.txt
printf '{"skeleton":{"hash":"uarghost","spine":"4.2.00","width":8,"height":8},"bones":[{"name":"root"}],"slots":[{"name":"body","bone":"root","attachment":"body"}],"skins":[{"name":"default","attachments":{"body":{"body":{"width":8,"height":8}}}}],"animations":{"idle":{}}}\n' > ghost.json
printf 'ghost.png\nsize:8,8\nfilter:Linear,Linear\nbody\nbounds:0,0,8,8\n' > ghost.atlas.txt
printf '{"skeleton":{"hash":"uarwisp","spine":"4.2.00","width":8,"height":8},"bones":[{"name":"root"}],"slots":[{"name":"body","bone":"root","attachment":"body"}],"skins":[{"name":"default","attachments":{"body":{"body":{"width":8,"height":8}}}}],"animations":{"idle":{}}}\n' > wisp.json
printf 'wisp.png\nsize:8,8\nfilter:Linear,Linear\nbody\nbounds:0,0,8,8\n' > wisp.atlas.txt
printf '{"skeleton":{"hash":"uarshade","spine":"4.2.00","width":8,"height":8},"bones":[{"name":"root"}],"slots":[{"name":"body","bone":"root","attachment":"body"}],"skins":[{"name":"default","attachments":{"body":{"body":{"width":8,"height":8}}}}],"animations":{"idle":{}}}\n' > shade.json
```

The hero JSON and atlas text are Spine 4.x's export format, the imp ones 3.8's;
nothing reads them as Spine data, they only have to come back byte for byte.
The pages are 8x8 RGBA PNGs, every pixel distinct within and across pages
(stored deflate, so the bytes do not depend on the zlib version):

```python
import struct, zlib
def png(name, page):
    px = [[((32 * x + 4 * page) % 256, (32 * y + 3) % 256, (40 * page + 4 * x + y) % 256, 255 - 8 * (x + y)) for x in range(8)] for y in range(8)]
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 0)) + chunk(b"IEND", b"")
    open(name, "wb").write(data)
for page, name in enumerate(["hero.png", "hero2.png", "imp.png", "imp-fx.png", "ghost.png", "wisp.png"], 1):
    png(name, page)
```

sha256 of each file:

```
77b9da52d4b22be22a18b32d668ce49086745af5562df63c36fe07573e970ff9  hero.json
9ba4fae5677381ee0b1ed848183797a60c52848f36dd733557ee3afdad9c92af  hero.atlas.txt
98767306c19f9306753272348ede1eb10ea6fe3b2007f1cb15b48f5a62d3b8ae  hero.png
5d63131a81a671ab079f0a54ba201d5a358f0264d2173722f0d4e5aa33ebe030  hero2.png
64ebbd5f211bb27b246f901626c22c5cac06add9cff06d5ca2f9925c5ed1ef24  imp.json
25f4fffdeca789d74a8079272f885eda44965f55715465e9e1774fdadb13be4c  imp.atlas.txt
330ce484fb0f86e29d836cfa7546389838ff2126906dfe261c0317346f5ee6ed  imp.png
8cff25a19d77c886a6b35ffdb3baa26e98e6f2d33e60809a273ab6ddcd05ba08  imp-fx.atlas.txt
408e078298da49777fec9d0522da5e33492ac341a61473e80159e58479c1b345  imp-fx.png
8946f6c1e5e8a71196fb5c0e4ed4053ff881d2ca5f5e41cb844006ef038d286d  ghost.json
1d804a8efa9ced3f9601ec44ccfc94626427ee1dcfd4df08afe0b061f2f297c8  ghost.atlas.txt
8aafa8abaf30aa4912faca2c62285194457902e1ba9c870851d5c089c791faf1  ghost.png
eb550200017581578294d1bd03449b3d605f3082727640b437aa4c1ca614d044  wisp.json
4f8f7f1ede0d334012d8ccb251aaafa238bd53d10c3f8b3486818a2d3ed58e2c  wisp.atlas.txt
2045f7a939e5b7875ce4274b71cdbb7a8fb210f362e5b97eaac345d7e44dd011  wisp.png
6f18c54041e266d4e47ecebf80707b256aead744f4eece47adc8466c30b994e4  shade.json
```

`page.shader`, the smallest shader with a `_MainTex` slot:

```shaderlab
// The smallest shader with a _MainTex slot, for the page Materials (#238).
Shader "UAR/SpinePage"
{
    Properties { _MainTex ("Page", 2D) = "white" {} }
    SubShader
    {
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            sampler2D _MainTex;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return tex2D(_MainTex, float2(0, 0)); }
            ENDCG
        }
    }
}
```

### Stub scripts

Under `Assets/Scripts/Spine/` (`SkeletonDataAsset.cs`, `SpineAtlasAsset.cs`,
`UarTypes.cs`, `UarOtherAtlasAsset.cs`) and `Assets/Scripts/SpineOnDemand/`
(`SpineAtlasAsset.cs`).
Unity takes two scripts of the same file name in different folders, as long
as their namespaces differ. One `SkeletonDataAsset` serves both atlas
layouts, through the common base `UarAtlasBase`:

```csharp
// Spine/SkeletonDataAsset.cs
using System.Collections.Generic;
using UnityEngine;

namespace Spine.Unity
{
    // spine-unity's SkeletonDataAsset serialized fields (3.8 to 4.2): names, types, order.
    public class SkeletonDataAsset : ScriptableObject
    {
        public UarAtlasBase[] atlasAssets;
        public float scale;
        public TextAsset skeletonJSON;
        public bool isUpgradingBlendModeMaterials;
        public UarBlendModes blendModeMaterials;
        public List<UarModifier> skeletonDataModifiers;
        public string[] fromAnimation;
        public string[] toAnimation;
        public float[] duration;
        public float defaultMix;
        public RuntimeAnimatorController controller;
    }
}

// Spine/SpineAtlasAsset.cs
using UnityEngine;

namespace Spine.Unity
{
    // SpineAtlasAsset of 3.8 and 4.0 (and 4.1+ without SPINE_OPTIONAL_ON_DEMAND_LOADING).
    public class SpineAtlasAsset : UarAtlasBase
    {
        public TextAsset atlasFile;
        public Material[] materials;
    }
}

// Spine/UarTypes.cs
using System.Collections.Generic;
using UnityEngine;

namespace Spine.Unity
{
    // Our own types for the fields above that need one; the names are ours.
    public abstract class UarAtlasBase : ScriptableObject { }

    public abstract class UarModifier : ScriptableObject { }

    public abstract class UarTextureLoader : ScriptableObject { }

    [System.Serializable]
    public class UarPageMaterial
    {
        public string pageName;
        public Material material;
    }

    [System.Serializable]
    public class UarBlendModes
    {
        public bool requiresBlendModeMaterials;
        public bool applyAdditiveMaterial;
        public List<UarPageMaterial> additiveMaterials;
        public List<UarPageMaterial> multiplyMaterials;
        public List<UarPageMaterial> screenMaterials;
    }
}

// Spine/UarOtherAtlasAsset.cs
namespace Spine.Unity
{
    // An atlas type of our own that is not a SpineAtlasAsset (#254): neither atlasFile
    // nor materials.
    public class UarOtherAtlasAsset : UarAtlasBase { }
}

// SpineOnDemand/SpineAtlasAsset.cs
using UnityEngine;

namespace Spine.Unity.OnDemand
{
    // SpineAtlasAsset of 4.1+ as shipped (SPINE_OPTIONAL_ON_DEMAND_LOADING defined): the
    // two base-class fields come first. textureLoadingMode is an enum there, an int here.
    public class SpineAtlasAsset : Spine.Unity.UarAtlasBase
    {
        public int textureLoadingMode;
        public Spine.Unity.UarTextureLoader onDemandTextureLoader;
        public TextAsset atlasFile;
        public Material[] materials;
    }
}
```

`Assets/Editor/BuildSpine.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;
using Spine.Unity;
using OnDemand = Spine.Unity.OnDemand;

// Spine skeletons laid out as spine-unity stores them (#238), with our stub
// scripts: hero (4.1+ atlas layout, one atlas, two pages), imp (3.8/4.0 atlas
// layout, two atlases and a null entry between them, one page each), and ghost
// (4.1+ layout, texture loading mode OnDemand) in a bundle of its own; wisp
// (4.1+ layout) split from its atlas asset, and shade, whose atlas asset is our
// own other atlas type, each in bundles of their own (#254).
public static class BuildSpine
{
    const string Dir = "Assets/Fixtures/spine";

    static T Load<T>(string file) where T : Object
    {
        var asset = AssetDatabase.LoadAssetAtPath<T>(Dir + "/" + file);
        if (asset == null) throw new System.Exception("missing " + file);
        return asset;
    }

    static string Save(Object asset, string name)
    {
        var path = Dir + "/" + name + ".asset";
        AssetDatabase.DeleteAsset(path);
        AssetDatabase.CreateAsset(asset, path);
        return path;
    }

    // A page: an uncompressed RGBA32 texture without mips, and its Material.
    static Material Page(string page)
    {
        var tex = (TextureImporter)AssetImporter.GetAtPath(Dir + "/" + page + ".png");
        tex.textureCompression = TextureImporterCompression.Uncompressed;
        tex.mipmapEnabled = false;
        tex.SaveAndReimport();
        var path = Dir + "/" + page + "_Material.mat";
        AssetDatabase.DeleteAsset(path);
        var mat = new Material(Load<Shader>("page.shader"));
        mat.SetTexture("_MainTex", Load<Texture2D>(page + ".png"));
        AssetDatabase.CreateAsset(mat, path);
        return mat;
    }

    static SpineAtlasAsset PlainAtlas(string name, params string[] pages)
    {
        var atlas = ScriptableObject.CreateInstance<SpineAtlasAsset>();
        atlas.atlasFile = Load<TextAsset>(name + ".atlas.txt");
        atlas.materials = System.Array.ConvertAll(pages, Page);
        Save(atlas, name + "_Atlas");
        return atlas;
    }

    static OnDemand.SpineAtlasAsset OnDemandAtlas(string name, int loadingMode, params string[] pages)
    {
        var atlas = ScriptableObject.CreateInstance<OnDemand.SpineAtlasAsset>();
        atlas.textureLoadingMode = loadingMode; // 0 Normal, 1 OnDemand
        atlas.atlasFile = Load<TextAsset>(name + ".atlas.txt");
        atlas.materials = System.Array.ConvertAll(pages, Page);
        Save(atlas, name + "_Atlas");
        return atlas;
    }

    static string Skeleton(string name, UarAtlasBase[] atlases)
    {
        var data = ScriptableObject.CreateInstance<SkeletonDataAsset>();
        data.atlasAssets = atlases;
        data.scale = 0.01f;
        data.skeletonJSON = Load<TextAsset>(name + ".json");
        return Save(data, name + "_SkeletonData");
    }

    public static void Build()
    {
        var hero = Skeleton("hero", new UarAtlasBase[] { OnDemandAtlas("hero", 0, "hero", "hero2") });
        // A null entry, which spine-unity skips.
        var imp = Skeleton("imp", new UarAtlasBase[] { PlainAtlas("imp", "imp"), null, PlainAtlas("imp-fx", "imp-fx") });
        var ghost = Skeleton("ghost", new UarAtlasBase[] { OnDemandAtlas("ghost", 1, "ghost") });
        var wisp = Skeleton("wisp", new UarAtlasBase[] { OnDemandAtlas("wisp", 0, "wisp") });
        var shadeAtlas = ScriptableObject.CreateInstance<UarOtherAtlasAsset>();
        Save(shadeAtlas, "shade_Atlas");
        var shade = Skeleton("shade", new UarAtlasBase[] { shadeAtlas });
        AssetDatabase.SaveAssets();

        // The shader goes into a bundle of its own (not committed), so the page
        // Materials point at another file for it and the bundles stay small.
        // wisp_Atlas is named into splitatlas, so its atlas text, Material and page
        // go there with it and the split bundle points at that bundle for them.
        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "skeletons", assetNames = new[] { hero, imp } },
            new AssetBundleBuild { assetBundleName = "ondemand", assetNames = new[] { ghost } },
            new AssetBundleBuild { assetBundleName = "split", assetNames = new[] { wisp } },
            new AssetBundleBuild { assetBundleName = "splitatlas", assetNames = new[] { Dir + "/wisp_Atlas.asset" } },
            new AssetBundleBuild { assetBundleName = "otheratlas", assetNames = new[] { shade } },
            new AssetBundleBuild { assetBundleName = "spinedeps", assetNames = new[] { Dir + "/page.shader" } },
        };
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4, builds);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", "spine-" + name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: spine " + name);
        Debug.Log("FIXTURE-OK spine " + name + " -> " + dir);
    }
}
```

### Build

Same command as section 2, with `-executeMethod BuildSpine.Build`; the log
must hold two `FIXTURE-OK spine` lines. Copy only these seven files:

```
Build/spine-lz4/skeletons              -> fixtures/bundles/editor/2019.4.41f2/spine/lz4/skeletons
Build/spine-lz4/ondemand               -> fixtures/bundles/editor/2019.4.41f2/spine/lz4/ondemand
Build/spine-lz4-notypetree/skeletons   -> fixtures/bundles/editor/2019.4.41f2/spine/lz4-notypetree/skeletons
Build/spine-lz4/split                  -> fixtures/bundles/editor/2019.4.41f2/spine/lz4/split
Build/spine-lz4/splitatlas             -> fixtures/bundles/editor/2019.4.41f2/spine/lz4/splitatlas
Build/spine-lz4/otheratlas             -> fixtures/bundles/editor/2019.4.41f2/spine/lz4/otheratlas
Build/spine-lz4-notypetree/splitatlas  -> fixtures/bundles/editor/2019.4.41f2/spine/lz4-notypetree/splitatlas
```

The first three come from the #238 build, the other four from a build of a
project made from this page for #254, which also wrote the first three: those
were not replaced (section 4 says why a rebuild changes them). The two builds
share no asset, so mixing them is safe: `split` points at `splitatlas` by the
SerializedFile name, which depends only on the bundle name.

then rerun `make-goldens.py` (it dumps the MonoBehaviours', Materials',
TextAssets' and Texture2Ds' type trees) and `make-export-goldens.py`
(section 17: each TextAsset's file and each page's PNG).

## 20. The `mesh` bundles (#253, #257, #285)

Three meshes made from code, in their own bundles beside the existing ones, so
the `main` bundles and their goldens stay as they are. Editors: 2019.4.41f2,
2020.3.30f1 and 6000.3.26f1 (6000.3.25f1 is no longer installed, as in section
18). Formats 21 and 22 only: AssetStudio `c37af7d` cannot read format 23
(6000.6), so a 6000.6 mesh would have no OBJ golden. The skinned meshes at the
end of this section (#285) are built by 6000.6.4f1 too.

- `detail`: 8 vertices with UV0 and normals. Its positions include a negative
  zero, values below 1e-4 and at or above 1e9 (written in scientific notation)
  and fractions. It has two submeshes: triangles (0, 1, 2), (0, 2, 3), and the
  quad 4, 5, 6, 7, which Unity keeps as `topology` 2.
- `basevertex`: the reproduction of #257. Six vertices and one submesh,
  `SetIndices(new[] { 0, 1, 2 }, MeshTopology.Triangles, 0, true, 3)`: the
  index buffer holds 0, 1, 2 and `baseVertex` is 3, so Unity draws vertices 3,
  4 and 5. The build log has a `FIXTURE-INFO basevertex baseVertex=3
  idx=3,4,5 raw=0,1,2` line.
- `compressed`: `detail`'s data with `MeshUtility.SetMeshCompression(Medium)`.
  The build moves its vertices and triangles to `m_CompressedMesh`
  (`m_VertexData` empty). It has a bundle of its own, `mesh-compressed`.

Not built: a mesh streamed to a `.resS` (#253 lists it as optional). A plain
`Mesh` asset in an AssetBundle is not streamed, and the vertex streams are
already covered by `packages/core/tests/Mesh.test.ts`.

Create a project per editor named `uar-253-mesh-<editor version>`, with
`ProjectSettings/` and `Packages/` copied from one of the projects above and
only this file under `Assets/`.

`Assets/Editor/BuildMeshes.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// The mesh fixtures (#253, #257), created from code and built once per
// variant: "detail" (UV0, normals, fractional, tiny, huge and negative-zero
// coordinates, a triangle and a quad submesh), "basevertex" (one submesh whose
// indices 0, 1, 2 are offset by baseVertex 3) and "compressed" (detail's data
// with mesh compression on, in a bundle of its own).
public static class BuildMeshes
{
    const string Dir = "Assets/Fixtures/mesh";

    public static void Build()
    {
        // Keep every vertex channel: no renderer uses these meshes.
        PlayerSettings.stripUnusedMeshComponents = false;
        Directory.CreateDirectory(Dir);
        Save(Detail("detail"), "detail");
        Save(BaseVertex(), "basevertex");
        var compressed = Detail("compressed");
        MeshUtility.SetMeshCompression(compressed, ModelImporterMeshCompression.Medium);
        Save(compressed, "compressed");
        AssetDatabase.SaveAssets();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static Mesh Detail(string name)
    {
        var mesh = new Mesh { name = name };
        mesh.vertices = new[]
        {
            new Vector3(-0f, 0.5f, 0.25f),
            new Vector3(1.5f, 0.000012345f, -2.75f),
            new Vector3(1e9f, 3.14159f, 0.1f),
            new Vector3(-0.333333f, 2.5e10f, 7e-5f),
            new Vector3(0.125f, -0f, 1f),
            new Vector3(2f, 0.001f, -1e-7f),
            new Vector3(123456.79f, 1e-3f, 0f),
            new Vector3(-4.5e9f, -0.5f, 0.75f),
        };
        mesh.normals = new[]
        {
            new Vector3(0f, 0f, -1f),
            new Vector3(0.6f, 0f, 0.8f),
            new Vector3(-0.267261f, 0.534522f, 0.801784f),
            new Vector3(0f, 1f, 0f),
            new Vector3(0.707107f, -0.707107f, 0f),
            new Vector3(-0f, 0f, 1f),
            new Vector3(0.1f, 0.2f, 0.974679f),
            new Vector3(-1f, 0f, 0f),
        };
        mesh.uv = new[]
        {
            new Vector2(0f, 0f),
            new Vector2(0.333333f, 0.000031f),
            new Vector2(1f, 0.5f),
            new Vector2(0.75f, 0.125f),
            new Vector2(0.1f, 0.9f),
            new Vector2(1.5e-5f, 0.2f),
            new Vector2(0.6f, 0.7f),
            new Vector2(-0.25f, 1.25f),
        };
        mesh.subMeshCount = 2;
        mesh.SetIndices(new[] { 0, 1, 2, 0, 2, 3 }, MeshTopology.Triangles, 0);
        mesh.SetIndices(new[] { 4, 5, 6, 7 }, MeshTopology.Quads, 1);
        return mesh;
    }

    static Mesh BaseVertex()
    {
        var mesh = new Mesh { name = "basevertex" };
        mesh.vertices = new[]
        {
            new Vector3(0f, 0f, 0f), new Vector3(0f, 1f, 0f), new Vector3(1f, 0f, 0f),
            new Vector3(2f, 0f, 0f), new Vector3(2f, 1f, 0f), new Vector3(3f, 0f, 0f),
        };
        mesh.SetIndices(new[] { 0, 1, 2 }, MeshTopology.Triangles, 0, true, 3);
        var check = mesh.GetIndices(0, true);
        var raw = mesh.GetIndices(0, false);
        Debug.Log("FIXTURE-INFO basevertex baseVertex=" + mesh.GetBaseVertex(0) +
            " idx=" + string.Join(",", check) + " raw=" + string.Join(",", raw));
        return mesh;
    }

    static void Save(Mesh mesh, string name)
    {
        AssetDatabase.CreateAsset(mesh, Dir + "/" + name + ".asset");
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", "mesh-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "mesh", assetNames = new[] { Dir + "/detail.asset", Dir + "/basevertex.asset" } },
            new AssetBundleBuild { assetBundleName = "mesh-compressed", assetNames = new[] { Dir + "/compressed.asset" } },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: mesh " + name);
        Debug.Log("FIXTURE-OK mesh " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildMeshes.Build` (same command
as section 2). The log must hold two `FIXTURE-OK mesh` lines. Copy only these
files (not `mesh-lz4`, the manifest bundle):

```
Build/mesh-lz4/mesh                  ->  fixtures/bundles/editor/<editor version>/mesh/lz4/mesh
Build/mesh-lz4/mesh-compressed       ->  fixtures/bundles/editor/<editor version>/mesh/lz4/mesh-compressed
Build/mesh-lz4-notypetree/mesh       ->  fixtures/bundles/editor/<editor version>/mesh/lz4-notypetree/mesh
```

`Build/mesh-lz4-notypetree/mesh-compressed` is not committed. Unity compresses
the mesh again for each variant, and the two builds do not quantize alike: on
all three editors their `m_CompressedMesh.m_Normals` differ (on 2019.4 and
2020.3 the second build's `m_Range` is 1.9999847 and `m_Start` -0.9999924,
where the first's are 2 and -1). So the typed twin cannot check the build
without type trees.

Then rerun the goldens:

```bash
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --project <external-harness> --dotnet <dotnet-executable>
```

`make-goldens.py` (UnityPy 1.25.3) dumps each Mesh's type tree, so
`packages/core/tests/Mesh.test.ts` compares `readMesh()` with it. The decoded
vertices, normals and UV0 are compared with the float32 values of the
script above.

`make-export-goldens.py` (section 17) records an OBJ for `detail` and
`compressed`. `basevertex` gets no golden (plan section 6: the oracle is
wrong). AssetStudio's `GetTriangles` (`Classes/Mesh.cs`) never reads
`baseVertex`, and UnityPy's `get_triangles` does not either, so `ExportMesh`
writes `f 3/3/3 2/2/2 1/1/1`. unity-asset-reader adds the offset and writes
`f 6/6/6 5/5/5 4/4/4`. The harness records that verdict as the entry's
`exportError` and keeps AssetStudio's OBJ as `objWithoutBaseVertex`.
`packages/mesh/tests/obj.test.ts` checks that `meshToObj`, given the same mesh
with the offset taken off its indices, writes exactly that file.

### The skinned meshes (#285)

Two more meshes made from code, in bundles of their own (`mesh-skinned`,
`mesh-skinned-compressed`), so the bundles above stay as they are. Editors:
2019.4.41f2, 2020.3.30f1, 6000.3.26f1 and 6000.6.4f1, whose Mesh layout differs
(no `m_MeshUsageFlags`, `m_PreBake*` fields; blend shapes still in `m_Shapes`).

- `skinned`: 8 vertices with tangents, Color32 colours, UV0 and UV1, and
  32-bit indices (`IndexFormat.UInt32`), six triangles. Its skin goes through
  `mesh.boneWeights`, at most four influences, so the weights stay in the
  vertex data's weight channel (`SetBoneWeights` with more than four would
  write `m_VariableBoneCountWeights`, which UnityPy ignores and the reader
  refuses). The vertices have 1, 2, 2, 3, 3, 4, 4 and 4 influences over five
  bones, with five `bindposes`. Two blend shapes, `smile` (frames at 50 and 100,
  moving vertices 4 to 7) and `blink` (25, 50 and 100, vertices 0 to 3), each
  frame with vertex, normal and tangent deltas. The build log has a
  `FIXTURE-INFO skinned bonesPerVertex=1,2,2,3,3,4,4,4 shapes=2
  indexFormat=UInt32` line.
- `skinned-compressed`: the same data with `MeshUtility.SetMeshCompression(Medium)`.
  Its vertices, skin, tangents, colours and both UV channels (`m_UVInfo` 85)
  move to `m_CompressedMesh`. Three of its 4-influence vertices store three
  weights that add up to less than 31, so the fourth is derived (see below).

Not built: `skinned-compressed` from 2020.3.30f1. That editor saves a Mesh with
bone weights uncompressed whatever `SetMeshCompression` set: a probe project
(the script below with each channel left out in turn) logged
`GetMeshCompression` Medium after the call and Off after `CreateAsset` and
`SaveAssets` for every variant with bone weights, Medium for those without;
setting it again after `CreateAsset` changed nothing. Its build of
`mesh-skinned-compressed` holds `m_MeshCompression` 0 and plain vertex data, so
it is not committed.

Create a project per editor named `uar-285-skinned-mesh-<editor version>`,
with `ProjectSettings/` and `Packages/` copied from the section's
`uar-253-mesh-<editor version>` projects (6000.6.4f1: from the 6000.6 shader
project of section 18), and only this file under `Assets/`.

`Assets/Editor/BuildSkinnedMeshes.cs`:

```csharp
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

// The skinned mesh fixtures (#285), created from code and built once per
// variant: "skinned" (8 vertices with 1, 2, 3 and 4 bone influences out of 5
// bones, bindposes, two blend shapes of two and three frames with vertex,
// normal and tangent deltas, tangents, Color32 colors, UV0 and UV1, 32-bit
// indices) and "skinned-compressed" (the same data with mesh compression on,
// in a bundle of its own).
public static class BuildSkinnedMeshes
{
    const string Dir = "Assets/Fixtures/skinned";

    public static void Build()
    {
        // Keep every vertex channel: no renderer uses these meshes.
        PlayerSettings.stripUnusedMeshComponents = false;
        Directory.CreateDirectory(Dir);
        Save(Skinned("skinned"), "skinned");
        var compressed = Skinned("skinned-compressed");
        MeshUtility.SetMeshCompression(compressed, ModelImporterMeshCompression.Medium);
        Save(compressed, "skinned-compressed");
        AssetDatabase.SaveAssets();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static BoneWeight Weight(params float[] pairs)
    {
        // pairs: bone index, weight, bone index, weight, ... (heaviest first)
        var w = new BoneWeight();
        int n = pairs.Length / 2;
        if (n > 0) { w.boneIndex0 = (int)pairs[0]; w.weight0 = pairs[1]; }
        if (n > 1) { w.boneIndex1 = (int)pairs[2]; w.weight1 = pairs[3]; }
        if (n > 2) { w.boneIndex2 = (int)pairs[4]; w.weight2 = pairs[5]; }
        if (n > 3) { w.boneIndex3 = (int)pairs[6]; w.weight3 = pairs[7]; }
        return w;
    }

    static Mesh Skinned(string name)
    {
        var mesh = new Mesh { name = name };
        mesh.indexFormat = IndexFormat.UInt32;
        mesh.vertices = new[]
        {
            new Vector3(0f, 0f, 0f),
            new Vector3(1f, 0f, 0.125f),
            new Vector3(0f, 1f, -0.25f),
            new Vector3(1f, 1f, 0.5f),
            new Vector3(0f, 2f, 0.75f),
            new Vector3(1f, 2f, -0.5f),
            new Vector3(0.25f, 3f, 0f),
            new Vector3(1.5f, 3f, 0.375f),
        };
        mesh.normals = new[]
        {
            new Vector3(0f, 0f, -1f),
            new Vector3(0.6f, 0f, -0.8f),
            new Vector3(0f, 0.6f, -0.8f),
            new Vector3(0f, 1f, 0f),
            new Vector3(-0.8f, 0f, -0.6f),
            new Vector3(1f, 0f, 0f),
            new Vector3(0f, -0.8f, -0.6f),
            new Vector3(0f, 0f, 1f),
        };
        mesh.tangents = new[]
        {
            new Vector4(1f, 0f, 0f, 1f),
            new Vector4(0.8f, 0f, 0.6f, 1f),
            new Vector4(1f, 0f, 0f, -1f),
            new Vector4(0f, 0f, 1f, 1f),
            new Vector4(0.6f, 0f, -0.8f, -1f),
            new Vector4(0f, 1f, 0f, 1f),
            new Vector4(1f, 0f, 0f, 1f),
            new Vector4(0f, 1f, 0f, -1f),
        };
        mesh.colors32 = new[]
        {
            new Color32(255, 0, 0, 255),
            new Color32(0, 255, 0, 255),
            new Color32(0, 0, 255, 255),
            new Color32(255, 255, 0, 128),
            new Color32(0, 255, 255, 64),
            new Color32(255, 0, 255, 0),
            new Color32(12, 34, 56, 78),
            new Color32(200, 150, 100, 50),
        };
        mesh.uv = new[]
        {
            new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 0.25f), new Vector2(1f, 0.25f),
            new Vector2(0f, 0.5f), new Vector2(1f, 0.5f), new Vector2(0.125f, 0.75f), new Vector2(0.875f, 1f),
        };
        mesh.uv2 = new[]
        {
            new Vector2(0.5f, 0.5f), new Vector2(0.75f, 0.5f), new Vector2(0.5f, 0.625f), new Vector2(0.75f, 0.625f),
            new Vector2(0.5f, 0.75f), new Vector2(0.75f, 0.75f), new Vector2(0.5f, 0.875f), new Vector2(0.75f, 1f),
        };
        mesh.triangles = new[] { 0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5, 5, 6, 7 };
        mesh.boneWeights = new[]
        {
            Weight(0, 1f),
            Weight(1, 0.75f, 0, 0.25f),
            Weight(2, 0.5f, 1, 0.5f),
            Weight(3, 0.5f, 2, 0.3f, 1, 0.2f),
            Weight(4, 0.6f, 2, 0.25f, 3, 0.15f),
            Weight(3, 0.4f, 2, 0.3f, 1, 0.2f, 0, 0.1f),
            Weight(1, 0.35f, 0, 0.3f, 4, 0.2f, 2, 0.15f),
            Weight(4, 0.7f, 3, 0.1f, 0, 0.1f, 1, 0.1f),
        };
        mesh.bindposes = Enumerable.Range(0, 5)
            .Select(i => Matrix4x4.TRS(new Vector3(0f, -0.75f * i, 0.1f * i),
                Quaternion.Euler(0f, 0f, 15f * i), Vector3.one).inverse)
            .ToArray();
        // "smile": two frames moving vertices 4..7; "blink": three frames moving 0..3.
        AddShape(mesh, "smile", new[] { 50f, 100f }, 4);
        AddShape(mesh, "blink", new[] { 25f, 50f, 100f }, 0);
        var per = mesh.GetBonesPerVertex();
        Debug.Log("FIXTURE-INFO " + name + " bonesPerVertex=" + string.Join(",", per.ToArray()) +
            " shapes=" + mesh.blendShapeCount + " indexFormat=" + mesh.indexFormat);
        return mesh;
    }

    static void AddShape(Mesh mesh, string shape, float[] weights, int first)
    {
        for (int f = 0; f < weights.Length; f++)
        {
            var dv = new Vector3[8];
            var dn = new Vector3[8];
            var dt = new Vector3[8];
            float k = (f + 1) / (float)weights.Length;
            for (int v = first; v < first + 4; v++)
            {
                dv[v] = new Vector3(0.125f * k, 0.25f * k * (v - first + 1), -0.0625f * k);
                dn[v] = new Vector3(0f, 0.5f * k, -0.25f * k);
                dt[v] = new Vector3(-0.25f * k, 0f, 0.125f * (v - first + 1));
            }
            mesh.AddBlendShapeFrame(shape, weights[f], dv, dn, dt);
        }
    }

    static void Save(Mesh mesh, string name)
    {
        AssetDatabase.CreateAsset(mesh, Dir + "/" + name + ".asset");
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", "skinned-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "mesh-skinned", assetNames = new[] { Dir + "/skinned.asset" } },
            new AssetBundleBuild { assetBundleName = "mesh-skinned-compressed", assetNames = new[] { Dir + "/skinned-compressed.asset" } },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: skinned " + name);
        Debug.Log("FIXTURE-OK skinned " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildSkinnedMeshes.Build` (same
command as section 2). The log must hold two `FIXTURE-OK skinned` lines. Copy
only these files:

```
Build/skinned-lz4/mesh-skinned               ->  fixtures/bundles/editor/<editor version>/mesh/lz4/mesh-skinned
Build/skinned-lz4/mesh-skinned-compressed    ->  fixtures/bundles/editor/<editor version>/mesh/lz4/mesh-skinned-compressed   (not 2020.3.30f1)
Build/skinned-lz4-notypetree/mesh-skinned    ->  fixtures/bundles/editor/<editor version>/mesh/lz4-notypetree/mesh-skinned   (not 6000.6.4f1)
```

As above, the compressed mesh's build without type trees is not committed
(the two builds quantize differently). 6000.6.4f1's build without type trees
is not either: format 23 has no UnityPy 1.25.3 golden, and its typed twin is
in `modern-goldens.json`.

Then rerun the goldens:

```bash
.venv-oracle/bin/python scripts/make-goldens.py
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

`make-goldens.py` (and `make-modern-goldens.py` for 6000.6, through the same
code) records, for each skinned Mesh, UnityPy MeshHelper's decoded skin under
`skins`: four bone weights (float32 bits) and bone indices per vertex. It
fails unless the mesh has vertices with 2, 3 and 4 influences and, for the
compressed one, `m_CompressedMesh.m_Weights.m_NumItems` above 0 and a derived
fourth weight.

Plan section 6, the oracle is wrong: for a vertex whose three stored weights
add up to less than 31 (31sts), UnityPy's `decompress_compressed_mesh` sets the
fourth weight to `1 - sum` (for stored weights 12, 9 and 6: -26), where
AssetStudio's `DecompressCompressedMesh` (`Classes/Mesh.cs`) sets
`(31 - sum) / 31.0f` (4/31). The golden keeps UnityPy's value and lists those
vertices under `derivedWeights`, with the 31sts it unpacked, and an
`oracleNote` with the verdict: AssetStudio. `make-export-goldens.py` records
the `m_Skin` c37af7d's Mesh reader decodes for every skinned Mesh it reads
(`skin`, formats 21 and 22), and an OBJ as for the meshes above. 6000.6 has
neither (c37af7d cannot read format 23); there the derived weight is checked
against AssetStudio's formula on the 31sts UnityPy unpacked.
`packages/core/tests/MeshSkinned.test.ts` checks `read()`'s skin against both,
`m_Shapes` against UnityPy's type-tree dump, and the source values above.

## 21. The signed-EAC bundles (#288)

`signed-eac/android` for **2019.4.41f2**, **2020.3.30f1**, **6000.3.26f1** and
**6000.6.4f1**: one lz4 bundle (typed, Android target) per editor with two 32x16
Texture2D, `42_EAC_R_SIGNED` and `44_EAC_RG_SIGNED`, no mips, readable, image
data inline. The importer never compresses to signed EAC, but the `Texture2D`
constructor accepts any compressed format the editor can decompress, and
`LoadRawTextureData` takes the blocks as they are. So the blocks come from
etc2comp, not from Unity, and the editor only stores them.

### Image and blocks

The image, `signed-eac.png`, is 32x16 RGBA in section 12's coordinate-color
style: R identifies x, G identifies y.

```python
# signed-eac.png: 32x16 RGBA, R = x ramp, G = y ramp, B = 0, A = 255.
# etc2comp maps 0..255 to signed -128..127 by subtracting 128, so each ramp
# covers both signs.
import struct, zlib, sys
W, H = 32, 16
rows = b""
for y in range(H):
    rows += b"\0" + b"".join(bytes((x * 255 // (W - 1), y * 255 // (H - 1), 0, 255)) for x in range(W))
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
```

The encoder is google/etc2comp (Apache-2.0) at commit
`39422c1aa2f4889d636db5790af1d0be6ff3a226`, cloned and built outside the repo
(R2; never committed). Without cmake, one g++ call builds `EtcTool`:

```bash
git clone https://github.com/google/etc2comp.git && cd etc2comp
g++ -std=c++11 -pthread -O2 -w -IEtcLib/Etc -IEtcLib/EtcCodec -Ithird_party/lodepng \
  EtcLib/Etc/*.cpp EtcLib/EtcCodec/*.cpp EtcTool/*.cpp third_party/lodepng/lodepng.cpp \
  -o build/EtcTool
mkdir out
build/EtcTool signed-eac.png -format SIGNED_R11 -effort 100 -output out/SIGNED_R11.ktx
build/EtcTool signed-eac.png -format SIGNED_RG11 -effort 100 -output out/SIGNED_RG11.ktx
```

`EtcTool` needs a directory in `-output`. Its encoder subtracts 128 from each
8-bit channel (`EtcBlock4x4Encoding_R11.cpp`), so every ramp has negative and
positive values. The payload is level 0 of the KTX (internal formats `0x9271`
and `0x9273`): the bytes after the 64-byte header, the key-value data and the
4-byte image size. Payload sha256 (rerunning gives the same bytes):

| File | Bytes | sha256 |
| --- | --- | --- |
| `SIGNED_R11.bin` | 256 (32 blocks x 8) | `456a042fdde523e151d46a2850f22c9d4dd2c0b25eb8afcd63218cf4c24e8a49` |
| `SIGNED_RG11.bin` | 512 (32 blocks x 16) | `7b7394deb2cd415e347c0af39506286b789f50d7047b03fbe8bdcd7f7fd5cd2b` |

`packages/texture/tests/signed-eac.test.ts` checks every fixture's image data
against these hashes.

### Build

Each project is a fresh copy holding `ProjectSettings/` and `Packages/` of an
earlier fixture project of the same editor, the two payloads in `Payload/`
(next to `Assets/`, so no importer touches them) and only
`Assets/Editor/BuildSignedEac.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// Signed EAC Texture2D assets made by script from etc2comp output (#288). The
// importer never compresses to EAC_R_SIGNED or EAC_RG_SIGNED, but the Texture2D
// constructor accepts them and LoadRawTextureData takes the encoded blocks.
public static class BuildSignedEac
{
    const string Dir = "Assets/Fixtures/signed-eac";
    const int W = 32, H = 16;
    // By value: EAC_R_SIGNED, EAC_RG_SIGNED, with the etc2comp payload of each,
    // read from Payload/ next to Assets/.
    static readonly int[] Formats = { 42, 44 };
    static readonly string[] Payloads = { "SIGNED_R11.bin", "SIGNED_RG11.bin" };

    // 0: Apply(false, true); 1: Apply(false, false); 2: no Apply.
    public static void Probe() { Emit("probe", new[] { 0, 1, 2 }); }
    public static void Build() { Emit("android", new[] { 1 }); }

    static void Emit(string bundle, int[] variants)
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "signed-eac");
        var paths = new List<string>();
        foreach (var v in variants)
            for (int i = 0; i < Formats.Length; i++)
            {
                var format = (TextureFormat)Formats[i];
                var name = Formats[i] + "_" + format + (variants.Length > 1 ? "_v" + v : "");
                try
                {
                    var data = File.ReadAllBytes(Path.Combine("Payload", Payloads[i]));
                    var tex = new Texture2D(W, H, format, false) { name = name };
                    if (tex.format != format) throw new Exception("created as " + tex.format);
                    tex.LoadRawTextureData(data);
                    if (v == 0) tex.Apply(false, true);
                    else if (v == 1) tex.Apply(false, false);
                    var path = Dir + "/" + name + ".asset";
                    AssetDatabase.DeleteAsset(path);
                    AssetDatabase.CreateAsset(tex, path);
                    paths.Add(path);
                    Debug.Log("FIXTURE-TEX " + name + " " + tex.format + " " + W + "x" + H + " " + data.Length + " bytes, readable " + tex.isReadable);
                }
                catch (Exception e)
                {
                    Debug.Log("FIXTURE-SKIP " + name + ": " + e.Message);
                }
            }
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "signed-eac-" + bundle);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = bundle, assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.ChunkBasedCompression, BuildTarget.Android);
        if (m == null) throw new Exception("build failed: signed-eac " + bundle);
        Debug.Log("FIXTURE-OK signed-eac " + bundle + " -> " + dir);
    }
}
```

First a probe, in its own 6000.3.26f1 project, with
`-executeMethod BuildSignedEac.Probe` (same command as section 2): all three
variants kept format 42/44 and etc2comp's exact bytes in UnityPy, under
`-nographics` too; `Apply(false, true)` moves the image data to the bundle's
`.resS`, the other two keep it inline. The fixtures use `Apply(false, false)`
(readable, inline, as section 8). Then each editor's project is built once with
`-executeMethod BuildSignedEac.Build`: the log holds two `FIXTURE-TEX` lines,
no `FIXTURE-SKIP`, and `FIXTURE-OK signed-eac android`. The 6000.6.4f1
installation now has the Android module (compare section 13). Copy only
`Build/signed-eac-android/android` to
`fixtures/bundles/editor/<version>/signed-eac/android`.

### Goldens

In this order (`make-goldens.py` skips what `modern-goldens.json` holds):

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-export-goldens.py ...   # the section 17 command
```

`make-modern-goldens.py` lists the 6000.6 bundle and checks its two texture
names and size. UnityPy and AssetStudio agree on all six format 21/22
textures (the UnityPy hash is of Unity's stored row order, bottom row first,
the PNG's of top row first), so no golden has an `oracleNote`. AssetStudio
c37af7d cannot read the 6000.6 bundle (format 23), so it has UnityPy's golden
only. The synthetic signed EAC goldens of `make-goldens.py` stay.

## 22. The `animator` bundles (#303)

`animator/{lz4,lz4-notypetree}/animator` for **2019.4.41f2**, **2020.3.30f1**,
**6000.3.26f1** and **6000.6.4f1**: one bundle per editor and kind, made from
code by an editor script, for the `Avatar`, `AnimatorController`, `Animator`
and `AnimatorOverrideController` readers. Each bundle holds:

- two prefabs, each a generated hierarchy with an `Animator`: `humanoid` (28
  transforms in a T-pose, its humanoid avatar and the controller, culling mode
  1, update mode 1, root motion, stabilize feet) and `generic` (four
  transforms, its generic avatar and the override controller, culling mode 2,
  update mode 2, linear velocity blending);
- `human`, a humanoid `Avatar` from `AvatarBuilder.BuildHumanAvatar` and a
  `HumanDescription` of the generated hierarchy: 27 human bones (two left
  fingers of three bones each), one with limits of its own (`m_Modified`),
  translation DoF on. No model import: the editor accepts it in all four
  editors (`FIXTURE-INFO human avatar valid=True human=True`);
- `generic`, a generic `Avatar` from `AvatarBuilder.BuildGenericAvatar` with
  `Body` as the root motion bone;
- `controller`, an `AnimatorController` built with `UnityEditor.Animations`:
  a parameter of each type (float, int, bool, trigger) with defaults; a base
  layer with states, a 1D blend tree with a nested 1D tree, a freeform
  directional and a freeform cartesian 2D tree, a direct tree, transitions
  with conditions of every mode, an any-state transition, entry and exit
  transitions, a sub-state machine (selector states) and a
  `StateMachineBehaviour` on a state and on the sub-state machine; a second
  layer, additive, weight 0.5, IK pass, masked by an `AvatarMask` with
  transforms and humanoid body parts off (`m_SkeletonMask`, `m_BodyMask`);
- `override`, an `AnimatorOverrideController` of `controller` that overrides
  two of its seven clips;
- the eight clips (`idle`, `walk`, ...: one linear `localPosition.y` curve
  each; their reader is #302's), the two `FixtureBehaviour` MonoBehaviours and
  their MonoScript.

The traps of building a controller from code: blend trees and state
machines must be sub-assets of the controller (`CreateBlendTreeInController`,
`CreateBlendTreeChild`, `AddStateMachine`, `AddLayer` and `AddTransition` add
them, a `new BlendTree()` would not); `controller.layers` returns copies, so
a layer edit is written back with `controller.layers = layers`; and
`AssetDatabase.SaveAssets()` runs before the build.

Each project is a fresh copy named `uar-303-animator-<editor version>`,
holding `ProjectSettings/` and `Packages/` of the section 21 project of the
same editor and only these two files under `Assets/`.

`Assets/Scripts/FixtureBehaviour.cs` (a runtime script, so the behaviour is
a MonoBehaviour in the bundle):

```csharp
using UnityEngine;

// A StateMachineBehaviour for the animator fixtures (#303), so the controller's
// m_StateMachineBehaviours and its behaviour ranges are not empty.
public class FixtureBehaviour : StateMachineBehaviour
{
    public float weight = 0.5f;
}
```

`Assets/Editor/BuildAnimator.cs`:

```csharp
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

// The animator fixtures (#303), created from code: a humanoid and a generic
// hierarchy, each a prefab with an Animator; a humanoid Avatar
// (AvatarBuilder.BuildHumanAvatar) and a generic one (BuildGenericAvatar); an
// AnimatorController with two layers, an AvatarMask, states, a sub-state
// machine, transitions with conditions, 1D, nested, 2D and direct blend trees,
// a parameter of each type and StateMachineBehaviours; and an
// AnimatorOverrideController. The clips are simple generated ones.
public static class BuildAnimator
{
    const string Dir = "Assets/Fixtures/animator";

    // name, parent, local position: a T-pose, root first.
    static readonly (string, string, Vector3)[] Bones =
    {
        ("humanoid", null, Vector3.zero),
        ("Hips", "humanoid", new Vector3(0f, 1f, 0f)),
        ("LeftUpperLeg", "Hips", new Vector3(-0.1f, -0.05f, 0f)),
        ("LeftLowerLeg", "LeftUpperLeg", new Vector3(0f, -0.45f, 0f)),
        ("LeftFoot", "LeftLowerLeg", new Vector3(0f, -0.42f, 0f)),
        ("LeftToes", "LeftFoot", new Vector3(0f, -0.06f, 0.12f)),
        ("RightUpperLeg", "Hips", new Vector3(0.1f, -0.05f, 0f)),
        ("RightLowerLeg", "RightUpperLeg", new Vector3(0f, -0.45f, 0f)),
        ("RightFoot", "RightLowerLeg", new Vector3(0f, -0.42f, 0f)),
        ("RightToes", "RightFoot", new Vector3(0f, -0.06f, 0.12f)),
        ("Spine", "Hips", new Vector3(0f, 0.1f, 0f)),
        ("Chest", "Spine", new Vector3(0f, 0.15f, 0f)),
        ("Neck", "Chest", new Vector3(0f, 0.25f, 0f)),
        ("Head", "Neck", new Vector3(0f, 0.1f, 0f)),
        ("LeftShoulder", "Chest", new Vector3(-0.05f, 0.2f, 0f)),
        ("LeftUpperArm", "LeftShoulder", new Vector3(-0.12f, 0f, 0f)),
        ("LeftLowerArm", "LeftUpperArm", new Vector3(-0.28f, 0f, 0f)),
        ("LeftHand", "LeftLowerArm", new Vector3(-0.25f, 0f, 0f)),
        ("LeftThumbProximal", "LeftHand", new Vector3(-0.03f, 0f, 0.03f)),
        ("LeftThumbIntermediate", "LeftThumbProximal", new Vector3(-0.03f, 0f, 0.01f)),
        ("LeftThumbDistal", "LeftThumbIntermediate", new Vector3(-0.02f, 0f, 0.01f)),
        ("LeftIndexProximal", "LeftHand", new Vector3(-0.08f, 0f, 0.02f)),
        ("LeftIndexIntermediate", "LeftIndexProximal", new Vector3(-0.03f, 0f, 0f)),
        ("LeftIndexDistal", "LeftIndexIntermediate", new Vector3(-0.02f, 0f, 0f)),
        ("RightShoulder", "Chest", new Vector3(0.05f, 0.2f, 0f)),
        ("RightUpperArm", "RightShoulder", new Vector3(0.12f, 0f, 0f)),
        ("RightLowerArm", "RightUpperArm", new Vector3(0.28f, 0f, 0f)),
        ("RightHand", "RightLowerArm", new Vector3(0.25f, 0f, 0f)),
    };

    // Transform name -> HumanBodyBones: every name above but the root and the
    // finger names, whose human names have spaces ("Left Thumb Proximal").
    static readonly HumanBodyBones[] Human =
    {
        HumanBodyBones.Hips, HumanBodyBones.LeftUpperLeg, HumanBodyBones.LeftLowerLeg,
        HumanBodyBones.LeftFoot, HumanBodyBones.LeftToes, HumanBodyBones.RightUpperLeg,
        HumanBodyBones.RightLowerLeg, HumanBodyBones.RightFoot, HumanBodyBones.RightToes,
        HumanBodyBones.Spine, HumanBodyBones.Chest, HumanBodyBones.Neck, HumanBodyBones.Head,
        HumanBodyBones.LeftShoulder, HumanBodyBones.LeftUpperArm, HumanBodyBones.LeftLowerArm,
        HumanBodyBones.LeftHand, HumanBodyBones.LeftThumbProximal,
        HumanBodyBones.LeftThumbIntermediate, HumanBodyBones.LeftThumbDistal,
        HumanBodyBones.LeftIndexProximal, HumanBodyBones.LeftIndexIntermediate,
        HumanBodyBones.LeftIndexDistal, HumanBodyBones.RightShoulder,
        HumanBodyBones.RightUpperArm, HumanBodyBones.RightLowerArm, HumanBodyBones.RightHand,
    };

    public static void Build()
    {
        Directory.CreateDirectory(Dir);
        var clips = new[] { "idle", "walk", "run", "left", "right", "jump", "wave", "override" }
            .Select(MakeClip).ToDictionary(c => c.name);

        var humanoid = Hierarchy(Bones);
        var human = BuildHuman(humanoid);
        var generic = Hierarchy(new (string, string, Vector3)[]
        {
            ("generic", null, Vector3.zero),
            ("Body", "generic", new Vector3(0f, 0.5f, 0f)),
            ("Arm", "Body", new Vector3(0.25f, 0.25f, 0f)),
            ("Tip", "Arm", new Vector3(0.25f, 0f, 0.5f)),
        });
        var genericAvatar = AvatarBuilder.BuildGenericAvatar(generic, "Body");
        genericAvatar.name = "generic";
        AssetDatabase.CreateAsset(genericAvatar, Dir + "/generic.asset");
        Debug.Log("FIXTURE-INFO generic avatar valid=" + genericAvatar.isValid + " human=" + genericAvatar.isHuman);

        var mask = new AvatarMask { name = "upper" };
        mask.AddTransformPath(humanoid.transform, true);
        for (int i = 0; i < mask.transformCount; i++)
            mask.SetTransformActive(i, !mask.GetTransformPath(i).Contains("Leg") && !mask.GetTransformPath(i).Contains("Foot"));
        mask.SetHumanoidBodyPartActive(AvatarMaskBodyPart.LeftLeg, false);
        mask.SetHumanoidBodyPartActive(AvatarMaskBodyPart.RightLeg, false);
        mask.SetHumanoidBodyPartActive(AvatarMaskBodyPart.Root, false);
        AssetDatabase.CreateAsset(mask, Dir + "/upper.mask");

        var controller = MakeController(clips, mask);
        var aoc = new AnimatorOverrideController(controller) { name = "override" };
        var overrides = new List<KeyValuePair<AnimationClip, AnimationClip>>();
        aoc.GetOverrides(overrides);
        for (int i = 0; i < overrides.Count; i++)
        {
            var name = overrides[i].Key.name;
            if (name == "walk") overrides[i] = new KeyValuePair<AnimationClip, AnimationClip>(overrides[i].Key, clips["override"]);
            if (name == "jump") overrides[i] = new KeyValuePair<AnimationClip, AnimationClip>(overrides[i].Key, clips["run"]);
        }
        aoc.ApplyOverrides(overrides);
        AssetDatabase.CreateAsset(aoc, Dir + "/override.overrideController");
        Debug.Log("FIXTURE-INFO override clips=" + overrides.Count);

        var a = humanoid.AddComponent<Animator>();
        a.avatar = human;
        a.runtimeAnimatorController = controller;
        a.applyRootMotion = true;
        a.cullingMode = AnimatorCullingMode.CullUpdateTransforms;
        // 1: AnimatePhysics, named Fixed from 2023.1 (the old name does not compile in 6000).
        a.updateMode = (AnimatorUpdateMode)1;
        a.stabilizeFeet = true;
        var g = generic.AddComponent<Animator>();
        g.avatar = genericAvatar;
        g.runtimeAnimatorController = aoc;
        g.cullingMode = AnimatorCullingMode.CullCompletely;
        g.updateMode = AnimatorUpdateMode.UnscaledTime;
        g.linearVelocityBlending = true;
        PrefabUtility.SaveAsPrefabAsset(humanoid, Dir + "/humanoid.prefab");
        PrefabUtility.SaveAsPrefabAsset(generic, Dir + "/generic.prefab");
        Object.DestroyImmediate(humanoid);
        Object.DestroyImmediate(generic);

        AssetDatabase.SaveAssets();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static GameObject Hierarchy((string, string, Vector3)[] bones)
    {
        var made = new Dictionary<string, Transform>();
        foreach (var (name, parent, pos) in bones)
        {
            var t = new GameObject(name).transform;
            if (parent != null) t.SetParent(made[parent], false);
            t.localPosition = pos;
            made[name] = t;
        }
        return made[bones[0].Item1].gameObject;
    }

    static Avatar BuildHuman(GameObject root)
    {
        var all = root.GetComponentsInChildren<Transform>();
        var desc = new HumanDescription
        {
            skeleton = all.Select(t => new SkeletonBone
            {
                name = t.name, position = t.localPosition, rotation = t.localRotation, scale = t.localScale,
            }).ToArray(),
            human = Human.Select(b => new HumanBone
            {
                boneName = b.ToString(),
                humanName = HumanTrait.BoneName[(int)b],
                limit = new HumanLimit { useDefaultValues = true },
            }).ToArray(),
            upperArmTwist = 0.5f, lowerArmTwist = 0.5f, upperLegTwist = 0.5f, lowerLegTwist = 0.5f,
            armStretch = 0.05f, legStretch = 0.05f, feetSpacing = 0.125f, hasTranslationDoF = true,
        };
        // One bone with its own limits, so a SkeletonBoneLimit is m_Modified.
        var h = desc.human;
        h[14].limit = new HumanLimit
        {
            useDefaultValues = false, min = new Vector3(-60f, -80f, -90f), max = new Vector3(60f, 80f, 45f),
            center = new Vector3(0f, 5f, 0f), axisLength = 0.25f,
        };
        desc.human = h;
        var avatar = AvatarBuilder.BuildHumanAvatar(root, desc);
        avatar.name = "human";
        Debug.Log("FIXTURE-INFO human avatar valid=" + avatar.isValid + " human=" + avatar.isHuman);
        if (!avatar.isValid || !avatar.isHuman) throw new System.Exception("humanoid avatar refused");
        AssetDatabase.CreateAsset(avatar, Dir + "/human.asset");
        return avatar;
    }

    static AnimationClip MakeClip(string name)
    {
        var clip = new AnimationClip { name = name };
        clip.SetCurve("", typeof(Transform), "localPosition.y", AnimationCurve.Linear(0f, 0f, 1f, name.Length * 0.125f));
        AssetDatabase.CreateAsset(clip, Dir + "/" + name + ".anim");
        return clip;
    }

    static AnimatorController MakeController(Dictionary<string, AnimationClip> clips, AvatarMask mask)
    {
        var c = AnimatorController.CreateAnimatorControllerAtPath(Dir + "/controller.controller");
        c.AddParameter("speed", AnimatorControllerParameterType.Float);
        c.AddParameter("dirX", AnimatorControllerParameterType.Float);
        c.AddParameter("dirY", AnimatorControllerParameterType.Float);
        c.AddParameter("count", AnimatorControllerParameterType.Int);
        c.AddParameter("grounded", AnimatorControllerParameterType.Bool);
        c.AddParameter("jump", AnimatorControllerParameterType.Trigger);
        var ps = c.parameters;
        ps[0].defaultFloat = 0.25f;
        ps[3].defaultInt = 3;
        ps[4].defaultBool = true;
        c.parameters = ps;

        var sm = c.layers[0].stateMachine;
        var idle = sm.AddState("idle");
        idle.motion = clips["idle"];
        idle.tag = "rest";
        idle.speed = 1.5f;
        idle.cycleOffset = 0.25f;
        idle.iKOnFeet = true;
        idle.mirror = true;
        idle.writeDefaultValues = false;
        idle.speedParameterActive = true;
        idle.speedParameter = "speed";
        idle.AddStateMachineBehaviour<FixtureBehaviour>();
        sm.defaultState = idle;

        // 1D blend tree on speed, with a nested 1D tree as its third child.
        var loco = c.CreateBlendTreeInController("locomotion", out var tree1d, 0);
        tree1d.blendParameter = "speed";
        tree1d.useAutomaticThresholds = false;
        tree1d.AddChild(clips["walk"], 0f);
        tree1d.AddChild(clips["run"], 1f);
        var nested = tree1d.CreateBlendTreeChild(2f);
        nested.name = "nested";
        nested.blendParameter = "dirX";
        nested.AddChild(clips["left"], -1f);
        nested.AddChild(clips["right"], 1f);

        // Freeform directional 2D on dirX, dirY.
        var strafe = c.CreateBlendTreeInController("strafe", out var tree2d, 0);
        tree2d.blendType = BlendTreeType.FreeformDirectional2D;
        tree2d.blendParameter = "dirX";
        tree2d.blendParameterY = "dirY";
        tree2d.AddChild(clips["idle"], Vector2.zero);
        tree2d.AddChild(clips["left"], new Vector2(-1f, 0f));
        tree2d.AddChild(clips["right"], new Vector2(1f, 0f));
        tree2d.AddChild(clips["walk"], new Vector2(0f, 1f));
        tree2d.AddChild(clips["run"], new Vector2(0f, 2f));

        // Freeform cartesian 2D and a direct tree.
        var aim = c.CreateBlendTreeInController("aim", out var cart, 0);
        cart.blendType = BlendTreeType.FreeformCartesian2D;
        cart.blendParameter = "dirX";
        cart.blendParameterY = "dirY";
        cart.AddChild(clips["left"], new Vector2(-1f, -1f));
        cart.AddChild(clips["right"], new Vector2(1f, -1f));
        cart.AddChild(clips["wave"], new Vector2(0f, 1f));
        var direct = c.CreateBlendTreeInController("direct", out var dtree, 0);
        dtree.blendType = BlendTreeType.Direct;
        dtree.AddChild(clips["walk"]);
        dtree.AddChild(clips["wave"]);
        var children = dtree.children;
        children[0].directBlendParameter = "speed";
        children[1].directBlendParameter = "dirY";
        dtree.children = children;

        var jump = sm.AddState("jump");
        jump.motion = clips["jump"];

        var t = idle.AddTransition(loco);
        t.AddCondition(AnimatorConditionMode.Greater, 0.1f, "speed");
        t.hasExitTime = false;
        t.duration = 0.2f;
        t.interruptionSource = TransitionInterruptionSource.Destination;
        t.orderedInterruption = false;
        t = loco.AddTransition(idle);
        t.AddCondition(AnimatorConditionMode.Less, 0.1f, "speed");
        t.hasExitTime = true;
        t.exitTime = 0.75f;
        t.hasFixedDuration = false;
        t.offset = 0.125f;
        t = idle.AddTransition(strafe);
        t.AddCondition(AnimatorConditionMode.If, 0f, "grounded");
        t.AddCondition(AnimatorConditionMode.Equals, 2f, "count");
        t = strafe.AddTransition(aim);
        t.AddCondition(AnimatorConditionMode.IfNot, 0f, "grounded");
        t.AddCondition(AnimatorConditionMode.NotEqual, 1f, "count");
        t = aim.AddTransition(direct);
        t.AddCondition(AnimatorConditionMode.Greater, 4f, "count");
        t = direct.AddTransition(idle);
        t.AddCondition(AnimatorConditionMode.Less, 1f, "count");
        var any = sm.AddAnyStateTransition(jump);
        any.AddCondition(AnimatorConditionMode.If, 0f, "jump");
        any.canTransitionToSelf = false;
        jump.AddExitTransition().hasExitTime = true;

        // A sub-state machine: entry, exit and behaviour of its own.
        var sub = sm.AddStateMachine("sub");
        var inner = sub.AddState("inner");
        inner.motion = clips["wave"];
        var inner2 = sub.AddState("inner2");
        inner2.motion = clips["left"];
        sub.defaultState = inner;
        var entry = sub.AddEntryTransition(inner2);
        entry.AddCondition(AnimatorConditionMode.Greater, 0.5f, "dirY");
        inner.AddExitTransition().hasExitTime = true;
        inner2.AddExitTransition().hasExitTime = true;
        sub.AddStateMachineBehaviour<FixtureBehaviour>();
        idle.AddTransition(sub).AddCondition(AnimatorConditionMode.Less, -0.5f, "dirY");
        sm.AddEntryTransition(strafe).AddCondition(AnimatorConditionMode.Greater, 5f, "count");

        // The second layer: masked, additive, IK, its own states.
        c.AddLayer("upper");
        var layers = c.layers;
        layers[1].avatarMask = mask;
        layers[1].blendingMode = AnimatorLayerBlendingMode.Additive;
        layers[1].defaultWeight = 0.5f;
        layers[1].iKPass = true;
        var sm1 = layers[1].stateMachine;
        var rest = sm1.AddState("rest");
        var wave = sm1.AddState("wave");
        wave.motion = clips["wave"];
        rest.AddTransition(wave).AddCondition(AnimatorConditionMode.If, 0f, "jump");
        wave.AddTransition(rest).hasExitTime = true;
        sm1.defaultState = rest;
        c.layers = layers;
        EditorUtility.SetDirty(c);
        Debug.Log("FIXTURE-INFO controller layers=" + c.layers.Length + " params=" + c.parameters.Length +
            " clips=" + c.animationClips.Length);
        return c;
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var assets = new[] { "humanoid.prefab", "generic.prefab", "controller.controller",
            "override.overrideController", "human.asset", "generic.asset" };
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "animator", assetNames = assets.Select(a => Dir + "/" + a).ToArray() },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK animator " + name + " -> " + dir);
    }
}
```

The 2019.4.41f2 and 2020.3.30f1 builds ran this script with
`a.updateMode = AnimatorUpdateMode.AnimatePhysics;`, the same value 1: Unity
6000 names it `Fixed` and refuses the old name at compile time, so the 6000.x
projects failed to compile once, before any build, and ran the text above.

Build each project once, with `-executeMethod BuildAnimator.Build` (same
command as section 2). The log must hold two `FIXTURE-OK animator` lines
(`lz4`, `lz4-notypetree`) and these `FIXTURE-INFO` lines:

```
FIXTURE-INFO human avatar valid=True human=True
FIXTURE-INFO generic avatar valid=True human=False
FIXTURE-INFO controller layers=2 params=6 clips=19
FIXTURE-INFO override clips=7
```

Copy only these files:

```
Build/lz4/animator               ->  fixtures/bundles/editor/<editor version>/animator/lz4/animator
Build/lz4-notypetree/animator    ->  fixtures/bundles/editor/<editor version>/animator/lz4-notypetree/animator
```

6000.6.4f1's build without type trees is committed too: UnityPy 1.25.4 reads
it through its own TPK trees, so it is in `modern-goldens.json` with its
typed twin (format 23 has no UnityPy 1.25.3 golden).

Then rerun the goldens, `make-modern-goldens.py` first: `make-goldens.py`
leaves out the fixtures `modern-goldens.json` lists, and UnityPy 1.25.3
cannot read the 6000.6 bundles. Both dump the four classes
(`DUMPED_CLASSES` 90, 91, 95 and 221); no older fixture holds one, so no
other golden changes.

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-tpk-trees.py 43 74 90 91 95 221
```

`make-tpk-trees.py` writes Unity's player trees of the classes from 2019.1,
`fixtures/tpk-trees.json`: AnimationClip (74) for the HumanPose struct the
readers share, and the four classes. Its keys keep the patch release
(`2020.3.43f1`): the Animator's 2023.1 fields came to 2020.3, 2021.3, 2022.1
and 2022.2 in patch releases, which UnityPy's version string, without the
patch, merged. Every fixture object's type tree of the four classes equals
the TPK tree of its version, node for node (flags included).

What the fixtures leave to the TPK layouts of `packages/core/tests/Animator.test.ts`,
which fill every array:

- arrays no fixture object fills: the avatars' `m_AvatarSkeleton.m_AxesArray`,
  `m_RootMotionSkeleton.m_AxesArray` and `m_RootMotionSkeletonPose.m_X`, and
  the controller's `m_PositionValues`, `m_QuaternionValues`, `m_ScaleValues`
  (no parameter is a transform) and, in 6000.3 and 6000.6, `m_EntityIdValues`.
  An `EntityId` node has no children (4 bytes to 6000.4, 8 from 6000.5);
  `readTypeTree()` and the reader read it by that size, an `Int32` or a
  `UInt64` (#307, `packages/core/tests/EntityId.test.ts`), where UnityPy
  reads `{}` of 0 bytes; the fixtures' vectors are empty;
- the Animator layouts of the patch releases no fixture editor is
  (2020.3.43 and 46, 2021.3.16 and 20, 2022.1.24, 2022.2.9). The 2020.3.30f1
  Animator predates the 2020.3 backports; the 6000.x ones have every 2023.1
  field.

The controller field `m_EvaluateTransitionsOnStart` (6000.4+, at the top and
per state machine) is in the 6000.6.4f1 fixtures; 6000.3.26f1 predates it.

A build without type trees writes the generic avatar's `m_TOS` (a map) in
another order than its typed twin; the test compares the stripped objects
with `readTypeTree()` through the TPK tree of their version, and with the
twin with `m_TOS` sorted.

## 23. The `animation` bundles (#302)

`animation/{lz4,lz4-notypetree}/animation` for **2019.4.41f2**, **2020.3.30f1**,
**6000.3.26f1** and **6000.6.4f1**: one bundle per editor and kind, made from
code by an editor script, for the `AnimationClip` reader. The clips are bound
to the paths of a generated hierarchy (`Body`, `Body/Arm`, `Body/Arm/Tip`, not
in the bundle). Each bundle holds six clips, their two sprites (with their
textures) and the `FixtureProps` MonoScript, which the curves pull in:

- `legacy` (`m_Legacy`): position, quaternion rotation (`localRotation`),
  euler rotation (`localEulerAnglesRaw`), scale, two float curves (a
  `SpriteRenderer` colour and a script field) and a sprite swap
  (`AnimationUtility.SetObjectReferenceCurve`: `SetCurve` cannot make a curve
  of object references), a few keys each, and two events;
- `mecanim`: the same curves and events, a root (`""`) position curve and clip
  settings (loop time, loop blend, height from feet, mirror, cycle offset,
  level, orientation offset);
- `dense` and `dense60`: a key every frame (30 per second for 1 s, 60 per
  second for 2 s), `m_UseHighQualityCurve` off;
- `constant`: flat curves only;
- `mixed`: a sparse curve, three keyed every frame and a flat one,
  `m_UseHighQualityCurve` off.

Where each clip's curves land, as UnityPy reads them (the same in all four
editors but for the split count):

| Clip | Curve arrays | Streamed curves | Dense curves | Constant curves | Bindings | Events |
|---|---|---|---|---|---|---|
| `legacy` | all six kinds, `m_MuscleClipSize` 0 | 0 | 0 | 0 | 0 | 2 |
| `mecanim` | emptied | 19 (6000.x: 18, and the sprite swap as `discreteCurveCount` 1) | 0 | 0 | 8, 3 `pptrCurveMapping` | 2 |
| `dense` | emptied | 0 | 3 | 0 | 1 | 0 |
| `dense60` | emptied | 0 | 4 | 0 | 2 | 0 |
| `constant` | emptied | 0 | 0 | 4 | 2 | 0 |
| `mixed` | emptied | 3 | 3 | 1 | 3 | 0 |

So a Mecanim clip empties the curve arrays (`m_RotationCurves`, `m_EulerCurves`,
`m_PositionCurves`, `m_ScaleCurves`, `m_FloatCurves`, `m_PPtrCurves`) and keeps
its events; a legacy clip keeps them and leaves `m_MuscleClip` empty.

The dense part took a probe. The first 2019.4.41f2 copy,
`uar-302-animation-2019.4.41f2`, ran the script below without `LowQuality`:
every curve keyed every frame still went to the streamed part, `m_DenseClip`
empty (`m_CurveCount` 0). With `m_UseHighQualityCurve` off (no API sets it; a
`SerializedObject` does), a second copy, `uar-302-animation-2019.4.41f2-b`, put
them in the dense part; its build is the committed 2019.4.41f2 one, and the
other three editors ran the final script once each. The first copy's bundles
are not committed.

What no fixture clip fills, left to the TPK layouts of
`packages/core/tests/AnimationClip.test.ts`, which fill every array at every
TPK version: `m_CompressedRotationCurves` (a `.anim` asset has no compression
setting) and `m_MuscleClip.m_ValueArrayReferencePose`. Also left to them: the
layouts of the versions no fixture editor is (2022.1 `isIntCurve`, 2022.2 the
curves' `flags` and `isSerializeReferenceCurve`, the split curve count of
2022.3.19, 2023.2.8 and 2023.3, not 2023.1). 6000.3.26f1 and 6000.6.4f1 have
the 2022.x fields and the split count; only 6000.6.4f1 has `GenericBinding`'s
`metaData` (6000.5+).

Each project is a fresh copy named `uar-302-animation-<editor version>`,
holding `ProjectSettings/` and `Packages/` of the section 22 project of the
same editor and only these two files under `Assets/`.

`Assets/Scripts/FixtureProps.cs` (a runtime script, so its field is animatable):

```csharp
using UnityEngine;

// A MonoBehaviour with an animatable field for the animation fixtures (#302),
// so a float curve and its binding name a script.
public class FixtureProps : MonoBehaviour
{
    public float amount;
}
```

`Assets/Editor/BuildAnimation.cs`:

```csharp
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

// The animation fixtures (#302), created from code: AnimationClips bound to the
// paths of a generated hierarchy (rig/Body/Arm/Tip), with position, quaternion
// and euler rotation, scale, float (a SpriteRenderer colour and a script field)
// and PPtr (sprite swap) curves, and events. One legacy clip; Mecanim clips
// whose curves land in the streamed (sparse keys), dense (a key every frame)
// and constant (flat) parts of m_MuscleClip.
public static class BuildAnimation
{
    const string Dir = "Assets/Fixtures/animation";

    public static void Build()
    {
        Directory.CreateDirectory(Dir);
        var rig = new GameObject("rig").transform;
        var body = Child(rig, "Body");
        var arm = Child(body, "Arm");
        var tip = Child(arm, "Tip");
        body.gameObject.AddComponent<FixtureProps>();
        tip.gameObject.AddComponent<SpriteRenderer>();
        var paths = new[] { body, arm, tip }.Select(t => AnimationUtility.CalculateTransformPath(t, rig)).ToArray();
        string b = paths[0], a = paths[1], t3 = paths[2];
        var red = Png("red", new Color32(255, 0, 0, 255));
        var blue = Png("blue", new Color32(0, 0, 255, 255));

        // legacy: every curve kind, sparse keys, events; m_Legacy keeps the curve arrays.
        var legacy = NewClip("legacy", true);
        legacy.wrapMode = WrapMode.Loop;
        Sparse(legacy, b, a, t3, red, blue);
        Events(legacy, red);
        Save(legacy);

        // mecanim: the same curves, events and clip settings, plus a root curve.
        var mecanim = NewClip("mecanim", false);
        Sparse(mecanim, b, a, t3, red, blue);
        mecanim.SetCurve("", typeof(Transform), "localPosition.z", Keys(0f, 0f, 0.5f, 0.75f, 1f, 2f));
        Events(mecanim, red);
        var s = AnimationUtility.GetAnimationClipSettings(mecanim);
        s.loopTime = true;
        s.loopBlend = true;
        s.loopBlendOrientation = true;
        s.loopBlendPositionY = true;
        s.keepOriginalPositionY = true;
        s.heightFromFeet = true;
        s.mirror = true;
        s.cycleOffset = 0.25f;
        s.level = 0.125f;
        s.orientationOffsetY = 15f;
        AnimationUtility.SetAnimationClipSettings(mecanim, s);
        Save(mecanim);

        // dense: a key every frame (30 per second for 1 s, then 60 for 2 s), and
        // m_UseHighQualityCurve off.
        var dense = NewClip("dense", false);
        dense.frameRate = 30f;
        foreach (var c in new[] { "x", "y", "z" })
            dense.SetCurve(b, typeof(Transform), "localPosition." + c, PerFrame(30f, 1f, c.Length + c[0]));
        LowQuality(dense);
        Save(dense);
        var dense60 = NewClip("dense60", false);
        dense60.frameRate = 60f;
        foreach (var c in new[] { "x", "y", "z" })
            dense60.SetCurve(a, typeof(Transform), "localScale." + c, PerFrame(60f, 2f, c[0]));
        dense60.SetCurve(b, typeof(FixtureProps), "amount", PerFrame(60f, 2f, 7));
        LowQuality(dense60);
        Save(dense60);

        // constant: flat curves only.
        var constant = NewClip("constant", false);
        foreach (var c in new[] { "x", "y", "z" })
            constant.SetCurve(b, typeof(Transform), "localPosition." + c, Flat(0.5f + c[0] - 'x', 1f));
        constant.SetCurve(t3, typeof(SpriteRenderer), "m_Color.a", Flat(0.75f, 1f));
        Save(constant);

        // mixed: one clip with streamed, dense and constant curves, m_UseHighQualityCurve off.
        var mixed = NewClip("mixed", false);
        mixed.frameRate = 30f;
        mixed.SetCurve(b, typeof(Transform), "localPosition.x", Keys(0f, 0f, 0.4f, 1f, 1f, -0.5f));
        mixed.SetCurve(a, typeof(Transform), "localScale.x", PerFrame(30f, 1f, 3));
        mixed.SetCurve(a, typeof(Transform), "localScale.y", PerFrame(30f, 1f, 4));
        mixed.SetCurve(a, typeof(Transform), "localScale.z", PerFrame(30f, 1f, 5));
        mixed.SetCurve(b, typeof(FixtureProps), "amount", Flat(2.5f, 1f));
        LowQuality(mixed);
        Save(mixed);

        Object.DestroyImmediate(rig.gameObject);
        AssetDatabase.SaveAssets();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static Transform Child(Transform parent, string name)
    {
        var t = new GameObject(name).transform;
        t.SetParent(parent, false);
        return t;
    }

    static AnimationClip NewClip(string name, bool legacy)
    {
        return new AnimationClip { name = name, legacy = legacy };
    }

    // m_UseHighQualityCurve off (no API sets it): the build may then sample a
    // curve into the dense part instead of streaming its keys.
    static void LowQuality(AnimationClip clip)
    {
        var so = new SerializedObject(clip);
        so.FindProperty("m_UseHighQualityCurve").boolValue = false;
        so.ApplyModifiedPropertiesWithoutUndo();
    }

    static void Save(AnimationClip clip)
    {
        AssetDatabase.CreateAsset(clip, Dir + "/" + clip.name + ".anim");
        Debug.Log("FIXTURE-INFO clip " + clip.name + " legacy=" + clip.legacy +
            " curves=" + AnimationUtility.GetCurveBindings(clip).Length +
            " pptr=" + AnimationUtility.GetObjectReferenceCurveBindings(clip).Length +
            " events=" + AnimationUtility.GetAnimationEvents(clip).Length);
    }

    // Every curve kind with a few keys: position, quaternion rotation, euler
    // rotation, scale, two float curves and a sprite swap.
    static void Sparse(AnimationClip clip, string b, string a, string t, Sprite red, Sprite blue)
    {
        clip.SetCurve(b, typeof(Transform), "localPosition.x", Keys(0f, 0f, 0.5f, 1f, 1f, 0.25f));
        clip.SetCurve(b, typeof(Transform), "localPosition.y", Keys(0f, 1f, 0.25f, 1.5f, 1f, 1f));
        clip.SetCurve(b, typeof(Transform), "localPosition.z", Keys(0f, 0f, 1f, -1f));
        var q = Quaternion.Euler(0f, 90f, 30f);
        clip.SetCurve(a, typeof(Transform), "localRotation.x", Keys(0f, 0f, 1f, q.x));
        clip.SetCurve(a, typeof(Transform), "localRotation.y", Keys(0f, 0f, 1f, q.y));
        clip.SetCurve(a, typeof(Transform), "localRotation.z", Keys(0f, 0f, 1f, q.z));
        clip.SetCurve(a, typeof(Transform), "localRotation.w", Keys(0f, 1f, 1f, q.w));
        foreach (var c in new[] { "x", "y", "z" })
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(t, typeof(Transform), "localEulerAnglesRaw." + c),
                Keys(0f, 0f, 0.5f, 45f + c[0] - 'x', 1f, 90f));
        clip.SetCurve(b, typeof(Transform), "localScale.x", Keys(0f, 1f, 0.5f, 2f, 1f, 1f));
        clip.SetCurve(b, typeof(Transform), "localScale.y", Keys(0f, 1f, 1f, 0.5f));
        clip.SetCurve(b, typeof(Transform), "localScale.z", Keys(0f, 1f, 1f, 1.5f));
        clip.SetCurve(t, typeof(SpriteRenderer), "m_Color.a", Keys(0f, 1f, 0.5f, 0.25f, 1f, 1f));
        clip.SetCurve(b, typeof(FixtureProps), "amount", Keys(0f, 0f, 0.75f, 3f, 1f, 1f));
        AnimationUtility.SetObjectReferenceCurve(clip, EditorCurveBinding.PPtrCurve(t, typeof(SpriteRenderer), "m_Sprite"),
            new[]
            {
                new ObjectReferenceKeyframe { time = 0f, value = red },
                new ObjectReferenceKeyframe { time = 0.5f, value = blue },
                new ObjectReferenceKeyframe { time = 1f, value = red },
            });
    }

    static void Events(AnimationClip clip, Sprite red)
    {
        AnimationUtility.SetAnimationEvents(clip, new[]
        {
            new AnimationEvent { time = 0.25f, functionName = "Step", stringParameter = "left", floatParameter = 0.5f, intParameter = 3 },
            new AnimationEvent
            {
                time = 0.75f, functionName = "Swap", objectReferenceParameter = red,
                messageOptions = SendMessageOptions.DontRequireReceiver,
            },
        });
    }

    // (time, value) pairs.
    static AnimationCurve Keys(params float[] tv)
    {
        var c = new AnimationCurve();
        for (int i = 0; i < tv.Length; i += 2) c.AddKey(tv[i], tv[i + 1]);
        return c;
    }

    static AnimationCurve PerFrame(float fps, float seconds, int seed)
    {
        int n = Mathf.RoundToInt(fps * seconds);
        var keys = new Keyframe[n + 1];
        for (int i = 0; i <= n; i++)
            keys[i] = new Keyframe(i / fps, Mathf.Sin(i * 0.37f + seed) * (1f + 0.1f * (i % 3)));
        return new AnimationCurve(keys);
    }

    static AnimationCurve Flat(float value, float seconds)
    {
        return new AnimationCurve(new Keyframe(0f, value), new Keyframe(seconds, value));
    }

    static Sprite Png(string name, Color32 color)
    {
        var path = Dir + "/" + name + ".png";
        var tex = new Texture2D(4, 4, TextureFormat.RGBA32, false);
        tex.SetPixels32(Enumerable.Repeat(color, 16).ToArray());
        File.WriteAllBytes(path, tex.EncodeToPNG());
        AssetDatabase.ImportAsset(path);
        var imp = (TextureImporter)AssetImporter.GetAtPath(path);
        imp.textureType = TextureImporterType.Sprite;
        imp.spriteImportMode = SpriteImportMode.Single;
        imp.mipmapEnabled = false;
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.SaveAndReimport();
        return AssetDatabase.LoadAssetAtPath<Sprite>(path);
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var assets = new[] { "legacy", "mecanim", "dense", "dense60", "constant", "mixed" };
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "animation", assetNames = assets.Select(x => Dir + "/" + x + ".anim").ToArray() },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK animation " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildAnimation.Build` (same
command as section 2). The log must hold two `FIXTURE-OK animation` lines
(`lz4`, `lz4-notypetree`) and these `FIXTURE-INFO` lines:

```
FIXTURE-INFO clip legacy legacy=True curves=15 pptr=1 events=2
FIXTURE-INFO clip mecanim legacy=False curves=18 pptr=1 events=2
FIXTURE-INFO clip dense legacy=False curves=3 pptr=0 events=0
FIXTURE-INFO clip dense60 legacy=False curves=4 pptr=0 events=0
FIXTURE-INFO clip constant legacy=False curves=4 pptr=0 events=0
FIXTURE-INFO clip mixed legacy=False curves=7 pptr=0 events=0
```

Copy only these files:

```
Build/lz4/animation               ->  fixtures/bundles/editor/<editor version>/animation/lz4/animation
Build/lz4-notypetree/animation    ->  fixtures/bundles/editor/<editor version>/animation/lz4-notypetree/animation
```

6000.6.4f1's build without type trees is committed too, in
`modern-goldens.json` with its typed twin, as in section 22.

Then rerun the goldens, `make-modern-goldens.py` first. Both now dump
`AnimationClip` (`DUMPED_CLASSES` 74), so the section 22 animator bundles'
entries gain their eight clips' dumps (and `make-modern-goldens.py`'s
evidence counts them); no other entry changes. `make-modern-goldens.py`
checks the table above for the 6000.6 bundles (its `evidence`).

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

`make-export-goldens.py` (section 17) adds the two sprites and their textures
of each bundle: AssetStudio's PNGs for 2019.4, 2020.3 and 6000.3.26f1; for
6000.6.4f1 it loads only the textures of the build without type trees (it
fails on format 23's type trees), and records why for the rest.

`fixtures/tpk-trees.json` already has AnimationClip's trees (section 22); every
fixture clip's type tree equals the TPK tree of its version.

## 24. The `scene` bundles (#305)

`scene/{lz4,lz4-notypetree}/scene` for **2019.4.41f2**, **2020.3.30f1**,
**6000.3.26f1** and **6000.6.4f1**: one bundle per editor and kind, made from
code by an editor script, for the `GameObject`, `Transform`, `MeshFilter`,
`MeshRenderer` and `SkinnedMeshRenderer` readers, and as the oracle fixture of
#304's clip curves. Each bundle holds:

- `scene`, a prefab of ten GameObjects: the root `scene` with an `Animator`
  (the generic avatar, the controller, culling mode 1); `Armature` with a
  chain of five bones (`Hips`, `Spine`, `Chest`, `Neck`, `Head`), each at the
  pose its bind pose inverts; `Skin`, a `SkinnedMeshRenderer` of the #285
  `skinned` mesh (section 20) over the five bones, root bone `Hips`, blend
  shape weights 25 and 60, quality 2 bones, update when offscreen, its own
  bounds, two-sided shadows, probe anchor `Chest`, sorting order 3, priority
  5, rendering layer mask 3; `Prop`, static, layer 4, tag `Player`, rotated
  and scaled, with a `MeshFilter` of the same mesh and a `MeshRenderer` with
  two materials, sorting order -2; and `Hidden`, inactive, under `Prop`;
- `humanoid`, a prefab of the section 22 T-pose without fingers (22
  GameObjects) with an `Animator` on its humanoid avatar;
- `generic` (`AvatarBuilder.BuildGenericAvatar` of `scene`, root motion bone
  `Hips`) and `human` (`BuildHumanAvatar`, every transform but the root a
  human bone);
- `controller`, three states playing the three clips in turn;
- three clips: `move`, curves on child paths (`Armature/Hips` position,
  `Armature/Hips/Spine` quaternion rotation, `Armature/Hips/Spine/Chest`
  scale, `Prop`'s `m_IsActive`), so their path hashes resolve through the
  generic avatar's `m_TOS`; `smile`, the `Skin` renderer's two blend shape
  weights (`blendShape.smile`, `blendShape.blink`); and `muscle`, a humanoid
  clip of three muscles (`Spine Front-Back`, `Left Arm Down-Up`,
  `Right Forearm Stretch`) and `RootT.y` (`SetCurve("", typeof(Animator), ...)`);
- the `skinned` Mesh.

The renderers' material, an `Unlit/Color` one, goes in a bundle of its own,
`scene-material`, which is not committed: the scene bundle holds an external
pointer to it (`m_FileID` 1) and no shader. The script sets the
`MeshRenderer`'s `additionalVertexStreams`, but the built object's
`m_AdditionalVertexStreams` is a null pointer in all four editors.

Each project is a fresh copy named `uar-305-scene-<editor version>`, holding
`ProjectSettings/` and `Packages/` of the section 22 project of the same
editor and only this file under `Assets/`.

`Assets/Editor/BuildScene.cs`:

```csharp
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.Rendering;

// The scene fixtures (#305), created from code: a prefab "scene" whose root has
// an Animator (a generic Avatar, a controller), a five-bone hierarchy skinning
// a SkinnedMeshRenderer (the #285 skinned mesh, blend shape weights), a static
// child with a MeshFilter and a MeshRenderer, and an inactive child; a prefab
// "humanoid" (the #303 T-pose with a humanoid Avatar). Clips for #304: "move"
// (curves on child paths), "smile" (blend shape weights) and "muscle"
// (humanoid muscle curves). The renderers' material is in a bundle of its own,
// so the scene bundle holds an external reference and no shader.
public static class BuildScene
{
    const string Dir = "Assets/Fixtures/scene";

    // name, parent, local position: a T-pose, root first (section 22).
    static readonly (string, string, Vector3)[] Bones =
    {
        ("humanoid", null, Vector3.zero),
        ("Hips", "humanoid", new Vector3(0f, 1f, 0f)),
        ("LeftUpperLeg", "Hips", new Vector3(-0.1f, -0.05f, 0f)),
        ("LeftLowerLeg", "LeftUpperLeg", new Vector3(0f, -0.45f, 0f)),
        ("LeftFoot", "LeftLowerLeg", new Vector3(0f, -0.42f, 0f)),
        ("LeftToes", "LeftFoot", new Vector3(0f, -0.06f, 0.12f)),
        ("RightUpperLeg", "Hips", new Vector3(0.1f, -0.05f, 0f)),
        ("RightLowerLeg", "RightUpperLeg", new Vector3(0f, -0.45f, 0f)),
        ("RightFoot", "RightLowerLeg", new Vector3(0f, -0.42f, 0f)),
        ("RightToes", "RightFoot", new Vector3(0f, -0.06f, 0.12f)),
        ("Spine", "Hips", new Vector3(0f, 0.1f, 0f)),
        ("Chest", "Spine", new Vector3(0f, 0.15f, 0f)),
        ("Neck", "Chest", new Vector3(0f, 0.25f, 0f)),
        ("Head", "Neck", new Vector3(0f, 0.1f, 0f)),
        ("LeftShoulder", "Chest", new Vector3(-0.05f, 0.2f, 0f)),
        ("LeftUpperArm", "LeftShoulder", new Vector3(-0.12f, 0f, 0f)),
        ("LeftLowerArm", "LeftUpperArm", new Vector3(-0.28f, 0f, 0f)),
        ("LeftHand", "LeftLowerArm", new Vector3(-0.25f, 0f, 0f)),
        ("RightShoulder", "Chest", new Vector3(0.05f, 0.2f, 0f)),
        ("RightUpperArm", "RightShoulder", new Vector3(0.12f, 0f, 0f)),
        ("RightLowerArm", "RightUpperArm", new Vector3(0.28f, 0f, 0f)),
        ("RightHand", "RightLowerArm", new Vector3(0.25f, 0f, 0f)),
    };

    public static void Build()
    {
        // Keep every vertex channel of the skinned mesh.
        PlayerSettings.stripUnusedMeshComponents = false;
        Directory.CreateDirectory(Dir);

        var mesh = Skinned("skinned");
        AssetDatabase.CreateAsset(mesh, Dir + "/skinned.asset");
        var shader = Shader.Find("Unlit/Color") ?? Shader.Find("Hidden/InternalErrorShader");
        var mat = new Material(shader) { name = "mat" };
        AssetDatabase.CreateAsset(mat, Dir + "/mat.mat");

        var move = new AnimationClip { name = "move" };
        move.SetCurve("Armature/Hips", typeof(Transform), "localPosition.x", Keys(0f, 0f, 0.5f, 0.25f, 1f, 0f));
        move.SetCurve("Armature/Hips", typeof(Transform), "localPosition.y", Keys(0f, 0f, 1f, 0.5f));
        move.SetCurve("Armature/Hips", typeof(Transform), "localPosition.z", Keys(0f, 0.1f, 1f, -0.1f));
        var q = Quaternion.Euler(0f, 0f, 30f);
        move.SetCurve("Armature/Hips/Spine", typeof(Transform), "localRotation.x", Keys(0f, 0f, 1f, q.x));
        move.SetCurve("Armature/Hips/Spine", typeof(Transform), "localRotation.y", Keys(0f, 0f, 1f, q.y));
        move.SetCurve("Armature/Hips/Spine", typeof(Transform), "localRotation.z", Keys(0f, 0f, 1f, q.z));
        move.SetCurve("Armature/Hips/Spine", typeof(Transform), "localRotation.w", Keys(0f, 1f, 1f, q.w));
        move.SetCurve("Armature/Hips/Spine/Chest", typeof(Transform), "localScale.x", Keys(0f, 1f, 1f, 1.5f));
        move.SetCurve("Armature/Hips/Spine/Chest", typeof(Transform), "localScale.y", Keys(0f, 1f, 0.5f, 0.75f, 1f, 1f));
        move.SetCurve("Armature/Hips/Spine/Chest", typeof(Transform), "localScale.z", Keys(0f, 1f, 1f, 1f));
        move.SetCurve("Prop", typeof(GameObject), "m_IsActive", Keys(0f, 1f, 0.5f, 0f, 1f, 1f));
        AssetDatabase.CreateAsset(move, Dir + "/move.anim");

        var smile = new AnimationClip { name = "smile" };
        smile.SetCurve("Skin", typeof(SkinnedMeshRenderer), "blendShape.smile", Keys(0f, 0f, 0.5f, 100f, 1f, 25f));
        smile.SetCurve("Skin", typeof(SkinnedMeshRenderer), "blendShape.blink", Keys(0f, 0f, 0.25f, 100f, 0.5f, 0f));
        AssetDatabase.CreateAsset(smile, Dir + "/smile.anim");

        var muscle = new AnimationClip { name = "muscle" };
        muscle.SetCurve("", typeof(Animator), "Spine Front-Back", Keys(0f, 0f, 0.5f, 0.5f, 1f, -0.25f));
        muscle.SetCurve("", typeof(Animator), "Left Arm Down-Up", Keys(0f, 0.25f, 1f, 0.75f));
        muscle.SetCurve("", typeof(Animator), "Right Forearm Stretch", Keys(0f, 1f, 1f, 0.5f));
        muscle.SetCurve("", typeof(Animator), "RootT.y", Keys(0f, 1f, 1f, 1.05f));
        AssetDatabase.CreateAsset(muscle, Dir + "/muscle.anim");
        foreach (var c in new[] { move, smile, muscle })
            Debug.Log("FIXTURE-INFO clip " + c.name + " legacy=" + c.legacy + " human=" + c.humanMotion +
                " curves=" + AnimationUtility.GetCurveBindings(c).Length);

        var controller = AnimatorController.CreateAnimatorControllerAtPath(Dir + "/controller.controller");
        var sm = controller.layers[0].stateMachine;
        var sMove = sm.AddState("move");
        sMove.motion = move;
        var sSmile = sm.AddState("smile");
        sSmile.motion = smile;
        var sMuscle = sm.AddState("muscle");
        sMuscle.motion = muscle;
        sm.defaultState = sMove;
        sMove.AddTransition(sSmile).hasExitTime = true;
        sSmile.AddTransition(sMuscle).hasExitTime = true;
        sMuscle.AddTransition(sMove).hasExitTime = true;
        EditorUtility.SetDirty(controller);

        var scene = Scene(mesh, mat);
        var generic = AvatarBuilder.BuildGenericAvatar(scene, "Hips");
        generic.name = "generic";
        AssetDatabase.CreateAsset(generic, Dir + "/generic.asset");
        Debug.Log("FIXTURE-INFO generic avatar valid=" + generic.isValid + " human=" + generic.isHuman);
        var a = scene.AddComponent<Animator>();
        a.avatar = generic;
        a.runtimeAnimatorController = controller;
        a.cullingMode = AnimatorCullingMode.CullUpdateTransforms;
        Debug.Log("FIXTURE-INFO scene transforms=" + scene.GetComponentsInChildren<Transform>(true).Length);

        var humanoid = Hierarchy(Bones);
        var human = BuildHuman(humanoid);
        var h = humanoid.AddComponent<Animator>();
        h.avatar = human;
        h.runtimeAnimatorController = controller;

        PrefabUtility.SaveAsPrefabAsset(scene, Dir + "/scene.prefab");
        PrefabUtility.SaveAsPrefabAsset(humanoid, Dir + "/humanoid.prefab");
        Object.DestroyImmediate(scene);
        Object.DestroyImmediate(humanoid);

        AssetDatabase.SaveAssets();
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static GameObject Scene(Mesh mesh, Material mat)
    {
        var root = new GameObject("scene");
        var armature = new GameObject("Armature").transform;
        armature.SetParent(root.transform, false);
        // Five bones in a chain, each at the pose its bindpose inverts.
        var names = new[] { "Hips", "Spine", "Chest", "Neck", "Head" };
        var bones = new Transform[5];
        for (int i = 0; i < 5; i++)
        {
            bones[i] = new GameObject(names[i]).transform;
            bones[i].SetParent(i == 0 ? armature : bones[i - 1], false);
            bones[i].position = new Vector3(0f, -0.75f * i, 0.1f * i);
            bones[i].rotation = Quaternion.Euler(0f, 0f, 15f * i);
        }

        var skin = new GameObject("Skin");
        skin.transform.SetParent(root.transform, false);
        var smr = skin.AddComponent<SkinnedMeshRenderer>();
        smr.sharedMesh = mesh;
        smr.bones = bones;
        smr.rootBone = bones[0];
        smr.sharedMaterials = new[] { mat };
        smr.quality = SkinQuality.Bone2;
        smr.updateWhenOffscreen = true;
        smr.skinnedMotionVectors = false;
        smr.localBounds = new Bounds(new Vector3(0.5f, 1.5f, 0f), new Vector3(1.5f, 3f, 1.25f));
        smr.SetBlendShapeWeight(0, 25f);
        smr.SetBlendShapeWeight(1, 60f);
        smr.shadowCastingMode = ShadowCastingMode.TwoSided;
        smr.receiveShadows = false;
        smr.lightProbeUsage = LightProbeUsage.Off;
        smr.reflectionProbeUsage = ReflectionProbeUsage.Simple;
        smr.probeAnchor = bones[2];
        smr.sortingOrder = 3;
        smr.rendererPriority = 5;
        smr.renderingLayerMask = 3u;
        smr.allowOcclusionWhenDynamic = false;
        smr.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;

        var prop = new GameObject("Prop");
        prop.transform.SetParent(root.transform, false);
        prop.transform.localPosition = new Vector3(2f, 0f, 0f);
        prop.transform.localRotation = Quaternion.Euler(0f, 30f, 0f);
        prop.transform.localScale = new Vector3(2f, 0.5f, 1f);
        prop.layer = 4;
        prop.tag = "Player";
        prop.isStatic = true;
        prop.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = prop.AddComponent<MeshRenderer>();
        mr.sharedMaterials = new[] { mat, mat };
        mr.additionalVertexStreams = mesh;
        mr.sortingOrder = -2;

        var hidden = new GameObject("Hidden");
        hidden.transform.SetParent(prop.transform, false);
        hidden.SetActive(false);
        return root;
    }

    static GameObject Hierarchy((string, string, Vector3)[] bones)
    {
        var made = new Dictionary<string, Transform>();
        foreach (var (name, parent, pos) in bones)
        {
            var t = new GameObject(name).transform;
            if (parent != null) t.SetParent(made[parent], false);
            t.localPosition = pos;
            made[name] = t;
        }
        return made[bones[0].Item1].gameObject;
    }

    static Avatar BuildHuman(GameObject root)
    {
        var all = root.GetComponentsInChildren<Transform>();
        var desc = new HumanDescription
        {
            skeleton = all.Select(t => new SkeletonBone
            {
                name = t.name, position = t.localPosition, rotation = t.localRotation, scale = t.localScale,
            }).ToArray(),
            // Every bone but the root: the transform names are HumanBodyBones names.
            human = all.Skip(1).Select(t =>
            {
                var b = (HumanBodyBones)System.Enum.Parse(typeof(HumanBodyBones), t.name);
                return new HumanBone
                {
                    boneName = t.name, humanName = HumanTrait.BoneName[(int)b],
                    limit = new HumanLimit { useDefaultValues = true },
                };
            }).ToArray(),
            upperArmTwist = 0.5f, lowerArmTwist = 0.5f, upperLegTwist = 0.5f, lowerLegTwist = 0.5f,
            armStretch = 0.05f, legStretch = 0.05f, feetSpacing = 0f, hasTranslationDoF = false,
        };
        var avatar = AvatarBuilder.BuildHumanAvatar(root, desc);
        avatar.name = "human";
        Debug.Log("FIXTURE-INFO human avatar valid=" + avatar.isValid + " human=" + avatar.isHuman);
        if (!avatar.isValid || !avatar.isHuman) throw new System.Exception("humanoid avatar refused");
        AssetDatabase.CreateAsset(avatar, Dir + "/human.asset");
        return avatar;
    }

    static AnimationCurve Keys(params float[] tv)
    {
        var keys = new Keyframe[tv.Length / 2];
        for (int i = 0; i < keys.Length; i++) keys[i] = new Keyframe(tv[2 * i], tv[2 * i + 1]);
        return new AnimationCurve(keys);
    }

    // The #285 "skinned" mesh (section 20), unchanged.
    static BoneWeight Weight(params float[] pairs)
    {
        var w = new BoneWeight();
        int n = pairs.Length / 2;
        if (n > 0) { w.boneIndex0 = (int)pairs[0]; w.weight0 = pairs[1]; }
        if (n > 1) { w.boneIndex1 = (int)pairs[2]; w.weight1 = pairs[3]; }
        if (n > 2) { w.boneIndex2 = (int)pairs[4]; w.weight2 = pairs[5]; }
        if (n > 3) { w.boneIndex3 = (int)pairs[6]; w.weight3 = pairs[7]; }
        return w;
    }

    static Mesh Skinned(string name)
    {
        var mesh = new Mesh { name = name };
        mesh.indexFormat = IndexFormat.UInt32;
        mesh.vertices = new[]
        {
            new Vector3(0f, 0f, 0f), new Vector3(1f, 0f, 0.125f), new Vector3(0f, 1f, -0.25f),
            new Vector3(1f, 1f, 0.5f), new Vector3(0f, 2f, 0.75f), new Vector3(1f, 2f, -0.5f),
            new Vector3(0.25f, 3f, 0f), new Vector3(1.5f, 3f, 0.375f),
        };
        mesh.normals = new[]
        {
            new Vector3(0f, 0f, -1f), new Vector3(0.6f, 0f, -0.8f), new Vector3(0f, 0.6f, -0.8f),
            new Vector3(0f, 1f, 0f), new Vector3(-0.8f, 0f, -0.6f), new Vector3(1f, 0f, 0f),
            new Vector3(0f, -0.8f, -0.6f), new Vector3(0f, 0f, 1f),
        };
        mesh.tangents = new[]
        {
            new Vector4(1f, 0f, 0f, 1f), new Vector4(0.8f, 0f, 0.6f, 1f), new Vector4(1f, 0f, 0f, -1f),
            new Vector4(0f, 0f, 1f, 1f), new Vector4(0.6f, 0f, -0.8f, -1f), new Vector4(0f, 1f, 0f, 1f),
            new Vector4(1f, 0f, 0f, 1f), new Vector4(0f, 1f, 0f, -1f),
        };
        mesh.colors32 = new[]
        {
            new Color32(255, 0, 0, 255), new Color32(0, 255, 0, 255), new Color32(0, 0, 255, 255),
            new Color32(255, 255, 0, 128), new Color32(0, 255, 255, 64), new Color32(255, 0, 255, 0),
            new Color32(12, 34, 56, 78), new Color32(200, 150, 100, 50),
        };
        mesh.uv = new[]
        {
            new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 0.25f), new Vector2(1f, 0.25f),
            new Vector2(0f, 0.5f), new Vector2(1f, 0.5f), new Vector2(0.125f, 0.75f), new Vector2(0.875f, 1f),
        };
        mesh.uv2 = new[]
        {
            new Vector2(0.5f, 0.5f), new Vector2(0.75f, 0.5f), new Vector2(0.5f, 0.625f), new Vector2(0.75f, 0.625f),
            new Vector2(0.5f, 0.75f), new Vector2(0.75f, 0.75f), new Vector2(0.5f, 0.875f), new Vector2(0.75f, 1f),
        };
        mesh.triangles = new[] { 0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5, 5, 6, 7 };
        mesh.boneWeights = new[]
        {
            Weight(0, 1f),
            Weight(1, 0.75f, 0, 0.25f),
            Weight(2, 0.5f, 1, 0.5f),
            Weight(3, 0.5f, 2, 0.3f, 1, 0.2f),
            Weight(4, 0.6f, 2, 0.25f, 3, 0.15f),
            Weight(3, 0.4f, 2, 0.3f, 1, 0.2f, 0, 0.1f),
            Weight(1, 0.35f, 0, 0.3f, 4, 0.2f, 2, 0.15f),
            Weight(4, 0.7f, 3, 0.1f, 0, 0.1f, 1, 0.1f),
        };
        mesh.bindposes = Enumerable.Range(0, 5)
            .Select(i => Matrix4x4.TRS(new Vector3(0f, -0.75f * i, 0.1f * i),
                Quaternion.Euler(0f, 0f, 15f * i), Vector3.one).inverse)
            .ToArray();
        AddShape(mesh, "smile", new[] { 50f, 100f }, 4);
        AddShape(mesh, "blink", new[] { 25f, 50f, 100f }, 0);
        Debug.Log("FIXTURE-INFO " + name + " bonesPerVertex=" + string.Join(",", mesh.GetBonesPerVertex().ToArray()) +
            " shapes=" + mesh.blendShapeCount + " indexFormat=" + mesh.indexFormat);
        return mesh;
    }

    static void AddShape(Mesh mesh, string shape, float[] weights, int first)
    {
        for (int f = 0; f < weights.Length; f++)
        {
            var dv = new Vector3[8];
            var dn = new Vector3[8];
            var dt = new Vector3[8];
            float k = (f + 1) / (float)weights.Length;
            for (int v = first; v < first + 4; v++)
            {
                dv[v] = new Vector3(0.125f * k, 0.25f * k * (v - first + 1), -0.0625f * k);
                dn[v] = new Vector3(0f, 0.5f * k, -0.25f * k);
                dt[v] = new Vector3(-0.25f * k, 0f, 0.125f * (v - first + 1));
            }
            mesh.AddBlendShapeFrame(shape, weights[f], dv, dn, dt);
        }
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var assets = new[] { "scene.prefab", "humanoid.prefab", "controller.controller", "generic.asset",
            "human.asset", "skinned.asset", "move.anim", "smile.anim", "muscle.anim" };
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "scene", assetNames = assets.Select(x => Dir + "/" + x).ToArray() },
            // Not committed: it holds the material and its shader, so "scene" refers to them.
            new AssetBundleBuild { assetBundleName = "scene-material", assetNames = new[] { Dir + "/mat.mat" } },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK scene " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildScene.Build` (same command
as section 2). The log must hold two `FIXTURE-OK scene` lines (`lz4`,
`lz4-notypetree`) and these `FIXTURE-INFO` lines:

```
FIXTURE-INFO skinned bonesPerVertex=1,2,2,3,3,4,4,4 shapes=2 indexFormat=UInt32
FIXTURE-INFO clip move legacy=False human=False curves=11
FIXTURE-INFO clip smile legacy=False human=False curves=2
FIXTURE-INFO clip muscle legacy=False human=True curves=4
FIXTURE-INFO generic avatar valid=True human=False
FIXTURE-INFO scene transforms=10
FIXTURE-INFO human avatar valid=True human=True
```

Copy only these files:

```
Build/lz4/scene               ->  fixtures/bundles/editor/<editor version>/scene/lz4/scene
Build/lz4-notypetree/scene    ->  fixtures/bundles/editor/<editor version>/scene/lz4-notypetree/scene
```

6000.6.4f1's build without type trees is committed too, in
`modern-goldens.json` with its typed twin, as in section 22.

Then rerun the goldens, `make-modern-goldens.py` first. Both now dump the five
classes (`DUMPED_CLASSES` 1, 4, 23, 33 and 137), so the section 22 animator
bundles' entries gain their GameObjects' and Transforms' dumps; no other entry
changes. `make-modern-goldens.py` checks the 6000.6 bundles' counts (its
`evidence`). `make-tpk-trees.py` adds the five classes' trees (it rewrites
the whole file, so every class id is passed), and `make-export-goldens.py`
adds the `skinned` Mesh of each bundle: AssetStudio's OBJ and skin for all but
6000.6.4f1's typed build, whose format-23 type trees c37af7d fails on (it
reads the build without them).

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-tpk-trees.py 43 74 90 91 95 221 1 4 23 33 137
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

Every fixture object of the five classes has the TPK tree of its version, so
the stripped builds are read through it. The fixtures fill every array of the
five classes (`m_Component`, `m_Children`, `m_Materials`, `m_Bones`,
`m_BlendShapeWeights`); `packages/core/tests/SceneObjects.test.ts` reads each
TPK layout from 2019.1 to 6000.6 filled. 2019.4.41f2 has none of the renderer
fields from 2020.1 on, 2020.3.30f1 `m_RayTraceProcedural` and the
`MeshRenderer`'s `m_EnlightenVertexStream`, and the 6000.x editors every field
up to 6000.3's `m_MaskInteraction`.

## 25. The `legacy-animation` bundles (#314)

`legacy-animation/{lz4,lz4-notypetree}/legacy-animation` for **2019.4.41f2**,
**2020.3.30f1**, **6000.3.26f1** and **6000.6.4f1**: one bundle per editor and
kind, made from code by an editor script, for the `Animation` reader (a legacy
`Animation` component, class 111) and as the oracle fixture of the
`Animation` branches of #304's `FindTOS` and `FindRoots`. Each bundle holds:

- `legacy`, a prefab of four GameObjects: the root `legacy` with a legacy
  `Animation` component; `Body` and `Body/Arm`; and `Skin`, a
  `SkinnedMeshRenderer` of the `face` mesh, without bones or material;
- `walk`, a Mecanim clip (`legacy` false): position curves on `Body`,
  quaternion rotation and `m_IsActive` curves on `Body/Arm`, and the `Skin`
  renderer's two blend shape weights (`blendShape.smile`, `blendShape.blink`);
- `unlisted`, the same curves in a clip no component lists;
- `face`, a quad with two blend shapes, `smile` and `blink`, a frame each.

The `Animation` component's default clip (`m_Animation`) is `walk`, and
`AnimationUtility.SetAnimationClips` makes `walk` its only listed clip
(`m_Animations`). Its other fields are set away from their defaults through a
`SerializedObject`: `m_WrapMode` 4 (ping-pong), `m_PlayAutomatically` false,
`m_AnimatePhysics` true, `m_CullingType` 1 (based on renderers), and in the
6000.x editors `m_UpdateMode` 1 (2023.1+).

Why a Mecanim clip: a legacy clip keeps its curves in the curve arrays with
string paths and has no generic bindings, and AssetStudio's `AddTOS` names only
the paths of the bindings (`AnimationClipExtensions.cs`), so a legacy clip
would leave the `Animation` branch untested. The bundle holds no Avatar and no
Animator, which `FindTOS` would try first. Whether Unity keeps a Mecanim clip in
an `Animation` component's list was a time-boxed probe: the script reloads the
saved prefab and fails unless `m_Animations` still lists `walk`. Unity
accepted it in all four editors, so the probe's build is the committed one.

The quad's vertex streams differ between the typed and the untyped build of
2019.4.41f2 and 2020.3.30f1 (the normals in stream 0 or in stream 1); its
untyped Mesh is checked through Unity's own tree of the version instead of
its typed twin (`packages/core/tests/Mesh.test.ts`).

Each project is a fresh copy named `uar-314-legacy-animation-<editor version>`,
holding `ProjectSettings/` and `Packages/` of the section 24 project of the
same editor and only this file under `Assets/`.

`Assets/Editor/BuildLegacyAnimation.cs`:

```csharp
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

// The legacy-animation fixtures (#314), created from code: a prefab "legacy"
// whose root has a legacy Animation component listing "walk", a Mecanim (not
// legacy) clip with curves on child paths and two blend shape weights. The
// bundle holds no Avatar and no Animator, so only the Animation component
// names the clip's paths. "unlisted", the same curves in a clip no component
// lists, keeps its path hashes.
public static class BuildLegacyAnimation
{
    const string Dir = "Assets/Fixtures/legacy-animation";

    public static void Build()
    {
        // Keep every vertex channel of the mesh.
        PlayerSettings.stripUnusedMeshComponents = false;
        Directory.CreateDirectory(Dir);
        var mesh = Face("face");
        AssetDatabase.CreateAsset(mesh, Dir + "/face.asset");

        var walk = new AnimationClip { name = "walk" };
        Curves(walk);
        AssetDatabase.CreateAsset(walk, Dir + "/walk.anim");
        var unlisted = new AnimationClip { name = "unlisted" };
        Curves(unlisted);
        AssetDatabase.CreateAsset(unlisted, Dir + "/unlisted.anim");
        foreach (var c in new[] { walk, unlisted })
            Debug.Log("FIXTURE-INFO clip " + c.name + " legacy=" + c.legacy +
                " curves=" + AnimationUtility.GetCurveBindings(c).Length);

        var root = new GameObject("legacy");
        var body = Child(root.transform, "Body");
        Child(body, "Arm");
        var skin = Child(root.transform, "Skin");
        skin.gameObject.AddComponent<SkinnedMeshRenderer>().sharedMesh = mesh;
        var anim = root.AddComponent<Animation>();
        anim.clip = walk;
        AnimationUtility.SetAnimationClips(anim, new[] { walk });
        // Every field away from its default (m_UpdateMode only from 2023.1).
        var so = new SerializedObject(anim);
        so.FindProperty("m_WrapMode").intValue = (int)WrapMode.PingPong;
        so.FindProperty("m_PlayAutomatically").boolValue = false;
        so.FindProperty("m_AnimatePhysics").boolValue = true;
        so.FindProperty("m_CullingType").intValue = (int)AnimationCullingType.BasedOnRenderers;
        var update = so.FindProperty("m_UpdateMode");
        if (update != null) update.intValue = 1;
        so.ApplyModifiedPropertiesWithoutUndo();

        PrefabUtility.SaveAsPrefabAsset(root, Dir + "/legacy.prefab");
        Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();

        // The probe: the saved component still lists the Mecanim clip.
        var saved = AssetDatabase.LoadAssetAtPath<GameObject>(Dir + "/legacy.prefab").GetComponent<Animation>();
        var check = new SerializedObject(saved);
        var list = check.FindProperty("m_Animations");
        var names = Enumerable.Range(0, list.arraySize)
            .Select(i => list.GetArrayElementAtIndex(i).objectReferenceValue)
            .Select(o => o == null ? "null" : o.name).ToArray();
        var mode = check.FindProperty("m_UpdateMode");
        Debug.Log("FIXTURE-INFO animation clip=" + (saved.clip == null ? "null" : saved.clip.name) +
            " animations=" + string.Join(",", names) +
            " wrap=" + check.FindProperty("m_WrapMode").intValue +
            " play=" + check.FindProperty("m_PlayAutomatically").boolValue +
            " physics=" + check.FindProperty("m_AnimatePhysics").boolValue +
            " culling=" + check.FindProperty("m_CullingType").intValue +
            " update=" + (mode == null ? "none" : mode.intValue.ToString()));
        if (names.Length != 1 || names[0] != "walk") throw new System.Exception("m_Animations lost the Mecanim clip");

        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    // Child-path position, rotation and active curves and two blend shape weights.
    static void Curves(AnimationClip clip)
    {
        clip.SetCurve("Body", typeof(Transform), "localPosition.x", Keys(0f, 0f, 0.5f, 0.25f, 1f, 0f));
        clip.SetCurve("Body", typeof(Transform), "localPosition.y", Keys(0f, 0f, 1f, 0.5f));
        clip.SetCurve("Body", typeof(Transform), "localPosition.z", Keys(0f, 0.1f, 1f, -0.1f));
        var q = Quaternion.Euler(0f, 45f, 0f);
        clip.SetCurve("Body/Arm", typeof(Transform), "localRotation.x", Keys(0f, 0f, 1f, q.x));
        clip.SetCurve("Body/Arm", typeof(Transform), "localRotation.y", Keys(0f, 0f, 1f, q.y));
        clip.SetCurve("Body/Arm", typeof(Transform), "localRotation.z", Keys(0f, 0f, 1f, q.z));
        clip.SetCurve("Body/Arm", typeof(Transform), "localRotation.w", Keys(0f, 1f, 1f, q.w));
        clip.SetCurve("Body/Arm", typeof(GameObject), "m_IsActive", Keys(0f, 1f, 0.5f, 0f, 1f, 1f));
        clip.SetCurve("Skin", typeof(SkinnedMeshRenderer), "blendShape.smile", Keys(0f, 0f, 0.5f, 100f, 1f, 25f));
        clip.SetCurve("Skin", typeof(SkinnedMeshRenderer), "blendShape.blink", Keys(0f, 0f, 0.25f, 100f, 0.5f, 0f));
    }

    static Transform Child(Transform parent, string name)
    {
        var t = new GameObject(name).transform;
        t.SetParent(parent, false);
        return t;
    }

    static AnimationCurve Keys(params float[] tv)
    {
        var keys = new Keyframe[tv.Length / 2];
        for (int i = 0; i < keys.Length; i++) keys[i] = new Keyframe(tv[2 * i], tv[2 * i + 1]);
        return new AnimationCurve(keys);
    }

    // A quad with two blend shapes, "smile" and "blink", one frame each.
    static Mesh Face(string name)
    {
        var mesh = new Mesh { name = name };
        mesh.vertices = new[] { new Vector3(0f, 0f, 0f), new Vector3(1f, 0f, 0f), new Vector3(0f, 1f, 0f), new Vector3(1f, 1f, 0f) };
        mesh.normals = Enumerable.Repeat(new Vector3(0f, 0f, -1f), 4).ToArray();
        mesh.uv = new[] { new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 1f), new Vector2(1f, 1f) };
        mesh.triangles = new[] { 0, 2, 1, 1, 2, 3 };
        mesh.AddBlendShapeFrame("smile", 100f,
            new[] { Vector3.zero, Vector3.zero, new Vector3(0f, 0.25f, 0f), new Vector3(0f, 0.25f, 0f) }, null, null);
        mesh.AddBlendShapeFrame("blink", 100f,
            new[] { new Vector3(0.125f, 0f, 0f), new Vector3(-0.125f, 0f, 0f), Vector3.zero, Vector3.zero }, null, null);
        Debug.Log("FIXTURE-INFO " + name + " shapes=" + mesh.blendShapeCount);
        return mesh;
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var assets = new[] { "legacy.prefab", "walk.anim", "unlisted.anim", "face.asset" };
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "legacy-animation", assetNames = assets.Select(x => Dir + "/" + x).ToArray() },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK legacy-animation " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildLegacyAnimation.Build` (same
command as section 2). The log must hold two `FIXTURE-OK legacy-animation`
lines (`lz4`, `lz4-notypetree`) and these `FIXTURE-INFO` lines (`update=none`
for 2019.4.41f2 and 2020.3.30f1, `update=1` for the 6000.x editors):

```
FIXTURE-INFO face shapes=2
FIXTURE-INFO clip walk legacy=False curves=10
FIXTURE-INFO clip unlisted legacy=False curves=10
FIXTURE-INFO animation clip=walk animations=walk wrap=4 play=False physics=True culling=1 update=none
```

Copy only these files:

```
Build/lz4/legacy-animation               ->  fixtures/bundles/editor/<editor version>/legacy-animation/lz4/legacy-animation
Build/lz4-notypetree/legacy-animation    ->  fixtures/bundles/editor/<editor version>/legacy-animation/lz4-notypetree/legacy-animation
```

6000.6.4f1's build without type trees is committed too, in
`modern-goldens.json` with its typed twin, as in section 22.

Then rerun the goldens, `make-modern-goldens.py` first. Both now dump
`Animation` (`DUMPED_CLASSES` 111); no fixture held one before, so no other
entry changes. `make-modern-goldens.py` checks the 6000.6 bundles' counts,
the listed clip and the component's fields (its `evidence`).
`make-tpk-trees.py` adds the `Animation` trees (it rewrites the whole file,
so every class id is passed), and `make-export-goldens.py` adds the two clips
of the 2019.4, 2020.3 and 6000.3.26f1 bundles (AssetStudio's `.anim` curves:
`walk` named through the `Animation` component, `unlisted` with its hashes)
and the `face` Mesh of every bundle but 6000.6.4f1's typed one, whose
format-23 type trees c37af7d fails on; it does not load the 6000.6 clips
without type trees either (section 17). The 6000.3.26f1 `walk` clips get the
blend shape `verdict` of section 17; `unlisted` does not: the script gives it
only to a clip with a named path on a blend shape curve.

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-tpk-trees.py 43 74 90 91 95 221 1 4 23 33 137 111
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

Every fixture `Animation` has the TPK tree of its version, so the stripped
builds are read through it; `packages/core/tests/AnimationComponent.test.ts`
reads each TPK layout from 2019.1 to 6000.6 with two listed clips.

## 26. The `ui-animation` bundles (#315)

`ui-animation/{lz4,lz4-notypetree}/ui-animation` for **2019.4.41f2**,
**2020.3.30f1**, **6000.3.26f1** and **6000.6.4f1**: one bundle per editor and
kind, made from code by an editor script, for the `RectTransform` reader
(class 224) and as the oracle fixture of #304's `BuildTOS` and `FindChild`
through a UI hierarchy. Each bundle holds:

- `ui`, a prefab of four GameObjects, each with a `RectTransform` and no plain
  `Transform`: the root `ui` with a `Canvas` and an `Animator`; `Panel`, and
  below it `Button` and `Label`, each with its anchors, anchored position,
  size delta and pivot set away from the defaults;
- `ui`, a Mecanim clip: `RectTransform` curves on `Panel`
  (`m_AnchoredPosition.x`, `.y`) and `Panel/Button` (`m_SizeDelta.x`,
  `m_AnchorMin.y`, `m_Pivot.x`), which AssetStudio names through its
  `CustomCurveResolver`, and on `Panel/Label` a scale curve (`localScale`
  through the `Transform` type) and `m_IsActive`;
- `ui`, an `AnimatorController` whose one state plays the clip.

The `Animator` has no Avatar and the bundle holds none: `FindTOS` returns from
any Avatar whose `m_TOS` covers the bindings, and `AddAnimatorTOS` tries
`m_Avatar` before the hierarchy (`AnimationClipExtensions.cs`), so only the
`Animator`'s GameObject hierarchy, walked through its `RectTransform`s, names
the clip's paths. The script fails unless the saved prefab's Animator has no
Avatar and every Transform in it is a `RectTransform`.

`com.unity.modules.ui` (the `Canvas`) is already in the manifests of the
section 24 projects, so the manifests are copied unchanged. Each project is a
fresh copy named `uar-315-ui-animation-<editor version>`, holding
`ProjectSettings/` and `Packages/` of the section 24 project of the same
editor and only this file under `Assets/`.

`Assets/Editor/BuildUiAnimation.cs`:

```csharp
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

// The ui-animation fixtures (#315), created from code: a prefab "ui", a Canvas
// whose children are RectTransforms, with an Animator that has no Avatar and
// plays "ui", a clip on the children's paths. The bundle holds no Avatar, so
// only the Animator's hierarchy, through RectTransforms, names the paths.
public static class BuildUiAnimation
{
    const string Dir = "Assets/Fixtures/ui-animation";

    public static void Build()
    {
        Directory.CreateDirectory(Dir);
        var clip = new AnimationClip { name = "ui" };
        // RectTransform properties (custom bindings), a Transform scale through
        // the RectTransform below and an active curve, on child paths.
        clip.SetCurve("Panel", typeof(RectTransform), "m_AnchoredPosition.x", Keys(0f, 10f, 0.5f, 30f, 1f, 10f));
        clip.SetCurve("Panel", typeof(RectTransform), "m_AnchoredPosition.y", Keys(0f, 20f, 1f, -20f));
        clip.SetCurve("Panel/Button", typeof(RectTransform), "m_SizeDelta.x", Keys(0f, 100f, 1f, 150f));
        clip.SetCurve("Panel/Button", typeof(RectTransform), "m_AnchorMin.y", Keys(0f, 0.25f, 1f, 0.5f));
        clip.SetCurve("Panel/Button", typeof(RectTransform), "m_Pivot.x", Keys(0f, 0.5f, 1f, 0f));
        clip.SetCurve("Panel/Label", typeof(Transform), "localScale.x", Keys(0f, 1f, 1f, 2f));
        clip.SetCurve("Panel/Label", typeof(Transform), "localScale.y", Keys(0f, 1f, 1f, 0.5f));
        clip.SetCurve("Panel/Label", typeof(Transform), "localScale.z", Keys(0f, 1f, 1f, 1f));
        clip.SetCurve("Panel/Label", typeof(GameObject), "m_IsActive", Keys(0f, 1f, 0.5f, 0f, 1f, 1f));
        AssetDatabase.CreateAsset(clip, Dir + "/ui.anim");
        Debug.Log("FIXTURE-INFO clip ui legacy=" + clip.legacy +
            " curves=" + AnimationUtility.GetCurveBindings(clip).Length);
        var controller = AnimatorController.CreateAnimatorControllerAtPathWithClip(Dir + "/ui.controller", clip);

        var root = new GameObject("ui", typeof(RectTransform), typeof(Canvas));
        var panel = Child(root.transform, "Panel", new Vector2(0.25f, 0.25f), new Vector2(0.75f, 0.75f),
            new Vector2(10f, 20f), new Vector2(-40f, -30f), new Vector2(0.5f, 0.25f));
        Child(panel, "Button", new Vector2(0f, 0.25f), new Vector2(0f, 0.25f),
            new Vector2(8f, -4f), new Vector2(100f, 30f), new Vector2(0.5f, 0.5f));
        Child(panel, "Label", new Vector2(0f, 0f), new Vector2(1f, 1f),
            new Vector2(0f, 2f), new Vector2(-16f, -8f), new Vector2(0f, 1f));
        var animator = root.AddComponent<Animator>();
        animator.runtimeAnimatorController = controller;
        PrefabUtility.SaveAsPrefabAsset(root, Dir + "/ui.prefab");
        Object.DestroyImmediate(root);
        AssetDatabase.SaveAssets();

        // The saved Animator has no Avatar, and its children are RectTransforms.
        var saved = AssetDatabase.LoadAssetAtPath<GameObject>(Dir + "/ui.prefab");
        var savedAnimator = saved.GetComponent<Animator>();
        var rects = saved.GetComponentsInChildren<Transform>(true).Select(t => t is RectTransform).ToArray();
        Debug.Log("FIXTURE-INFO animator avatar=" + (savedAnimator.avatar == null ? "null" : savedAnimator.avatar.name) +
            " controller=" + savedAnimator.runtimeAnimatorController.name +
            " rects=" + rects.Count(r => r) + "/" + rects.Length);
        if (savedAnimator.avatar != null) throw new System.Exception("the Animator has an Avatar");
        if (rects.Any(r => !r)) throw new System.Exception("a Transform is not a RectTransform");

        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree);
    }

    static Transform Child(Transform parent, string name, Vector2 anchorMin, Vector2 anchorMax,
        Vector2 anchoredPosition, Vector2 sizeDelta, Vector2 pivot)
    {
        var t = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
        t.SetParent(parent, false);
        t.anchorMin = anchorMin;
        t.anchorMax = anchorMax;
        t.anchoredPosition = anchoredPosition;
        t.sizeDelta = sizeDelta;
        t.pivot = pivot;
        return t;
    }

    static AnimationCurve Keys(params float[] tv)
    {
        var keys = new Keyframe[tv.Length / 2];
        for (int i = 0; i < keys.Length; i++) keys[i] = new Keyframe(tv[2 * i], tv[2 * i + 1]);
        return new AnimationCurve(keys);
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var assets = new[] { "ui.prefab", "ui.anim", "ui.controller" };
        var builds = new[]
        {
            new AssetBundleBuild { assetBundleName = "ui-animation", assetNames = assets.Select(x => Dir + "/" + x).ToArray() },
        };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK ui-animation " + name + " -> " + dir);
    }
}
```

Build each project once, with `-executeMethod BuildUiAnimation.Build` (same
command as section 2). The log must hold two `FIXTURE-OK ui-animation` lines
(`lz4`, `lz4-notypetree`) and these `FIXTURE-INFO` lines, the same in all four
editors:

```
FIXTURE-INFO clip ui legacy=False curves=9
FIXTURE-INFO animator avatar=null controller=ui rects=4/4
```

Copy only these files:

```
Build/lz4/ui-animation               ->  fixtures/bundles/editor/<editor version>/ui-animation/lz4/ui-animation
Build/lz4-notypetree/ui-animation    ->  fixtures/bundles/editor/<editor version>/ui-animation/lz4-notypetree/ui-animation
```

6000.6.4f1's build without type trees is committed too, in
`modern-goldens.json` with its typed twin, as in section 22.

Then rerun the goldens, `make-modern-goldens.py` first. Both now dump
`RectTransform` (`DUMPED_CLASSES` 224); no fixture held one before, so no
other entry changes. `make-modern-goldens.py` checks the 6000.6 bundles'
counts and that the Animator has no Avatar (its `evidence`).
`make-tpk-trees.py` adds the `RectTransform` trees (it rewrites the whole
file, so every class id is passed), and `make-export-goldens.py` adds the `ui`
clip of the 2019.4, 2020.3 and 6000.3.26f1 bundles, typed and not
(AssetStudio's `.anim` curves); it does not load the 6000.6 bundles (section
17). In the 2019.4 and 2020.3 clips AssetStudio names every path through the
`Animator`'s hierarchy. In the 6000.3.26f1 ones it names none: c37af7d's
`Animator` reader lacks `m_AnimatePhysics`, which Unity writes before
`m_HasTransformHierarchy` from 2023.1 (Unity's type trees, `fixtures/tpk-trees.json`
class 95), so it reads that byte, false, as `m_HasTransformHierarchy`, and
`AddAnimatorTOS` gets only the root from `BuildTOS(Animator)`. The script gives
such a clip a `verdict` (`ANIMATOR_VERDICT`): every path it wrote is
`path_<hash>`, and UnityPy reads an `Animator` whose `m_AnimatePhysics` is false
and `m_HasTransformHierarchy` true and whose controller lists the clip.
`packages/animation/tests/ui.test.ts` and `goldens.test.ts` compare those two
goldens with each named path replaced by `path_<CRC-32>`.

```bash
<modern-oracle>/bin/python scripts/make-modern-goldens.py
.venv-oracle/bin/python scripts/make-goldens.py
.venv-oracle/bin/python scripts/make-tpk-trees.py 43 74 90 91 95 221 1 4 23 33 137 111 224
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

Every fixture `RectTransform` has the TPK tree of its version, so the stripped
builds are read through it; `packages/core/tests/RectTransform.test.ts` reads
each TPK layout from 2019.1 to 6000.6 with two children.

## 27. The scene export oracle: AssetStudio's ModelConverter (#306)

No new bundle: `sceneToGltf()` (unity-asset-reader-animation) is checked on
the section 24 `scene` bundles against what AssetStudio's FBX export converts
before it writes FBX. `scripts/make-export-goldens.py` (section 17) runs, for
every `scene` bundle (`MODEL_ROOTS`), `new ModelConverter(Animator, Options,
clips)` (`AssetStudio.Utility/ModelConverter.cs:84`, c37af7d) on the Animator
of the GameObject `scene`, before the bundle's clips are exported (the
`.anim` export's `Convert()` replaces a clip's curve lists). The options are
those of the GUI's "Export Animator" without materials: game `Normal` (the
ACL branches read it), `uvs` `UV0` to `UV7` on, `exportMaterials` false,
empty `materials` and `texs` (ConvertMaterial returns before it reads them).

The constructor runs twice:

- with no clip, for the frames (`RootFrame`: name, local position, rotation
  and scale as `SetFrame` converts them), the meshes (each `ImportedMesh`'s
  path, converted vertex positions and bones, each bone's path and
  `convert * bindpose * convert` matrix) and the morphs (each channel's
  frames: full weight, and per vertex its index, morphed position, normal and
  tangent);
- then with every AnimationClip of the Animator's file, in file order, for the
  keyframe tracks (per clip and path the translations, rotations, scalings
  and blend shape keys, each key's time and value).

The first call cannot be stopped by a clip: an euler binding (m_EulerCurves,
or binding attribute 4) calls `Fbx.EulerToQuaternion`, the native FBX SDK,
whose static constructor loads a library the harness does not have. The scene
clips have no euler binding (a fixture clip for this oracle must not use
`localEulerAnglesRaw`), and the euler to quaternion conversion of
`sceneToGltf()` has no oracle: it follows `Quaternion.Euler` and is checked
on synthetic angles only (`packages/animation/tests/gltf-cubic.test.ts`).

Every float is dumped as its float32 bits, 8 hex digits, into the golden's
`models`: fixture -> SerializedFile -> the Animator's path id. A matrix is
written in Unity's order, `e00 e01 e02 e03 e10 ...`, the order
`Matrix4x4(float[])` reads it in.

What the oracle covers per editor:

- **2019.4.41f2** and **2020.3.30f1**, both builds: frames, both meshes
  (`Skin` with its five bones and two morph channels, `Prop` unskinned) and
  the `move` and `smile` tracks (`muscle` has humanoid bindings only, which
  ModelConverter skips).
- **6000.3.26f1**, both builds: c37af7d's Renderer reader fails on Unity
  6000's `MeshRenderer` and `SkinnedMeshRenderer` (`unreadObjects`), so
  ModelConverter converts no mesh, no bones and no morphs, and names no blend
  shape track; the dump gets a `verdict`. Its frames and transform tracks are
  compared; its skin and morphs equal the 2019.4 export's by the cross-editor
  test, the Mesh being the same.
- **6000.6.4f1**: c37af7d reads no format-23 type tree, so its typed build has
  no dump; the build without type trees has the frames only: its renderers
  and two of its clips are unread (the `verdict` again), and the call with
  the clips fails (`animationsError`). The cross-editor test covers it.

Regenerate with section 17's command:

```bash
.venv-oracle/bin/python scripts/make-export-goldens.py --source <external-source> --smolv <external-smolv> --modern-python <modern-oracle>/bin/python --project <external-harness> --dotnet <dotnet-executable>
```

The tests (`packages/animation/tests/gltf.test.ts`) compare the node TRS with
the frames, the skin's joint order and inverse bind matrices with the bones,
the morph targets with the last frame of each channel (glTF has no in-between
frames: base plus delta in float32 equals the morphed position), and the
sampler values at the keys with the tracks, float32 bit for bit; a zero's sign
is not compared (JSON numbers carry none, and the bind poses are C# sums of
products).
