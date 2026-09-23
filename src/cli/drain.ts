import { loadRegistry } from '../kshetra/registry';
import { bd } from '../sthapathi/beads';
import { parseReadyOutput, rankCandidates } from '../sthapathi/pickup';
import { parentsWithOpenChildren } from '../sthapathi/epics';
import { DEFAULT_INTERVAL_MS, type CycleOutcome } from '../sthapathi/index';
import { emit, getCurrentLotId } from '../sthapathi/activity-log';
import { loadState } from '../kshetra/state';
import {
  createWorkerRuntime,
  workerPreconditionError,
  type WorkerRuntime,
  type WorkerEntrypoint,
} from './worker-runtime';
import { classifyOpenBeads, type StalledBead } from './drain-classify';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';
import { claimForThisProcess } from './pid';

// `shreni drain` (epic 7h3 / Study B3): run the REAL worker in the foreground
// until every ready bead in scope is worked, then EXIT with a machine-readable
// reason. Unlike `shreni start` (a daemon that never exits), drain is a scripted,
// unattended unit with a defined end and a stated reason for ending — the trial
// primitive the study needs. It reuses the worker runtime verbatim (recover, sync,
// reconcile, watchdog, heartbeat, self-heal) and differs only in the driving loop.
//
// `shreni run` is NOT a second execution path: it is `drain --max-cycles 1`
// (Shreni-beads-nhw). It once built its own scheduler + hooks and so skipped every
// wiring the worker runtime performs (ledger sink, persisted phase, heartbeat,
// recovery, timers) — a task it merged left no ledger trail. A cycle cap is a STOP
// CONDITION on this loop, so the one-cycle command gets all of that for free.
//
// B3.3 delivered the command + loop + exit sequence; B3.4 adds the decision-grade
// end: per-bead stall classification, exit codes (0/10/11/130·143), the stdout
// summary (+ --json), and the pushed `drain_finished` ledger record so a stalled
// trial can never be read as a completed one.

export interface DrainOptions {
  labels?: Record<string, string>;
  allowAblation?: boolean;
  // Scope the drain to an epic's subtree; out-of-scope beads are never worked.
  epic?: string;
  // Poll/backoff interval. Defaults to the scheduler's 30s. Injectable for tests.
  intervalMs?: number;
  // Stop after this many scheduler cycles (`--max-cycles <n>`, a positive
  // integer). Unset = no cap. The normal exit sequence still runs on a capped stop.
  maxCycles?: number;
  // Which command started the drain, recorded in the lot manifest. `shreni run`
  // (the one-cycle alias) passes 'run' so its lots stay attributable as such.
  entrypoint?: Exclude<WorkerEntrypoint, 'worker'>;
}

//   complete — every in-scope bead closed (exit 0)
//   stalled  — open beads remain, none workable (exit 10)
//   budget   — the budget policy stopped work (exit 11); a stalled bead's note
//              names the cap
//   capped   — the --max-cycles cap stopped the loop while at least one open
//              bead is still READY, i.e. workable but not reached (exit 12)
//   signal   — SIGINT/SIGTERM interrupted the drain (exit 130/143)
export type DrainReason = 'complete' | 'stalled' | 'budget' | 'capped' | 'signal';

export interface DrainCounts {
  filed: number;   // in-scope beads created during the drain
  merged: number;  // in-scope beads closed during the drain
  open: number;    // in-scope beads still open at exit
}

// What the loop itself produces (classification included). runDrain wraps this
// with the lot/labels/scope/counts summary and the drain_finished record.
export interface DrainCore {
  exitCode: number;
  reason: DrainReason;
  signal?: NodeJS.Signals;
  openInScope: string[];
  stalled: StalledBead[];
}

export interface DrainResult extends DrainCore {
  kshetra: string;
  lotId: string;
  scope: string | null;               // epic id, or null for the whole queue
  labels: Record<string, string>;
  maxCycles: number | null;           // the --max-cycles cap, or null when uncapped
  elapsedMs: number;
  counts: DrainCounts;
  outOfScopeFiled: string[];          // beads filed during the drain OUTSIDE scope
}

