# Style Guide — Go service

> Materialized from the `go-service` pack. This file is yours: edit it to match
> your project. Shreni's agents read it when implementing and reviewing.

## Layout

- Standard layout: `cmd/<binary>/main.go` for entrypoints, `internal/` for
  everything else. `main.go` wires; packages do the work.

## Errors

- Errors are **wrapped with `%w`** and either handled or returned — never
  discarded. `_ =` on an error return needs a comment saying why it's safe.
- No `panic` in library code; `panic` is for `main`-level unrecoverable wiring
  only.

## Context

- `context.Context` is the **first parameter** on anything that does I/O or
  can block. Never store a context in a struct.

## Concurrency

- Tests run with `-race` — write code as if the race detector is always on,
  because here it is. Guard shared state with a mutex or confine it to one
  goroutine.

## Testing

- Table-driven tests for every exported function. Subtests via `t.Run` with
  descriptive names.
- HTTP handlers are tested with `net/http/httptest`, not a live server.

## Style

- `gofmt` is not negotiable. Small interfaces, accept interfaces / return
  structs. No `init()` unless there is no alternative.
