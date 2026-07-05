# Releasing Shreni

How to cut a release and get Shreni onto a real install path (npm + Homebrew).
Most steps are mechanical; a few are **founder decisions** and are flagged.

## What's already wired (yds.4)

`package.json` is publish-ready:

- **`files`** whitelists the tarball to `dist` + the docs — no `src`, tests, or
  configs ship. (`tsconfig` already excludes `*.test.ts` from the build, so no
  test code lands in `dist` either.) Verify any time with:

  ```bash
  npm pack --dry-run
  ```

- **`bin.shreni` → `dist/cli/index.js`**, which carries the `#!/usr/bin/env node`
  shebang (`tsc` preserves it), so the global install is directly executable.
- **`prepublishOnly: pnpm build`** rebuilds `dist` immediately before publish, so
  a stale or missing build can't be shipped.
- **`publishConfig.access: public`** so the first publish isn't rejected.
- **`engines.node: >=20`** advertises the runtime requirement to consumers.

## npm publish

> **Founder decision — package name + account.** This publishes as the unscoped
> name **`shreni`**. Confirm it is available (`npm view shreni`) and that you are
> logged in to the owning account (`npm whoami`). If the name is taken, switch to
> a scoped name (e.g. `@teakwood/shreni`) — update `name` in `package.json`; the
> `publishConfig.access: public` already covers a scoped public publish.

```bash
npm whoami                 # confirm the right account (npm login if needed)
npm view shreni            # confirm availability / current published version
pnpm build && pnpm test    # green gate before shipping
npm publish                # runs prepublishOnly (pnpm build) first
```

Bump the version with `npm version <patch|minor|major>` before publishing a new
release (it commits + tags). Keep the Homebrew formula's `url`/`sha256` in step.

After this, the user install path is simply:

```bash
npm install -g shreni      # (or the scoped name)
shreni                     # no args prints the usage banner (there is no --version flag)
```

## Homebrew

A draft formula lives at [`homebrew/shreni.rb`](homebrew/shreni.rb). It installs
the **published npm tarball**, so it can only be finalised after the npm publish
above.

> **Founder decision — tap repo.** Homebrew serves third-party formulae from a
> "tap": a GitHub repo named `homebrew-shreni` under your org/user. Create it once.

```bash
# After npm publish, regenerate the formula so the sha256 is correct:
brew create --tap <you>/homebrew-shreni \
  https://registry.npmjs.org/shreni/-/shreni-<version>.tgz
# Reconcile the generated file against packaging/homebrew/shreni.rb (desc, test,
# node dependency), fill in url version + sha256, and push it to the tap repo.
```

Then users install with:

```bash
brew install <you>/shreni/shreni
```

## Prebuilt standalone binaries (Node SEA)

Self-contained per-platform executables — no Node install required — are built
with [Node SEA](https://nodejs.org/api/single-executable-applications.html):
`esbuild` bundles the CLI into one file, `--experimental-sea-config` produces a
blob, and `postject` injects it into a copy of the `node` binary. The whole
pipeline is [`scripts/build-binary.mjs`](../scripts/build-binary.mjs).

Because the binary is one file, `shreni start` / `phalaka start` can't spawn
sibling `worker.js` / `phalaka-server.js` scripts. Instead the binary re-invokes
itself with hidden `__worker` / `__phalaka-server` subcommands
([`src/cli/self-exec.ts`](../src/cli/self-exec.ts)) — the same code path also
works under a normal `node` / npm install.

### Building

```bash
pnpm build:binary        # outputs build/shreni-<platform>-<arch> (+ .sha256)
```

> **Requires an official Node binary.** SEA injection needs the fuse sentinel
> that ships in Node.org builds. **Homebrew's `node` is built without it** and
> will fail with *"Could not find the sentinel … in the binary"*. Use a Node
> from `actions/setup-node` (as CI does) or a nodejs.org tarball.

### Release pipeline

[`.github/workflows/release-binaries.yml`](../.github/workflows/release-binaries.yml)
builds on a matrix (macOS arm64 + x64, Linux x64, Windows x64 — SEA can't
cross-compile), runs typecheck + tests, and attaches the executables and their
SHA-256 sidecars to the GitHub Release. Push a `v*` tag to trigger it; run it via
`workflow_dispatch` for an artifacts-only dry build.

### First-run notes for users (unsigned alpha)

These binaries are **not code-signed or notarized**, so the OS will warn on first
run of a downloaded file:

- **macOS** (Gatekeeper): `xattr -d com.apple.quarantine ./shreni-darwin-arm64`,
  then run it. (CI re-signs ad-hoc, which only covers local, non-quarantined use.)
- **Windows** (SmartScreen): *More info → Run anyway*.
- **Linux**: `chmod +x ./shreni-linux-x64` and run.

Always verify the download against its published `.sha256` first. Signing +
notarization (Apple Developer ID, Windows Authenticode) is a later enhancement.