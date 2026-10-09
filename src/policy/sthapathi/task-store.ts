import { sql } from 'kysely';
import { toSlug } from '../../sthapathi/pickup.js';
import type { EngineTaskStore } from '../../sthapathi/task-store.js';
import type { PrWatermark } from '../../sthapathi/pr-followup.js';
import type { ActorHandle, Claim, ProjectHandle } from '../../taskgraph';
import type { ShreniClient } from '../db/client';
import { randomUUID } from 'crypto';
import { LEASE_MS, retryUnavailable } from './leases';

// The engine's task store for merge and PR follow-up (policy spec, "The
// lifecycle", "Boost and repeated expiry"). Moves on a claimed task are fenced
// by its claim; on a waiting task (reconcile), plain moves as the orchestrator.

const NO_WATERMARK: PrWatermark = { head: null, round: 0, at: null };

export function engineTaskStore(opts: {
  shreni: ShreniClient;
  tg: ProjectHandle;
  as: ActorHandle;
  /** The worker's live claim on a task, if it holds one. */
  claimFor(taskId: string): Claim | undefined;
  /** Called when a move ends the worker's claim, so it stops heartbeating it. */
  onClaimEnded?(taskId: string): void;
  retry?: Parameters<typeof retryUnavailable>[1];
}): EngineTaskStore {
  const { shreni, tg, as, claimFor } = opts;
  /** Every store write and read retries a lost database, as the worker's own steps do. */
  const r = <T>(fn: () => Promise<T>) => retryUnavailable(fn, opts.retry);

  /** The attempt the task's evidence goes on: the live claim's, else the newest. */
  const currentAttempt = async (taskId: string): Promise<string | undefined> => {
    const claim = claimFor(taskId);
    if (claim) return claim.attemptId;
    const r = await sql<{ id: string }>`
      select id from taskgraph.attempts where project_id = ${tg.id} and task_id = ${taskId}
       order by started_at desc, id desc limit 1`.execute(shreni.db);
    return r.rows[0]?.id;
  };

  /** Upserts evidence for an attempt, merging gates. */
  const putEvidence = (attemptId: string, fields: { pr_url?: string; gates?: Record<string, unknown> }) =>
    shreni.transaction(async db => {
      await sql`
        insert into shreni.attempt_evidence (attempt_id, pr_url, gates)
        values (${attemptId}, ${fields.pr_url ?? null}, cast(cast(${JSON.stringify(fields.gates ?? {})} as text) as jsonb))
        on conflict (attempt_id) do update set
          pr_url = coalesce(excluded.pr_url, shreni.attempt_evidence.pr_url),
          gates  = shreni.attempt_evidence.gates || excluded.gates`.execute(db);
    });

  /** The PR the task's attempts recorded, newest first. */
  const lastPr = async (taskId: string): Promise<string | undefined> => {
    const r = await sql<{ pr_url: string }>`
      select e.pr_url from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id
       where a.project_id = ${tg.id} and a.task_id = ${taskId} and e.pr_url is not null
       order by a.started_at desc, a.id desc limit 1`.execute(shreni.db);
    return r.rows[0]?.pr_url;
  };

  /** A move fenced by the live claim when there is one. */
  const moveTask = async (taskId: string, move: string, reason: string) => {
    const claim = claimFor(taskId);
    // One request id across retries, so a move whose reply was lost isn't made twice.
    const requestId = randomUUID();
    if (claim) {
      await r(() => as.moveClaimed(claim, move, { reason, requestId }));
      opts.onClaimEnded?.(taskId);
    } else {
      await r(() => as.move(taskId, move, { reason, requestId }));
    }
  };

  return {
    async beforeMerge(taskId) {
      const claim = claimFor(taskId);
      if (claim) await r(() => as.heartbeat(claim, { leaseMs: LEASE_MS }));
    },

    finish: (taskId, reason) => moveTask(taskId, 'finish', reason),

    async deferForPr(taskId, prUrl) {
      const attempt = await currentAttempt(taskId);
      if (!attempt) throw new Error(`taskgraph: ${taskId} has no attempt to record its PR on`);
      await r(() => putEvidence(attempt, { pr_url: prUrl }));
      await moveTask(taskId, 'submit', `PR opened: ${prUrl}`);
    },

    async listAwaitingMerge() {
      return (await r(() => tg.tasks.list({ states: ['waiting'], orderBy: 'created' })))
        .map(t => ({ id: t.id, title: t.title, slug: toSlug(t.title) }));
    },

    prDeclined: (taskId, reason) => moveTask(taskId, 'flag', reason),

    async needsFollowup(taskId) {
      await moveTask(taskId, 'followUp', 'the PR has unaddressed feedback');
    },

    async resubmit(taskId, reason) {
      // The round's own attempt carries the PR, which the hasOpenPr guard reads.
      const attempt = await currentAttempt(taskId);
      const pr = await lastPr(taskId);
      if (attempt && pr) await r(() => putEvidence(attempt, { pr_url: pr }));
      await moveTask(taskId, 'submit', reason);
    },

    flag: (taskId, reason) => moveTask(taskId, 'flag', reason),

    async note(taskId, text) {
      await r(() => as.notes.add(taskId, text));
    },

    async readWatermark(taskId) {
      const r = await sql<{ w: PrWatermark | null }>`
        select e.gates -> 'prFollowup' as w
          from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id
         where a.project_id = ${tg.id} and a.task_id = ${taskId} and e.gates ? 'prFollowup'
         order by a.started_at desc, a.id desc limit 1`.execute(shreni.db);
      return r.rows[0]?.w ?? NO_WATERMARK;
    },

    async writeWatermark(taskId, w) {
      const attempt = await currentAttempt(taskId);
      if (attempt) await r(() => putEvidence(attempt, { gates: { prFollowup: w } }));
    },
  };
}
