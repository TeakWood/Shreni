# Style Guide — Next.js (App Router) + TypeScript

> Materialized from the `nextjs-vitest` pack. This file is yours: edit it to
> match your project. Shreni's agents read it when implementing and reviewing.

## Components

- **Server components by default.** Add `'use client'` only when the component
  actually needs state, effects, or browser APIs — and say why in the PR/bead.
- Client components live at the leaves; never mark a layout or page `'use client'`
  just to pass a handler down.

## Route handlers & domain logic

- Route handlers (`app/api/**/route.ts`) stay thin: parse → validate → call a
  domain function → shape the response. No business logic in the handler.
- Domain logic lives in `src/domain/` as plain, framework-free functions.
- Data access goes through a repository module — components and handlers never
  touch the store directly.

## Validation

- **zod at every boundary**: request bodies, route/search params, and env access
  are parsed with a zod schema before use. Never trust `await req.json()` raw.

## TypeScript

- `strict` stays on. No `any` at module boundaries; prefer `unknown` + narrowing.
- Export explicit types for domain entities; infer zod types with `z.infer`.

## Testing

- vitest. Every domain function you touch gets (or updates) a unit test.
- Test files sit next to the code: `src/domain/foo.test.ts`.
