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

// Detached-process lifecycle for one Suthradhara session, per Kshetra. Mirrors
// the Phalaka precedent: `start` is idempotent on a live PID; `stop` clears a
// stale PID file; `status` reports the running-or-not state without side
// effects. The detached child (see cli/suthradhara-runner) writes its own PID
// once it comes up; the parent writes the PID here too so `status` reports
// correctly the moment start returns.

export type SessionStartResult =
  | { status: 'started'; kshetraId: string; pid: number }
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

export function startSession(
  kshetra: KshetraConfig,
  launch: Launch = selfExec('__suthradhara-runner', [kshetra.id]),
): SessionStartResult {
  const existing = readSuthradharaPid(kshetra.id);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId: kshetra.id, pid: existing };
  }

  // Fail loudly before spawning if the target repo is gone — a session whose
  // cwd doesn't exist would exit immediately and confuse the operator.
  if (!existsSync(kshetra.repo.path)) {
    throw new Error(
      `Kshetra "${kshetra.id}" repo path does not exist: ${kshetra.repo.path}`,
    );
  }

  mkdirSync(kshetraDir(kshetra.id), { recursive: true });
  const logFd = openSync(suthradharaLogPath(kshetra.id), 'a');

  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: kshetra.repo.path,
  });

  if (child.pid === undefined) {
    throw new Error(`Failed to spawn suthradhara session for "${kshetra.id}"`);
  }

  writeSuthradharaPid(kshetra.id, child.pid);
  child.unref();

  return { status: 'started', kshetraId: kshetra.id, pid: child.pid };
}

export function stopSession(kshetraId: string): SessionStopResult {
  const pid = readSuthradharaPid(kshetraId);
  if (pid === null) return { status: 'not_running', kshetraId };

  if (!isAlive(pid)) {
    clearSuthradharaPid(kshetraId);
    return { status: 'stale_pid_cleared', kshetraId };
  }

  process.kill(pid, 'SIGTERM');
  clearSuthradharaPid(kshetraId);
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
