# Suthradhara session monitoring — activity events + token-usage recovery

## Problem

The launched planning session (see
[suthradhara-launched-planning-session.md](./suthradhara-launched-planning-session.md))
has **no monitoring surface**: it files an epic + children, but nothing records
the *session itself* — no activity events, no token accounting. The old
per-session audit bead was deleted with the interview engine. The executor loop
(Silpi/Viharapala/Parikshaka) already emits activity events and meters tokens;
Suthradhara should mirror that so an operator can watch a planning session and
see what it cost.

## Constraint that shapes the design

The launched session runs **interactive** (`stdio: 'inherit'`, no `-p`), so the
launcher never sees its output and there is **no `stream-json` to parse**. The
executor's usage path — parse the headless `result` message's `usage` block
(`providers/claude.ts` → `parseClaudeUsage`) — therefore does not apply. Usage
must be recovered a different way.

## Approach

Two independent seams, both already extension-friendly:

1. **Events** — `emit(event)` in `src/sthapathi/activity-log.ts` (writes
   `~/.shreni/kshetra/<id>/activity.jsonl`, fans out to `EventSink`s that Phalaka
   reads). The launcher control loop (`runPlanningLoop`) owns every lifecycle
   moment, so it emits: session launched, Gate ① filed, Gate ② pushed,
   extend/new/end, session ended.

2. **Token usage — recovered after every session.** Because the launch pins
   `--session-id <uuid>`, Claude Code writes the session transcript to a known
   JSONL under `~/.claude/projects/<worktree-path-slug>/<session-id>.jsonl` (the
   project dir is the worktree cwd with path separators slugified). Every
   assistant line carries a `usage` block. When a session ends (`current.wait()`
   resolves), a reader sums those blocks and calls the **same
   `getUsageMeter().record(...)`** seam the executors use. Runs once per session
   — fresh, extend, and new-story alike.

   Keying into `UsageRecord`: `beadId` = the filed **epic id** (from the
   handoff), `runId` = the `claudeSessionId`, `agent` = `suthradhara` (already an
   `AgentRole`), `provider`/`model` from the Kshetra config.

   **Caveat (load-bearing):** the transcript is a Claude Code *internal* format,
   a softer contract than the `-p` `result` message — the reader must be
   defensive (missing/rotated/renamed file → zero usage + a warning, never a
   throw) and is a candidate to break across CLI versions.

## Touch-points (real files)

| Change | File(s) |
|--------|---------|
| Widen event/agent surface | `src/sthapathi/activity-log.ts` (`ActivityEvent` union, `agent` enum, `SCHEMA_VERSION`); event consumers |
| Emit lifecycle events | `src/cli/suthradhara.ts` (`runPlanningLoop`), maybe `src/suthradhara/lifecycle.ts` |
| Transcript usage reader | new `src/suthradhara/usage.ts` |
| Record usage after each session | `src/cli/suthradhara.ts` — wire `getUsageMeter()` from `src/ext/` |
| Phalaka rendering | `src/phalaka/*` |

## Non-goals

- No per-session **audit bead** — activity-log events are the monitoring surface;
  a bead would pollute the queue (which is exactly why `pickup.ts` filters the
  legacy `suthradhara-session` type).
- No live per-token streaming; usage is recovered as a batch total at session
  exit, per the operator's decision.
