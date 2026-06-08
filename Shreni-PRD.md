# Shreni — Product Requirements Document

> Automated Code Development Harness  
> Version 1.0 · June 2026 · TeakWood  
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

**Core value proposition:** A developer can describe a product feature on their phone, have AI decompose it into tasks, and return hours later to find working, reviewed, tested code merged into the main branch — while retaining full visibility and override control at every step.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- Automate the full inner loop of software development: task → code → review → test → merge.
- Support multiple concurrent projects (Kshetras) on a single machine with strict context isolation.
- Enable zero-friction task and bug capture from mobile, CLI, or chat.
- Provide a conversational interface (Vichara) for project Q&A and task management.
- Maintain a complete, auditable task history using `bd` (Beads) per project.
- Require no cloud infrastructure — everything runs locally with GitHub as the sole remote.

### 2.2 Non-Goals

- Shreni is not a replacement for human architectural decisions or product direction.
- Shreni does not manage infrastructure, deployment pipelines, or production operations.
- Shreni is not a general-purpose AI assistant — scope is code development workflows only.
- Shreni does not support distributed/cloud-hosted agent execution in v1.

---

## 3. Users and Stakeholders

| User | Context | Primary Need |
|---|---|---|
| Solo founder / developer | Running Shreni on their machine across 2–5 projects | Delegate coding tasks, capture bugs during demos, monitor progress |
| Co-founder / technical partner | Remote access via Vichara on phone/browser | File tasks, check status, ask questions about the codebase |
| AI Agents (Silpi, Viharapala, E2E) | Automated system users | Structured task context, clear accept/reject criteria, project memory |

---

## 4. Product Overview

### 4.1 Component Architecture

Shreni has five named components, each with a distinct responsibility:

| Component | Role |
|---|---|
| **Sthapathi** | Orchestrator. Polls `bd` for pending tasks, manages agent dispatch, handles git branching and merging, drives the Silpi↔Viharapala review loop. |
| **Silpi** | Coding agent. Receives a task bead, writes implementation code and unit tests, runs lint and tests locally, submits for review. |
| **Viharapala** | Review agent. Evaluates Silpi's output against acceptance criteria, code quality, and test coverage. Approves or rejects with structured feedback. |
| **E2E Agent** | Test agent. Works asynchronously post-merge. Writes end-to-end and user persona tests for shipped features, reports coverage gaps. |
| **Vichara** | Conversational interface. Mobile-first PWA + CLI. Ask questions about the codebase, check agent status, file bugs and tasks — all from one chat thread. |

### 4.2 Kshetra (Project Workspace)

Each project managed by Shreni is a **Kshetra** (Sanskrit: field/domain). A Kshetra is a registered project repo with its own:

- Git repository at `TeakWood/<project-slug>` on GitHub
- `bd` (Beads) task database at `TeakWood/<project-slug>-beads` on GitHub
- RAG index of the codebase for Vichara Q&A
- `kshetra.yaml` configuration (stack, agent settings, conventions)
- Independent agent queue — one active task at a time (sequential execution)

### 4.3 `bd` (Beads) Integration

