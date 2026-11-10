import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { builtinModules } from "node:module";

import { declaredDependencies, failOnTypeErrors } from "../../rollup.reader.mjs";

// An application, not a library: one ESM file, the bin, with the declared
// packages and node builtins left as imports (#338). No .d.ts: nothing imports it.
export default {
  input: "./src/cli.ts",
  output: { file: "dist/cli.mjs", format: "es", banner: "#!/usr/bin/env node" },
  external: [
    ...declaredDependencies(),
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  onwarn: failOnTypeErrors,
  plugins: [
    resolve({ preferBuiltins: true }),
    typescript({ tsconfig: "./tsconfig.json", outputToFilesystem: true }),
  ],
};
