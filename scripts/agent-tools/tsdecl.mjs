// Prints TypeScript declarations by name, with their JSDoc, for look.py's `ts:` spec.
//
//   node tsdecl.mjs [--max N] [--tests] <file-or-dir> <Name|Class.member>...
//
// A directory is searched recursively (no node_modules, dist or .d.ts; tests only with --tests).
// Names match functions, classes, interfaces, type aliases, enums and exported or top-level
// const/let/var; `Class.member` matches a method, property or accessor of a class or interface.
// Uses the repository's own `typescript` dev dependency, so the checkout needs `npm ci`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch {
  console.log("error: typescript is not installed in this checkout; run npm ci");
  process.exit(0);
}

const args = process.argv.slice(2);
let max = 150;
let tests = false;
while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  if (flag === "--max") max = Number(args.shift());
  else if (flag === "--tests") tests = true;
}
const [target, ...names] = args;

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  const res = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const p = join(path, entry.name);
    if (entry.isDirectory()) res.push(...files(p));
    else if (/\.(ts|mts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && (tests || !/\.test\.ts$/.test(entry.name))) res.push(p);
  }
  return res;
}

function nameOf(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
}

/** Top-level declarations of a file by name, and the members of its classes and interfaces. */
function declarations(sf) {
  const found = [];
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) found.push([d.name.text, st]);
      }
      continue;
    }
    const n = nameOf(st);
    if (!n) continue;
    found.push([n, st]);
    if (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) {
      for (const m of st.members) {
        const mn = nameOf(m);
        if (mn) found.push([`${n}.${mn}`, m]);
      }
    }
  }
  return found;
}

const want = new Set(names);
const seen = new Set();
const out = [];
for (const file of files(target)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  for (const [name, node] of declarations(sf)) {
    if (!want.has(name)) continue;
    seen.add(name);
    // getStart(sf, true) starts at the declaration's own JSDoc, not at earlier comments.
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf, true)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    out.push(`== ${relative(process.cwd(), file) || file}:${start + 1}-${end + 1} ${name}`);
    const rows = [];
    for (let i = start; i <= end; i++) rows.push(`${i + 1}\t${lines[i]}`);
    out.push(...rows.slice(0, max));
    if (rows.length > max) out.push(`... (${rows.length - max} more lines cut; read ${file}:${start + 1 + max}-${end + 1})`);
  }
}
for (const n of names) if (!seen.has(n)) out.push(`== ${n}: no declaration under ${target}`);
console.log(out.join("\n"));
