import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  BuildTarget,
  detectFileType,
  diff,
  readBundle,
  readTypeTree,
  type BundleFile,
  type DiffEntry,
  type Env,
  type ObjectReader,
} from "unity-asset-reader";
import { loadPath } from "unity-asset-reader-node";

import { extract, readVorbisHeaders, type MeshFormat } from "./extract.js";
import { describeError, jsonReplacer, UsageError } from "./util.js";

/** Where a command writes: standard output and standard error, without a trailing newline added. */
export interface Io {
  /** Write to standard output. */
  out(text: string): void;
  /** Write to standard error. */
  err(text: string): void;
}

/** The usage text `--help` prints. */
export const USAGE = `Usage: unity-asset-reader-cli <command> <file-or-dir> [options]

Takes one Unity file (an AssetBundle, a .assets file, a WebGL .data file) or one
directory. A directory loads every file below it together, so pointers between
bundles and .resS sidecars resolve; to load several files at once, pass their
directory.

Commands:
  ls <input>                   list the objects: type, name, container path,
                               path id, size and file
    --type <T,...>             only objects of these classes (Texture2D, ...)
    --json                     print a JSON array instead of a table
  info <input>                 containers, Unity version, platform, files and
                               object counts per class
  extract <input> -o <dir>     write the assets as files, into <dir>/<class>/
    --type <T,...>             only these classes (default: Texture2D, Sprite,
                               TextAsset, AudioClip, Mesh, Shader); any other
                               class is written as type tree JSON
    --mesh <obj|glb>           mesh format (default: obj)
    --vorbis-headers <file>    Vorbis setup headers by CRC-32, as JSON, to write
                               Vorbis AudioClips as .ogg (skipped without it)
  dump <input> --path-id <n>   one object's type tree as JSON
    --file <name>              the file holding it, when several have that id
  diff <old> <new>             the assets added, removed or modified between two
                               builds, one line each: change, class, container
                               path (or file/path id), size change, fields
    --json                     print a JSON array instead

Options:
  -h, --help                   print this help

Exit status: 0 on success, 1 when an asset or the input failed, 2 on a usage error.
diff exits 0 when the builds do not differ, 1 when they do, 2 on any error.
`;

