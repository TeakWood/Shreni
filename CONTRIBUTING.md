# Contributing to Shreni

Thanks for your interest in Shreni. This document explains how to propose
changes and what we need from every contribution.

Shreni is open-core: this repository is the free, Apache-2.0 licensed core.
Commercial team/cloud features live in a separate product and are not part of
this repo.

## Ground rules

- Be respectful. All participation is governed by our
  [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an issue before large changes so we can align on direction before you
  invest time.
- Keep pull requests focused — one logical change per PR is much easier to
  review and merge.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. By signing off you certify that you wrote the
patch or otherwise have the right to submit it under the project's license — the
full text is at <https://developercertificate.org/>.

Add the sign-off automatically with the `-s` flag:

```bash
git commit -s -m "your message"
```

This appends a line to your commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must match your Git identity. PRs whose commits are not
signed off cannot be merged.

## Development setup

Shreni uses **pnpm** — `npm` and `yarn` are blocked via `engines` and `.npmrc`.

```bash
pnpm install        # install dependencies
pnpm build          # compile TypeScript
pnpm typecheck      # type-check without emitting
pnpm test           # run the test suite (vitest)
pnpm dev            # run via tsx
```

## Before you open a pull request

1. `pnpm typecheck` passes.
2. `pnpm test` passes, and new behavior is covered by tests.
3. Commits are signed off (DCO, above).
4. The PR description explains the *why*, not just the *what*.

## Reporting bugs and requesting features

Use the GitHub issue templates. For security vulnerabilities, **do not** open a
public issue — follow [SECURITY.md](SECURITY.md) instead.