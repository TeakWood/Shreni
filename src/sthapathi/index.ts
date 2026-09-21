import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';
import { canTransition, type Phase } from './lifecycle.js';
import { emit } from './activity-log.js';
import { nowMs, elapsedMs } from './timing.js';
import { parikshakaInFlight } from './parikshaka-tracker.js';

// Worker lifecycle phase. One task at a time is enforced structurally: a cycle
// only starts from IDLE (see runCycle). The legal transitions are formalized in
// lifecycle.ts (canTransition), consulted by setPhase below.
// See the Sthapathi workflow design §4.1.
export type { Phase };

// What a single scheduler cycle did (epic 7h3 / Study B3). `shreni drain` reads
// this to decide whether to re-tick immediately, wait, or begin its exit sequence;
// the daemon's scheduleLoop ignores it (its tick is fire-and-forget through
// setInterval). B3.2 will teach scheduleLoop to re-tick immediately on 'ran'.
//   'ran'      — a task was dispatched to WORKING (whatever its result).
//   'no-work'  — SELECT found nothing ready.
//   'declined' — PREPARE rejected the pick (preflight/health/pause), or the cycle
//                could not start because one was already in flight. This is the
//                failure-backoff path: a caller must NOT re-tick early on it, or a
//                repeatedly-rejecting kshetra spins hot (ARCHITECTURE.md ~L228).
export type CycleOutcome = 'ran' | 'no-work' | 'declined';

export interface SchedulerHooks {
  // SELECT — read-only: choose the next ready task. Must NOT mutate the work tree.
  selectNext(kshetra: KshetraConfig): Promise<Task | null>;
  // PREPARE — the only mutator: claim + set up the work tree. Returns the task to
  // work, or null if it was rejected (preflight/health) and the cycle should idle.
  prepareTask(task: Task, kshetra: KshetraConfig): Promise<Task | null>;
  // WORK — run the agent loop for the prepared task.
  runTask(task: Task, kshetra: KshetraConfig): Promise<void>;
}

export interface Scheduler {
  // One cycle, awaitable, resolving with what it did (epic 7h3). This IS the
  // one-shot tick `shreni drain` awaits — it drives cycles itself rather than
  // firing-and-forgetting through setInterval, so it can act on the outcome.
  runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<CycleOutcome>;
  scheduleLoop(kshetra: KshetraConfig, hooks: SchedulerHooks, intervalMs?: number): () => void;
  start(kshetras: KshetraConfig[], hooks: SchedulerHooks, intervalMs?: number): () => void;
  getActive(kshetraId: string): Task | undefined;
  // True while ANY work for this kshetra is outstanding: a task is dispatched
  // (getActive is set) OR an asynchronous post-merge Parikshaka backfill is still
  // running (epic 7h3). `shreni drain` gates its exit on this being false so it
  // never quits while an agent is still writing test beads.
  isInFlight(kshetraId: string): boolean;
  getPhase(kshetraId: string): Phase;
  // Flush any coalesced idle-poll time as a final phase_changed summary (epic hto /
  // Study A3). Called on worker shutdown so idle accumulated since the last real
  // cycle is still recorded exactly.
  flushPhase(kshetraId: string): void;
}

export const DEFAULT_INTERVAL_MS = 30_000;

