# Shreni

Automated coding agent harness for your services.

Shreni orchestrates specialised AI agents to pick up structured tasks, write and review code, run tests, and merge approved changes — all without human intervention in the inner loop. You discuss a feature, file a task, and come back to find working code merged into `main`.

> **Does Shreni push to `main` without me reviewing? Yes — by design.** When the
> review agent (Viharapala) approves a change, Sthapathi **squash-merges it
> straight to `main` and pushes** — there is no human pull-request gate in the
> inner loop. You steer by *outcome* — the automated review loop, the green-base
> health gate, and the merged result — not by approving every diff. Every task
> still passes the Silpi ↔ Viharapala AI review before it can merge. If you want a
> human gate, an optional **PR mode** (open a pull request on approval instead of
> merging) is planned for cautious and team setups.

## Architecture

Shreni has five named components:

| Component | Role |
|---|---|
| **Sthapathi** | Orchestrator. Polls `bd` for tasks, manages agent dispatch, drives the Silpi↔Viharapala review loop, and owns the entire task lifecycle and git workflow. |
| **Silpi** | Coding agent. Receives a task (context injected by Sthapathi), writes implementation code and unit tests, runs lint and tests, then submits for review. |
| **Viharapala** | Review agent. Evaluates Silpi's output against acceptance criteria, code quality, and test coverage. Returns `APPROVE` or `REJECT` with structured feedback. |
| **Parikshaka** | Test agent (Sanskrit: examiner). Runs asynchronously after each merge. Writes tests for shipped features and surfaces coverage gaps back to Sthapathi. |
| **Phalaka** | Local dashboard (Sanskrit: panel). Loopback web UI to watch worker status, task progress, and stuck-state alerts across all Kshetras. |

Each project managed by Shreni is a **Kshetra** (Sanskrit: field). A Kshetra has its own git repo, `bd` task database, RAG index, and agent queue. Kshetras are fully isolated — no cross-contamination of context, tasks, or git state.

```
Developer machine
├── Sthapathi (Node.js process)
│   ├── polls bd ready every 30s per Kshetra
│   ├── dispatches Silpi → Viharapala loop (up to 3 rounds)
│   ├── squash-merges approved branches to main
│   └── dispatches E2E agent async post-merge
├── Phalaka server (Fastify, loopback)
│   └── serves the local dashboard at 127.0.0.1
└── Kshetras/
    ├── myapp/          ← project repo
    │   ├── .beads/      ← symlink to myapp-beads/
    │   └── .shreni/kshetra.yaml
    └── myapp-beads/    ← bd Dolt database (git repo)
```

**Key design constraint:** Sthapathi is the sole caller of `bd update --claim` and `bd close`. Agents (Silpi, Viharapala, E2E) never call `bd` directly — they receive task context as injected prompt data. Interactive Claude Code sessions can file tasks (`bd create`) but cannot claim or close them.

> For a deeper walkthrough — the worker lifecycle and phase machine, the git workflow, the provider abstraction, and the watchdog/self-heal resilience machinery — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

- **Node.js** ≥ 20 and **pnpm** (`npm install -g pnpm`)
- **`bd` (Beads) CLI** — `npm install -g @beads/bd`
- **Anthropic API key** — set `ANTHROPIC_API_KEY` in your environment
- **GitHub CLI** (`gh`) — authenticated with access to the GitHub account or org where your projects live

## Installing Shreni

```bash
git clone git@github.com:TeakWood/Shreni.git /projects/shreni
cd /projects/shreni
pnpm install
pnpm build
npm install -g .   # installs the shreni CLI globally
```

Verify:

```bash
shreni --version
```

## Kickstarting a Project (Kshetra)

Before running `shreni init-kshetra`, the project git repo must already exist and have a GitHub remote configured. `init-kshetra` reads the remote URL from the repo (`git remote get-url origin`) to populate `kshetra.yaml` — it does not create the project repo for you.

```bash
# Create and push the project repo first (if it doesn't exist yet)
gh repo create <your-org>/myapp --private --clone
cd myapp
git remote -v   # confirm origin is set
```

Then run `shreni init-kshetra` to register a new project. This is a one-time setup per project.

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

File your first task:

```bash
cd /projects/myapp
bd create "Add user authentication" -p 2 --description "Email + password login with JWT sessions"
```

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