#!/usr/bin/env python3
"""Generate fixtures/shader-layouts.json from UnityPy's type tree data (#237).

The Shader reader has version gates no fixture editor covers: the shader
fixtures (fixtures/BUILDING.md section 18) come from a few editors only. For
every layout from Unity 2019.1 (the oldest the reader supports), this writes
one synthetic Shader object per Unity version, laid out by the Shader type
tree UnityPy's TPK data
records for that version (the type trees UnityPy reads a file without type
trees by), with a distinct generated value in every field and one element in
every array (two in the byte and UInt16 arrays, so their padding shows).

Goldens come from the oracle (R12): the object is written with UnityPy's own
`write_typetree`, read back with its `read_typetree` (which must consume every
byte), and the read-back value, normalized, is hashed. The tests hand the
bytes to `readShader` and compare the hash of its result.

Normalization: int64 fields as decimal strings, byte arrays as "hex:<hex>",
pairs and map entries as two-element lists, and keys in type tree order.
Floats stay numbers: every generated float is k + 0.25, which Python and
JavaScript print alike.

Usage:  .venv-oracle/bin/python scripts/make-shader-layouts.py
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
from io import BytesIO

from UnityPy.helpers import Tpk
from UnityPy.helpers.TypeTreeHelper import read_typetree, write_typetree
from UnityPy.helpers.UnityVersion import UnityVersion
from UnityPy.streams import EndianBinaryReader, EndianBinaryWriter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "shader-layouts.json"
SHADER = 48

# One release per Shader layout in the TPK data from 2019.1 on, at or after
# the version that introduced it, plus the 2020.3.30f1 and 6000.3.25f1 fixture
# editors. Alphas and betas with interim layouts are left out, as the
# reader's gates compare release numbers only.
VERSIONS = [
    "2019.1.0f1",
    "2019.3.0f1",
    "2020.1.0f1",
    "2020.2.0f1",
    "2020.3.0f1",
    "2020.3.30f1",
    "2021.1.0f1",
    "2021.1.1f1",
    "2021.2.0f1",
    "2021.3.0f1",
    "2021.3.10f1",
    "2021.3.12f1",
    "2022.1.0f1",
    "2022.1.13f1",
    "2022.1.21f1",
    "2022.2.0f1",
    "2023.1.0f1",
    "2023.2.0f1",
    "6000.0.0f1",
    "6000.3.25f1",
    "6000.5.0f1",
    "6000.6.4f1",
]

INT64_TYPES = {"SInt64", "UInt64", "long long", "unsigned long long", "FileSize"}
BYTE_TYPES = {"UInt8", "SInt8", "char"}
ARRAY_TYPES = {"vector", "staticvector", "set", "map"}


def generate(node, counter):
    """A distinct value for every field of `node`, in type tree order."""
    counter[0] += 1
    k = counter[0]
    t = node.m_Type
    if t in ARRAY_TYPES:
        element = node.m_Children[0].m_Children[1]
        count = 2 if element.m_Type in BYTE_TYPES or element.m_Type == "UInt16" else 1
        if element.m_Type in BYTE_TYPES:
            # Odd length, so a missing align shows.
            return bytes((k * 37 + 11 + i) & 0xFF for i in range(3))
        return [generate(element, counter) for _ in range(count)]
    if t == "pair":
        return (generate(node.m_Children[0], counter), generate(node.m_Children[1], counter))
    if t == "string":
        text = f"{node.m_Name}#{k}"
        return text + "x" if len(text) % 4 == 0 else text
    if t == "bool":
        return k % 2 == 0
    if t == "float":
        return k + 0.25
    if t == "SInt8":
        return (k * 7) % 200 - 100
    if t in ("UInt8", "char"):
        return (k * 37 + 11) & 0xFF
    if t == "UInt16":
        return (k * 257 + 3) & 0xFFFF
    if t in ("int", "SInt32"):
        return -(k * 1009 + 7) if k % 2 else k * 1009 + 7
    if t in ("unsigned int", "UInt32"):
        return 0x8000_0000 + k
    if t in ("SInt64", "long long"):
        return -(2**40) - k * 3
    if not node.m_Children:
        raise SystemExit(f"no generator for {t} {node.m_Name}")
    return {child.m_Name: generate(child, counter) for child in node.m_Children}


def normalize(node, value):
    """`value` in the hashed form, walking the type tree next to it."""
    t = node.m_Type
    if t in INT64_TYPES:
        return str(value)
    if t in ARRAY_TYPES:
        element = node.m_Children[0].m_Children[1]
        if element.m_Type in BYTE_TYPES:
            return "hex:" + bytes(value).hex()
        return [normalize(element, v) for v in value]
    if t == "pair":
        return [normalize(node.m_Children[0], value[0]), normalize(node.m_Children[1], value[1])]
    if node.m_Children and t != "string":
        return {c.m_Name: normalize(c, value[c.m_Name]) for c in node.m_Children}
    return value


def layout(version: str) -> dict:
    root = Tpk.get_typetree_node(SHADER, UnityVersion.from_str(version))
    value = generate(root, [0])
    writer = EndianBinaryWriter(endian="<")
    write_typetree(value, root, writer)
    data = writer.bytes
    back = read_typetree(root, EndianBinaryReader(data, endian="<"), byte_size=len(data))
    expected = normalize(root, back)
    assert expected == normalize(root, value), f"{version}: UnityPy did not read back its own write"
    text = json.dumps(expected, separators=(",", ":"), ensure_ascii=False)
    return {
        "version": version,
        "fields": list(expected),
        "bytes": base64.b64encode(data).decode(),
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    }


def main() -> None:
    import UnityPy

    result = {
        "_oracle": f"UnityPy {UnityPy.__version__} (TPK type trees, write/read_typetree)",
        "_generator": "scripts/make-shader-layouts.py",
        "layouts": [layout(v) for v in VERSIONS],
    }
    OUT.write_text(json.dumps(result, indent=1) + "\n")
    print(f"{len(VERSIONS)} layouts -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
