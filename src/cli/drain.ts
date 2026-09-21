import { loadRegistry } from '../kshetra/registry';
import { bd } from '../sthapathi/beads';
import { parseReadyOutput } from '../sthapathi/pickup';
import { DEFAULT_INTERVAL_MS, type CycleOutcome } from '../sthapathi/index';
import {
  createWorkerRuntime,
  workerPreconditionError,
  type WorkerRuntime,
} from './worker-runtime';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

// `shreni drain` (epic 7h3 / Study B3): run the REAL worker in the foreground
// until every ready bead in scope is worked, then EXIT with a machine-readable
// reason. Unlike `shreni start` (a daemon that never exits) and `shreni run` (one
// bare cycle with none of the worker's machinery), drain is a scripted, unattended
// unit with a defined end and a stated reason for ending — the trial primitive the
// study needs. It reuses the worker runtime verbatim (recover, sync, reconcile,
// watchdog, heartbeat, self-heal) and differs only in the driving loop.
//
// This bead (B3.3) delivers the command, the loop, and the exit sequence. The
// decision-grade CLASSIFICATION (per-bead stall reasons, exit codes 10/11, the
// stdout summary, and the drain_finished ledger entry) is bead B3.4; here the
// result carries the raw open-in-scope bead ids and a coarse reason so B3.4 can
// refine it without reshaping the loop.

export interface DrainOptions {
  labels?: Record<string, string>;
  allowAblation?: boolean;
  // Scope the drain to an epic's subtree; out-of-scope beads are never worked.
  epic?: string;
  // Poll/backoff interval. Defaults to the scheduler's 30s. Injectable for tests.
  intervalMs?: number;
}

export type DrainReason = 'complete' | 'stalled' | 'signal';

export interface DrainResult {
  exitCode: number;
  reason: DrainReason;
  signal?: NodeJS.Signals;
  // Bead ids still OPEN in scope at exit. Empty ⇒ complete (exit 0); non-empty ⇒
  // stalled (exit 10). B3.4 classifies each with a per-bead reason.
  openInScope: string[];
}

