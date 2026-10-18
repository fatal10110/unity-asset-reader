#!/usr/bin/env python3
"""Write packages/shader/src/grammar.ts from CSspv's SPIR-V grammar (#242).

The SPIR-V disassembler of unity-asset-reader-shader is a TypeScript port of
CSspv as AssetStudio vendors it (BSD-2-Clause). CSspv's grammar is a generated
C# file, AssetStudio.Utility/CSspv/SpirV.Core.Grammar.cs: one enum per operand
kind, a parameter factory per enum naming the operands a value takes, and an
Instruction class per opcode. This script reads that file at REVISION from a
clone of Razviar/assetstudio OUTSIDE the repository (R2: no C# is committed)
and writes the same content as TypeScript tables, so the port's grammar can be
regenerated and checked instead of trusted.

Operand types map to the codes grammar.ts documents (`I` IdRef, `R` IdResult,
`T` IdResultType, ...); `EnumType<E, EParameterFactory>` is the enum's name and
`EnumType<E>` (the base factory, never any parameters) its name with a `!`.
Quantifiers become `?` (Optional) and `*` (Varying). Enums keep their
declaration order, which is also .NET's sorted order (each one is declared in
ascending value order; the script checks).

Usage:
  python3 scripts/make-spirv-grammar.py --source <assetstudio clone>          # write
  python3 scripts/make-spirv-grammar.py --source <assetstudio clone> --check  # compare
"""
import argparse
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "packages" / "shader" / "src" / "grammar.ts"
REVISION = "c37af7dfcdafee93e33b5da9f0285c97998d6ae3"
GRAMMAR = "AssetStudio.Utility/CSspv/SpirV.Core.Grammar.cs"


def external(path: pathlib.Path) -> pathlib.Path:
    path = path.resolve()
    if path == ROOT or ROOT in path.parents:
        raise SystemExit("the AssetStudio clone must stay outside the repository (R2)")
    return path


