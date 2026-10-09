import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Project, TaskGraphClient } from './client';
import type { Lifecycle } from './lifecycle';
import { lockGraph, TASK_COLUMNS, toTask, type TaskRow } from './tasks';
import { runTransaction } from './tx';
import { jsonb, textArray, timestamp } from './sql-values';
import { CycleError, InvalidRequest, NotFound, VersionMismatch } from './errors';
import type { Actor, Attempt, Plan, Task, TaskGraphEvent } from './types';

// Import, export and purge (engine spec, "Import, export and purge"): the
// three calls that work on a whole project. A bundle is the engine's own
// format, every row of one project; it survives JSON, so dates may come back
// as strings.

export const BUNDLE_FORMAT = 'taskgraph.bundle';

export type BundleTask = Omit<Task, 'projectId'>;
export type BundlePlan = Omit<Plan, 'projectId'>;
export type BundleEvent = Omit<TaskGraphEvent, 'id' | 'projectId'>;

export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  /** The id is kept on import when present, so a restore keeps the repo's config valid. */
  project: { id?: string; name: string; idPrefix: string; lifecycleName: string; lifecycleVersion: number; createdAt: Date };
  plans: BundlePlan[];
  tasks: BundleTask[];
  deps: { taskId: string; dependsOnId: string }[];
  links: { a: string; b: string; kind: string }[];
  attempts: Attempt[];
  /** Oldest first, in the order they were written. */
  events: BundleEvent[];
};

export type ImportReport = { project: Project; counts: Record<string, number> };
export type PurgeReport = { projectId: string; name: string; counts: Record<string, number> };
/** Runs inside the import's transaction, after the rows are written; throwing rolls everything back. */
export type ImportCallback = (tx: { db: Transaction<any>; project: Project }) => Promise<void>;

const id = z.string().min(1);
// Any 8-4-4-4-12 hex uuid; zod's uuid() also checks the version digit.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.coerce.date();
const json = z.record(z.string(), z.unknown());
const BundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(1),
  project: z.object({
    id: uuid.optional(), name: z.string().min(1), idPrefix: z.string().min(1),
    lifecycleName: z.string().min(1), lifecycleVersion: z.number().int(), createdAt: date,
  }),
  plans: z.array(z.object({
    id, title: z.string(), meta: json, approvedAt: date.nullable(), approvedBy: z.string().nullable(),
    discardedAt: date.nullable(), discardedBy: z.string().nullable(), createdAt: date,
  })),
  tasks: z.array(z.object({
    id, key: z.string().nullable(), planId: z.string().nullable(), parentId: z.string().nullable(),
    kind: z.enum(['work', 'container']), category: z.string().nullable(), title: z.string(), description: z.string().nullable(),
    priority: z.number().int(), state: id, origin: z.enum(['plan', 'manual', 'system', 'agent', 'imported']),
    spec: json, tags: z.array(z.string()), boosted: z.boolean(), holdUntil: date.nullable(), nextChild: z.number().int().min(1),
    leaseAttemptId: uuid.nullable(), leaseExpiresAt: date.nullable(),
    createdAt: date, updatedAt: date, closedAt: date.nullable(),
  })),
  deps: z.array(z.object({ taskId: id, dependsOnId: id })),
  links: z.array(z.object({ a: id, b: id, kind: id })),
  attempts: z.array(z.object({
    id: uuid, taskId: id, worker: z.string(), actor: z.string(), startedAt: date,
    endedAt: date.nullable(), outcome: z.string().nullable(),
  })),
  events: z.array(z.object({
    taskId: z.string().nullable(), planId: z.string().nullable(), attemptId: uuid.nullable(), kind: id,
    actor: z.string(), actorRole: z.string(), fromState: z.string().nullable(), toState: z.string().nullable(),
    payload: json, requestId: z.string().nullable(), at: date,
  })),
});

