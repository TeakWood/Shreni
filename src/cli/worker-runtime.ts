import { createScheduler, type Scheduler, type SchedulerHooks } from '../sthapathi/index';
import { preFlightFresh, PreFlightError, BaseRedError } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError, AgentAbortedError } from '../sthapathi/errors';
import { resetWorkTree } from '../sthapathi/recover';
import { untrackCommittedRepoMap } from '../sthapathi/repo-map-migration';
import { runWatchdogOnce } from '../sthapathi/watchdog';
import { branchName } from '../sthapathi/branch';
import { touchHeartbeat, emitLotManifest } from '../sthapathi/activity-log';
import { collectLotManifest } from '../sthapathi/lot-manifest';
import { shouldSelfHeal, type ActiveRun, type PauseSnapshot } from '../sthapathi/self-heal';
import {
  clearStuckPauseOnRecover,
  isKshetraManuallyPaused,
  loadState,
  pauseKshetra,
  recordStall,
  setPhase,
  setAblations,
} from '../kshetra/state';
import { reconcilePullRequests } from '../sthapathi/merge';
import { runPrFollowupTask } from '../sthapathi/pr-followup-run';
import { loadExtension, DEFAULT_EXT_MODULE } from '../ext/loader';
import {
  extensionCore,
  getPolicySource,
  makeBudgetPolicy,
  makeLedgerSink,
  extensionSeamsSnapshot,
} from '../ext/index';
import { findRoleCredentialGaps } from './provider-preflight';
import { ablationGuardError, ablationBanner, activeAblations } from '../kshetra/ablation';
import { NotMigratedError, type KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import { ledgerPath } from '../kshetra/state-locations';
import { EngineQueue, takeWorkerLock, UNAVAILABLE_RETRY_MS, WorkerLockHeld, workerName } from '../policy/sthapathi/leases';
import { Unavailable, type ActorHandle, type ProjectHandle, type Release } from '../taskgraph';
import { engineHooks } from '../policy/sthapathi/hooks';
import { engineTaskStore } from '../policy/sthapathi/task-store';
import { reconcileContainers } from '../policy/sthapathi/epics';
import { registerEngineStore, unregisterEngineStore, type EngineTaskStore } from '../sthapathi/task-store';
import { git } from '../sthapathi/git';
import { sql } from 'kysely';
import { lifecycleGap, lifecycleGapMessage } from './task';

// The worker runtime, factored out of src/cli/worker.ts (epic 7h3 / Study B3) so
// the daemon (`shreni start` → `__worker`) and `shreni drain` share ONE copy of
// the real machinery: the scheduler + hooks, self-heal, the startup sequence
// (extension load, ledger sink, budget policy, lot manifest, the engine and its
// worker lock, work-tree reset, reconcile), and the background timers (PR
// reconcile, watchdog, heartbeat, resume-watch). The only difference between the two callers
// is the DRIVING loop: the daemon arms `scheduler.scheduleLoop` and never exits;
// drain drives `scheduler.runCycle` itself so it can read each cycle's outcome and
// run an exit sequence. This is the ONLY place a scheduler is built for real work:
// `shreni run` is `drain --max-cycles 1`, not a loop of its own (Shreni-beads-nhw),
// so nothing can dispatch agents while skipping the ledger sink, persisted phase,
// heartbeat, recovery, or timers wired here. src/cli/single-scheduler.test.ts
// guards against a second createScheduler() call site returning.

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const RESUME_WATCH_INTERVAL_MS = 5 * 1000;

// 'run' is `shreni run`, a one-cycle drain (Shreni-beads-nhw) — same runtime.
/**
 * The project is on another lifecycle version than this worker runs: an older
 * one is moved by shreni task upgrade, a newer one needs a newer Shreni.
 */
export class LifecycleBehind extends Error {
  constructor(id: string, gap: { on: string; runs: string; newer: boolean }) {
    super(gap.newer
      ? `${lifecycleGapMessage(id, gap)}, then shreni resume --kshetra ${id}`
      : `${lifecycleGapMessage(id, gap)}; run shreni task upgrade in its repo, then shreni resume --kshetra ${id}`);
    this.name = 'LifecycleBehind';
  }
}

export type WorkerEntrypoint = 'worker' | 'drain' | 'run';

export interface WorkerRuntimeOptions {
  // Opaque run labels (epic yrk / Study B2), forwarded to the lot manifest.
  labels?: Record<string, string>;
  // Whether --allow-ablation was passed (epic 8wi / Study B1).
  allowAblation?: boolean;
  // Distinguishes the daemon from drain in the lot manifest + log lines.
  entrypoint: WorkerEntrypoint;
  // Optional scope (epic 7h3): `shreni drain --epic <id>` restricts claims to
  // the epic's subtree so only in-scope tasks are worked. Omitted for the
  // daemon and an unscoped drain — the whole ready queue is fair game.
  scopeEpic?: string;
}

export interface WorkerRuntime {
  readonly kshetra: KshetraConfig;
  /** Closes the engine's connections (dropping the worker lock). */
  close(): Promise<void>;
  readonly scheduler: Scheduler;
  readonly hooks: SchedulerHooks;
  /** The startup sequence — MUST complete before the first cycle is driven, so
   *  the work tree is reset and PRs reconciled before any new work is claimed. */
  startup(): Promise<void>;
  /** Complete every container whose children have settled (Shreni-beads-q08).
   *  Run by startup and at drain exit; idempotent, never throws. Returns the
   *  ids completed. */
  sweepEpics(): Promise<string[]>;
  /** Arm the background timers; returns a stop function that clears them all and
   *  flushes any coalesced idle-poll phase time. */
  startTimers(): () => void;
  /** True while a task is dispatched OR a Parikshaka backfill is outstanding. */
  isInFlight(): boolean;
  /** True while a self-heal (abort + RECOVER of a hung run) is in progress. */
  isHealing(): boolean;
  /**
   * Called when someone else's write to the project may have made work ready
   * (engine spec, "Events and history"): the daemon wakes its poll loop with it.
   * The worker's own writes never call it, so a refused claim can't spin.
   */
  onWake(fn: () => void): void;
}

// The precondition guards `shreni start`/drain both run before building a
// runtime: the defensive ablation gate (a copied config must not silently weaken
// a real repo) and the per-role credential preflight. Returns the first error
// message, or null when the kshetra is clear to run. Kept as a returned string
// (not a throw) so each caller reports it its own way — the daemon logs + exits
// 1, drain throws so the dispatcher exits 1.
export function workerPreconditionError(kshetra: KshetraConfig, allowAblation: boolean): string | null {
  // A Kshetra with no project is still on beads, which no worker runs.
  if (!kshetra.project) return new NotMigratedError(kshetra.id).message;
  const ablationErr = ablationGuardError(kshetra, allowAblation);
  if (ablationErr) return ablationErr;
  const gaps = findRoleCredentialGaps(kshetra);
  if (gaps.length > 0) {
    return `cannot start — missing provider credentials:\n${gaps.map(g => `  • ${g.message}`).join('\n')}`;
  }
  return null;
}

export function createWorkerRuntime(
  kshetra: KshetraConfig,
  options: WorkerRuntimeOptions,
): WorkerRuntime {
  const { entrypoint } = options;
  const labels = options.labels ?? {};
  const allowAblation = options.allowAblation ?? false;
  const logTag = `[shreni ${entrypoint}:${kshetra.id}]`;
  const log = (msg: string): void => console.log(`${logTag} ${msg}`);
  const logErr = (msg: string, err?: unknown): void =>
    err === undefined ? console.error(`${logTag} ${msg}`) : console.error(`${logTag} ${msg}`, err);

  // Persist the phase so `shreni status` / Phalaka can show it cross-process, and
  // refresh the heartbeat the instant a non-IDLE phase begins so the watchdog's
  // liveness window starts fresh at the moment work begins.
  const scheduler = createScheduler({
    onPhase: (_id, phase) => {
      setPhase(kshetra, phase);
      if (phase !== 'IDLE') touchHeartbeat(kshetra.id);
    },
  });

  // The single in-flight run's cancellation handle + a promise that resolves once
  // it has fully unwound, and the gate the self-heal holds while RECOVER runs so
  // no poll cycle mutates the work tree underneath it.
  let activeRun: ActiveRun | undefined;
  let healing = false;

  // The Kshetra is worked through the task graph engine's claims and leases
  // (policy spec, "Running work"). Opened in startup; until then, and if
  // opening failed, it picks up nothing.
  let engine: {
    conn: KshetraEngine; hooks: ReturnType<typeof engineHooks>; queue: EngineQueue; lock: Release;
    tg: ProjectHandle; as: ActorHandle; unsubscribe?: () => Promise<void>;
  } | undefined;
  let wake: (() => void) | undefined;
  // When opening the engine first failed, for the retry window (policy spec, "The database").
  let engineDownSince: number | undefined;

  /**
   * The engine, opening it if startup couldn't. If it stays unreachable past
   * the retry window, pauses the Kshetra for a manual resume. Also checks the
   * worker lock is still this worker's: a dropped session connection loses it.
   */
  async function ensureEngine(k: KshetraConfig): Promise<typeof engine> {
    if (engine) {
      if (await engine.lock.held()) return engine;
      logErr('the worker lock was lost (the session connection dropped); pausing');
      await close();
      pauseKshetra(k, { manual: true, reason: 'worker_lock_lost', message: 'the worker lock was lost; resume to take it again' });
      return undefined;
    }
    try {
      await startEngine();
      engineDownSince = undefined;
      return engine;
    } catch (err) {
      if (err instanceof WorkerLockHeld) {
        pauseKshetra(k, { manual: true, reason: 'worker_lock_held', message: err.message });
        return undefined;
      }
      if (err instanceof LifecycleBehind) {
        logErr(err.message);
        pauseKshetra(k, { manual: true, reason: 'lifecycle_behind', message: err.message });
        return undefined;
      }
      engineDownSince ??= Date.now();
      logErr('cannot open the task graph engine:', err);
      if (Date.now() - engineDownSince >= UNAVAILABLE_RETRY_MS) {
        pauseKshetra(k, { manual: true, reason: 'database_unavailable', message: `cannot open the database: ${(err as Error).message}` });
        engineDownSince = undefined;
      }
      return undefined;
    }
  }

  // Run one task through the Silpi↔Viharapala loop (or the PR fix+finalize path
  // for a follow-up bead), funnelling any throw into the error handler — the same
  // loop and error policy the scheduler's WORK phase uses.
  async function runTaskSafely(
    k: KshetraConfig,
    task: Task,
    branch: string,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean; note: string }> {
    try {
      if (task.followup) return await runPrFollowupTask(k, task, signal);
      return await runSilpiViharapalaLoop(k, task, branch, signal);
    } catch (err) {
      // A self-heal abort is a SANCTIONED cancellation, not a cycle failure — the
      // resume watcher deliberately aborted this run; the claim is given back and
      // the work tree reset. Routing it through handleCycleError would flag the
      // task. Swallow it quietly.
      if (err instanceof AgentAbortedError) return { approved: false, note: 'aborted for self-heal' };
      await handleCycleError(k, task, err as Error);
      return { approved: false, note: 'cycle error (handled)' };
    }
  }

  const hooks: SchedulerHooks = {
    async selectNext(k: KshetraConfig): Promise<Task | null> {
      // While a self-heal is in flight, no cycle may proceed to PREPARE (which
      // mutates the tree) and race recoverKshetra. selectNext is read-only and
      // runs first, so returning null here idles the cycle before any mutation.
      if (healing) return null;
      if (isKshetraManuallyPaused(k)) return null;
      const e = await ensureEngine(k);
      if (!e) return null;
      // Epics are reconciled on each poll, not only on the settled event; a
      // database lost meanwhile has paused the Kshetra.
      await sweepEpics();
      if (isKshetraManuallyPaused(k)) return null;
      // A follow-up (a task followUp reopened, boosted) is claimed ahead of fresh work.
      return e.hooks.selectNext(k);
    },
    async prepareTask(task: Task, k: KshetraConfig): Promise<Task | null> {
      return engine ? engine.hooks.prepareTask(task, k) : null;
    },
    async runTask(task: Task, k: KshetraConfig): Promise<void> {
      // Publish a cancellation handle so the resume watcher can abort a hung run
      // and RECOVER in-process. `done` resolves in the finally, after the loop has
      // unwound and (via runCycle's own finally) phase has returned to IDLE.
      const controller = new AbortController();
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      activeRun = { controller, task, done };
      try {
        if (engine) await engine.hooks.runTask(task, k);
      } finally {
        activeRun = undefined;
        resolveDone();
      }
    },
  };

  // Reconcile deferred PRs (mergePolicy 'pr'): finish any whose PR merged,
  // flag any whose PR was closed unmerged. Gated on IDLE + not-healing so its
  // branch deletes never race an in-flight agent's work tree.
  async function reconcile(): Promise<void> {
    if (scheduler.getPhase(kshetra.id) !== 'IDLE' || healing) return;
    if (!engine) return;
    try {
      await reconcilePullRequests(kshetra);
    } catch (err) {
      logErr('PR reconcile failed:', err);
    }
  }

  /** The database stayed away past the retry window: pause the Kshetra for a manual resume. */
  function pauseUnavailable(k: KshetraConfig, err: Unavailable): void {
    logErr('database unavailable for a minute; pausing', err);
    pauseKshetra(k, { manual: true, reason: 'database_unavailable', message: `the database stayed unreachable: ${err.message}` });
  }

  // Epic sweep (Shreni-beads-q08): an epic is never worked; complete the
  // settled containers, flag any whose children were all cancelled. A scoped
  // drain (--epic) sweeps only its own subtree. Never throws.
  async function sweepEpics(): Promise<string[]> {
    if (!engine) return [];
    try {
      const { tg, as } = engine;
      const { completed } = await reconcileContainers({
        tg, as, ...(options.scopeEpic ? { within: options.scopeEpic } : {}), log: m => log(`epics: ${m}`),
      });
      return completed;
    } catch (err) {
      if (err instanceof Unavailable) pauseUnavailable(kshetra, err);
      else logErr('epic reconcile failed:', err);
      return [];
    }
  }

  /**
   * Opens the engine and takes the Kshetra's worker lock, refusing to start
   * (WorkerLockHeld, naming the holder's host) if another worker has it.
   */
  async function startEngine(): Promise<void> {
    const conn = await openKshetraEngine(kshetra);
    try {
      // Every write would be refused on an older lifecycle: say so once, rather than fail each poll.
      const gap = await lifecycleGap(conn.shreni, kshetra.project!);
      if (gap) throw new LifecycleBehind(kshetra.id, gap);
      const tg = conn.shreni.tg.project(kshetra.project!);
      const lock = await takeWorkerLock(tg);
      const queue = new EngineQueue(tg, tg.as({ id: `sthapathi:${kshetra.id}`, role: 'orchestrator' }), workerName(),
        options.scopeEpic ? { within: options.scopeEpic } : {});
      const as = tg.as({ id: `sthapathi:${kshetra.id}`, role: 'orchestrator' });
      // Declared before the hooks, which it reads claims from (and tells when a claim ends).
      const store: EngineTaskStore = engineTaskStore({
        shreni: conn.shreni, tg, as,
        systemActor: tg.as({ id: `sthapathi:${kshetra.id}`, role: 'system' }),
        agentActor: tg.as({ id: 'parikshaka', role: 'agent' }),
        claimFor: taskId => hooks.claims.get(taskId),
        onClaimEnded: taskId => hooks.endClaim(taskId),
      });
      const hooks = engineHooks({
        queue,
        // A follow-up works its open PR's branch; anything else starts from main,
        // and only on a green base (the health gate queues its repair otherwise).
        preflight: (task, k) => (task.followup ? prepareFollowupBranch(task, k) : preFlightFresh(task, k)),
        // A follow-up is a task followUp reopened: boosted (only followUp sets
        // it; submit and finish clear it) and with a PR on an earlier attempt.
        // A task whose PR was closed and later unblocked isn't boosted, so it is
        // worked afresh.
        isFollowup: async task => {
          if (!task.boosted) return false;
          const r = await sql<{ n: number }>`
            select count(*)::int as n from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id
             where a.project_id = ${tg.id} and a.task_id = ${task.id} and e.pr_url is not null`.execute(conn.shreni.db);
          return r.rows[0].n > 0;
        },
        // A follow-up whose branch can't be prepared goes back to waiting on its
        // PR, for reconcile to settle; released, it would stay boosted at the
        // head of the queue.
        onFollowupRefused: taskId => store.resubmit(taskId, 'the follow-up branch could not be prepared; back to waiting on the PR'),
        // The run's own abort (self-heal) and the lease's both stop the agents.
        run: (task, k, signal) => {
          const signals = [signal, activeRun?.controller.signal].filter((x): x is AbortSignal => !!x);
          return runTaskSafely(k, task, branchName(task), AbortSignal.any(signals)).then(() => {});
        },
        onUnavailable: pauseUnavailable,
        onLeaseLost: task => log(`lease on ${task.id} lost; another worker has it now`),
        onPreflightRefused: (task, k, err) => {
          if (!(err instanceof PreFlightError)) throw err;
          console.warn(`${logTag} preflight refused ${task.id}: ${err.message}; claim given back`);
          // The health gate has recorded its own stall.
          if (!(err instanceof BaseRedError)) recordStall(k, 'preflight');
        },
      });
      engine = { conn, hooks, queue, lock, tg, as };
      registerEngineStore(kshetra.id, store);
      log(`on the task graph engine as ${workerName()} (worker lock held)`);
      // Woken by others' writes; the poll stays as the fallback, so a lost subscription only costs latency.
      const own = new Set([`sthapathi:${kshetra.id}`, 'parikshaka']);
      try {
        engine.unsubscribe = await tg.events.subscribe(events => {
          if (events.some(e => !own.has(e.actor))) wake?.();
        }, { onError: err => logErr('event subscription:', err) });
      } catch (err) {
        log(`no wake-up on events (${(err as Error).message}); polling only`);
      }
    } catch (err) {
      await conn.close().catch(() => {});
      throw err;
    }
  }

  async function startup(): Promise<void> {
    // Load the optional extension FIRST, before any events are emitted or the
    // loop is driven, so a registered extension's sinks/meter are in place from
    // the very first event. Loud ablation banner (epic 8wi): one line per active
    // switch, and persist them so `shreni status` / Phalaka flag them.
    for (const line of ablationBanner(kshetra)) log(line);
    setAblations(kshetra, activeAblations(kshetra));
    const extensionLoaded = await loadExtension({ log: msg => log(msg) });
    // Snapshot which seams the extension overrode (epic yrk) RIGHT NOW — before we
    // compose our own budget policy / register the ledger sink below, which would
    // otherwise read as extension overrides. moduleId mirrors loader.ts.
    const extensionSeams = extensionSeamsSnapshot();
    const extensionModuleId = process.env.SHRENI_EXT?.trim() || DEFAULT_EXT_MODULE;
    // Register the decision ledger sink beside localFileSink and any sink the
    // extension just added; it writes decision-grade events to ledger.jsonl at
    // ledgerPath (the Kshetra's runtime dir). A failing ledger write is
    // isolated by the SinkRegistry.
    extensionCore.addEventSink(
      makeLedgerSink({ kshetraId: kshetra.id, ledgerPath: ledgerPath(kshetra) }),
    );
    // Enforce kshetra.yaml budget caps on top of whatever policy is now active.
    // Composed last so the caps always apply; the inner policy keeps its model
    // selection and can still deny for its own reasons.
    extensionCore.setPolicySource(makeBudgetPolicy(getPolicySource()));
    // Collect + emit the lot manifest (epic yrk / Study B2) NOW — after
    // loadExtension and after the ledger sink is registered, so worker_started
    // reaches ledger.jsonl, and BEFORE any other event so every
    // one of them carries this lot's id. Collection is bounded (parallel probes
    // with timeouts) so it never stalls start.
    const sections = await collectLotManifest(
      kshetra,
      { loaded: extensionLoaded, moduleId: extensionModuleId, seams: extensionSeams },
      { allowAblation },
    );
    emitLotManifest(kshetra.id, entrypoint, labels, sections);
    try {
      await startEngine();
    } catch (err) {
      // Recorded, so status and Phalaka say why, then the worker stops with the same words.
      if (err instanceof LifecycleBehind) pauseKshetra(kshetra, { manual: true, reason: 'lifecycle_behind', message: err.message });
      throw err;
    }
    // Leases return interrupted work by themselves; only the work tree needs resetting.
    await resetWorkTree(kshetra);
    if (clearStuckPauseOnRecover(kshetra)) log('cleared stale stuck pause after recovery');
    // Self-heal a legacy repo that committed .shreni/repo-map.md before it was
    // gitignored, so its post-merge regen stops dirtying the tree and wedging
    // preflight. resetWorkTree just left us on a clean main — the precondition.
    if (await untrackCommittedRepoMap(kshetra)) {
      log('untracked committed .shreni/repo-map.md (now gitignored)');
    }
    // PRs that merged or closed while the worker was down, then the epics
    // they (or tasks finished meanwhile) settled.
    await reconcile();
    await sweepEpics();
  }

  // The background timers: the watchdog, the liveness heartbeat, PR
  // reconcile, and the resume watcher.
  function startTimers(): () => void {
    // Watchdog: detect a stuck runtime (hung agent or a repeating stall loop) and
    // escalate — pause for manual resume + push an operator notification. The
    // hasReadyWork probe asks the engine, so it never escalates an empty queue.
    const watchdogTimer = setInterval(() => {
      runWatchdogOnce(kshetra, () => scheduler.getPhase(kshetra.id), Date.now(), {
        hasReadyWork: async () => !!engine && (await engine.queue.peek()) !== null,
      }).catch((err: unknown) => logErr('watchdog failed:', err));
    }, WATCHDOG_INTERVAL_MS);
    // Worker-liveness heartbeat: while a phase is active, stamp the heartbeat on a
    // fixed cadence regardless of agent output, so a long SILENT tool call stops
    // reading as a hung agent.
    const heartbeatTimer = setInterval(() => {
      if (scheduler.getPhase(kshetra.id) !== 'IDLE') touchHeartbeat(kshetra.id);
    }, HEARTBEAT_INTERVAL_MS);
    // Tasks waiting on their PRs: finish on merge, flag on close, reopen boosted
    // on feedback. Merges are human-paced.
    const reconcileTimer = setInterval(
      () => reconcile().catch(err => logErr('PR reconcile failed:', err)),
      RECONCILE_INTERVAL_MS,
    );
    // Resume watcher: `shreni resume` runs in a SEPARATE process and can only flip
    // state.json. Poll for the stuck-paused → resumed transition and, when a run
    // is still in flight, self-heal in-process: abort the hung run; the run's end
    // gives its claim back (hooks.runTask), so only the work tree needs resetting.
    // It holds the `healing` gate so the reset never races a poll cycle.
    let prevPause: PauseSnapshot | undefined;
    const resumeWatchTimer = setInterval(() => {
      const curr = loadState().kshetras[kshetra.id] as PauseSnapshot | undefined;
      if (shouldSelfHeal(prevPause, curr, activeRun !== undefined, healing)) {
        const run = activeRun!;
        healing = true;
        log(`stuck resume detected — aborting ${run.task.id}`);
        run.controller.abort(new AgentAbortedError('self-heal'));
        run.done
          .then(() => resetWorkTree(kshetra))
          .then(() => log('self-heal complete — back to IDLE'))
          .catch((err: unknown) => logErr('self-heal failed:', err))
          .finally(() => { healing = false; });
      }
      prevPause = curr;
    }, RESUME_WATCH_INTERVAL_MS);
    return () => {
      clearInterval(watchdogTimer);
      clearInterval(heartbeatTimer);
      clearInterval(reconcileTimer);
      clearInterval(resumeWatchTimer);
      // Flush any coalesced idle-poll time as a final phase_changed (epic hto) so
      // idle accumulated since the last real cycle is recorded before shutdown.
      scheduler.flushPhase(kshetra.id);
    };
  }

  /** Closes the engine connections, which also drops the worker lock. */
  async function close(): Promise<void> {
    const e = engine;
    engine = undefined;
    unregisterEngineStore(kshetra.id);
    await e?.unsubscribe?.().catch(() => {});
    await e?.conn.close();
  }

  return {
    kshetra,
    scheduler,
    hooks,
    onWake: fn => { wake = fn; },
    close,
    startup,
    sweepEpics,
    startTimers,
    isInFlight: () => scheduler.isInFlight(kshetra.id),
    isHealing: () => healing,
  };
}

/**
 * A follow-up's work tree on the engine: its PR branch, reset to origin. Throws
 * PreFlightError to refuse, so the claim is given back.
 */
async function prepareFollowupBranch(task: Task, kshetra: KshetraConfig): Promise<void> {
  const g = git(kshetra);
  const branch = branchName(task);
  try {
    await g.fetch('origin', branch);
    await g.checkout(branch);
    await g.resetHard(`origin/${branch}`);
  } catch (err) {
    throw new PreFlightError(task, `pr-followup prepare: ${(err as Error).message}`);
  }
}
