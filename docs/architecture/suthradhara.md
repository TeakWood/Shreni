# Suthradhara — Requirements & Design Intake Agent

**Suthradhara** (Sanskrit *सूत्रधार*, "holder of the thread/measuring cord") is the
front door of a Kshetra. It is an interactive, human-in-the-loop agent that
**interviews** the operator to turn a raw feature idea into a correctly-scoped,
dependency-ordered set of ready beads — plus a per-feature design doc — that
Sthapathi's `Silpi ↔ Viharapala` loop then executes. In the Shilpa/Vastu tradition
the *Suthradhara* is the draughtsman who holds the measuring cord and lays out the
plan before the **Silpis** carve the stone — subordinate to the Sthapati (the master
builder), who directs the construction; the etymology is exact.

Suthradhara sits **entirely outside the Sthapathi poll loop**. It is a *producer*
of beads and design docs; Sthapathi is the *consumer* that picks them up on its next
poll. The two never call each other — they meet only at the `bd` database and the
design-docs path, both already read by the loop. Adding Suthradhara required a
single filter line in Sthapathi's selection path (see [Queue isolation](#queue-isolation))
and no change to the orchestration state machine.

> **Source of record:** this document describes the **as-built** agent in the OSS
> core (`src/suthradhara/`); the launched-session design note is
> [`docs/design/suthradhara-launched-planning-session.md`](../design/suthradhara-launched-planning-session.md).

---

## Why it exists

Work enters Shreni as a bead. Everything downstream — Silpi's code, Viharapala's
review against acceptance criteria, Parikshaka's coverage backfill — inherits the
quality of that bead. Before Suthradhara there was **no deliberate step between "I
have a feature idea" and "there is a dependency-ordered set of ready beads with
acceptance criteria."** That translation happened in the operator's head, and its
quality was invisible until Silpi produced something that missed the intent.
Suthradhara is that missing step: a design session that refuses to file a half-formed
epic.

Suthradhara is deliberately a *heavy*, high-ceremony step — a focused design session,
not a quick capture. It keeps that ceremony safe not by re-implementing an agent loop
but by **launching a real interactive Claude Code session** — seeded with a planning
system-prompt and wrapped in a **launcher-owned control loop** — so the operator is at
the keyboard for every question and every write, and is never left in a free-roaming
agent between planning units.

---

## Using it

Suthradhara is **CLI-first** — a terminal session, because design intake is a focused,
keyboard-heavy desk activity.

```bash
shreni suthradhara start   [@<id> | --kshetra <id>]   # launch a planning session
shreni suthradhara resume  <session-id>               # reattach to an interrupted session
shreni suthradhara status  [@<id> | --kshetra <id>]   # is a session running?
shreni suthradhara stop    [@<id> | --kshetra <id>]   # stop the running session
shreni suthradhara list    [@<id> | --kshetra <id>]   # list on-disk sessions
```

The active Kshetra is resolved by `@<id>`, `--kshetra <id>`, or a `cwd` that falls
inside a registered Kshetra's repo (the standard `@`-mention mechanism). The
launched session runs with `cwd` = the session's isolated worktree, so all reads and
`bd`/`git` calls auto-scope to that project (see
[Worktree isolation](../guides/suthradhara-worktree-isolation.md)).

