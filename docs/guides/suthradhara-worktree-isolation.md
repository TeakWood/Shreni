# Suthradhara worktree isolation (developer guide)

This is a task-oriented guide for developers working on **Suthradhara** (the
intake/planning agent). It explains the per-session git **worktree** that isolates
an intake session from the shared build tree, where those worktrees live, how they
are torn down, and how to recover from a leaked one.

> **Design vs. how-to.** The *why* — the collision analysis, the two-phase plan,
> and the complexity accounting — lives in the ARD,
> `docs/ard/Shreni-ARD-Worktree-Isolation.md` (in the **Shreni-cloud** repo). This
> page is the **do-this-then-that** companion for the code in
> `src/suthradhara/worktree.ts` and its callers. This guide covers **Phase 1
> only** (the Suthradhara intake worktree); per-bead Sthapathi worktrees are the
> deferred Phase 2.

---

## The one thing to understand

Every mutating git operation in a Kshetra runs against a **single shared working
tree** at `kshetra.repo.path`. Before Phase 1, a Suthradhara session ran there
too — so an intake session writing design docs, and its read-only `git
status/diff/show` allowlist, shared a directory with whatever Silpi was editing
mid-build. Two loops, one directory (ARD §1.1, collision #1).

Phase 1 gives each intake session its **own detached checkout**. The interview
subprocess reads and greps *there*, isolated from the build tree — so planning
never observes a build in progress, and the frequent read surface never perturbs
Sthapathi's checkout.

What stays at `repo.path` (deliberately):

- **The design doc.** `writeDesignDoc` writes to `repo.path/.shreni/design/`
  (absolute — cwd-independent), because two downstream consumers require it there:
  Silpi/Viharapala `Read` it via the link stamped into bead descriptions (their
  cwd is `repo.path`), and Suthradhara's own evolve locator scans that directory
  for existing docs. The worktree isolates the interview's **reads**; the single
  design-doc **write** remains canonical at `repo.path` (ARD §4.4 / §10 open
  question, resolved this way for Phase 1).
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

Each worktree is **detached**, pinned to `origin/<mainBranch>` (falling back to
local `<mainBranch>`, then `HEAD`, when origin isn't resolvable — e.g. offline or
a test fixture). `--detach` is correct because **Suthradhara never commits**: it
writes design docs and files beads, so it needs a clean private tree to read from,
not a branch.

---

## Lifecycle

| Event | What happens | Code |
| --- | --- | --- |
| **`shreni suthradhara start`** | Reap any leaked `suthradhara-*` worktree for this Kshetra, create a fresh detached one, spawn the runner with `cwd` = that worktree. | `startSession` → `reapSessionWorktrees` + `createSessionWorktree` (`lifecycle.ts`) |
| **`shreni suthradhara resume <sid>`** | Re-create the session's worktree (removing any stale one at the same path first), spawn the runner there. | `resumeSession` → `createSessionWorktree` |
| **Runner boot** | `git worktree prune` — reaps admin entries whose dir a crash removed. Never touches the live worktree. | `suthradhara-runner.ts` → `pruneWorktrees` |
| **`shreni suthradhara stop`** | SIGTERM the runner, then sweep + prune the Kshetra's `suthradhara-*` worktrees. | `stopSession` → `reapSessionWorktrees` |

Only **one** intake session runs per Kshetra at a time (the pid file enforces it),
which is what makes the broad "remove every `suthradhara-*` dir" sweep safe: any
such dir present at start or stop time is a leak from a dead session.

The interview subprocess (`claude`) inherits the runner's `cwd`, so pointing the
runner at the worktree is what puts the model's Read/Grep and read-only git in the
isolated tree. `SpawnSpec` carries no `cwd`; the inheritance from the detached
runner is the mechanism (`session.ts` / `capture.ts`).

---

## The `BEADS_DIR` invariant

**A worktree does not contain `.beads/`.** The `.beads/` symlink is gitignored, so
a fresh checkout (worktree included) never gets it — cwd-based auto-discovery
would fail from inside a worktree.

The fix, and the invariant to preserve: **always pass an absolute
`BEADS_DIR = kshetra.beads.path`** to any `bd` invocation. The interview/filing
child gets it injected in its env by `buildClaudeSpawn` (`session.ts`); the
server-side commit path already sets it in `commit.ts`. Never rely on the `.beads`
symlink resolving from a worktree — pass the absolute dir (ARD §4.4).

If you add a new `bd` call anywhere on the Suthradhara path, set `BEADS_DIR`
explicitly. A read that "works from the repo root" will silently fail from a
worktree.

---

## Troubleshooting

### A leaked worktree

A crashed or `kill -9`'d session leaves a worktree directory and a
`.git/worktrees/` admin entry.

- **Self-healing.** The next `shreni suthradhara start` for that Kshetra reaps it
  (`reapSessionWorktrees`) before creating a fresh one; a runner boot runs
  `git worktree prune`. You usually don't need to do anything.
- **Manual.** From the Kshetra repo:
  ```bash
  git worktree list                        # see linked worktrees
  git worktree remove <path> --force       # drop a specific one
  git worktree prune                       # reap admin entries for deleted dirs
  rm -rf ~/.shreni/worktrees/<kshetra-id>/suthradhara-*   # last resort: stale dirs
  ```

### `bd` reads fail inside an intake session (`no beads database found`)

The child is running in a worktree with no `.beads` symlink and no `BEADS_DIR`.
Confirm `buildClaudeSpawn` still injects `BEADS_DIR: kshetra.beads.path` into the
child env, and that any new `bd` call on the path sets it too.

### The design doc doesn't appear for Silpi

The doc must be at `repo.path/.shreni/design/<slug>.md` — **not** in the worktree.
Confirm `writeDesignDoc`/`resolveDesignDir` still resolve against
`kshetra.repo.path` (absolute), independent of the runner's cwd. Writing it into
the (ephemeral, torn-down) worktree would strand the link.

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
