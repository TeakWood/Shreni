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

Light/dark, **dark by default**. A header toggle flips it and persists the choice
in `localStorage` (`phalaka-theme`). Dark is the untouched base — every component
keeps its dark Tailwind utilities and the `light:` variant (a `@custom-variant` in
`index.css`, keyed on `<html data-theme="light">`) layers light overrides on top.
A tiny head script in `index.html` applies the stored theme before first paint to
avoid a flash; `useTheme` keeps `<html data-theme>` in sync thereafter.

## Tests

Two layers, both in this standalone package (off the backend + SEA binary):

- **Unit / component** — `pnpm test` (vitest): `lib/` logic + `renderToStaticMarkup`
  component tests + one jsdom `App` smoke test.
- **E2E** — `pnpm test:e2e` (Playwright, chromium): real-browser regression guard
  for rendering + interactions the jsdom smoke can't reach (theme toggle, SSE live
  updates, lazy task-row expansion). Config: `playwright.config.ts`; specs in
  `e2e/*.spec.ts`.

E2E tests are **hermetic**: `e2e/fixtures/mock-backend.ts` mocks the whole backend
in-browser — `page.route('**/api/**')` answers the REST endpoints from
`e2e/fixtures/data.ts`, and an in-page `EventSource` mock replaces the SSE stream so
a spec drives `process`/`state`/`activity`/`keepalive` frames on demand (the `sse`
controller on the `backend` fixture). No live Phalaka server, `bd` database, or
agents are needed. The `webServer` builds the single-file bundle and serves it with
`vite preview`, so the tests exercise the **shipped** artifact.

First run needs the browser once: `pnpm exec playwright install chromium`.
