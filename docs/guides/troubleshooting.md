# Troubleshooting

Common failure modes when running the Shreni harness, and how to recover. Most
issues resolve by reading the blocked task's round notes (`shreni task show <id>`)
and the harness logs, fixing the cause, and giving the work back to Sthapathi.

> A blocked task is moved back to `open` by the lifecycle's `unblock` move, which
> only a developer may make. `shreni task` has no `unblock` subcommand yet, so the
> recovery steps below re-file the work instead: `shreni task cancel <id>` the
> blocked task and `shreni task create` a fresh one (then `shreni task approve` it).
> A task blocked only on its *manual* acceptance checks, whose code already landed,
> is finished with `shreni task confirm <id>`.

## Harness won't start — `registry.json` missing

```
Error: ~/.shreni/registry.json not found
```

No Kshetras are registered. Either run `shreni init --mode kshetra` for a new project or `shreni register /path/to/project` for an existing one.

---

## Harness won't start — "run shreni migrate"

```
<id> has no task graph project: run shreni migrate <id>
```

The Kshetra was set up on the older beads tracker (its `kshetra.yaml` has `beads:`
and no `project:`). Move it onto the task graph:

```bash
# optional, if bd is still installed: refresh the committed export first
bd export -o <beads dir>/issues.jsonl
shreni migrate <id>       # dry run, confirmation, database dump, then the import
```

---

## Database unreachable

```
cannot open the database: …
```

Every Kshetra keeps its tasks in Postgres. A command that needs it fails at once;
a running worker retries a lost connection for a minute, then pauses the Kshetra.

```bash
shreni db check                  # server, login, version, database, pg_dump
# start Postgres (e.g. brew services start postgresql@17), then:
shreni resume --kshetra <slug>
```

---

## Task stuck `claimed` after restart

A claimed task is held under a lease. If its worker dies, the lease expires and the
next poll's sweep puts the task back in the queue — no manual step is needed. A
fresh worker resets the work tree (clean `main`, no stale `bead-*` branches) at
startup. To see where the task stopped:

```bash
shreni task show <id>     # the task, its checks, and its round notes
shreni logs --bead <id>   # check harness logs for the error
```

---

## Kshetra is paused with `requiresManualResume: true`

This happens after a git failure, a lost worker lock, or a database that stayed
unreachable. The harness will not auto-resume these.

```bash
shreni status --all                  # identify the paused Kshetra and reason
shreni task show <blocked-task-id>   # read the error detail in the round notes
# Fix the underlying issue (resolve git conflict, free disk space, start Postgres, etc.)
shreni resume --kshetra <slug>       # clear the pause and restart the loop
```

---

## Push rejected — non-fast-forward

Sthapathi retries once automatically with a pull-rebase. If it fails twice, it flags the task and pauses the Kshetra. Resolve manually:

```bash
cd /projects/<slug>
git pull --rebase origin main
git push origin main
shreni resume --kshetra <slug>
```

Then re-file the blocked task (see the note at the top) if its work didn't land.

---

## Merge conflict outside task scope

Silpi touched files it wasn't supposed to. The task is flagged (blocked) and the Kshetra is paused for human review.

```bash
shreni task show <id>             # see which files conflicted
git diff bead-<id>/<slug>         # inspect Silpi's changes
# Resolve the conflict manually, or cancel the task and file a cleaner one:
shreni task cancel <id> --reason "conflicted outside its scope; re-filed"
shreni task create --title "…" --description "…"
shreni resume --kshetra <slug>
```

---

## Agent output malformed / JSON parse error

Sthapathi retries the round once automatically. If it fails again, the task is flagged:

```bash
shreni task show <id>         # round note shows the parse error detail
```

If this recurs for the same task, the task description may be too ambiguous:
cancel it and file it again with more precise acceptance criteria
(`shreni task create … --check "given … when … then …"`).

---

## Anthropic API rate limit (429) or overloaded (529)

Sthapathi retries with exponential backoff (up to 3×, max 60s between retries). If all retries are exhausted, the Kshetra pauses for 5 minutes and auto-resumes. No action is needed unless the outage is prolonged.

---

## Another worker holds the Kshetra

```
another worker already runs this Kshetra: <host>
```

One worker runs per Kshetra, enforced by a session lock in the database (so it
holds across machines). Stop the other worker (`shreni stop --kshetra <slug>` on
its host). Postgres drops the lock when that worker's connection closes, so a
crashed worker never leaves it behind; then `shreni resume --kshetra <slug>`.

---

## Interactive Claude Code session not seeing project tasks

The `SessionStart` and `PreCompact` hooks run `shreni task prime`, which prints
Shreni's rules for the session and the project's memories. If they're not firing,
reinstall them (and rewrite Shreni's block in the instruction files):

```bash
shreni task setup
```

Verify the hooks are present in the repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "shreni task prime" }] }],
    "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "shreni task prime" }] }]
  }
}
```