function parseBundle(input: unknown): ProjectBundle {
  const r = BundleSchema.safeParse(input);
  if (!r.success) {
    throw new InvalidRequest(`not a ${BUNDLE_FORMAT} v1: ` + r.error.issues.slice(0, 5)
      .map(i => `${i.path.join('.') || 'bundle'}: ${i.message}`).join('; '));
  }
  return r.data as ProjectBundle;
}

/** Throws when two of the items share a key. */
function unique<T>(what: string, items: readonly T[], key: (x: T) => string | null): void {
  const seen = new Set<string>();
  for (const x of items) {
    const k = key(x);
    if (k === null) continue;
    if (seen.has(k)) throw new InvalidRequest(`the bundle repeats ${what} ${k}`);
    seen.add(k);
  }
}

/**
 * Refuses a bundle no engine path could have produced: duplicates, references
 * to rows it lacks, parent loops, dependency cycles, leases that don't match
 * their attempts, and the container and dependent rules broken. The trigger
 * exempts an import from the create rules and moves only, not these.
 */
function checkGraph(b: ProjectBundle, lifecycle: Lifecycle): void {
  unique('task id', b.tasks, t => t.id);
  unique('task key', b.tasks, t => t.key);
  unique('plan id', b.plans, p => p.id);
  unique('attempt id', b.attempts, a => a.id);
  unique('dependency', b.deps, d => `${d.taskId} -> ${d.dependsOnId}`);
  unique('link', b.links, l => `${l.a} -${l.kind}-> ${l.b}`);
  unique('request id', b.events, e => e.requestId);
  const ids = new Set(b.tasks.map(t => t.id));
  const missing = (what: string, x: string | null) => {
    if (x !== null && !ids.has(x)) throw new InvalidRequest(`${what} names task ${x}, which the bundle doesn't have`);
  };
  for (const t of b.tasks) missing(`task ${t.id}'s parent`, t.parentId);
  for (const d of b.deps) { missing('a dependency', d.taskId); missing('a dependency', d.dependsOnId); }
  for (const l of b.links) { missing('a link', l.a); missing('a link', l.b); }
  for (const a of b.attempts) missing(`attempt ${a.id}`, a.taskId);
  const plans = new Set(b.plans.map(p => p.id));
  for (const t of b.tasks) {
    if (t.planId !== null && !plans.has(t.planId)) throw new InvalidRequest(`task ${t.id} names plan ${t.planId}, which the bundle doesn't have`);
  }

  const parent = new Map(b.tasks.map(t => [t.id, t.parentId]));
  for (const t of b.tasks) {
    const seen = new Set<string>();
    for (let p: string | null | undefined = t.id; p; p = parent.get(p)) {
      if (seen.has(p)) throw new InvalidRequest(`task ${t.id}'s parents loop back on themselves`);
      seen.add(p);
    }
  }

  // Dependency cycles: depth-first, white/grey/black.
  const out = new Map<string, string[]>();
  for (const d of b.deps) {
    if (d.taskId === d.dependsOnId) throw new CycleError(d.taskId, d.dependsOnId);
    out.set(d.taskId, [...(out.get(d.taskId) ?? []), d.dependsOnId]);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): void => {
    state.set(n, 1);
    for (const m of out.get(n) ?? []) {
      if (state.get(m) === 1) throw new CycleError(n, m);
      if (!state.has(m)) visit(m);
    }
    state.set(n, 2);
  };
  for (const n of out.keys()) if (!state.has(n)) visit(n);

  // Leases: a task is in the leased state exactly when it holds a lease, and
  // the lease is its one open attempt.
  const flags = (s: string) => lifecycle.states[s] ?? {};
  const open = new Map<string, string>();
  for (const a of b.attempts) {
    if (a.endedAt !== null) continue;
    if (open.has(a.taskId)) throw new InvalidRequest(`task ${a.taskId} has more than one open attempt`);
    open.set(a.taskId, a.id);
  }
  for (const t of b.tasks) {
    const leased = !!flags(t.state).leased;
    if (leased !== (t.leaseAttemptId !== null)) {
      throw new InvalidRequest(`task ${t.id} is ${t.state} ${leased ? 'without a lease' : 'but holds a lease'}`);
    }
    if ((t.leaseAttemptId ?? undefined) !== open.get(t.id)) {
      throw new InvalidRequest(`task ${t.id}'s lease and its open attempt don't match`);
    }
  }

  // Containers and dependents.
  const byId = new Map(b.tasks.map(t => [t.id, t]));
  for (const t of b.tasks) {
    const parentState = t.parentId ? byId.get(t.parentId)!.state : null;
    if (parentState && flags(parentState).terminal && !flags(t.state).terminal) {
      throw new InvalidRequest(`task ${t.parentId} is ${parentState} with a live child, ${t.id}`);
    }
  }
  for (const d of b.deps) {
    const target = byId.get(d.dependsOnId)!.state;
    if (!flags(byId.get(d.taskId)!.state).terminal && flags(target).terminal && !flags(target).satisfiesDeps) {
      throw new InvalidRequest(`task ${d.taskId} waits on ${d.dependsOnId}, which is ${target}`);
    }
  }
}

