# Beads importer fixtures

- `shreni-beads.jsonl`: a beads export (`issues.jsonl`) of a real project of 457 issues and 33 memories, taken just before three tasks under a parked epic (`2sg.1`, `2sg.4`, `2sg.5` under `2sg`) were deferred themselves. Ids, states, kinds, priorities, labels, edges and times are kept. Every free-text field (titles, descriptions, design notes, acceptance criteria, notes, close reasons) is replaced by a placeholder such as `Title of <id>.`, every memory by `memory-NN` / `Memory NN.`, and every person by `Developer` or `dev@example.com`.
- `bd-ready.json`: the ids `bd ready --limit 1000` listed after loading that export into a scratch beads database with `bd import` (bd 1.0.3).

`beads-import.test.ts` checks that the dry run matches these, and that the files hold only placeholders.
