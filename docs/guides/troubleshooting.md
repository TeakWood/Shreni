# Troubleshooting

Common failure modes when running the Shreni harness, and how to recover. Most
issues resolve by reading the blocked bead's round note (`bd show <id>`) and then
unblocking so Sthapathi can retry.

## Harness won't start — `registry.json` missing

```
Error: ~/.shreni/registry.json not found
```

No Kshetras are registered. Either run `shreni init-kshetra` for a new project or `shreni register /path/to/project` for an existing one.

---

## Task stuck in `in_progress` after restart

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

## Kshetra is paused with `requiresManualResume: true`

This happens after a git failure or `bd` database error. The harness will not auto-resume these.

```bash
shreni status --all                  # identify the paused Kshetra and reason
bd show <blocked-bead-id>            # read the error detail in round notes
# Fix the underlying issue (resolve git conflict, free disk space, etc.)
shreni resume --kshetra <slug>       # clear the pause and restart the loop
```

---

## Push rejected — non-fast-forward

Sthapathi retries once automatically with a pull-rebase. If it fails twice, it blocks the bead and pauses the Kshetra. Resolve manually:

```bash
cd /projects/<slug>
git pull --rebase origin main
git push origin main
shreni resume --kshetra <slug>
bd update <blocked-bead-id> --unblock
```

---

## Merge conflict outside task scope

Silpi touched files it wasn't supposed to. The bead is blocked and the Kshetra is paused for human review.

```bash
bd show <id>                      # see which files conflicted
git diff bead-<id>/<slug>         # inspect Silpi's changes
# Resolve the conflict manually, or close the bead and re-file a cleaner task
bd update <id> --unblock          # let Sthapathi retry
shreni resume --kshetra <slug>
```

---

## Agent output malformed / JSON parse error

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

## Anthropic API rate limit (429) or overloaded (529)

Sthapathi retries with exponential backoff (up to 3×, max 60s between retries). If all retries are exhausted, the Kshetra pauses for 5 minutes and auto-resumes. No action is needed unless the outage is prolonged.

---

## `bd` database locked

`bd` uses embedded Dolt which is single-writer. If another process holds the lock:

```bash
lsof +D /projects/<slug>-beads/embeddeddolt   # find the lock holder
# kill the blocking process, then:
shreni resume --kshetra <slug>
```

---

## Interactive Claude Code session not seeing project tasks

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