`start` and `resume` **launch an interactive Claude Code session** (`stdio` inherited,
attached to your TTY) in the session worktree, seeded with the planning system-prompt,
and then **enter the launcher control loop**: the CLI blocks on the live session, and
when the session ends (Ctrl-D / `/exit`) it prints a completion summary and a bounded
menu — **[1] extend this topic · [2] new story · [3] end**. `resume <session-id>`
reattaches to the underlying Claude Code conversation via `claude --resume`; a session
id embeds its Kshetra id, so `resume <session-id>` needs no redundant `@<id>`. The
control loop is why the operator is never stranded in a free-roaming agent: completion
always returns here, not to an open prompt (see
[The launcher control loop](#the-launcher-control-loop)).

---

## The phased interview

Suthradhara runs **one agent through phased stages** — not five agents, not a rigid
wizard. The stages are rendered into the planning system-prompt as a rubric the model
advances through and *may revisit*: clarification routinely reopens discovery, and
design work can expose a missing requirement. There is **no machine gate** advancing
the stages — the launched session self-governs against the rubric and owns the
conversation.

| Stage | Hat | Purpose | Exit condition |
|---|---|---|---|
| **1 · Discovery** | Product | Capture the raw idea: intent, the user and their problem, the "why now", rough success criteria; **detect new-feature vs. change-to-existing**, and if a change, locate the existing design doc. | The problem/outcome are stated in the operator's words and reflected back; any existing doc is loaded. |
| **2 · Clarify** | Product → Technical | Active interview: resolve ambiguity, enumerate edge cases, non-functional requirements, explicit **in/out of scope**, priorities, constraints. | The readiness rubric is satisfied; open questions answered or explicitly deferred. |
| **3 · Decompose** | Technical | Grounded in the repo, break the feature into a parent epic + child beads with acceptance criteria, each sized for one `Silpi ↔ Viharapala` pass, ordered by dependency. | Every child has title, description, acceptance criteria, priority; deps drawn; nothing is "and then figure out X". |
| **4 · Design** | Technical | Synthesise the decisions into a design note: chosen approach, key components and their touch-points in real files, alternatives, risks. | The note explains *why* the decomposition looks the way it does, referencing real files. |
| **5 · Confirm & commit** | — | Present the full bundle; operator edits/approves; only then file the beads, write the doc, sync beads, and push the doc branch. | Operator approves; artifacts filed and pushed; bead ids echoed. |

### The readiness rubric

The interview's job is to *know when it has enough*. The planning prompt carries an
explicit checklist that the session must satisfy (or explicitly defer) before it will
propose a decomposition, and it is told to surface what is still missing rather than
guessing:

- **Intent** — the problem and desired outcome, not just a feature name.
- **Users / stories** — who benefits and the concrete scenarios.
- **Success criteria** — an observable, testable definition of done.
- **Scope boundary** — an explicit *out-of-scope* list, not only in-scope.
- **Non-functional** — perf/security/UX/compat constraints, or an explicit "none".
- **Dependencies / unknowns** — external systems, prerequisite work, deferred questions.

An item may be **deferred** — captured as an open question in the design note rather
than blocking — so the interview can converge without forcing false precision. The
prompt instructs the session to show the rubric state when the operator asks "are we
ready?" and not to jump to Stage 3 with unmet items.

---

## Codebase-aware grounding

"Grounding" means the session looks at your **actual** project before it proposes any
tasks, so the plan fits the code you really have instead of a generic template. It is
about the *quality* of the decomposition — **not** a restriction on where Claude may
look.

Concretely: the launched session is a normal, full Claude Code session (`Read`, `Grep`,
`Glob`, `Bash`, `bd`, `git` are all available, and you approve each call at the
keyboard). It runs with its working directory set to the Kshetra's worktree, so its
searches *default* to that repo — but nothing fences it off from the rest of the
machine; it is just a normal session pointed at your project and steered by the
planning prompt. There is no sandbox and no allow-list boundary.

Why it matters: asked to "add auth middleware," a grounded session first greps the
request pipeline, reads the router, and checks whether a session abstraction already
exists — then writes the beads around what it finds, rather than proposing a middleware
the project's shape doesn't call for. That is the difference between a decomposition
that fits and one that reads like boilerplate.

Grounding can also reach **beyond the repo**: you can point the session at an external
ticket (a Jira/Linear/Confluence issue) over MCP — *"let's work on PROJ-123"* — and it
folds that into the interview. Authorization is just Claude Code's normal permission
prompt; there is no separate grant machinery, because you are present. See
[MCP grounding](./mcp-grounding.md).

(Grounding uses live `Read`/`Grep`/`Glob`, not a RAG index — a RAG index would sharpen
decomposition but is not required to ship.)

---

## What the session files — and how it does it

Suthradhara has two write surfaces — **beads** and a **design doc** — and in the
launched-session model the session performs both **itself**, directly. There is no
server-side write authority, no `--allowedTools` whitelist, and no server-authored
file: the session runs `bd`, `git`, and `Write` under the operator's live approval.

### Bead filing

The session files the plan with plain `bd`:

| Capability | `bd` surface |
|---|---|
| File the epic | `bd create … -t epic\|feature` |
| File children | `bd create … -t task\|bug\|feature` (acceptance criteria in the body) |
| Link dependencies | `bd dep add <blocked> <blocker>` |

`bd` resolves its database from the absolute `BEADS_DIR` the launcher injects (the
worktree has no `.beads/` symlink — see the
[worktree guide](../guides/suthradhara-worktree-isolation.md)).

Suthradhara *files* work but never *transitions* it: **Sthapathi remains the sole
owner of task-state transitions** (`bd update --claim`, `bd close`). That invariant is
no longer enforced by a compiled allowlist — a full session *could* run those commands —
but the planning prompt scopes the session to filing, and the operator is at the
keyboard approving each `bd` call.

### Design-doc file write

The session writes the design note with its own `Write` tool to
`.shreni/design/<slug>.md` **inside the worktree** (`DESIGN_DIR = .shreni/design`).
The doc is then committed and pushed on a branch (see below) rather than written
straight into the shared build tree.

---

## Confirmation & completion — the two-gate protocol

Suthradhara proposes; the operator commits. At the end of Stage 4 the session renders
a **decomposition proposal** — the design note (full text, or a revision when updating
an existing note), the epic and each child (type, title, priority, acceptance
criteria), and the dependency edges — and asks the operator to **Approve / Edit /
Cancel**. Edit reopens the interview and re-proposes; Cancel discards the pending
bundle and nothing is written.

On approval the session runs a **two-gate completion protocol** itself, grounded in
this Kshetra's real remotes and paths (`repo.remote`, `beads.remote`,
`repo.mainBranch` from `src/kshetra/config.ts`):

- **Gate ① — plan approved.** File the epic, then each child, with `bd create`;
  add the dependency edges with `bd dep add`. Write the design note to
  `.shreni/design/<slug>.md` in the worktree. Then **sync beads** to `beads.remote`:
  `bd export -o "$BEADS_DIR/issues.jsonl"` → `git -C "$BEADS_DIR" add/commit` →
  `pull --rebase && push`, verifying the beads repo is up to date with origin. Report
  the epic id, child ids, and doc path, and tell the operator the doc is ready to review.
- **Gate ② — design doc approved.** Create a `suthradhara/<slug>` branch off the
  worktree's detached HEAD, commit the doc, and **push the branch** to `repo.remote`.
  The session **never merges to `main`** — the operator merges the branch on their own
  time. Then write the JSON handoff and stop.

There is **no fast-path** — a design bundle is never an emergency; every commit is
pre-approved by the operator in the conversation, and every `bd`/`git`/`Write` call is
additionally gated by Claude Code's live permission prompt. That human-in-the-loop
approval is also the anti-injection control: repo content read during grounding is
untrusted, and nothing is filed or pushed without the operator present.

### The handoff record

Just before it exits, the session writes a small JSON **handoff**
(`.suthradhara-handoff.json`) to the worktree root — `branch`, `epicId`, `docPath`,
`summary` (`src/suthradhara/handoff.ts`). The session and the launcher are separate
processes with no shared memory, so this file **is** the channel between them: the
launcher reads it to render the completion summary and the merge prompt. It is
transient state, never committed (Gate ②'s `git add` names only the design doc).
Recovery is graceful — an absent or malformed handoff (a session that crashed before
writing it) yields a **degraded summary**, never a crash; the branch was still pushed
and the beads still filed, both recoverable from `git`/`bd`.

---

## The design doc & how it reaches executors

The design doc is the durable record of what the operator vetted, and it is **as deep as
the interview warrants** — a ten-minute clarification yields a short doc; a substantial
architectural feature yields a full technical design. Suthradhara does not cap the depth;
the *structure* is fixed (intent & scope · chosen approach · component/interface design
referencing real files · alternatives + why rejected · risks & edge cases · open
questions · links to the filed epic and children), the *length* follows the discussion.

The challenge is not "keep the doc small" — it is "deliver a possibly-deep doc to
Silpi/Viharapala without taxing every unrelated task." Delivery is by **on-demand read**:
the full doc lives under `.shreni/design/`, and the epic and **each child bead link to its
path** in their description. Once the operator merges the `suthradhara/<slug>` branch,
the doc lands on `main`; Silpi/Viharapala `Read` it while working those beads — so the
full depth is available exactly where relevant, and only there. Fifty features → fifty
docs, none forced into an unrelated task's context.

For a cross-cutting decision worth surfacing beyond the doc, Suthradhara may additionally
record a provider-neutral **`bd remember`** fact ("feature X established pattern Y; see
`<doc path>`"), searchable via `bd memories`. It does **not** dump the doc — or the
pointer — into the always-injected `conventions.architecture` file (which stays
human-curated), and it does **not** use provider-native Memory (Claude `/memories`, Gemini
`GEMINI.md`, Codex `AGENTS.md`): that would strand design knowledge on an
`agents.provider` switch, the same reason Shreni already chose `bd remember` over
`MEMORY.md`. **Docs → repo files; memory → `bd remember`; conventions → the existing
human-curated file.** Suthradhara reuses all three and invents no fourth channel.

### Evolving an existing feature — update, don't fork

A feature is rarely designed once. When the operator returns to **extend or change** an
existing feature, the planning prompt directs the session to treat the existing doc as the
source of truth and **revise it in place** rather than forking a second doc that leaves the
first stale (which would rot the on-demand-read guarantee — an executor could read the
wrong one):

1. **Locate.** In discovery, detect new-feature vs. change-to-existing; for a change,
   `Glob`/`Grep` under `.shreni/design/` *and* `bd search`/`bd show` the linked-from beads
   for the doc(s) covering the named feature. Any match is loaded.
2. **Reconcile in the interview.** Clarification is framed against the existing design:
   what changes, what is added, what is now **obsolete**. Superseded decisions are edited
   or struck, never left contradicting the new ones.
3. **Update in place.** On approval the *same* file is rewritten — an update is just a
   `Write` to an existing in-dir path.
4. **Reconcile the beads too.** New or changed work is filed as children (or a follow-on
   epic) that link to the same doc and reference prior beads — one doc, one bead lineage.

The **launcher's "extend this topic"** menu choice reinforces this: it relaunches a fresh
session in the *same* worktree and branch, seeding the planning prompt with the
just-written doc's path so the new session frames its work as an extension of that topic
(see [The launcher control loop](#the-launcher-control-loop)). Ambiguity is the operator's
to resolve: no existing doc → create one; **more than one** plausible match → the session
asks which to evolve rather than guessing.

---

## Session model & persistence

Because a launched Claude Code session **owns the conversation itself**, Suthradhara no
longer persists a transcript, stage, or rubric ledger of its own — Claude Code holds that
memory and `claude --resume` rehydrates it. What Suthradhara keeps on disk is a
deliberately **slim session record** (`src/suthradhara/state.ts`, `persistence.ts`) at
`~/.shreni/suthradhara/<session-id>.json`:

- the Suthradhara **session id** and its **Kshetra id**;
- the **Claude Code session id** it drives (assigned via `--session-id` on first launch,
  reattached via `claude --resume <id>`);
- the **worktree path** the session runs in;
- lifecycle **status** (`active` until the operator ends it or `stop` is called, then
  `ended`, kept for the `list` view).

The record is versioned (`SESSION_STATE_VERSION`); `loadSession` rejects an unknown
version rather than mis-hydrating. There is no separate "session bead" — a launched
session files directly and creates no per-session audit bead.

---

## The launcher control loop

`start`/`resume` do not just spawn a session — they enter a **launcher-owned control
loop** (`runPlanningLoop` in `src/cli/suthradhara.ts`) that sits above each short-lived
session so the operator is never left in a free-roaming agent:

```
loop:
  launch one interactive claude planning session (in the session worktree) → block on it
  on exit → read the handoff → print:
     • summary (epic id, doc path, branch) + "merge this branch when ready" (never auto-merged)
     • menu: [1] extend this topic   [2] new story   [3] end
        1 → fresh claude session, SAME worktree + branch, seeded with the just-written doc
        2 → fresh worktree + fresh claude session (blank topic, off main)
        3 → teardown (reap the worktree), exit
```

Properties: a **new Claude Code session per planning unit** (context never bleeds between
topics); the operator **cannot drift** (completion returns to the 3-way menu, not a free
prompt); scoping is by **prompt + short lifecycle**, not by tool-stripping — the session
needs `Write`/`bd`/`git` to file directly, so a hard sandbox would be incompatible. While
a child session runs, the loop swallows `SIGINT` so Ctrl-C reaches the interactive session,
not the parent.

---

## Queue isolation

Sthapathi's whole input is `bd ready`, and a plain open bead is `ready` by default. A
launched Suthradhara session files only **executable feature beads** (the epic and its
children), which Sthapathi is *meant* to pick up — that is the handoff. It creates **no**
tracking/audit bead of its own, so there is nothing extra to hide from the poll.

The one Suthradhara-driven touch to Sthapathi is a **backward-compatibility filter**:
`selectNext`/`pickNext` in `src/sthapathi/pickup.ts` skip any bead whose type is
`suthradhara-session` (`SUTHRADHARA_SESSION_TYPE`, an inlined constant). The *legacy*
commit engine created such beads as its per-session spine; that engine is gone, but a
Kshetra's DB may still hold historical `suthradhara-session` beads, so the filter stays —
Sthapathi must never try to "work" one. This is a single line in the *selection* path,
unit-tested (`pickNext` never returns a `suthradhara-session` bead, even a `ready` one),
**not** a state-machine change.

---

## Security

Suthradhara's base controls (shared token, scoped `cwd`/worktree, the operator at the
keyboard) carry the same weight as elsewhere in Shreni. The launched-session model moves
the boundary from a compiled allowlist to **live human approval**:

- **Blast radius: "file beads + write one design note + push a doc branch", never task
  state or a merge to `main`.** The session can file beads, write a doc under
  `.shreni/design/`, and push a `suthradhara/<slug>` branch. It does **not** merge to
  `main` (Gate ② pushes only) — the operator merges manually.
- **Human-in-the-loop as the control.** Every `bd`/`git`/`Write` runs under Claude Code's
  interactive permission prompt, with the operator present. There is no unattended write
  surface: a scripted, non-interactive launch would stall at the first permission prompt
  rather than filing anything.
- **Anti-injection.** Repo content read during grounding is untrusted; the operator's
  presence and approval at each write is what stops an injected instruction from filing or
  pushing on its own.
- **Argument hygiene.** Bead titles/bodies and doc content are handled as `bd` args and
  file data, never shell-interpolated.
- **No API key on host** — the `claude` CLI's own session, like every other agent.

---

## Module map

Standalone in `src/suthradhara/`, plus the CLI and the one Sthapathi touch-point.

| Module | Responsibility |
|---|---|
| `src/cli/suthradhara.ts` | CLI dispatch (`start`/`resume`/`stop`/`status`/`list`), Kshetra + session-id resolution, and the **launcher control loop** (`runPlanningLoop`, `renderSummary`, `parseMenuChoice`) |
| `lifecycle.ts` | Launch/resume/stop/status: (reap +) create the worktree, spawn the **interactive** `claude` in it, track the pid, block on exit |
| `session.ts` | `buildPlanningSession` — the interactive spawn spec (`--session-id`/`--resume`, `--append-system-prompt`, MCP config, `--model`, `BEADS_DIR`); `defaultKickoff` |
| `prompt.ts` | `buildPlanningPrompt` — the composed-once planning system-prompt: role boundary, five stages, rubric, proposal shape, and the two-gate completion protocol |
| `handoff.ts` | The JSON handoff contract (`readHandoff`/`writeHandoff`/`clearHandoff`) between a session and the launcher |
| `state.ts` / `persistence.ts` | The slim on-disk session record (schema + I/O): id ↔ Claude Code session id ↔ worktree + status; `list`/`save`/`load` |
| `pid.ts` | PID file under `~/.shreni/suthradhara.*` — one live session per Kshetra |
| `worktree.ts` | Per-session detached git worktree: create/reap/prune (see the worktree guide) |
| `src/sthapathi/pickup.ts` *(existing)* | One line: `pickNext` skips legacy `suthradhara-session` beads |

---

## Testing

Tests ship with each module (Vitest), with emphasis on the launcher contract and the
planning prompt:

- **Planning prompt** (`prompt.test.ts`) — the prompt names the Kshetra/repo, walks the
  five stages, carries both completion gates, grounds the beads-sync/doc-push in the real
  remotes/paths, instructs writing the handoff, **drops** the old server-side delta
  protocol, and adds the extend block only when a prior doc is seeded.
- **Spawn builder** (`session.test.ts`) — a fresh launch is an **interactive** invocation
  (no `-p`/stream-json), pins the session id and appends the system prompt + kickoff, sets
  the model/project settings/`BEADS_DIR` and **no `--allowedTools` whitelist**; a resume
  reattaches via `--resume` and omits the system prompt + kickoff.
- **Control loop** (`cli/suthradhara.test.ts`) — `renderSummary` renders epic/doc/branch +
  a merge prompt (and degrades gracefully with no handoff); `parseMenuChoice` maps
  digits/words; `runPlanningLoop` transitions: **end** tears down + stops, **extend**
  relaunches in the *same* worktree seeded with the prior doc, **new story** tears down the
  old worktree before starting fresh, and an unrecognised answer re-asks.
- **Lifecycle** (`lifecycle.test.ts`) — a fresh unit creates a worktree, persists ids, and
  launches an interactive claude; the pid clears when the session exits; the "extend" path
  reuses a given worktree; a live pid refuses a second launch; resume reattaches or starts
  fresh; teardown reaps the worktrees.
- **Handoff** (`handoff.test.ts`) — round-trips the record at the fixed dot-prefixed path;
  `readHandoff` returns null (never throws) on an absent file, malformed JSON, or a
  missing/wrong-typed field.
- **Session persistence** (`state.test.ts`, `persistence.test.ts`) — a slim `active` record
  at the current schema version **carries no interview-ledger fields** (transcript / rubric
  / stage / pending are gone); save/load round-trips the launched-session fields, rejects a
  traversal id and an unsupported schema version; `list` summarises by status.
- **Queue isolation** (`sthapathi/pickup`) — `pickNext` never returns a
  `suthradhara-session` bead, even a `ready` one.
- **Worktree** (`worktree.test.ts`) — create/reap/prune and the leak-sweep semantics (see
  the worktree guide).

---

## Relationships

- **Sthapathi** ([ARCHITECTURE.md](../../ARCHITECTURE.md)) — the unchanged consumer. Suthradhara
  files feature beads for it to pick up but never transitions executable work. One
  backward-compat filter line in the selection path; no state-machine change.
- **MCP grounding** ([mcp-grounding.md](./mcp-grounding.md)) — grounds a session in an external
  MCP server (Jira/Linear/Confluence); callability is governed by Claude Code's interactive
  permission prompts, a general per-agent MCP capability, not a bespoke tracker integration.
- **Extension seams** ([extension-points.md](./extension-points.md)) — Suthradhara runs entirely
  on the core's local defaults; it needs no optional package.
- **Worktree isolation** ([../guides/suthradhara-worktree-isolation.md](../guides/suthradhara-worktree-isolation.md))
  — each intake session runs in its own detached git worktree so planning never shares a working
  directory with a build. Developer how-to for the lifecycle, the `BEADS_DIR` invariant, and
  recovering leaked worktrees.
</content>
</invoke>
