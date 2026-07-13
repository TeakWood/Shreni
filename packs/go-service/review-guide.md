# Review Guide — go-service

Stack-specific review rubric (injected into the reviewer only). These lines are
grounds for REJECT; they add to — never replace — Shreni's hard gates.

REJECT when:

1. **An ignored error return.** Any `_ =` (or bare call discarding an error)
   without a comment justifying why the error is safe to drop.
2. **Exported function without a table test.** Every exported function added
   or behaviourally changed needs a table-driven test (`t.Run` subtests).
3. **`panic` in library code.** Anything under `internal/` that panics on a
   recoverable condition instead of returning an error.
4. **Unwrapped errors.** Errors propagated without `%w` context where the
   caller could need to inspect or trace them.
5. **Missing `ctx`.** New I/O or blocking functions that don't take
   `context.Context` as the first parameter.
6. **Unguarded shared state.** Mutable state reachable from multiple
   goroutines without a mutex/channel — remember the test gate runs `-race`.

Require in every review: run `go build ./...` and confirm new handlers are
tested with `httptest`, not skipped.
