# Review Guide — nextjs-vitest

Stack-specific review rubric (injected into the reviewer only). These lines are
grounds for REJECT; they add to — never replace — Shreni's hard gates.

REJECT when:

1. **`'use client'` without a stated need.** The diff adds `'use client'` and
   neither the code (state/effects/browser APIs) nor the summary justifies it.
2. **Server-only code reachable from a client component.** A `'use client'`
   file imports (directly or transitively) a repository module, a DB/ORM
   client (e.g. Prisma), or reads server-only secrets/env.
3. **Route handler without input validation.** Any new/changed handler in
   `app/api/**/route.ts` uses a request body, route param, or search param
   that was not parsed through a zod schema first.
4. **Domain change without a test.** A function in `src/domain/` was added or
   behaviourally changed and no corresponding vitest test was added/updated.
5. **Business logic in the handler or page.** Non-trivial logic inline in a
   route handler or page component instead of `src/domain/`.

Require in every review: run the build (`pnpm build` — it is the type gate),
and confirm new API surface has both the zod schema and a test.