const OPTIONS = {
  type: { type: "string" },
  json: { type: "boolean" },
  output: { type: "string", short: "o" },
  mesh: { type: "string" },
  "vorbis-headers": { type: "string" },
  "path-id": { type: "string" },
  file: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Command = "ls" | "info" | "extract" | "dump" | "diff";
type Option = keyof typeof OPTIONS;

/** The options each command takes, `--help` aside. */
const COMMAND_OPTIONS: Record<Command, Option[]> = {
  ls: ["type", "json"],
  info: [],
  extract: ["type", "output", "mesh", "vorbis-headers"],
  dump: ["path-id", "file"],
  diff: ["json"],
};

/**
 * Run the command line `argv` (the arguments after the program name) and
 * return its exit status: 0 on success, 1 when the input or an asset failed,
 * 2 on a usage error. `diff` has its own: 0 when the builds do not differ, 1
 * when they do, 2 on any error. Reports go to `io.err`, results to `io.out`.
 *
 * @param argv the arguments, e.g. `["ls", "ui.bundle", "--json"]`
 * @param io where to write
 * @returns the exit status
 */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.err(`error: ${(error as Error).message}\nRun unity-asset-reader-cli --help for usage.\n`);
      return 2;
    }
    io.err(`error: ${describeError(error)}\n`);
    return 1;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  // Path ids are often negative, and `--path-id -123` would read as an option.
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--path-id" && next !== undefined && /^-\d+$/.test(next)) {
      args.push(`--path-id=${next}`);
      i++;
    } else {
      args.push(argv[i]!);
    }
  }
  const { values, positionals } = parseArgs({
    args,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [name, ...inputs] = positionals;
  if (name === undefined) throw new UsageError("no command given");
  if (!Object.hasOwn(COMMAND_OPTIONS, name)) throw new UsageError(`unknown command "${name}"`);
  const command = name as Command;
  for (const option of Object.keys(values) as Option[]) {
    if (option !== "help" && !COMMAND_OPTIONS[command].includes(option)) {
      throw new UsageError(`${command} does not take --${option}`);
    }
  }
  if (command === "diff") {
    if (inputs.length !== 2) {
      throw new UsageError(
        `diff takes two files or directories, the old build and the new, got ${inputs.length}`,
      );
    }
    return diffBuilds(inputs[0]!, inputs[1]!, values.json === true, io);
  }
  if (inputs.length === 0) throw new UsageError(`${command} needs a file or directory`);
  if (inputs.length > 1) {
    throw new UsageError(
      `${command} takes one file or directory, got ${inputs.length} paths; to load several ` +
        "files together, put them in one directory and pass the directory",
    );
  }
  const input = inputs[0]!;
  const types = values.type === undefined ? undefined : typeList(values.type);

  // Everything the command line can get wrong is checked before the input is read.
  let mesh: MeshFormat = "obj";
  let vorbisHeaders;
  let pathId: bigint | undefined;
  if (command === "extract") {
    if (values.output === undefined) throw new UsageError("extract needs -o <dir>");
    if (values.mesh !== undefined) {
      if (values.mesh !== "obj" && values.mesh !== "glb") {
        throw new UsageError(`--mesh takes obj or glb, got "${values.mesh}"`);
      }
      mesh = values.mesh;
    }
    if (values["vorbis-headers"] !== undefined) {
      vorbisHeaders = readVorbisHeaders(values["vorbis-headers"]);
    }
  }
  if (command === "dump") {
    const raw = values["path-id"];
    if (raw === undefined) throw new UsageError("dump needs --path-id <n>");
    if (!/^-?\d+$/.test(raw)) throw new UsageError(`--path-id takes an integer, got "${raw}"`);
    pathId = BigInt(raw);
  }

  let env: Env;
  try {
    env = loadPath(input);
  } catch (error) {
    io.err(`error: ${input}: ${describeError(error)}\n`);
    return 1;
  }

  switch (command) {
    case "ls":
      return ls(env, types, values.json === true, io);
    case "info":
      return info(input, env, io);
    case "extract":
      return extract(env, { output: values.output!, types, mesh, vorbisHeaders }, io);
    case "dump":
      return dump(env, pathId!, values.file, io);
  }
}

/** Whether `error` is one `parseArgs` throws for a bad command line. */
function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/** The class names of a `--type` value, `Texture2D,Sprite`. */
function typeList(value: string): Set<string> {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) throw new UsageError("--type needs at least one class name");
  return new Set(names);
}

/** One row of `ls`. */
interface Row {
  type: string;
  name: string;
  path: string;
  pathId: string;
  size: number;
  file: string;
}

/** `ls`: one row per object, in `env.assets()` order. */
function ls(env: Env, types: Set<string> | undefined, json: boolean, io: Io): number {
  const rows: Row[] = [];
  let failed = 0;
  for (const asset of env.assets()) {
    if (types && !types.has(asset.typeName)) continue;
    // A name or path that cannot be read is reported, and the row kept.
    const read = (field: "name" | "path"): string => {
      try {
        return asset[field] ?? "";
      } catch (error) {
        const what = `${asset.typeName} ${field} (${where(asset.reader)})`;
        io.err(`failed: ${what}: ${describeError(error)}\n`);
        failed++;
        return "";
      }
    };
    rows.push({
      type: asset.typeName,
      name: read("name"),
      path: read("path"),
      pathId: asset.pathId.toString(),
      size: asset.byteSize,
      file: asset.file,
    });
  }
  if (json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const header = ["Type", "Name", "Path", "PathID", "Size", "File"];
    const cells = rows.map((r) => [r.type, r.name, r.path, r.pathId, String(r.size), r.file]);
    io.out(table([header, ...cells]));
  }
  return failed > 0 ? 1 : 0;
}

/** One entry of `diff --json`: a {@link DiffEntry} without its assets. */
interface DiffRow {
  change: DiffEntry["change"];
  type: string;
  name: string;
  path: string;
  file: string;
  pathId: string;
  sizeDelta: number;
  fields?: string[];
}

