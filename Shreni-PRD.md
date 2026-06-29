# Shreni — Product Requirements Document

> Automated Code Development Harness  
> Version 1.1 · June 2026 · TeakWood  
> Confidential — Internal Use Only

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Users and Stakeholders](#3-users-and-stakeholders)
4. [Product Overview](#4-product-overview)
5. [Feature Requirements](#5-feature-requirements)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [Constraints and Dependencies](#7-constraints-and-dependencies)
8. [Open Questions](#8-open-questions)

---

## 1. Executive Summary

Shreni (Sanskrit: *collection of craftsmen*) is a locally-hosted, multi-agent automated code development harness. It orchestrates specialised AI agents to pick up structured tasks, write and review code, run end-to-end tests, and merge approved changes — all without human intervention in the inner loop.

The harness is designed to run on a developer's local machine, manage multiple independent projects (**Kshetras**), and be fully controllable via a conversational mobile/desktop interface called **Vichara**.

**Core value proposition:** A developer can discuss a product feature in Claude Code or on their phone, have AI decompose it into `bd` tasks, and return hours later to find working, reviewed, tested code merged into the main branch — while retaining full visibility and override control at every step.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- Automate the full inner loop of software development: task → code → review → test → merge.
- Support multiple concurrent projects (Kshetras) on a single machine with strict context isolation.
- Enable zero-friction task and bug capture from mobile, CLI, or interactive Claude Code session.
- Provide a conversational interface (Vichara) for project Q&A and task management.
- Maintain a complete, auditable task history using `bd` (Beads) per project.
- Require no cloud infrastructure — everything runs locally with GitHub as the sole remote.
- Allow interactive Claude Code sessions to discuss features and file `bd` tasks without implementing them.

### 2.2 Non-Goals

- Shreni is not a replacement for human architectural decisions or product direction.
- Shreni does not manage infrastructure, deployment pipelines, or production operations.
- Shreni is not a general-purpose AI assistant — scope is code development workflows only.
- Shreni does not support distributed/cloud-hosted agent execution in v1.
- Interactive Claude Code sessions are not permitted to implement features — only Sthapathi's agents do.

---

## 3. Users and Stakeholders

| User | Context | Primary Need |
|---|---|---|
| Solo founder / developer | Running Shreni on their machine across 2–5 projects | Delegate coding tasks, capture bugs during demos, monitor progress |
| Co-founder / technical partner | Remote access via Vichara on phone/browser, or interactive Claude Code | Discuss features, file tasks, check status — not implement |
| Interactive Claude Code session | Human-initiated session in the project repo | Answer questions about the codebase, decompose features into `bd` tasks, never implement |
| AI Agents (Silpi, Viharapala, E2E) | Automated system users driven by Sthapathi | Structured task context injected by Sthapathi; never self-direct via `bd` |

---

## 4. Product Overview

### 4.1 Component Architecture

Shreni has five named components, each with a distinct responsibility:

| Component | Role |
|---|---|
| **Sthapathi** | Orchestrator. Polls `bd` for pending tasks, manages agent dispatch, handles git branching and merging, drives the Silpi↔Viharapala review loop. Owns the entire `bd` task lifecycle. |
| **Silpi** | Coding agent. Receives a task bead (context injected by Sthapathi), writes implementation code and unit tests, runs lint and tests locally, submits for review. Never calls `bd` directly. |
| **Viharapala** | Review agent. Evaluates Silpi's output against acceptance criteria, code quality, and test coverage. Approves or rejects with structured feedback. Never calls `bd` directly. |
| **E2E Agent** | Test agent. Works asynchronously post-merge. Writes end-to-end and user persona tests for shipped features, returns coverage gaps for Sthapathi to file as new `bd` tasks. |
| **Vichara** | Conversational interface. Mobile-first PWA + CLI. Ask questions about the codebase, check agent status, file bugs and tasks — all from one chat thread. |

### 4.2 Two Modes of Human Interaction

Humans interact with the system in two distinct modes. These must not be confused:

| Mode | Surface | Can discuss? | Can file tasks? | Can implement? |
|---|---|---|---|---|
| **Interactive** | Claude Code session in project repo | ✅ Yes | ✅ Yes (via `bd create`) | ❌ Never |
| **Operational** | Vichara PWA / `shreni` CLI | ✅ Yes | ✅ Yes | ❌ Never |

Implementation is exclusively handled by Sthapathi's agents. Humans and interactive Claude Code sessions are task producers, not implementors.

### 4.3 Kshetra (Project Workspace)

Each project managed by Shreni is a **Kshetra** (Sanskrit: field/domain). A Kshetra is a registered project repo with its own:

- Git repository at `TeakWood/<project-slug>` on GitHub
- `bd` (Beads) task database at `TeakWood/<project-slug>-beads` on GitHub
- RAG index of the codebase for Vichara Q&A
- `kshetra.yaml` configuration (stack, agent settings, conventions)
- Independent agent queue — one active task at a time (sequential execution)

### 4.4 `bd` (Beads) Integration

Shreni uses **`bd`** ([github.com/gastownhall/beads](https://github.com/gastownhall/beads)) as its task store — a distributed graph issue tracker for AI agents, powered by Dolt.

**Sthapathi owns the full `bd` task lifecycle.** No agent calls `bd` directly. The `bd` workflow is:

| `bd` Command | Called By | Purpose |
|---|---|---|
| `bd ready --json` | Sthapathi | Poll for tasks with no open blockers |
| `bd update <id> --claim` | Sthapathi | Atomically mark task in-progress |
| `bd show <id> --json` | Sthapathi | Load task context to inject into agent prompt |
| `bd prime` | Sthapathi | Load project memory to inject into agent prompt |
| `bd update <id> --note` | Sthapathi | Record round results on behalf of agents |
| `bd remember <insight>` | Sthapathi | Persist agent-discovered insights from output |
| `bd close <id> <note>` | Sthapathi | Mark complete after successful merge |
| `bd create <title> -p <N>` | Sthapathi (E2E gaps), Vichara, interactive Claude Code, CLI | File new tasks and bugs |
| `bd dep add <child> <parent>` | Vichara, interactive Claude Code | Link task dependencies |

**Interactive Claude Code** uses `bd create`, `bd dep add`, and `bd show` to discuss and file tasks. It never calls `bd update --claim` or `bd close` — those are Sthapathi's exclusively.

> **Storage:** `bd` runs in embedded mode (no Dolt server). The `.beads/` database lives inside the `<project-slug>-beads` repo and is committed to GitHub as the sole remote. No DoltHub or Dolt remote server is used.

### 4.5 `bd setup claude` — Role in Shreni

`bd setup claude` installs two hooks into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": ["bd prime"],
    "PreCompact": ["bd prime"]
  }
}
```

These hooks serve **interactive Claude Code sessions only** — they automatically inject `bd prime` output (project memory, pending tasks, workflow context) at session start and before context compaction. This enables a human using Claude Code to have full task awareness without manual setup.

These hooks have no role in Sthapathi's automated workflow. Sthapathi calls `bd prime` explicitly as part of `buildAgentContext()` and injects the output into agent prompts programmatically.

---

## 5. Feature Requirements

### 5.1 Sthapathi — Orchestration

#### 5.1.1 Task Lifecycle Management

- Sthapathi polls `bd ready --json` for each Kshetra on a configurable interval (default: 30s).
- P0 priority tasks preempt the current queue position and are dispatched immediately.
- Exactly one task is active per Kshetra at any time (`maxConcurrentBeads: 1`).
- On task pickup: creates a git branch `bead-{id}/{slug}` from `main` in the Kshetra repo.
- **Branch-isolation guardrail:** after each agent run, Sthapathi verifies HEAD is still on the bead branch and `main` has not moved. An agent that checks out `main` or commits outside the squash-merge flow cannot land work on `main` — the cycle aborts, stray commits are preserved on a `shreni-salvage/<id>` branch, `main` is restored to origin, and the bead is flagged for a human.
- On task completion: squash-merges branch to `main`, deletes branch, calls `bd close`. This squash-merge is the **only** sanctioned path for changes to reach `main`.
- On max rounds exceeded (default: 3): marks task blocked, sends alert to Vichara. The block reason distinguishes "the task's own tests/lint kept failing" from "Viharapala kept rejecting" — these are different failure modes and must not be conflated.
- Sthapathi is the **sole caller** of `bd update --claim` and `bd close` in the system.

#### 5.1.1a Green-Base Health Gate

The Silpi↔Viharapala test gate compares against the **full** suite, so it is only meaningful when `main` is green to begin with. Sthapathi enforces "green main" as a precondition rather than working around a red one:

- **At the pickup boundary only** (never mid-loop), before claiming a feature task, Sthapathi runs the configured test suite on the freshly-pulled `main`. The result is cached by `main`'s HEAD sha — since `main` only moves on merge, the suite runs at most once per merge, not once per 30s poll.
- "Green" means **no failures beyond an accepted baseline** of known-failing tests (default baseline: 0 — fully green). This baseline is the escape valve that keeps genuinely-unfixable tests from wedging all work.
- If the base is red beyond the baseline, the feature task is **not** claimed. Instead Sthapathi ensures a single P0 `[shreni-health]` "restore green suite" repair bead exists and defers feature work until the suite is green again.
- The repair bead is **exempt** from this gate (it is the thing that restores green) and is gated on "failures must strictly decrease" instead of "tests pass." On reaching zero it merges and resets the baseline to 0.
- If the repair bead cannot reach zero within max rounds, Sthapathi **quarantines** the remaining failures (bumps the accepted baseline to the current count) and flags the bead `[needs-human]`. Feature work then resumes against the new baseline, so an intractable suite degrades to "proceed, minus these known failures" rather than deadlocking the whole Kshetra.
- The health gate runs **only** at pickup / on restart-with-no-WIP — it never interrupts an in-flight Silpi↔Viharapala round. Resuming WIP after a restart goes through the recovery path, which bypasses the gate by construction.

#### 5.1.2 Beads Auto-Sync

- On daemon startup, Sthapathi syncs all registered Kshetra beads repos before the first poll cycle.
- A background sync runs every 5 minutes per Kshetra, independent of task activity — ensuring the beads repo stays current even when no tasks are in flight.
- Sync order: commit any local changes first, then pull-rebase from remote, then push. This prevents `git pull --rebase` from failing on a dirty working tree.
- Concurrent sync calls for the same Kshetra are deduplicated — a second caller awaits the in-flight sync rather than launching a parallel git operation, preventing index lock conflicts.
- Stale `.git/index.lock` files (left by crashed git processes) are cleared automatically before each sync attempt.

#### 5.1.3 Silpi↔Viharapala Review Loop

- Sthapathi builds full agent context before each dispatch: `bd prime` output + `bd show` output + RAG chunks + skills.
- On Silpi completion: Sthapathi records the round note via `bd update --note`, then dispatches Viharapala.
- On Viharapala completion: Sthapathi records the verdict via `bd update --note`.
- The pre-Viharapala test gate assumes a green base (guaranteed by §5.1.1a), so a failing suite at this point is attributable to the task's own diff — not pre-existing unrelated failures.
- On Viharapala `APPROVE`: proceeds to merge flow.
- On Viharapala `REJECT`: increments round counter, re-dispatches Silpi with must-fix list.
- Sthapathi calls `bd remember` after each session to persist insights returned in agent output.

#### 5.1.4 E2E Agent Dispatch

- E2E agent is triggered asynchronously after each successful merge — does not block the main loop.
- E2E agent returns coverage gaps in its output; Sthapathi translates these into `bd create` calls.
- New test files are committed directly to `main` by Sthapathi on behalf of the E2E agent.

### 5.2 Silpi — Code Generation

- Silpi receives full task context injected by Sthapathi — it does not call `bd` commands.
- Silpi writes implementation code and unit tests, runs lint and tests locally before submitting.
- Silpi's output includes: changed files, test file paths, summary, confidence score, questions for Viharapala, and a list of project insights for Sthapathi to persist via `bd remember`.
- Silpi's prompt explicitly instructs it not to call `bd` commands or manage task state.

### 5.3 Viharapala — Code Review

- Viharapala receives full task context plus Silpi's output, injected by Sthapathi — it does not call `bd` commands.
- Viharapala produces a structured verdict: `APPROVE` or `REJECT` with score, blockers, and suggestions.
- Viharapala's output includes a list of project insights for Sthapathi to persist via `bd remember`.
- Viharapala's prompt explicitly instructs it not to call `bd` commands or manage task state.

### 5.4 Interactive Claude Code Session

- `bd setup claude` installs `SessionStart` and `PreCompact` hooks so `bd prime` runs automatically.
- The interactive session has full awareness of pending tasks, project memory, and codebase context.
- The session can discuss features, decompose them into tasks, and file them via `bd create`.
- The session can link dependencies via `bd dep add` and query tasks via `bd show` / `bd ready`.
- The session **must not** call `bd update --claim`, `bd close`, or any git operations on the main repo.
- `CLAUDE.md` in the project root includes a SHRENI INTEGRATION section (added by `shreni init-kshetra`) that instructs Claude Code on its role: discuss and file, never implement.

### 5.5 Vichara — Conversational Interface

Vichara runs as a **`claude` CLI agentic loop**, not a custom function-tool
server. Each chat turn spawns the `claude` CLI in print mode (`stream-json`)
scoped to the active Kshetra repo; the model drives its own loop with native
tools (`Read`/`Grep`/`Glob`) plus an **allowlist** of read-only `bd` and `git`
subcommands. The read/write boundary is enforced by the CLI `--allowedTools`
allowlist — i.e. by the harness — rather than by prompt instructions alone, so
anything not allowlisted (file edits, `git commit`/`push`, `bd close`) is denied
outright. Auth is the CLI's own subscription/OAuth session; **no
`ANTHROPIC_API_KEY` is required**.

#### 5.5.1 Access Surfaces

- **Mobile PWA:** installable to phone home screen, accessible via Tailscale. Optimised for one-hand use.
- **Browser:** same PWA accessible from any browser on the Tailscale network.
- **CLI:** `shreni` CLI for terminal-first interactions.

#### 5.5.2 Ask Mode (read-only — Phase 10, shipped)

The default and only mode until Phase 11. Vichara answers using its read-only
toolset (native `Read`/`Grep`/`Glob` over the repo, plus read-only `bd`/`git`):

- Answer natural language questions about the codebase by reading and searching project files (RAG augments this where indexed).
- Answer questions about agent state: what is Silpi working on, what's blocked, recent completions.
- Answer questions about task history: what changed in `bead-042`, why was `bead-031` blocked.
- Cross-Kshetra queries: what needs attention across all projects.

#### 5.5.3 Act Mode (write — Phase 11)

Write capability is added by **extending the allowlist** with specific filing
subcommands (`bd create`, add-note, flag) — never custom function tools, and
never `bd update --claim` / `bd close`, which stay Sthapathi-only. The agent
proposes the change in chat and **confirms before executing** the `bd` write:

- File bug beads: title, severity (P0/P1/P2), context, optional screenshot — agent proposes, user confirms, then `bd create -t bug`.
- Create feature tasks: Vichara proposes a decomposed bead list, user confirms before filing.
- Add comments and flag blockers on existing beads (no claim/close).
- P0 bugs: filed immediately, confirmation shown after.

#### 5.5.4 Ambient Status

- Always-visible status strip showing active agent and current task per Kshetra.
- Proactive notifications for: task completions, blocked tasks, E2E coverage gaps, agent errors.
- Voice input supported for hands-free capture during demos.

### 5.6 Developer Observability — `shreni tail`

Developers need live visibility into what agents are doing without watching raw daemon logs. `shreni tail` provides a real-time, human-readable stream of agent activity.

- `shreni tail --kshetra <id>` streams agent events for a single Kshetra.
- `shreni tail --all` streams events across all registered Kshetras simultaneously.
- Events are written by Sthapathi to a per-Kshetra JSONL log at `~/.shreni/logs/<id>.jsonl` and polled every 500ms.
- Each event line shows: timestamp, Kshetra, event type, and relevant detail.

**Events streamed:**

| Event | When emitted | What it shows |
|---|---|---|
| `TASK` | Task claimed | Bead ID + title |
| `SILPI R{n} starting…` | Before Silpi API call | Round number |
| `SILPI R{n}` | After Silpi returns | Confidence score, lint/test status, summary, changed files |
| `VIHARAPALA R{n} starting…` | Before Viharapala API call | Round number |
| `VIHARAPALA R{n}` | After Viharapala returns | Verdict (APPROVE/REJECT), overall score, must-fix items |
| `DONE` | Task approved or blocked | Approved/blocked, total rounds |
| `ERROR` | Agent or git failure | Bead ID + error message |

The log file is append-only and survives daemon restarts. `shreni tail` prints existing history then follows new events.

### 5.7 Multi-Kshetra Management

- Sthapathi manages N Kshetras concurrently, each with an isolated queue and `bd` instance.
- `BEADS_DIR` environment variable scopes all `bd` calls to the correct Kshetra database.
- Each Kshetra has its own RAG index, rebuilt incrementally on every merged bead.
- Vichara supports per-project context switching via `@kshetra-name` prefix in chat.
- Practical ceiling on a single machine: 5–8 active Kshetras before API rate limits and RAM contention become significant.

### 5.8 Bug and Task Capture

- **CLI:** `bd create 'title' -p 0 -t bug` — available from any terminal in a registered Kshetra.
- **Vichara (phone):** tap Bug chip → enter title → select severity → optionally dictate context. Filed in under 30 seconds.
- **Interactive Claude Code:** discuss the bug in context, let Claude decompose and file via `bd create`.
- **Auto-triage:** background AI step suggests affected files, related beads, and reproduction steps for newly filed bugs.
- Beads repo synced to GitHub after every Sthapathi write for backup and cross-device access.

---

## 6. Non-Functional Requirements

| Requirement | Target | Notes |
|---|---|---|
| Agent round-trip latency | < 5 min per round | Silpi + Viharapala for a typical bead |
| Vichara response time | < 3s first token | Streaming; RAG lookup included |
| Beads sync delay | < 5 min | Periodic auto-sync every 5 min; immediate sync on task write |
| Kshetra isolation | Complete | No cross-contamination of RAG, `bd`, or git context |
| Local-only operation | 100% | No cloud dependency except GitHub and LLM API |
| Mobile usability | One-hand, 30s bug capture | PWA optimised for narrow viewports |
| Offline capture | Bug queue persisted locally | Syncs on reconnect via Vichara PWA |

---

## 7. Constraints and Dependencies

- **LLM API:** Claude Sonnet 4 (Anthropic) for all agents. API key required.
- **`bd` (Beads) CLI:** must be installed system-wide (`brew install beads` or `npm install -g @beads/bd`).
- **Tailscale:** required for phone↔machine connectivity. Both devices on same Tailscale network.
- **Git:** all Kshetra repos and beads repos hosted at `github.com/TeakWood/`.
- **Node.js / TypeScript:** Sthapathi and Vichara server runtime.
- **Single-writer constraint:** `bd` embedded mode is file-locked. Sthapathi is the sole writer for task state transitions; `bd create` may be called from Vichara or interactive Claude Code for task filing only.

---

## 8. Open Questions

1. Should `shreni init-kshetra` write the SHRENI INTEGRATION section to `CLAUDE.md` automatically, or leave it as a manual step?
2. What is the notification delivery mechanism for Vichara alerts when the phone app is in background?
3. Should Viharapala's review strictness be configurable per bead type (bug fix vs. feature vs. refactor)?
4. How should Shreni handle a Kshetra where the `main` branch has diverged from the bead branch during a long-running task?
5. Should interactive Claude Code sessions be able to reorder task priorities via `bd update`, or is that reserved for the human via `bd` CLI directly?
