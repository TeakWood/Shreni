import type { SchedulerHooks } from '../../sthapathi/index.js';
import type { KshetraConfig } from '../../kshetra/config.js';
import type { Task } from '../../sthapathi/types.js';
import { Unavailable, type Claim, type Task as EngineTask } from '../../taskgraph';
import { randomUUID } from 'crypto';
import { EngineQueue, retryUnavailable, toSthapathiTask } from './leases';

// The worker's scheduler hooks on the task graph engine (policy spec, "Running
// work"): SELECT sweeps and peeks, PREPARE claims in one call and checks the
// work tree, WORK runs the agents while the worker heartbeats the lease.

export interface EngineHooksDeps {
  queue: EngineQueue;
  /** The git preflight for a claimed task; throws to refuse it. */
  preflight(task: Task, kshetra: KshetraConfig): Promise<void>;
  /** The agent loop for a prepared task. */
  run(task: Task, kshetra: KshetraConfig, signal: AbortSignal): Promise<void>;
  /** The database stayed unavailable past the retry window: pause the Kshetra. */
  onUnavailable(kshetra: KshetraConfig, err: Unavailable): void;
  /** The lease was lost mid-run: another worker has the task now. */
  onLeaseLost?(task: Task): void;
  /**
   * Preflight refused a claimed task (the claim is already given back):
   * record it, or rethrow an error that isn't a refusal.
   */
  onPreflightRefused?(task: Task, kshetra: KshetraConfig, err: unknown): void;
  /** A fresh request id per claim and release; retries reuse it. */
  requestId?: () => string;
  /** Whether a claimed task is a PR follow-up (policy spec, "Boost and repeated expiry"). */
  isFollowup?(task: EngineTask): Promise<boolean>;
  /** A follow-up's preflight refused: put it back to waiting on its PR (the claim is still held). */
  onFollowupRefused?(taskId: string): Promise<void>;
  retry?: Parameters<typeof retryUnavailable>[1];
}

export function engineHooks(deps: EngineHooksDeps): SchedulerHooks & { claims: Map<string, Claim>; endClaim(taskId: string): void } {
  const claims = new Map<string, Claim>();
  /** Claims the run itself ended (submit, finish, flag through the store): no more heartbeats or release. */
  const ended = new Set<string>();
  const newId = deps.requestId ?? (() => randomUUID());
  /** Runs a database step, pausing the Kshetra if the database stays away. */
  const db = async <T>(k: KshetraConfig, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await retryUnavailable(fn, deps.retry);
    } catch (err) {
      if (!(err instanceof Unavailable)) throw err;
      deps.onUnavailable(k, err);
      return null;
    }
  };

  return {
    claims,
    endClaim: taskId => { ended.add(taskId); },
    async selectNext(k) {
      // Swept on every poll, so a dead worker's task comes back within a lease and a poll.
      const peek = await db(k, async () => {
        await deps.queue.sweep();
        return deps.queue.peek();
      });
      return peek ? toSthapathiTask(peek) : null;
    },

    async prepareTask(_peeked, k) {
      // The claim picks the task: it may differ from the one peeked, if another
      // worker took that one in between.
      const claimId = newId();
      const claim = await db(k, () => deps.queue.claim(claimId));
      if (!claim) return null;
      const task = toSthapathiTask(claim.task);
      claims.set(task.id, claim);
      ended.delete(task.id);
      try {
        if (deps.isFollowup && (await retryUnavailable(() => deps.isFollowup!(claim.task), deps.retry))) task.followup = true;
        await deps.preflight(task, k);
      } catch (err) {
        if (task.followup && deps.onFollowupRefused) {
          await db(k, () => deps.onFollowupRefused!(task.id));
        } else {
          const releaseId = newId();
          await db(k, () => deps.queue.release(claim, 'preflight refused the work tree', releaseId));
        }
        claims.delete(task.id);
        ended.delete(task.id);
        if (deps.onPreflightRefused) deps.onPreflightRefused(task, k, err);
        return null;
      }
      return task;
    },

    async runTask(task, k) {
      const claim = claims.get(task.id);
      if (!claim) throw new Error(`taskgraph: no claim held for ${task.id}`);
      try {
        await deps.queue.whileHeld(claim, signal => deps.run(task, k, signal), undefined, () => ended.has(task.id));
      } catch (err) {
        if ((err as { code?: string }).code === 'LeaseLost' && !ended.has(task.id)) {
          deps.onLeaseLost?.(task);
          return;
        }
        if ((err as { code?: string }).code !== 'LeaseLost') throw err;
      } finally {
        claims.delete(task.id);
      }
      const done = ended.delete(task.id);
      if (done) return;
      // A run that ended without moving its task (aborted for a self-heal, or a
      // handled cycle error) gives the claim back rather than leave it to expire.
      const releaseId = newId();
      await db(k, () => deps.queue.release(claim, 'the run ended without moving the task', releaseId));
    },
  };
}
