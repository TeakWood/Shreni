import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { ActorHandle } from './client';
import { runTransaction } from './tx';
import { newTaskId, nextChildId } from './ids';
import { InvalidRequest, NotFound } from './errors';
import { LOCK_NAMESPACE } from './locks';
import { jsonb, textArray, timestamp } from './sql-values';
import type { Task } from './types';

// Creating, editing and deleting tasks (engine spec, "Creating and editing
// tasks"). Where a task lands is the lifecycle's create rule, never the
// caller's choice; the origin comes from the plan or the caller's role.

export type NewTask = {
  title: string;
  description?: string;
  kind?: 'work' | 'container';
  category?: string;
  /** 0 is most urgent; defaults to 2. */
  priority?: number;
  /** The container it sits under. */
  parent?: string;
  /** The plan it is filed in; the plan must be neither approved nor discarded. */
  plan?: string;
  /** The caller's dedupe key: a key that exists returns the existing task. */
  key?: string;
  spec?: Record<string, unknown>;
  tags?: string[];
  /** Not claimable before this time. */
  holdUntil?: Date;
};

export type TaskPatch = {
  title?: string;
  description?: string | null;
  category?: string | null;
  priority?: number;
  tags?: string[];
  spec?: Record<string, unknown>;
  holdUntil?: Date | null;
  /** Reparent, keeping the id; null takes it out of its container. */
  parent?: string | null;
  kind?: 'work' | 'container';
};

export type WriteOptions = { requestId?: string };

const title = z.string().min(1).max(500);
const priority = z.number().int().min(0).max(4);
const kind = z.enum(['work', 'container']);
const spec = z.record(z.string(), z.unknown());
const tags = z.array(z.string());

// Not strict: an unknown field, such as a state, is dropped, never applied.
const NewTaskSchema = z.object({
  title, kind: kind.optional(), priority: priority.optional(), spec: spec.optional(), tags: tags.optional(),
  description: z.string().optional(), category: z.string().optional(),
  parent: z.string().min(1).optional(), plan: z.string().min(1).optional(), key: z.string().min(1).optional(),
  holdUntil: z.date().optional(),
});

