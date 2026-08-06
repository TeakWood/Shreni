import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import type { KshetraConfig } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';
import {
  readSuthradharaPid,
  writeSuthradharaPid,
  clearSuthradharaPid,
  isAlive,
  suthradharaLogPath,
} from './pid';
import {
  generateSessionId,
  loadSession,
  saveSession,
  SessionNotFoundError,
} from './persistence';
import { newSessionState, type SessionState } from './state';
import { createSessionWorktree, reapSessionWorktrees } from './worktree';
import { buildPlanningSession, defaultKickoff } from './session';
import { clearHandoff } from './handoff';

// Lifecycle for a launched Claude Code planning session, per Kshetra (epic d3y).
// In the launched-session model Suthradhara no longer runs a detached node
// runner driving a headless-turn REPL — it spawns an INTERACTIVE `claude`
// session in the session worktree and blocks on it. The pid file still enforces
// one live session per Kshetra; the worktree is created fresh per unit (or
// reused for the launcher's "extend" path) and reaped by the control loop.

// A spawned interactive session: its pid, and a `wait` that resolves with the
// exit code once the session ends (clearing the pid file). It deliberately does
// NOT reap the worktree — the launcher control loop owns worktree teardown so an
// "extend" can relaunch into the same checkout.
export interface Spawned {
  pid: number;
  wait: () => Promise<number>;
}

// Seam so tests never launch real claude: given the spec + cwd, return a Spawned.
export type SpawnPlanning = (spec: SpawnSpec, cwd: string) => Spawned;

export interface LaunchResult {
  status: 'launched';
  kshetraId: string;
  sessionId: string;
  claudeSessionId: string;
  worktreePath: string;
  pid: number;
  wait: () => Promise<number>;
}
export interface AlreadyRunning {
  status: 'already_running';
  kshetraId: string;
  pid: number;
}
export type SessionStartResult = LaunchResult | AlreadyRunning;
export type SessionResumeResult = LaunchResult | AlreadyRunning;

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

