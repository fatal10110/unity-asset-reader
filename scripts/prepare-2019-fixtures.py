#!/usr/bin/env python3
"""Derive Unity 2019 builders from documented sources; C# stays outside the repo.
Usage: python scripts/prepare-2019-fixtures.py <external-unity-project>
Requires the Windows and Android build modules for Unity 2019.4.41f2.
"""
import importlib.util
import pathlib
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("modern", pathlib.Path(__file__).with_name("prepare-modern-fixtures.py"))
modern = importlib.util.module_from_spec(spec)
spec.loader.exec_module(modern)

def main():
    modern.main()
    editor = pathlib.Path(sys.argv[1]).resolve() / "Assets/Editor"
    base = (editor / "BuildSprites.cs").read_text()
    plain = editor / "BuildMorePlain.cs"
    source = plain.read_text()
    begin = source.index("        var formats = new[]")
    end = source.index("        foreach", begin)
    plain.write_text(source[:begin] + "        var formats = new[] { TextureFormat.R8, TextureFormat.RG16, TextureFormat.RG32, TextureFormat.RGB48, TextureFormat.RGBA64 };\n" + source[end:])
    for cls, folder in [("BuildRotationProbe", "rotation-probe"), ("BuildLegacyProbe", "legacy-probe"), ("BuildSplitAlpha", "split-alpha")]:
        source = base.replace("BuildSprites", cls).replace("Assets/Fixtures/sprite", "Assets/Fixtures/" + folder).replace('"sprite"', '"' + folder + '"')
        if cls == "BuildRotationProbe":
            source = source.replace('Atlas("packed", packed, true, true)', 'Atlas("packed", packed, false, true)').replace("maxTextureSize = 256", "maxTextureSize = 64")
        elif cls == "BuildLegacyProbe":
            source = source.replace("using UnityEditor.U2D;", "using UnityEditor.U2D;\nusing UnityEditor.Sprites;")
            source = source.replace("SpritePackerMode.AlwaysOnAtlas", "SpritePackerMode.AlwaysOn")
            source = source.replace('assets.Add(Atlas("packed", packed, true, true));', 'foreach (var item in packed) assets.Add(AssetDatabase.GetAssetPath(item));')
            source = source.replace('assets.Add(Atlas("rect", rect, false, false));', 'foreach (var item in rect) assets.Add(AssetDatabase.GetAssetPath(item));')
            source = source.replace("imp.spriteImportMode = SpriteImportMode.Single;", 'imp.spriteImportMode = SpriteImportMode.Single;\n        imp.spritePackingTag = "fixture-rotate";')
            source = source.replace("SpriteAtlasUtility.PackAllAtlases(BuildTarget.StandaloneWindows64);", 'Packer.SelectedPolicy = "TightRotateEnabledSpritePackerPolicy";\n        Packer.RebuildAtlasCacheIfNeeded(BuildTarget.StandaloneWindows64, true, Packer.Execution.ForceRegroup);')
        else:
            source = source.replace("BuildTarget.StandaloneWindows64", "BuildTarget.Android")
            source = source.replace("        atlas.SetIncludeInBuild(true);", '        atlas.SetPlatformSettings(new TextureImporterPlatformSettings { name = "Android", overridden = true, maxTextureSize = 256, format = TextureImporterFormat.ETC_RGB4, allowsAlphaSplitting = true, textureCompression = TextureImporterCompression.Compressed });\n        atlas.SetIncludeInBuild(true);')
        (editor / (cls + ".cs")).write_text(source)
    for name in ["BuildSprites", "BuildV2Sprites", "BuildV2Rects"]:
        (editor / (name + ".cs")).unlink()
    print("Prepared five Unity 2019 builders")

if __name__ == "__main__":
    main()