const TaskPatchSchema = z.strictObject({
  title: title.optional(), priority: priority.optional(), spec: spec.optional(), tags: tags.optional(), kind: kind.optional(),
  description: z.string().nullable().optional(), category: z.string().nullable().optional(),
  holdUntil: z.date().nullable().optional(), parent: z.string().min(1).nullable().optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new InvalidRequest(r.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  return r.data;
}

/** Every column but the search vector. */
export const TASK_COLUMNS = sql.raw(`project_id, id, key, plan_id, parent_id, kind, category, title, description,
  priority, state, origin, spec, tags, boosted, hold_until, next_child, lease_attempt_id, lease_expires_at,
  created_at, updated_at, closed_at`);

export type TaskRow = {
  project_id: string; id: string; key: string | null; plan_id: string | null; parent_id: string | null;
  kind: Task['kind']; category: string | null; title: string; description: string | null; priority: number;
  state: string; origin: Task['origin']; spec: Record<string, unknown>; tags: string[]; boosted: boolean;
  hold_until: Date | null; next_child: number; lease_attempt_id: string | null; lease_expires_at: Date | null;
  created_at: Date; updated_at: Date; closed_at: Date | null;
};

export function toTask(r: TaskRow): Task {
  return {
    projectId: r.project_id, id: r.id, key: r.key, planId: r.plan_id, parentId: r.parent_id, kind: r.kind,
    category: r.category, title: r.title, description: r.description, priority: r.priority, state: r.state,
    origin: r.origin, spec: r.spec, tags: r.tags, boosted: r.boosted, holdUntil: r.hold_until,
    nextChild: r.next_child, leaseAttemptId: r.lease_attempt_id, leaseExpiresAt: r.lease_expires_at,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
  };
}

/** A task by id, optionally locking its row; throws NotFound. */
export async function loadTask(db: Kysely<any>, projectId: string, id: string, lock = false): Promise<Task> {
  const r = await sql<TaskRow>`
    select ${TASK_COLUMNS} from taskgraph.tasks where project_id = ${projectId} and id = ${id}
    ${lock ? sql`for update` : sql``}`.execute(db);
  if (!r.rows[0]) throw new NotFound('task', id);
  return toTask(r.rows[0]);
}

/**
 * Thrown when the insert lost to a concurrent task with the same key. It rolls
 * the transaction back, so a child number drawn for the loser isn't used up.
 */
class KeyTaken {}

/** The project's graph lock: first in the lock order, held until commit. */
export const lockGraph = (db: Kysely<any>, projectId: string) =>
  sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE.deps}, hashtext(${projectId}))`.execute(db);

async function taskByKey(db: Kysely<any>, projectId: string, key: string): Promise<Task | undefined> {
  const r = await sql<TaskRow>`
    select ${TASK_COLUMNS} from taskgraph.tasks where project_id = ${projectId} and key = ${key}`.execute(db);
  return r.rows[0] && toTask(r.rows[0]);
}

export function tasksApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;

  return {
    /** Files a task where the lifecycle's create rule puts it; a known key returns the existing task. */
    async create(input: NewTask, opts: WriteOptions = {}): Promise<Task> {
      const t = parse(NewTaskSchema, input);
      try {
        return await runTransaction(client.db, async ({ db, emit }) => {
          await as.check('tasks.create', undefined, db);
          if (t.plan) {
            // Shared: blocks approve and discard, not other creates.
            const plan = await sql<{ approved_at: Date | null; discarded_at: Date | null }>`
              select approved_at, discarded_at from taskgraph.plans
               where project_id = ${projectId} and id = ${t.plan} for share`.execute(db);
            if (!plan.rows[0]) throw new NotFound('plan', t.plan);
            if (plan.rows[0].approved_at || plan.rows[0].discarded_at) {
              throw new InvalidRequest(`plan ${t.plan} is ${plan.rows[0].approved_at ? 'approved' : 'discarded'}; later work is a new plan`);
            }
          }
          if (t.parent) await loadTask(db, projectId, t.parent, true);
          if (t.key) {
            const existing = await taskByKey(db, projectId, t.key);
            if (existing) return existing;
          }
          const { role } = as.actor;
          const { byRole } = lifecycle.create;
          // A plan's tasks wait for the plan's approval, whoever files them.
          const state = !t.plan && byRole && Object.hasOwn(byRole, role) ? byRole[role] : lifecycle.create.state;
          const origin: Task['origin'] = t.plan ? 'plan' : role === 'system' ? 'system' : role === 'agent' ? 'agent' : 'manual';

          // `on conflict do nothing` with no target also covers the key: a
          // concurrent insert with the same key waits, then inserts nothing.
          let row: TaskRow | undefined;
          const insert = async (id: string): Promise<boolean> => {
            const r = await sql<TaskRow>`
              insert into taskgraph.tasks
                (project_id, id, key, plan_id, parent_id, kind, category, title, description, priority, state, origin,
                 spec, tags, hold_until)
              values (${projectId}, ${id}, ${t.key ?? null}, ${t.plan ?? null}, ${t.parent ?? null}, ${t.kind ?? 'work'},
                ${t.category ?? null}, ${t.title}, ${t.description ?? null}, ${t.priority ?? 2}, ${state}, ${origin},
                ${jsonb(t.spec ?? {})}, ${textArray(t.tags ?? [])}, ${timestamp(t.holdUntil ?? null)})
              on conflict do nothing
              returning ${TASK_COLUMNS}`.execute(db);
            row = r.rows[0];
            if (row) return true;
            if (t.key && (await taskByKey(db, projectId, t.key))) throw new KeyTaken();
            return false;
          };
          if (t.parent) {
            // The parent's row is locked above, so siblings are created one at a time.
            const id = await nextChildId(db, projectId, t.parent);
            if (!(await insert(id))) throw new Error(`taskgraph: child id ${id} is already taken`);
          } else {
            await newTaskId(db, projectId, insert);
          }
          const task = toTask(row!);
          emit({
            projectId, taskId: task.id, planId: task.planId ?? undefined, kind: 'task.created',
            actor: as.actor.id, actorRole: role, toState: state, requestId: opts.requestId,
            payload: { title: task.title, kind: task.kind, origin, parentId: task.parentId, key: task.key },
          });
          return task;
        });
      } catch (err) {
        if (!(err instanceof KeyTaken)) throw err;
        const existing = await taskByKey(client.db, projectId, t.key!);
        if (!existing) throw new Error(`taskgraph: task with key ${t.key} vanished`);
        return existing;
      }
    },

    /** Changes the fields the tasks.update permission allows in the task's state; writes task.updated. */
    async update(id: string, input: TaskPatch, opts: WriteOptions = {}): Promise<Task> {
      const patch = parse(TaskPatchSchema, input);
      return runTransaction(client.db, async ({ db, emit }) => {
        // A reparent takes the graph lock first, so two can't each pass the
        // subtree check and together form a parent cycle.
        if (patch.parent !== undefined) await lockGraph(db, projectId);
        // Lock order: parent rows, then the task. Read the parent first, lock
        // both parents, then the task, and start over if it moved meanwhile.
        let task: Task | undefined;
        for (let tries = 0; tries < 3 && !task; tries++) {
          const seen = await loadTask(db, projectId, id);
          const parents = [seen.parentId, patch.parent].filter((p): p is string => !!p && p !== id);
          if (parents.length) {
            await sql`select 1 from taskgraph.tasks where project_id = ${projectId}
                       and id = any(${textArray([...new Set(parents)].sort())}) order by id for update`.execute(db);
          }
          const locked = await loadTask(db, projectId, id, true);
          if (locked.parentId === seen.parentId) task = locked;
        }
        if (!task) throw new InvalidRequest(`task ${id} kept moving while being edited; try again`);
        await as.check('tasks.update', task.state, db);

        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const sets: RawBuilder<unknown>[] = [];
        const change = (field: string, column: string, from: unknown, to: unknown, value: RawBuilder<unknown> | unknown) => {
          if (JSON.stringify(from) === JSON.stringify(to)) return;
          changes[field] = { from, to };
          sets.push(sql`${sql.ref(column)} = ${value}`);
        };
        const iso = (d: Date | null) => (d ? d.toISOString() : null);

        if (patch.title !== undefined) change('title', 'title', task.title, patch.title, patch.title);
        if (patch.description !== undefined) change('description', 'description', task.description, patch.description, patch.description);
        if (patch.category !== undefined) change('category', 'category', task.category, patch.category, patch.category);
        if (patch.priority !== undefined) change('priority', 'priority', task.priority, patch.priority, patch.priority);
        if (patch.tags !== undefined) change('tags', 'tags', task.tags, patch.tags, textArray(patch.tags));
        if (patch.spec !== undefined) change('spec', 'spec', task.spec, patch.spec, jsonb(patch.spec));
        if (patch.holdUntil !== undefined) {
          change('holdUntil', 'hold_until', iso(task.holdUntil), iso(patch.holdUntil), timestamp(patch.holdUntil));
        }
        if (patch.kind !== undefined && patch.kind !== task.kind) {
          const used = await sql<{ n: number }>`
            select (select count(*) from taskgraph.tasks where project_id = ${projectId} and parent_id = ${id})
                 + (select count(*) from taskgraph.attempts where project_id = ${projectId} and task_id = ${id}) as n`.execute(db);
          if (Number(used.rows[0].n) > 0) throw new InvalidRequest(`task ${id} has children or attempts, so its kind can't change`);
          change('kind', 'kind', task.kind, patch.kind, patch.kind);
        }
        if (patch.parent !== undefined && patch.parent !== task.parentId) {
          if (patch.parent !== null) {
            if (patch.parent === id) throw new InvalidRequest(`task ${id} can't be its own parent`);
            await loadTask(db, projectId, patch.parent);
            // The new parent must not sit inside this task's subtree.
            const loop = await sql<{ hit: boolean }>`
              with recursive up(id, parent_id) as (
                select id, parent_id from taskgraph.tasks where project_id = ${projectId} and id = ${patch.parent}
                union
                select t.id, t.parent_id from taskgraph.tasks t join up on t.id = up.parent_id
                 where t.project_id = ${projectId}
              )
              select exists (select 1 from up where id = ${id}) as hit`.execute(db);
            if (loop.rows[0].hit) throw new InvalidRequest(`task ${patch.parent} is inside ${id}'s subtree`);
          }
          change('parent', 'parent_id', task.parentId, patch.parent, patch.parent);
        }
        if (sets.length === 0) return task;

        const r = await sql<TaskRow>`
          update taskgraph.tasks set ${sql.join(sets)}, updated_at = taskgraph.now()
           where project_id = ${projectId} and id = ${id}
          returning ${TASK_COLUMNS}`.execute(db);
        emit({
          projectId, taskId: id, kind: 'task.updated', actor: as.actor.id, actorRole: as.actor.role,
          requestId: opts.requestId, payload: { changes },
        });
        return toTask(r.rows[0]);
      });
    },

    /** Removes a task still in create.state, with no attempts or children, and its edges; writes task.deleted. */
    async delete(id: string, opts: WriteOptions = {}): Promise<void> {
      await runTransaction(client.db, async ({ db, emit }) => {
        await lockGraph(db, projectId);
        const task = await loadTask(db, projectId, id, true);
        await as.check('tasks.delete', task.state, db);
        if (task.state !== lifecycle.create.state) {
          throw new InvalidRequest(`task ${id} has left ${lifecycle.create.state}; cancel it instead`);
        }
        const used = await sql<{ attempts: number; children: number }>`
          select (select count(*) from taskgraph.attempts where project_id = ${projectId} and task_id = ${id})::int as attempts,
                 (select count(*) from taskgraph.tasks where project_id = ${projectId} and parent_id = ${id})::int as children`.execute(db);
        if (used.rows[0].attempts > 0) throw new InvalidRequest(`task ${id} has attempts; cancel it instead`);
        if (used.rows[0].children > 0) throw new InvalidRequest(`task ${id} has children; delete or move them first`);
        // Its edges go with it; each task that waited on it gets dep.removed.
        const dependents = await sql<{ task_id: string }>`
          select task_id from taskgraph.task_deps
           where project_id = ${projectId} and depends_on_id = ${id} order by task_id`.execute(db);
        await sql`delete from taskgraph.tasks where project_id = ${projectId} and id = ${id}`.execute(db);
        for (const { task_id } of dependents.rows) {
          emit({
            projectId, taskId: task_id, kind: 'dep.removed', actor: as.actor.id, actorRole: as.actor.role,
            payload: { dependsOnId: id, reason: 'deleted' },
          });
        }
        emit({
          projectId, taskId: id, kind: 'task.deleted', actor: as.actor.id, actorRole: as.actor.role,
          fromState: task.state, requestId: opts.requestId, payload: { title: task.title },
        });
      });
    },
  };
}
