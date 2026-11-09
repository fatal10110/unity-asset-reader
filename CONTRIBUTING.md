# Contributing to unity-asset-reader

Thank you for your interest in contributing to unity-asset-reader! This guide takes you from a
fresh clone to an open pull request: setup, building, testing, the code style and how to report
issues.

## Quick start

The shortest path from clone to pull request:

1. **Fork and clone** the repository, then fetch the C++ submodule (see
   [Installation Steps](#installation-steps)).
2. **Install** the dependencies from the repo root: `npm ci`.
3. **Build and test everything:** `npm run verify`. It builds every package, runs the tests, the
   browser-safety check and the no-C# guard. It needs no Docker: without a built WASM, the decoder
   tests and the texture decode tests are skipped.
4. **Branch from `main`**, make your change and add tests for it
   ([Making Changes](#making-changes)).
5. **Run `npm run verify` again**, then push and open a pull request
   ([Submitting Pull Requests](#submitting-pull-requests)).

```bash
npm ci
npm run verify
```

Only a change to the decoder's C++ or its WASM bindings needs Docker and `npm run build:wasm`
([Building the Project](#building-the-project)).

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Building the Project](#building-the-project)
- [Running Tests](#running-tests)
- [Making Changes](#making-changes)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Coding Standards](#coding-standards)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows a code of conduct to ensure a welcoming environment for all contributors.
Please be respectful and considerate in all interactions.

## Getting Started

Before contributing, please:

1. Check the existing [issues](https://github.com/fatal10110/unity-asset-reader/issues) to see
   if your concern has already been reported.
2. Read through this contributing guide.
3. Familiarize yourself with the [project structure](#project-structure).

## Development Setup

### Prerequisites

- **Node.js** 20.19.0 or later 20.x, or 22.12.0 or later. This is the `engines` range of the
  reader packages (`^20.19.0 || >=22.12.0`). The decoder package alone runs on Node.js 14.0.0
  or later.
- **Docker**, only to build the WebAssembly module (`npm run build:wasm`).
- **Git**, for version control.

### Installation Steps

1. **Fork and clone the repository:**

```bash
git clone https://github.com/YOUR_USERNAME/unity-asset-reader.git
cd unity-asset-reader
```

2. **Initialize git submodules:**

```bash
git submodule update --init --recursive
```

This downloads the C++ texture decoder source files from the upstream repository into
`packages/decoder/texture2ddecoder/`. Only the WASM build needs them.

3. **Install dependencies** (one root lockfile, all workspaces):

```bash
npm ci
```

4. **Verify Docker is installed** (only if you will build the WASM):

```bash
docker --version
```

If Docker is not installed, download it from
[https://www.docker.com/get-started](https://www.docker.com/get-started).

## Building the Project

To build every package (TypeScript only, no Docker), run `npm run build` from the repo root.
`npm run verify` runs it too.

The commands below build the decoder package, `texture2ddecoder-wasm`. Its build has two steps:
the WebAssembly module, then the TypeScript.

### Build WebAssembly Module

```bash
npm run build:wasm
```

From the repo root this delegates to `packages/decoder` (npm workspaces). This command:

- Compiles the C++ to WebAssembly with the Emscripten SDK, inside Docker. The image is pinned to
  `emscripten/emsdk:4.0.7` (the toolchain of the published 1.2.2), so every build is the same.
- Generates `packages/decoder/wasm/texture2ddecoder.js` and `.wasm`.
- Needs no local Emscripten installation.

### Build TypeScript

```bash
npm run build:rollup
```

This bundles the decoder's TypeScript sources into `packages/decoder/dist/`.

### Build Everything

Both decoder steps in one line:

```bash
npm run build:wasm && npm run build:rollup
```

## Running Tests

### Run All Tests

```bash
npm test
```

From the repo root this tests every reader package, then the decoder, then the `scripts/tests`.
The decoder tests run only when its WASM is built (`packages/decoder/wasm/texture2ddecoder.wasm`
exists); otherwise they are skipped with a message.

### Test Structure

The decoder's tests are in `packages/decoder/tests/`. Among them:

- `index.test.ts`: unit tests for the decoder functions.
- `samples.test.ts`: integration tests with real texture samples.

Each reader package has its tests in `packages/<package>/tests/`. The repo's own scripts are
tested in `scripts/tests/`.

### Adding New Tests

When you add new functionality:

1. Add tests for it in the matching test file.
2. Use descriptive test names.
3. Test both the success and the error cases.
4. Make sure all tests pass before you submit.

An example test:

```typescript
describe('New Decoder', () => {
  it('should decode valid data', async () => {
    const data = Buffer.alloc(16);
    const result = await decode_new_format(data, 4, 4);
    assert.notStrictEqual(result, null);
  });

  it('should handle invalid input gracefully', async () => {
    const result = await decode_new_format(Buffer.alloc(0), 0, 0);
    assert.strictEqual(result, null);
  });
});
```

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feature/add-new-decoder`: new features
- `fix/memory-leak`: bug fixes
- `docs/update-readme`: documentation updates
- `refactor/optimize-bc7`: refactoring

For work on an issue, the project rules add its number: `feature/<issue>-<slug>`,
`fix/<issue>-<slug>`, `docs/<issue>-<slug>`
([Git and PRs](docs/unity-asset-reader-rules.md#git-and-prs)).

### Commit Messages

Write clear, descriptive commit messages:

```
Add BC8 decoder support

- Implement decode_bc8 function in TypeScript
- Add C++ bindings for BC8 decoding
- Include tests for BC8 format
- Update README with BC8 documentation
```

The format:

- First line: a brief summary, 50 characters or less.
- A blank line.
- A detailed description, with bullet points if needed.

## Submitting Pull Requests

1. **Create a new branch** from `main`:

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**, following the [coding standards](#coding-standards).

3. **Test your changes:**

```bash
npm run build:wasm
npm run build:rollup
npm test
```

   For a change outside the decoder, `npm run verify` is enough (no Docker).

4. **Commit your changes** with clear messages.

5. **Push to your fork:**

```bash
git push origin feature/your-feature-name
```

6. **Open a Pull Request** on GitHub:
   - Give it a clear title and description.
   - Reference any related issues (for example "Fixes #123").
   - Include screenshots if they help.
   - List what changed and why.

### Pull Request Checklist

Before you submit, make sure:

- [ ] The code builds (`npm run build:rollup`)
- [ ] All tests pass (`npm test`)
- [ ] There are no linter errors
- [ ] The documentation is updated (README, JSDoc comments)
- [ ] The commit messages are clear and descriptive
- [ ] The branch is up to date with `main`

## Coding Standards

### TypeScript

- Write all source code in **TypeScript**.
- Follow the existing code style and formatting.
- Use proper type annotations; avoid `any` when you can.
- Add JSDoc comments to public functions.

Example:

```typescript
/**
 * Decode BC1 (DXT1) compressed texture to BGRA
 * @param data - Compressed texture data
 * @param width - Texture width in pixels
 * @param height - Texture height in pixels
 * @returns Decoded BGRA pixel data or null on failure
 */
export async function decode_bc1(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  // Implementation
}
```

### Code Style

- **2 spaces** for indentation.
- **Double quotes** for strings.
- **Semicolons** at the end of statements.
- Lines under **100 characters** when practical.
- **async/await** instead of promise chains.

### Naming Conventions

| Kind | Convention |
|---|---|
| Functions | `camelCase`, or `snake_case` for decoder functions, to match the C++ API |
| Classes | `PascalCase` |
| Constants | `UPPER_SNAKE_CASE` |
| Variables | `camelCase` |

## Continuous Integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. A `changes` job picks
the jobs to run from the changed paths (a push to `main` runs them all). Skipped jobs report
success, so all of them can be required checks.

| Status check | Runs when these change | What it does |
|---|---|---|
| `reader (node 20)`, `reader (node 22)` | `packages/{core,texture,node,mesh,audio,spine,shader,animation}/**`, `fixtures/**`, `scripts/**`, `.github/**`, root config | `npm ci && npm run verify` (build, test, `check:browser`, no-C# guard) |
| `reader floor (node 20.19.0)`, `reader floor (node 22.12.0)` | same as `reader` | Tests the lowest versions of the reader packages' `engines` (#172): `npm ci && npm run verify`, then `node scripts/check-node-floor.mjs` (`import` and `require()` of the three packages) |
| `decoder` | `packages/{decoder,core,texture}/**`, `fixtures/**`, `examples/**`, the `docs/` demo, `scripts/check-node-floor.mjs`, `.github/**`, root config | Checks out the submodules, then `build:wasm` (Docker), `build:rollup`, `npm test -w texture2ddecoder-wasm`, the texture package's tests with the WASM, and the Playwright tests (`npm run test:smoke`). Then `scripts/check-node-floor.mjs` with the WASM (`initTexture()` and decodes) on Node.js 20.19.0 and 22.12.0 |

Run the reader job locally with `npm ci && npm run verify`.

## Releases

Every package has its own version. Put each user-facing change under the `Unreleased` heading of
its package's section in [CHANGELOG.md](CHANGELOG.md).

Do not change a `version` in a feature PR: merging a version change to `main` publishes that
package. The release procedure is in [RELEASING.md](RELEASING.md).

## Reporting Issues

### Bug Reports

When you report a bug, please include:

1. **Description**: a clear description of the issue.
2. **Steps to Reproduce**: detailed steps that reproduce the bug.
3. **Expected Behavior**: what you expected to happen.
4. **Actual Behavior**: what actually happened.
5. **Environment**:
   - Node.js version
   - Operating system
   - Package version
6. **Code Sample**: minimal code that reproduces the issue.
7. **Error Messages**: any error messages or stack traces.

### Feature Requests

For a feature request, describe:

1. **Use Case**: why the feature is needed.
2. **Proposed Solution**: how you see it working.
3. **Alternatives**: any alternative solutions you considered.
4. **Additional Context**: anything else that is relevant.

## Project Structure

```
./                                # repo root: npm workspaces root (private)
├── package.json                  # workspaces: ["packages/*"]
├── docs/                         # plan, rules, GitHub Pages
└── packages/
    ├── core/                     # unity-asset-reader
    ├── texture/                  # unity-asset-reader-texture
    ├── node/                     # unity-asset-reader-node
    ├── mesh/                     # unity-asset-reader-mesh
    ├── audio/                    # unity-asset-reader-audio
    ├── spine/                    # unity-asset-reader-spine
    ├── shader/                   # unity-asset-reader-shader
    ├── animation/                # unity-asset-reader-animation
    └── decoder/                  # texture2ddecoder-wasm
        ├── src/                  # TypeScript source (index.ts)
        ├── tests/                # index.test.ts, samples.test.ts
        ├── scripts/              # build-wasm.sh, copy-wasm.js
        ├── texture2ddecoder/     # Git submodule (C++ source)
        ├── wasm_bindings.cpp     # C++ to WASM bindings
        ├── wasm/                 # Generated WASM files
        └── dist/                 # Rollup output
```

The repo root also holds `fixtures/` (test bundles and their goldens), `scripts/` (oracle, guard
and release scripts, tested in `scripts/tests/`) and `examples/`.

## Additional Resources

- [WebAssembly Documentation](https://webassembly.org/)
- [Emscripten Documentation](https://emscripten.org/docs/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Original Texture2DDecoder](https://github.com/K0lb3/texture2ddecoder)

## Questions?

If you have a question this guide does not cover:

1. Check the existing
   [GitHub Discussions](https://github.com/fatal10110/unity-asset-reader/discussions).
2. Open a new discussion.
3. Reach out to the maintainers.

## License

By contributing to this project, you agree that your contributions will be licensed under the
MIT License.

The reader packages are hand-ported from AssetStudio and UnityPy (MIT).

- The root [`NOTICE`](NOTICE) lists every upstream the repo derives from.
- `packages/*/NOTICE` are the per-tarball notices.
- Code you port from a new upstream needs three things: a stanza in the `NOTICE` of the package
  it lands in, a stanza in the root `NOTICE`, and the one-line attribution at the top of each
  ported file (rule R3 in [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md)).

---

Thank you for contributing to unity-asset-reader!
