# Releasing

This is the maintainer procedure for publishing the packages to npm. The versioning policy is at
the top of [CHANGELOG.md](CHANGELOG.md).

Every package has its own version, and **a release is a version bump**. In short:

- Change the `version` in the package's `package.json` and its `CHANGELOG.md` section.
- Open a PR. Its dry run shows what will publish.
- Merge. The [Release workflow](.github/workflows/release.yml) publishes the package.

Releases are published by the workflow, never from a laptop.

<a id="steps"></a>

## Release in 6 steps

1. **Bump**, in a PR to `main`, for each package that ships:
   ```bash
   npm version <version> --no-git-tag-version -w <name>
   npm install --package-lock-only
   ```
   - `CHANGELOG.md`: in the package's section, `### <version> - Unreleased` becomes
     `### <version> - <YYYY-MM-DD>`. `scripts/tests/release.test.mjs` fails when the section has
     no dated heading for the version on disk.
   - When a package needs a new version of another package of this repo, raise its range too.
     For example: the texture package's `texture2ddecoder-wasm` range; a feature package's peer
     range on `unity-asset-reader` after a new core major; or its `^<major>.<minor>.0` minimum
     when it needs something a newer core minor adds.
   - Bump both packages in the same PR; the workflow publishes the dependency first. Or release
     the dependency in an earlier PR. The plan refuses a package whose peer minimum is neither
     on npm nor in the same run.
   - The docs for the release are in the PR or already on `main` (package READMEs, QUICK_START,
     bundler guide). A tarball without a README shows an empty page on npmjs.com.
2. **Check the PR's Release run.** A PR that changes a `packages/*/package.json` runs the
   workflow as a dry run:
   - Its notice lists exactly the `name@version`s the merge will publish.
   - Then it runs the whole gate and `npm publish --dry-run` for each.
   - It fails when a package needs a range that neither npm nor an earlier package of the same
     release satisfies.
3. **Merge** once CI and the dry run are green. The push to `main` runs the workflow for real: it
   publishes the packages whose version changed in that push, then tags each one
   `<name>@<version>`.
