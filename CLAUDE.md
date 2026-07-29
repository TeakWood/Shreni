# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. The beads database is symlinked as `.beads/` in this repo. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

> **Note:** `bd` auto-discovers the database via the `.beads/` symlink. No `BEADS_DIR` export needed when running from this project directory. If running from outside this repo, set `BEADS_DIR` to the checkout's `.beads/` directory.

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push          # NOTE: pushes ONLY this repo. The beads DB is a SEPARATE repo with its own remote — see "Beads Repository & Sync" below; it does NOT ship with this push.
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
<!-- END BEADS INTEGRATION -->

## Beads Repository & Sync

**The beads DB is a SEPARATE git repository, not part of this repo.** `.beads/`
is a symlink to a sibling checkout (`Shreni-beads`) that has its own remote
(`github.com:TeakWood/Shreni-beads.git`). This repo tracks **nothing** under
`.beads/`, so **`git push` of the Shreni repo does NOT ship any bead changes** —
the beads repo is committed and pushed on its own.

The remote's source of truth is `issues.jsonl` (the Dolt data under
`embeddeddolt/` is local-only). bd auto-syncs periodically, but it is **not
guaranteed to have exported your latest `bd create` / `update` / `close`** — the
child beads of a just-created epic are a common miss, because the auto-sync can
fire between the parent and the children.

**MANDATORY: after ANY bead mutation (`bd create` / `bd update` / `bd close`),
sync the beads repo explicitly — do not rely on auto-sync:**

```bash
bd export                                    # regenerate issues.jsonl from the live DB
cd .beads                                    # the symlink resolves into the beads repo
git add issues.jsonl
git commit -m "chore(beads): sync <what changed>"
git pull --rebase && git push                # ship to the beads remote
git status                                   # MUST show "up to date with origin"
```

Verify a specific bead actually shipped:
`grep '"id":"<bead-id>"' .beads/issues.jsonl` — if a bead you created isn't
there, it was never exported and never pushed.

**Caveat:** do NOT run manual git ops on the beads repo while a Shreni worker is
running — concurrent access triggers `doSyncBeads` "no candidate for rebasing"
pull errors. Stop the worker first (or let its own auto-sync handle it).


## Build & Test

**Package manager: pnpm only.** Never use `npm` or `yarn` — the project enforces this via `engines` in package.json and `.npmrc`.

```bash
pnpm install        # install dependencies
pnpm build          # compile TypeScript
pnpm typecheck      # type-check without emitting
pnpm dev            # run via tsx
```

## Architecture Overview

Shreni is an autonomous coding-agent harness. **Sthapathi** (orchestrator) polls
`bd` for ready tasks and drives a **Silpi** (coder) ↔ **Viharapala** (reviewer)
loop, squash-merges approved work to `main`, and dispatches **Parikshaka** (test
agent) asynchronously after merge. **Phalaka** is a loopback dashboard. Each
managed project is an isolated **Kshetra** with its own repo, `bd` database, RAG
index, and agent queue. See the README's Architecture section for the component
table and flow diagram.

## Conventions & Patterns

- **One config per Kshetra** at `<repo>/.shreni/kshetra.yaml`; `~/.shreni/registry.json`
  is the only thing that resolves `id → configPath`. Paths are absolute.
- **Sthapathi is the sole caller** of `bd update --claim` / `bd close`. Agents never
  call `bd` directly — they receive task context as injected prompt data.
- **TypeScript strict**, tests via **vitest**, provider adapters behind a single
  `ProviderAdapter` interface (`src/agents/providers/`).

## Feature Planning & Design Rubric

**When the operator asks to plan, design, or scope a feature** (new capability or
a change to an existing one), adopt the five-stage flow below rather than jumping
straight to code or beads. Each stage has a hat and an exit condition; do not
advance until the exit condition is met, and **never file beads or write design
docs until Stage 5** — the operator approves the bundle first.

| Stage | Hat | Purpose | Exit condition |
|-------|-----|---------|----------------|
| **1 · Discovery** | Product | Capture the raw idea: intent, the user and their problem, the "why now", rough success criteria. Detect new-feature vs. change-to-existing; if a change, locate and load the existing design doc. | Problem/outcome stated in the operator's words and reflected back; any existing doc loaded. |
| **2 · Clarify** | Product → Technical | Active interview: resolve ambiguity, enumerate edge cases, non-functional requirements, explicit in/out of scope, priorities, constraints. | Readiness rubric satisfied; open questions answered or explicitly deferred. |
| **3 · Decompose** | Technical | Grounded in the repo, break the feature into a parent epic + child beads with acceptance criteria, each sized for one Silpi ↔ Viharapala pass, ordered by dependency. | Every child has title, description, acceptance criteria, priority; deps drawn; nothing left as "and then figure out X". |
| **4 · Design** | Technical | Synthesise the decisions into a design note: chosen approach, key components and their touch-points in **real files**, alternatives, risks. | The note explains *why* the decomposition looks the way it does, referencing real files. |
| **5 · Confirm & commit** | — | Present the full bundle; operator edits/approves; **only then** write the doc + file the beads. | Operator confirms; artifacts written; bead ids echoed. |

Guidance:

- **Ground before you decompose.** Stages 3–4 must reference real files/symbols
  (use the repo map, search, or subagents) — no hand-wavy decomposition.
- **Confirm is a hard gate.** Stage 5 is the first point at which anything is
  written; before it, everything is a proposal the operator can edit.
- **Store the design note on the epic** (`bd create --design=...`) so it travels
  with the work, and echo the epic + child ids back when done.
- Scale the ceremony to the ask — a one-line tweak doesn't need five stages, but
  anything that becomes an epic does.