Shreni uses **`bd`** ([github.com/gastownhall/beads](https://github.com/gastownhall/beads)) as its task store — a distributed graph issue tracker for AI agents, powered by Dolt. Shreni does not build a custom task store; it drives `bd` via CLI commands.

| `bd` Command | Shreni Usage |
|---|---|
| `bd ready --json` | Sthapathi polls for tasks with no open blockers |
| `bd update <id> --claim` | Atomically marks a task in-progress and assigns to Silpi |
| `bd show <id> --json` | Agents read full task details and acceptance criteria |
| `bd prime` | Agents load project memory and workflow context at session start |
| `bd close <id> <note>` | Sthapathi closes task on successful merge |
| `bd create <title> -p <N>` | Vichara / CLI files new tasks and bugs |
| `bd remember <insight>` | Agents persist useful project knowledge across sessions |
| `bd dep add <child> <parent>` | Task dependency linking from Vichara or bead generator |

> **Storage:** `bd` runs in embedded mode (no Dolt server). The `.beads/` database lives inside the `<project-slug>-beads` repo and is committed to GitHub as the sole remote. No DoltHub or Dolt remote server is used.

---

## 5. Feature Requirements

### 5.1 Sthapathi — Orchestration

#### 5.1.1 Task Lifecycle Management

- Sthapathi polls `bd ready --json` for each Kshetra on a configurable interval (default: 30s).
- P0 priority tasks preempt the current queue position and are dispatched immediately.
- Exactly one task is active per Kshetra at any time (`maxConcurrentBeads: 1`).
- On task pickup: creates a git branch `bead-{id}/{slug}` from `main` in the Kshetra repo.
- On task completion: squash-merges branch to `main`, deletes branch, calls `bd close`.
- On max rounds exceeded (default: 3): marks task blocked, sends alert to Vichara.

#### 5.1.2 Silpi↔Viharapala Review Loop

- Sthapathi dispatches Silpi with: task details (`bd show`), project context (`bd prime`), codebase RAG, and prior round feedback.
- On Silpi completion: dispatches Viharapala with the same context plus Silpi's diff and notes.
- On Viharapala `APPROVE`: proceeds to merge flow.
- On Viharapala `REJECT`: increments round counter, re-dispatches Silpi with must-fix list.
- Full feedback history from all prior rounds is included in each agent's context.

#### 5.1.3 E2E Agent Dispatch

- E2E agent is triggered asynchronously after each successful merge — does not block the main loop.
- E2E agent receives: merged diff, feature spec reference, and existing test suite inventory.
- E2E agent outputs new test files committed directly to `main`, plus a coverage gap report.
- Coverage gaps surface as new `bd` tasks (`type: e2e`, priority: P2 by default).

### 5.2 Silpi — Code Generation

- Silpi begins every session with `bd prime` to load project memory and conventions.
- Silpi reads the full task bead including acceptance criteria, related files, and dependency context.
- Silpi writes implementation code and unit tests in a single session.
- Silpi runs lint and unit tests locally before submitting. Submission is blocked if tests fail.
- Silpi calls `bd remember` to persist project insights discovered during coding.
- Silpi's output includes: changed files, test file paths, a summary, self-assessed confidence score, and questions for Viharapala.

### 5.3 Viharapala — Code Review

- Viharapala reviews on five dimensions: correctness, test coverage, code quality, side effects, and completeness.
- Viharapala produces a structured verdict: `APPROVE` or `REJECT` with an overall score (0–100).
- `REJECT` verdicts include: list of blocker issues (must-fix), list of suggestions (non-blocking), and per-file notes.
- Minor issues do not block approval — they are recorded in `bd` notes for future reference.
- Viharapala calls `bd remember` to persist recurring patterns observed across reviews.

### 5.4 Vichara — Conversational Interface

#### 5.4.1 Access Surfaces

- **Mobile PWA:** installable to phone home screen, accessible via Tailscale. Optimised for one-hand use.
- **Browser:** same PWA accessible from any browser on the Tailscale network.
- **CLI:** `shreni` CLI for terminal-first interactions.

#### 5.4.2 Ask Mode

- Answer natural language questions about the codebase using RAG over project files.
- Answer questions about agent state: what is Silpi working on, what's blocked, recent completions.
- Answer questions about task history: what changed in `bead-042`, why was `bead-031` blocked.
- Cross-Kshetra queries: what needs attention across all projects.

#### 5.4.3 Act Mode

- File bug beads: title, severity (P0/P1/P2), context, optional screenshot — confirmed before write.
- Create feature tasks: Vichara proposes a decomposed bead list, user confirms before filing.
- Update task status, add comments, flag blockers.
- P0 bugs: acted on immediately, confirmation shown after.

#### 5.4.4 Ambient Status

- Always-visible status strip showing active agent and current task per Kshetra.
- Proactive notifications for: task completions, blocked tasks, E2E coverage gaps, agent errors.
- Voice input supported for hands-free capture during demos.

### 5.5 Multi-Kshetra Management

- Sthapathi manages N Kshetras concurrently, each with an isolated queue and `bd` instance.
- `BEADS_DIR` environment variable scopes all `bd` calls to the correct Kshetra database.
- Each Kshetra has its own RAG index, rebuilt incrementally on every merged bead.
- Vichara supports per-project context switching via `@kshetra-name` prefix in chat.
- Practical ceiling on a single machine: 5–8 active Kshetras before API rate limits and RAM contention become significant.

### 5.6 Bug and Task Capture

- **CLI:** `bd create 'title' -p 0 -t bug` — minimal, available from any terminal in a registered Kshetra.
- **Vichara (phone):** tap Bug chip → enter title → select severity → optionally dictate context. Filed in under 30 seconds.
- **Auto-triage:** background AI step suggests affected files, related beads, and reproduction steps for newly filed bugs.
- Beads repo synced to GitHub after every write for backup and cross-device access.

---

## 6. Non-Functional Requirements

| Requirement | Target | Notes |
|---|---|---|
| Agent round-trip latency | < 5 min per round | Silpi + Viharapala for a typical bead |
| Vichara response time | < 3s first token | Streaming; RAG lookup included |
| Beads sync delay | < 30s | `git push` after every `bd` write |
| Kshetra isolation | Complete | No cross-contamination of RAG, `bd`, or git context |
| Local-only operation | 100% | No cloud dependency except GitHub and LLM API |
| Mobile usability | One-hand, 30s bug capture | PWA optimised for narrow viewports |
| Offline capture | Bug queue persisted locally | Syncs on reconnect via Vichara PWA |

---

## 7. Constraints and Dependencies

- **LLM API:** Claude Sonnet 4 (Anthropic) for all agents. API key required.
- **bd (Beads) CLI:** must be installed system-wide (`brew install beads` or `npm install -g @beads/bd`).
- **Tailscale:** required for phone↔machine connectivity. Both devices on same Tailscale network.
- **Git:** all Kshetra repos and beads repos hosted at `github.com/TeakWood/`.
- **Node.js / TypeScript:** Sthapathi and Vichara server runtime.
- **Single-writer constraint:** `bd` embedded mode is file-locked. Sthapathi is the sole writer; Vichara routes writes through Sthapathi's API.

---

## 8. Open Questions

1. Should Shreni support a bead generator UI inside Vichara (feature discussion → bead decomposition), or rely on the `bd` CLI for initial task creation?
2. What is the notification delivery mechanism for Vichara alerts when the phone app is in background?
3. Should Viharapala's review strictness be configurable per bead type (bug fix vs. feature vs. refactor)?
4. How should Shreni handle a Kshetra where the `main` branch has diverged from the bead branch during a long-running task?
