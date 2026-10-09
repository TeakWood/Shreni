import { randomUUID } from 'crypto';
import { Unavailable, type ActorHandle, type ProjectHandle } from '../../taskgraph';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { retryUnavailable } from './leases';

// Epics reconciled on the engine (policy spec, "Containers"). Sthapathi doesn't
// rely on the children.settled event: on start and on each poll it asks the
// engine for containers whose children have all settled, completes each with a
// finished child, and flags one whose children were all cancelled, for the
// developer to cancel or reopen. This replaces the bd epic sweep.

/** A state that counts as finished, by the lifecycle's flag rather than its name (as childrenSettled reads it). */
const finished = (state: string) => !!taskLifecycle.states[state]?.satisfiesDeps;

/** Bound on the passes, each of which can settle the containers one level up. */
const MAX_DEPTH = 10;

export async function reconcileContainers(opts: {
  tg: ProjectHandle;
  /** The orchestrator, which completes and flags containers. */
  as: ActorHandle;
  /** A scoped run's epic: only containers in its subtree, itself included. */
  within?: string;
  retry?: Parameters<typeof retryUnavailable>[1];
  log?(message: string): void;
}): Promise<{ completed: string[]; flagged: string[] }> {
  const { tg, as } = opts;
  const r = <T>(fn: () => Promise<T>) => retryUnavailable(fn, opts.retry);
  const completed: string[] = [];
  const flagged: string[] = [];
  const scope = opts.within
    ? new Set([opts.within, ...(await r(() => tg.tasks.list({ within: opts.within }))).map(t => t.id)])
    : undefined;
  /** Containers that failed this call: tried once, then left for the next poll. */
  const failed = new Set<string>();
  for (let pass = 0; pass < MAX_DEPTH; pass++) {
    const settled = (await r(() => tg.tasks.settled())).filter(c => (!scope || scope.has(c.id)) && !failed.has(c.id));
    let progressed = false;
    for (const c of settled) {
      // One request id per move across retries, so a lost reply doesn't move twice.
      const requestId = randomUUID();
      try {
        const children = await r(() => tg.tasks.list({ parent: c.id }));
        if (children.some(t => finished(t.state))) {
          await r(() => as.move(c.id, 'completeContainer', { reason: `all ${children.length} children settled`, requestId }));
          completed.push(c.id);
          opts.log?.(`completed epic ${c.id}: all ${children.length} children settled`);
        } else {
          // Not guarded: a child a developer files between the read and the flag
          // is held under the blocked epic until they unblock it. Rare, and the
          // flag names the reason, so it is accepted rather than locked against.
          await r(() => as.move(c.id, 'flag', { reason: 'every child was cancelled; cancel the epic or reopen its work', requestId }));
          flagged.push(c.id);
          opts.log?.(`flagged epic ${c.id}: every child was cancelled`);
        }
        progressed = true;
      } catch (err) {
        // A lost database stops the reconcile, for the caller to pause on; any
        // other refusal (a developer moved the epic meanwhile) is left for the next poll.
        if (err instanceof Unavailable) throw err;
        failed.add(c.id);
        opts.log?.(`could not reconcile epic ${c.id}: ${(err as Error).message}`);
      }
    }
    if (!progressed) break;
  }
  return { completed, flagged };
}
