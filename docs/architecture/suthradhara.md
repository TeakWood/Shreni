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

> **Source of record:** the full design rationale, alternatives, and open decisions
> live in the ARD (`Shreni-ARD-Suthradhara.md`, in the Shreni-cloud repo). This
> document describes the **as-built** agent in the OSS core (`src/suthradhara/`).
> Section markers below (§4, §8.1, …) refer to that ARD.

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

It is deliberately the *heavy* cousin of Vichara's <30-second capture. A bug spotted
on a phone goes to Vichara; a feature that needs designing goes to Suthradhara. The
two share mechanism (the CLI agentic loop, the `--allowedTools` boundary, the
server-side confirm gate) but occupy opposite ends of the effort/ceremony spectrum.

---

## Using it

Suthradhara is **CLI-first** — a terminal REPL, because design intake is a focused,
keyboard-heavy desk activity.

```bash
shreni suthradhara start   [@<id> | --kshetra <id>]   # begin an interview session
shreni suthradhara resume  <session-id>               # rehydrate an interrupted session
shreni suthradhara status  [@<id> | --kshetra <id>]   # is a session running?
shreni suthradhara stop    [@<id> | --kshetra <id>]   # stop the detached process
shreni suthradhara list    [@<id> | --kshetra <id>]   # list on-disk sessions
```

The active Kshetra is resolved by `@<id>`, `--kshetra <id>`, or a `cwd` that falls
inside a registered Kshetra's repo (the same `@`-mention mechanism Vichara uses). The
CLI runs with `cwd` = the resolved Kshetra repo, so all reads and `bd`/`git` calls
auto-scope to that project.

`start` prints the new session id and the exact `resume` command; a session id
embeds its Kshetra id, so `resume <session-id>` needs no redundant `@<id>`.

---

## The phased interview

Suthradhara runs **one agent through phased stages** — not five agents, not a rigid
wizard. The stages are a rubric the model advances through and *may revisit*:
clarification routinely reopens discovery, and design work can expose a missing
requirement. The current stage is tracked in session state and steers the system
prompt, but the model owns the conversation.

| Stage | Hat | Purpose | Exit condition |
|---|---|---|---|
| **1 · Discovery** | Product | Capture the raw idea: intent, the user and their problem, the "why now", rough success criteria; **detect new-feature vs. change-to-existing**, and if a change, locate the existing design doc. | The problem/outcome are stated in the operator's words and reflected back; any existing doc is loaded. |
| **2 · Clarify** | Product → Technical | Active interview: resolve ambiguity, enumerate edge cases, non-functional requirements, explicit **in/out of scope**, priorities, constraints. | The readiness rubric is satisfied; open questions answered or explicitly deferred. |
| **3 · Decompose** | Technical | Grounded in the repo, break the feature into a parent epic + child beads with acceptance criteria, each sized for one `Silpi ↔ Viharapala` pass, ordered by dependency. | Every child has title, description, acceptance criteria, priority; deps drawn; nothing is "and then figure out X". |
| **4 · Design** | Technical | Synthesise the decisions into a design note: chosen approach, key components and their touch-points in real files, alternatives, risks. | The note explains *why* the decomposition looks the way it does, referencing real files. |
| **5 · Confirm & commit** | — | Present the full bundle; operator edits/approves; only then write the doc + file the beads. | Operator confirms; artifacts written; bead ids echoed. |

### The readiness rubric

The interview's job is to *know when it has enough*. Suthradhara self-assesses against
an explicit checklist before it will propose a decomposition, and surfaces what is
still missing rather than guessing:

- **Intent** — the problem and desired outcome, not just a feature name.
- **Users / stories** — who benefits and the concrete scenarios.
- **Success criteria** — an observable, testable definition of done.
- **Scope boundary** — an explicit *out-of-scope* list, not only in-scope.
- **Non-functional** — perf/security/UX/compat constraints, or an explicit "none".
- **Dependencies / unknowns** — external systems, prerequisite work, deferred questions.

An item may be checked as **"deferred (Qn)"** — captured as an open question in the
design note rather than blocking — so the interview can converge without forcing false
precision. Suthradhara shows the rubric state when the operator asks "are we ready?"
and will not silently jump to Stage 3 with unchecked items.

