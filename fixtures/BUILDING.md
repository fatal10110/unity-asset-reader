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
Android module). The editor does not compress signed EAC and has no ATC; see
[`README.md`](README.md#oracle-notes) for how those are covered.

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
the manifest bundle of this build is not copied.

| Bundle | Objects | Where the bytes are |
|---|---|---|
| `audio` | two AudioClips from one WAV: `tone-pcm` (PCM) and `tone-vorbis` (Vorbis, load in background) | an FMOD sound bank (FSB5) each, in the bundle's `.resource` node |
| `font` | one Font (dynamic, font data included), with the Material and the 0x0 "Font Texture" the importer makes | the TrueType file, inline in `m_FontData` |
| `video` | one VideoClip, imported without transcoding | the WebM file as it went in, in the bundle's `.resource` node |

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

## 13. Unity 6000.6.4f1 candidate fixtures (#108, #153, #155, #160)

Scope: Unity 2019 and newer. Unity 5.x layouts are outside this fixture task.
The existing 2019.4, 2020.3 and 6000.3 bundles are preserved.

These Windows64 builds write **SerializedFile format 23**, even for plain
textures. Core reads their metadata and generic type-tree dumps (#223).
UnityPy **1.25.4** reads these files; 1.25.3 fails in the type-tree metadata.
They are therefore candidate fixtures, with independent goldens in
`modern-goldens.json`, separate from the supported-fixture `goldens.json`.
`scripts/make-goldens.py` excludes the sidecar's candidate keys; it continues
using UnityPy 1.25.3 for the existing fixtures. The core reads their Sprite and
SpriteAtlas layouts and compares them with these dumps (#155). Do not add the
candidates to the main golden set until their texture conversion is ported too:
sprites cut out of a 6000.6 atlas, and the signed plain formats.

| Folder / bundle | Content | Evidence / remaining work |
|---|---|---|
| `more-plain/textures` | 13 textures, 8x5, no mips, raw byte ramp | R8, RG16, RG32, RGB48, RGBA64 tested by #108; eight signed variants remain unsupported |
| `sprite/sprites` | Section 12 source, Atlas V1 | #155: atlas drops packed sprite arrays and embeds `*spriteInstanceData` in every render-data entry; the core reads it (`Sprite.test.ts`), cutting sprites out of it remains |
| `variant/sprites` | `rect` master plus `half` variant, scale 0.5 | #153: two real entries have `downscaleMultiplier = 0.5`; bicubic cross-check and decoder still required |
| `sprite-v2/sprites` | Section 12 shapes, native Atlas V2 tight packing | #160 probe: flips observed, no rotation value 4 |
| `sprite-v2-rect/sprites` | Same shapes, native Atlas V2 rectangle packing | #160 probe: flips and Rotate180 observed, no rotation value 4 |

The 6000.6 atlas holds the imported sprites' names, rects, pivots, border,
vertex data and indices inside `*spriteInstanceData`; individual packed Sprite
objects are no longer necessary in the bundle. The sheet and unpacked tight
sprite are still individual Sprite objects. Inspect the oracle type-tree dumps,
not only the old `sprites` image map, when implementing #155 and #160.

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
  downscale field for sprite export. A separate AssetStudio bicubic cross-check
  is still needed before choosing a resampler or claiming decoded pixels agree.
- #155: the core reads the 6000.6 SpriteAtlas layout. Its packed sprites exist
  only inside the atlas (`*spriteInstanceData`), not as Sprite objects, and the
  texture package does not list or decode them yet; a Sprite object that points
  at a 6000.6 atlas is refused with `UnsupportedError`.
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
pixels are available through section 15; the resize implementation remains #153.

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
.venv-oracle/bin/python scripts/make-goldens.py
<modern-oracle>/bin/python scripts/make-modern-goldens.py
npm run verify
```

Use the separate UnityPy 1.25.4 environment from section 13 for modern goldens.
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

| Case | Requested atlas maximum (V1/V2) | Packing / imported mesh | Order |
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
V1/V2 request the listed atlas maxima and tight-packing settings, with rotation
enabled and padding 2. Legacy uses the built-in policy without overriding its
atlas maximum or padding: the size in its case name is only a label. Its c1, c2
and c4 repeat the same Tight/forward settings with separately imported images.
All image imports use Windows RGBA32, point filtering and no mipmaps.
V1 produced pages within the requested limits. V2 produced 128x256 or 256x128
pages even for the 64/128 requests; those calls did not establish effective
V2 size limits in this experiment. The report records this limitation explicitly
without assuming its cause.

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
is impossible; this result applies only to the bounded configurations above.

The separate [`codex/fixture-oracle-references` branch at `be60685`](https://github.com/fatal10110/unity-asset-reader/tree/be60685)
contains the prepared plain and half-scale variant pixel references. Those
references do not settle Rotate90. Its rectangle-only variant harness must not
be used as a tight-mask oracle.
