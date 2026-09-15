# What the beads repo tracks

Each Kshetra's beads repo (`<slug>-beads`, symlinked as `.beads/` in the project
repo) is the only **git-tracked, pushed, shareable** store in the system.
Everything under `~/.shreni/kshetra/<id>/` is machine-local and dies with the
laptop. Three feeds live in the beads repo and travel with it:

| File | Written by | What it is | How it lands in git |
|------|-----------|------------|---------------------|
| `issues.jsonl` | bd export pipeline | The **plan**: the dependency graph, acceptance criteria, notes, close reasons. | bd's export + `syncBeads` (`git add -A`) |
| `ledger.jsonl` | Shreni's `ledgerSink` (epic 4a2) | Shreni's **decisions**: claim, rounds + verdicts, gate results, policy decisions, per-run usage, merge, close. Evidence is referenced by `runId`, never inlined. | `syncBeads` (`git add -A`), one commit per sync |
| `interactions.jsonl` | bd | bd's **model of field changes**: an append-only log of status transitions and other field edits, with actor, timestamp, and old/new value. | `syncBeads` (`git add -A`), once the ignore entry is removed (below) |

`ledger.jsonl` and `interactions.jsonl` are **different records and are not merged**:
the ledger is Shreni's model of decisions; interactions is bd's model of field
changes. interactions entries are never folded into `ledger.jsonl`. For the full
audit trail, read `ledger.jsonl` (or `shreni show <bead>`, which joins the plan and
the ledger into one timeline). interactions is a useful supplementary signal, not
the audit trail.

## The interactions.jsonl gitignore (epic 4a2.7)

bd writes the beads repo's `.gitignore` at `bd init` and lists `interactions.jsonl`
among the runtime files to ignore — and bd's export pipeline does **not** carry it
into git (export-state tracks only issues + memories). So by default this real
provenance is thrown away.

Shreni removes that one ignore entry so `git add -A` (in `syncBeads`) starts
tracking the file:

- **New Kshetras** track it from day one: `shreni init` removes the entry right
  after `bd init`, before the initial beads-repo commit.
- **Existing Kshetras**: run `shreni migrate <kshetra-path>`. It removes the entry
  idempotently (safe to re-run) and leaves the rest of bd's `.gitignore` intact.
  It never adds a negation pattern (`!interactions.jsonl`) — bd's `.gitignore`
  warns that negations override the fork protection in `.git/info/exclude`.

The file appears in `git ls-files` after the first sync that follows a bd field
change (bd creates `interactions.jsonl` on the first field change, not at init).

## Concurrency: ledger writes during a sync (accepted risk)

`ledgerSink` appends to `ledger.jsonl` in the beads working tree while `syncBeads`
runs `git add -A` / commit / `git pull --rebase` on the same tree, with no
cross-lock between them. This is a **deliberately accepted risk** (bead 4a2.11),
not an oversight:

- `syncBeads` commits **before** it pulls, so an append that lands during the
  rebase is an uncommitted change that survives to the next sync (deferred, not
  lost) in every case except a sub-millisecond OS-level unlinked-inode edge.
- If the append dirties the tree mid-rebase, the rebase aborts with a non-benign
  error, which `syncBeads` logs and retries next cycle — the entry stays in the
  tree.
- `parseLedgerLines` drops a torn/corrupt line on read.
- The worst case is **one** deferred/lost ledger entry — never `issues.jsonl`
  corruption — and the same event is also in the machine-local `activity.jsonl`.

A cross-module async lock around the pull window was judged disproportionate to
this narrow, self-healing window for a low-volume (O(rounds)) feed. The reasoning
is recorded at the write site (`src/ext/ledger-sink.ts`) and the sync site
(`src/sthapathi/beads.ts`).

### If a bd upgrade re-adds the ignore

bd owns this `.gitignore`, so a future bd version could regenerate it and re-add
the `interactions.jsonl` line. That is expected and not fought — **`shreni migrate
<kshetra-path>` is the recovery**: re-running it re-applies the removal (the
operation is idempotent, so it is always safe to run again). If you notice
`interactions.jsonl` has stopped being tracked after a bd upgrade, run migrate
once more.