---

## Codebase-aware grounding

To interview and decompose well, Suthradhara reads the active Kshetra's repo the same
way Vichara does — the **read allowlist carries over unchanged**: `Read`, `Grep`,
`Glob`, read-only `bd` subcommands (`list`/`ready`/`show`/`search`/`memories`/…), and
read-only `git` (`log`/`diff`/`status`/`show`/`branch`). Grounding is what separates a
useful decomposition from a generic one: before proposing "add an auth middleware,"
Suthradhara greps the existing request pipeline, reads the router, and checks whether a
session abstraction already exists — then shapes the beads around what it finds.

Grounding uses live `Read`/`Grep`/`Glob`, not RAG — a RAG index would sharpen
decomposition but is not required to ship.

Grounding also reaches **past the repo boundary**: the operator can ground a session
in an external source of record (a Jira/Linear/Confluence ticket) over MCP — *"let's
work on PROJ-123"* — with interactive, grant-on-demand authorization. See
[MCP grounding](./mcp-grounding.md).

---

## The write surface & boundary

Suthradhara has exactly **two** confirmed write surfaces, and the boundary around them
is the load-bearing control.

### 1. Bead filing

The harness allowlist is extended with *filing-only* `bd` subcommands — the same
`--allowedTools` discipline as Vichara-Write:

| Capability | `bd` surface |
|---|---|
| File the epic | `bd create … -t epic\|feature` |
| File children | `bd create … -t task\|bug\|feature` (acceptance criteria in the body) |
| Link dependencies | `bd dep add …` |

**Never allowlisted** (and covered by a mandatory negative test): `bd update --claim`,
`bd close`, and any wildcard (`Bash(bd:*)`, `Bash(bd update:*)`) that would silently
re-admit them. The allowlist is an **enumeration of exact subcommands**. Sthapathi
remains the sole owner of task-state transitions — Suthradhara *files* work but never
*transitions* it.

### 2. Design-doc file write

Suthradhara is the first agent in the system that puts a file on disk, so the grant is
**scoped to a single designated docs directory** — `.shreni/design/` under the repo
root by default (`DEFAULT_DESIGN_DIR`), a distinct subtree from `.shreni/` config.

- **Path allowlist, not a blanket `Write`.** A resolved target outside the design-docs
  dir is rejected **before any content is written** — enforced by a path guard in
  `designdoc.ts`, not by the prompt.
- **Server-authors-the-file.** The model emits the doc content; the *server* writes it
  to the vetted path. The boundary lives server-side; the model is never granted a
  native `Write` tool. (ARD Q4, resolved to server-writes.)
- **No git.** Writing the file is the whole action — no `git add/commit/push`. The file
  lands in the working tree; a human (or a later, separate flow) commits it.

> A test asserts a write **inside** the design dir succeeds and a write to an arbitrary
> source path (e.g. `src/index.ts`) is **denied**. Getting the path scope wrong would
> turn a design agent into an arbitrary file writer, so this test is as load-bearing as
> the `bd` negative test.

---

## Confirmation & commit

Suthradhara proposes; the operator commits. Because a single confirm triggers *both* a
set of `bd` writes and a file write, the bundle is confirmed **as a unit**.

1. At the end of Stage 4, Suthradhara renders a **commit proposal**: the design note
   (full text, or a diff when updating an existing note), the epic and each child (type,
   title, priority, acceptance criteria), the dependency edges, and the literal `bd`
   commands + target doc path it intends to write.
2. The operator can **Confirm / Edit / Cancel**. Edit loops back into conversation and
   re-proposes; Cancel discards the pending bundle and nothing is written.
3. On **Confirm**, the **server** (the authority, not the model) commits the bundle,
   journaling each step into the session bead as it lands: write the doc, file the epic,
   file each child, add the dep edges — recording the doc sha and every returned id. It
   echoes back the parent id + child ids + the doc path.

There is **no fast-path** — a design bundle is never an emergency; every commit is
pre-confirmed. The server-side confirm gate (`confirm.ts`) is also the anti-injection
control: repo content read during grounding is untrusted, and nothing commits without an
explicit operator confirm.

