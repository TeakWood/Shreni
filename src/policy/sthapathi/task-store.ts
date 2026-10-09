import { sql } from 'kysely';
import { toSlug } from '../../sthapathi/pickup.js';
import type { EngineTaskStore } from '../../sthapathi/task-store.js';
import type { PrWatermark } from '../../sthapathi/pr-followup.js';
import type { ActorHandle, Claim, ProjectHandle } from '../../taskgraph';
import type { ShreniClient } from '../db/client';
import { createHash, randomUUID } from 'crypto';
import { LEASE_MS, retryUnavailable } from './leases';
import { engineReads } from './reads';

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
  /** Files the health gate's repair task (role system: it lands open). */
  systemActor: ActorHandle;
  /** Files Parikshaka's gaps (role agent: they land proposed). */
  agentActor: ActorHandle;
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

  /** The acceptance the task's attempts recorded, newest first. */
  const lastAcceptance = async (taskId: string): Promise<unknown> => {
    const r = await sql<{ acceptance: unknown }>`
      select e.gates -> 'acceptance' as acceptance
        from taskgraph.attempts a join shreni.attempt_evidence e on e.attempt_id = a.id
       where a.project_id = ${tg.id} and a.task_id = ${taskId} and e.gates ? 'acceptance'
       order by a.started_at desc, a.id desc limit 1`.execute(shreni.db);
    return r.rows[0]?.acceptance ?? undefined;
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

    async finish(taskId, reason) {
      // Only work on main is finished: recorded first, so a task whose finish is
      // refused for a manual check can be confirmed by the developer, and nothing else.
      const attempt = await currentAttempt(taskId);
      if (attempt) await r(() => putEvidence(attempt, { gates: { landed: true } }));
      await moveTask(taskId, 'finish', reason);
    },

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
      // The round's own attempt carries the PR, which the hasOpenPr guard reads,
      // and the approved attempt's acceptance, which checksPassed reads when the
      // PR merges.
      const attempt = await currentAttempt(taskId);
      const pr = await lastPr(taskId);
      const acceptance = await lastAcceptance(taskId);
      if (attempt && (pr || acceptance)) {
        await r(() => putEvidence(attempt, { pr_url: pr, ...(acceptance ? { gates: { acceptance } } : {}) }));
      }
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

    reads: engineReads(shreni, tg),

    tracker: {
      // The project's memories, as bd prime printed them.
      async prime() {
        const rows = await r(() => shreni.db.selectFrom('shreni.memories').select(['key', 'content'])
          .where('project_id', '=', tg.id).orderBy('key').execute());
        return rows.length ? rows.map(m => `- ${m.key}: ${m.content}`).join('\n') : '';
      },
      // The task as bd show --json printed it: an array holding the task, with
      // its acceptance criteria rendered from its checks, and its dependencies.
      async show(id) {
        const t = await r(() => tg.tasks.get(id));
        const checks = await r(() => shreni.db.selectFrom('shreni.acceptance_checks').select(['given', 'when', 'then'])
          .where('project_id', '=', tg.id).where('task_id', '=', id).orderBy('created_at').execute());
        const acceptance = checks.map(c => `- Given ${c.given}, when ${c.when}, then ${c.then}`).join('\n');
        return JSON.stringify([{
          id: t.id, title: t.title, description: t.description ?? '', status: t.state, priority: t.priority,
          issue_type: t.category ?? (t.kind === 'container' ? 'epic' : 'task'),
          ...(acceptance ? { acceptance_criteria: acceptance } : {}),
          dependencies: t.deps.map(d => ({ id: d.id, status: d.state })),
        }]);
      },
      async addNote(id, text) {
        await r(() => as.notes.add(id, text));
        return '';
      },
      async remember(insight) {
        // Keyed by the insight's own text, so the same insight is kept once.
        const key = createHash('sha256').update(insight).digest('hex').slice(0, 16);
        await r(() => shreni.transaction(db => db.insertInto('shreni.memories')
          .values({ project_id: tg.id, key, content: insight })
          .onConflict(oc => oc.columns(['project_id', 'key']).doUpdateSet({ updated_at: sql`now()` })).execute()));
        return '';
      },
      async flag(id, reason) {
        await moveTask(id, 'flag', reason);
        return '';
      },
    },

    async ensureHealthTask(title, priority) {
      const open = await r(() => tg.tasks.list({ tags: ['shreni-health'], states: ['proposed', 'open', 'claimed', 'waiting', 'blocked', 'parked'] }));
      if (open.length) return false;
      // Keyed per red episode, so two filings racing for the same one file once.
      const episode = await r(() => tg.tasks.count({ tags: ['shreni-health'] }));
      const before = await r(() => tg.tasks.list({ key: `shreni-health:${episode + 1}` }));
      const created = await r(() => opts.systemActor.tasks.create(
        { title, priority, category: 'bug', tags: ['shreni-health'], key: `shreni-health:${episode + 1}` },
        { requestId: `shreni-health:${episode + 1}` }));
      return !before.some(t => t.id === created.id);
    },

    async fileGap(gap) {
      // Linked even when it exists, so a link a failed filing missed is added on the next.
      const link = async (id: string) => {
        if (gap.sourceTaskId) await r(() => opts.agentActor.links.add(id, gap.sourceTaskId!, 'discovered-from'));
      };
      const [existing] = await r(() => tg.tasks.list({ key: gap.key }));
      if (existing) {
        await link(existing.id);
        return 'exists';
      }
      // Under the source task's epic while it is open; standalone once it has closed.
      let parent: string | undefined;
      if (gap.sourceTaskId) {
        const source = await r(() => tg.tasks.get(gap.sourceTaskId!));
        if (source.parentId) {
          const epic = await r(() => tg.tasks.get(source.parentId!));
          if (!['done', 'cancelled'].includes(epic.state)) parent = epic.id;
        }
      }
      const create = (under?: string) => r(() => opts.agentActor.tasks.create({
        title: gap.title, description: gap.description, priority: gap.priority, category: 'bug',
        tags: ['parikshaka'], key: gap.key, ...(under ? { parent: under } : {}),
      }));
      let task;
      try {
        task = await create(parent);
      } catch (err) {
        // The epic completed since it was read: file the gap standalone.
        if (!parent || (err as { code?: string }).code !== 'InvalidRequest') throw err;
        task = await create();
      }
      await link(task.id);
      return 'filed';
    },

    async recordAcceptance(taskId, passed) {
      // Green gates and an approval pass the auto checks only; a manual check
      // waits for the developer's confirmation, so finish is refused and the
      // task flagged for them.
      const manual = await r(() => shreni.db.selectFrom('shreni.acceptance_checks').select('id')
        .where('project_id', '=', tg.id).where('task_id', '=', taskId).where('mode', '=', 'manual').limit(1).execute());
      const attempt = await currentAttempt(taskId);
      if (attempt) await r(() => putEvidence(attempt, { gates: { acceptance: { passed: passed && !manual.length } } }));
    },
  };
}