export function createScheduler(opts: { onPhase?: (kshetraId: string, phase: Phase) => void } = {}): Scheduler {
  const active = new Map<string, Task>();
  const phase = new Map<string, Phase>();
  // Phase-timing state (epic hto / Study A3). `enteredAt` is the monotonic time
  // the current phase began. Empty polls (IDLE→SELECTING→IDLE, no work) are
  // coalesced: `pendingIdleMs` buffers a just-started poll's idle time until we
  // know whether it found work, and `idleAccum` sums the idle of consecutive empty
  // polls until a real cycle (or shutdown) flushes them as ONE phase_changed.
  const enteredAt = new Map<string, number>();
  const pendingIdleMs = new Map<string, number>();
  const idleAccum = new Map<string, { idleMs: number; polls: number }>();

  function getPhase(kshetraId: string): Phase {
    return phase.get(kshetraId) ?? 'IDLE';
  }

  function emitPhase(kshetraId: string, from: Phase, to: Phase, heldMs: number, polls?: number): void {
    emit({ type: 'phase_changed', kshetra: kshetraId, from, to, heldMs, ...(polls !== undefined ? { polls } : {}) });
  }

  // Emit the coalesced empty-poll idle (if any) as one summary phase_changed. The
  // `polls` count says how many empty polls it folds in; `heldMs` their total idle.
  function flushPhase(kshetraId: string): void {
    const acc = idleAccum.get(kshetraId);
    if (acc && acc.polls > 0) {
      emitPhase(kshetraId, 'IDLE', 'SELECTING', acc.idleMs, acc.polls);
      idleAccum.delete(kshetraId);
    }
  }

  // Record a phase transition as a phase_changed run-log event, coalescing the
  // high-volume empty-poll cycles. `heldMs` is the monotonic time spent in `from`.
  function recordPhaseChange(kshetraId: string, from: Phase, to: Phase, heldMs: number): void {
    // A poll begins: its heldMs is idle time, but we don't yet know if it will
    // find work — buffer it rather than emit.
    if (from === 'IDLE' && to === 'SELECTING') {
      pendingIdleMs.set(kshetraId, heldMs);
      return;
    }
    // Empty poll (found nothing): coalesce the buffered idle into the accumulator
    // instead of emitting; the trailing ~0ms select time isn't worth a per-tick event.
    if (from === 'SELECTING' && to === 'IDLE') {
      const acc = idleAccum.get(kshetraId) ?? { idleMs: 0, polls: 0 };
      acc.idleMs += pendingIdleMs.get(kshetraId) ?? 0;
      acc.polls += 1;
      idleAccum.set(kshetraId, acc);
      pendingIdleMs.delete(kshetraId);
      return;
    }
    // Any other transition is real activity. Flush coalesced empty-poll idle, then
    // (if this is the SELECTING→PREPARING that found work) emit the buffered
    // IDLE→SELECTING for THIS cycle, then this transition.
    flushPhase(kshetraId);
    const buffered = pendingIdleMs.get(kshetraId);
    if (buffered !== undefined && from === 'SELECTING') {
      emitPhase(kshetraId, 'IDLE', 'SELECTING', buffered);
      pendingIdleMs.delete(kshetraId);
    }
    emitPhase(kshetraId, from, to, heldMs);
  }

  // Set the in-memory phase and notify the optional observer (the worker persists
  // it to state.json so `shreni status` / Phalaka can show it cross-process).
  // The transition is validated against the formalized phase machine
  // (lifecycle.ts): an illegal jump is a logic bug — most importantly a
  // write-only latch (a phase with no edge back to IDLE) — so warn loudly, but
  // don't throw. runCycle already owns the hard structural invariant; this is a
  // tripwire (yds.10), not a second gate that could wedge the loop.
  function setPhase(kshetraId: string, p: Phase): void {
    const prev = getPhase(kshetraId);
    // Monotonic time held in the phase we're leaving (epic hto). First set for a
    // kshetra has no start marker → 0.
    const heldMs = enteredAt.has(kshetraId) ? elapsedMs(enteredAt.get(kshetraId)!) : 0;
    if (!canTransition(prev, p)) {
      console.warn(`[sthapathi] illegal phase transition for "${kshetraId}": ${prev} -> ${p}`);
    }
    phase.set(kshetraId, p);
    enteredAt.set(kshetraId, nowMs());
    opts.onPhase?.(kshetraId, p);
    // Emit AFTER the state is updated so a sink observing the phase sees it settled.
    if (prev !== p) recordPhaseChange(kshetraId, prev, p, heldMs);
  }

  // One task at a time is a STRUCTURAL invariant, not an emergent property of
  // several guards: a cycle runs only from IDLE, and the phase is advanced
  // SYNCHRONOUSLY (before the first await) so an overlapping tick for the same
  // Kshetra is an immediate no-op. Crucially, SELECT (read-only) is separated
  // from PREPARE (the only work-tree mutation), so polling for work can never
  // check out main under an in-flight agent — the cause of the off-branch aborts
  //. See the Sthapathi workflow design §4.1–4.2.
  async function runCycle(kshetra: KshetraConfig, hooks: SchedulerHooks): Promise<CycleOutcome> {
    // A cycle already owns this kshetra: report 'declined' (not 'ran') so a caller
    // that re-ticks on 'ran' never spins on a busy kshetra. In practice unreachable
    // — scheduleLoop's single-flight latch and drain's sequential await both keep
    // ticks from overlapping — but the outcome must still be conservative.
    if (getPhase(kshetra.id) !== 'IDLE') return 'declined';
    setPhase(kshetra.id, 'SELECTING');
    try {
      const selected = await hooks.selectNext(kshetra);
      if (!selected) return 'no-work';

      setPhase(kshetra.id, 'PREPARING');
      const prepared = await hooks.prepareTask(selected, kshetra);
      if (!prepared) return 'declined';

      setPhase(kshetra.id, 'WORKING');
      active.set(kshetra.id, prepared);
      await hooks.runTask(prepared, kshetra);
      // A task was dispatched (whatever runTask's own result) — real work happened.
      // A throw from runTask propagates as a rejection through the finally; only the
      // clean path reaches here as 'ran'.
      return 'ran';
    } finally {
      active.delete(kshetra.id);
      setPhase(kshetra.id, 'IDLE');
    }
  }

  function scheduleLoop(
    kshetra: KshetraConfig,
    hooks: SchedulerHooks,
    intervalMs = DEFAULT_INTERVAL_MS,
  ): () => void {
    // Self-rescheduling loop (epic 7h3 / Study B3): each cycle schedules the next
    // one when it settles, with the delay chosen by the OUTCOME —
    //   'ran'  → re-tick immediately (0ms). A task just merged and the next bead
    //            may be ready NOW; the full interval there is pure latency and,
    //            across a multi-bead epic, a systematic per-bead bias against
    //            decomposition (up to one interval lost per bead).
    //   else   → wait the full interval. 'declined' is the failure-backoff path
    //            (ARCHITECTURE.md ~L228 — e.g. the same preflight rejection every
    //            poll); an early re-tick there would spin hot and burn the retry
    //            budget in seconds. 'no-work' has nothing to hurry for. An errored
    //            cycle also backs off a full interval.
    // Single-flight is preserved two ways: the next tick is only ever scheduled
    // AFTER the current cycle resolves (never overlapping), and runCycle still
    // enters only from IDLE. The `inFlight` guard is a belt-and-suspenders no-op
    // against a stray double-fire. An immediate re-tick is still a normal tick.
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delayMs: number): void => {
      if (stopped) return;
      timer = setTimeout(tick, delayMs);
    };

    function tick(): void {
      if (stopped || inFlight) return;
      inFlight = true;
      runCycle(kshetra, hooks)
        .then((outcome) => {
          inFlight = false;
          schedule(outcome === 'ran' ? 0 : intervalMs);
        })
        .catch((err: unknown) => {
          console.error(`[sthapathi] cycle error for "${kshetra.id}":`, err);
          inFlight = false;
          schedule(intervalMs);
        });
    }

    schedule(intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  function start(
    kshetras: KshetraConfig[],
    hooks: SchedulerHooks,
    intervalMs = DEFAULT_INTERVAL_MS,
  ): () => void {
    const stops = kshetras.map(k => scheduleLoop(k, hooks, intervalMs));
    return () => stops.forEach(s => s());
  }

  function getActive(kshetraId: string): Task | undefined {
    return active.get(kshetraId);
  }

  // In flight = a dispatched task OR an outstanding Parikshaka backfill. The
  // backfill is registered (beginParikshaka) inside runTask's merge step, before
  // runCycle's finally clears `active`, so there is no window where both read
  // false while post-merge work is still pending.
  function isInFlight(kshetraId: string): boolean {
    return active.has(kshetraId) || parikshakaInFlight(kshetraId);
  }

  return { runCycle, scheduleLoop, start, getActive, isInFlight, getPhase, flushPhase };
}