### Idempotent by reconcile, not replay

The commit is not a blind re-run. Because the session bead records the plan up front and
each committed item as it lands, a crash mid-commit is recovered by **reconciling against
the session bead**: on resume the server reads it and creates only what is missing (epic
present? each child present? deps added? doc written with matching sha?). Deterministic
child ids (`<epic>.1…`, fixed once the epic exists) make existence-checks exact, so
re-running files each item **exactly once**. Partial failure is reported with precisely
what did and didn't land, straight from the journal.

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
the full doc lives in the design-docs dir, and the epic and **each child bead link to its
path** in their description. Silpi/Viharapala `Read` it while working those beads — so the
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
existing feature, Suthradhara treats the existing doc as the source of truth and **revises
it in place** rather than forking a second doc that leaves the first stale (which would rot
the on-demand-read guarantee — an executor could read the wrong one). The flow (`evolve.ts`):

1. **Locate.** Before Stage 3/4, search the design-docs dir *and* the linked-from beads
   for the doc(s) covering the named feature (the same read grounding — `Glob`/`Grep` over
   the docs dir, `bd search`/`bd show` on related beads). Any match is loaded.
2. **Reconcile in the interview.** Clarification is framed against the existing design:
   what changes, what is added, what is now **obsolete**. Superseded decisions are edited
   or struck, never left contradicting the new ones.
3. **Update in place, shown as a diff.** The commit proposal renders the change as a diff
   against the existing file; on confirm the *same* file is rewritten. Path-scope and
   server-authors-the-file rules are unchanged — an update is just a write to an existing
   in-dir path.
4. **Reconcile the beads too.** New or changed work is filed as children (or a follow-on
   epic) that link to the same doc and reference prior beads — one doc, one bead lineage.

Ambiguity is the operator's to resolve: no existing doc → create one; **more than one**
plausible match → Suthradhara **asks which to evolve** rather than guessing.

---

## Session model & persistence — two layers

A design session needs two kinds of durable state, with different shapes and failure
modes, so they live in two places.

**Layer 1 — the conversation transcript (on disk).** The transcript + current stage +
rubric state + running requirement set persist as a per-session JSON record under
`~/.shreni/suthradhara/<session-id>.json`. It is chatty, unstructured, and single-host — a
poor fit for `bd` — so it stays on disk; `resume` rehydrates it. This is the Vichara
divergence: Vichara runs each turn stateless, Suthradhara must retain the conversation.

**Layer 2 — the session bead (in `bd`).** Once Stage 3 yields a plan, the **server** creates
a dedicated bead of type **`suthradhara-session`** — the durable spine of the session and
its commit journal. It is structured, small, operator-visible, crash-durable, and
git-shipped — exactly what `bd` is for.

The split is deliberate: **the transcript resumes the *interview*; the session bead resumes
the *commit***, and makes an in-flight design session a first-class, operator-visible object.

### Distilled state IS the conversation summary

Each interview turn is a **fresh, stateless `claude` invocation** — there is no
provider-native conversation memory. Rather than replay the whole transcript (which grows
unbounded and buries the signal), the per-turn context is the **distilled session state**:
current stage, rubric check marks, running requirement bullets, open questions, any pending
proposal — rendered into the system prompt (`prompt.ts`). *That distilled state IS the
running summary.* It is a **monotonic ledger** of what has been decided and what remains, so
a completed stage does not come back and tokens go only to unsettled work.

