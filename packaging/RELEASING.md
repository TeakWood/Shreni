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

## Not yet: prebuilt standalone binaries

The bead also mentions **prebuilt binaries** (a single self-contained executable,
no Node install required). That is a heavier, CI-driven effort — per-platform
builds via Node SEA or `pkg`, checksums, and a GitHub Releases pipeline — and is
tracked separately as a follow-up. The npm + Homebrew paths above already give
users a real, non-source install; standalone binaries are an enhancement on top.