// Production spawn: attach the interactive session to the operator's terminal
// (stdio inherited) in the worktree, and resolve `wait` when it exits. No
// detach/unref: the caller (the control loop) blocks on `wait`. Pid bookkeeping
// is spawnAndTrack's job, so this only reports the exit code.
function defaultSpawn(spec: SpawnSpec, cwd: string): Spawned {
  const child = spawn(spec.bin, spec.args, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
  });
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn claude planning session (bin: ${spec.bin})`);
  }
  const wait = (): Promise<number> =>
    new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', () => resolve(1));
    });
  return { pid: child.pid, wait };
}

export interface StartOpts {
  // Reuse this existing worktree instead of reaping + creating a fresh one — the
  // launcher's "extend this topic" path keeps the operator on the same branch.
  reuseWorktree?: string;
  // Seed the planning prompt with a prior design doc (the "extend" path).
  extendDocRelPath?: string;
  // Test seams.
  spawn?: SpawnPlanning;
  uuid?: () => string;
}

function guardRunning(kshetra: KshetraConfig): AlreadyRunning | null {
  const existing = readSuthradharaPid(kshetra.id);
  if (existing !== null && isAlive(existing)) {
    return { status: 'already_running', kshetraId: kshetra.id, pid: existing };
  }
  return null;
}

function assertRepoExists(kshetra: KshetraConfig): void {
  if (!existsSync(kshetra.repo.path)) {
    throw new Error(`Kshetra "${kshetra.id}" repo path does not exist: ${kshetra.repo.path}`);
  }
}

// Spawn the session, write its pid, and wrap `wait` so it clears the pid on exit.
function spawnAndTrack(
  kshetra: KshetraConfig,
  spec: SpawnSpec,
  worktreePath: string,
  doSpawn: SpawnPlanning,
): { pid: number; wait: () => Promise<number> } {
  const child = doSpawn(spec, worktreePath);
  writeSuthradharaPid(kshetra.id, child.pid);
  const wait = (): Promise<number> =>
    child.wait().then((code) => {
      if (readSuthradharaPid(kshetra.id) === child.pid) clearSuthradharaPid(kshetra.id);
      return code;
    });
  return { pid: child.pid, wait };
}

// Start a fresh planning unit: (reap +) create the worktree, mint session ids,
// persist the record, and launch an interactive `claude` seeded with the
// planning prompt. Idempotent-guarded on a live pid.
export async function startSession(
  kshetra: KshetraConfig,
  opts: StartOpts = {},
): Promise<SessionStartResult> {
  const running = guardRunning(kshetra);
  if (running) return running;
  assertRepoExists(kshetra);

  const sessionId = generateSessionId(kshetra.id);
  let worktreePath = opts.reuseWorktree;
  if (!worktreePath) {
    await reapSessionWorktrees(kshetra);
    worktreePath = await createSessionWorktree(kshetra, sessionId);
  }
  const claudeSessionId = (opts.uuid ?? randomUUID)();

  const state: SessionState = {
    ...newSessionState(sessionId, kshetra.id),
    claudeSessionId,
    worktreePath,
  };
  saveSession(state);
  clearHandoff(worktreePath); // drop any stale handoff from a prior unit

  const spec = buildPlanningSession({
    kshetra,
    claudeSessionId,
    kickoff: defaultKickoff(Boolean(opts.extendDocRelPath)),
    extendDocRelPath: opts.extendDocRelPath,
  });

  const { pid, wait } = spawnAndTrack(kshetra, spec, worktreePath, opts.spawn ?? defaultSpawn);
  return { status: 'launched', kshetraId: kshetra.id, sessionId, claudeSessionId, worktreePath, pid, wait };
}

// Resume an existing session: reattach to its Claude Code conversation via
// `--resume`. The state file must exist and belong to this Kshetra. A session
// that never launched (no claudeSessionId) is started fresh under its stored id.
export async function resumeSession(
  kshetra: KshetraConfig,
  sessionId: string,
  opts: StartOpts = {},
): Promise<SessionResumeResult> {
  const running = guardRunning(kshetra);
  if (running) return running;
  assertRepoExists(kshetra);

  let state: SessionState;
  try {
    state = loadSession(sessionId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      throw new Error(`Cannot resume: session "${sessionId}" not found under ~/.shreni/suthradhara/.`);
    }
    throw err;
  }
  if (state.kshetraId !== kshetra.id) {
    throw new Error(`Session "${sessionId}" belongs to kshetra "${state.kshetraId}", not "${kshetra.id}".`);
  }

  const worktreePath = await createSessionWorktree(kshetra, sessionId);
  const resume = Boolean(state.claudeSessionId);
  const claudeSessionId = state.claudeSessionId ?? (opts.uuid ?? randomUUID)();
  saveSession({ ...state, worktreePath, claudeSessionId, status: 'active' });

  const spec = buildPlanningSession({
    kshetra,
    claudeSessionId,
    resume,
    kickoff: resume ? undefined : defaultKickoff(false),
  });

  const { pid, wait } = spawnAndTrack(kshetra, spec, worktreePath, opts.spawn ?? defaultSpawn);
  return { status: 'launched', kshetraId: kshetra.id, sessionId, claudeSessionId, worktreePath, pid, wait };
}

// Reap the current worktree(s) for a Kshetra — the control loop calls this when
// the operator chooses "end" or "new story". Exposed so worktree teardown lives
// in one place.
export async function teardownWorktrees(kshetra: KshetraConfig): Promise<void> {
  await reapSessionWorktrees(kshetra);
}

export async function stopSession(kshetra: KshetraConfig): Promise<SessionStopResult> {
  const kshetraId = kshetra.id;
  const pid = readSuthradharaPid(kshetraId);
  if (pid === null) {
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
  await reapSessionWorktrees(kshetra);
  return { status: 'stopped', kshetraId, pid };
}

export function statusSession(kshetraId: string): SessionStatusResult {
  const pid = readSuthradharaPid(kshetraId);
  const running = pid !== null && isAlive(pid);
  return { kshetraId, running, pid: running ? pid : null, logPath: suthradharaLogPath(kshetraId) };
}