/**
 * `diff`: core `diff()` of the two builds, one line or JSON object per entry.
 * Its exit status differs from the other commands': 0 when nothing differs, 1
 * when something does, 2 when a build cannot be read or compared.
 */
function diffBuilds(oldInput: string, newInput: string, json: boolean, io: Io): number {
  const envs: Env[] = [];
  for (const input of [oldInput, newInput]) {
    try {
      envs.push(loadPath(input));
    } catch (error) {
      io.err(`error: ${input}: ${describeError(error)}\n`);
      return 2;
    }
  }
  let entries: DiffEntry[];
  try {
    entries = diff(envs[0]!, envs[1]!);
  } catch (error) {
    io.err(`error: ${describeError(error)}\n`);
    return 2;
  }
  const rows: DiffRow[] = entries.map((e) => ({
    change: e.change,
    type: e.type,
    name: e.name,
    path: e.path ?? "",
    file: e.file,
    pathId: e.pathId.toString(),
    sizeDelta: e.sizeDelta,
    fields: e.fields,
  }));
  if (json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    // No header: nothing at all is printed for two builds that do not differ.
    const cells = rows.map((r) => [
      r.change,
      r.type,
      r.path !== "" ? r.path : `${r.file}/${r.pathId}`,
      r.sizeDelta > 0 ? `+${r.sizeDelta}` : String(r.sizeDelta),
      r.fields?.join(",") ?? "",
    ]);
    io.out(table(cells));
  }
  return rows.length > 0 ? 1 : 0;
}

/** Columns padded to their widest cell, two spaces apart, the last one not padded. */
function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  const pad = (cell: string, i: number, row: string[]): string =>
    i < row.length - 1 ? cell.padEnd(widths[i]!) : cell;
  return rows.map((row) => `${row.map(pad).join("  ").trimEnd()}\n`).join("");
}

/** "file, path id N", for reports. */
function where(reader: ObjectReader): string {
  return `${reader.fileName}, path id ${reader.pathId}`;
}

/** Block codec names, indexed by `flags & 0x3f`; readBundle() refuses any other. */
const BLOCK_CODECS = ["uncompressed", "LZMA", "LZ4", "LZ4HC"];

/**
 * A bundle's data compression. Before format 6, UnityWeb is one LZMA stream and UnityRaw stored;
 * a UnityFS bundle names each data block's codec in its blocks info (its header's compression
 * bits name only the blocks info's), so the distinct ones in block order.
 */
function compressionOf({ header, blocks }: BundleFile): string | undefined {
  if (header.signature !== "UnityFS" && header.version !== 6) {
    return header.signature === "UnityWeb" ? "LZMA" : "uncompressed";
  }
  const names = new Set(
    blocks.map(({ flags }) => BLOCK_CODECS[flags & 0x3f] ?? `codec ${flags & 0x3f}`),
  );
  return names.size > 0 ? [...names].join(", ") : undefined;
}

/** The name of a `BuildTarget` value, or the number for one this library does not name. */
function platformName(platform: number): string {
  const entry = Object.entries(BuildTarget).find(([, value]) => value === platform);
  return entry ? entry[0] : `platform ${platform}`;
}

/**
 * One part of a file Unity split for size, as `loadPath` reads them:
 * `<name>.split0`, `.split1`, ..., no leading zeros.
 */
const SPLIT_PART = /^(.+)\.split(0|[1-9]\d*)$/;

/** One input file as `loadPath` reads it: a file, or the parts of a split file merged. */
interface InputFile {
  /** The path, or for a split file the merged name next to its parts. */
  path: string;
  /** How many parts it was merged from; 0 for a file that is not split. */
  parts: number;
  /** Its bytes. */
  data: Uint8Array;
}

/**
 * The files a path stands for, as `loadPath` scans them: the file, or every
 * file below it, with the parts of a split file merged in part order.
 */