def generate(src: str) -> str:
    # Operand type classes -> the codes the TS tables use.
    CODES = {
        "IdRef": "I",
        "IdResult": "R",
        "IdResultType": "T",
        "IdScope": "S",
        "IdMemorySemantics": "M",
        "LiteralInteger": "L",
        "LiteralString": "Str",
        "LiteralContextDependentNumber": "C",
        "LiteralExtInstInteger": "X",
        "LiteralSpecConstantOpInteger": "SC",
        "PairIdRefIdRef": "PII",
        "PairIdRefLiteralInteger": "PIL",
        "PairLiteralIntegerIdRef": "PLI",
    }

    def code(kind: str) -> str:
        kind = kind.strip()
        if kind in CODES:
            return CODES[kind]
        m = re.fullmatch(r"EnumType<(\w+), (\w+)ParameterFactory>", kind)
        if m:
            assert m.group(1) == m.group(2), kind
            return m.group(1)
        m = re.fullmatch(r"EnumType<(\w+)>", kind)
        if m:
            # The base ParameterFactory: never any parameters.
            return m.group(1) + "!"
        raise SystemExit("unknown operand type " + kind)

    enums = []
    for m in re.finditer(r"(\[Flags\]\s*)?public enum (\w+) : uint\s*\{(.*?)\n    \}", src, re.S):
        entries = re.findall(r"(\w+) = (\d+),", m.group(3))
        enums.append((m.group(2), bool(m.group(1)), [(n, int(v)) for n, v in entries]))

    factories = {}
    for m in re.finditer(r"public class (\w+)ParameterFactory : ParameterFactory\s*\{(.*?)\n    \}\n", src, re.S):
        name, body = m.group(1), m.group(2)
        params = {}
        for p in re.finditer(r"public class (\w+)Parameter : Parameter.*?new List<OperandType>\(\)\s*\{(.*?)\}", body, re.S):
            params[p.group(1)] = [code(k) for k in re.findall(r"new ([\w<>, ]+?)\(\)", p.group(2))]
        cases = {}
        for c in re.finditer(r"case (\w+)\.(\w+):\s*return new (\w+)Parameter\(\);", body):
            assert c.group(1) == name
            cases[c.group(2)] = params[c.group(3)]
        factories[name] = cases

    instructions = {}
    for m in re.finditer(r"public class (Op\w+) : Instruction\s*\{\s*public \1\(\) : base\(\"(\w+)\"(.*?)\)\s*\{\s*\}\s*\}", src, re.S):
        ops = []
        for o in re.finditer(r"new Operand\(new ([\w<>, ]+?)\(\), (?:null|\"[^\"]*\"), OperandQuantifier\.(\w+)\)", m.group(3)):
            q = {"Default": "", "Optional": "?", "Varying": "*"}[o.group(2)]
            ops.append(code(o.group(1)) + q)
        instructions[m.group(1)] = (m.group(2), ops)

    opcodes = [(int(n), c) for n, c in re.findall(r"\{ (\d+), new (Op\w+)\(\) \}", src)]
    assert len(opcodes) == len(instructions), (len(opcodes), len(instructions))

    out = []
    w = out.append
    w("// Ported from AssetStudio.Utility/CSspv/SpirV.Core.Grammar.cs (BSD-2-Clause, © 2017 Matthäus G. Chajdas)")
    w("//")
    w("// The SPIR-V grammar CSspv was generated with (SPIR-V 1.2 and the extensions")
    w("// of its day), as data: the enums in their declaration order, the operands")
    w("// each enum value takes, and every instruction CSspv knows. Written by")
    w("// scripts/make-spirv-grammar.py from that file at Razviar/assetstudio")
    w("// c37af7d; not edited by hand.")
    w("")
    w("/**")
    w(" * An operand type: `I` IdRef, `R` IdResult, `T` IdResultType, `S` IdScope,")
    w(" * `M` IdMemorySemantics, `L` LiteralInteger, `Str` LiteralString, `C`")
    w(" * LiteralContextDependentNumber, `X` LiteralExtInstInteger, `SC`")
    w(" * LiteralSpecConstantOpInteger, `PII` PairIdRefIdRef, `PIL`")
    w(" * PairIdRefLiteralInteger, `PLI` PairLiteralIntegerIdRef; otherwise an enum's")
    w(" * name, ending in `!` when CSspv reads it without its parameters.")
    w(" */")
    w("export type OperandCode = string;")
    w("")
    w("/** An enum of the grammar. */")
    w("export interface GrammarEnum {")
    w("  /** C#'s `[Flags]`: a bit set. */")
    w("  flags: boolean;")
    w("  /** Name and value, in declaration order. */")
    w("  entries: readonly (readonly [string, number])[];")
    w("  /** The operands that follow a value, by value name. */")
    w("  params: Readonly<Record<string, readonly OperandCode[]>>;")
    w("}")
    w("")
    w("/** Every enum of the grammar, by name. */")
    w("export const ENUMS: Readonly<Record<string, GrammarEnum>> = {")
    for name, flags, entries in enums:
        w(f"  {name}: {{")
        w(f"    flags: {'true' if flags else 'false'},")
        w("    entries: [")
        line = "     "
        for n, v in entries:
            item = f' ["{n}", {v}],'
            if len(line) + len(item) > 100:
                w(line)
                line = "     "
            line += item
        if line.strip():
            w(line)
        w("    ],")
        params = factories.get(name, {})
        if params:
            w("    params: {")
            for k, ops in params.items():
                w(f"      {k}: [{', '.join(repr(o).replace(chr(39), chr(34)) for o in ops)}],")
            w("    },")
        else:
            w("    params: {},")
        w("  },")
    w("};")
    w("")
    w("/**")
    w(" * Every instruction CSspv knows, by opcode: its name, then its operands, each")
    w(" * an {@link OperandCode} with `?` for optional and `*` for any number.")
    w(" */")
    w("export const INSTRUCTIONS: ReadonlyMap<number, readonly string[]> = new Map(")
    w("  [")
    for n, cls in opcodes:
        name, ops = instructions[cls]
        items = ", ".join(f'"{x}"' for x in [name, *ops])
        entry = f"    [{n}, [{items}]],"
        if len(entry) > 100:
            w(f"    [")
            w(f"      {n},")
            w(f"      [{items}],")
            w(f"    ],")
        else:
            w(entry)
    w("  ] as [number, string[]][],")
    w(");")

    for name, flags, entries in enums:
        values = [v for _, v in entries]
        if values != sorted(values):
            raise SystemExit(f"{name}: not declared in value order; .NET would sort it")
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, type=pathlib.Path,
                        help="a git clone of Razviar/assetstudio holding " + REVISION)
    parser.add_argument("--check", action="store_true",
                        help="compare with the committed grammar.ts instead of writing it")
    args = parser.parse_args()
    source = external(args.source)
    # The file as the revision has it, whatever the clone has checked out.
    src = subprocess.run(["git", "-C", str(source), "show", f"{REVISION}:{GRAMMAR}"],
                         check=True, capture_output=True).stdout.decode("utf-8-sig")
    text = generate(src)
    if args.check:
        if OUTPUT.read_text() != text:
            sys.exit(f"{OUTPUT.relative_to(ROOT)} differs from what {GRAMMAR} at "
                     f"{REVISION[:7]} gives; rerun without --check")
        print(f"{OUTPUT.relative_to(ROOT)} matches {GRAMMAR} at {REVISION[:7]}")
    else:
        OUTPUT.write_text(text)
        print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
