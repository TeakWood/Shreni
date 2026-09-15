// Stop the beads repo from gitignoring interactions.jsonl (epic 4a2.7).
//
// bd writes the beads repo's .gitignore at `bd init` and lists interactions.jsonl
// among the runtime files to ignore. But interactions.jsonl is real provenance —
// an append-only log of bd field changes (status transitions etc.) with actor,
// timestamp, and old/new value — and bd's export pipeline does NOT carry it into
// git (export-state tracks only issues + memories). So left ignored it is thrown
// away and dies with the laptop. Removing that one ignore line lets `git add -A`
// (syncBeads) start tracking it.
//
// This is NOT the decision ledger (ledger.jsonl, 4a2.1-4a2.6). interactions.jsonl
// is bd's model of field changes; the ledger is Shreni's model of decisions. They
// are kept separate and interactions entries are never folded into ledger.jsonl.
//
// Idempotent so both init (fresh Kshetra) and `shreni migrate` (existing Kshetra,
// and the recovery path if a bd upgrade ever rewrites .gitignore) can call it
// safely and repeatedly.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// The exact bd-written lines for the interactions ignore block. We match on the
// exact entry so nothing else in the bd-managed .gitignore is disturbed.
const IGNORE_LINE = 'interactions.jsonl';
const BD_COMMENT = '# Interactions log (runtime, not versioned)';
// The Shreni marker left in place of the removed entry — explains why the file is
// now tracked and makes the change self-documenting and re-run detectable.
const MARKER = '# interactions.jsonl is tracked by Shreni (epic 4a2.7) — bd field-change provenance';

export type UntrackResult = 'changed' | 'already' | 'no_gitignore';

// Remove the active `interactions.jsonl` ignore entry (and bd's now-stale comment
// above it) from the beads repo's .gitignore, replacing it with a Shreni marker.
// Everything else in the file is left byte-for-byte intact. NEVER adds a negation
// pattern (`!interactions.jsonl`) — bd's .gitignore warns that negations override
// the fork protection in .git/info/exclude.
//
// Returns:
//   'no_gitignore' — no .gitignore in the beads repo (nothing to do)
//   'already'      — no active interactions.jsonl ignore line (fresh or re-run)
//   'changed'      — the entry was present and has been removed
export function untrackInteractions(beadsPath: string): UntrackResult {
  const path = join(beadsPath, '.gitignore');
  if (!existsSync(path)) return 'no_gitignore';

  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');

  // Only an EXACT, uncommented `interactions.jsonl` line is an active ignore.
  if (!lines.some(l => l.trim() === IGNORE_LINE)) return 'already';

  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === IGNORE_LINE) {
      out.push(MARKER); // replace the entry with the self-documenting marker
      continue;
    }
    if (trimmed === BD_COMMENT) continue; // drop bd's now-misleading comment
    out.push(line);
  }
  writeFileSync(path, out.join('\n'), 'utf8');
  return 'changed';
}
