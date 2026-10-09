import { join } from 'path';
import { createScheduler, type Scheduler, type SchedulerHooks } from '../sthapathi/index';
import { selectNext, prepareTask, preFlightFresh, PreFlightError, BaseRedError } from '../sthapathi/pickup';
import { runSilpiViharapalaLoop } from '../sthapathi/dispatch';
import { handleCycleError, AgentAbortedError } from '../sthapathi/errors';
import { recoverKshetra, resetWorkTree, scheduleResume } from '../sthapathi/recover';
import { untrackCommittedRepoMap } from '../sthapathi/repo-map-migration';
import { runWatchdogOnce } from '../sthapathi/watchdog';
import { branchName } from '../sthapathi/branch';
import { touchHeartbeat, emitLotManifest } from '../sthapathi/activity-log';
import { collectLotManifest } from '../sthapathi/lot-manifest';
import { selfHeal, shouldSelfHeal, type ActiveRun, type PauseSnapshot } from '../sthapathi/self-heal';
import {
  clearStuckPauseOnRecover,
  isKshetraManuallyPaused,
  loadState,
  pauseKshetra,
  recordStall,
  setPhase,
  setAblations,
} from '../kshetra/state';
import { syncBeads } from '../sthapathi/beads';
import { reconcilePullRequests } from '../sthapathi/merge';
import { sweepCompleteEpics } from '../sthapathi/epics';
import { selectFollowup } from '../sthapathi/pr-followup';
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
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import { EngineQueue, takeWorkerLock, UNAVAILABLE_RETRY_MS, WorkerLockHeld, workerName } from '../policy/sthapathi/leases';
import { Unavailable, type ActorHandle, type ProjectHandle, type Release } from '../taskgraph';
import { engineHooks } from '../policy/sthapathi/hooks';
import { engineTaskStore } from '../policy/sthapathi/task-store';
import { reconcileContainers } from '../policy/sthapathi/epics';
import { registerEngineStore, unregisterEngineStore, type EngineTaskStore } from '../sthapathi/task-store';
import { git } from '../sthapathi/git';
import { sql } from 'kysely';

// The worker runtime, factored out of src/cli/worker.ts (epic 7h3 / Study B3) so
// the daemon (`shreni start` → `__worker`) and `shreni drain` share ONE copy of
// the real machinery: the scheduler + hooks, self-heal, the startup sequence
// (extension load, ledger sink, budget policy, lot manifest, sync, recover,
// resume, reconcile), and the background timers (bead sync, PR reconcile,
// watchdog, heartbeat, resume-watch). The only difference between the two callers
// is the DRIVING loop: the daemon arms `scheduler.scheduleLoop` and never exits;
// drain drives `scheduler.runCycle` itself so it can read each cycle's outcome and
// run an exit sequence. This is the ONLY place a scheduler is built for real work:
// `shreni run` is `drain --max-cycles 1`, not a loop of its own (Shreni-beads-nhw),
// so nothing can dispatch agents while skipping the ledger sink, persisted phase,
// heartbeat, recovery, or timers wired here. src/cli/single-scheduler.test.ts
// guards against a second createScheduler() call site returning.

const BEADS_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const RESUME_WATCH_INTERVAL_MS = 5 * 1000;

// 'run' is `shreni run`, a one-cycle drain (Shreni-beads-nhw) — same runtime.
export type WorkerEntrypoint = 'worker' | 'drain' | 'run';

export interface WorkerRuntimeOptions {
  // Opaque run labels (epic yrk / Study B2), forwarded to the lot manifest.
  labels?: Record<string, string>;
  // Whether --allow-ablation was passed (epic 8wi / Study B1).
  allowAblation?: boolean;
  // Distinguishes the daemon from drain in the lot manifest + log lines.
  entrypoint: WorkerEntrypoint;
  // Optional scope filter (epic 7h3): `shreni drain --epic <id>` restricts pickup
  // to the epic's subtree so only in-scope beads are worked. Omitted for the
  // daemon and an unscoped drain — the whole ready queue is fair game.
  inScope?: (task: Task) => boolean;
  // The epic that inScope is the subtree of, so a Kshetra on the task graph
  // engine can claim within it (the engine's filter takes the epic, not a predicate).
  scopeEpic?: string;
}

