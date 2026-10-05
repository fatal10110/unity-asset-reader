#!/usr/bin/env python3
"""Prepare an exploratory native Rotate90 matrix, not a verified generation recipe.
Usage: python scripts/prepare-rotate90-experiment.py <external-unity-project>
Then run BuildRotationMatrix.Build with -probeMode legacy/v1/v2 as available.
Six cases per mode; no serialized flags or importer rotation flags are forced.
"""
from pathlib import Path
import re
import sys
root=Path(__file__).resolve().parent.parent
project=Path(sys.argv[1]).resolve()
if project == root or root in project.parents:
 raise SystemExit("Unity project must be outside the repository (R2)")
sprite=re.search(r'```csharp\n(using System.Collections.Generic;.*?public static class BuildSprites.*?)\n```',(root/'fixtures/BUILDING.md').read_text(),re.S)[1]
start=sprite.index('    public static void Build()'); end=sprite.index('    enum Shape',start)
body='''    static string Mode;
    static int AtlasSize;
    static bool Tight;
    public static void Build()
    {
        Mode = "v1";
        var args = System.Environment.GetCommandLineArgs();
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "-probeMode") Mode = args[i + 1];
        if (Mode == "legacy") EditorSettings.spritePackerMode = SpritePackerMode.AlwaysOn;
        else if (Mode == "v1") EditorSettings.spritePackerMode = SpritePackerMode.AlwaysOnAtlas;
#if UNITY_2020_1_OR_NEWER
        else if (Mode == "v2") EditorSettings.spritePackerMode = SpritePackerMode.SpriteAtlasV2;
#endif
        else throw new System.Exception("unsupported probe mode " + Mode);
        Dir = "Assets/Fixtures/rotate-matrix-" + Mode;
        Directory.CreateDirectory(Dir);
        AssetDatabase.Refresh();
        var assets = new List<string>();
        var sizes = new[] {64,64,128,128,256,256};
        var tight = new[] {false,true,true,true,true,false};
        var reverse = new[] {false,false,false,true,false,true};
        var dimensions = new int[,] {{13,47},{47,13},{19,37},{37,19},{23,41},{41,23},{33,49},{49,33},{35,43},{43,35},{7,53},{53,7}};
        for (int c = 0; c < sizes.Length; c++)
        {
            AtlasSize = sizes[c]; Tight = tight[c];
            var caseName = "c" + c + "-" + AtlasSize + "-" + (Tight ? "tight" : "rect") + "-" + (reverse[c] ? "reverse" : "forward");
            var packables = new List<Object>();
            for (int i = 0; i < 12; i++)
            {
                int id = reverse[c] ? 11 - i : i;
                var shape = !Tight || id % 3 == 0 ? Shape.Full : id % 3 == 1 ? Shape.Triangle : Shape.Ell;
                var path = Png(caseName + "-s" + id.ToString("D2"), dimensions[id,0], dimensions[id,1], id + 1,
                    shape, Tight ? SpriteMeshType.Tight : SpriteMeshType.FullRect, new Vector2(0.3f,0.6f));
                if (Mode == "legacy")
                {
                    var imp = (TextureImporter)AssetImporter.GetAtPath(path);
                    imp.spritePackingTag = caseName;
                    imp.SaveAndReimport();
                    assets.Add(path);
                }
                else packables.Add(AssetDatabase.LoadAssetAtPath<Texture2D>(path));
            }
            if (Mode != "legacy") assets.Add(Atlas(caseName, packables, Tight, true));
            Debug.Log("ROTATION-PROBE " + Mode + " " + caseName + " sprites=12");
        }
        AssetDatabase.SaveAssets();
        if (Mode == "legacy")
        {
            UnityEditor.Sprites.Packer.SelectedPolicy = "TightRotateEnabledSpritePackerPolicy";
            UnityEditor.Sprites.Packer.RebuildAtlasCacheIfNeeded(BuildTarget.StandaloneWindows64, true, UnityEditor.Sprites.Packer.Execution.ForceRegroup);
        }
        else SpriteAtlasUtility.PackAllAtlases(BuildTarget.StandaloneWindows64);
        var dir = "Build/rotate-matrix-" + Mode;
        Directory.CreateDirectory(dir);
        var builds = new[] {new AssetBundleBuild {assetBundleName="sprites", assetNames=assets.ToArray()}};
        if (BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.ChunkBasedCompression, BuildTarget.StandaloneWindows64) == null)
            throw new System.Exception("rotation matrix build failed");
        Debug.Log("ROTATION-MATRIX-OK " + Mode);
    }

'''
sprite=sprite[:start]+body+sprite[end:]
sprite=sprite.replace('public static class BuildSprites','public static class BuildRotationMatrix').replace('const string Dir = "Assets/Fixtures/sprite";','static string Dir;')
sprite=sprite.replace('maxTextureSize = 256','maxTextureSize = 1024',1)
sprite=sprite.replace('maxTextureSize = 256','maxTextureSize = AtlasSize')
sprite=sprite.replace('var path = Dir + "/" + name + ".spriteatlas";', 'var path = Dir + "/" + name + (Mode == "v2" ? ".spriteatlasv2" : ".spriteatlas");')
sprite=sprite.replace('var atlas = new SpriteAtlas();','''#if UNITY_2020_1_OR_NEWER
        if (Mode == "v2") return AtlasV2(path, sprites, tight, rotate);
#endif
        var atlas = new SpriteAtlas();''')
v2='''
#if UNITY_2020_1_OR_NEWER
    static string AtlasV2(string path, List<Object> sprites, bool tight, bool rotate)
    {
        var atlas = new SpriteAtlasAsset();
        atlas.SetPackingSettings(new SpriteAtlasPackingSettings {enableRotation=rotate, enableTightPacking=tight, padding=2, blockOffset=1});
        atlas.SetTextureSettings(new SpriteAtlasTextureSettings {readable=false, generateMipMaps=false, sRGB=true, filterMode=FilterMode.Point});
        atlas.SetPlatformSettings(new TextureImporterPlatformSettings {name="Standalone", overridden=true, maxTextureSize=AtlasSize, format=TextureImporterFormat.RGBA32});
        atlas.SetIncludeInBuild(true);
        atlas.Add(sprites.ToArray());
        SpriteAtlasAsset.Save(atlas,path);
        AssetDatabase.ImportAsset(path);
        return path;
    }
#endif
'''
sprite=sprite.rsplit('}',1)[0]+v2+'}\n'
sprite=sprite.replace('            UnityEditor.Sprites.Packer.SelectedPolicy', '#if !UNITY_6000_0_OR_NEWER\n            UnityEditor.Sprites.Packer.SelectedPolicy').replace('UnityEditor.Sprites.Packer.Execution.ForceRegroup);', 'UnityEditor.Sprites.Packer.Execution.ForceRegroup);\n#else\n            throw new System.Exception("Legacy packer unavailable in Unity 6");\n#endif')
editor=project/'Assets/Editor'
editor.mkdir(parents=True,exist_ok=True)
(editor/'BuildRotationMatrix.cs').write_text(sprite)
print("Prepared bounded rotation experiment in",editor)