/**
 * The highest `<n>` among ids of the shape `<task>.<n>`, by the task the id
 * names, wherever the child sits now: ids are kept across reparents.
 */
function highestChild(tasks: BundleTask[]): Map<string, number> {
  const high = new Map<string, number>();
  for (const t of tasks) {
    const m = /^(.+)\.(\d+)$/.exec(t.id);
    if (!m) continue;
    const n = Number(m[2]);
    if (n > (high.get(m[1]) ?? 0)) high.set(m[1], n);
  }
  return high;
}

const errorCode = (err: unknown) => (err as { code?: string })?.code;

/** Carries the import callback's error past the mapping of the engine's own. */
class CallbackFailed {
  constructor(readonly cause: unknown) {}
}

export async function importProject(
  client: TaskGraphClient, input: ProjectBundle, opts: { actor: Actor; name?: string; idPrefix?: string }, inTx?: ImportCallback,
): Promise<ImportReport> {
  const b = parseBundle(input);
  const { lifecycle } = client;
  if (b.project.lifecycleName !== lifecycle.name || b.project.lifecycleVersion !== lifecycle.version) {
    throw new VersionMismatch(`the bundle is on lifecycle ${b.project.lifecycleName}@${b.project.lifecycleVersion}; this process runs ${lifecycle.name}@${lifecycle.version}`);
  }
  checkGraph(b, lifecycle);
  const name = opts.name ?? b.project.name;
  const idPrefix = opts.idPrefix ?? b.project.idPrefix;
  const high = highestChild(b.tasks);

  try {
    return await client.transaction(async ({ db, emit }) => {
      const p = await sql<{ id: string; created_at: Date }>`
        insert into taskgraph.projects (id, name, id_prefix, lifecycle_name, lifecycle_version, created_at)
        values (coalesce(${b.project.id ?? null}::uuid, gen_random_uuid()), ${name}, ${idPrefix},
                ${lifecycle.name}, ${lifecycle.version}, ${timestamp(b.project.createdAt)})
        returning id, created_at`.execute(db);
      const projectId = p.rows[0].id;
      await sql`select set_config('taskgraph.importing', ${projectId}, true)`.execute(db);

      for (const pl of b.plans) {
        await sql`insert into taskgraph.plans
            (project_id, id, title, meta, approved_at, approved_by, discarded_at, discarded_by, created_at)
          values (${projectId}, ${pl.id}, ${pl.title}, ${jsonb(pl.meta)}, ${timestamp(pl.approvedAt)}, ${pl.approvedBy},
                  ${timestamp(pl.discardedAt)}, ${pl.discardedBy}, ${timestamp(pl.createdAt)})`.execute(db);
      }
      // Parents are set in a second pass, so the order of tasks in the bundle doesn't matter.
      for (const t of b.tasks) {
        await sql`insert into taskgraph.tasks
            (project_id, id, key, plan_id, parent_id, kind, category, title, description, priority, state, origin, spec,
             tags, boosted, hold_until, next_child, lease_attempt_id, lease_expires_at, created_at, updated_at, closed_at)
          values (${projectId}, ${t.id}, ${t.key}, ${t.planId}, null, ${t.kind}, ${t.category}, ${t.title}, ${t.description},
                  ${t.priority}, ${t.state}, ${t.origin}, ${jsonb(t.spec)}, ${textArray(t.tags)}, ${t.boosted},
                  ${timestamp(t.holdUntil)}, ${Math.max(t.nextChild, (high.get(t.id) ?? 0) + 1)},
                  ${t.leaseAttemptId}::uuid, ${timestamp(t.leaseExpiresAt)},
                  ${timestamp(t.createdAt)}, ${timestamp(t.updatedAt)}, ${timestamp(t.closedAt)})`.execute(db);
      }
      for (const t of b.tasks) {
        if (t.parentId) {
          await sql`update taskgraph.tasks set parent_id = ${t.parentId}
                     where project_id = ${projectId} and id = ${t.id}`.execute(db);
        }
      }
      for (const d of b.deps) {
        await sql`insert into taskgraph.task_deps (project_id, task_id, depends_on_id)
                  values (${projectId}, ${d.taskId}, ${d.dependsOnId}) on conflict do nothing`.execute(db);
      }
      for (const l of b.links) {
        await sql`insert into taskgraph.task_links (project_id, a, b, kind)
                  values (${projectId}, ${l.a}, ${l.b}, ${l.kind}) on conflict do nothing`.execute(db);
      }
      for (const a of b.attempts) {
        await sql`insert into taskgraph.attempts (id, project_id, task_id, worker, actor, started_at, ended_at, outcome)
                  values (${a.id}::uuid, ${projectId}, ${a.taskId}, ${a.worker}, ${a.actor},
                          ${timestamp(a.startedAt)}, ${timestamp(a.endedAt)}, ${a.outcome})`.execute(db);
      }
      for (const ev of b.events) {
        emit({
          projectId, kind: ev.kind, actor: ev.actor, actorRole: ev.actorRole,
          taskId: ev.taskId ?? undefined, planId: ev.planId ?? undefined, attemptId: ev.attemptId ?? undefined,
          fromState: ev.fromState ?? undefined, toState: ev.toState ?? undefined, payload: ev.payload,
          requestId: ev.requestId ?? undefined, at: ev.at,
        });
      }
      const counts = {
        plans: b.plans.length, tasks: b.tasks.length, deps: b.deps.length, links: b.links.length,
        attempts: b.attempts.length, events: b.events.length,
      };
      emit({ projectId, kind: 'project.imported', actor: opts.actor.id, actorRole: opts.actor.role, payload: { name, idPrefix, counts } });

      const project: Project = {
        id: projectId, name, idPrefix, lifecycleName: lifecycle.name, lifecycleVersion: lifecycle.version,
        createdAt: p.rows[0].created_at,
      };
      if (inTx) {
        try {
          await inTx({ db, project });
        } catch (err) {
          throw new CallbackFailed(err);
        }
      }
      return { project, counts };
    });
  } catch (err) {
    // The caller's own error, untouched.
    if (err instanceof CallbackFailed) throw err.cause;
    const code = errorCode(err);
    if (code === '23505') throw new InvalidRequest(`the import clashes with rows already in the database: ${(err as Error).message}`);
    if (code === '23503' || code === '23514') throw new InvalidRequest(`the bundle breaks a constraint: ${(err as Error).message}`);
    throw err;
  }
}

