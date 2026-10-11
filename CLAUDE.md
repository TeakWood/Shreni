# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Task tracking

Tasks live in Shreni's own task graph engine: this repo is a tracker project
(`.shreni/tracker.yaml`), worked by hand with `shreni task` — see the Shreni
block at the end of this file. Use `shreni task` for ALL task tracking — not
TodoWrite, TaskCreate or markdown TODO lists — and `shreni task remember` for
knowledge later sessions need, not MEMORY.md files. There is nothing to sync:
tasks, notes and memories are in the database the moment a command returns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File tasks for remaining work** - `shreni task create` for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update task state** - `shreni task finish` what is done, `shreni task note` or `release` what isn't
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Per-Task Workflow — Code Review Before Push (MANDATORY)

**Whenever you implement a task (any `shreni task`), you MUST run the loop
below. The code review is a HARD GATE: no code from a task is pushed until
a review has run and its findings are resolved.** Work one task at a time — finish
this full loop for a task before starting the next.

1. **Claim** — `shreni task claim <id>`, then `shreni task show <id>`: read its
   acceptance checks and the spec section it names (for the task graph engine, in
   `docs/architecture/`).
2. **Checks first** — write the acceptance criteria as tests and run them. Each
   must fail, for the reason the check describes, before you write the code.
3. **Implement** the change until those tests pass.
4. **Quality gates** — `pnpm typecheck` and `pnpm vitest run` must be green (also
   `pnpm build:web` when the Phalaka frontend under `src/phalaka/web/` changed, so
   the committed `ui.ts` bundle is regenerated, and `pnpm test:integration`
   when `src/taskgraph/` changed).
5. **Code review — the gate** — run `/code-review` (high effort) or the
   code-review subagent over the diff, checked against the acceptance criteria and
   the spec section the task names. **Never push an unreviewed task diff.**
6. **Resolve findings** — fix every confirmed finding, or consciously accept it
   with a stated reason. A finding that shows the spec itself is wrong changes the
   spec first, then the code. Re-run the gates after any fix.
7. **Push only after the review is clean** — commit and `git push` (per *Session
   Completion*), then `shreni task finish <id> --reason "…"`.

**CRITICAL RULES:**
- The review runs BEFORE the push, not after — a pushed-then-reviewed diff defeats
  the gate.
- "Tests pass" is NOT a substitute for the review; run both.
- If you skip the review because a change is trivial, say so explicitly and why —
  do not skip it silently.
- An epic finishes only when its user journeys pass on a real setup, not just in
  tests — never finish one only because its children finished.

## Build & Test

**Package manager: pnpm only.** Never use `npm` or `yarn` — the project enforces this via `engines` in package.json and `.npmrc`.

```bash
pnpm install        # install dependencies
pnpm build          # compile TypeScript
pnpm typecheck      # type-check without emitting
pnpm dev            # run via tsx
```

## Architecture Overview

Shreni is an autonomous coding-agent harness. **Sthapathi** (orchestrator) takes
ready tasks from the task graph engine and drives a **Silpi** (coder) ↔ **Viharapala** (reviewer)
loop, squash-merges approved work to `main`, and dispatches **Parikshaka** (test
agent) asynchronously after merge. **Phalaka** is a loopback dashboard. Each
managed project is an isolated **Kshetra** with its own repo, task graph project,
RAG index, and agent queue. See the README's Architecture section for the component
table and flow diagram.

## Conventions & Patterns

- **One config per Kshetra** at `<repo>/.shreni/kshetra.yaml`; `~/.shreni/registry.json`
  is the only thing that resolves `id → configPath`. Paths are absolute.
- **Sthapathi is the sole claimer and finisher** of a Kshetra's tasks. Agents never
  claim or finish one — they receive task context as injected prompt data.
- **TypeScript strict**, tests via **vitest**, provider adapters behind a single
  `ProviderAdapter` interface (`src/agents/providers/`).

## Feature Planning & Design Rubric

**When the operator asks to plan, design, or scope a feature** (new capability or
a change to an existing one), adopt the five-stage flow below rather than jumping
straight to code or tasks. Each stage has a hat and an exit condition; do not
advance until the exit condition is met, and **never file tasks or write design
docs until Stage 5** — the operator approves the bundle first.

| Stage | Hat | Purpose | Exit condition |
|-------|-----|---------|----------------|
| **1 · Discovery** | Product | Capture the raw idea: intent, the user and their problem, the "why now", rough success criteria. Detect new-feature vs. change-to-existing; if a change, locate and load the existing design doc. | Problem/outcome stated in the operator's words and reflected back; any existing doc loaded. |
| **2 · Clarify** | Product → Technical | Active interview: resolve ambiguity, enumerate edge cases, non-functional requirements, explicit in/out of scope, priorities, constraints. | Readiness rubric satisfied; open questions answered or explicitly deferred. |
| **3 · Decompose** | Technical | Grounded in the repo, break the feature into a parent epic + child tasks with acceptance checks, each sized for one Silpi ↔ Viharapala pass, ordered by dependency. | Every child has title, description, acceptance criteria, priority; deps drawn; nothing left as "and then figure out X". |
| **4 · Design** | Technical | Synthesise the decisions into a design note: chosen approach, key components and their touch-points in **real files**, alternatives, risks. | The note explains *why* the decomposition looks the way it does, referencing real files. |
| **5 · Confirm & commit** | — | Present the full bundle; operator edits/approves; **only then** write the doc + file the tasks. | Operator confirms; artifacts written; task ids echoed. |

Guidance:

- **Ground before you decompose.** Stages 3–4 must reference real files/symbols
  (use the repo map, search, or subagents) — no hand-wavy decomposition.
- **Confirm is a hard gate.** Stage 5 is the first point at which anything is
  written; before it, everything is a proposal the operator can edit.
- **Store the design note on the epic** (`shreni task create --epic --description "…"`) so it travels
  with the work, and echo the epic + child ids back when done.
- Scale the ceremony to the ask — a one-line tweak doesn't need five stages, but
  anything that becomes an epic does.

<!-- shreni:begin tracker v1 -->
## Task tracking

This repo is tracked with `shreni task`. It is tracker-only: Shreni never runs work here.
Use the installed `shreni`, never a build from this checkout.

1. `shreni task ready` lists open tasks with nothing blocking them.
2. `shreni task claim <id>` takes one. It is yours for 8 hours, and any
   `shreni task note` on it renews the claim.
3. Do the work. `shreni task note <id> "…"` records progress.
4. `shreni task finish <id> --reason "…"` once it is reviewed and pushed,
   or `shreni task release <id>` to give it back. An epic finishes
   the same way once all its tasks are done.
5. If you stop without finishing, the claim lapses after 8 hours. Three lapses
   in a row block the task for the developer.

Filing and remembering:

    shreni task create --title "…"   # lands as proposed; the developer approves it
    shreni task remember "…"         # an insight for later sessions

Never run `shreni task approve` or `shreni task upgrade`; those are the developer's.
<!-- shreni:end -->
