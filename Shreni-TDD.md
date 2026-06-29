# Shreni — Technical Design Document

> Automated Code Development Harness  
> Version 1.1 · June 2026 · TeakWood  
> Confidential — Internal Use Only

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Repository Structure](#2-repository-structure)
3. [Data Models](#3-data-models)
4. [Sthapathi — Orchestrator Design](#4-sthapathi--orchestrator-design)
5. [Error Handling and Recovery](#5-error-handling-and-recovery)
6. [Agent Design](#6-agent-design)
7. [Interactive Claude Code Integration](#7-interactive-claude-code-integration)
8. [Vichara — Server Design](#8-vichara--server-design)
9. [RAG Index Design](#9-rag-index-design)
10. [Git Operations](#10-git-operations)
11. [shreni CLI](#11-shreni-cli)
12. [Security Model](#12-security-model)
13. [Recommended Build Sequence](#13-recommended-build-sequence)

---

## 1. System Overview

Shreni is a locally-hosted multi-agent code development harness. This document describes the technical design: module boundaries, data models, inter-agent communication, storage, and the runtime topology on a developer's machine.

The system is built with **TypeScript/Node.js** for the Sthapathi orchestrator and Vichara server. Agents invoke **Claude Sonnet 4** via the Anthropic API. Task storage uses **`bd` (Beads)** — a Dolt-powered embedded CLI tool. All project repos and beads repos are hosted on `github.com/TeakWood/`.

### 1.1 Command Boundary

Two CLI tools, distinct responsibilities, no overlap:

| CLI | Owns |
|---|---|
| `bd` | All task operations — create, claim, close, show, remember, dep, prime |
| `shreni` | Harness operations — Kshetra management, agent control, workflow, RAG, Vichara |

`shreni` never wraps or proxies `bd` commands. If you need to manage tasks, use `bd` directly.

### 1.2 `bd` Caller Boundary

This is the most important design constraint in the system:

| Caller | Permitted `bd` operations |
|---|---|
| **Sthapathi** | All — `ready`, `claim`, `show`, `prime`, `note`, `remember`, `close`, `create` (E2E gaps), `flag` |
| **Vichara** | Phase 10: read-only (`list`, `ready`, `show`, `blocked`, `stats`, `search`, …). Phase 11 adds `create` + note/flag via allowlist (never `claim`/`close`). Runs `bd` directly through the CLI agentic loop's allowlist — not the `beads.ts` wrapper. |
| **Interactive Claude Code** | `create`, `dep add`, `show`, `ready`, `prime` (read + file only) |
| **Silpi** | None — receives `bd` output as injected context, never calls `bd` |
| **Viharapala** | None — receives `bd` output as injected context, never calls `bd` |
| **E2E Agent** | None — returns coverage gaps in output; Sthapathi calls `bd create` on its behalf |

`bd update --claim` and `bd close` are called **only by Sthapathi**. No other component touches task state transitions.

---

## 2. Repository Structure

### 2.1 Shreni Harness Repo

The Shreni harness itself lives at `TeakWood/shreni`. Its own tasks are tracked at `TeakWood/shreni-beads` (dogfooding).

```
TeakWood/shreni/
├── sthapathi/          # Orchestrator — scheduler, git ops, agent dispatch
│   ├── index.ts        # Main loop entry point
│   ├── scheduler.ts    # Per-Kshetra queue management
│   ├── git.ts          # Branch create, merge, push helpers
│   ├── beads.ts        # bd CLI wrapper — internal to Sthapathi only
│   ├── dispatch.ts     # Agent session builder + context injector
│   └── activity-log.ts # Per-Kshetra JSONL event log (~/.shreni/logs/<id>.jsonl)
├── agents/
│   ├── silpi.ts        # Coding agent session
│   ├── viharapala.ts   # Review agent session
│   └── e2e.ts          # E2E test agent session
├── vichara/            # Conversational interface server
│   ├── server.ts       # Fastify + WebSocket
│   ├── tools/
│   │   ├── read.ts     # Codebase search, bead queries
│   │   └── write.ts    # bd create/dep — routes through Sthapathi API
│   ├── rag.ts          # Per-Kshetra vector index
│   └── pwa/            # Mobile PWA (React)
├── kshetra/
│   ├── registry.ts     # Discover and load Kshetras
│   └── config.ts       # kshetra.yaml parser
├── cli/
│   └── shreni.ts       # shreni CLI entry point
└── shreni-beads/       # Symlink to ../shreni-beads clone
```

### 2.2 Per-Kshetra Layout

```
/projects/<slug>/               # Main project repo (TeakWood/<slug>)
├── .beads/                     # Symlink → /projects/<slug>-beads/
├── .shreni/
│   ├── kshetra.yaml            # Kshetra config
│   ├── style-guide.md          # Silpi reads this
│   ├── arch.md                 # Architecture context for agents
│   └── personas.yaml           # E2E user personas
├── CLAUDE.md                   # Agent skills + SHRENI INTEGRATION section
├── .claude/
│   ├── settings.json           # bd SessionStart/PreCompact hooks (bd setup claude)
│   └── commands/               # Per-task scoped skills
├── AGENTS.md                   # Written by: bd init
├── .gitignore                  # Includes: .beads/
└── src/

/projects/<slug>-beads/         # Beads repo (TeakWood/<slug>-beads)
├── .git/
└── embeddeddolt/               # bd Dolt database (committed to GitHub)
```

> **Symlink pattern:** `bd` embedded mode requires `BEADS_DIR` to point at the directory containing `embeddeddolt/`. Sthapathi sets `BEADS_DIR=/projects/<slug>-beads` for all `bd` calls. The `.beads/` symlink inside the project dir is a convenience for interactive Claude Code sessions running with `cwd` set to the project.

---

## 3. Data Models

### 3.1 Kshetra Config (`kshetra.yaml`)

```yaml
id: sishya
name: Sishya
description: AI-enabled test platform for coaching institutes

repo:
  path: /projects/sishya
  remote: git@github.com:TeakWood/sishya.git
  mainBranch: main
  branchPattern: "bead-{id}/{slug}"

beads:
  path: /projects/sishya-beads     # local beads repo clone
  remote: git@github.com:TeakWood/sishya-beads.git
  mode: embedded                   # no dolt server

stack:
  language: typescript
  framework: nextjs
  testRunner: vitest
  linter: eslint

conventions:
  styleGuide: .shreni/style-guide.md
  architecture: .shreni/arch.md

agents:
  model: claude-sonnet-4
  maxRoundsPerBead: 3

priority:
  p0AutoAssign: true
  maxConcurrentBeads: 1
```

### 3.2 Agent Output Types

```typescript
// Silpi output
interface SilpiOutput {
  filesChanged: { path: string; diff: string }[];
  testFiles: string[];
  summary: string;
  confidenceScore: number;       // 0-100, self-assessed
  questionsForReviewer: string[];
  lintPassed: boolean;
  testsPassed: boolean;
  insights: string[];            // Sthapathi calls bd remember for each
}

// Viharapala output
interface ViharapalaOutput {
  verdict: 'APPROVE' | 'REJECT';
  overallScore: number;          // 0-100
  mustFix: string[];             // blockers; passed back to Silpi next round
  suggestions: string[];         // non-blocking improvements
  issues: {
    severity: 'blocker' | 'major' | 'minor';
    file?: string;
    description: string;
  }[];
  insights: string[];            // Sthapathi calls bd remember for each
}

// E2E Agent output
interface E2EOutput {
  testFilesAdded: string[];
  coverageGaps: { feature: string; description: string; priority: number }[];
  // Sthapathi calls bd create for each coverageGap — E2E agent never calls bd
}
```

### 3.3 Shreni Runtime State

```typescript
interface KshetraState {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'idle' | 'error';
  activeBead: string | null;
  activeAgent: 'silpi' | 'viharapala' | 'e2e' | null;
  round: number;
  queueDepth: number;
  lastCompletedAt: string | null;
  lastError: string | null;
  // Accepted count of known-failing tests for the health gate (§4.1a). The base
  // suite is "green enough" when current failures <= this. Default 0 (fully
  // green); bumped by quarantine when a repair bead can't reach zero. Persisted
  // in ~/.shreni/state.json alongside pause state.
  healthBaseline: number;
}
```

---

## 4. Sthapathi — Orchestrator Design

### 4.1 Main Loop

Sthapathi runs as a single Node.js process. It manages one sequential queue per Kshetra. The main loop polls on a configurable interval (default 30s) and is event-driven for P0 priority tasks.

```typescript
// sthapathi/index.ts
async function runCycle(kshetra: Kshetra): Promise<void> {
  await syncBeads(kshetra);                   // git pull on beads repo
  const tasks = await bd(kshetra).ready();    // bd ready --json
  if (tasks.length === 0) return;

  const task = pickNext(tasks);               // P0 first, then FIFO
  await bd(kshetra).claim(task.id);           // bd update --claim (atomic)
                                              // ONLY Sthapathi calls this

  const branch = await git(kshetra).createBranch(task);
  const result = await runSilpiViharapalaLoop(kshetra, task, branch);

  if (result.approved) {
    await git(kshetra).merge(branch);
    await bd(kshetra).close(task.id, result.note);  // ONLY Sthapathi calls this
    await syncBeads(kshetra);
    dispatch(e2eAgent, kshetra, task);        // async, non-blocking
  } else {
    await bd(kshetra).flag(task.id, 'Exceeded max rounds');
    await notifyVichara(kshetra, task, 'blocked');
  }
}
```

### 4.1a Green-Base Health Gate

The pre-Viharapala test gate (§4.2) checks the **whole** suite, so it is only meaningful when `main` is green. Rather than baseline-diff every task's self-reported result, Sthapathi makes the invariant true: it guarantees a green base before a feature loop starts, so any failure observed during the loop is attributable to that task's diff.

**Why a gate, not per-task diffing.** `testsPassed` is self-reported by the Silpi LLM (`sthapathi/dispatch.ts` → `silpi.ts` system prompt). Diffing an LLM's self-assessment against a remembered baseline is fragile. A deterministic suite run by Sthapathi on a known tree is trustworthy, and it sits naturally at the scheduler's existing pickup boundary — so it never interferes mid-loop.

```typescript
// sthapathi/health.ts
export async function checkHealth(kshetra: Kshetra): Promise<HealthStatus> {
  const sha = await git(kshetra).headSha();          // cache key — main moves only on merge
  const baseline = getHealthBaseline(kshetra);       // accepted known-failing count
  if (cached(kshetra, sha, baseline)) return cache;  // no re-run while main is unchanged
  const { passed, failCount } = await runTestSuite(kshetra);  // configured stack.testRunner
  // green = fully passing OR failures within the accepted baseline
  const green = passed || (failCount >= 0 && failCount <= baseline);
  return store(kshetra, { green, failCount, baseline, sha });
}
```

The gate lives in `pickup()`, after `preFlightCheck` (which puts us on a clean, pulled `main`) and **before** `bd claim`:

```typescript
// sthapathi/pickup.ts
if (!isHealthBead(task)) {
  const health = await checkHealth(kshetra);
  if (!health.green) {
    await ensureHealthBead(kshetra, health.failCount);  // idempotent P0 [shreni-health] bead
    return null;                                        // defer feature work; don't claim
  }
}
await bd(kshetra).claim(task.id);
```

**Repair loop.** A `[shreni-health]` bead is dispatched through a dedicated path in `runSilpiViharapalaLoop` (`runHealthRepairLoop`). It is exempt from the green precondition and gated on "failures must strictly decrease":

- Measure failures on the branch before round 1 — that's the bar to beat.
- After each Silpi round, re-measure (`measureHealth`, cache-bypassing since the tree changed). Green → squash-merge, `setHealthBaseline(0)`, done. Fewer failures → record progress, continue. No progress → continue (counts toward max rounds).
- On exhausting max rounds without green → **quarantine**: `setHealthBaseline(remainingFailures)` so feature work can resume against the new baseline, and `flag` the bead `[needs-human]`. This is the key safety property: an intractable suite degrades to "proceed minus known failures," never a whole-Kshetra deadlock.

**Restart / WIP.** The gate is only in the pickup path. In-flight tasks resume through the recovery path (§5.7), which bypasses the gate by construction — consistent with "never interfere with a loop mid-turn."

### 4.2 Silpi↔Viharapala Loop

```typescript
async function runSilpiViharapalaLoop(
  kshetra: Kshetra, task: Task, branch: string
): Promise<{ approved: boolean; note: string }> {
  // [shreni-health] beads run a different loop — see §4.1a (gated on
  // "failures must decrease", not Viharapala approval).
  if (isHealthBead(task)) return runHealthRepairLoop(kshetra, task);

  let round = 0;
  let feedback: ViharapalaOutput | null = null;
  // Why the latest round failed — so the terminal block reason distinguishes
  // "task's own tests failed" from "reviewer rejected".
  let lastRejectSource: 'tests' | 'reviewer' | null = null;

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;

    // Sthapathi builds context — agents never call bd themselves
    const context = await buildAgentContext(kshetra, task);
    const silpiOut = await runSilpi(context, branch, feedback);

    // Sthapathi persists insights on Silpi's behalf
    for (const insight of silpiOut.insights) {
      await bd(kshetra).remember(insight);
    }

    // The base is green (guaranteed by §4.1a), so a failing suite here is the
    // task's own diff — not pre-existing unrelated failures.
    if (!silpiOut.testsPassed || !silpiOut.lintPassed) {
      await bd(kshetra).addNote(task.id, `Round ${round}: lint/tests failed`);
      lastRejectSource = 'tests';
      feedback = { verdict: 'REJECT', mustFix: ['Tests or lint failed'], insights: [] };
      continue;
    }

    await bd(kshetra).addNote(task.id, `Round ${round}: submitted for review`);

    feedback = await runViharapala(context, silpiOut, round);

    // Sthapathi persists Viharapala insights
    for (const insight of feedback.insights) {
      await bd(kshetra).remember(insight);
    }

    await bd(kshetra).addNote(task.id, `Round ${round}: ${feedback.verdict}`);

    if (feedback.verdict === 'APPROVE') {
      return { approved: true, note: `Approved round ${round}` };
    }
    lastRejectSource = 'reviewer';
  }
  const cause = lastRejectSource === 'tests'
    ? "task's own tests/lint kept failing"
    : 'Viharapala kept rejecting';
  await bd(kshetra).flag(task.id, `Blocked after ${round} rounds — ${cause}.`);
  return { approved: false, note: `Blocked after ${round} rounds` };
}
```

### 4.2a Branch-Isolation Guardrail

The safety model assumes agents only ever commit to their bead branch, and that changes reach `main` solely through `squashMergeAndClose`. Nothing enforced that: an agent that ran `git checkout main` and committed there landed unreviewed, out-of-scope work directly on `main` (incident `sishya-le3y`). The orchestrator never noticed.

Sthapathi now **verifies the invariant around every agent run** rather than trusting the agent. Right after `createTaskBranch`, it snapshots the sanctioned state (on the bead branch, `main` at origin); after each Silpi round it asserts nothing drifted.

```typescript
// sthapathi/guard.ts
export async function captureGuard(kshetra, branch): Promise<BranchGuard> {
  return { branch, mainSha: await git(kshetra).headSha(kshetra.repo.mainBranch) };
}

export async function assertOnBranch(kshetra, guard): Promise<void> {
  const [head, mainSha] = await Promise.all([
    git(kshetra).currentBranch(),                  // HEAD must still be the bead branch
    git(kshetra).headSha(kshetra.repo.mainBranch), // main must not have moved
  ]);
  if (head !== guard.branch || mainSha !== guard.mainSha) {
    throw new OffBranchError(/* reason + detail */);
  }
}
```

On a violation the cycle aborts **before review or merge** — so off-branch work can never reach the squash-merge flow — and recovers without losing the agent's commits:

```typescript
// after each runSilpi(), in both the review loop and the health-repair loop:
const offBranch = await guardAfterAgent(kshetra, task, guard, round);
if (offBranch) return offBranch;   // aborts; bead is flagged
```

`recoverOffBranch` returns HEAD to the bead branch, then — if `main` diverged — preserves the stray commits on a `shreni-salvage/<task.id>` branch and force-resets `main` back to origin. The bead is flagged `[needs-human]` with the salvage ref named, so the invariant (`main == origin`, all changes via squash-merge) is restored automatically while the work is kept for manual triage. This satisfies the rule: **an agent cannot land commits on `main` outside the squash-merge flow.**

### 4.3 Agent Context Builder

Sthapathi builds the full context before each agent dispatch. Agents receive `bd` output as data — they never call `bd` themselves.

```typescript
// sthapathi/dispatch.ts
async function buildAgentContext(kshetra: Kshetra, task: Task): Promise<AgentContext> {
  return {
    // bd output injected as context — NOT available as a tool to agents
    projectMemory:   await bd(kshetra).prime(),        // bd prime output
    taskDetails:     await bd(kshetra).show(task.id),  // full task + history

    // Skills — three-tier injection
    universalSkills: loadSkills('~/.shreni/skills/'),
    projectSkills:   readFile(kshetra, 'CLAUDE.md'),
    scopedSkills:    loadScopedClaudes(kshetra, task.context.relatedFiles),

    // Project conventions
    conventions:     readFile(kshetra, '.shreni/style-guide.md'),
    architecture:    readFile(kshetra, '.shreni/arch.md'),

    // Codebase context
    ragChunks:       await rag(kshetra).search(task.title, { topK: 10 }),
    stack:           kshetra.stack,
  };
}
```

### 4.4 Beads Sync

`bd` calls are internal to Sthapathi only. The `beads.ts` wrapper is not used by the `shreni` CLI or Vichara.

**Sync order:** local changes are committed *before* pulling. `git pull --rebase` rejects a dirty working tree, so staging and committing first is required. This also means local beads writes are preserved if the pull-rebase encounters a conflict.

**Concurrency guard:** if two callers (e.g. the periodic sync timer and a per-task sync) hit `syncBeads` for the same Kshetra simultaneously, the second caller receives the same in-flight Promise instead of spawning a parallel git operation. Parallel `git add` on the same repo causes `index.lock` conflicts.

**Stale lock cleanup:** a `.git/index.lock` file left by a previously crashed git process is removed automatically before each sync attempt.

**Periodic sync:** the daemon calls `syncAll()` (syncs all registered Kshetras) on startup and every 5 minutes via `setInterval`. This ensures the beads repo stays current between task runs and protects against data loss if the machine is powered off between tasks.

```typescript
// sthapathi/beads.ts — internal module, not exposed outside Sthapathi

// Deduplicates concurrent sync calls per beads path
const syncInFlight = new Map<string, Promise<void>>();

export function syncBeads(kshetra: Kshetra): Promise<void> {
  const key = kshetra.beads.path;
  const existing = syncInFlight.get(key);
  if (existing) return existing;                      // share in-flight sync

  const promise = doSyncBeads(kshetra).finally(() => syncInFlight.delete(key));
  syncInFlight.set(key, promise);
  return promise;
}

async function doSyncBeads(kshetra: Kshetra): Promise<void> {
  // Clear stale lock before touching git
  const indexLock = join(kshetra.beads.path, '.git', 'index.lock');
  if (existsSync(indexLock)) rmSync(indexLock);

  const g = git(kshetra.beads.path);
  await g.add('-A');                                  // stage local changes first
  await g.commit(`shreni: sync ${new Date().toISOString()}`);  // no-op if nothing staged
  await g.pull('--rebase', 'origin', 'main');         // pull-rebase now safe (clean tree)
  await g.push('origin', 'main');
}

// daemon.ts — periodic sync for all Kshetras
const BEADS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function syncAll(): Promise<void> {
  for (const kshetra of kshetras) {
    try { await syncBeads(kshetra); }
    catch (err) { log.error(`beads sync failed for "${kshetra.id}":`, err); }
  }
}

syncAll();                                            // sync on startup before first poll
setInterval(syncAll, BEADS_SYNC_INTERVAL_MS);        // periodic background sync
```

function bd(kshetra: Kshetra) {
  const env = { ...process.env, BEADS_DIR: kshetra.beads.path };
  return {
    ready:    ()          => exec('bd', ['ready', '--json'], { env }),
    claim:    (id)        => exec('bd', ['update', id, '--claim'], { env }),
    show:     (id)        => exec('bd', ['show', id, '--json'], { env }),
    prime:    ()          => exec('bd', ['prime'], { env }),
    close:    (id, note)  => exec('bd', ['close', id, note], { env }),
    create:   (t, p, typ) => exec('bd', ['create', t, '-p', p, '-t', typ], { env }),
    remember: (s)         => exec('bd', ['remember', s], { env }),
    addNote:  (id, n)     => exec('bd', ['update', id, '--note', n], { env }),
    flag:     (id, r)     => exec('bd', ['update', id, '--block', r], { env }),
  };
}
```

### 4.5 Activity Log

Every agent event in the Silpi↔Viharapala loop is written to a per-Kshetra JSONL file at `~/.shreni/logs/<kshetra-id>.jsonl`. Each line is a self-contained JSON object with a `ts` timestamp and typed event fields. The file is append-only and survives daemon restarts.

```typescript
// sthapathi/activity-log.ts

export type ActivityEvent =
  | { type: 'task_claimed';    kshetra: string; beadId: string; title: string }
  | { type: 'round_start';     kshetra: string; beadId: string; round: number; agent: 'silpi' | 'viharapala' }
  | { type: 'silpi_done';      kshetra: string; beadId: string; round: number; summary: string; confidence: number; files: string[]; lintPassed: boolean; testsPassed: boolean }
  | { type: 'viharapala_done'; kshetra: string; beadId: string; round: number; verdict: 'APPROVE' | 'REJECT'; score: number; mustFix: string[] }
  | { type: 'task_done';       kshetra: string; beadId: string; title: string; approved: boolean; rounds: number }
  | { type: 'beads_synced';    kshetra: string }
  | { type: 'error';           kshetra: string; beadId?: string; message: string };

export type LoggedEvent = ActivityEvent & { ts: string };

export function emit(event: ActivityEvent): void {
  // mkdirSync + appendFileSync — never throws, never blocks the daemon
}
```

`emit()` is called by `dispatch.ts` at each stage: task claimed, round start (per agent), silpi/viharapala completion, and task done. Errors swallowed — logging must never crash the daemon.

`shreni tail` reads this file using a synchronous polling loop (`readSync` from the last known byte position, every 500ms) and pretty-prints each event. See Section 11.2 for the CLI interface.

### 4.6 E2E Agent Dispatch

```typescript
async function runE2EAgent(kshetra: Kshetra, mergedTask: Task): Promise<void> {
  const personas      = readFile(kshetra, '.shreni/personas.yaml');
  const existingTests = scanTestFiles(kshetra);
  const diff          = await git(kshetra).diffMerged(mergedTask.branch);

  const output: E2EOutput = await callClaude({
    system: buildE2ESystemPrompt(kshetra, personas),
    user:   { task: mergedTask, diff, existingTests }
  });

  // Sthapathi commits test files — E2E agent does not touch git directly
  for (const file of output.testFilesAdded) {
    await git(kshetra).commitFile(file, `e2e: add tests for ${mergedTask.id}`);
  }

  // Sthapathi files coverage gaps — E2E agent never calls bd create
  for (const gap of output.coverageGaps) {
    await bd(kshetra).create(gap.description, gap.priority, 'e2e');
  }

  await syncBeads(kshetra);
}
```

---

## 5. Error Handling and Recovery

### 5.1 Failure Taxonomy

| Failure | Example | Recoverable? | Sthapathi action |
|---|---|---|---|
| Transient API error | Rate limit 429, 529 overloaded, timeout | ✅ Retry with backoff | Retry up to 3× with exponential backoff |
| API hard failure | 400 bad request, invalid key | ❌ Stop | Block bead, alert Vichara, pause Kshetra |
| Malformed agent output | Claude returns truncated or non-JSON | ✅ Retry once | Retry round, escalate after 2 failures |
| Lint / test failure | Silpi self-reports `testsPassed: false` | ✅ Normal flow | Counts as a round, Viharapala not dispatched |
| Git failure | Push rejected, merge conflict | ❌ Stop | Block bead, pause Kshetra, alert Vichara |
| `bd` failure | Database locked, disk full | ❌ Stop | Pause Kshetra, alert Vichara |
| Machine restart | Process killed mid-round | ✅ Resume | Reconstruct state from `bd show` + disk files on startup |

### 5.2 What State Lives Where

The critical design principle: **no essential state lives only in Sthapathi's memory.** Everything needed to resume is on disk or in `bd`.

```
Sthapathi process (ephemeral — lost on crash)
  ├── in-memory Kshetra loop handles
  ├── active bead pointer per Kshetra
  └── current round counter

~/.shreni/registry.json (durable — survives crash)
  └── registered Kshetras and their config paths

~/.shreni/state.json (durable — survives crash)
  └── per-Kshetra pause state and reason

bd / beads repo (durable — survives crash)
  ├── bead status: in_progress / blocked / pending
  ├── round notes: "Round 2: dispatching Silpi"
  ├── all prior agent output as notes
  └── project memory (bd remember entries)

git (durable — survives crash)
  ├── bead branch with all Silpi commits
  └── main branch untouched until approved merge
```

### 5.3 Persistent Registry

`shreni register` writes to `~/.shreni/registry.json`. This is the only thing Sthapathi needs on startup to discover all Kshetras — it reads this file, loads each `kshetra.yaml`, and begins recovery.

```json
// ~/.shreni/registry.json
{
  "kshetras": [
    {
      "id": "sishya",
      "configPath": "/projects/sishya/.shreni/kshetra.yaml",
      "registeredAt": "2026-06-01T10:00:00Z"
    },
    {
      "id": "shreni",
      "configPath": "/projects/shreni/.shreni/kshetra.yaml",
      "registeredAt": "2026-06-01T10:05:00Z"
    }
  ]
}
```

If a `configPath` is missing on startup (project moved or deleted), Sthapathi logs a warning and skips that Kshetra — it does not crash.

### 5.4 Persistent Pause State

Kshetra pause state is written to `~/.shreni/state.json` before any pause takes effect. This ensures a manual pause (from git or `bd` failure) survives a crash and is not accidentally auto-cleared on restart.

```json
// ~/.shreni/state.json
{
  "kshetras": {
    "sishya": {
      "paused": false
    },
    "bms": {
      "paused": true,
      "reason": "git_failed",
      "message": "Push rejected: remote contains work not in local",
      "pausedAt": "2026-06-08T14:30:00Z",
      "requiresManualResume": true
    }
  }
}
```

On startup, Sthapathi reads `state.json` and skips any Kshetra where `paused: true` + `requiresManualResume: true`. The human must still run `shreni resume --kshetra bms` — a crash does not auto-clear a manual pause.

API cooldown pauses (`requiresManualResume: false`) are cleared automatically on restart since the API is likely recovered.

```typescript
// kshetra/state.ts

async function pauseKshetra(
  kshetra: Kshetra,
  opts: { cooldownMs?: number; manual?: boolean; reason: string; message: string }
): Promise<void> {
  const state = await loadState();
  state.kshetras[kshetra.id] = {
    paused: true,
    reason: opts.reason,
    message: opts.message,
    pausedAt: new Date().toISOString(),
    requiresManualResume: opts.manual ?? false,
  };
  await saveState(state);  // writes to disk BEFORE stopping the loop

  if (opts.cooldownMs) {
    setTimeout(() => autoResumeKshetra(kshetra), opts.cooldownMs);
  }
}

async function resumeKshetra(kshetra: Kshetra): Promise<void> {
  const state = await loadState();
  state.kshetras[kshetra.id] = { paused: false };
  await saveState(state);
  scheduleLoop(kshetra);
}
```

### 5.5 Bead State as Recovery Anchor

`bd` task notes are the per-bead state log. The rule: **write to `bd` before the risky operation, not after.**

```typescript
// WRONG — if dispatch crashes, bd still shows previous state
await runSilpi(context);
await bd(kshetra).addNote(task.id, 'Round 1: dispatched');

// CORRECT — bd reflects intent before the operation starts
await bd(kshetra).addNote(task.id, 'Round 1: dispatching Silpi');
await runSilpi(context);   // if this throws, bd shows last known state
```

### 5.6 Startup Sequence

```typescript
// sthapathi/index.ts

async function start(): Promise<void> {

  // 1. Load Kshetras from persistent registry
  const registry = await loadRegistry();           // ~/.shreni/registry.json
  const kshetras = registry.kshetras
    .map(entry => loadKshetraConfig(entry.configPath))
    .filter(k => k !== null);                      // skip missing configs

  // 2. Load pause state from disk
  const state = await loadState();                 // ~/.shreni/state.json

  // 3. Sync beads repos (pull any tasks filed while down)
  for (const k of kshetras) {
    try {
      await syncBeads(k);
    } catch (err) {
      log.warn(`Sync failed for ${k.id} on startup: ${err.message}`);
      // Non-fatal — continue with local state
    }
  }

  // 4. Recover in-flight tasks for each running Kshetra
  for (const k of kshetras) {
    const kshetraState = state.kshetras[k.id];

    if (kshetraState?.paused && kshetraState.requiresManualResume) {
      log.info(`Skipping ${k.id} — manually paused (${kshetraState.reason})`);
      continue;
    }

    // Clear API cooldown pauses — API likely recovered
    if (kshetraState?.paused && !kshetraState.requiresManualResume) {
      await resumeKshetra(k);
    }

    await recoverKshetra(k);
  }

  // 5. Start main polling loop for all recovered Kshetras
  for (const k of kshetras) {
    const s = state.kshetras[k.id];
    if (!s?.paused) scheduleLoop(k);
  }
}
```

### 5.7 In-Flight Task Recovery

```typescript
async function recoverKshetra(kshetra: Kshetra): Promise<void> {
  const inFlight = await bd(kshetra).list({ status: 'in_progress' });

  for (const task of inFlight) {
    const lastNote  = parseLastNote(task.notes);
    const branch    = `bead-${task.id}/${task.slug}`;
    const hasBranch = await git(kshetra).branchExists(branch);

    log.info(`Recovery [${kshetra.id}]: ${task.id} — "${lastNote}"`);

    // Crashed before branch was created
    if (lastNote.includes('claiming') && !hasBranch) {
      await git(kshetra).createBranch(task);
      scheduleResume(kshetra, task, 'silpi');
    }

    // Crashed while Silpi was running
    else if (lastNote.includes('dispatching Silpi')) {
      await bd(kshetra).addNote(task.id,
        `Round ${task.round}: resuming Silpi after restart`
      );
      scheduleResume(kshetra, task, 'silpi');
    }

    // Silpi finished, crashed before Viharapala dispatched
    else if (lastNote.includes('Silpi submitted')) {
      await bd(kshetra).addNote(task.id,
        `Round ${task.round}: resuming at Viharapala after restart`
      );
      const silpiOut = await reconstructSilpiOutput(kshetra, task);
      scheduleResume(kshetra, task, 'viharapala', { silpiOut });
    }

    // Crashed while Viharapala was running
    else if (lastNote.includes('dispatching Viharapala')) {
      await bd(kshetra).addNote(task.id,
        `Round ${task.round}: resuming Viharapala after restart`
      );
      const silpiOut = await reconstructSilpiOutput(kshetra, task);
      scheduleResume(kshetra, task, 'viharapala', { silpiOut });
    }

    // Viharapala approved — crashed before or during merge
    else if (lastNote.includes('APPROVE')) {
      const alreadyMerged = await git(kshetra).isAncestor(branch, 'main');
      if (alreadyMerged) {
        // Merge done, bd close didn't run — just close it
        await bd(kshetra).close(task.id, 'Recovered: merged before crash');
        await syncBeads(kshetra);
      } else {
        // Merge didn't happen — redo from approval
        scheduleResume(kshetra, task, 'merge');
      }
    }

    // Was paused waiting for API — retry
    else if (lastNote.includes('Paused: API unavailable')) {
      scheduleResume(kshetra, task, 'silpi');
    }

    // Already blocked/failed — leave for human
    else {
      log.info(`Recovery: ${task.id} is blocked/failed, skipping`);
    }
  }
}

// Silpi output is recoverable from the branch diff + bd notes
async function reconstructSilpiOutput(
  kshetra: Kshetra,
  task: Task
): Promise<SilpiOutput> {
  const diff  = await git(kshetra).branchDiff(`bead-${task.id}`);
  const notes = parseRoundNotes(task.notes);
  return reconstructFromDiffAndNotes(diff, notes);
}
```

### 5.8 Retry Strategy

```typescript
// sthapathi/retry.ts

const AGENT_RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 5_000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  retryableStatuses: [429, 502, 503, 529],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
};

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  config = AGENT_RETRY_CONFIG
): Promise<T> {
  let attempt = 0;
  let delay = config.initialDelayMs;

  while (attempt < config.maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        config.retryableStatuses.includes(err.status) ||
        config.retryableErrors.some(e => err.message?.includes(e));

      if (!isRetryable || attempt >= config.maxAttempts) throw err;

      log.warn(`${label} attempt ${attempt} failed (${err.message}). Retry in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }
  throw new Error(`${label} exhausted ${config.maxAttempts} attempts`);
}
```

### 5.9 Agent Dispatch With Error Handling

```typescript
// sthapathi/dispatch.ts

async function runSilpiSafe(
  kshetra: Kshetra, task: Task, context: AgentContext, round: number
): Promise<SilpiOutput> {

  await bd(kshetra).addNote(task.id, `Round ${round}: dispatching Silpi`);

  try {
    const raw    = await withRetry(`Silpi r${round}`, () => callClaude(buildSilpiPrompt(context)));
    const output = parseSilpiOutput(raw);     // throws ParseError if invalid
    await bd(kshetra).addNote(task.id, `Round ${round}: Silpi submitted`);
    return output;

  } catch (err) {
    if (err instanceof ParseError) {
      await bd(kshetra).addNote(task.id, `Round ${round}: Silpi output malformed — ${err.message}`);
      throw new AgentError('MALFORMED_OUTPUT', { task, round, cause: err });
    }
    await bd(kshetra).addNote(task.id, `Round ${round}: Silpi failed after retries — ${err.message}`);
    throw new AgentError('API_FAILURE', { task, round, cause: err });
  }
}

async function runViharapalaSafe(
  kshetra: Kshetra, task: Task, context: AgentContext, silpiOut: SilpiOutput, round: number
): Promise<ViharapalaOutput> {

  await bd(kshetra).addNote(task.id, `Round ${round}: dispatching Viharapala`);

  try {
    const raw    = await withRetry(`Viharapala r${round}`, () => callClaude(buildViharapalaPrompt(context, silpiOut, round)));
    const output = parseViharapalaOutput(raw);
    await bd(kshetra).addNote(task.id, `Round ${round}: ${output.verdict}`);
    return output;

  } catch (err) {
    if (err instanceof ParseError) {
      await bd(kshetra).addNote(task.id, `Round ${round}: Viharapala output malformed — ${err.message}`);
      throw new AgentError('MALFORMED_OUTPUT', { task, round, cause: err });
    }
    await bd(kshetra).addNote(task.id, `Round ${round}: Viharapala failed after retries — ${err.message}`);
    throw new AgentError('API_FAILURE', { task, round, cause: err });
  }
}
```

### 5.10 Top-Level Cycle Error Handler

```typescript
async function handleCycleError(
  kshetra: Kshetra, task: Task | null, err: Error
): Promise<void> {

  switch (classifyError(err)) {

    case 'API_DOWN':
      if (task) await bd(kshetra).addNote(task.id,
        `Paused: API unavailable — ${err.message}. Will retry.`
      );
      await pauseKshetra(kshetra, {
        reason: 'api_down', message: err.message,
        cooldownMs: 5 * 60 * 1000                 // auto-resumes after 5 min
      });
      await notifyVichara(kshetra, task, 'api_down');
      break;

    case 'AGENT_FAILED':
      // Block bead — Kshetra continues with next task
      if (task) {
        await bd(kshetra).flag(task.id, `Agent failed: ${err.message}`);
        await syncBeads(kshetra);
      }
      await notifyVichara(kshetra, task, 'agent_failed');
      break;

    case 'MALFORMED_OUTPUT':
      if (task) {
        await bd(kshetra).flag(task.id, `Malformed output after retries: ${err.message}`);
        await syncBeads(kshetra);
      }
      await notifyVichara(kshetra, task, 'agent_failed');
      break;

    case 'GIT_FAILED':
      if (task) {
        await bd(kshetra).flag(task.id, `Git failure: ${err.message}. Branch kept.`);
        await syncBeads(kshetra);
      }
      await pauseKshetra(kshetra, {
        reason: 'git_failed', message: err.message,
        manual: true                               // requires shreni resume
      });
      await notifyVichara(kshetra, task, 'git_failed');
      break;

    case 'BD_FAILED':
      await pauseKshetra(kshetra, {
        reason: 'bd_failed', message: err.message,
        manual: true
      });
      await notifyVichara(kshetra, null, 'bd_failed');
      break;

    default:
      if (task) {
        await bd(kshetra).flag(task.id, `Unexpected error: ${err.message}`);
        await syncBeads(kshetra);
      }
      await notifyVichara(kshetra, task, 'unknown_error');
  }
}
```

### 5.11 Bead State After Each Failure Scenario

| Scenario | Bead status | Branch | Kshetra | `state.json` | Next action |
|---|---|---|---|---|---|
| API rate limit, retries succeed | `in_progress` | Alive | Running | unchanged | Continues normally |
| API down, retries exhausted | `in_progress` + note | Alive | Paused 5 min | `paused: true, requiresManualResume: false` | Auto-resumes after cooldown |
| Malformed output, retried | `in_progress` + note | Alive | Running | unchanged | Sthapathi retries round |
| Malformed output, 2nd failure | `blocked` + note | Alive | Running | unchanged | Human: `bd update --unblock` |
| Agent hard failure | `blocked` + note | Alive | Running | unchanged | Human: `bd update --unblock` |
| Git failure | `blocked` + note | Alive | Paused (manual) | `paused: true, requiresManualResume: true` | Human fixes, `shreni resume` |
| `bd` failure | unchanged | unchanged | Paused (manual) | `paused: true, requiresManualResume: true` | Human fixes, `shreni resume` |
| Sthapathi crash mid-round | `in_progress` + note | Alive | Recovers on restart | auto-cleared if API cooldown | Re-runs current round |
| Sthapathi crash post-approve | `in_progress` + note | Alive | Recovers on restart | unchanged | Re-checks merge, closes bead |
| Max rounds exceeded | `blocked` + note | Alive | Running | unchanged | Human reviews, `bd update --unblock` |

> **Branch retention:** Bead branches are never deleted on failure. They are kept for human inspection. Cleanup is a manual `git branch -d` after the human resolves the block.

> **Blocked beads do not require `shreni resume`.** `shreni resume` is only for Kshetra-level pauses caused by git or `bd` failures. For a blocked bead, Sthapathi keeps running and picks up the next pending task automatically. The human unblocks via `bd update --unblock` when ready.

### 5.12 Human Recovery via CLI

```bash
# Inspect what failed and why
shreni status --kshetra sishya
shreni logs --kshetra sishya --bead bd-f3a2
bd show bd-f3a2              # full round notes and error detail

# Resume a Kshetra paused by git or bd failure
shreni resume --kshetra sishya

# Unblock a bead and let Sthapathi retry it
# (no shreni command needed — bd is enough)
bd update bd-f3a2 --unblock
```

### 5.13 Git Conflict Handling

Merge failures are a distinct failure class with their own response strategy. The goal is to auto-resolve as many cases as possible before escalating to human.

#### Failure Scenarios

| Scenario | Sthapathi action | Bead | Kshetra |
|---|---|---|---|
| Dirty working tree on `main` | Pre-flight fails, task never claimed | `pending` (untouched) | Running |
| `main` moved since branch cut | Rebase attempt before merge | `in_progress` | Running |
| Rebase succeeds | Merge proceeds normally | → `complete` | Running |
| Rebase fails, conflict in task files, rounds remain | Re-dispatch Silpi with conflict context | `in_progress` + note | Running |
| Rebase fails, conflict outside task scope | Block bead, pause Kshetra | `blocked` + note | Paused (manual) |
| Push rejected (non-fast-forward) | Pull-rebase and retry once | `in_progress` | Running |
| Push rejected twice | Block bead, pause Kshetra | `blocked` + note | Paused (manual) |

#### Pre-Flight Check (before `bd claim`)

Sthapathi verifies `main` is clean before creating a branch. If this fails, the task is never claimed — it stays `pending` and is retried next cycle.

```typescript
// sthapathi/git.ts

async function preFlightCheck(kshetra: Kshetra): Promise<void> {
  const repo = kshetra.repo.path;
  await git(repo).checkout('main');

  const status = await git(repo).status();
  if (status.modified.length > 0 || status.staged.length > 0) {
    throw new GitError('DIRTY_WORKING_TREE',
      `Uncommitted changes on main: ${status.modified.join(', ')}`
    );
  }

  // Pull latest main before branching so Silpi starts from current state
  await git(repo).pull('--rebase', 'origin', 'main');
}
```

`preFlightCheck` is called before `bd.claim()` in the main cycle:

```typescript
async function runCycle(kshetra: Kshetra): Promise<void> {
  await syncBeads(kshetra);
  const tasks = await bd(kshetra).ready();
  if (tasks.length === 0) return;

  const task = pickNext(tasks);

  await preFlightCheck(kshetra);   // ← fails here = task stays pending, no bd state touched
  await bd(kshetra).claim(task.id);
  // ...
}
```

#### Safe Merge (rebase + conflict detection + push retry)

```typescript
async function safeMerge(kshetra: Kshetra, task: Task, branch: string): Promise<void> {

  // 1. Fetch latest main
  await git(kshetra).fetch('origin', 'main');

  // 2. If main has moved, rebase branch onto it before merging
  const mainAhead = await git(kshetra).revsBetween(branch, 'origin/main');
  if (mainAhead.length > 0) {
    await rebaseBranchOnMain(kshetra, task, branch);
  }

  // 3. Dry-run conflict check before committing
  const conflicts = await git(kshetra).mergeTree(branch, 'main');
  if (conflicts.length > 0) {
    await handleMergeConflict(kshetra, task, branch, conflicts);
    return;
  }

  // 4. Squash merge and push
  await git(kshetra).checkout('main');
  await git(kshetra).merge('--squash', branch);
  await git(kshetra).commit(`bead-${task.id}: ${task.title}`);
  await safePush(kshetra, task);
}

async function rebaseBranchOnMain(
  kshetra: Kshetra, task: Task, branch: string
): Promise<void> {
  await bd(kshetra).addNote(task.id,
    'main has new commits — attempting rebase before merge'
  );
  try {
    await git(kshetra).checkout(branch);
    await git(kshetra).rebase('origin/main');
    await git(kshetra).checkout('main');
    await bd(kshetra).addNote(task.id, 'rebase onto main succeeded');
  } catch (err) {
    await git(kshetra).rebase('--abort');
    await git(kshetra).checkout('main');
    throw new GitError('REBASE_FAILED', err.message);
  }
}

async function safePush(kshetra: Kshetra, task: Task): Promise<void> {
  try {
    await git(kshetra).push('origin', 'main');
  } catch (pushErr) {
    if (!pushErr.message.includes('non-fast-forward')) throw pushErr;

    // main moved between merge and push — pull-rebase and retry once
    await bd(kshetra).addNote(task.id,
      'push rejected (non-fast-forward) — pull-rebase and retrying'
    );
    try {
      await git(kshetra).pull('--rebase', 'origin', 'main');
      await git(kshetra).push('origin', 'main');
    } catch (retryErr) {
      throw new GitError('PUSH_FAILED',
        `Push failed after rebase retry: ${retryErr.message}`
      );
    }
  }
}
```

#### Merge Conflict — Diagnose Before Blocking

When a conflict is unavoidable, Sthapathi distinguishes between Silpi drifting outside scope vs a legitimate collision within task files:

```typescript
async function handleMergeConflict(
  kshetra: Kshetra, task: Task, branch: string, conflictedFiles: string[]
): Promise<void> {

  const taskFiles  = task.context.relatedFiles;
  const outOfScope = conflictedFiles.filter(f => !taskFiles.includes(f));

  if (outOfScope.length > 0) {
    // Silpi touched files outside task scope — human must review
    await bd(kshetra).flag(task.id,
      `Merge conflict in files outside task scope: ${outOfScope.join(', ')}. ` +
      `Silpi may have drifted. Branch kept for inspection.`
    );
    await pauseKshetra(kshetra, {
      reason: 'git_failed', manual: true,
      message: `Out-of-scope conflict: ${outOfScope.join(', ')}`
    });
    await notifyVichara(kshetra, task, 'merge_conflict_out_of_scope');
    return;
  }

  // All conflicts within task scope — legitimate collision
  // Re-dispatch Silpi with conflict context if rounds remain
  if (task.round < kshetra.agents.maxRoundsPerBead) {
    await bd(kshetra).addNote(task.id,
      `Merge conflict in task files — re-dispatching Silpi with conflict context. ` +
      `Conflicted: ${conflictedFiles.join(', ')}`
    );
    // Conflict context is injected into Silpi's next prompt
    // Silpi is told to resolve the conflict with the current main state
    scheduleResumeWithConflictContext(kshetra, task, conflictedFiles);
  } else {
    await bd(kshetra).flag(task.id,
      `Merge conflict after max rounds: ${conflictedFiles.join(', ')}`
    );
    await pauseKshetra(kshetra, {
      reason: 'git_failed', manual: true,
      message: `Unresolved merge conflict: ${conflictedFiles.join(', ')}`
    });
    await notifyVichara(kshetra, task, 'merge_conflict');
  }
}
```

---

## 6. Agent Design

### 6.1 Silpi System Prompt

```
You are Silpi, a coding agent for the {kshetra.name} project.

== SKILLS ==
{universal skills from ~/.shreni/skills/}
{CLAUDE.md — project skills}
{scoped CLAUDE.md files for related directories}

== PROJECT MEMORY ==
{bd prime output — injected by Sthapathi}

== TASK ==
{bd show <id> output — injected by Sthapathi}

== PRIOR FEEDBACK (Round {n}) ==
{viharapala must-fix list from last round, if any}

== CONVENTIONS ==
{style-guide.md}

== ARCHITECTURE ==
{arch.md}

== RELEVANT CODE ==
{RAG chunks: top-10 relevant file sections}

== ROLE BOUNDARY ==
Your job is to write code and return a SilpiOutput JSON object.
You do NOT call bd commands or manage task state — Sthapathi handles
all of that. Any project insights you discover should go in the
`insights` field of your output; Sthapathi will persist them.
Do NOT call bd, git, or any shell commands outside of running
lint and tests on the code you write.

== INSTRUCTIONS ==
1. Implement the task to satisfy all acceptance criteria.
2. Write unit tests. Run lint and tests.
3. If tests fail, fix them before submitting.
4. Respond ONLY with a JSON SilpiOutput object.
```

### 6.2 Viharapala System Prompt

```
You are Viharapala, a code reviewer for the {kshetra.name} project.

== SKILLS ==
{universal skills}
{CLAUDE.md}
{scoped CLAUDE.md files}

== PROJECT MEMORY ==
{bd prime output — injected by Sthapathi}

== TASK AND ACCEPTANCE CRITERIA ==
{bd show <id> output — injected by Sthapathi}

== SILPI'S OUTPUT (Round {n}) ==
{SilpiOutput JSON}

== FULL ROUND HISTORY ==
{all prior round notes — injected by Sthapathi from bd show}

== REVIEW DIMENSIONS ==
1. Correctness: Does code satisfy all acceptance criteria?
2. Test coverage: Are edge cases covered? Do tests test behavior?
3. Code quality: Patterns, readability, potential bugs, security.
4. Side effects: Regressions, breaking interface changes.
5. Completeness: No TODOs, no half-done work.

== ROLE BOUNDARY ==
Your job is to review code and return a ViharapalaOutput JSON object.
You do NOT call bd commands or manage task state — Sthapathi handles
all of that. Any project insights you discover should go in the
`insights` field of your output; Sthapathi will persist them.
Minor issues do not block approval. Only raise REJECT for blockers.

Respond ONLY with a JSON ViharapalaOutput object.
```

---

## 7. Interactive Claude Code Integration

Interactive Claude Code sessions serve a distinct role in the Shreni workflow: **discuss features and file tasks, never implement**.

### 7.1 What `bd setup claude` Installs

`bd setup claude` (run during `shreni init-kshetra`) installs hooks into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": ["bd prime"],
    "PreCompact": ["bd prime"]
  }
}
```

- **`SessionStart`:** runs `bd prime` automatically when a Claude Code session starts in the project. Injects pending tasks, project memory, and `bd` workflow context (~1-2k tokens).
- **`PreCompact`:** runs `bd prime` before context compaction so task awareness survives long sessions.

These hooks fire for **interactive sessions only** — they have no role in Sthapathi's automated workflow. Sthapathi calls `bd prime` explicitly in `buildAgentContext()`.

### 7.2 CLAUDE.md — SHRENI INTEGRATION Section

`shreni init-kshetra` appends a SHRENI INTEGRATION section to `CLAUDE.md` that defines the interactive session's role boundary:

```markdown
## SHRENI INTEGRATION

This project is managed by Shreni, an automated code development harness.

### Your role in this project
You are a **task producer**, not an implementor. Your job is to:
- Answer questions about the codebase and architecture
- Discuss and clarify feature requirements
- Decompose features into atomic bd tasks with clear acceptance criteria
- File tasks via `bd create` and link dependencies via `bd dep add`
- Check task status via `bd show`, `bd ready`, and `bd prime`

### What you must NOT do
- Implement features or write production code to the main branch
- Call `bd update --claim` or `bd close` — Sthapathi owns task state transitions
- Create git branches or merge code — Sthapathi owns the git workflow
- Run Sthapathi's agents or trigger the automated workflow

### Filing a task
When a feature is agreed, file it as:
```
bd create "title" -p <0|1|2> --description "acceptance criteria"
bd dep add <child-id> <parent-id>   # if dependencies exist
```

Keep tasks atomic — one clear outcome, testable acceptance criteria.
Sthapathi picks them up automatically within 30 seconds.
```

### 7.3 What Interactive Claude Code Can Do

```bash
# Discuss and understand the project
bd prime                           # load project context
bd show bd-f3a2                    # understand a specific task
bd ready                           # see what's pending

# File new tasks
bd create "Bulk CSV import" -p 1 --description "per-row errors, upsert on duplicate"
bd create "CSV parser" -p 1        # sub-task
bd dep add <csv-parser-id> <bulk-import-id>

# File bugs
bd create "Timer not stopping" -p 0 -t bug

# Query and discuss
bd ready --json                    # what's in the queue
bd show <id>                       # task detail
```

### 7.4 What Interactive Claude Code Must NOT Do

```bash
# These are Sthapathi-only — never call from interactive session
bd update <id> --claim             # ❌ task state transition
bd close <id>                      # ❌ task state transition
git checkout -b bead-*/            # ❌ Sthapathi owns branches
git merge                          # ❌ Sthapathi owns merges
```

---

## 8. Vichara — Server Design

### 8.1 Server Stack

| Layer | Technology |
|---|---|
| HTTP / WebSocket server | Fastify + `@fastify/websocket` |
| Streaming to client | WebSocket — SSE-style token streaming |
| LLM calls | `claude` CLI agentic loop — print mode + `stream-json`, spawned per turn |
| LLM auth | CLI subscription/OAuth session — **no `ANTHROPIC_API_KEY`** |
| RAG index | LanceDB (local, no server) |
| Embedding model | `voyage-code-3` via Anthropic API |
| PWA frontend | React + Tailwind, Vite build |
| WS auth | Shared secret token (Tailscale-only, not public) |
| Mobile connectivity | Tailscale — machine accessible as `shreni.local` |

### 8.2 Tool Registry

Vichara has **no custom function tools**. The `claude` CLI drives its own
agentic loop with native tools and an `--allowedTools` allowlist; the read/write
boundary is enforced by that allowlist (the harness), not by which tools we
define. Writes never route through a Sthapathi internal API — the agent shells
out to `bd` directly — but `bd update --claim` and `bd close` are never
allowlisted, so state transitions stay Sthapathi-only.

The allowlist lives in `vichara/agent.ts` as `VICHARA_ALLOWED_TOOLS`.

**Phase 10 — read-only (shipped):**

| Tool / command | Purpose |
|---|---|
| `Read`, `Grep`, `Glob` | Read and search files in the active Kshetra repo |
| `Bash(bd list/ready/show/blocked/stats/search/memories/stale/orphans:*)` | Inspect issues and backlog (read-only subcommands only) |
| `Bash(git log/diff/status/show/branch:*)` | Inspect history and branch diffs |
| `Bash(ls/cat:*)` | Filesystem inspection |

> Note: the allowlist scopes individual `bd` subcommands, **not** `Bash(bd:*)` —
> a coarse `bd` allow would let `bd create`/`update`/`close` through and break
> the read-only boundary.

**Phase 11 — write (planned):** extend `VICHARA_ALLOWED_TOOLS` with filing
subcommands only, gated by in-chat confirmation:

| Command added | Purpose |
|---|---|
| `bd create` (incl. `-t bug`) | File new task / bug bead — agent proposes, user confirms (P0 bug files immediately, confirms after) |
| add-note subcommand | Add a comment to an existing bead |
| flag/block subcommand | Flag a bead as blocked with reason |

> `--claim` and `--close` are deliberately excluded from any allowlist pattern.

### 8.3 Context Injection Per Request

`buildVicharaSystemPrompt` (in `vichara/prompt.ts`) builds the `--system-prompt`
passed to the CLI each turn. It injects the registered Kshetras with live
paused/active state, the active project + stack, and the role boundary. The
boundary text is belt-and-suspenders — the real enforcement is the
`--allowedTools` allowlist — and instructs the agent to fetch fresh state via
its read-only tools rather than guessing.

```typescript
function buildVicharaSystemPrompt(ctx: VicharaContext): string {
  // ctx = { activeKshetra, allKshetras, currentTime }
  // sections:
  //   - "You are Vichara, the read-only observer interface…" + current time
  //   - == REGISTERED KSHETRAS ==  (each with active/paused state + repo path)
  //   - == ACTIVE PROJECT ==       (id, name, stack, path) when a Kshetra is active
  //   - == ROLE BOUNDARY ==        read-only; never create/update/close beads,
  //                                 never trigger runs, never modify files/git.
  //                                 Lists the read-only bd/git + Read/Grep/Glob tools.
  return sections.join('\n\n');
}
```

The turn itself is executed by `runVicharaTurn(opts, events)` in
`vichara/agent.ts`, which spawns the CLI (`buildVicharaSpawnArgs`) and maps
`stream-json` lines to `text` / `toolUse` / `toolResult` / `error` / `done`
events forwarded over the WebSocket. Spawn flags of note:
`-p --output-format stream-json --verbose`, `--no-session-persistence`,
`--setting-sources ''` (ignore user/project settings), `--permission-mode
default`, and `--allowedTools <VICHARA_ALLOWED_TOOLS>`.

### 8.4 PWA — Mobile UI Spec

| Element | Specification |
|---|---|
| Status strip | Top bar: Kshetra name, active agent, current bead ID, round number. Updates via WebSocket push. |
| Project selector | Dropdown to switch Kshetra context. `@mention` syntax also works inline. |
| Chat thread | Streamed responses. Markdown rendered. Code blocks monospaced. |
| Quick action chips | Contextual buttons after assistant messages: Bug, New Task, Show Diff, Show Status. |
| Input bar | Text + voice (Web Speech API). Mic button for hands-free capture. |
| Offline queue | Bugs composed offline saved to IndexedDB, synced on reconnect. |
| Install prompt | PWA manifest configured for Add to Home Screen on iOS and Android. |

---

## 9. RAG Index Design

### 9.1 Storage

Each Kshetra has a LanceDB vector index stored at `~/.shreni/indexes/<kshetra-id>/`. LanceDB is embedded (no server), written as Arrow files, queryable from Node.js.

### 9.2 Chunk Schema and Strategy

```typescript
interface CodeChunk {
  kshetraId:  string;
  filePath:   string;
  startLine:  number;
  endLine:    number;
  content:    string;
  symbols:    string[];       // function/class names in chunk
  embedding:  Float32Array;   // 1024-dim, voyage-code-3
}

// Chunking:  200-line overlapping windows, split at function/class boundaries
// Embedding: voyage-code-3 (Anthropic) — 1024 dimensions
// Rebuild:   initial registration + incremental on every merged bead
```

### 9.3 Rebuild Triggers

- **Full rebuild:** on first Kshetra registration and on manual `shreni index rebuild --kshetra <id>`.
- **Incremental:** after each merge, only files changed in the merged bead are re-embedded.
- Incremental runs async in Sthapathi after `git merge` — never blocks the agent loop.
- Index is evicted from memory when Kshetra has no active tasks; reloaded on next query.

---

## 10. Git Operations

### 10.1 Branch Lifecycle

| Event | Git Operation |
|---|---|
| Pre-flight check | `git status` + `git pull --rebase origin main` — before `bd claim` |
| Task claimed | `git checkout -b bead-{id}/{slug}` from `main` |
| Silpi submits (each round) | `git add -A && git commit -m 'silpi: round {n} — {title}'` |
| Viharapala rejects | Silpi continues on same branch; adds fixup commits |
| Viharapala approves | fetch + rebase check + `git merge --squash bead-{id}/{slug}` |
| Merge committed | `git commit -m 'bead-{id}: {title}'` |
| Push | `git push origin main` with pull-rebase retry on rejection |
| Branch cleanup (success only) | `git branch -d bead-{id}/{slug} && git push origin --delete bead-{id}/{slug}` |
| Branch on failure | Kept alive — never deleted on error |

> **Squash merge rationale:** All round iterations are squashed into a single clean commit on `main`. The full round history is preserved in the `bd` bead record, not in git history.

### 10.2 Merge Safety Functions

The full merge flow is handled by three functions in `sthapathi/git.ts`. See Section 5.13 for implementation details.

| Function | Purpose |
|---|---|
| `preFlightCheck()` | Verifies `main` is clean and pulls latest before branching. Called before `bd claim` — failure leaves bead `pending`. |
| `rebaseBranchOnMain()` | Rebases bead branch onto `origin/main` when main has moved. Aborts cleanly on conflict. |
| `safeMerge()` | Orchestrates: fetch → rebase if needed → dry-run conflict check → squash merge → `safePush`. |
| `safePush()` | Pushes to `origin/main`. On non-fast-forward rejection: pull-rebase and retry once. |
| `handleMergeConflict()` | Diagnoses conflict scope. Out-of-scope → block + pause. In-scope + rounds remain → re-dispatch Silpi with conflict context. |

### 10.3 Conflict Prevention

- `maxConcurrentBeads: 1` per Kshetra — only one branch active at a time, eliminating most inter-bead conflicts.
- Pre-flight pulls latest `main` before each branch, minimising the window for divergence.
- Beads repo uses `git pull --rebase` before every write to handle concurrent `bd create` from phone/CLI/interactive Claude Code.
- Sthapathi is the sole caller of `bd update --claim` and `bd close` — no concurrent state transition conflicts.

---

## 11. `shreni` CLI

The `shreni` CLI controls the harness — Kshetras, agents, workflow, RAG, and Vichara. It does not manage tasks; use `bd` directly for all task operations.

### 11.1 Installation

```bash
cd /projects/shreni
pnpm install && pnpm build
pnpm install -g .   # or: npm install -g . (engine warning is harmless)
```

### 11.2 Command Reference

#### Kshetra Management

```bash
shreni init-kshetra --slug sishya --path /projects/sishya [--beads-path /projects/sishya-issues]
# 1. Creates TeakWood/sishya-beads on GitHub     ← skipped if --beads-path exists on disk
# 2. Clones to /projects/sishya-beads             ← skipped if --beads-path exists on disk
# 3. BEADS_DIR=... bd init --stealth              ← skipped if embeddeddolt/ already present
# 4. Creates symlink: /projects/sishya/.beads → /projects/sishya-beads
#    (fails with clear message if .beads already exists as a directory, not a symlink)
# 5. Appends .beads to /projects/sishya/.gitignore
# 6. BEADS_DIR=... bd setup claude
#    (installs SessionStart/PreCompact hooks for interactive Claude Code)
# 7. Generates kshetra.yaml from template
# 8. Appends SHRENI INTEGRATION section to CLAUDE.md
# 9. Builds initial RAG index
# 10. Registers Kshetra with Sthapathi

# --beads-path: use an existing local beads repo instead of creating a new one.
# When the path exists, steps 1-3 are skipped; the remote URL is read from the
# existing repo's git origin for inclusion in kshetra.yaml.

shreni register /projects/sishya   # register already-initialised project
shreni list                        # all registered Kshetras + status
shreni status                      # current Kshetra (auto-detected from cwd)
shreni status --all
```

#### Workflow Control

```bash
shreni start                       # start Sthapathi loop
shreni stop                        # graceful shutdown
shreni pause --kshetra sishya
shreni resume --kshetra sishya
shreni run --kshetra sishya        # force one cycle immediately
shreni sync --kshetra sishya       # force beads git pull + push
shreni sync --all
```

#### Agent Inspection

```bash
shreni agents                      # what each agent is doing right now
shreni logs --kshetra sishya
shreni logs --kshetra sishya --bead bd-f3a2
shreni logs --all

# Live streaming of agent events (task claimed, silpi/viharapala rounds, verdicts)
shreni tail --kshetra sishya       # stream events for one Kshetra
shreni tail --all                  # stream events for all Kshetras
# Reads ~/.shreni/logs/<id>.jsonl — prints history then follows new events (Ctrl+C to stop)
```

#### RAG Index

```bash
shreni index rebuild
shreni index rebuild --kshetra sishya
shreni index rebuild --all
shreni index status
```

#### Vichara

```bash
shreni vichara start
shreni vichara stop
shreni vichara status
```

#### Skills

```bash
shreni skills list
shreni skills add <path-or-url>
shreni skills remove <name>
```

### 11.3 What `shreni` Does NOT Do

These remain `bd` commands — never exposed through `shreni`:

```bash
bd create "title" -p 0 -t bug   # file tasks (human, Vichara, or interactive Claude Code)
bd ready                         # list ready tasks
bd show <id>                     # view task detail
bd update <id> --claim           # claim a task (Sthapathi only)
bd close <id> "note"             # close a task (Sthapathi only)
bd remember "insight"            # store memory (Sthapathi only, on behalf of agents)
bd prime                         # print project context
bd dep add <child> <parent>      # link tasks
bd dolt push / pull              # sync beads database
```

---

## 12. Security Model

- Shreni is a local-only system. Vichara is not exposed to the public internet.
- Tailscale provides the only remote access path — device-level authentication.
- A shared secret token (set at `shreni init` time) is required for all Vichara API calls.
- The Anthropic API key is stored in the local environment (`ANTHROPIC_API_KEY`) and never committed.
- GitHub access uses SSH keys — no HTTPS tokens stored on disk.
- Agent prompts explicitly prohibit calling `bd`, `git`, or shell commands outside lint/test execution.

---

## 13. Recommended Build Sequence

| Phase | Deliverable |
|---|---|
| **Phase 1: Foundation** | `kshetra.yaml` schema, `bd` wrapper (`beads.ts`), git helpers, `syncBeads`. Manually verify `bd` commands work with `BEADS_DIR` scoping. |
| **Phase 2: Sthapathi core** | Main loop, task polling, `bd claim`, branch creation, Silpi dispatch (hardcoded prompt). First automated bead closure with `bd close`. |
| **Phase 3: Review loop** | Viharapala integration, round counter, APPROVE/REJECT, `bd addNote` per round, squash merge. |
| **Phase 4: Error handling** | `withRetry`, `handleCycleError`, `recoverKshetra` on startup. `registry.json` and `state.json` persistence. All failure scenarios from Section 5.11 covered. |
| **Phase 5: shreni CLI** | `shreni start/stop/status/agents/logs/resume`. Sthapathi controllable from terminal. `shreni init-kshetra` including `bd setup claude` and SHRENI INTEGRATION in `CLAUDE.md`. |
| **Phase 6: Interactive Claude Code** | Verify `SessionStart` hook fires `bd prime`. Test filing a task from Claude Code and confirming Sthapathi picks it up. |
| **Phase 7: E2E agent** | Async post-merge dispatch, Sthapathi commits test files, Sthapathi files coverage gap beads. |
| **Phase 8: Multi-Kshetra** | Kshetra registry, `BEADS_DIR` scoping per Kshetra, cross-project status via `shreni status --all`. |
| **Phase 9: RAG** | LanceDB indexing, incremental rebuild on merge, `shreni index rebuild`. Codebase search available to agents. |
| **Phase 10: Vichara read** | Fastify server, WebSocket, `claude` CLI agentic loop with read-only allowlist (`Read`/`Grep`/`Glob` + read-only `bd`/`git`). PWA shell. `shreni vichara start` works. |
| **Phase 11: Vichara write** | Extend the allowlist with `bd create` + note/flag, gated by in-chat confirmation flow. Bug filing from phone works end to end. |
