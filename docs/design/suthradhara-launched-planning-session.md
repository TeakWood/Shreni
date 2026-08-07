# Suthradhara: launched Claude Code planning session

## Problem

`suthradhara start` runs its own hand-rolled readline REPL
(`suthradhara-runner.ts`) and puppeteers `claude -p` one headless turn at a time
(`turnloop.ts` → `session.ts` → `capture.ts`), distilling each reply into a
monotonic state ledger (`distill.ts`, `stages.ts`, `rubric.ts`) and filing the
result behind a confirm gate (`confirm.ts` → `commit.ts`). The REPL's terminal
handling is fragile — the `82700c3` "attach TTY" fix still leaves the operator
unable to see their own keystrokes — and the whole server-side interview engine
re-implements an agent loop that Claude Code already is.

## Outcome

`suthradhara start` becomes a **thin launcher**: it sets up the session worktree
(unchanged) and drops the operator into a real **interactive Claude Code
session** seeded with the planning prompt. That session conducts the five-stage
interview *and does the filing itself* — creating beads, writing the design doc,
syncing beads, and pushing the doc branch. A **launcher-owned control loop**
sits above the session so the operator is never left in a free-roaming agent:
each planning unit is one short-lived, single-purpose session, and completion
returns control to a bounded menu.

## Chosen approach

### Runtime flow

1. `suthradhara start <kshetra>` → create the session worktree (as today) →
   spawn `claude` **interactively** (`stdio: 'inherit'`, no `-p`) in that
   worktree, seeded with:
   - `--append-system-prompt` = the planning prompt (reused `ROLE_BOUNDARY` +
     `DESIGN_RULES` + five stages/rubric + `PROPOSAL_SHAPE`, rewritten so the
     session knows *it* files), **minus** the delta protocol.
   - `--model <kshetra.agents.model>`, `BEADS_DIR=<kshetra.beads.path>`,
     `--setting-sources project`, MCP servers wired as today.
   - Full tool access (Read/Grep/Write/Edit/Bash + bd + git) — the operator is
     at the keyboard approving Claude Code's own permission prompts, so the
     grant-on-demand layer is no longer needed.
   - `--resume <claudeSessionId>` when resuming.
2. Operator runs the five-stage interview conversationally.
3. **Gate ① — plan approved**: the session creates the epic + child beads
   (`bd`), writes the design doc to `.shreni/design/<slug>.md` in the worktree,
   and **syncs beads** (`bd export -o` → commit → push to `beads.remote`).
4. **Gate ② — design doc approved**: the session commits the doc and
   **pushes the branch** to `repo.remote` (it does NOT merge to `main`), then
   writes a JSON **handoff record** and exits.

### Launcher control loop

```
loop:
  spawn interactive claude (one planning unit, in a worktree)
  on exit → read handoff → print:
     • summary (epic id, child count, doc path, branch + push URL)
     • "Merge this branch: <url>"   (operator merges manually)
     • menu: [1] extend topic  [2] new story  [3] end
        1 → fresh claude session, seeded with the just-written doc (same worktree+branch)
        2 → fresh worktree + fresh claude session (blank topic, off main)
        3 → teardown (reap worktree, clear pid), exit
```

Properties: a **new claude session per planning unit** (context never bleeds);
the operator **cannot drift** (completion returns to the 3-way menu, not a free
prompt); scoping is by **prompt + short lifecycle**, not tool-stripping (the
session needs Write/bd/git to file, so a hard sandbox is incompatible with
direct filing).

### Handoff contract

The session writes a small JSON handoff (`branch`, `epicId`, `docPath`,
`summary`) to a known worktree path just before exiting; the launcher reads it
to render the summary/menu deterministically. Absent/malformed handoff → the
launcher still shows the menu with a degraded summary.

## Key components & touch-points (real files)

| Change | File(s) |
|--------|---------|
| Slim session record | `src/suthradhara/state.ts`, `persistence.ts` (+tests) |
| Interactive spawn builder | `src/suthradhara/session.ts` |
| Rewrite planning prompt | `src/suthradhara/prompt.ts` |
| Thin interactive runner | `src/cli/suthradhara-runner.ts`, `src/suthradhara/lifecycle.ts` |
| Handoff contract | new `src/suthradhara/handoff.ts` + runner/launcher wiring |
| Launcher control loop + menu | `src/cli/suthradhara.ts` |
| Delete dead engine | `turnloop`, `distill`, `confirm`, `commit`, `decomposition`, `evolve`, `capture`, `rubric`, `grant`, `allowlist`, `interview`, `sessionbead` (+tests) |
| Docs | `docs/architecture/suthradhara.md`, `docs/guides/suthradhara-worktree-isolation.md` |

Config already carries everything the git/beads flow needs: `repo.remote`,
`repo.mainBranch`, `repo.branchPattern`, `beads.path`, `beads.remote`
(`src/kshetra/config.ts`). The interactive `claude` binary resolves via
`resolveBin('SHRENI_CLAUDE_BIN', 'claude')`.

## Alternatives considered

- **Keep the backbone, add a commit tool** the session calls at Stage 5 —
  preserves evolve-in-place dedup and atomic session-bead semantics, but keeps
  the server-side engine we're trying to shed. Rejected: the operator wants the
  session to file directly.
- **Full replace, session files with raw `bd`** (chosen) — deletes the most
  code; loses evolve-in-place dedup and the audit session-bead unless re-taught
  as prompt rules. Accepted trade-off.
- **Front-door only** (claude wrapping the existing turnloop) — two agents, does
  not compose. Rejected.

## Risks

- **Scoping is soft**: a full-tool session could be asked to do unrelated work
  mid-planning; mitigated by the system prompt + short lifecycle, not enforced.
- **Handoff reliance on clean exit**: if the session crashes before writing the
  handoff, the launcher shows a degraded summary (branch still pushed, beads
  still filed — recoverable from `bd`/`git`).
- **Large deletion**: removing the interview engine drops ~12 modules + tests;
  sequenced last, after the launched path works, to avoid a broken mid-state.

## Open questions (deferred)

- "Extend" off an **unmerged** branch accumulates related planning on one branch
  until merge — acceptable default; revisit if it produces unwieldy branches.
- Hard-sandbox variant (session cannot do non-planning work) is out of scope; it
  is incompatible with direct filing.
