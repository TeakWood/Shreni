# What a beads repo holds, and what migration reads

Kshetras used to keep their tasks in a separate, git-synced **beads repo**
(`<slug>-beads`, symlinked as `.beads/` in the project repo) driven by the `bd` CLI.
Every Kshetra now runs on the task graph engine (Postgres), and Shreni no longer
runs `bd`, writes to a beads repo, or syncs one. A Kshetra whose config still has
`beads:` and no `project:` can't run until it is moved with `shreni migrate <kshetra>`.

## What the importer reads

`shreni migrate <kshetra>` (and init's Import phase, for a tracker repo with a
`.beads` directory) reads the files committed in the beads directory and never
runs `bd`:

| File | What it is | Imported as |
|------|-----------|-------------|
| `issues.jsonl` | The plan: tasks, the dependency graph, acceptance criteria, notes, close reasons, and `bd remember` memories | Tasks with their own ids, states, dependencies and notes (origin `imported`), and Shreni memories |
| `interactions.jsonl` | bd's append-only log of field changes, when the beads repo tracks it | Past events on those tasks |

The beads repo's `ledger.jsonl` (Shreni's decision ledger from the beads days) is
not imported; it stays in the beads repo's history. New ledger entries go to
`~/.shreni/kshetra/<id>/ledger.jsonl`.

The export is only as fresh as its last commit. **If `bd` is still installed, run
`bd export -o <beads dir>/issues.jsonl` first** so the import sees the latest
state; migrate's preflight says which file it read.

Imported tasks keep their bead ids, so existing `bead-<id>/<slug>` branches and
open PRs still resolve after the move. `shreni migrate <kshetra> --undo` puts the
Kshetra back on its beads config until the first new write on the engine.

## Where things live after the move

| Record | Where |
|--------|-------|
| Tasks, dependencies, claims, notes, history | The task graph, in the database `kshetra.yaml` names (`database:`, or `SHRENI_DATABASE_URL`) |
| Memories (`bd remember` entries) | Shreni's `memories` table; read with `shreni task prime` |
| Decision ledger | `~/.shreni/kshetra/<id>/ledger.jsonl` |
| Run telemetry | `~/.shreni/kshetra/<id>/activity.jsonl`, `usage.jsonl` |

The database is backed up by Shreni's own dumps (`~/.shreni/backups/`), taken
before every import; see [Backups](../architecture/task-lifecycle.md#backups).
