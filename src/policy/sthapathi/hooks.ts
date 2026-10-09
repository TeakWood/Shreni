import type { SchedulerHooks } from '../../sthapathi/index.js';
import type { KshetraConfig } from '../../kshetra/config.js';
import type { Task } from '../../sthapathi/types.js';
import { Unavailable, type Claim } from '../../taskgraph';
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
  retry?: Parameters<typeof retryUnavailable>[1];
}

export function engineHooks(deps: EngineHooksDeps): SchedulerHooks & { claims: Map<string, Claim> } {
  const claims = new Map<string, Claim>();
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
      try {
        await deps.preflight(task, k);
      } catch (err) {
        const releaseId = newId();
        await db(k, () => deps.queue.release(claim, 'preflight refused the work tree', releaseId));
        if (deps.onPreflightRefused) deps.onPreflightRefused(task, k, err);
        return null;
      }
      claims.set(task.id, claim);
      return task;
    },

    async runTask(task, k) {
      const claim = claims.get(task.id);
      if (!claim) throw new Error(`taskgraph: no claim held for ${task.id}`);
      try {
        await deps.queue.whileHeld(claim, signal => deps.run(task, k, signal));
      } catch (err) {
        if ((err as { code?: string }).code === 'LeaseLost') {
          deps.onLeaseLost?.(task);
          return;
        }
        throw err;
      } finally {
        claims.delete(task.id);
      }
      // A run that ended without moving its task (aborted for a self-heal, or a
      // handled cycle error) gives the claim back rather than leave it to expire.
      const releaseId = newId();
      await db(k, () => deps.queue.release(claim, 'the run ended without moving the task', releaseId));
    },
  };
}
