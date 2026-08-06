# Suthradhara worktree isolation (developer guide)

This is a task-oriented guide for developers working on **Suthradhara** (the
intake/planning agent). It explains the per-session git **worktree** that isolates
an intake session from the shared build tree, where those worktrees live, how they
are torn down, and how to recover from a leaked one.

> **Design vs. how-to.** The *why* — the collision analysis, the two-phase plan,
> and the complexity accounting — lives in the ARD,
> `docs/ard/Shreni-ARD-Worktree-Isolation.md` (in the **Shreni-cloud** repo). This
> page is the **do-this-then-that** companion for the code in
> `src/suthradhara/worktree.ts` and its callers (`src/suthradhara/lifecycle.ts`,
> the control loop in `src/cli/suthradhara.ts`). This guide covers **Phase 1
> only** (the Suthradhara intake worktree); per-bead Sthapathi worktrees are the
> deferred Phase 2.

---

## The one thing to understand

Every mutating git operation in a Kshetra runs against a **single shared working
tree** at `kshetra.repo.path`. Before Phase 1, a Suthradhara session ran there
too — so an intake session reading, greping, and writing design docs shared a
directory with whatever Silpi was editing mid-build. Two loops, one directory
(ARD §1.1, collision #1).

Phase 1 gives each intake session its **own detached checkout**. The interactive
Claude Code session reads, greps, **and writes** *there*, isolated from the build
tree — so planning never observes a build in progress, and its work never perturbs
Sthapathi's checkout.

What now lives **inside the worktree** (the launched-session model):

- **The reads.** `Read`/`Grep`/`Glob` and read-only `git` run in the worktree —
  planning grounds against an isolated checkout of `origin/<mainBranch>`.
- **The design-doc write.** The session writes `.shreni/design/<slug>.md` into the
  worktree (its cwd) at Gate ①. At Gate ② it commits that doc on a
  `suthradhara/<slug>` branch created off the detached worktree HEAD and **pushes
  the branch** to `repo.remote` — it never writes into the shared build tree and
  never merges to `main`. The doc reaches Silpi/Viharapala (whose cwd is
  `repo.path`) only when the **operator merges that branch** (ARD §4.4).

What stays **shared** (not in the worktree):

- **The beads DB.** Filing always targets the one shared dolt DB via an absolute
  `BEADS_DIR` (see below).

---

## Where worktrees live

```
~/.shreni/worktrees/<kshetra-id>/suthradhara-<session-id>
```

The root is **outside** `repo.path` on purpose (ARD §3.1): a worktree directory
must never be an untracked entry *inside* the tracked tree, which would re-create
the very collision it solves. The path is derived by
`sessionWorktreePath(kshetraId, sessionId)` in `src/suthradhara/worktree.ts`; the
`suthradhara-` prefix (`WORKTREE_PREFIX`) is what lets a leak sweep find sessions
without knowing their ids.

Each worktree **starts detached**, pinned to `origin/<mainBranch>` (falling back to
local `<mainBranch>`, then `HEAD`, when origin isn't resolvable — e.g. offline or
a test fixture). It starts detached because a planning session begins with no
branch of its own — it needs a clean private base to read from and to write the
design doc into. At **Gate ②** the session creates a `suthradhara/<slug>` branch
off that detached HEAD, commits the design doc, and pushes it to `repo.remote`
(never merging to `main`); the isolation keeps both its reads and that one doc
commit off the shared build tree.

---

## Lifecycle

| Event | What happens | Code |
| --- | --- | --- |
| **`shreni suthradhara start`** | Reap any leaked `suthradhara-*` worktree for this Kshetra, create a fresh detached one, spawn the **interactive** `claude` session with `cwd` = that worktree, and block on it. | `startSession` → `reapSessionWorktrees` + `createSessionWorktree`, then `spawnAndTrack` (`lifecycle.ts`) |
| **`shreni suthradhara resume <sid>`** | Re-create the session's worktree (removing any stale one at the same path first), spawn the session there via `claude --resume`. | `resumeSession` → `createSessionWorktree` |
| **Control loop `[1]` extend** | Relaunch a fresh `claude` session in the **same** worktree (no reap) so its `suthradhara/<slug>` branch is preserved. | `runPlanningLoop` → `startSession({ reuseWorktree })` (`cli/suthradhara.ts`) |
| **Control loop `[2]` new / `[3]` end** | Reap the Kshetra's `suthradhara-*` worktrees, then start fresh (new) or exit (end). | `runPlanningLoop` → `teardownWorktrees` → `reapSessionWorktrees` |
| **`shreni suthradhara stop`** | SIGTERM the session, then sweep + prune the Kshetra's `suthradhara-*` worktrees. | `stopSession` → `reapSessionWorktrees` |

`git worktree prune` — reaping admin entries whose dir a crash removed, never
touching a live worktree — is **folded into every reap** (`reapSessionWorktrees` /
`removeSessionWorktree` both call `pruneWorktrees`), so there is no separate
runner-boot prune step in the launched-session model.

Only **one** intake session runs per Kshetra at a time (the pid file enforces it),
which is what makes the broad "remove every `suthradhara-*` dir" sweep safe: any
such dir present at start or stop time is a leak from a dead session.

The interactive `claude` session is spawned with `cwd` = the worktree
(`lifecycle.ts` `defaultSpawn`, `stdio` inherited), so the model's Read/Grep, its
design-doc `Write`, and its `bd`/`git` all run in the isolated tree. `SpawnSpec`
carries no `cwd`; `lifecycle.ts` binds it at spawn time (`session.ts` builds the
spec).

---

## The `BEADS_DIR` invariant

**A worktree does not contain `.beads/`.** The `.beads/` symlink is gitignored, so
a fresh checkout (worktree included) never gets it — cwd-based auto-discovery
would fail from inside a worktree.

The fix, and the invariant to preserve: **always pass an absolute
`BEADS_DIR = kshetra.beads.path`** to any `bd` invocation. `buildPlanningSession`
(`session.ts`) injects it into the launched session's env, so every `bd` call — the
grounding reads and the completion-protocol `bd create` / `bd dep add` / `bd export`
the session runs itself — resolves to the one shared dolt DB regardless of cwd.
Never rely on the `.beads` symlink resolving from a worktree — pass the absolute
dir (ARD §4.4).

If you add a new `bd` call anywhere on the Suthradhara path, set `BEADS_DIR`
explicitly. A read that "works from the repo root" will silently fail from a
worktree.

---

## Troubleshooting

### A leaked worktree

A crashed or `kill -9`'d session leaves a worktree directory and a
`.git/worktrees/` admin entry.

- **Self-healing.** The next `shreni suthradhara start` for that Kshetra reaps it
  (`reapSessionWorktrees`, which also `git worktree prune`s) before creating a fresh
  one. You usually don't need to do anything.
- **Manual.** From the Kshetra repo:
  ```bash
  git worktree list                        # see linked worktrees
  git worktree remove <path> --force       # drop a specific one
  git worktree prune                       # reap admin entries for deleted dirs
  rm -rf ~/.shreni/worktrees/<kshetra-id>/suthradhara-*   # last resort: stale dirs
  ```

### `bd` reads fail inside an intake session (`no beads database found`)

The session is running in a worktree with no `.beads` symlink and no `BEADS_DIR`.
Confirm `buildPlanningSession` (`session.ts`) still injects
`BEADS_DIR: kshetra.beads.path` into the session env, and that any new `bd` call on
the path sets it too.

### The design doc doesn't appear for Silpi

In the launched-session model the doc is written **in the worktree** and pushed on
a `suthradhara/<slug>` branch at Gate ②; it reaches `main` — where Silpi/Viharapala
(cwd `repo.path`) read it via the link in the bead description — only when the
**operator merges that branch**. If it is missing for Silpi, the branch has almost
certainly not been merged yet: check `git branch -r` for `suthradhara/<slug>` and
merge it (the launcher printed the merge prompt on session exit). The branch is
pushed, never auto-merged.

### `git worktree add` fails on start

Usually a stale worktree at the same path, or a missing origin ref.
`createSessionWorktree` removes a same-path worktree first and falls back through
`origin/<main>` → `<main>` → `HEAD`, so this is rare; check that
`kshetra.repo.path` is a valid git repo and `kshetra.repo.mainBranch` exists.

---

## See also

- ARD: `docs/ard/Shreni-ARD-Worktree-Isolation.md` (Shreni-cloud) — the full
  rationale, Phase 2, and the complexity ledger.
- `docs/architecture/suthradhara.md` — the intake agent's overall design.
- `src/suthradhara/worktree.ts` — the lifecycle primitives.
