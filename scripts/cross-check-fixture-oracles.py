#!/usr/bin/env python3
"""Execute pinned AssetStudio plain decoders and rectangle variant CutImage.

All inputs come from our editor bundles through UnityPy. The unmodified C#
methods and their .NET project are generated outside the repository (R2).
This is not execution of the full AssetStudio application or its tight mask.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import shutil
import subprocess
import sys

import UnityPy

ROOT = pathlib.Path(__file__).resolve().parent.parent
REVISION = "c37af7dfcdafee93e33b5da9f0285c97998d6ae3"
BLOBS = {
    "Texture2DConverter.cs": "91c659434c07d92ea1d6fbc634d222fc37222b4f",
    "SpriteHelper.cs": "2110b7100491417e337ed06aa155ab9bc3696edb",
    "AssetStudio.Utility.csproj": "328274d0428a262c9d6e351fc3d734a9d7f5fad4",
}
PLAIN = "editor/2019.4.41f2/more-plain/textures"
VARIANT = "editor/2019.4.41f2/variant/sprites"
FORMATS = {"RG16": (62, 2), "RG32": (72, 4), "RGBA64": (74, 8)}
NUGET_SOURCE = "https://api.nuget.org/v3/index.json"
PACKAGE_HASHES = {
    "Microsoft.NETCore.Platforms/5.0.0": "hJP+EWSMfswgtlMEkNMP1jdElhNFwFAaehCxEEZmHaCbeD3c64syCK5SpyqKlMr9zo3BvWBzwyCB4w0OdAfxdA==",
    "SixLabors.Fonts/1.0.0-beta18": "uBiPe21m3CCu0eNaDQyx3LJ0H9nP5O8PK2f3dSw1RGOfzdx+3sA316XkrByjecgkHxqYJ9/aR7g4A0p3KlSUIQ==",
    "SixLabors.ImageSharp/2.1.3": "B4VO+wsXBdKEe0NpKa4sojWS+qYDE3W407jqFHCxQFFQPpiivXau/8zTrjUINpiIy5nEaiML/KPcmraJX0zOWQ==",
    "SixLabors.ImageSharp.Drawing/1.0.0-beta15": "nr49GVBxF47lGY+CE3ZopAtflIHlRa8HDyM53pcrp1hDA+13xLAHpHDiaTScZ5bWZ/l2ycGIGvhSt96iY5KNAg==",
    "System.Runtime.CompilerServices.Unsafe/5.0.0": "IyJsUDsGq+zuWpYEpuTdPavN+SH1XWqm2tK6scoSoAHHhmr1pt4BzJtKzlTlyO4dXC/Sndnf1+2j7Yb5s1+lnw==",
    "System.Text.Encoding.CodePages/5.0.0": "TzLIAbPciz0ofBcxDo6uy7fT0OMR454cQoQ5/qcnaGD+vDhCKmGryT08u82Xv1EYNbMWVT6THgT2MzqAYp3HRg==",
}
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("rgb48", ROOT / "scripts/cross-check-rgb48.py")
rgb48 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rgb48)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def external(path):
    path = path.resolve()
    if path == ROOT or ROOT in path.parents:
        raise SystemExit("C# source and harness must stay outside the repository (R2)")
    return path


def source_files(source):
    result = {}
    for name, expected in BLOBS.items():
        raw = external(source / "AssetStudio.Utility" / name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if blob != expected:
            raise SystemExit("source does not match pinned AssetStudio blob: " + name)
        result[name] = raw.decode("utf-8-sig")
    return result


def inputs():
    jobs = []
    for obj in UnityPy.load(str(ROOT / "fixtures/bundles" / PLAIN)).objects:
        if obj.type.name != "Texture2D":
            continue
        texture = obj.read()
        if texture.m_Name not in FORMATS:
            continue
        fmt, stride = FORMATS[texture.m_Name]
        raw = bytes(texture.get_image_data())
        assert (texture.m_TextureFormat, texture.m_Width, texture.m_Height, texture.m_MipCount) == (fmt, 8, 5, 1)
        assert len(raw) == 40 * stride
        assert raw == bytes((k * 37 + 11) & 255 for k in range(len(raw)))
        jobs.append({"kind": "plain", "name": texture.m_Name, "format": fmt,
                     "width": 8, "height": 5, "raw": raw})
    assert {job["name"] for job in jobs} == set(FORMATS)
    env = UnityPy.load(str(ROOT / "fixtures/bundles" / VARIANT))
    for obj in env.objects:
        if obj.type.name != "Sprite":
            continue
        sprite = obj.read()
        atlas = sprite.m_SpriteAtlas.deref_parse_as_object()
        assert atlas.m_IsVariant
        data = next(value for key, value in atlas.m_RenderDataMap if key == sprite.m_RenderDataKey)
        texture = data.texture.deref_parse_as_object()
        assert texture.m_TextureFormat == 4
        assert data.downscaleMultiplier == 0.5
        assert (data.settingsRaw >> 1) & 1 == 1, "rectangle-only oracle; tight masking is not executed"
        rect = {key: float(getattr(data.textureRect, key)) for key in ["x", "y", "width", "height"]}
        offset = {key: float(getattr(data.textureRectOffset, key)) for key in ["x", "y"]}
        raw = bytes(texture.get_image_data())
        assert len(raw) == texture.m_Width * texture.m_Height * 4
        jobs.append({"kind": "variant", "name": sprite.m_Name, "format": 4,
                     "width": texture.m_Width, "height": texture.m_Height, "raw": raw,
                     "textureRect": rect, "textureRectOffset": offset,
                     "settingsRaw": int(data.settingsRaw), "downscaleMultiplier": 0.5})
    assert {job["name"] for job in jobs if job["kind"] == "variant"} == {"r_a", "r_b"}
    return sorted(jobs, key=lambda job: (job["kind"], job["name"]))


def harness(sources):
    converter = sources["Texture2DConverter.cs"]
    methods = "\n".join(rgb48.method(converter, signature) for signature in [
        "public static byte DownScaleFrom16BitTo8Bit(ushort component)",
        *[f"private bool Decode{name}(byte[] image_data, byte[] buff)" for name in ["RG16", "RG32", "RGBA64", "RGBA32"]],
    ])
    cut = rgb48.method(sources["SpriteHelper.cs"], "private static Image<Bgra32> CutImage(")
    return '''using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using System.Collections.Generic;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
public class Converter {
    private int m_Width, m_Height, outPutSize;
    public Converter(int width, int height) {
        m_Width = width; m_Height = height; outPutSize = width * height * 4;
    }
''' + methods + '''
    public byte[] Run(string name, byte[] input) {
        var output = new byte[outPutSize];
        bool ok = name switch {
            "RG16" => DecodeRG16(input, output), "RG32" => DecodeRG32(input, output),
            "RGBA64" => DecodeRGBA64(input, output), "RGBA32" => DecodeRGBA32(input, output),
            _ => throw new Exception("unexpected format")
        };
        if (!ok) throw new Exception("decode failed");
        return output;
    }
}
// Metadata/texture-loading shims only. The tight path is rejected before CutImage.
public enum SpritePackingMode { Tight = 0, Rectangle = 1 }
public enum SpritePackingRotation { None = 0, FlipHorizontal = 1, FlipVertical = 2, Rotate180 = 3, Rotate90 = 4 }
public class SpriteSettings {
    public uint packed;
    public SpritePackingMode packingMode;
    public SpritePackingRotation packingRotation;
    public SpriteSettings(uint raw) {
        packed = raw & 1; packingMode = (SpritePackingMode)((raw >> 1) & 1);
        packingRotation = (SpritePackingRotation)((raw >> 2) & 15);
    }
}
public class Rectf { public float x, y, width, height; }
public class SpriteRenderData { }
public class Sprite {
    public SpriteRenderData m_RD = new SpriteRenderData();
    public float m_PixelsToUnits;
    public Rectf m_Rect = new Rectf();
    public Vector2 m_Pivot;
}
public class Texture2D {
    public int m_Width, m_Height;
    public byte[] bgra;
    public Image<Bgra32> ConvertToImage(bool flip) {
        if (flip) throw new Exception("oracle requires stored rows");
        return Image.LoadPixelData<Bgra32>(bgra, m_Width, m_Height);
    }
}
public static class SpriteHelper {
''' + cut + '''
    private static Vector2[][] GetTriangles(SpriteRenderData unused) {
        throw new Exception("tight geometry is outside this oracle");
    }
    public static Image<Bgra32> Run(Texture2D texture, Rectf rect, Vector2 offset, float scale, uint raw) {
        var settings = new SpriteSettings(raw);
        if (settings.packingMode != SpritePackingMode.Rectangle) throw new Exception("rectangle only");
        return CutImage(new Sprite(), texture, rect, offset, scale, settings);
    }
}
public class Program {
    static float Number(JsonElement value, string key) => value.GetProperty(key).GetSingle();
    public static void Main(string[] args) {
        if (!BitConverter.IsLittleEndian) throw new Exception("AssetStudio decoder requires little-endian host");
        var results = new List<object>();
        foreach (var job in JsonDocument.Parse(File.ReadAllText(args[0])).RootElement.EnumerateArray()) {
            int width = job.GetProperty("width").GetInt32(), height = job.GetProperty("height").GetInt32();
            bool variant = job.GetProperty("kind").GetString() == "variant";
            var bgra = new Converter(width, height).Run(variant ? "RGBA32" : job.GetProperty("name").GetString(),
                File.ReadAllBytes(job.GetProperty("input").GetString()));
            if (variant) {
                var rect = job.GetProperty("textureRect"); var offset = job.GetProperty("textureRectOffset");
                using var image = SpriteHelper.Run(new Texture2D { m_Width = width, m_Height = height, bgra = bgra },
                    new Rectf { x = Number(rect, "x"), y = Number(rect, "y"), width = Number(rect, "width"), height = Number(rect, "height") },
                    new Vector2(Number(offset, "x"), Number(offset, "y")), Number(job, "downscaleMultiplier"),
                    job.GetProperty("settingsRaw").GetUInt32());
                // CutImage returns top-down. Normalize the reference to stored rows.
                image.Mutate(x => x.Flip(FlipMode.Vertical));
                width = image.Width; height = image.Height; bgra = new byte[width * height * 4];
                image.CopyPixelDataTo(bgra);
            }
            for (int i = 0; i < bgra.Length; i += 4) {
                byte red = bgra[i + 2]; bgra[i + 2] = bgra[i]; bgra[i] = red;
            }
            File.WriteAllBytes(job.GetProperty("output").GetString(), bgra);
            results.Add(new { width, height });
        }
        File.WriteAllText(args[1], JsonSerializer.Serialize(results));
    }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "project", "output"]:
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    parser.add_argument("--dotnet", default=shutil.which("dotnet"))
    args = parser.parse_args()
    if UnityPy.__version__ != "1.25.3":
        raise SystemExit("requires UnityPy==1.25.3 for the 2019 acceptance bundles")
    if not args.dotnet:
        raise SystemExit(".NET 8 SDK required; supply --dotnet")
    source, project = external(args.source), external(args.project)
    sources = source_files(source)
    jobs = inputs()
    for name in ["Program.cs", "Check.csproj", "NuGet.config", "packages.lock.json", "obj", "bin", "packages", "cli-home"]:
        external(project / name)
    project.mkdir(parents=True, exist_ok=True)
    package_references = "\n".join(
        f'    <PackageReference Include="{identity.split("/")[0]}" Version="[{identity.split("/")[1]}]" />'
        for identity in PACKAGE_HASHES)
    (project / "Check.csproj").write_text('''<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile></PropertyGroup>
  <ItemGroup>
''' + package_references + '\n  </ItemGroup>\n</Project>\n')
    (project / "NuGet.config").write_text(
        '<configuration><packageSources><clear /><add key="nuget.org" value="' + NUGET_SOURCE + '" /></packageSources></configuration>\n')
    (project / "Program.cs").write_text(harness(sources))
    manifest = []
    for index, job in enumerate(jobs):
        raw_path, output_path = project / f"{index}.raw", project / f"{index}.rgba"
        raw_path.write_bytes(job["raw"])
        manifest.append({**{key: value for key, value in job.items() if key != "raw"},
                         "input": str(raw_path), "output": str(output_path)})
    (project / "jobs.json").write_text(json.dumps(manifest))
    environment = dict(os.environ, DOTNET_CLI_HOME=str(project / "cli-home"),
                       NUGET_PACKAGES=str(project / "packages"),
                       DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1")
    restore = [args.dotnet, "restore", str(project / "Check.csproj"), "--configfile", str(project / "NuGet.config")]
    if (project / "packages.lock.json").exists():
        restore.append("--locked-mode")
    subprocess.run(restore, env=environment, check=True)
    assets = json.loads((project / "obj/project.assets.json").read_text())
    if set(assets["libraries"]) != set(PACKAGE_HASHES):
        raise SystemExit("resolved NuGet package identities differ from the pinned oracle")
    for identity, expected in PACKAGE_HASHES.items():
        name, version = identity.lower().split("/")
        archive = project / "packages" / name / version / f"{name}.{version}.nupkg"
        actual = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
        if actual != expected:
            raise SystemExit("NuGet archive checksum mismatch: " + identity)
    subprocess.run([args.dotnet, "build", str(project / "Check.csproj"), "--no-restore", "-o", str(project / "bin")],
                   env=environment, check=True)
    subprocess.run([args.dotnet, str(project / "bin/Check.dll"), str(project / "jobs.json"),
                    str(project / "results.json")], env=environment, check=True)
    dimensions = json.loads((project / "results.json").read_text())
    result = {
        "verdict": "AssetStudio", "revision": REVISION, "sourceBlobs": BLOBS,
        "source": f"https://github.com/Razviar/assetstudio/tree/{REVISION}/AssetStudio.Utility",
        "generator": "scripts/cross-check-fixture-oracles.py", "inputOracle": "UnityPy 1.25.3",
        "nugetSource": NUGET_SOURCE, "packageSha512": PACKAGE_HASHES,
        "packages": {"SixLabors.ImageSharp.Drawing": "1.0.0-beta15", "SixLabors.ImageSharp": "2.1.3", "SixLabors.Fonts": "1.0.0-beta18"},
        "execution": "Unmodified DecodeRG16/RG32/RGBA64/RGBA32, DownScaleFrom16BitTo8Bit and CutImage methods in an external .NET 8 harness. Metadata/loading shims; rectangle path only, tight path rejected. ImageSharp default bicubic resize. Full AssetStudio application not run. BGRA swapped to RGBA once; CutImage output flipped back to bottom row first.",
        "plain": {}, "variants": {VARIANT: {}},
    }
    for job, manifest_job, size in zip(jobs, manifest, dimensions):
        rgba = pathlib.Path(manifest_job["output"]).read_bytes()
        assert len(rgba) == size["width"] * size["height"] * 4
        pixels = {**size, "imageSha256": digest(job["raw"]), "rgbaSha256": digest(rgba),
                  "rgbaHex": rgba.hex(), "firstPixel": list(rgba[:4])}
        if job["kind"] == "plain":
            result["plain"][job["name"]] = {**pixels, "format": job["format"], "method": "Decode" + job["name"]}
        else:
            rect = job["textureRect"]
            assert size == {"width": math.ceil(rect["x"] + rect["width"]) - math.floor(rect["x"]),
                            "height": math.ceil(rect["y"] + rect["height"]) - math.floor(rect["y"])}
            result["variants"][VARIANT][job["name"]] = {**pixels, "textureWidth": job["width"], "textureHeight": job["height"],
                **{key: job[key] for key in ["textureRect", "textureRectOffset", "settingsRaw", "downscaleMultiplier"]}}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print("Generated three plain and two native half-scale variant references: " + str(args.output))


if __name__ == "__main__":
    main()