// The seam the loop drives, so its control flow is unit-testable without a real
// kshetra, git, or agents. Production wires this from createWorkerRuntime + bd.
export interface DrainDriver {
  runtime: WorkerRuntime;
  // Open (non-closed) beads within scope at the exit point.
  openInScope(): Promise<string[]>;
  // Per-bead stall reason for each open in-scope bead (needs-human, blocked-by,
  // budget, …). A 'budget' category flips the whole drain to exit 11.
  classify(openIds: string[]): Promise<StalledBead[]>;
  // filed/merged/out-of-scope-filed counts over beads touched since `sinceMs`
  // (epoch millis of the drain's start).
  counts(sinceMs: number): Promise<{ filed: number; merged: number; outOfScopeFiled: string[] }>;
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
// completed task, interval backoff on the failure path, the exit sequence, the
// classification, the cycle cap, and a clean signal stop) is exercised directly
// by tests.
//
// `maxCycles` counts EVERY scheduler cycle, including the post-sync probe. When
// the cap is reached the loop stops (skipping any probe) and the normal exit
// sequence runs. On a capped stop a still-READY open bead is expected, not an
// anomaly: it is reclassified 'not-reached', and its presence makes the drain
// 'capped' (exit 12). A capped stop that leaves only unworkable beads is 'stalled'
// (10) and one that leaves none is 'complete' (0), exactly as uncapped.
export async function driveDrain(
  driver: DrainDriver,
  opts: { intervalMs: number; signalled: () => NodeJS.Signals | undefined; maxCycles?: number },
  delay: (ms: number) => Promise<void> = defaultDelay,
): Promise<DrainCore> {
  const { runtime } = driver;
  const { intervalMs, signalled, maxCycles } = opts;
  let cycles = 0;
  const runOne = (): Promise<CycleOutcome> => {
    cycles++;
    return runtime.scheduler.runCycle(runtime.kshetra, runtime.hooks);
  };
  const atCap = (): boolean => maxCycles !== undefined && cycles >= maxCycles;
  // Set when the cap (not the queue) ended the loop.
  let capped = false;
  // Async work (an in-flight task or a Parikshaka backfill that may yet file a
  // bead) or a self-heal is still settling — wait one interval before re-checking.
  const settling = (): boolean => runtime.isInFlight() || runtime.isHealing();

  // recoverKshetra MUST run before the first cycle so crash drift is reconciled
  // before any new work is picked up (E3's kill-9 recovery depends on it).
  await runtime.startup();

  while (!signalled()) {
    const outcome = await runOne();
    if (signalled()) break;

    // Cycle cap reached: stop driving and fall through to the exit sequence.
    if (atCap()) { capped = true; break; }

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

    // 'no-work' with nothing in flight → maybe drained. Sync so accumulated ledger
    // work is committed and pushed, then ONE probe cycle: a Parikshaka backfill may
    // have filed a bead during the sync. The probe goes through the SAME
    // pause/scope-gated pickup as the loop, so a paused kshetra reads as 'no-work'
    // (→ exit) rather than a raw ready-queue probe that would spin forever.
    await runtime.sync();
    if (signalled()) break;
    const recheck = await runOne();
    if (signalled()) break;
    if (atCap()) { capped = true; break; }
    if (recheck === 'ran') continue;             // backfill surfaced fresh work
    if (settling()) { await delay(intervalMs); continue; }
    if (recheck === 'declined') { await delay(intervalMs); continue; }
    break;                                        // 'no-work' after the sync → drained
  }

  // A capped stop may leave async work settling (a Parikshaka backfill still
  // writing test beads, a self-heal). Let it finish before classifying, exactly as
  // the uncapped loop would, so the exit never races an agent still at work.
  while (!signalled() && settling()) await delay(intervalMs);

  const signal = signalled();
  if (signal) {
    // A driver kill -9 needs no handling — recovery covers it at the next start.
    // A SIGINT/SIGTERM leaves in-flight work to recovery and exits 130/143.
    return { exitCode: signal === 'SIGINT' ? 130 : 143, reason: 'signal', signal, openInScope: [], stalled: [] };
  }

  const openInScope = await driver.openInScope();
  if (openInScope.length === 0) {
    return { exitCode: 0, reason: 'complete', openInScope, stalled: [] };
  }
  // Open beads remain → classify each. A budget denial (persisted in a bead's
  // note) flips the whole drain to exit 11; everything else is exit-10 'stalled'.
  // On a capped stop a ready bead was simply not reached: relabel it (it is NOT
  // the "should not happen" anomaly) and let it make the drain 'capped' — unless
  // a budget denial, the more severe signal, is present.
  const classified = await driver.classify(openInScope);
  const stalled = capped
    ? classified.map(s =>
        s.category === 'ready-but-unworked'
          ? { beadId: s.beadId, category: 'not-reached' as const, reason: 'ready — not reached before the --max-cycles cap' }
          : s,
      )
    : classified;
  const budget = stalled.some(s => s.category === 'budget');
  const notReached = stalled.some(s => s.category === 'not-reached');
  const reason: DrainReason = budget ? 'budget' : notReached ? 'capped' : 'stalled';
  return {
    exitCode: reason === 'budget' ? 11 : reason === 'capped' ? 12 : 10,
    reason,
    openInScope,
    stalled,
  };
}

// Non-closed, non-epic bead ids from a `bd list` JSON payload, optionally scoped.
// Epic containers are dropped: an epic is never itself worked (pickup excludes it,
// Shreni-beads-q08) and is closed by Sthapathi only once its children are all
// closed (at the child's close, or by the drain-exit sweep), so counting one would
// report a fully-drained epic as stalled — and it also drops the --epic scope
// root, which is itself an epic. Exported for direct testing.
export function openBeadIds(listJson: string, scope?: Set<string>): string[] {
  const ids = parseReadyOutput(listJson)
    .filter(t => t.type !== 'epic')
    .map(t => t.id);
  return scope ? ids.filter(id => scope.has(id)) : ids;
}

// Wire the real driver: the worker runtime + scope-aware bd probes.
async function defaultDriver(kshetra: KshetraConfig, opts: DrainOptions): Promise<DrainDriver> {
  const scope = opts.epic ? await collectEpicScope(kshetra, opts.epic) : undefined;
  const inScope = scope ? (task: Task) => scope.has(task.id) : undefined;
  const runtime = createWorkerRuntime(kshetra, {
    labels: opts.labels,
    allowAblation: opts.allowAblation,
    entrypoint: opts.entrypoint ?? 'drain',
    inScope,
  });
  const client = bd(kshetra);
  const idsInScope = (tasks: Task[]): string[] =>
    (scope ? tasks.filter(t => scope.has(t.id)) : tasks).map(t => t.id);
  return {
    runtime,
    async openInScope(): Promise<string[]> {
      // "Open" here means NOT closed — the beads a stalled drain must surface.
      // bd's `--status open` is LITERAL (status==open only); the stalled states
      // (in_progress from a crash, blocked behind a needs-human bead, deferred)
      // are separate stored statuses, so they must be named explicitly or a
      // stalled drain would report complete. See `bd list --help` (--status).
      // `all`: bd list caps at 50 rows by default — a large kshetra would under-count.
      const raw = await client.list({ status: 'open,in_progress,blocked,deferred', all: true });
      // Exclude epic containers: an epic is never itself worked (pickup excludes
      // it, q08) and may still be open here — the drain-exit sweep that closes it
      // runs after this — so counting it would report a fully-drained epic as
      // stalled. This also drops the --epic scope root, which is itself an epic.
      const beads = parseReadyOutput(raw).filter(t => t.type !== 'epic');
      return idsInScope(beads);
    },
    async classify(openIds: string[]): Promise<StalledBead[]> {
      // ANY pause (manual or watchdog-escalated) explains an unworked bead — read
      // the raw flag, not isKshetraManuallyPaused (which requires manual resume).
      const paused = loadState().kshetras[kshetra.id]?.paused === true;
      // "Ready" means what PICKUP would select (q08): rankCandidates drops epics
      // and session beads, and a parent with open children is skipped by pickup's
      // structural guard — so neither may read as the "ready but unworked"
      // anomaly.
      // One bd list yields every parent-with-open-children at once. If it fails,
      // no ready bead is excluded (the pre-q08 behaviour) — classification only.
      let parents = new Set<string>();
      try { parents = await parentsWithOpenChildren(kshetra); } catch { /* classify without it */ }
      const readyIds = new Set(
        idsInScope(rankCandidates(parseReadyOutput(await client.ready()))).filter(id => !parents.has(id)),
      );
      return classifyOpenBeads(kshetra, openIds, { paused, readyIds });
    },
    async counts(sinceMs: number): Promise<{ filed: number; merged: number; outOfScopeFiled: string[] }> {
      // One list over ALL statuses; parseReadyOutput drops the timestamps, so parse
      // the payload directly here. Compare on PARSED epoch millis, not the raw
      // strings: bd's created_at/closed_at are second-granular ('…:28Z') while a
      // drain starts at ms precision, so a lexical string compare would count a
      // bead created earlier in the same wall-clock second as "during the drain".
      const raw = await client.list({ status: 'open,in_progress,blocked,deferred,closed', all: true });
      let arr: unknown;
      try { arr = JSON.parse(raw); } catch { arr = []; }
      const rows: Record<string, unknown>[] = Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
      const atOrAfter = (v: unknown): boolean => {
        if (typeof v !== 'string' || v === '') return false;
        const t = Date.parse(v);
        return !Number.isNaN(t) && t >= sinceMs;
      };
      let filed = 0;
      let merged = 0;
      const outOfScopeFiled: string[] = [];
      for (const r of rows) {
        const id = typeof r.id === 'string' ? r.id : '';
        if (!id) continue;
        const inScope = !scope || scope.has(id);
        if (atOrAfter(r.created_at)) {
          if (inScope) filed++;
          else outOfScopeFiled.push(id);
        }
        // An epic is a container, never merged work (q08) — its auto-close at the
        // end of its subtree must not inflate the merged count.
        if (atOrAfter(r.closed_at) && inScope && r.issue_type !== 'epic') merged++;
      }
      return { filed, merged, outOfScopeFiled };
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
  if (opts.maxCycles !== undefined && !(Number.isInteger(opts.maxCycles) && opts.maxCycles >= 1)) {
    throw new Error(`Invalid max cycles "${opts.maxCycles}": expected a positive integer.`);
  }

  // One kshetra, one worker (Shreni-beads-4w0): claim worker.pid BEFORE building
  // the runtime, so a drain started on a kshetra a daemon (or another drain) is
  // already working is refused before it can touch the shared working tree. The
  // claim is also what makes this foreground worker visible to Phalaka and
  // `shreni status`. Held for the whole drain and released however it ends
  // (return, throw, or a signal-ended drain; an 'exit' backstop covers the rest).
  const releaseOwnership = claimForThisProcess(kshetraId);
  try {
    return await runOwnedDrain(kshetra, opts, makeDriver, delay);
  } finally {
    releaseOwnership();
  }
}

// The drain proper, run while this process owns the kshetra (see runDrain).
async function runOwnedDrain(
  kshetra: KshetraConfig,
  opts: DrainOptions,
  makeDriver: (k: KshetraConfig, o: DrainOptions) => Promise<DrainDriver>,
  delay: (ms: number) => Promise<void>,
): Promise<DrainResult> {
  const kshetraId = kshetra.id;
  const driver = await makeDriver(kshetra, opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAtMs = Date.now();

  // SIGINT/SIGTERM stop cleanly: record the signal so the loop breaks at the next
  // check-point, finishing or leaving the in-flight task to recovery, and exit
  // 130/143. A kill -9 needs no handler — recovery covers it at the next start.
  let signal: NodeJS.Signals | undefined;
  const onSigint = (): void => { signal = 'SIGINT'; };
  const onSigterm = (): void => { signal = 'SIGTERM'; };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const stopTimers = driver.runtime.startTimers();
  try {
    const core = await driveDrain(
      driver,
      { intervalMs, signalled: () => signal, maxCycles: opts.maxCycles },
      delay,
    );
    // Drain-exit epic sweep (Shreni-beads-q08): an --epic scope root (or any epic)
    // whose subtree just finished is closed here — never worked, so nothing else
    // would. Skipped on a signal (state is left to recovery; the next startup's
    // sweep covers it). Its closes ride the FINAL sync below. Epics are excluded
    // from openInScope and from the merged count, so this never shifts the
    // drain's classification.
    if (core.reason !== 'signal') await driver.runtime.sweepEpics();
    const cnt =
      core.reason === 'signal'
        ? { filed: 0, merged: 0, outOfScopeFiled: [] }
        : await driver.counts(startedAtMs);
    const result: DrainResult = {
      ...core,
      kshetra: kshetraId,
      lotId: getCurrentLotId(kshetraId),
      scope: opts.epic ?? null,
      labels: opts.labels ?? {},
      maxCycles: opts.maxCycles ?? null,
      elapsedMs: Date.now() - startedAtMs,
      counts: { filed: cnt.filed, merged: cnt.merged, open: core.openInScope.length },
      outOfScopeFiled: cnt.outOfScopeFiled,
    };
    // Record the decision-grade outcome and PUSH it before returning — for the
    // classified outcomes only. On a signal we leave state to recovery and do not
    // touch the ledger (the process is being torn down).
    if (core.reason !== 'signal') {
      emit({
        type: 'drain_finished',
        kshetra: kshetraId,
        lotId: result.lotId,
        reason: result.reason,
        scope: result.scope,
        exitCode: result.exitCode,
        counts: result.counts,
        stalled: result.stalled.map(s => ({ beadId: s.beadId, reason: s.reason })),
        outOfScopeFiled: result.outOfScopeFiled,
        ...(result.maxCycles !== null ? { maxCycles: result.maxCycles } : {}),
      });
      // FINAL sync: the drain_finished record reaches the git-tracked ledger
      // BEFORE the process exits — a trial's outcome belongs in the pushed store.
      await driver.runtime.sync();
    }
    return result;
  } finally {
    stopTimers();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

// The machine-readable summary (--json). Every field of the text summary so a
// script never has to parse prose.
export function drainResultJson(result: DrainResult): string {
  return JSON.stringify(
    {
      kshetra: result.kshetra,
      lotId: result.lotId,
      reason: result.reason,
      exitCode: result.exitCode,
      scope: result.scope,
      labels: result.labels,
      maxCycles: result.maxCycles,
      elapsedMs: result.elapsedMs,
      counts: result.counts,
      stalled: result.stalled.map(s => ({ beadId: s.beadId, category: s.category, reason: s.reason })),
      outOfScopeFiled: result.outOfScopeFiled,
      ...(result.signal ? { signal: result.signal } : {}),
    },
    null,
    2,
  );
}

// Human-readable multi-line summary for the console.
export function formatDrainResult(result: DrainResult): string {
  const lot = result.lotId ? result.lotId.slice(0, 8) : '(none)';
  const labelStr = Object.entries(result.labels).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
  const head =
    result.reason === 'signal'
      ? `drain interrupted for "${result.kshetra}" by ${result.signal} (exit ${result.exitCode}); state left recoverable`
      : result.reason === 'complete'
        ? `drain complete for "${result.kshetra}" — every in-scope bead closed (exit ${result.exitCode})`
        : result.reason === 'budget'
          ? `drain stopped for "${result.kshetra}" — budget policy denied work (exit ${result.exitCode})`
          : result.reason === 'capped'
            ? `drain stopped for "${result.kshetra}" after ${result.maxCycles} cycle(s) (--max-cycles) — ${result.counts.open} bead(s) still open (exit ${result.exitCode})`
            : `drain stalled for "${result.kshetra}" — ${result.counts.open} bead(s) open, none workable (exit ${result.exitCode})`;
  const lines = [
    head,
    `  lot ${lot} · scope ${result.scope ?? 'all'} · labels ${labelStr} · elapsed ${Math.round(result.elapsedMs / 1000)}s`,
    `  filed ${result.counts.filed} · merged ${result.counts.merged} · open ${result.counts.open}`,
  ];
  if (result.stalled.length > 0) {
    lines.push('  stalled beads:');
    for (const s of result.stalled) lines.push(`    ${s.beadId} — ${s.reason}`);
  }
  if (result.outOfScopeFiled.length > 0) {
    lines.push(`  out-of-scope beads filed: ${result.outOfScopeFiled.join(', ')}`);
  }
  return lines.join('\n');
}
