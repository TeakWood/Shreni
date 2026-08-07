# Shreni

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#prerequisites)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

**Shreni is an AI builders' dojo — a team of AI agents that turns your ideas into a
backlog, and the backlog into product.**

Shreni isn't the worker; it's the place the workers train and build. Describe what
you want to build, and a team of specialized agents takes it from there: an intake
agent interviews you, reads your repo, and files a dependency-ordered backlog of
ready tasks. Coding agents write the implementation and its tests. A reviewer agent
checks the diff against your acceptance criteria. Your lint and test suite gate it,
and what passes gets merged. On *your* machine, with *your* model, on *your* terms.
You bring the ideas; the team ships the product.

And because every task lives in **beads** — a durable, git-tracked issue database —
you get a full, replayable trace of what the team did: which agent touched which
task, the reviewer's verdicts, the round-by-round notes, and the commit that closed
it. Nothing the staff does is a black box.

> It's not a copilot that waits for you to type. It's a standing engineering team,
> with a paper trail, that takes an idea and hands you back merged code.

### From idea to product, without you in the loop

You have an idea: *"add rate limiting to the API — per-key quotas, a friendly 429,
and metrics."* You say it in plain English. Suthradhara, the intake agent,
interviews you until it's precise, then files an epic of ordered tasks with
acceptance criteria — the backlog you'd normally spend an afternoon writing.

You close your laptop. The team goes to work: each task is written by a coding
agent, sent back by a reviewer agent for the edge cases you'd have caught in
review, corrected, gated through your test suite, and squash-merged only after it
goes green. What gets stuck is flagged with the reviewer's notes — not silently
half-done. You came in with a sentence; you leave with shipped features and a paper
trail of decisions.

### Why it's different

Three convictions set Shreni apart from most agent frameworks:

- **Bring your own model.** Shreni drives the provider CLI you already pay for
  (Claude today; Codex/Gemini experimental). No hosted middleman, no per-seat
  markup, no lock-in to one vendor's model. Your Anthropic bill is the whole bill.
- **Local-first, by construction.** The orchestrator, your git repos, the task
  database, and the dashboard all run on your machine over loopback. Your code
  never has to leave it — this isn't a privacy *setting*, it's the architecture.
