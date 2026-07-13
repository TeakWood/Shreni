# Architecture — Next.js (App Router)

> Materialized from the `nextjs-vitest` pack. Replace the placeholders with your
> project's real notes; keep the layer boundaries.

## Layout

```
app/                 # routes: pages, layouts, route handlers (thin)
  api/<res>/route.ts # HTTP boundary — validate with zod, delegate to domain
src/domain/          # business logic: pure, framework-free, unit-tested
src/repositories/    # data access — the only layer that touches the store
```

## Rules of the road

- **Data flows one way:** route/page → domain → repository. A page never imports
  a repository directly; a domain module never imports from `app/`.
- **Server/client boundary is a security boundary.** Secrets, DB clients, and
  repository modules must never be importable from a `'use client'` component.
- Rendering defaults to server components; fetch data in the server component
  and pass plain props down.
- v1 of this pack targets the **App Router only** — no `pages/` directory.
