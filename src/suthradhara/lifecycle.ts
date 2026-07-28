import { spawn } from 'child_process';
import { openSync, mkdirSync, existsSync } from 'fs';
import type { KshetraConfig } from '../kshetra/config';
import {
  readSuthradharaPid,
  writeSuthradharaPid,
  clearSuthradharaPid,
  isAlive,
  suthradharaLogPath,
} from './pid';
import { kshetraDir } from '../cli/pid';
import { selfExec, type Launch } from '../cli/self-exec';
import {
  generateSessionId,
  loadSession,
  saveSession,
  SessionNotFoundError,
} from './persistence';
import { newSessionState } from './state';
import {
  createSessionWorktree,
  reapSessionWorktrees,
} from './worktree';

// Detached-process lifecycle for one Suthradhara session, per Kshetra. Mirrors
// the Phalaka precedent: `start` is idempotent on a live PID; `stop` clears a
// stale PID file; `status` reports the running-or-not state without side
// effects.
//
// xa0.3 threads a session id through here so the runner can hydrate Layer-1
// state on boot. Only one live session per Kshetra at a time (the pid file
// enforces it), but each Kshetra accumulates many persisted transcripts —
// `resume <session-id>` re-spawns the runner pointed at a specific one.

export type SessionStartResult =
  | { status: 'started'; kshetraId: string; sessionId: string; pid: number }
  | { status: 'already_running'; kshetraId: string; pid: number };

export type SessionResumeResult =
  | { status: 'resumed'; kshetraId: string; sessionId: string; pid: number }
  | { status: 'already_running'; kshetraId: string; pid: number };

export type SessionStopResult =
  | { status: 'stopped'; kshetraId: string; pid: number }
  | { status: 'not_running'; kshetraId: string }
  | { status: 'stale_pid_cleared'; kshetraId: string };

export interface SessionStatusResult {
  kshetraId: string;
  running: boolean;
  pid: number | null;
  logPath: string;
}

// The lifecycle needs to build the child-process command with a session id
// that's chosen inside startSession. Callers (production and tests) supply a
// factory rather than a fixed Launch so the id can flow through cleanly.
export type LaunchFactory = (sessionId: string) => Launch;

const defaultLaunch: LaunchFactory = (sessionId) =>
  selfExec('__suthradhara-runner', [kshetraIdFromSessionArg(sessionId), sessionId]);

// Session ids are `<kshetraId>-<yyyymmddThhmmss>-<hex>`, so the kshetra id is
// everything up to the trailing timestamp+hex tail. Kept local — no other
// caller needs to parse a session id apart.
function kshetraIdFromSessionArg(sessionId: string): string {
  return sessionId.replace(/-\d{8}T\d{6}-[0-9a-f]{4}$/, '');
}

export async function startSession(
  kshetra: KshetraConfig,
  launchFactory: LaunchFactory = defaultLaunch,
): Promise<SessionStartResult> {
  const existing = readSuthradharaPid(kshetra.id);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId: kshetra.id, pid: existing };
  }

  if (!existsSync(kshetra.repo.path)) {
    throw new Error(
      `Kshetra "${kshetra.id}" repo path does not exist: ${kshetra.repo.path}`,
    );
  }

  // Create the session state on disk before spawning so that `list` sees it
  // immediately and a crash between spawn and first save can't leave the
  // operator with a session id they can't resume.
  const sessionId = generateSessionId(kshetra.id);
  saveSession(newSessionState(sessionId, kshetra.id));

  // Reap any leaked worktree from a prior crashed session (only one runs per
  // Kshetra), then give this session its own detached checkout (ARD §4). The
  // runner — and the interview child that inherits its cwd — reads/greps there,
  // isolated from the build tree at repo.path.
  await reapSessionWorktrees(kshetra);
  const worktreePath = await createSessionWorktree(kshetra, sessionId);

  const pid = spawnRunner(kshetra, launchFactory(sessionId), worktreePath);
  return { status: 'started', kshetraId: kshetra.id, sessionId, pid };
}

// Resume an existing session's transcript. The state file must already exist
// and must belong to this Kshetra; otherwise fail loudly rather than silently
// creating a fresh state under the same id.
export async function resumeSession(
  kshetra: KshetraConfig,
  sessionId: string,
  launchFactory: LaunchFactory = defaultLaunch,
): Promise<SessionResumeResult> {
  const existing = readSuthradharaPid(kshetra.id);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId: kshetra.id, pid: existing };
  }

  if (!existsSync(kshetra.repo.path)) {
    throw new Error(
      `Kshetra "${kshetra.id}" repo path does not exist: ${kshetra.repo.path}`,
    );
  }

  let state;
  try {
    state = loadSession(sessionId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      throw new Error(
        `Cannot resume: session "${sessionId}" not found under ~/.shreni/suthradhara/.`,
      );
    }
    throw err;
  }
  if (state.kshetraId !== kshetra.id) {
    throw new Error(
      `Session "${sessionId}" belongs to kshetra "${state.kshetraId}", not "${kshetra.id}".`,
    );
  }

  // Re-establish the session's worktree (createSessionWorktree removes any stale
  // one at the same path first, so a resume after an unclean stop is safe).
  const worktreePath = await createSessionWorktree(kshetra, sessionId);

  const pid = spawnRunner(kshetra, launchFactory(sessionId), worktreePath);
  return { status: 'resumed', kshetraId: kshetra.id, sessionId, pid };
}

function spawnRunner(kshetra: KshetraConfig, launch: Launch, cwd: string): number {
  mkdirSync(kshetraDir(kshetra.id), { recursive: true });
  const logFd = openSync(suthradharaLogPath(kshetra.id), 'a');

  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd,
  });

  if (child.pid === undefined) {
    throw new Error(`Failed to spawn suthradhara session for "${kshetra.id}"`);
  }

  writeSuthradharaPid(kshetra.id, child.pid);
  child.unref();
  return child.pid;
}

export async function stopSession(
  kshetra: KshetraConfig,
): Promise<SessionStopResult> {
  const kshetraId = kshetra.id;
  const pid = readSuthradharaPid(kshetraId);
  if (pid === null) {
    // No live session, but a crash could still have leaked a worktree — sweep.
    await reapSessionWorktrees(kshetra);
    return { status: 'not_running', kshetraId };
  }

  if (!isAlive(pid)) {
    clearSuthradharaPid(kshetraId);
    await reapSessionWorktrees(kshetra);
    return { status: 'stale_pid_cleared', kshetraId };
  }

  process.kill(pid, 'SIGTERM');
  clearSuthradharaPid(kshetraId);
  // Session over → tear down its worktree (a sweep, since only one runs per
  // Kshetra and stop doesn't carry the session id). Prune reaps admin entries.
  await reapSessionWorktrees(kshetra);
  return { status: 'stopped', kshetraId, pid };
}

export function statusSession(kshetraId: string): SessionStatusResult {
  const pid = readSuthradharaPid(kshetraId);
  const running = pid !== null && isAlive(pid);
  return {
    kshetraId,
    running,
    pid: running ? pid : null,
    logPath: suthradharaLogPath(kshetraId),
  };
}
