# Architecture — Go stdlib service

> Materialized from the `go-service` pack. Replace the placeholders with your
> project's real notes; keep the layer boundaries.

## Layout

```
cmd/svc/main.go      # wiring only: flags/env, construct deps, http.ListenAndServe
internal/            # all application code
  notes/             # a domain package: types, logic, storage behind an interface
  httpapi/           # handlers: decode → call domain → encode; no logic
```

## Rules of the road

- Deliberately boring: stdlib `net/http`, no framework. The mux, middleware,
  and JSON encoding are plain library code — easy to test, nothing magic.
- Domain packages know nothing about HTTP; handlers know nothing about
  storage internals (they hold an interface).
- Everything blocking takes a `ctx context.Context` first parameter and
  respects cancellation.
- `go generate` steps and CGO are out of scope for this pack — if the repo
  needs them, point `buildCommand` at the Makefile.