export interface WorkerRuntime {
  readonly kshetra: KshetraConfig;
  /** Closes the engine's connections (dropping the worker lock); nothing to do on beads. */
  close(): Promise<void>;
  readonly scheduler: Scheduler;
  readonly hooks: SchedulerHooks;
  /** The startup sequence — MUST complete before the first cycle is driven, so
   *  recoverKshetra reconciles crash drift before any new work is picked up.
   *  Returns the resumed WIP task count (for logging). */
  startup(): Promise<number>;
  /** Commit + push the beads DB (incl. ledger.jsonl). Used by the periodic timer
   *  and by drain's FINAL sync before it classifies and exits. */
  sync(): Promise<void>;
  /** Close every epic whose (>= 1) children are all closed (Shreni-beads-q08).
   *  Run by startup and at drain exit; idempotent, never throws, does NOT sync
   *  (callers sync after). Returns the epic ids closed. */
  sweepEpics(): Promise<string[]>;
  /** Arm the background timers; returns a stop function that clears them all and
   *  flushes any coalesced idle-poll phase time. */
  startTimers(): () => void;
  /** True while a task is dispatched OR a Parikshaka backfill is outstanding. */
  isInFlight(): boolean;
  /** True while a self-heal (abort + RECOVER of a hung run) is in progress. */
  isHealing(): boolean;
}