- **An explicit merge policy.** Shreni answers the scariest question up front:
  *does a bot push to `main`?* You decide — auto-merge for a solo high-trust loop,
  or a pull-request gate for a human/team sign-off. Either way, nothing merges
  until the AI reviewer approves it. See [Merge policy](#merge-policy-push-vs-pr).

### Who it's for

- **The solo engineer / indie hacker** with more ideas than evenings. Hand the
  ideas you never get to to a staff that decomposes and ships them overnight, on
  the model you already pay for — no new SaaS bill.
- **The small team** that wants leverage without handing its codebase to a hosted
  agent. Point Shreni at a repo, choose `pr` mode, and let it open reviewed pull
  requests your team merges — your CI, your gate, your machine.
- **The agent-automation explorer** who wants to *study a real multi-agent system*,
  not another toy demo. Shreni is a working orchestrator → coder → reviewer → tester
  loop with recovery, watchdogs, quality gates, and an explicit git workflow —
  readable TypeScript, 800+ tests, Apache-2.0. Fork it, instrument it, learn from it.

## How it works

Step onto the dojo floor. Shreni is the space; the agents are the small, tireless
engineering team working in it, each with a clear station and a clear hand-off:

- An **intake agent** (**Suthradhara**) is the front door. Instead of hand-writing a
  perfectly decomposed backlog, you describe a feature and it interviews you —
  discovery, clarify, decompose, design, confirm — reading your repo read-only to
  ground itself in the real code. On your confirmation it files a dependency-ordered
  epic of ready tasks plus a per-feature design doc. It only *produces* work; it never
  claims or closes it.
- An **orchestrator** watches your task list. When a task is ready and its
  dependencies are met, it assigns it, sets up an isolated branch, and manages the
  whole lifecycle — including recovering cleanly if the machine restarts mid-task.
- A **coding agent** does the work: writes the implementation and unit tests, runs
  lint and the test suite, and submits the result.
- A **reviewer agent** judges that result against the task's acceptance criteria,
  code quality, and coverage — and either approves it or sends it back with
  specific feedback. The coder and reviewer iterate for a few rounds until the work
  is approved or the task is flagged for you.

When the reviewer approves, the change lands on `main` (or opens a pull request —
your choice), and the orchestrator moves to the next task. A separate **test agent**
runs afterward to backfill coverage. The whole inner loop runs without you in it —
you steer by *outcome*: the review verdicts, a green-base health gate that refuses
to start new work on a broken build, and the merged result.

> **Does Shreni push to `main` without me reviewing?** By default, **yes — that's
> the point**: when the reviewer approves, the change is squash-merged straight to
> `main`. There is no human pull-request gate in the inner loop; every task still
> passes the automated coder ↔ reviewer review first. If you want a human gate, set
> **`mergePolicy: pr`** and Shreni opens a pull request on approval instead of
> merging — ideal for cautious solo devs and teams. See
> [Merge policy](#merge-policy-push-vs-pr).

## Why Shreni (vs. the alternatives)

Most tools in this space are either an IDE autocomplete, a Python library for
*building* an agent graph, or a hosted product that runs your code on someone
else's servers. Shreni is a **ready-to-run harness** for *autonomous, reviewed,
task-driven* delivery on your own machine.

| | **Shreni** | Copilot / Cursor / Augment | CrewAI / AutoGen | LangGraph | Roll your own |
|---|:---:|:---:|:---:|:---:|:---:|
| Runs autonomously from a backlog | ✅ | ✋ you drive each edit | ⚙️ you build the loop | ⚙️ you build the loop | ⚙️ |
| Built-in AI code review before merge | ✅ | ❌ | ⚙️ DIY | ⚙️ DIY | ⚙️ |
| Owns the git + merge workflow | ✅ | ❌ | ❌ | ❌ | ⚙️ |
| Task-graph driven (dependencies, priorities) | ✅ | ❌ | partial | ✅ (you wire it) | ⚙️ |
| Bring your own model / CLI | ✅ | ❌ (their model) | ✅ | ✅ | ✅ |
| Local-first (code stays on your machine) | ✅ | ❌ (mostly cloud) | ✅ | ✅ | depends |
| Explicit auto-merge **and** PR-gate modes | ✅ | n/a | ❌ | ❌ | ⚙️ |

✅ built-in · ⚙️ possible but you build it · ✋ manual · ❌ not the model

If you want a copilot that suggests lines while *you* type, use a copilot. If you
want to *assemble* a bespoke agent graph in Python, use CrewAI or LangGraph. If you
want to hand a backlog to a local, self-reviewing team and get merged commits back,
that's Shreni.

## Quickstart

> Prefer a zero-setup taste first? See [Prerequisites](#prerequisites) — you need a
> provider CLI (e.g. Claude) authenticated, plus `bd`, `gh`, and Node ≥ 20.

Install the CLI from source:

```bash
git clone https://github.com/TeakWood/Shreni.git /projects/shreni
cd /projects/shreni
pnpm install
pnpm build
npm install -g .          # installs the `shreni` CLI globally
shreni help               # list all commands
```

Register a project (a **Kshetra**) and file your first task:

```bash
# Your project repo must already exist with a GitHub remote configured.
cd /projects/myapp
shreni init               # prompts for slug/path (defaults: cwd + its name), then scaffolds

# Non-interactive / scripted equivalent:
#   shreni init --slug myapp --path /projects/myapp
# `init-kshetra` is the same flow with all options required as flags.

bd create "Add user authentication" -p 2 \
  --description "Email + password login with JWT sessions"
```

Start the harness and watch it work:

```bash
shreni start                     # orchestrator begins polling for ready tasks
shreni agents                    # see which agent is active and on what
shreni phalaka start             # optional: local dashboard on 127.0.0.1
```

Sthapathi polls each registered project every 30 seconds. When your task is ready,
the coder ↔ reviewer loop runs and — on approval — the change merges to `main`.

## Prerequisites

- **Node.js** ≥ 20 and **pnpm** (`npm install -g pnpm`)
- **`bd` (Beads) CLI** — the task database — `npm install -g @beads/bd`
- **A provider CLI, authenticated** — **Anthropic API key** (`ANTHROPIC_API_KEY`)
  for the default Claude provider. The agent still calls a model, so this is
  required; Shreni does not host one for you.
- **GitHub CLI** (`gh`) — authenticated for the account/org where your projects
  live. Used to create the task database repo and (in `pr` merge mode) to open PRs.

## Status

Shreni is **alpha**: the core loop, recovery/watchdog machinery, and merge policies
are implemented and tested (800+ unit tests), but the install path is source-only
and the provider story beyond Claude is experimental. Expect rough edges around
onboarding and distribution — those are the current focus. Feedback and issues
welcome.

## Meet the team (architecture)

Every role on the dojo floor has a Sanskrit name — the vocabulary you'll see in
logs, config, and the dashboard. Think of them as the staff you've hired:

| Component | Role on the team | What they do |
|---|---|---|
| **Suthradhara** (draughtsman / layout-planner) | **Product manager** | Requirements & design intake agent. Interviews you to turn a feature idea into a dependency-ordered epic of ready beads plus a per-feature design doc. Runs *outside* the poll loop as a producer — it files work for Sthapathi to pick up; it never claims or closes. |
| **Sthapathi** (master builder / chief architect) | **Engineering manager** | Orchestrator. Polls `bd` for tasks, assigns them, drives the review loop, and owns the task lifecycle and git workflow. |
| **Silpi** (craftsman) | **Software engineer** | Coding agent. Writes implementation code and unit tests, runs lint and tests, submits for review. |
| **Viharapala** (guardian) | **Code reviewer** | Review agent. Judges Silpi's output against acceptance criteria, quality, and coverage; returns `APPROVE` or `REJECT` with structured feedback. |
| **Parikshaka** (examiner) | **QA engineer** | Test agent. Runs asynchronously after each merge; backfills tests and surfaces coverage gaps. |
| **Phalaka** (panel) | **The team's status board** | Local dashboard. Loopback web UI to watch worker status, task progress, and stuck-state alerts. |

And the record-keeping runs underneath all of them: **beads** is the team's durable
ledger — every task, assignment, review verdict, and round note is written to a
git-tracked database, so the whole engagement is auditable and replayable long after
the work merges.

Each project managed by Shreni is a **Kshetra** (field) — its own git repo, `bd`
task database, and agent queue, fully isolated from every other project.

```
Developer machine
├── Suthradhara (interactive, own process)   ← PRODUCER, outside the poll loop
│   ├── interviews you: Discovery → Clarify → Decompose → Design → Confirm
│   ├── reads the Kshetra repo (read-only) to ground the decomposition
│   └── on confirm, files an epic + child beads and writes a design doc
│           │                                    │
│           ▼ (bd create / dep add)              ▼ (.shreni/design/<feature>.md)
├── Sthapathi (Node.js process)               ← CONSUMER of what Suthradhara filed
│   ├── polls bd ready every 30s per Kshetra
│   ├── dispatches Silpi → Viharapala loop (up to 3 rounds)   ← read the design doc on demand
│   ├── squash-merges approved branches to main (or opens a PR)
│   └── dispatches the test agent async post-merge
├── Phalaka server (Fastify, loopback)
│   └── serves the local dashboard at 127.0.0.1
└── Kshetras/
    ├── myapp/          ← project repo
    │   ├── .beads/          ← symlink to myapp-beads/
    │   ├── .shreni/kshetra.yaml
    │   └── .shreni/design/  ← per-feature design docs Suthradhara writes
    └── myapp-beads/    ← bd Dolt database (git repo)
```

Suthradhara and Sthapathi never call each other — they meet only at the `bd`
database and the design-docs path, both of which the poll loop already reads. See
[docs/architecture/suthradhara.md](docs/architecture/suthradhara.md) for the full
intake agent design.

**Key design constraint:** Sthapathi is the sole caller of `bd update --claim` and
`bd close`. Agents (Silpi, Viharapala, Parikshaka) never call `bd` directly — they
receive task context as injected prompt data. Interactive Claude Code sessions can
file tasks (`bd create`) but cannot claim or close them.

> For a deeper walkthrough — the worker lifecycle and phase machine, the git
> workflow, the provider abstraction, and the watchdog/self-heal resilience
> machinery — see [ARCHITECTURE.md](ARCHITECTURE.md).

**Connecting external tools (MCP).** To give the executor agents access to an
external Model Context Protocol server (Jira, Linear, Confluence, a local tool, …),
see the how-to guide
[docs/guides/connect-mcp-to-executors.md](docs/guides/connect-mcp-to-executors.md).
The design rationale and security model are in
[docs/architecture/mcp-grounding.md](docs/architecture/mcp-grounding.md).

**Adding a new language.** To teach Shreni about a new programming language — so
its repo map extracts real symbols, its build/test/lint gates run, and `shreni
init` can scaffold it — follow the how-to guide
[docs/guides/add-language-support.md](docs/guides/add-language-support.md). The
architectural seam reference is
[docs/architecture/extension-points.md](docs/architecture/extension-points.md).

## Setting up a Project (Kshetra) in detail

Before running `shreni init-kshetra`, the project git repo must already exist and
have a GitHub remote configured. `init-kshetra` reads the remote URL from the repo
(`git remote get-url origin`) to populate `kshetra.yaml` — it does not create the
project repo for you.

```bash
# Create and push the project repo first (if it doesn't exist yet)
gh repo create <your-org>/myapp --private --clone
cd myapp
git remote -v   # confirm origin is set
```

Then register the project. This is a one-time setup per project:

```bash
shreni init-kshetra --slug myapp --path /projects/myapp
```

This command runs 10 steps automatically:

1. Creates `<your-org>/myapp-beads` on GitHub
2. Clones the beads repo to `/projects/myapp-beads`
3. Initialises the `bd` database (`bd init --stealth`)
4. Creates symlink: `/projects/myapp/.beads → /projects/myapp-beads`
5. Appends `.beads` to `/projects/myapp/.gitignore`
6. Installs Claude Code hooks (`bd setup claude`) — auto-injects project context at session start
7. Generates `.shreni/kshetra.yaml` from the project template
8. Appends a `SHRENI INTEGRATION` section to `CLAUDE.md` defining the interactive session role boundary
9. Scaffolds an empty RAG index placeholder (codebase-search indexing is not yet implemented)
10. Registers the Kshetra with Sthapathi

After init, edit `.shreni/kshetra.yaml` to set your stack and conventions:

```yaml
stack:
  language: typescript
  framework: nextjs
  testRunner: vitest
  linter: eslint

agents:
  provider: claude          # supported provider; codex / gemini are experimental
  model: claude-sonnet-4-6
  maxRoundsPerBead: 3
```

> **Agent providers.** **Claude** (`claude`) is the supported, default provider.
> Adapters for **Codex** (`codex`) and **Gemini** (`gemini`) are wired but
> **experimental** — draft and not verified end-to-end — and ship with no default
> model, so they require an explicit `agents.model`. `shreni init-kshetra` warns
> you if you pick one. If you want a reliable first run, use Claude.

### Config source of truth

There is **exactly one config per Kshetra**, at `<repo>/.shreni/kshetra.yaml`, and
`~/.shreni/registry.json` is the only thing that resolves `id → configPath`. The
`.shreni/` directory is the Kshetra's home for all Shreni-owned assets (the config
plus the `style-guide.md` / `arch.md` conventions docs it references), which keeps
the target repo root clean.

- **Absolute paths only.** `repo.path` and `beads.path` are used verbatim as the
  cwd for git and exec — the loader does **not** expand `~` or resolve relative
  paths. `init` writes absolute paths; `migrate` absolutizes them.
- **Resolution.** `shreni register <dir>` prefers `<dir>/.shreni/kshetra.yaml` and
  falls back to a legacy root `<dir>/kshetra.yaml`.
- **Migrating a legacy layout.** If a project still has a root `kshetra.yaml`, run
  `shreni migrate <dir>` to move it into `.shreni/`, absolutize its paths,
  re-register it, and remove the root file. It is idempotent — safe to re-run.

### Merge policy (push vs pr)

`repo.mergePolicy` decides **where approved work lands** — independently of *when*
the next task starts (that is always driven by the `bd` dependency graph):

| Policy | On APPROVE | Task closes | Use when |
|---|---|---|---|
| `push` (default) | Squash-merge the bead branch straight to `main` and push | Immediately | Solo, high-trust, fastest loop |
| `pr` | Push the branch and open a **pull request** (`bead-…` → `main`); do **not** merge | Only when the PR actually merges | You want a human gate, or a team merge queue |

In `pr` mode the bead is kept **open** (labelled `awaiting-merge`) so anything that
depends on it stays blocked until the code is really on `main`. Sthapathi does not
wait around: it immediately picks the next ready bead branching from the current
`main`. A background reconcile pass closes the bead when its PR merges, or blocks it
for review if the PR is closed unmerged. The Silpi ↔ Viharapala AI review runs in
both modes — `pr` mode adds a human merge gate *on top of* it, it does not replace it.

#### Active PR follow-up loop

An open PR is not left to rot when it draws feedback. On the same background
reconcile pass, Shreni inspects each `awaiting-merge` PR for **unaddressed
feedback** — a failing *required* check, a `CHANGES_REQUESTED` review, or a
foreign commit pushed onto the branch — measured against a per-bead watermark so
the same feedback never re-triggers. When it finds some, it labels the bead
`pr-needs-followup`, and the scheduler routes that bead **back into the single
work slot ahead of fresh `bd ready` work**. There it runs a bounded
Silpi ↔ Viharapala pass over the PR: Silpi pushes the fix and drafts a reply per
comment, Viharapala re-reviews the diff, and Sthapathi owns every side effect —
it pushes **before** it replies (never auto-resolving a human's thread), advances
the watermark, and drops the label. If a comment needs a human decision
(`escalate`) or the round budget runs out (`prFollowupMaxRounds`, reset on each
new human review), the bead is flagged for a human rather than looped forever. The
loop is **on by default** — set `repo.prFollowup: false` or `SHRENI_PR_FOLLOWUP=off`
to disable it. Follow-up state is visible on `shreni status` (the active bead shows
its round) and the Phalaka banner (a `PR follow-up` chip).

Set it at init or in `kshetra.yaml`, and override per run with an env var:

```bash
shreni init-kshetra --slug myapp --path /projects/myapp --merge-policy pr
```

```yaml
repo:
  path: /projects/myapp
  remote: git@github.com:your-org/myapp.git
  mainBranch: main
  mergePolicy: pr        # omit for the default 'push'
```

```bash
SHRENI_MERGE_POLICY=pr shreni start   # runtime override of the config, all Kshetras
```

> `pr` mode uses the `gh` CLI (already a prerequisite) to open and inspect PRs, so
> `gh` must be authenticated for the account that owns the project repo.

### Quality gates (`gates:`)

Every round, after Silpi submits, the harness runs the project's quality gates and
only forwards clean work to Viharapala. The optional `gates:` block in
`kshetra.yaml` controls **how strictly** each gate is enforced — never *what* it
runs:

```yaml
gates:                    # all optional — these are the defaults
  test:     { level: block }
  lint:     { level: block }
  coverage: { level: warn }
  diffSize: { level: warn, maxFiles: 40, maxLines: 1500 }
```

- **Delegate-first.** Gate commands are never restated here — each gate resolves
  its command from the toolchain single-source (`stack.testRunner`,
  `stack.lintCommand`, `stack.coverageCommand`, falling back to the language
  default, e.g. `pnpm test:coverage` on node). To disable a gate, empty its
  command (`coverageCommand: ""`) — a visible skip, never a silent pass. Silpi's
  prompt is injected with the same resolved commands, so the agent iterates
  against exactly what the gate will enforce.
- **`block` vs `warn`.** A failing `block` gate rejects the round with a per-gate
  reason fed back to Silpi; a failing `warn` gate is noted on the bead but does
  not block. Enforcement happens at the dispatch decision point — stronger than a
  bypassable git hook.
- **Additive-stricter only.** The hard `build`/`test`/`lint` gates cannot be
  waived: setting `test` or `lint` to `warn` is clamped back to `block`. Config
  may only tighten (e.g. raise `coverage` to `block`), never loosen.
- **`diffSize`** is the one loop-native guard (no equivalent in the repo's own
  tooling): it caps the bead branch's diff against `main` — a runaway-agent
  tripwire. Defaults are conservative and `warn`-level; raise to `block` if an
  oversized diff must never reach review.

## Running the Harness

### Start / Stop

```bash
shreni start         # start the Sthapathi orchestration loop
shreni stop          # graceful shutdown (waits for active round to finish)
```

Sthapathi polls each registered Kshetra every 30 seconds for ready tasks. P0-priority tasks interrupt the queue immediately.

### Check Status

```bash
shreni status             # current Kshetra (auto-detected from cwd)
shreni status --all       # all Kshetras
shreni agents             # which agent is active per Kshetra and what it's working on
```

### Kshetra States

| State | Meaning | Next action |
|---|---|---|
| `idle` | No pending tasks, loop is running | File a task via `bd create` |
| `running` | Sthapathi is actively processing a bead | Wait, or `shreni agents` for detail |
| `paused` | Manually paused or paused due to an error | `shreni resume --kshetra <slug>` |
| `error` | Unrecoverable state, loop stopped | Check logs, resolve the issue, then `shreni resume` |

### Bead (Task) States

| State | Meaning |
|---|---|
| `pending` | Filed, waiting to be picked up |
| `in_progress` | Claimed by Sthapathi, agents are working on it |
| `blocked` | Exceeded max rounds, or a hard failure occurred — needs human review |
| `complete` | Merged to `main`, `bd close` called |

### Per-Kshetra Controls

```bash
shreni pause --kshetra myapp    # pause without stopping other Kshetras
shreni resume --kshetra myapp   # resume a paused Kshetra
shreni run --kshetra myapp      # force one cycle immediately (useful for testing)
shreni sync --kshetra myapp     # force beads git pull + push
```

### Logs

```bash
shreni logs --kshetra myapp
shreni logs --kshetra myapp --bead bd-f3a2   # logs for a specific bead
shreni logs --all
```

### Phalaka (Local Dashboard)

```bash
shreni phalaka start    # start the local dashboard server
shreni phalaka stop
shreni phalaka status    # server URL
```

Once started, the dashboard is served on loopback (`127.0.0.1`) — open the printed URL in your browser to watch worker status, task progress, and stuck-state alerts across all Kshetras.

## Telemetry (opt-in, anonymous)

Shreni collects **no telemetry by default**. If you opt in, it sends a small,
anonymous signal that helps us understand activation (did a clone reach a first
merged task?) and retention — nothing else.

```bash
shreni telemetry status     # show the current setting
shreni telemetry enable     # opt in (prints exactly what is sent)
shreni telemetry disable    # opt back out any time
```

When enabled, an event carries only: a random anonymous id, the event name
(`session_start`, `kshetra_init`, `task_merged`), the Shreni version, and your OS
platform. It **never** sends your code, file paths, repo names, task contents, or
any personal identifier. Set `DO_NOT_TRACK=1` (or `SHRENI_TELEMETRY=0`) to hard-
disable it regardless of config; `SHRENI_TELEMETRY=1` opts in for one run. Until a
collector endpoint is configured, opted-in events are written to a local file
(`~/.shreni/telemetry-local.jsonl`) and never leave your machine.

## Troubleshooting

Hit a snag? The common failure modes — a stuck task after restart, a rejected
push, a paused Kshetra, `bd` lock contention, and rate limits —
and their recovery steps live in the
**[Troubleshooting guide](docs/guides/troubleshooting.md)**.

## License & Trademark

Shreni's source code is licensed under the [Apache License 2.0](LICENSE) — free to
use, modify, and redistribute, including commercially.

**Shreni™** and **TeakWood™** are trademarks of TeakWood. An open-source license
covers the *code*, not the *name* (Apache-2.0 §6 grants no trademark rights). See
[TRADEMARK.md](TRADEMARK.md) for how you may use the names and logos — short
version: use the software freely; just don't name your fork "Shreni" or imply our
endorsement.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (contributions
are under the Developer Certificate of Origin) and our
[Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see
[SECURITY.md](SECURITY.md).