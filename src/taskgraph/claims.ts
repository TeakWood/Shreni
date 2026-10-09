import { sql, type Kysely } from 'kysely';
import type { ActorHandle, TaskGraphClient } from './client';
import type { Lifecycle, Move } from './lifecycle';
import { SYSTEM_ROLE } from './lifecycle';
import { parse, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import { CLAIM_ORDER, claimableState, readyWhere } from './ready';
import { filterWhere, TaskFilterSchema } from './reads';
import { InvalidRequest, NotPermitted } from './errors';
import type { NewEvent } from './events';
import type { Task, TaskFilter } from './types';

// Claims and the lease sweep (engine spec, "Claiming and leases"). A claim
// runs the sweep, then picks one ready task with SKIP LOCKED, so concurrent
// workers each get a different row, and leases it under a new attempt id: the
// fencing token every leased write carries.

export type Claim = { task: Task; attemptId: string; expiresAt: Date };
export type ClaimOptions = {
  /** The process claiming, e.g. my-laptop/48211; kept on the attempt. */
  worker: string;
  /** How long the lease lasts before the sweep may return the task; renewed by heartbeat. */
  leaseMs: number;
  /** Narrows what may be claimed, e.g. { within: epicId }; its order and limit are ignored. */
  filter?: TaskFilter;
};

/** The longest lease a claim may ask for; a worker renews with heartbeats instead. */
export const MAX_LEASE_MS = 30 * 24 * 3_600_000;

const leasedState = (lc: Lifecycle) => Object.keys(lc.states).find(s => lc.states[s].leased)!;
const moveNamed = (lc: Lifecycle, name: string) => lc.moves.find(m => m.name === name)!;
/** The boosted column after a move: set by boost, cleared by clearsBoost, else kept. */
const boostAfter = (m: Move) => (m.boost ? sql`true` : m.clearsBoost ? sql`false` : sql`t.boosted`);

/**
 * Returns lapsed leases through onLeaseExpiry, or through onRepeatedExpiry on
 * the after-th expiry in a row, in the caller's transaction; returns how many.
 * Expiries count since the task's last attempt that ended another way.
 */
export async function sweep(db: Kysely<any>, lifecycle: Lifecycle, projectId: string, emit: (e: NewEvent) => void): Promise<number> {
  const expire = moveNamed(lifecycle, lifecycle.hooks.onLeaseExpiry);
  const repeat = lifecycle.hooks.onRepeatedExpiry;
  const repeatMove = repeat ? moveNamed(lifecycle, repeat.move) : expire;
  const leased = leasedState(lifecycle);

  const expired = await sql<{ id: string; attempt_id: string; expiries: number }>`
    select t.id, t.lease_attempt_id as attempt_id, (r.prior + 1)::int as expiries
      from taskgraph.tasks t
     cross join lateral (
       select count(*) as prior
         from taskgraph.attempts a
        where a.project_id = t.project_id and a.task_id = t.id and a.outcome = ${expire.name}
          and a.started_at > coalesce(
                (select max(b.started_at) from taskgraph.attempts b
                  where b.project_id = t.project_id and b.task_id = t.id and b.outcome <> ${expire.name}),
                '-infinity')
     ) r
     where t.project_id = ${projectId} and t.state = ${leased} and t.lease_expires_at < taskgraph.now()
     order by t.id
     for update of t skip locked`.execute(db);

  for (const x of expired.rows) {
    const repeated = !!repeat && x.expiries >= repeat.after;
    const m = repeated ? repeatMove : expire;
    await sql`update taskgraph.tasks t
                 set state = ${m.to}, boosted = ${boostAfter(m)},
                     lease_attempt_id = null, lease_expires_at = null, updated_at = taskgraph.now()
               where t.project_id = ${projectId} and t.id = ${x.id}`.execute(db);
    await sql`update taskgraph.attempts set ended_at = taskgraph.now(), outcome = ${m.name}
               where id = ${x.attempt_id} and ended_at is null`.execute(db);
    emit({
      projectId, taskId: x.id, attemptId: x.attempt_id, kind: `move:${m.name}`, actor: SYSTEM_ROLE, actorRole: SYSTEM_ROLE,
      fromState: leased, toState: m.to, payload: { expiries: x.expiries },
    });
  }
  return expired.rows.length;
}

/** tg.expireLeases(): the sweep on its own, as system; returns how many leases it returned. */
export function expireLeasesApi(client: TaskGraphClient, projectId: string) {
  return async function expireLeases(): Promise<number> {
    await client.need('0002_triggers');
    return client.transaction(({ db, emit }) => sweep(db, client.lifecycle, projectId, emit));
  };
}

export function claimApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;
  const claimMove = moveNamed(lifecycle, lifecycle.hooks.onClaim);

  /** Sweeps, then leases the next ready task to this worker; null when nothing is ready. */
  return async function claim(opts: ClaimOptions): Promise<Claim | null> {
    if (!opts?.worker) throw new InvalidRequest('a claim needs a worker');
    if (!(Number.isInteger(opts.leaseMs) && opts.leaseMs > 0 && opts.leaseMs <= MAX_LEASE_MS)) {
      throw new InvalidRequest(`leaseMs must be a whole number of milliseconds from 1 to ${MAX_LEASE_MS} (30 days), not ${opts.leaseMs}`);
    }
    const filter = parse(TaskFilterSchema, opts.filter ?? {});
    if (!claimMove.by.includes(as.actor.role)) {
      throw new NotPermitted('claim', as.actor.role, claimableState(lifecycle));
    }

    return client.transaction(async ({ db, emit }) => {
      await as.assertVersion(db);
      await sweep(db, lifecycle, projectId, emit);
      const next = await sql<{ id: string }>`
        select t.id from taskgraph.tasks t
         where ${filterWhere(projectId, filter)} and ${readyWhere(lifecycle)}
         order by ${CLAIM_ORDER}
         for update of t skip locked
         limit 1`.execute(db);
      if (!next.rows[0]) return null;
      const id = next.rows[0].id;

      const r = await sql<TaskRow>`
        update taskgraph.tasks t
           set state = ${claimMove.to}, boosted = ${boostAfter(claimMove)},
               lease_attempt_id = gen_random_uuid(),
               lease_expires_at = taskgraph.now() + make_interval(secs => ${opts.leaseMs / 1000}),
               updated_at = taskgraph.now()
         where t.project_id = ${projectId} and t.id = ${id}
        returning ${TASK_COLUMNS}`.execute(db);
      const task = toTask(r.rows[0]);
      await sql`insert into taskgraph.attempts (id, project_id, task_id, worker, actor)
                values (${task.leaseAttemptId}::uuid, ${projectId}, ${id}, ${opts.worker}, ${as.actor.id})`.execute(db);
      emit({
        projectId, taskId: id, attemptId: task.leaseAttemptId!, kind: `move:${claimMove.name}`,
        actor: as.actor.id, actorRole: as.actor.role, fromState: claimableState(lifecycle), toState: claimMove.to,
        payload: { worker: opts.worker, leaseMs: opts.leaseMs },
      });
      return { task, attemptId: task.leaseAttemptId!, expiresAt: task.leaseExpiresAt! };
    });
  };
}
