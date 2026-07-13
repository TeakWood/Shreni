# Review Guide — node-api

Stack-specific review rubric (injected into the reviewer only). These lines are
grounds for REJECT; they add to — never replace — Shreni's hard gates.

REJECT when:

1. **Route without input validation.** A new/changed route uses body, params,
   or query that was not parsed through a schema (zod / fastify schema) first.
2. **Route without an integration test.** Every new/changed route needs an
   `app.inject()` test covering the success case AND a failure case (invalid
   input, missing resource, or the authz-failure case where auth exists).
3. **Layer violation.** A route imports a repository directly, business logic
   sits inline in a route handler, or a service imports framework types.
4. **Ad hoc error responses.** Errors turned into responses outside the
   central error handler.
5. **`any` at a module boundary** (exported signature, route payload type), or
   a floating promise (unawaited, unreturned, no `void` + comment).
6. **Raw `process.env` reads** outside the config module.

Require in every review: run the build (`pnpm build`) and confirm new routes
have both schema validation and inject tests.
