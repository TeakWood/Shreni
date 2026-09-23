import { spawn } from 'child_process';
import { openSync, mkdirSync } from 'fs';
import { readPid, isLiveWorker, claimWorkerPid, kshetraDir, workerLogPath } from './pid';
import { selfExec, type Launch } from './self-exec';
import { labelsToArgs } from './labels';

export type StartResult =
  | { status: 'started'; kshetraId: string; pid: number }
  | { status: 'already_running'; kshetraId: string; pid: number };

export function startWorker(
  kshetraId: string,
  // Opaque run labels (epic yrk / Study B2) threaded to the worker as repeatable
  // `--label key=value` args; the worker re-parses them into the lot manifest.
  labels: Record<string, string> = {},
  // Whether --allow-ablation was passed (epic 8wi / Study B1) — threaded to the
  // worker so its defensive ablation guard passes and it records the flag.
  allowAblation = false,
  // Defaults to re-invoking this CLI with the hidden `__worker` subcommand so it
  // works both under node (spawns `node dist/cli/index.js __worker <id> …`) and as
  // a standalone SEA binary (spawns `<binary> __worker <id> …`). Injectable for tests.
  launch: Launch = selfExec('__worker', [
    kshetraId,
    ...labelsToArgs(labels),
    ...(allowAblation ? ['--allow-ablation'] : []),
  ]),
): StartResult {
  // A live worker — a daemon OR a foreground drain/run (Shreni-beads-4w0) — owns
  // the kshetra: never start a second one on the same working tree.
  const existing = readPid(kshetraId);
  if (existing !== null && isLiveWorker(existing)) {
    return { status: 'already_running', kshetraId, pid: existing };
  }

  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  const logFd = openSync(workerLogPath(kshetraId), 'a');
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  if (child.pid === undefined) {
    throw new Error(`Failed to spawn worker process for "${kshetraId}"`);
  }

  // Claim atomically for the child (the child claims its own pid too, so either
  // order lands the same value). If a worker won the race since the check above,
  // back out: kill our child rather than overwrite a live owner's identity.
  const claim = claimWorkerPid(kshetraId, child.pid);
  if (!claim.ok) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    return { status: 'already_running', kshetraId, pid: claim.ownerPid };
  }
  child.unref();

  return { status: 'started', kshetraId, pid: child.pid };
}