4. **Watch the Release run** (Actions → Release). If it fails, see
   [When a release fails](#when-a-release-fails).
5. **GitHub release**, optional, from the tag, with the version's `CHANGELOG.md` section as notes:
   ```bash
   gh release create <name>@<version> --title "<name> <version>" --notes-file <file with that section>
   ```
6. **After the publish.**
   - Update `examples/cdn-worker.js`. `TEXTURE_VERSION` is the published texture package.
     `CORE_VERSION` and `DECODER_VERSION` are the exact versions its jsDelivr `/+esm` build
     imports (`curl https://cdn.jsdelivr.net/npm/unity-asset-reader-texture@<v>/+esm`).
   - Check the live jsDelivr path: `CDN_LIVE=1 npm run test:smoke` (#150).
   - The next change to a package opens a new `### <next version> - Unreleased` heading in its
     section of `CHANGELOG.md`, without touching the `version`: that would publish it.

Since merging a version change publishes, a `version` changes only in a release PR, never in a
feature PR.

## Packages and publish order

| Package | Directory | Publish order |
|---|---|---|
| `texture2ddecoder-wasm` | `packages/decoder` | 1 |
| `unity-asset-reader` | `packages/core` | 2 |
| `unity-asset-reader-texture` | `packages/texture` | 3 |
| `unity-asset-reader-node` | `packages/node` | 4 |
| `unity-asset-reader-mesh` | `packages/mesh` | 5 |
| `unity-asset-reader-audio` | `packages/audio` | 6 |
| `unity-asset-reader-spine` | `packages/spine` | 7 |
| `unity-asset-reader-shader` | `packages/shader` | 8 |
| `unity-asset-reader-animation` | `packages/animation` | 9 |

### Adding a new package

1. Add it to `PACKAGE_DIRS` in `scripts/check-release.mjs`, after what it depends on, and to the
   table above.
2. Give it version `0.0.0` (`UNRELEASED`). The workflow never publishes that version, so merging
   the new package publishes nothing.
3. Start its `CHANGELOG.md` section with a `### 1.0.0 - Unreleased` heading, which
   `scripts/tests/release.test.mjs` requires.

Its first release is a bump like any other, to `1.0.0`. npm has no package of that name yet, so
it cannot have a trusted publisher and needs a token once, as in
[Bootstrap](#bootstrap-the-first-publish-with-a-token).

## How the workflow authenticates

The workflow publishes with [trusted publishing](https://docs.npmjs.com/trusted-publishers):

- npm authenticates the job by its GitHub OIDC token, so the repo holds no npm token. (While the
  bootstrap `NPM_TOKEN` secret exists, npm uses it instead; see below.)
- npm attaches a [provenance statement](https://docs.npmjs.com/generating-provenance-statements)
  to every package by itself.
- The only exception is the first publish, authenticated by a token
  ([Bootstrap](#bootstrap-the-first-publish-with-a-token)).

## What the workflow does

`.github/workflows/release.yml` runs on:

| Event | What it releases | Publishes |
|---|---|---|
| `push` to `main` changing a `packages/*/package.json` | each package whose `version` differs from the commit before the push (`github.event.before`) | for real, in the `npm` environment |
| `pull_request` changing a `packages/*/package.json` | what the merge would release: the versions that differ from the PR's base | `npm publish --dry-run`; no environment, no secrets, no OIDC token |
| `workflow_dispatch` (Actions → Release → *Run workflow*) | each package whose current `name@version` is not on npm | `--dry-run` while `dry_run` is ticked (the default); for real, in the `npm` environment, when it is not |

A change to anything else, docs included, does not run it. In every case a `name@version` that is
already on npm is dropped, so a run with nothing left ends green with a notice.

A run has four stages:

1. **Plan** (`scripts/check-release.mjs`), before anything is built: the packages to release, in
   publish order.
   - It fails when one of them has a range on another package of this repo (`dependencies`,
     `peerDependencies`) that no version on npm satisfies and no package published earlier in
     the same run satisfies either.
   - The error names the package, the range and what npm has. Nothing is published then.
2. **Gate:** builds and tests everything, with the submodule checked out.
   - `npm ci`, then `npm run build:wasm` (Docker, the pinned emsdk of #57; the decoder tarball
     ships `wasm/`).
   - Then the root `npm run verify`, split into steps, with `REQUIRE_WASM=1` (nothing may skip):
     the decoder's build and tests, one build-and-test step per reader package, the
     `scripts/tests`, `check:browser` and the no-C# guard.
3. **Publish** each package, in order, with `npm publish -w <name> --access public
   --ignore-scripts` on Node 22 and `npm@^11.5.1`.
   - Trusted publishing needs npm CLI 11.5.1 or later and Node 22.14.0 or later
     ([npm docs](https://docs.npmjs.com/trusted-publishers), checked 2026-09-28).
   - `--ignore-scripts` skips `prepublishOnly`, which would rerun the whole gate once per
     package. The tarballs are the `dist/` and `wasm/` the gate built and tested.
   - A `name@version` already on npm is skipped.
4. **Tag** each package that got published, also when a later one failed.
   - The tag is an annotated tag `<name>@<version>` (for example `texture2ddecoder-wasm@1.2.3`)
     on the released commit.
   - A separate `tag` job pushes it; it is the only job with `contents: write`.
   - An existing tag is skipped. Tags are records only; nothing runs on them.

The plan and the gate are one composite action (`.github/actions/release-gate`), used by both the
dry-run job and the publish job. So a PR's dry run plans and gates exactly like the push that
publishes it. Runs of the same ref queue (`concurrency.queue: max`); none is cancelled or dropped.

### Why a branch cannot publish

npm's trusted publisher checks the repository, the workflow file name and the environment, not
the ref. The `npm` environment admits only the `main` branch (see
[One-time setup](#github-environment-npm)). So a run on any other branch, including one that
edits its own copy of `release.yml`, fails one of two ways:

- it names no environment, which npm refuses; or
- it names `npm`, which GitHub does not start there.

### Old decoder tags

The decoder's releases before 1.2.3 were tagged `v1.0.1` ... `v1.2.2`. Those tags stay as they
are; the `<name>@<version>` tags never collide with them.

## When a release fails

- **Outside the code** (network, npm outage, a trusted-publisher typo): fix it and *Re-run failed
  jobs*. The re-run plans again against the same commits and skips what is on npm already. Or run
  the workflow by hand on `main` with `dry_run` unticked: it publishes every version not on npm.
- **The code or the packaging:** fix it on `main` and release the next patch version. Deprecate
  any package that did get out at the broken version:
  `npm deprecate <name>@<version> "broken release, use <next>"`.
- **A plan with no usable base** (a push that force-pushed `main`, so the commit before it is
  gone) fails before anything is built. Run the workflow by hand on `main`, dry run first.
- **Only the tag job failed** (for example a tag ruleset without a bypass for GitHub Actions): the
  packages are on npm. Re-run the job, or tag the commit by hand:
  `git tag -a <name>@<version> -m "<name>@<version>" <commit> && git push origin <name>@<version>`.

## One-time setup

### GitHub environment `npm`

1. Settings → Environments → *New environment* `npm` (or edit the existing one).
2. Under *Deployment branches and tags*, choose *Selected branches and tags*.
3. Have exactly one rule: type **branch**, pattern `main`. No tag rules.

GitHub creates the `npm` environment by itself the first time a job names it, but then with no
branch rule, so any branch could deploy to it. Create it, or add the `main` rule to it, before the
first run of the workflow.

### Protect `main`

A push to `main` that changes a version publishes, so only reviewed changes may reach it.
Settings → Rules → Rulesets → *New branch ruleset* targeting the default branch, with:

- *Require a pull request before merging*
- *Require status checks to pass* (the CI checks)
- *Block force pushes*
- bypassed by no one (or only by maintainers)

If a tag ruleset restricts creating tags, add the *GitHub Actions* app to its bypass list, or the
tag job cannot push the release tags.

### Trusted publisher, per package

npm links a trusted publisher only to a package that **already exists** on the registry:

- The setting lives in the package's own settings page (npmjs.com → the package → Settings →
  Trusted publishing).
- The `npm trust` command (npm 11.15.0 or later) requires that "the package you're configuring
  must already exist on the npm registry"
  ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), checked 2026-09-27).

For the first release this meant:

- `unity-asset-reader`, `unity-asset-reader-texture` and `unity-asset-reader-node` were new
  names, so they could only be linked after the bootstrap publish below.
- `texture2ddecoder-wasm` was on npm already (1.2.2). Its trusted publisher could be linked
  before the bootstrap (it then publishes by OIDC, which npm tries before the token) or with the
  other three right after it.

For each package, on npmjs.com as a maintainer with 2FA:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `fatal10110` |
| Repository | `unity-asset-reader` |
| Workflow filename | `release.yml` (file name only, with the extension; all fields are case-sensitive) |
| Environment name | `npm` |

or, from a shell logged in to npm with 2FA:

```bash
npm trust github <name> --file release.yml --repo fatal10110/unity-asset-reader --env npm --allow-publish
```

npm does not validate the entry when it is saved; a typo shows up as `ENEEDAUTH` at publish time.

Then, per package, Settings → Publishing access → *Require two-factor authentication and disallow
tokens*. Trusted publishing keeps working, and no leaked token can publish.

### Bootstrap: the first publish, with a token

A package that is not on npm yet cannot have a trusted publisher, so its first publish needs a
token. Every package of this repo has had its first publish (the last was
`unity-asset-reader-animation` 1.0.0, 2026-11-09). This section applies to the next new package.
The options, least bad first:

| Option | Cost |
|---|---|
| **Token in the workflow, once.** Publish the first release through this workflow, authenticated by a token in the **repository** secret `NPM_TOKEN` (maintainer decision 2026-09-28, #194). | Exposure of a repository secret, an *All packages* token; see below the table. In return, the same gate and provenance as every later release. |
| Placeholder publish from a laptop (for example a `0.0.0` of each name), then link the publishers, then release 1.0.0 through the workflow. | An empty version per new name stays on npm for good (unpublishing one blocks reusing that version number), and each name's first version is junk. |
| `npm publish` of 1.0.0 from a laptop. | 1.0.0 has no provenance (npm generates it only in a supported CI runner), is built on one machine outside the gate, and needs Docker locally for the WASM. |

The cost of the first option, the token in the workflow:

- A repository secret is readable by every workflow job of the repo, not only by the `npm`
  environment's.
- Only the `publish` job references it today. But a workflow on any branch of this repo could,
  without being merged: a push, or a pull request from a branch of this repo, including this
  workflow's own `pull_request` trigger, which runs the PR's copy of `release.yml`. A fork
  cannot.
- So it lives for the first publish only and is deleted right after it.
- npm's token page selects from packages and scopes that exist, so for a new name it has to be
  an *All packages* token, which can publish every package of the account. Keep its expiry
  short.
- In return the first release is built and gated exactly like every later one, and still gets
  provenance: token publishes from GitHub Actions with `id-token: write` support it, and the job
  sets `NPM_CONFIG_PROVENANCE=true`.

Do the first. [A new package's first release](#a-new-packages-first-release) gives the order.

## A new package's first release

It is a release PR like any other: its `version` goes from `0.0.0` to `1.0.0`
([Steps](#steps)).

1. **Before the merge**, add the repository secret `NPM_TOKEN`: a granular access token, *Read
   and write*, *All packages* (the name does not exist yet), *Bypass 2FA* ticked (a CI job cannot
   answer a 2FA prompt), with a short expiry.
2. **The PR's dry run** must list `<name>@1.0.0`.
3. **After the Release run publishes it:**
   1. Link its trusted publisher ([above](#trusted-publisher-per-package)).
   2. Delete the `NPM_TOKEN` secret (Settings → Secrets and variables → Actions) and revoke the
      token on npmjs.com.
   3. Set *disallow tokens* for the package (above).

Do (1) before (2). Otherwise a release in between has neither a token nor a matching trusted
publisher and fails with `ENEEDAUTH`.

While `NPM_TOKEN` is set, npm falls back to it when the OIDC token is refused, so a missing or
wrong trusted publisher does not show up until the token is deleted. Before you delete it, check that each package's trusted
publisher names `fatal10110/unity-asset-reader`, `release.yml` and environment `npm`.

<a id="the-first-release-decoder-123-then-readers-100"></a>

## History: the first release (2026-09-28)

The versions were on `main` already (`texture2ddecoder-wasm` 1.2.3, the three readers 1.0.0), so
no push would release them: the first release was a manual run. It published all four in one
run, in order:

1. `texture2ddecoder-wasm@1.2.3` first. It carries the BC3 fix #137 and the Worker fix #149,
   which the texture package's `^1.2.3` range and goldens rely on.
2. Then the readers.

Before it:

- The `npm` environment was set up with its `main` branch rule, and `main` protected (above). If
  the environment does not exist yet, the first run creates it, without the rule.
- The repository secret `NPM_TOKEN` was added. It had to hold a granular access token that can
  publish all four names: *Read and write*, *All packages* (three names were new), *Bypass 2FA*
  ticked (a CI job cannot answer a 2FA prompt).
- The publish step writes the token to the job's `~/.npmrc` as a reference to the environment
  variable, never the value, only when the secret is set, and warns. The `dry-run` job never
  reads it.

The release:

1. **`NPM_TOKEN` repository secret** (added). Optionally, a dry run first: Actions → Release →
   *Run workflow* on `main`, `dry_run` ticked. Its notice had to list
   `texture2ddecoder-wasm@1.2.3 unity-asset-reader@1.0.0 unity-asset-reader-texture@1.0.0
   unity-asset-reader-node@1.0.0`, and the gate and every `npm publish --dry-run` had to pass.
2. **Run the Release workflow by hand** on `main` with `dry_run` unticked. It published the four
   with the token and tagged them.
3. **Link the trusted publisher of each of the four packages** (above).
4. **Delete the `NPM_TOKEN` secret** (Settings → Secrets and variables → Actions) and revoke the
   token on npmjs.com, right away: a repository secret is readable by every workflow job in the
   repo, not only the `npm` environment's. With the secret gone the publish step passes no token
   and npm uses OIDC. Then set *disallow tokens* per package (above).

Do step 3 before step 4. The other way round, a release in between has neither a token nor a
matching trusted publisher and fails with `ENEEDAUTH`. Once step 3 is done, a release works
whether or not the secret is still set, because npm tries the OIDC token before a configured one.

## After the repo rename

The repo is now `fatal10110/unity-asset-reader` (plan D8, #199).

- **`repository.url` in every `package.json`** names the new repository already. GitHub
  redirects the old URL, but npm checks provenance against `repository.url`, which has to be the
  repository the job runs in.
  - Each package's `repository.directory` was kept.
  - The change was not a version change, so it published nothing.
  - The updated metadata reaches npm with each package's next release; versions published
    before the change keep the old URL.
- **Each package's trusted publisher.** It names the repository, so it has to name the new one.
  npm's docs say an existing connection cannot be changed, only deleted and added again
  ([npm docs](https://docs.npmjs.com/trusted-publishers)); do that per package. Check it as in
  [A new package's first release](#a-new-packages-first-release) before the `NPM_TOKEN` secret
  is deleted.
