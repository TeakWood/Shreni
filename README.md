# Shreni

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#prerequisites)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

**Shreni turns a backlog into merged code.** You file tasks; a team of AI agents
picks them up, writes and reviews the code, runs the tests, and merges what passes
— on your own machine, using the model you choose. You steer by outcome, not by
babysitting every keystroke.

It is built around three convictions that set it apart from most agent frameworks:

- **Bring your own model.** Shreni drives the provider CLI you already pay for
  (Claude today; Codex/Gemini experimental). No hosted middleman, no per-seat
  markup, no lock-in to one vendor's model.
- **Local-first.** The orchestrator, the git repos, the task database, and the
  dashboard all run on your machine and loopback. Your code never has to leave it.
- **An explicit merge policy.** Shreni is honest about the scariest question up
  front: *does a bot push to `main`?* You decide — auto-merge for speed, or a
  pull-request gate for a human/team sign-off. See [Merge policy](#merge-policy-push-vs-pr).

## How it works

Think of Shreni as a small, tireless engineering team you run locally:

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

## The team, by name (architecture)

Under the hood, each role above has a Sanskrit name — they are the vocabulary you
will see in logs, config, and the dashboard:

| Component | Plain-English role |
|---|---|
| **Sthapathi** (architect) | Orchestrator. Polls `bd` for tasks, dispatches agents, drives the review loop, and owns the task lifecycle and git workflow. |
| **Silpi** (craftsman) | Coding agent. Writes implementation code and unit tests, runs lint and tests, submits for review. |
| **Viharapala** (guardian) | Review agent. Judges Silpi's output against acceptance criteria, quality, and coverage; returns `APPROVE` or `REJECT` with structured feedback. |
| **Parikshaka** (examiner) | Test agent. Runs asynchronously after each merge; backfills tests and surfaces coverage gaps. |
| **Phalaka** (panel) | Local dashboard. Loopback web UI to watch worker status, task progress, and stuck-state alerts. |

Each project managed by Shreni is a **Kshetra** (field) — its own git repo, `bd`
task database, RAG index, and agent queue, fully isolated from every other project.

```
Developer machine
├── Sthapathi (Node.js process)
│   ├── polls bd ready every 30s per Kshetra
│   ├── dispatches Silpi → Viharapala loop (up to 3 rounds)
│   ├── squash-merges approved branches to main (or opens a PR)
│   └── dispatches the test agent async post-merge
├── Phalaka server (Fastify, loopback)
│   └── serves the local dashboard at 127.0.0.1
└── Kshetras/
    ├── myapp/          ← project repo
    │   ├── .beads/      ← symlink to myapp-beads/
    │   └── .shreni/kshetra.yaml
    └── myapp-beads/    ← bd Dolt database (git repo)
```

**Key design constraint:** Sthapathi is the sole caller of `bd update --claim` and
`bd close`. Agents (Silpi, Viharapala, Parikshaka) never call `bd` directly — they
receive task context as injected prompt data. Interactive Claude Code sessions can
file tasks (`bd create`) but cannot claim or close them.

> For a deeper walkthrough — the worker lifecycle and phase machine, the git
> workflow, the provider abstraction, and the watchdog/self-heal resilience
> machinery — see [ARCHITECTURE.md](ARCHITECTURE.md).

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
9. Builds the initial RAG index for codebase search
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

### Harness won't start — `registry.json` missing

```
Error: ~/.shreni/registry.json not found
```

No Kshetras are registered. Either run `shreni init-kshetra` for a new project or `shreni register /path/to/project` for an existing one.

---

### Task stuck in `in_progress` after restart

Sthapathi automatically recovers in-flight tasks on startup by reading `bd` round notes and the git branch state. If a task remains stuck after restart:

```bash
bd show <id>              # read the last round note to see where it stopped
shreni logs --bead <id>   # check harness logs for the error
```

If recovery failed, unblock manually and let Sthapathi retry:

```bash
bd update <id> --unblock
```

---

### Kshetra is paused with `requiresManualResume: true`

This happens after a git failure or `bd` database error. The harness will not auto-resume these.

```bash
shreni status --all                  # identify the paused Kshetra and reason
bd show <blocked-bead-id>            # read the error detail in round notes
# Fix the underlying issue (resolve git conflict, free disk space, etc.)
shreni resume --kshetra <slug>       # clear the pause and restart the loop
```

---

### Push rejected — non-fast-forward

Sthapathi retries once automatically with a pull-rebase. If it fails twice, it blocks the bead and pauses the Kshetra. Resolve manually:

```bash
cd /projects/<slug>
git pull --rebase origin main
git push origin main
shreni resume --kshetra <slug>
bd update <blocked-bead-id> --unblock
```

---

### Merge conflict outside task scope

Silpi touched files it wasn't supposed to. The bead is blocked and the Kshetra is paused for human review.

```bash
bd show <id>                      # see which files conflicted
git diff bead-<id>/<slug>         # inspect Silpi's changes
# Resolve the conflict manually, or close the bead and re-file a cleaner task
bd update <id> --unblock          # let Sthapathi retry
shreni resume --kshetra <slug>
```

---

### Agent output malformed / JSON parse error

Sthapathi retries the round once automatically. If it fails again, the bead is blocked:

```bash
bd show <id>                  # round note shows the parse error detail
bd update <id> --unblock      # let Sthapathi retry from round 1
```

If this recurs for the same task, the task description may be too ambiguous:

```bash
bd update <id> --description "More precise acceptance criteria"
bd update <id> --unblock
```

---

### Anthropic API rate limit (429) or overloaded (529)

Sthapathi retries with exponential backoff (up to 3×, max 60s between retries). If all retries are exhausted, the Kshetra pauses for 5 minutes and auto-resumes. No action is needed unless the outage is prolonged.

---

### `bd` database locked

`bd` uses embedded Dolt which is single-writer. If another process holds the lock:

```bash
lsof +D /projects/<slug>-beads/embeddeddolt   # find the lock holder
# kill the blocking process, then:
shreni resume --kshetra <slug>
```

---

### RAG search returning stale results

The index rebuilds incrementally on every merged bead. To force a full rebuild:

```bash
shreni index rebuild --kshetra <slug>
shreni index status
```

---

### Interactive Claude Code session not seeing project tasks

The `SessionStart` hook (`bd prime`) should run automatically when you open a Claude Code session in the project directory. If it's not firing:

```bash
bd doctor          # check hook installation
bd setup claude    # reinstall the hooks
```

Verify hooks are present in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": ["bd prime"],
    "PreCompact": ["bd prime"]
  }
}
```

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