// The precondition guards `shreni start`/drain both run before building a
// runtime: the defensive ablation gate (a copied config must not silently weaken
// a real repo) and the per-role credential preflight. Returns the first error
// message, or null when the kshetra is clear to run. Kept as a returned string
// (not a throw) so each caller reports it its own way — the daemon logs + exits
// 1, drain throws so the dispatcher exits 1.
export function workerPreconditionError(kshetra: KshetraConfig, allowAblation: boolean): string | null {
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

  // A Kshetra registered on the task graph engine (its kshetra.yaml names the
  // project's uuid) is worked through the engine's claims and leases (policy
  // spec, "Running work"); one still on beads keeps the bd path until the
  // migration release removes it. Opened in startup; until then, and if
  // opening failed, an engine Kshetra picks up nothing rather than fall back to bd.
  const onEngine = !!kshetra.project;
  let engine: {
    conn: KshetraEngine; hooks: ReturnType<typeof engineHooks>; queue: EngineQueue; lock: Release;
    tg: ProjectHandle; as: ActorHandle;
  } | undefined;
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
  // loop and error policy the scheduler's WORK phase and resume both use.
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
      // resume watcher deliberately aborted this run and recoverKshetra will
      // recover the bead. Routing it through handleCycleError would flag the bead
      // and clean the branch out from under the recovery. Swallow it quietly.
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
      if (onEngine) {
        const e = await ensureEngine(k);
        if (!e) return null;
        // Epics are reconciled on each poll, not only on the settled event; a
        // database lost meanwhile has paused the Kshetra.
        await sweepEpics();
        if (isKshetraManuallyPaused(k)) return null;
        return e.hooks.selectNext(k);
      }
      // Follow-up beads are prioritised over fresh work (ARD §4.1): finish
      // in-flight PRs before opening new WIP. Cheap — a bd label query. A
      // follow-up bead is on-scope by construction (its parent bead was worked
      // in-scope), so the scope filter applies only to fresh pickup below.
      const followup = await selectFollowup(k);
      if (followup) return followup;
      return selectNext(k, options.inScope);
    },
    async prepareTask(task: Task, k: KshetraConfig): Promise<Task | null> {
      if (onEngine) return engine ? engine.hooks.prepareTask(task, k) : null;
      return prepareTask(task, k);
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
        if (onEngine && engine) await engine.hooks.runTask(task, k);
        else await runTaskSafely(k, task, branchName(task), controller.signal);
      } finally {
        activeRun = undefined;
        resolveDone();
      }
    },
  };

  async function sync(): Promise<void> {
    try {
      await syncBeads(kshetra);
      log('beads synced');
    } catch (err) {
      logErr('beads sync failed:', err);
    }
  }

  // Reconcile deferred PR beads (mergePolicy 'pr'): close any whose PR merged,
  // block any whose PR was closed unmerged. Gated on IDLE + not-healing so its
  // branch deletes never race an in-flight agent's work tree.
  async function reconcile(): Promise<void> {
    if (scheduler.getPhase(kshetra.id) !== 'IDLE' || healing) return;
    if (onEngine && !engine) return;
    try {
      await reconcilePullRequests(kshetra);
    } catch (err) {
      logErr('PR reconcile failed:', err);
    }
  }

  // Epic sweep (Shreni-beads-q08): an epic is never worked, so Sthapathi closes it
  // itself once its children are all closed. The per-child close in the merge
  // paths covers the live case; this sweep self-heals a crash between a child's
  // close and its epic's, and closes epics completed before q08. Logged per epic
  // (inside sweepCompleteEpics). Never throws.
  /** The database stayed away past the retry window: pause the Kshetra for a manual resume. */
  function pauseUnavailable(k: KshetraConfig, err: Unavailable): void {
    logErr('database unavailable for a minute; pausing', err);
    pauseKshetra(k, { manual: true, reason: 'database_unavailable', message: `the database stayed unreachable: ${err.message}` });
  }

  async function sweepEpics(): Promise<string[]> {
    if (onEngine) {
      // On the engine: complete the settled containers, flag any whose children were all cancelled.
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
    // A scoped drain (--epic) sweeps only its own subtree (trial isolation).
    const scope = options.inScope;
    const closed = await sweepCompleteEpics(kshetra, scope ? id => scope({ id } as Task) : undefined);
    if (closed.length > 0) log(`epic sweep closed ${closed.length} complete epic(s): ${closed.join(', ')}`);
    return closed;
  }

  /**
   * Opens the engine and takes the Kshetra's worker lock, refusing to start
   * (WorkerLockHeld, naming the holder's host) if another worker has it.
   */
  async function startEngine(): Promise<void> {
    if (options.inScope && !options.scopeEpic) {
      throw new Error('a scoped run on the task graph engine needs the epic it is scoped to (scopeEpic)');
    }
    const conn = await openKshetraEngine(kshetra);
    try {
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
    } catch (err) {
      await conn.close().catch(() => {});
      throw err;
    }
  }

  async function startup(): Promise<number> {
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
    // extension just added; it writes decision-grade events to ledger.jsonl in the
    // beads repo — the only git-tracked, pushed store; syncBeads commits it. A
    // failing ledger write is isolated by the SinkRegistry.
    extensionCore.addEventSink(
      makeLedgerSink({ kshetraId: kshetra.id, ledgerPath: join(kshetra.beads.path, 'ledger.jsonl') }),
    );
    // Enforce kshetra.yaml budget caps on top of whatever policy is now active.
    // Composed last so the caps always apply; the inner policy keeps its model
    // selection and can still deny for its own reasons.
    extensionCore.setPolicySource(makeBudgetPolicy(getPolicySource()));
    // Collect + emit the lot manifest (epic yrk / Study B2) NOW — after
    // loadExtension and after the ledger sink is registered, so worker_started
    // reaches ledger.jsonl, and BEFORE any other event (sync, recover) so every
    // one of them carries this lot's id. Collection is bounded (parallel probes
    // with timeouts) so it never stalls start.
    const sections = await collectLotManifest(
      kshetra,
      { loaded: extensionLoaded, moduleId: extensionModuleId, seams: extensionSeams },
      { allowAblation },
    );
    emitLotManifest(kshetra.id, entrypoint, labels, sections);
    if (onEngine) {
      await startEngine();
      // Leases return interrupted work by themselves; only the work tree needs resetting.
      await resetWorkTree(kshetra);
      if (clearStuckPauseOnRecover(kshetra)) log('cleared stale stuck pause after recovery');
      // PRs that merged or closed while the worker was down, then the epics
      // they (or tasks finished meanwhile) settled.
      await reconcile();
      await sweepEpics();
      return 0;
    }
    await sync();
    const resumable = await recoverKshetra(kshetra);
    // RECOVER has reconciled the drift a stuck pause escalated over, so a leftover
    // auto-escalated stuck pause is now stale — clear it, or the fresh runtime
    // comes up paused and idle. A deliberate user pause is left intact.
    if (clearStuckPauseOnRecover(kshetra)) {
      log('cleared stale stuck pause after recovery');
    }
    log(`recovery complete (${resumable.length} to resume)`);
    // Self-heal a legacy repo that committed .shreni/repo-map.md before it was
    // gitignored, so its post-merge regen stops dirtying the tree and wedging
    // preflight. recoverKshetra just left us on a clean main — the precondition.
    if (await untrackCommittedRepoMap(kshetra)) {
      log('untracked committed .shreni/repo-map.md (now gitignored)');
    }
    for (const task of resumable) {
      log(`resuming WIP bead ${task.id} (bypassing health gate)`);
      await scheduleResume(kshetra, task, runTaskSafely);
    }
    // Reconcile any PRs that merged/closed while this runtime was down, before the
    // loop starts picking up new work.
    await reconcile();
    // Close already-complete epics (after reconcile, so children that just landed
    // via PR count as closed) and push the closes before the first cycle.
    if ((await sweepEpics()).length > 0) await sync();
    return resumable.length;
  }

  function startTimers(): () => void {
    if (onEngine) return startEngineTimers();
    const syncTimer = setInterval(
      () => sync().catch(err => logErr('beads sync failed:', err)),
      BEADS_SYNC_INTERVAL_MS,
    );
    // Poll open PRs for deferred (mergePolicy 'pr') beads and close/block them as
    // their PRs land. Same cadence as the beads sync — merges are human-paced.
    const reconcileTimer = setInterval(
      () => reconcile().catch(err => logErr('PR reconcile failed:', err)),
      BEADS_SYNC_INTERVAL_MS,
    );
    // Watchdog: detect a stuck runtime (hung agent or a repeating stall loop) and
    // escalate — pause for manual resume + push an operator notification. The
    // hasReadyWork probe uses the RAW ready queue so it never escalates an
    // empty-queue Kshetra.
    const watchdogTimer = setInterval(() => {
      runWatchdogOnce(kshetra, () => scheduler.getPhase(kshetra.id), Date.now(), {
        hasReadyWork: async () => (await selectNext(kshetra)) !== null,
      }).catch((err: unknown) => logErr('watchdog failed:', err));
    }, WATCHDOG_INTERVAL_MS);
    // Worker-liveness heartbeat: while a phase is active, stamp the heartbeat on a
    // fixed cadence regardless of agent output, so a long SILENT tool call stops
    // reading as a hung agent.
    const heartbeatTimer = setInterval(() => {
      if (scheduler.getPhase(kshetra.id) !== 'IDLE') touchHeartbeat(kshetra.id);
    }, HEARTBEAT_INTERVAL_MS);
    // Resume watcher: `shreni resume` runs in a SEPARATE process and can only flip
    // state.json. Poll for the stuck-paused → resumed transition and, when a run
    // is still in flight, self-heal in-process: abort the hung agent, RECOVER,
    // re-arm. It holds the `healing` gate so RECOVER never races a poll cycle.
    let prevPause: PauseSnapshot | undefined;
    const resumeWatchTimer = setInterval(() => {
      const curr = loadState().kshetras[kshetra.id] as PauseSnapshot | undefined;
      if (shouldSelfHeal(prevPause, curr, activeRun !== undefined, healing)) {
        const run = activeRun!;
        healing = true;
        log(`stuck resume detected — self-healing bead ${run.task.id}`);
        selfHeal(kshetra, run)
          .then(() => log('self-heal complete — back to IDLE'))
          .catch((err: unknown) => logErr('self-heal failed:', err))
          .finally(() => { healing = false; });
      }
      prevPause = curr;
    }, RESUME_WATCH_INTERVAL_MS);

    return () => {
      clearInterval(syncTimer);
      clearInterval(reconcileTimer);
      clearInterval(watchdogTimer);
      clearInterval(heartbeatTimer);
      clearInterval(resumeWatchTimer);
      // Flush any coalesced idle-poll time as a final phase_changed (epic hto) so
      // idle accumulated since the last real cycle is recorded before shutdown.
      scheduler.flushPhase(kshetra.id);
    };
  }

  // On the engine: no beads sync or bd PR reconcile; the watchdog and liveness
  // heartbeat as on beads, with the watchdog asking the engine for ready work.
  function startEngineTimers(): () => void {
    const watchdogTimer = setInterval(() => {
      runWatchdogOnce(kshetra, () => scheduler.getPhase(kshetra.id), Date.now(), {
        hasReadyWork: async () => !!engine && (await engine.queue.peek()) !== null,
      }).catch((err: unknown) => logErr('watchdog failed:', err));
    }, WATCHDOG_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => {
      if (scheduler.getPhase(kshetra.id) !== 'IDLE') touchHeartbeat(kshetra.id);
    }, HEARTBEAT_INTERVAL_MS);
    // Tasks waiting on their PRs: finish on merge, flag on close, reopen boosted on feedback.
    const reconcileTimer = setInterval(
      () => reconcile().catch(err => logErr('PR reconcile failed:', err)),
      BEADS_SYNC_INTERVAL_MS,
    );
    // Self-heal on the engine: on a stuck resume, abort the hung run; the run's
    // end gives its claim back (hooks.runTask), so only the work tree needs resetting.
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
      scheduler.flushPhase(kshetra.id);
    };
  }

  /** Closes the engine connections, which also drops the worker lock. */
  async function close(): Promise<void> {
    const e = engine;
    engine = undefined;
    unregisterEngineStore(kshetra.id);
    await e?.conn.close();
  }

  return {
    kshetra,
    scheduler,
    hooks,
    close,
    startup,
    sync,
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