// The seam the loop drives, so its control flow is unit-testable without a real
// kshetra, git, or agents. Production wires this from createWorkerRuntime + bd.
export interface DrainDriver {
  runtime: WorkerRuntime;
  // Open (non-closed) beads within scope at the exit point. B3.4 classifies each.
  openInScope(): Promise<string[]>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Recursively collect an epic's subtree (the epic + all descendants) as a set of
// bead ids, walking `bd children` breadth-first. A bead a backfill files DURING
// the drain gets a fresh, unrelated id, so it is correctly out of scope.
export async function collectEpicScope(kshetra: KshetraConfig, epicId: string): Promise<Set<string>> {
  const scope = new Set<string>([epicId]);
  const queue: string[] = [epicId];
  const client = bd(kshetra);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let children: Task[];
    try {
      children = parseReadyOutput(await client.children(parent));
    } catch {
      // A parent with no children (or an unreadable payload) contributes nothing.
      continue;
    }
    for (const child of children) {
      if (!scope.has(child.id)) {
        scope.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return scope;
}

// Drive the drain to completion. Pure control flow over the injected driver — no
// process, git, or bd calls of its own — so every branch (immediate re-tick on a
// completed task, interval backoff on the failure path, the exit sequence, and a
// clean signal stop) is exercised directly by tests.
export async function driveDrain(
  driver: DrainDriver,
  opts: { intervalMs: number; signalled: () => NodeJS.Signals | undefined },
  delay: (ms: number) => Promise<void> = defaultDelay,
): Promise<DrainResult> {
  const { runtime } = driver;
  const { intervalMs, signalled } = opts;
  const runOne = (): Promise<CycleOutcome> => runtime.scheduler.runCycle(runtime.kshetra, runtime.hooks);
  // Async work (an in-flight task or a Parikshaka backfill that may yet file a
  // bead) or a self-heal is still settling — wait one interval before re-checking.
  const settling = (): boolean => runtime.isInFlight() || runtime.isHealing();

  // recoverKshetra MUST run before the first cycle so crash drift is reconciled
  // before any new work is picked up (E3's kill-9 recovery depends on it).
  await runtime.startup();

  while (!signalled()) {
    const outcome = await runOne();
    if (signalled()) break;

    // A task completed — the next bead may be ready NOW. Re-tick immediately
    // (mirrors scheduleLoop's 'ran' fast-path); no interval, no exit check.
    if (outcome === 'ran') continue;
    if (settling()) { await delay(intervalMs); continue; }

    // 'declined' is the failure-backoff path (a preflight/health rejection that
    // repeats every poll). Never hot-loop it: wait the full interval, exactly as
    // the daemon does. Every 'declined' records a stall, so the watchdog will
    // eventually pause the kshetra, turning pickup into 'no-work' and letting the
    // drain conclude 'stalled'. Do NOT run the exit sequence here — a still-ready
    // (unpreparable) bead must not be mistaken for drained.
    if (outcome === 'declined') { await delay(intervalMs); continue; }

    // 'no-work' with nothing in flight → maybe drained. FINAL sync so the ledger
    // (drain's own record) is committed and pushed BEFORE we exit, then ONE probe
    // cycle: a Parikshaka backfill may have filed a bead during the sync. The
    // probe goes through the SAME pause/scope-gated pickup as the loop, so a
    // paused kshetra reads as 'no-work' (→ exit) rather than a raw ready-queue
    // probe that would still list the bead and spin forever.
    await runtime.sync();
    if (signalled()) break;
    const recheck = await runOne();
    if (recheck === 'ran') continue;             // backfill surfaced fresh work
    if (settling()) { await delay(intervalMs); continue; }
    if (recheck === 'declined') { await delay(intervalMs); continue; }
    break;                                        // 'no-work' after the sync → drained
  }

  const signal = signalled();
  if (signal) {
    // A driver kill -9 needs no handling — recovery covers it at the next start.
    // A SIGINT/SIGTERM leaves in-flight work to recovery and exits 130/143.
    return { exitCode: signal === 'SIGINT' ? 130 : 143, reason: 'signal', signal, openInScope: [] };
  }

  // Coarse classification (B3.4 refines): complete when nothing in scope is still
  // open, otherwise stalled. The final sync above already pushed the ledger.
  const openInScope = await driver.openInScope();
  return openInScope.length === 0
    ? { exitCode: 0, reason: 'complete', openInScope }
    : { exitCode: 10, reason: 'stalled', openInScope };
}

// Wire the real driver: the worker runtime + scope-aware bd probes.
async function defaultDriver(kshetra: KshetraConfig, opts: DrainOptions): Promise<DrainDriver> {
  const scope = opts.epic ? await collectEpicScope(kshetra, opts.epic) : undefined;
  const inScope = scope ? (task: Task) => scope.has(task.id) : undefined;
  const runtime = createWorkerRuntime(kshetra, {
    labels: opts.labels,
    allowAblation: opts.allowAblation,
    entrypoint: 'drain',
    inScope,
  });
  const client = bd(kshetra);
  return {
    runtime,
    async openInScope(): Promise<string[]> {
      // "Open" here means NOT closed — the beads a stalled drain must surface.
      // bd's `--status open` is LITERAL (status==open only); the stalled states
      // (in_progress from a crash, blocked behind a needs-human bead, deferred)
      // are separate stored statuses, so they must be named explicitly or a
      // stalled drain would report complete. See `bd list --help` (--status).
      const raw = await client.list({ status: 'open,in_progress,blocked,deferred' });
      const ids = parseReadyOutput(raw).map(t => t.id);
      return scope ? ids.filter(id => scope.has(id)) : ids;
    },
  };
}

export async function runDrain(
  kshetraId: string,
  opts: DrainOptions = {},
  makeDriver: (k: KshetraConfig, o: DrainOptions) => Promise<DrainDriver> = defaultDriver,
  delay: (ms: number) => Promise<void> = defaultDelay,
): Promise<DrainResult> {
  const kshetra = loadRegistry().find((k: KshetraConfig) => k.id === kshetraId);
  if (!kshetra) throw new Error(`Kshetra not found: ${kshetraId}`);

  // Same precondition gate the daemon runs (ablation + credentials); drain throws
  // so the dispatcher exits 1.
  const precondErr = workerPreconditionError(kshetra, opts.allowAblation ?? false);
  if (precondErr) throw new Error(`${kshetraId}: ${precondErr}`);

  const driver = await makeDriver(kshetra, opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // SIGINT/SIGTERM stop cleanly: record the signal so the loop breaks at the next
  // check-point, finishing or leaving the in-flight task to recovery, and exit
  // 130/143. A kill -9 needs no handler — recovery covers it at the next start.
  let signal: NodeJS.Signals | undefined;
  const onSignal = (s: NodeJS.Signals): void => { signal = s; };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const stopTimers = driver.runtime.startTimers();
  try {
    return await driveDrain(driver, { intervalMs, signalled: () => signal }, delay);
  } finally {
    stopTimers();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

// Human-readable one-line result for the CLI (B3.4 replaces this with the full
// summary + --json). Kept minimal here so the command is usable end-to-end now.
export function formatDrainResult(kshetraId: string, result: DrainResult): string {
  switch (result.reason) {
    case 'complete':
      return `drain complete for "${kshetraId}" — every in-scope bead closed (exit 0)`;
    case 'signal':
      return `drain interrupted for "${kshetraId}" by ${result.signal} (exit ${result.exitCode}); state left recoverable`;
    case 'stalled':
      return (
        `drain stalled for "${kshetraId}" — ${result.openInScope.length} bead(s) still open, none ready ` +
        `(exit ${result.exitCode}): ${result.openInScope.join(', ')}`
      );
  }
}