type Row = Record<string, any>;

export async function exportProject(db: Kysely<any>, projectId: string): Promise<ProjectBundle> {
  // One snapshot, so the rows agree with each other.
  return db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    const q = async <R = Row>(query: ReturnType<typeof sql>) => (await query.execute(trx)).rows as R[];
    const [p] = await q(sql`select * from taskgraph.projects where id = ${projectId}`);
    if (!p) throw new NotFound('project', projectId);
    const plans = await q(sql`select * from taskgraph.plans where project_id = ${projectId} order by created_at, id`);
    const tasks = await q<TaskRow>(sql`select ${TASK_COLUMNS} from taskgraph.tasks where project_id = ${projectId} order by id`);
    const deps = await q(sql`select task_id, depends_on_id from taskgraph.task_deps where project_id = ${projectId} order by task_id, depends_on_id`);
    const links = await q(sql`select a, b, kind from taskgraph.task_links where project_id = ${projectId} order by a, b, kind`);
    const attempts = await q(sql`select * from taskgraph.attempts where project_id = ${projectId} order by started_at, id`);
    const events = await q(sql`select * from taskgraph.events where project_id = ${projectId} order by id`);
    return {
      format: BUNDLE_FORMAT,
      version: 1,
      project: {
        id: p.id, name: p.name, idPrefix: p.id_prefix, lifecycleName: p.lifecycle_name,
        lifecycleVersion: p.lifecycle_version, createdAt: p.created_at,
      },
      plans: plans.map(r => ({
        id: r.id, title: r.title, meta: r.meta, approvedAt: r.approved_at, approvedBy: r.approved_by,
        discardedAt: r.discarded_at, discardedBy: r.discarded_by, createdAt: r.created_at,
      })),
      tasks: tasks.map(r => {
        const { projectId: _p, ...t } = toTask(r);
        return t;
      }),
      deps: deps.map(r => ({ taskId: r.task_id, dependsOnId: r.depends_on_id })),
      links: links.map(r => ({ a: r.a, b: r.b, kind: r.kind })),
      attempts: attempts.map(r => ({
        id: r.id, taskId: r.task_id, worker: r.worker, actor: r.actor, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
      })),
      events: events.map(r => ({
        taskId: r.task_id, planId: r.plan_id, attemptId: r.attempt_id, kind: r.kind, actor: r.actor, actorRole: r.actor_role,
        fromState: r.from_state, toState: r.to_state, payload: r.payload, requestId: r.request_id, at: r.at,
      })),
    };
  });
}

