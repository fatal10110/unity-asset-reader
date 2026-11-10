import { main } from "./main.js";

// The bin: exit codes as `main` returns them, set rather than `process.exit()`
// so a large `ls --json` or `dump` on a pipe is written out in full first.
main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
