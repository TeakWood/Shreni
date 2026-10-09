import { hostname } from 'os';
import {
  LeaseLost, Unavailable, type ActorHandle, type Claim, type ProjectHandle, type Release, type Task as EngineTask,
} from '../../taskgraph';
import { toSlug } from '../../sthapathi/pickup.js';
import type { Task } from '../../sthapathi/types.js';

// How Sthapathi uses the engine's claims and leases (policy spec, "Running
// work"): one claim per try, a 10-minute lease renewed every 2 minutes by the
// worker while its agents run, the sweep on every poll, and one worker per
// Kshetra across machines through a session lock.

export const LEASE_MS = 10 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;
/** How long the worker retries a lost database before it pauses the Kshetra. */
export const UNAVAILABLE_RETRY_MS = 60_000;

/** This process, as the engine records it on attempts: host and pid. */
export const workerName = (): string => `${hostname()}/${process.pid}`;

export class WorkerLockHeld extends Error {
  constructor(readonly holder: string) {
    super(`another worker already runs this Kshetra: ${holder || 'a worker that didn\'t name its host'}`);
    this.name = 'WorkerLockHeld';
  }
}

/** Takes the Kshetra's worker lock, or throws WorkerLockHeld naming the holder. */
export async function takeWorkerLock(tg: ProjectHandle): Promise<Release> {
  const release = await tg.locks.trySession('worker');
  if (release) return release;
  throw new WorkerLockHeld((await tg.locks.holder('worker')) ?? '');
}

/**
 * Runs `fn`, retrying it while the database is Unavailable, for up to `forMs`;
 * then rethrows. A worker uses it so a brief outage costs a pause in work, not
 * a lost task (its request ids make the retries safe).
 */
export async function retryUnavailable<T>(
  fn: () => Promise<T>,
  opts: { forMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<T> {
  const forMs = opts.forMs ?? UNAVAILABLE_RETRY_MS;
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + forMs;
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 10_000)) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Unavailable) || now() >= until) throw err;
      await sleep(Math.min(wait, Math.max(0, until - now())));
    }
  }
}

/** An engine task as the Silpi <-> Viharapala loop takes it. */
export function toSthapathiTask(t: EngineTask): Task {
  return {
    id: t.id,
    slug: toSlug(t.title),
    title: t.title,
    ...(t.description ? { description: t.description } : {}),
    status: 'in_progress',
    priority: t.priority,
    type: t.category ?? undefined,
  };
}

/** The worker's view of a project's queue: sweep, claim, and hold a claim while work runs. */
export class EngineQueue {
  constructor(
    private readonly tg: ProjectHandle,
    private readonly as: ActorHandle,
    private readonly worker: string,
    private readonly opts: { leaseMs?: number; heartbeatMs?: number; within?: string } = {},
  ) {}

  /** Returns lapsed leases; the poll runs it as well as each claim. */
  sweep(): Promise<number> {
    return this.tg.expireLeases();
  }

  /** The next ready task, without claiming it. */
  async peek(): Promise<EngineTask | null> {
    return (await this.tg.ready({ limit: 1, ...(this.opts.within ? { within: this.opts.within } : {}) }))[0] ?? null;
  }

  /**
   * Sweeps and claims in one call; null when nothing is ready. Pass the same
   * request id on a retry, so a claim whose reply was lost returns its attempt
   * rather than leasing a second task.
   */
  claim(requestId: string): Promise<Claim | null> {
    return this.as.claim({
      worker: this.worker, leaseMs: this.opts.leaseMs ?? LEASE_MS, requestId,
      ...(this.opts.within ? { filter: { within: this.opts.within } } : {}),
    });
  }

  /** Gives a claim back; one already ended (moved, released, or lost) is left alone. */
  async release(claim: Claim, reason: string, requestId?: string): Promise<void> {
    try {
      await this.as.moveClaimed(claim, 'release', { reason, requestId });
    } catch (err) {
      if (!(err instanceof LeaseLost)) throw err;
    }
  }

  /**
   * Runs `work` while heartbeating the claim. If the lease is lost, the signal
   * aborts the work, and LeaseLost is thrown once it has stopped.
   */
  async whileHeld<T>(
    claim: Claim, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal,
    /** True once the work itself has ended the claim (submit, finish): stop heartbeating it. */
    isEnded: () => boolean = () => false,
  ): Promise<T> {
    const controller = new AbortController();
    const onOuter = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', onOuter);
    let lost: LeaseLost | undefined;
    let current = claim;
    let beating = Promise.resolve();
    const timer = setInterval(() => {
      beating = beating.then(async () => {
        if (isEnded()) return;
        try {
          current = await this.as.heartbeat(current, { leaseMs: this.opts.leaseMs ?? LEASE_MS });
        } catch (err) {
          if (err instanceof LeaseLost) {
            lost = err;
            controller.abort(err);
          }
          // anything else (a brief outage): the next beat tries again within the lease
        }
      });
    }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
    try {
      const out = await work(controller.signal);
      if (lost) throw lost;
      return out;
    } catch (err) {
      throw lost ?? err;
    } finally {
      clearInterval(timer);
      outer?.removeEventListener('abort', onOuter);
      await beating;
    }
  }
}