For this to be safe, distillation **must actually happen every turn**. The model emits,
alongside its natural-language reply, an explicit **state delta** in a fenced
` ```suthradhara-delta ` JSON block (requirements to add, rubric keys satisfied or
deferred-with-question, new open questions, stage advance). The server validates the delta
and applies it via pure mutators (`addRequirement`, `checkRubricItem`, `deferRubricItem`,
`addOpenQuestion`) **before** `saveSession` (`distill.ts`). The delta is model-emitted
structured data — not heuristic parsing of the reply (brittle), not a second summarizer pass
(extra cost). Parsing is **fail-safe**: a missing or malformed block yields a null delta, so
the turn's reply still reaches the operator and no partial state is applied. Nothing decided
is lost by dropping chatter, because every decision already lives in the artifact it produced
(the doc + the filed beads); the operator changes a settled decision by amending those and
extending the conversation, not by replaying the transcript.

### The turn loop

`turnloop.ts` is the driver: read the operator message → build the stage-aware spawn
(`prompt.ts`) → spawn `claude` (`capture.ts`) → capture the reply + state delta → apply
distillation → append transcript → `saveSession`, routing a confirm frame through to filing
+ the session bead + the commit bundle.

**Transport is an attached-TTY REPL** (ARD Q11): the loop reads operator messages
line-by-line from the runner's **stdin** and writes replies to **stdout** — no socket, no
control channel. The detached pid/log/stop/status machinery stays for lifecycle bookkeeping;
when a session is spawned detached with stdio `ignore`, stdin is not readable, readline closes
immediately, and the runner falls back to an idle heartbeat — preserving resume-proof
behaviour with no interactive input. Turns are serialised through a queue so a line typed while
a turn is still spawning `claude` waits rather than racing the shared session state.

### Queue isolation — the session bead never reaches Sthapathi

Sthapathi's whole input is `bd ready`, and a plain open bead is `ready` by default. Two
mechanisms exclude the session bead together:

- **Structural.** The server creates it `in_progress`, owned by a `suthradhara` actor;
  `bd ready` returns only *unclaimed* work, so an in-progress bead is out of the pool — and
  this is accurate, because the bead is being actively worked interactively.
- **Type filter (race-proof).** The type is set at creation (`--type=suthradhara-session`),
  and `selectNext` in `src/sthapathi/pickup.ts` skips it. Because the type is present from the
  first instant, any brief window before `in_progress` applies is still excluded — no poll
  race. This is the one Suthradhara-driven touch to Sthapathi: a single line in the *selection*
  path, unit-tested ("`pickNext` never returns a session bead, even a `ready` one"), **not** a
  state-machine change.

The server (not the model) creates/journals/closes the session bead against the one id it
owns, so the model's allowlist still provably excludes `bd close`/`bd update --claim` — the
negative test stays green. The sole-writer invariant governs *executable work-state*; a
`suthradhara-session` bead is not that.

---

## Vichara → Suthradhara handoff (designed, pending)

When a Vichara capture turns out to be more than a quick file — the operator realises the
"bug" is really a feature, or the item needs scoping — Vichara can **hand the captured
requirement off to Suthradhara**, which opens a design session **seeded** with that text
(active Kshetra, title, any body/severity). The ingest is **one-way and seeded**, not a live
bridge, and Vichara files nothing on handoff — Suthradhara's own confirm gate governs any
resulting write.

This handoff is **designed but not yet built**, and it is a **Vichara-side** feature — Suthradhara
needs nothing from Vichara to function. It is therefore tracked under the **Vichara Write Interface**
epic (`Shreni-beads-9sk`, deferred), not the Suthradhara epic, and lands when Vichara's write surface
does. It is documented here for completeness; the seeded-ingest path is not present in
`src/suthradhara/` today.

---

## Security

Vichara's controls carry over (shared token, scoped `cwd`, harness allowlist as the authority);
the net-new surface is the doc write:

- **Blast radius: "file beads + write one design note", never task state or code.** A leaked
  token lets an attacker file garbage beads and write a doc under the design dir. It **cannot**
  claim/close beads, edit source, or push — worst case is triageable spam.
- **Doc-write is path-scoped by construction**; the single most important new test asserts
  out-of-dir writes are denied.
- **Confirmation as anti-injection.** Repo content read during grounding is untrusted; the
  server-side confirm gate is what stops an unattended write.
- **Argument hygiene.** Bead titles/bodies and doc content are passed to `bd` as discrete args
  and written as file *data*, never shell-interpolated.
- **No API key on host** — the `claude` CLI's own session, like every other agent.

---

## Module map

Standalone in `src/suthradhara/`, reusing Sthapathi/Vichara primitives as shared modules.

| Module | Responsibility |
|---|---|
| `src/cli/suthradhara.ts` | CLI: `start`/`resume`/`stop`/`status`/`list`, Kshetra resolution, session-id parsing |
| `src/cli/suthradhara-runner.ts` | The detached runner entrypoint — rehydrate, then drive the turn loop (or idle) |
| `lifecycle.ts` | Detached-process spawn/stop/status/resume (Vichara process precedent) |
| `pid.ts` | PID file under `~/.shreni/suthradhara.*` |
| `prompt.ts` | Stage-aware system prompt — the distilled state that IS the per-turn summary |
| `rubric.ts` / `stages.ts` / `state.ts` | Readiness rubric logic; stage machine; session-state shape + pure mutators |
| `interview.ts` | Interview scaffolding |
| `distill.ts` | Parse + apply the per-turn state delta before save (fail-safe) |
| `turnloop.ts` | The driver: input → spawn → capture → distill → save; route confirm frame |
| `capture.ts` | Spawn one `claude` turn and return the final assistant text (stream-json parse) |
| `confirm.ts` | Server-side confirm gate — holds a proposal until an explicit confirm frame |
| `decomposition.ts` | The Stage-3 structured decomposition object |
| `allowlist.ts` | Read-only vs. filing tool sets — the exact write surface |
| `filing.ts` | Compile a decomposition into the ordered `bd create`/`bd dep add` plan |
| `designdoc.ts` | Path-scoped, server-authored design-doc write + the out-of-dir path guard |
| `evolve.ts` | Locate + reconcile + update an existing feature's doc in place (no fork) |
| `commit.ts` | The post-confirm server-side transaction: doc + epic + children + deps, journaled |
| `sessionbead.ts` | Layer-2 session bead: create/journal/close + resume-reconcile |
| `session.ts` / `persistence.ts` | Layer-1 on-disk transcript/stage/rubric; list/save/load |
| `src/sthapathi/pickup.ts` *(existing)* | One line: `selectNext` skips `suthradhara-session` beads |

---

## Testing

Tests ship with each module (Vitest), with emphasis on the boundary:

- **Filing allowlist** — asserts *presence* of `bd create`/`bd dep add` and **absence** of
  `bd close`/`bd update --claim`/`Bash(bd:*)`. The single most important guard.
- **Doc-write scope** — a write inside the design dir succeeds; a write to an arbitrary source
  path is denied.
- **Confirm gate** — a commit-bearing turn writes nothing (no `bd`, no file) until a confirm
  frame arrives; cancel discards; partial-failure reporting lists exactly what was written.
- **Rubric** — the stage logic won't advance to a decomposition proposal with unchecked items;
  deferred items are recorded as open questions.
- **Session persistence** — a session round-trips through save/resume with stage, rubric, and
  requirements intact.
- **Distillation faithfulness** — a turn conveying a requirement and satisfying a rubric item
  leaves that requirement in `requirements` and that rubric key satisfied, and it appears in the
  *next* turn's rendered prompt.
- **Queue isolation** — `pickNext` never returns a `suthradhara-session` bead, even a `ready` one.
- **Commit idempotency** — a commit interrupted after the epic + some children reconciles against
  the session bead on resume and files the remaining items exactly once; a full re-run files
  nothing new.
- **Argument hygiene** — a bead title with shell metacharacters is filed verbatim and executes
  nothing.

---

## Relationships

- **Sthapathi** ([ARCHITECTURE.md](../../ARCHITECTURE.md)) — the unchanged consumer. Suthradhara
  files feature beads and manages its own non-executable session bead, but never transitions
  executable work. One filter line in the selection path; no state-machine change.
- **Vichara** — the lightweight <30s capture surface. Complementary, not overlapping: a bug goes
  to Vichara, a feature to Suthradhara. They share the CLI agentic loop, the `--allowedTools`
  boundary, the server-side confirm gate, and the token/PID model.
- **MCP grounding** ([mcp-grounding.md](./mcp-grounding.md)) — grounds a session in an external
  MCP server (Jira/Linear/Confluence) with interactive grant-on-demand; a general per-agent MCP
  capability, not a bespoke tracker integration.
- **Extension seams** ([extension-points.md](./extension-points.md)) — Suthradhara runs entirely
  on the core's local defaults; it needs no optional package.
