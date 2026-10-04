#!/usr/bin/env python3
"""Execute AssetStudio's pinned RGB48 methods in an external .NET 8 harness.

Supply the original Texture2DConverter.cs (outside the repo) and the 240 raw
bytes extracted from the fixture with UnityPy. No C# is written into the repo.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

SOURCE_REVISION = "c37af7dfcdafee93e33b5da9f0285c97998d6ae3"
SOURCE_BLOB = "91c659434c07d92ea1d6fbc634d222fc37222b4f"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def method(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "input", "project", "output"]:
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    parser.add_argument("--dotnet", default=shutil.which("dotnet"))
    args = parser.parse_args()
    source_path, project = args.source.resolve(), args.project.resolve()
    for path in [source_path, project]:
        if path == ROOT or ROOT in path.parents:
            raise SystemExit("C# reference and harness must stay outside the repository (R2)")
    raw_source = source_path.read_bytes()
    blob = hashlib.sha1(b"blob " + str(len(raw_source)).encode() + b"\0" + raw_source).hexdigest()
    if blob != SOURCE_BLOB:
        raise SystemExit("source does not match pinned AssetStudio blob: " + blob)
    raw = args.input.read_bytes()
    if len(raw) != 240:
        raise SystemExit("expected 240 RGB48 bytes (8x5), got " + str(len(raw)))
    if not args.dotnet:
        raise SystemExit(".NET 8 SDK required; supply --dotnet if it is not on PATH")
    source = raw_source.decode()
    methods = "\n".join(method(source, signature) for signature in [
        "public static byte DownScaleFrom16BitTo8Bit(ushort component)",
        "private bool DecodeRGB48(byte[] image_data, byte[] buff)",
    ])
    project.mkdir(parents=True, exist_ok=True)
    (project / "Check.csproj").write_text(
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
        '<TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n')
    (project / "Program.cs").write_text('''using System;
using System.IO;
public class Converter {
    private int m_Width = 8, m_Height = 5;
''' + methods + '''
    public byte[] Run(byte[] input) {
        var rgba = new byte[160];
        if (!DecodeRGB48(input, rgba)) throw new Exception("decode failed");
        for (int i = 0; i < rgba.Length; i += 4) {
            byte red = rgba[i + 2]; rgba[i + 2] = rgba[i]; rgba[i] = red;
        }
        return rgba;
    }
}
public class Program {
    public static void Main(string[] args) {
        File.WriteAllBytes(args[1], new Converter().Run(File.ReadAllBytes(args[0])));
    }
}
''')
    environment = dict(os.environ, DOTNET_CLI_HOME=str(project / "cli-home"),
                       DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1")
    subprocess.run([args.dotnet, "build", str(project / "Check.csproj"),
                    "--ignore-failed-sources", "-o", str(project / "bin")],
                   env=environment, check=True)
    output = project / "rgb48.rgba"
    subprocess.run([args.dotnet, str(project / "bin/Check.dll"),
                    str(args.input.resolve()), str(output)], env=environment, check=True)
    rgba = output.read_bytes()
    assert len(rgba) == 160
    result = {
        "verdict": "AssetStudio",
        "source": f"https://github.com/Razviar/assetstudio/blob/{SOURCE_REVISION}/AssetStudio.Utility/Texture2DConverter.cs",
        "sourceBlob": blob,
        "methods": ["DecodeRGB48", "DownScaleFrom16BitTo8Bit"],
        "execution": "Unmodified converter methods executed in an external .NET 8 harness; BGRA swapped to RGBA once; bottom row first. Full AssetStudio application was not run.",
        "generator": "scripts/cross-check-rgb48.py",
        "inputSha256": hashlib.sha256(raw).hexdigest(),
        "width": 8, "height": 5,
        "firstPixel": list(rgba[:4]),
        "rgbaSha256": hashlib.sha256(rgba).hexdigest(),
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
