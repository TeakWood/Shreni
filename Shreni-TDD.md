# Shreni — Technical Design Document

> Automated Code Development Harness  
> Version 1.0 · June 2026 · TeakWood  
> Confidential — Internal Use Only

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Repository Structure](#2-repository-structure)
3. [Data Models](#3-data-models)
4. [Sthapathi — Orchestrator Design](#4-sthapathi--orchestrator-design)
5. [Agent Design](#5-agent-design)
6. [Vichara — Server Design](#6-vichara--server-design)
7. [RAG Index Design](#7-rag-index-design)
8. [Git Operations](#8-git-operations)
9. [shreni CLI](#9-shreni-cli)
10. [Security Model](#10-security-model)
11. [Recommended Build Sequence](#11-recommended-build-sequence)

---

## 1. System Overview

Shreni is a locally-hosted multi-agent code development harness. This document describes the technical design: module boundaries, data models, inter-agent communication, storage, and the runtime topology on a developer's machine.

The system is built with **TypeScript/Node.js** for the Sthapathi orchestrator and Vichara server. Agents invoke **Claude Sonnet 4** via the Anthropic API. Task storage uses **`bd` (Beads)** — a Dolt-powered embedded CLI tool. All project repos and beads repos are hosted on `github.com/TeakWood/`.

### Command Boundary

Two CLI tools, distinct responsibilities, no overlap:

| CLI | Owns |
|---|---|
| `bd` | All task operations — create, claim, close, show, remember, dep, prime |
| `shreni` | Harness operations — Kshetra management, agent control, workflow, RAG, Vichara |

`shreni` never wraps or proxies `bd` commands. If you need to manage tasks, use `bd` directly.

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
│   └── dispatch.ts     # Agent session builder
├── agents/
│   ├── silpi.ts        # Coding agent session
│   ├── viharapala.ts   # Review agent session
│   └── e2e.ts          # E2E test agent session
├── vichara/            # Conversational interface server
│   ├── server.ts       # Fastify + WebSocket
│   ├── tools/
│   │   ├── read.ts     # Codebase search, bead queries
│   │   └── write.ts    # Bead create/update (routes through Sthapathi API)
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
├── CLAUDE.md                   # Agent skills — global for this project
├── .claude/
│   └── commands/               # Per-task scoped skills
├── AGENTS.md                   # Written by: bd setup claude
├── .gitignore                  # Includes: .beads/
└── src/

/projects/<slug>-beads/         # Beads repo (TeakWood/<slug>-beads)
├── .git/
└── embeddeddolt/               # bd Dolt database (committed to GitHub)
```

> **Symlink pattern:** `bd` embedded mode requires `BEADS_DIR` to point at the directory containing `embeddeddolt/`. Sthapathi sets `BEADS_DIR=/projects/<slug>-beads` for all `bd` calls. The `.beads/` symlink inside the project dir is a convenience for agents running with `cwd` set to the project.

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
}

// Viharapala output
interface ViharapalaOutput {
  verdict: 'APPROVE' | 'REJECT';
  overallScore: number;          // 0-100
  mustFix: string[];             // blockers; Silpi must address
  suggestions: string[];         // non-blocking improvements
  issues: {
    severity: 'blocker' | 'major' | 'minor';
    file?: string;
    description: string;
  }[];
}

// E2E Agent output
interface E2EOutput {
  testFilesAdded: string[];
  coverageGaps: { feature: string; description: string }[];
  newBeadsCreated: string[];     // bd IDs of gap-filling tasks filed
}
```

### 3.3 Shreni Runtime State

Sthapathi maintains live state in memory, exposed to the `shreni` CLI and Vichara via a local API:

```typescript
interface ShreniState {
  kshetras: KshetraState[];
}

interface KshetraState {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'idle' | 'error';
  activeBead: string | null;     // bd task ID currently being worked
  activeAgent: 'silpi' | 'viharapala' | 'e2e' | null;
  round: number;
  queueDepth: number;            // bd ready count
  lastCompletedAt: string | null;
  lastError: string | null;
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

  const branch = await git(kshetra).createBranch(task);
  const result = await runSilpiViharapalaLoop(kshetra, task, branch);

  if (result.approved) {
    await git(kshetra).merge(branch);
    await bd(kshetra).close(task.id, result.note);
    await syncBeads(kshetra);                 // git push
    dispatch(e2eAgent, kshetra, task);        // async, non-blocking
  } else {
    await bd(kshetra).flag(task.id, 'Exceeded max rounds');
    await notifyVichara(kshetra, task, 'blocked');
  }
}
```

### 4.2 Silpi↔Viharapala Loop

```typescript
async function runSilpiViharapalaLoop(
  kshetra: Kshetra, task: Task, branch: string
): Promise<{ approved: boolean; note: string }> {
  let round = 0;
  let feedback: ViharapalaOutput | null = null;

  while (round < kshetra.agents.maxRoundsPerBead) {
    round++;
    const silpiOut = await runSilpi(kshetra, task, branch, feedback);

    if (!silpiOut.testsPassed || !silpiOut.lintPassed) {
      // Silpi self-reported failure — don't send to Viharapala
      feedback = { verdict: 'REJECT', mustFix: ['Tests or lint failed'], ... };
      continue;
    }

    feedback = await runViharapala(kshetra, task, silpiOut, round);
    await bd(kshetra).addNote(task.id, `Round ${round}: ${feedback.verdict}`);

    if (feedback.verdict === 'APPROVE') {
      return { approved: true, note: `Approved round ${round}` };
    }
  }
  return { approved: false, note: `Blocked after ${round} rounds` };
}
```

### 4.3 Beads Sync

`bd` calls are internal to Sthapathi only. The `beads.ts` wrapper is not used by the `shreni` CLI or Vichara.

```typescript
// sthapathi/beads.ts — internal module, not exposed via shreni CLI

async function syncBeads(kshetra: Kshetra): Promise<void> {
  const p = kshetra.beads.path;
  await git(p).pull('--rebase', 'origin', 'main');  // pull first
  // ... bd operations ...
  await git(p).add('-A');
  await git(p).commit(`shreni: sync ${new Date().toISOString()}`);
  await git(p).push('origin', 'main');
}

// bd CLI wrapper — scopes BEADS_DIR per Kshetra
// Used only by Sthapathi internals and agent sessions
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

---

## 5. Agent Design

### 5.1 Agent Session Pattern

All three agents follow the same session structure. Each agent call is a single Claude API request with a carefully constructed system prompt + user message. There is no persistent agent process — context is fully injected per session.

```typescript
async function buildAgentContext(kshetra: Kshetra, task: Task): Promise<AgentContext> {
  return {
    universalSkills: loadSkills('~/.shreni/skills/'),       // global skills
    projectSkills:   readFile(kshetra, 'CLAUDE.md'),        // project CLAUDE.md
    scopedSkills:    loadScopedClaudes(kshetra, task.context.relatedFiles),
    projectMemory:   await bd(kshetra).prime(),             // bd prime output
    taskDetails:     await bd(kshetra).show(task.id),       // full task + history
    conventions:     readFile(kshetra, '.shreni/style-guide.md'),
    architecture:    readFile(kshetra, '.shreni/arch.md'),
    ragChunks:       await rag(kshetra).search(task.title, { topK: 10 }),
    stack:           kshetra.stack,
  };
}
```

Skills are loaded in three tiers and injected in order — universal → project → scoped. See Section 9.4 for skill management via the `shreni` CLI.

### 5.2 Silpi System Prompt Structure

```
You are Silpi, a coding agent for the {kshetra.name} project.

== SKILLS ==
{universal skills}
{CLAUDE.md}
{scoped CLAUDE.md files for related directories}

== PROJECT MEMORY ==
{bd prime output}

== TASK ==
{bd show <id> output}

== PRIOR FEEDBACK (Round {n}) ==
{viharapala must-fix list from last round, if any}

== CONVENTIONS ==
{style-guide.md}

== ARCHITECTURE ==
{arch.md}

== RELEVANT CODE ==
{RAG chunks: top-10 relevant file sections}

== INSTRUCTIONS ==
1. Implement the task. Write unit tests. Run lint and tests.
2. If tests fail, fix them before submitting.
3. Call bd remember for any useful project insights.
4. Respond ONLY with a JSON SilpiOutput object.
```

### 5.3 Viharapala System Prompt Structure

```
You are Viharapala, a code reviewer for the {kshetra.name} project.

== SKILLS ==
{universal skills}
{CLAUDE.md}
{scoped CLAUDE.md files for related directories}

== PROJECT MEMORY ==
{bd prime output}

== TASK AND ACCEPTANCE CRITERIA ==
{bd show <id> output}

== SILPI'S OUTPUT (Round {n}) ==
{SilpiOutput JSON}

== FULL ROUND HISTORY ==
{all prior round notes from bd show}

== REVIEW DIMENSIONS ==
1. Correctness: Does code satisfy all acceptance criteria?
2. Test coverage: Are edge cases covered? Do tests test behavior?
3. Code quality: Patterns, readability, potential bugs, security.
4. Side effects: Regressions, breaking interface changes.
5. Completeness: No TODOs, no half-done work.

Minor issues do not block approval. Only raise REJECT for blockers.
Respond ONLY with a JSON ViharapalaOutput object.
```

### 5.4 E2E Agent

The E2E agent runs asynchronously after each merge. It is dispatched by Sthapathi via a fire-and-forget call; results are committed to `main` independently.

```typescript
async function runE2EAgent(kshetra: Kshetra, mergedTask: Task): Promise<void> {
  const personas      = readFile(kshetra, '.shreni/personas.yaml');
  const existingTests = scanTestFiles(kshetra);
  const diff          = await git(kshetra).diffMerged(mergedTask.branch);

  const output: E2EOutput = await callClaude({
    system: buildE2ESystemPrompt(kshetra, personas),
    user:   { task: mergedTask, diff, existingTests }
  });

  // Commit new tests to main
  for (const file of output.testFilesAdded) {
    await git(kshetra).commitFile(file, `e2e: add tests for ${mergedTask.id}`);
  }

  // File coverage gaps as P2 tasks via bd (internal call)
  for (const gap of output.coverageGaps) {
    await bd(kshetra).create(gap.description, 2, 'e2e');
  }
  await syncBeads(kshetra);
}
```

---

## 6. Vichara — Server Design

### 6.1 Server Stack

| Layer | Technology |
|---|---|
| HTTP / WebSocket server | Fastify + `@fastify/websocket` |
| Streaming to client | WebSocket — SSE-style token streaming |
| LLM calls | Anthropic SDK (`claude-sonnet-4`) |
| RAG index | LanceDB (local, no server) |
| Embedding model | `voyage-code-3` via Anthropic API |
| PWA frontend | React + Tailwind, Vite build |
| Auth | Shared secret token (Tailscale-only, not public) |
| Mobile connectivity | Tailscale — machine accessible as `shreni.local` |

Vichara is started and stopped via `shreni vichara start / stop`. It does not start automatically with Sthapathi.

### 6.2 Tool Registry

Vichara exposes Claude a set of tools. On each user message, Claude decides which tools to call based on intent. Write tools route through Sthapathi's internal API — Vichara never calls `bd` directly.

| Tool | Type | Description |
|---|---|---|
| `get_bead` | Read | Fetch full task details by `bd` ID |
| `list_beads` | Read | List beads with status/severity/tag filters, any Kshetra |
| `get_agent_status` | Read | Current Sthapathi state: active task, round, agent |
| `search_codebase` | Read | Semantic RAG search over Kshetra files |
| `read_file` | Read | Read a specific file by path |
| `get_diff` | Read | Get git diff for a bead branch |
| `create_bead` | Write | Create a new task bead (requires confirmation) |
| `create_bug` | Write | File a bug bead — P0 bypasses confirmation |
| `add_comment` | Write | Add note to an existing bead |
| `flag_bead` | Write | Mark a bead blocked with reason |

### 6.3 Context Injection Per Request

```typescript
function buildVicharaSystemPrompt(kshetra: Kshetra | null): string {
  const agentState = sthapathi.getState();  // live read from Sthapathi
  return `
You are Vichara, the project assistant for Shreni.

Current time: ${new Date().toISOString()}
Active Kshetras: ${activeKshetras.map(k => k.name).join(', ')}

${kshetra ? `Active project: ${kshetra.name}` : 'Cross-project mode'}

Agent state:
${agentState.map(s => `  ${s.kshetra}: ${s.status} — ${s.activeBead ?? 'idle'}`).join('\n')}

Recent completions (last 5): ${recentCompletions(kshetra)}

For P0 bugs: act immediately, confirm after.
For all other writes: confirm details before calling write tools.
When asked about code: use search_codebase first.
  `;
}
```

### 6.4 PWA — Mobile UI Spec

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

## 7. RAG Index Design

### 7.1 Storage

Each Kshetra has a LanceDB vector index stored at `~/.shreni/indexes/<kshetra-id>/`. LanceDB is embedded (no server), written as Arrow files, queryable from Node.js.

### 7.2 Chunk Schema and Strategy

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

### 7.3 Rebuild Triggers

- **Full rebuild:** on first Kshetra registration and on manual `shreni index rebuild --kshetra <id>`.
- **Incremental:** after each merge, only files changed in the merged bead are re-embedded.
- Incremental runs async in Sthapathi after `git merge` — never blocks the agent loop.
- Index is evicted from memory when Kshetra has no active tasks; reloaded on next query.

---

## 8. Git Operations

### 8.1 Branch Lifecycle

| Event | Git Operation |
|---|---|
| Task claimed by Sthapathi | `git checkout -b bead-{id}/{slug}` from `main` |
| Silpi submits (each round) | `git add -A && git commit -m 'silpi: round {n} — {title}'` |
| Viharapala rejects | Silpi continues on same branch; adds fixup commits |
| Viharapala approves | `git checkout main && git merge --squash bead-{id}/{slug}` |
| Merge committed | `git commit -m 'bead-{id}: {title}' && git push origin main` |
| Branch cleanup | `git branch -d bead-{id}/{slug} && git push origin --delete bead-{id}/{slug}` |

> **Squash merge rationale:** All round iterations (fix commits) are squashed into a single clean commit on `main`. The full round history is preserved in the `bd` bead record, not in git history.

### 8.2 Conflict Prevention

- `maxConcurrentBeads: 1` per Kshetra — only one branch active at a time, so merge conflicts are structurally prevented.
- Beads repo (`TeakWood/<slug>-beads`) uses `git pull --rebase` before every write to handle concurrent updates from phone/CLI.
- Sthapathi is the sole writer to the Dolt embedded database — no concurrent write conflicts possible.

---

## 9. `shreni` CLI

The `shreni` CLI controls the harness — Kshetras, agents, workflow, RAG, and Vichara. It does not manage tasks; use `bd` directly for all task operations.

### 9.1 Installation

```bash
cd /projects/shreni
npm install && npm run build
npm install -g .

# shreni is now available globally
shreni --version
```

### 9.2 Command Reference

#### Kshetra Management

```bash
shreni init-kshetra --slug sishya --path /projects/sishya
# 1. Creates TeakWood/sishya-beads on GitHub (gh repo create)
# 2. Clones to /projects/sishya-beads
# 3. Runs: BEADS_DIR=/projects/sishya-beads bd init --stealth
# 4. Creates symlink: /projects/sishya/.beads → /projects/sishya-beads
# 5. Appends .beads to /projects/sishya/.gitignore
# 6. Runs: BEADS_DIR=/projects/sishya-beads bd setup claude
# 7. Generates .shreni/kshetra.yaml from template
# 8. Builds initial RAG index
# 9. Registers Kshetra with Sthapathi

shreni register /projects/sishya          # register an already-initialised project
shreni list                               # all registered Kshetras + status
shreni status                             # current Kshetra (auto-detected from cwd)
shreni status --all                       # all Kshetras
shreni status --kshetra sishya            # specific Kshetra
```

#### Workflow Control

```bash
shreni start                              # start Sthapathi loop (all Kshetras)
shreni stop                               # graceful shutdown
shreni pause --kshetra sishya             # pause a Kshetra queue
shreni resume --kshetra sishya
shreni run --kshetra sishya               # force one cycle immediately (useful for testing)
shreni sync --kshetra sishya              # force beads git pull + push
shreni sync --all
```

#### Agent Inspection

```bash
shreni agents                             # what each agent is doing right now
shreni logs --kshetra sishya              # tail agent activity log
shreni logs --kshetra sishya --bead bd-f3a2   # logs for a specific bead
shreni logs --all                         # all Kshetras
```

#### RAG Index

```bash
shreni index rebuild                      # rebuild current Kshetra (auto-detected)
shreni index rebuild --kshetra sishya
shreni index rebuild --all
shreni index status                       # when each index was last built, size
```

#### Vichara

```bash
shreni vichara start                      # start Vichara server
shreni vichara stop
shreni vichara status                     # port, connected clients, uptime
```

#### Skills

```bash
shreni skills list                        # show loaded skills for current Kshetra
shreni skills add <path>                  # install a local skill file
shreni skills add <url>                   # install from URL (e.g. awesome-claude-code)
shreni skills remove <name>
```

### 9.3 Auto-detection

`shreni` resolves the current Kshetra from `cwd` by walking up the directory tree looking for `.shreni/kshetra.yaml`. This means you can run `shreni status` from anywhere inside a registered project and get scoped output. Pass `--kshetra <id>` to override.

### 9.4 Skill Management Detail

Skills are markdown files injected into agent context at session start. Three tiers, loaded in order:

```
~/.shreni/skills/               ← Tier 1: universal (all Kshetras)
  base-coding.md
  base-review.md

/projects/sishya/CLAUDE.md      ← Tier 2: project-wide
/projects/sishya/src/payments/CLAUDE.md   ← Tier 3: scoped to directory

/projects/sishya/.claude/commands/        ← Named skills (slash commands)
  review-checklist.md
  migration-check.md
```

`shreni skills add` copies the file into the appropriate tier based on the current directory context:

```bash
cd /projects/sishya
shreni skills add ~/downloads/nextjs-patterns.md   # → CLAUDE.md (project tier)

cd /projects/sishya/src/payments
shreni skills add ~/downloads/razorpay-patterns.md # → src/payments/CLAUDE.md (scoped)

shreni skills add https://raw.githubusercontent.com/.../vitest-patterns.md
```

Skills are picked up on the next agent session — no restart of Sthapathi needed.

### 9.5 What `shreni` Does NOT Do

These remain `bd` commands and are never exposed through `shreni`:

```bash
bd create "title" -p 0 -t bug   # create tasks
bd ready                         # list ready tasks
bd show <id>                     # view task detail
bd update <id> --claim           # claim a task
bd close <id> "note"             # close a task
bd remember "insight"            # store project memory
bd prime                         # print project context
bd dep add <child> <parent>      # link tasks
bd dolt push / pull              # sync beads database
```

---

## 10. Security Model

- Shreni is a local-only system. Vichara is not exposed to the public internet.
- Tailscale provides the only remote access path — device-level authentication.
- A shared secret token (set at `shreni init` time) is required for all Vichara API calls, including from the PWA.
- The Anthropic API key is stored in the local environment (`ANTHROPIC_API_KEY`) and never committed to any repo.
- GitHub access uses SSH keys — no HTTPS tokens stored on disk.
- Agent prompts include explicit instructions not to execute shell commands outside the defined tool set.

---

## 11. Recommended Build Sequence

Build in this order to get value at each stage:

| Phase | Deliverable |
|---|---|
| **Phase 1: Foundation** | `kshetra.yaml` schema, `bd` wrapper (`beads.ts`), git helpers, `syncBeads`. Manually verify `bd` commands work with `BEADS_DIR` scoping. |
| **Phase 2: Sthapathi core** | Main loop, task polling, branch creation, Silpi dispatch (hardcoded prompt). First automated bead closure. |
| **Phase 3: Review loop** | Viharapala integration, round counter, APPROVE/REJECT routing, squash merge. |
| **Phase 4: shreni CLI** | `shreni start/stop/status/agents/logs`. Sthapathi controllable from terminal. |
| **Phase 5: Vichara read** | Fastify server, WebSocket, read-only tools (`list_beads`, `get_agent_status`, `search_codebase`). PWA shell. `shreni vichara start` works. |
| **Phase 6: Vichara write** | `create_bug`, `create_bead` with confirmation flow. Bug filing from phone works. |
| **Phase 7: E2E agent** | Async post-merge dispatch, test file commits, coverage gap bead creation. |
| **Phase 8: RAG** | LanceDB indexing, incremental rebuild on merge, `shreni index rebuild` command, semantic codebase search in Vichara. |
| **Phase 9: Multi-Kshetra** | Kshetra registry, `BEADS_DIR` scoping, cross-project Vichara queries, `shreni init-kshetra` CLI, `shreni skills` commands. |
