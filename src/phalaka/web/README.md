# Phalaka web

The Phalaka dashboard frontend: a standalone **React + TypeScript + Tailwind**
(Vite) app that builds to **one inlined `index.html`** and is codegen'd into the
`INDEX_HTML` export of [`../ui.ts`](../ui.ts).

## Why standalone

This package has its **own `package.json` + lockfile** and is **not** a root
dependency. That keeps React/Vite/Tailwind out of the backend dependency tree and
off the SEA binary bundle. The generated `../ui.ts` is **committed**, so
`pnpm build` / `tsc` / the binary need no frontend toolchain — only `pnpm build:web`
(run from the repo root, when the UI changes) regenerates it.

`src/phalaka/web/` is excluded from the root `tsconfig.json` and root `vitest`.

## Constraints

Phalaka runs on loopback, offline, with no CSP, and inside the SEA binary (no
filesystem to serve assets from). So the build **inlines everything** — JS + CSS —
into a single self-contained HTML with zero external requests
(`vite-plugin-singlefile`).

## Commands

```bash
# From the repo root — the canonical path. Builds here and rewrites ../ui.ts:
pnpm build:web

# From this directory (src/phalaka/web/):
pnpm install      # first time only
pnpm dev          # Vite dev server (UI iterates against a running Phalaka backend)
pnpm build        # produce dist/index.html
pnpm test         # vitest (lib logic + component render tests)
pnpm typecheck    # tsc --noEmit
```

## Layout

- `src/lib/` — pure logic + types (formatting, triage aggregation), unit-tested.
- `src/api/` — typed fetch client + `useEventStream` SSE hook (10s poll fallback).
- `src/components/` — Board (Kshetra cards, lazy task detail), Processes panel,
  Triage feed, App shell.

## Theme

Dark-only for now; a light/dark toggle is a separate, final bead (deferred).
