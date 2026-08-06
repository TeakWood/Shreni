// Session record for a launched Claude Code planning session (epic d3y). In the
// launched-session model Suthradhara no longer runs its own interview engine, so
// there is no distilled ledger / transcript / rubric to persist — Claude Code
// owns the conversation memory (rehydrated via `claude --resume`). This record is
// deliberately slim: it maps one Suthradhara session id to the Claude Code
// session it drives and the isolated worktree it runs in, plus lifecycle status.
// This file owns the schema; persistence.ts owns the I/O.

// A session is `active` from creation until it is explicitly ended (the operator
// chose "end" in the launcher control loop, or `stop` was called). `ended` is
// kept on disk for the audit/list view rather than deleting the record outright.
export type SessionStatus = 'active' | 'ended';

// Bumped when the on-disk shape changes in a way that isn't a pure additive
// field. loadSession() rejects an unknown version rather than mis-hydrating. v2
// is the launched-session record (the v1 interview-ledger shape is gone).
export const SESSION_STATE_VERSION = 2 as const;

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  id: string;
  kshetraId: string;
  createdAt: string;
  updatedAt: string;
  // The Claude Code session id this planning session drives. Absent until the
  // first launch assigns one (lifecycle passes it via `--session-id`); `resume`
  // re-attaches with `claude --resume <claudeSessionId>`.
  claudeSessionId?: string;
  // The session's isolated worktree checkout (ARD §4) the launched claude runs
  // in. Absent only in the brief window before createSessionWorktree returns.
  worktreePath?: string;
  status: SessionStatus;
}

export function newSessionState(
  id: string,
  kshetraId: string,
  now: string = new Date().toISOString(),
): SessionState {
  return {
    version: SESSION_STATE_VERSION,
    id,
    kshetraId,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };
}
