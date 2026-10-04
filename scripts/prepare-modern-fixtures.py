#!/usr/bin/env python3
"""Write the local Unity 6000.6 fixture builders outside this repository (R2).

Usage: python scripts/prepare-modern-fixtures.py <local-unity-project>
Create the project with Unity first. No third-party source images are used.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main():
    project = pathlib.Path(sys.argv[1]).resolve()
    if project == ROOT or ROOT in project.parents:
        raise SystemExit("Unity project must be outside the repository (R2)")
    editor = project / "Assets/Editor"
    editor.mkdir(parents=True, exist_ok=True)
    text = (ROOT / "fixtures/BUILDING.md").read_text()
    match = re.search(r"```csharp\n(using System.Collections.Generic;.*?public static class BuildSprites.*?)\n```", text, re.S)
    if not match:
        raise SystemExit("section 12 BuildSprites source not found")
    sprite = match[1]
    (editor / "BuildSprites.cs").write_text(sprite + "\n")

    variant = sprite.replace("BuildSprites", "BuildVariantSprites").replace(
        "Assets/Fixtures/sprite", "Assets/Fixtures/variant").replace('"sprite"', '"variant"')
    variant = variant.replace('assets.Add(Atlas("rect", rect, false, false));', '''
        var masterPath = Atlas("rect", rect, false, false);
        var master = AssetDatabase.LoadAssetAtPath<SpriteAtlas>(masterPath);
        master.SetIncludeInBuild(false);
        var variant = new SpriteAtlas();
        variant.SetIsVariant(true);
        variant.SetMasterAtlas(master);
        variant.SetVariantScale(0.5f);
        variant.SetIncludeInBuild(true);
        variant.SetPlatformSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true, maxTextureSize = 256, format = TextureImporterFormat.RGBA32 });
        var variantPath = Dir + "/half.spriteatlas";
        AssetDatabase.DeleteAsset(variantPath);
        AssetDatabase.CreateAsset(variant, variantPath);
        assets.Clear();
        assets.Add(masterPath);
        assets.Add(variantPath);
''')
    (editor / "BuildVariantSprites.cs").write_text(variant + "\n")

    v2 = sprite.replace("BuildSprites", "BuildV2Sprites").replace(
        "Assets/Fixtures/sprite", "Assets/Fixtures/sprite-v2").replace('"sprite"', '"sprite-v2"')
    v2 = v2.replace("SpritePackerMode.AlwaysOnAtlas", "SpritePackerMode.SpriteAtlasV2")
    v2 = v2.replace('".spriteatlas"', '".spriteatlasv2"').replace(
        "var atlas = new SpriteAtlas();", "var atlas = new SpriteAtlasAsset();")
    v2 = v2.replace("AssetDatabase.CreateAsset(atlas, path);", "")
    v2 = v2.replace("atlas.Add(sprites.ToArray());", '''atlas.Add(sprites.ToArray());
        SpriteAtlasAsset.Save(atlas, path);
        AssetDatabase.ImportAsset(path);''')
    (editor / "BuildV2Sprites.cs").write_text(v2 + "\n")
    rect = v2.replace("BuildV2Sprites", "BuildV2Rects").replace("sprite-v2", "sprite-v2-rect")
    rect = rect.replace('Atlas("packed", packed, true, true)', 'Atlas("packed", packed, false, true)')
    (editor / "BuildV2Rects.cs").write_text(rect + "\n")

    # The plain-format builder's source is documented in section 13.
    plain = [block for block in re.findall(r"```csharp\n(.*?)\n```", text, re.S)
             if "public static class BuildMorePlain" in block]
    if len(plain) != 1:
        raise SystemExit("section 13 BuildMorePlain source not found")
    (editor / "BuildMorePlain.cs").write_text(plain[0] + "\n")
    print("Wrote five editor builders to", editor)


if __name__ == "__main__":
    main()
