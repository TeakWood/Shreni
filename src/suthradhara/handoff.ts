// The completion handoff (epic d3y). A launched planning session, just before it
// exits, writes a small JSON record of what it filed and pushed; the launcher
// control loop (cli/suthradhara.ts) reads it to render the summary + merge prompt
// and offer the extend/new/end menu. The session and the launcher are separate
// processes with no shared memory, so this file IS the channel between them.
//
// It lives at a fixed, dot-prefixed path in the worktree root. It is transient
// state, never committed — the session's Gate ② `git add` names only the design
// doc, so the handoff never ships. readHandoff is deliberately tolerant: a
// missing or malformed file yields null (a degraded-but-usable menu), never a
// throw — a session that crashed before writing it must not break the launcher.

import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Repo-relative (worktree-root-relative) path the session writes to. Exported so
// prompt.ts can name the exact path in the completion protocol.
export function handoffRelPath(): string {
  return '.suthradhara-handoff.json';
}

// Absolute handoff path inside a given worktree.
export function handoffPath(worktreePath: string): string {
  return join(worktreePath, handoffRelPath());
}

export interface Handoff {
  // The branch the session pushed the design doc on (e.g. suthradhara/<slug>).
  branch: string;
  // The epic bead id the session filed.
  epicId: string;
  // Repo-relative path of the design doc the session wrote.
  docPath: string;
  // One-line summary of what was planned and filed.
  summary: string;
}

// Write the handoff (used by tests; in production the launched claude session
// writes it via its own Write tool per the completion protocol).
export function writeHandoff(worktreePath: string, handoff: Handoff): void {
  writeFileSync(handoffPath(worktreePath), JSON.stringify(handoff, null, 2), 'utf8');
}

// Read + validate the handoff from a worktree. Returns null on any problem
// (absent file, invalid JSON, missing/wrong-typed fields) so the launcher can
// fall back to a degraded summary rather than crashing.
export function readHandoff(worktreePath: string): Handoff | null {
  let raw: string;
  try {
    raw = readFileSync(handoffPath(worktreePath), 'utf8');
  } catch {
    return null; // absent (the common case for a crashed/aborted session)
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  if (!str(p.branch) || !str(p.epicId) || !str(p.docPath) || !str(p.summary)) {
    return null; // missing or wrong-typed field
  }
  return { branch: p.branch, epicId: p.epicId, docPath: p.docPath, summary: p.summary };
}

// Remove a stale handoff before (re)launching a session in a worktree, so a
// read after the new session never returns the previous unit's record. Tolerant
// of an absent file.
export function clearHandoff(worktreePath: string): void {
  try {
    unlinkSync(handoffPath(worktreePath));
  } catch {
    // nothing to clear
  }
}
