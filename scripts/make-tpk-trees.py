#!/usr/bin/env python3
"""Write Unity's player type trees of a class, as UnityPy's TPK data records them (#235).

TPK holds the type tree of every built-in class at each Unity version where it
changed. The class readers' version gates come from it; this dumps the trees
themselves, so a test can read a hand-built object through `readTypeTree()`
with the tree of its version and compare that with the class reader (R12: the
oracle's data, not this library's output). Only the trees from Unity 2019.1,
the supported floor (plan revision 2026-10-16), are kept: the one that holds at
2019.1 and every later one.

Output: fixtures/tpk-trees.json, `classes[<class id>][<first version>]`, each
tree in pre-order as `[level, type, name, byteSize, metaFlag]` (the goldens'
node form). Run with the oracle venv:

    .venv-oracle/bin/python scripts/make-tpk-trees.py 43
"""
import json
import pathlib
import sys

import UnityPy
from UnityPy.helpers.Tpk import get_typetree

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "tpk-trees.json"
FLOOR = (2019, 1)


def nodes(tree, root):
    out = []
    stack = [(root, 0)]
    while stack:
        node_id, level = stack.pop(0)
        node = tree.NodeBuffer[node_id]
        out.append([
            level,
            tree.StringBuffer[node.TypeName],
            tree.StringBuffer[node.Name],
            node.ByteSize,
            node.MetaFlag,
        ])
        stack = [(child, level + 1) for child in node.SubNodes] + stack
    return out


def main(class_ids):
    tree = get_typetree()
    classes = {}
    for class_id in class_ids:
        trees = [
            (version, info)
            for version, info in tree.ClassInformation[class_id]
            if info is not None and info.ReleaseRootNode is not None
        ]
        # The last tree that starts at or before the floor holds at the floor.
        start = max(i for i, (v, _) in enumerate(trees) if (v.major, v.minor) <= FLOOR)
        classes[str(class_id)] = {
            str(version): nodes(tree, info.ReleaseRootNode) for version, info in trees[start:]
        }
    data = {
        "_oracle": f"UnityPy {UnityPy.__version__} (TPK)",
        "_generator": "scripts/make-tpk-trees.py",
        "classes": classes,
    }
    # One node per line, so a regenerated tree diffs by node.
    OUT.write_text(json.dumps(data, indent=1).replace("\n     ", "").replace("\n    ]", "]") + "\n")


if __name__ == "__main__":
    main([int(arg) for arg in sys.argv[1:]])
