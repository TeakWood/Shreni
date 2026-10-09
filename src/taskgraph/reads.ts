import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { ProjectHandle } from './client';
import { loadTask, parse, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { CLAIM_ORDER, readyWhere } from './ready';
import { settledContainers } from './containers';
import { textArray, timestamp } from './sql-values';
import { InvalidRequest, NotFound } from './errors';
import type { Attempt, Plan, PlanFilter, Task, TaskDetail, TaskFilter, TaskGraphEvent } from './types';

// Reads (engine spec, "API"): on the project handle, with no actor. They see
// committed rows only and need no lifecycle version match, so a process on a
// newer lifecycle can read before activating it.

const nonEmpty = z.string().min(1);
export const TaskFilterSchema = z.object({
  states: z.array(nonEmpty).optional(),
  kind: z.enum(['work', 'container']).optional(),
  ids: z.array(nonEmpty).optional(),
  key: nonEmpty.optional(),
  parent: nonEmpty.optional(),
  within: nonEmpty.optional(),
  plan: nonEmpty.optional(),
  origin: z.array(z.enum(['plan', 'manual', 'system', 'agent', 'imported'])).optional(),
  tags: z.array(nonEmpty).optional(),
  orderBy: z.enum(['claim', 'created', 'updated', 'closed']).optional(),
  limit: z.number().int().min(0).optional(),
}).strict();

const PlanFilterSchema = z.object({ status: z.array(z.enum(['open', 'approved', 'discarded'])).optional() }).strict();

const ORDER: Record<NonNullable<TaskFilter['orderBy']>, RawBuilder<unknown>> = {
  claim: CLAIM_ORDER,
  created: sql`t.created_at, t.id`,
  updated: sql`t.updated_at, t.id`,
  closed: sql`t.closed_at nulls last, t.id`,
};

/** The filter as conditions on `t`, a row of taskgraph.tasks in the project. */
export function filterWhere(projectId: string, f: TaskFilter): RawBuilder<boolean> {
  const where: RawBuilder<unknown>[] = [sql`t.project_id = ${projectId}`];
  if (f.states) where.push(sql`t.state = any(${textArray(f.states)})`);
  if (f.kind) where.push(sql`t.kind = ${f.kind}`);
  if (f.ids) where.push(sql`t.id = any(${textArray(f.ids)})`);
  if (f.key) where.push(sql`t.key = ${f.key}`);
  if (f.parent) where.push(sql`t.parent_id = ${f.parent}`);
  if (f.within) {
    where.push(sql`t.id in (
      with recursive down(id) as (
        select c.id from taskgraph.tasks c where c.project_id = ${projectId} and c.parent_id = ${f.within}
        union
        select c.id from taskgraph.tasks c join down on c.parent_id = down.id where c.project_id = ${projectId}
      )
      select id from down)`);
  }
  if (f.plan) where.push(sql`t.plan_id = ${f.plan}`);
  if (f.origin) where.push(sql`t.origin = any(${textArray(f.origin)})`);
  if (f.tags) where.push(sql`t.tags @> ${textArray(f.tags)}`);
  return sql<boolean>`(${sql.join(where, sql` and `)})`;
}

const limitClause = (limit?: number) => (limit !== undefined ? sql`limit ${limit}` : sql``);

export type PlanRow = {
  project_id: string; id: string; title: string; meta: Record<string, unknown>;
  approved_at: Date | null; approved_by: string | null; discarded_at: Date | null; discarded_by: string | null; created_at: Date;
};
export const toPlan = (r: PlanRow): Plan => ({
  projectId: r.project_id, id: r.id, title: r.title, meta: r.meta, approvedAt: r.approved_at, approvedBy: r.approved_by,
  discardedAt: r.discarded_at, discardedBy: r.discarded_by, createdAt: r.created_at,
});

type AttemptRow = {
  id: string; task_id: string; worker: string; actor: string; started_at: Date; ended_at: Date | null; outcome: string | null;
};
const toAttempt = (r: AttemptRow): Attempt => ({
  id: r.id, taskId: r.task_id, worker: r.worker, actor: r.actor, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
});

type EventRow = {
  id: string; project_id: string; task_id: string | null; plan_id: string | null; attempt_id: string | null; kind: string;
  actor: string; actor_role: string; from_state: string | null; to_state: string | null; payload: Record<string, unknown>;
  request_id: string | null; at: Date;
};
// Qualified, and read through the alias e: `id::text as id` would otherwise
// make `order by id` sort the text, putting '10' before '9'.
const EVENT_COLUMNS = sql.raw(`e.id::text as id, e.project_id, e.task_id, e.plan_id, e.attempt_id, e.kind, e.actor,
  e.actor_role, e.from_state, e.to_state, e.payload, e.request_id, e.at`);
const toEvent = (r: EventRow): TaskGraphEvent => ({
  id: r.id, projectId: r.project_id, taskId: r.task_id, planId: r.plan_id, attemptId: r.attempt_id, kind: r.kind,
  actor: r.actor, actorRole: r.actor_role, fromState: r.from_state, toState: r.to_state, payload: r.payload,
  requestId: r.request_id, at: r.at,
});

const CURSOR = /^\d{1,19}$/;
const MAX_BIGINT = 2n ** 63n - 1n;
/** events.since's default page size. */
export const EVENTS_PAGE = 1000;

export function readsApi(tg: ProjectHandle) {
  const { client } = tg;
  const projectId = tg.id;
  const { lifecycle } = client;
  /** Every read needs the core schema; it runs outside any transaction. */
  const db = async (): Promise<Kysely<any>> => {
    await client.need('0001_core');
    return client.db;
  };

  async function listWhere(where: RawBuilder<boolean>, f: TaskFilter): Promise<Task[]> {
    const r = await sql<TaskRow>`
      select ${TASK_COLUMNS} from taskgraph.tasks t
       where ${where}
       order by ${ORDER[f.orderBy ?? 'claim']}
       ${limitClause(f.limit)}`.execute(await db());
    return r.rows.map(toTask);
  }

  const tasks = {
    /** A task, with its dependencies and their states, and its live claim; throws NotFound. */
    async get(id: string): Promise<TaskDetail> {
      const conn = await db();
      const task = await loadTask(conn, projectId, id);
      const deps = await sql<{ id: string; state: string }>`
        select dep.id, dep.state from taskgraph.task_deps d
          join taskgraph.tasks dep on dep.project_id = d.project_id and dep.id = d.depends_on_id
         where d.project_id = ${projectId} and d.task_id = ${id}
         order by dep.id`.execute(conn);
      let claim: TaskDetail['claim'] = null;
      if (task.leaseAttemptId && task.leaseExpiresAt) {
        const a = await sql<AttemptRow & { expired: boolean }>`
          select a.*, ${timestamp(task.leaseExpiresAt)} <= taskgraph.now() as expired from taskgraph.attempts a
           where a.project_id = ${projectId} and a.id = ${task.leaseAttemptId}`.execute(conn);
        if (a.rows[0]) {
          claim = {
            attemptId: a.rows[0].id, worker: a.rows[0].worker, actor: a.rows[0].actor,
            startedAt: a.rows[0].started_at, expiresAt: task.leaseExpiresAt, expired: a.rows[0].expired,
          };
        }
      }
      return { ...task, deps: deps.rows, claim };
    },

    /** The tasks the filter matches; every one, unless it gives a limit. */
    async list(filter: TaskFilter = {}): Promise<Task[]> {
      const f = parse(TaskFilterSchema, filter);
      return listWhere(filterWhere(projectId, f), f);
    },

    /** How many tasks the filter matches; its order and limit are ignored. */
    async count(filter: TaskFilter = {}): Promise<number> {
      const f = parse(TaskFilterSchema, filter);
      const r = await sql<{ n: number }>`
        select count(*)::int as n from taskgraph.tasks t where ${filterWhere(projectId, f)}`.execute(await db());
      return r.rows[0].n;
    },

    /** A task's direct children, oldest first; throws NotFound. */
    async children(id: string): Promise<Task[]> {
      await loadTask(await db(), projectId, id);
      return listWhere(filterWhere(projectId, { parent: id }), { orderBy: 'created' });
    },

    /** Every task below this one, oldest first; throws NotFound. */
    async subtree(id: string): Promise<Task[]> {
      await loadTask(await db(), projectId, id);
      return listWhere(filterWhere(projectId, { within: id }), { orderBy: 'created' });
    },

    /** Containers in the claimable state whose children have all settled, oldest first. */
    async settled(): Promise<Task[]> {
      return settledContainers(await db(), projectId, lifecycle);
    },

    /** A task's events, notes included, oldest first; throws NotFound. */
    async history(id: string): Promise<TaskGraphEvent[]> {
      const conn = await db();
      await loadTask(conn, projectId, id);
      const r = await sql<EventRow>`
        select ${EVENT_COLUMNS} from taskgraph.events e
         where e.project_id = ${projectId} and e.task_id = ${id} order by e.id`.execute(conn);
      return r.rows.map(toEvent);
    },

    /**
     * Tasks whose title or description holds every word of `text`, plus a
     * task whose id or key is exactly `text`, which comes first.
     */
    async search(text: string): Promise<Task[]> {
      const q = text.trim();
      if (!q) return [];
      const r = await sql<TaskRow>`
        select ${TASK_COLUMNS} from taskgraph.tasks t
         where t.project_id = ${projectId}
           and (t.id = ${q} or t.key = ${q} or t.search @@ plainto_tsquery('simple', ${q}))
         order by (t.id = ${q} or t.key is not distinct from ${q}) desc,
                  ts_rank(t.search, plainto_tsquery('simple', ${q})) desc, t.created_at, t.id`.execute(await db());
      return r.rows.map(toTask);
    },
  };

  const plans = {
    /** Throws NotFound. */
    async get(id: string): Promise<Plan> {
      const r = await sql<PlanRow>`
        select * from taskgraph.plans where project_id = ${projectId} and id = ${id}`.execute(await db());
      if (!r.rows[0]) throw new NotFound('plan', id);
      return toPlan(r.rows[0]);
    },

    /** The plans the filter matches, oldest first; every one by default. */
    async list(filter: PlanFilter = {}): Promise<Plan[]> {
      const f = parse(PlanFilterSchema, filter);
      const status = f.status ? sql`and (case when approved_at is not null then 'approved'
                                              when discarded_at is not null then 'discarded'
                                              else 'open' end) = any(${textArray(f.status)})` : sql``;
      const r = await sql<PlanRow>`
        select * from taskgraph.plans where project_id = ${projectId} ${status}
         order by created_at, id`.execute(await db());
      return r.rows.map(toPlan);
    },
  };

  const attempts = {
    /** A task's attempts, oldest first; throws NotFound. */
    async list(taskId: string): Promise<Attempt[]> {
      const conn = await db();
      await loadTask(conn, projectId, taskId);
      const r = await sql<AttemptRow>`
        select * from taskgraph.attempts where project_id = ${projectId} and task_id = ${taskId}
         order by started_at, id`.execute(conn);
      return r.rows.map(toAttempt);
    },
  };

  const events = {
    /**
     * The project's events after `cursor`, an event id ('0' for the start), in
     * id order. Ids commit in order (events are written last under the
     * project's events lock), so following the last id returned misses none.
     */
    async since(cursor: string, limit: number = EVENTS_PAGE): Promise<TaskGraphEvent[]> {
      if (!CURSOR.test(cursor) || BigInt(cursor) > MAX_BIGINT) throw new InvalidRequest(`an event cursor is an event id, not ${JSON.stringify(cursor)}`);
      if (!(Number.isInteger(limit) && limit > 0)) throw new InvalidRequest(`limit must be a positive whole number, not ${limit}`);
      const r = await sql<EventRow>`
        select ${EVENT_COLUMNS} from taskgraph.events e
         where e.project_id = ${projectId} and e.id > cast(cast(${cursor} as text) as bigint)
         order by e.id limit ${limit}`.execute(await db());
      return r.rows.map(toEvent);
    },
  };

  /** Ready work, in claim order unless the filter orders it otherwise: what a claim would pick next. */
  async function ready(filter: TaskFilter = {}): Promise<Task[]> {
    const f = parse(TaskFilterSchema, filter);
    return listWhere(sql<boolean>`${filterWhere(projectId, f)} and ${readyWhere(lifecycle)}`, f);
  }

  return { tasks, plans, attempts, events, ready };
}