export async function purgeProject(
  db: Kysely<any>, projectId: string, opts: { actor: Actor; confirmName: string },
): Promise<PurgeReport> {
  // Not stamped with a lifecycle: a project on any version can be purged.
  return runTransaction(db, async ({ db: tx }) => {
    const p = await sql<{ name: string }>`select name from taskgraph.projects where id = ${projectId} for update`.execute(tx);
    if (!p.rows[0]) throw new NotFound('project', projectId);
    const { name } = p.rows[0];
    if (opts.confirmName !== name) throw new InvalidRequest(`type the project's name, ${JSON.stringify(name)}, to purge it`);
    await sql`select set_config('taskgraph.purging', ${projectId}, true)`.execute(tx);
    // Every write to a project locks a task row, the graph or the project row
    // (a new task's foreign key). Holding all three first means a writer in
    // flight finishes before the deletes, or finds its task gone after.
    await lockGraph(tx, projectId);
    await sql`select 1 from taskgraph.tasks where project_id = ${projectId} for update`.execute(tx);
    const counts: Record<string, number> = {};
    const del = async (key: string, table: string) => {
      const r = await sql`delete from ${sql.table(`taskgraph.${table}`)} where project_id = ${projectId}`.execute(tx);
      counts[key] = Number(r.numAffectedRows ?? 0);
    };
    await del('deps', 'task_deps');
    await del('links', 'task_links');
    await del('attempts', 'attempts');
    await del('tasks', 'tasks');
    await del('plans', 'plans');
    // Last, as a statement of its own: at READ COMMITTED it sees the events
    // of every writer the locks above waited for.
    await del('events', 'events');
    const r = await sql`delete from taskgraph.projects where id = ${projectId}`.execute(tx);
    counts.projects = Number(r.numAffectedRows ?? 0);
    await sql`insert into taskgraph.purges (project_id, name, actor, counts)
              values (${projectId}, ${name}, ${opts.actor.id}, ${jsonb(counts)})`.execute(tx);
    return { projectId, name, counts };
  });
}
