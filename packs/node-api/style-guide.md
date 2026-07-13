# Style Guide — Node API (TypeScript)

> Materialized from the `node-api` pack. This file is yours: edit it to match
> your project. Shreni's agents read it when implementing and reviewing.

## Layers

- **routes → services → repositories**, strictly one-way. Route plugins parse
  and validate; services hold the business logic; repositories are the only
  layer touching the store.
- Framework types (request/reply) never leak below the route layer.

## Configuration & logging

- Environment config is parsed **once** at startup through a schema (zod);
  everything downstream receives typed config, never `process.env` reads.
- Structured logging only (fastify's built-in pino). No `console.log` in
  application code.

## Async discipline

- No floating promises — every promise is awaited, returned, or explicitly
  voided with a comment. The lint gate enforces this.

## Validation & errors

- Every route validates its input (body, params, query) with a schema before
  use, and returns typed error bodies (`{ error: ... }`).
- Errors become HTTP responses in one place (the error handler), not ad hoc in
  each route.

## TypeScript & testing

- `strict` on; no `any` at module boundaries.
- vitest with `app.inject()` integration tests: every route has at least the
  success case and one failure case (bad input or missing resource).
