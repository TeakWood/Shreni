import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, openSync, closeSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
// shreniDir / kshetraDir live in kshetra/state-locations.ts (the single source
// of truth for every ~/.shreni path). Re-exported here so existing importers of
// '../cli/pid' keep working.
import { shreniDir, kshetraDir } from '../kshetra/state-locations.js';

// Per-kshetra layout under ~/.shreni/kshetra/<id>/:
//   worker.pid       — id of the ONE live worker that owns the kshetra: the
//                      detached daemon (`shreni start`) or a foreground
//                      `shreni drain` / `shreni run` (Shreni-beads-4w0)
//   activity.jsonl   — structured event log (see activity-log.ts)
//   worker.log       — worker stdout/stderr

export { shreniDir, kshetraDir };

export function workerPidPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'worker.pid');
}

export function workerLogPath(kshetraId: string): string {
  return join(kshetraDir(kshetraId), 'worker.log');
}

export function writePid(kshetraId: string, pid: number): void {
  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  writeFileSync(workerPidPath(kshetraId), String(pid), 'utf8');
}

export function readPid(kshetraId: string): number | null {
  try {
    const raw = readFileSync(workerPidPath(kshetraId), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function clearPid(kshetraId: string): void {
  try {
    unlinkSync(workerPidPath(kshetraId));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Worker ownership (Shreni-beads-4w0) ─────────────────────────────────────
// One kshetra, one worker: every worker — the daemon and a foreground drain/run
// alike — CLAIMS worker.pid before it touches the working tree and releases it on
// exit. The pidfile is therefore both what Phalaka/`shreni status` read to show a
// running worker and the lock that refuses a second one. Registration and refusal
// are one mechanism on purpose: a foreground worker that merely wrote its pid
// would overwrite a live daemon's identity.

// Does the OS process `pid` look like a Shreni process? Guards against a stale
// pidfile whose pid the OS has since recycled for something unrelated — that must
// not block a new worker forever. Best-effort: where the command line cannot be
// read (Windows, no `ps`), a live pid is assumed to be ours (refusing is the safe
// side; the refusal message says how to clear it).
export function looksLikeShreniProcess(pid: number): boolean {
  if (pid === process.pid || process.platform === 'win32') return true;
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    // BOTH a Shreni entry point AND a worker subcommand: a bare 'shreni' substring
    // also matches unrelated processes (an editor on a Shreni file, a Claude
    // session whose args name the repo), and a recycled pid landing on one must
    // not block workers — nor invite `shreni stop` to signal it.
    return /\b(__worker|drain|run)\b/.test(cmd) && /shreni|cli[\\/]index\.[jt]s/i.test(cmd);
  } catch {
    return true;
  }
}

// A live worker owns this pid: the process exists AND it is a Shreni process.
export function isLiveWorker(pid: number): boolean {
  return isAlive(pid) && looksLikeShreniProcess(pid);
}

export type ClaimResult = { ok: true } | { ok: false; ownerPid: number };

// Serialise every read-check-write of worker.pid for one kshetra behind an
// O_EXCL lock file, so two workers starting at once cannot both reclaim a stale
// pidfile and both believe they own the kshetra. A lock older than LOCK_STALE_MS
// is a crashed claimer's leftover and is broken. The critical section is a few
// synchronous file ops, so contention waits are milliseconds.
const LOCK_STALE_MS = 10_000;
function withClaimLock<T>(kshetraId: string, fn: () => T): T {
  mkdirSync(kshetraDir(kshetraId), { recursive: true });
  const lock = `${workerPidPath(kshetraId)}.lock`;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch { /* released meanwhile */ }
      if (i > 500) throw new Error(`could not acquire ${lock} — remove it if no Shreni worker is starting`);
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

// Claim the kshetra's worker.pid for `pid`. Succeeds when the file is absent, is
// already `pid`, or names a dead / non-Shreni (recycled) process — a crashed
// worker's stale pidfile never blocks a new one. Fails with the owner's pid when a
// live worker holds it (never overwriting it). Runs under the claim lock; the new
// pidfile is written to a temp file and renamed into place, so a reader outside
// the lock (Phalaka, `shreni status`) never sees a half-written file.
export function claimWorkerPid(kshetraId: string, pid: number, isOwnerLive: (p: number) => boolean = isLiveWorker): ClaimResult {
  return withClaimLock(kshetraId, () => {
    const existing = readPid(kshetraId);
    if (existing === pid) return { ok: true };
    if (existing !== null && isOwnerLive(existing)) return { ok: false, ownerPid: existing };
    const target = workerPidPath(kshetraId);
    const tmp = `${target}.${pid}.tmp`;
    writeFileSync(tmp, String(pid), 'utf8');
    renameSync(tmp, target);
    return { ok: true };
  });
}

// Release worker.pid — only if it still names `pid`, so a worker never deletes a
// successor's claim. Under the claim lock so it cannot race a concurrent claim.
export function releaseWorkerPid(kshetraId: string, pid: number): void {
  try {
    withClaimLock(kshetraId, () => {
      if (readPid(kshetraId) === pid) clearPid(kshetraId);
    });
  } catch {
    // Best-effort on the way out; a leftover pidfile of a dead pid is stale and
    // reclaimable by the next worker.
  }
}

// The refusal a second worker prints (Shreni-beads-4w0).
export function workerOwnedMessage(kshetraId: string, ownerPid: number): string {
  return (
    `kshetra "${kshetraId}" is already owned by a live worker (pid ${ownerPid}). ` +
    `Only one worker may drive a kshetra's working tree. Stop it first — ` +
    `\`shreni stop ${kshetraId}\` for a daemon, or Ctrl-C the running drain — then retry.`
  );
}

// Claim ownership for THIS process for the duration of a foreground worker, with
// an 'exit' backstop so the claim is released however the process ends (normal
// return, process.exit, or a signal handler that exits). Throws the refusal when
// another live worker owns the kshetra. Returns the release function.
export function claimForThisProcess(kshetraId: string): () => void {
  const claim = claimWorkerPid(kshetraId, process.pid);
  if (!claim.ok) throw new Error(workerOwnedMessage(kshetraId, claim.ownerPid));
  const release = (): void => {
    process.removeListener('exit', release);
    releaseWorkerPid(kshetraId, process.pid);
  };
  process.on('exit', release);
  return release;
}
