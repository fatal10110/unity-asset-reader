import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  BuildTarget,
  detectFileType,
  readBundle,
  readTypeTree,
  type BundleHeader,
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

Options:
  -h, --help                   print this help

Exit status: 0 on success, 1 when an asset or the input failed, 2 on a usage error.
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

type Command = "ls" | "info" | "extract" | "dump";
type Option = keyof typeof OPTIONS;

/** The options each command takes, `--help` aside. */
const COMMAND_OPTIONS: Record<Command, Option[]> = {
  ls: ["type", "json"],
  info: [],
  extract: ["type", "output", "mesh", "vorbis-headers"],
  dump: ["path-id", "file"],
};

/**
 * Run the command line `argv` (the arguments after the program name) and
 * return its exit status: 0 on success, 1 when the input or an asset failed,
 * 2 on a usage error. Reports go to `io.err`, results to `io.out`.
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
  if (!(name in COMMAND_OPTIONS)) throw new UsageError(`unknown command "${name}"`);
  const command = name as Command;
  for (const option of Object.keys(values) as Option[]) {
    if (option !== "help" && !COMMAND_OPTIONS[command].includes(option)) {
      throw new UsageError(`${command} does not take --${option}`);
    }
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

/** A legacy bundle's compression: before format 6, UnityWeb is one LZMA stream, UnityRaw stored. */
function compressionOf(header: BundleHeader): string | undefined {
  if (header.signature !== "UnityFS" && header.version !== 6) {
    return header.signature === "UnityWeb" ? "LZMA" : "uncompressed";
  }
  // ponytail: a UnityFS header names the codec of its blocks info only (LZ4HC
  // in an LZMA or an uncompressed build too); each data block's is in the
  // blocks info, which readBundle() keeps to itself. Named once core exposes
  // the blocks (#355).
  return undefined;
}

/** The name of a `BuildTarget` value, or the number for one this library does not name. */
function platformName(platform: number): string {
  const entry = Object.entries(BuildTarget).find(([, value]) => value === platform);
  return entry ? entry[0] : `platform ${platform}`;
}

/** The files a path stands for, as `loadPath` scans them: the file, or every file below it. */
function inputFiles(input: string): string[] {
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
  for (const file of inputFiles(input)) {
    const name = isDir ? relative(input, file).split(sep).join("/") : basename(file);
    const buffer = readFileSync(file);
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const type = detectFileType(data);
    let line = `  ${name}: ${type}`;
    if (type === "UnityFS" || type === "UnityWeb" || type === "UnityRaw") {
      // ponytail: reads each bundle a second time, for its header only; a
      // header-only reader in core if a large input makes that matter.
      const { header } = readBundle(data);
      line += `, format ${header.version}, Unity ${header.unityRevision}`;
      const compression = compressionOf(header);
      if (compression !== undefined) line += `, ${compression}`;
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