function inputFiles(input: string): InputFile[] {
  const parts = new Map<string, Map<number, string>>();
  const files: InputFile[] = [];
  for (const path of inputPaths(input)) {
    const split = SPLIT_PART.exec(basename(path));
    if (!split) {
      files.push({ path, parts: 0, data: readBytes(path) });
      continue;
    }
    const merged = join(dirname(path), split[1]!);
    const own = parts.get(merged) ?? new Map<number, string>();
    own.set(Number(split[2]), path);
    parts.set(merged, own);
  }
  for (const [path, own] of parts) {
    // loadPath already refused a split file with a gap in its parts.
    const ordered = [...own].sort((a, b) => a[0] - b[0]).map(([, part]) => readBytes(part));
    const data = new Uint8Array(ordered.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of ordered) {
      data.set(part, offset);
      offset += part.length;
    }
    files.push({ path, parts: own.size, data });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A file's bytes, as a `Uint8Array`. */
function readBytes(path: string): Uint8Array {
  const buffer = readFileSync(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The paths a path stands for: the file, or every file below it. */
function inputPaths(input: string): string[] {
  if (!statSync(input).isDirectory()) return [input];
  const files: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      // A link to a file counts; a link to a directory is not followed.
      else if (entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile())) {
        files.push(path);
      }
    }
  };
  walk(input);
  return files;
}

/** `info`: the inputs' containers, the unpacked files, the Unity versions and the class counts. */
function info(input: string, env: Env, io: Io): number {
  const lines: string[] = ["Inputs:"];
  const isDir = statSync(input).isDirectory();
  for (const { path, parts, data } of inputFiles(input)) {
    const name = isDir ? relative(input, path).split(sep).join("/") : basename(path);
    const type = detectFileType(data);
    let line = `  ${name}${parts > 0 ? ` (${parts} split parts)` : ""}: ${type}`;
    if (type === "UnityFS" || type === "UnityWeb" || type === "UnityRaw") {
      // ponytail: reads each bundle a second time, for its header and blocks; a
      // header-only reader in core if a large input makes that matter.
      try {
        const bundle = readBundle(data);
        line += `, format ${bundle.header.version}, Unity ${bundle.header.unityRevision}`;
        const compression = compressionOf(bundle);
        if (compression !== undefined) line += `, ${compression}`;
      } catch (error) {
        line += `, header not readable: ${describeError(error)}`;
      }
    }
    lines.push(line);
  }

  const byFile = new Map<string, ObjectReader[]>();
  for (const obj of env.objects) {
    const list = byFile.get(obj.fileName) ?? [];
    list.push(obj);
    byFile.set(obj.fileName, list);
  }
  lines.push("Files:");
  for (const file of env.files) {
    const objects = byFile.get(file.path);
    let line = `  ${file.path}: ${detectFileType(file.data)}, ${file.data.length} bytes`;
    if (objects?.[0]) {
      const first = objects[0];
      const platform = platformName(first.platform);
      line += `, Unity ${first.unityVersion}, ${platform}, ${objects.length} objects`;
    }
    lines.push(line);
  }

  const distinct = (values: string[]): string => [...new Set(values)].join(", ") || "-";
  lines.push(`Unity version: ${distinct(env.objects.map((obj) => obj.unityVersion))}`);
  lines.push(`Platform: ${distinct(env.objects.map((obj) => platformName(obj.platform)))}`);

  const counts = new Map<string, number>();
  for (const { typeName } of env.assets()) counts.set(typeName, (counts.get(typeName) ?? 0) + 1);
  lines.push(`Objects: ${env.objects.length}`);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [type, count] of sorted) lines.push(`  ${type}: ${count}`);
  io.out(`${lines.join("\n")}\n`);
  return 0;
}

/** `dump`: the type tree of the object with that path id, as JSON. */
function dump(env: Env, pathId: bigint, file: string | undefined, io: Io): number {
  const found = env.objects.filter(
    (obj) => obj.pathId === pathId && (file === undefined || obj.fileName === file),
  );
  const at = file === undefined ? "" : ` in ${file}`;
  if (found.length === 0) {
    io.err(`error: no object with path id ${pathId}${at}\n`);
    return 1;
  }
  if (found.length > 1) {
    const files = found.map((obj) => obj.fileName).join(", ");
    throw new UsageError(`path id ${pathId} is in several files (${files}): pick one with --file`);
  }
  io.out(`${JSON.stringify(readTypeTree(found[0]!), jsonReplacer, 2)}\n`);
  return 0;
}
