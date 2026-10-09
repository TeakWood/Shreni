import { sql, type Kysely } from 'kysely';
import type { ActorHandle, TaskGraphClient } from './client';
import type { Lifecycle, Move } from './lifecycle';
import { SYSTEM_ROLE } from './lifecycle';
import { parse, toTask, TASK_COLUMNS, type TaskRow } from './tasks';
import type { MoveOptions } from './moves';
import { CLAIM_ORDER, claimableState, readyWhere } from './ready';
import { filterWhere, TaskFilterSchema } from './reads';
import { InvalidRequest, LeaseHeld, LeaseLost, NotFound, NotPermitted } from './errors';
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
  /** A retry with the same id returns the same attempt while it holds the task, LeaseLost after; never a second task. */
  requestId?: string;
};

/** The longest lease a claim may ask for; a worker renews with heartbeats instead. */
export const MAX_LEASE_MS = 30 * 24 * 3_600_000;

/** TASK_COLUMNS qualified by the alias t, for joins. */
const TASK_COLUMNS_T = `t.project_id, t.id, t.key, t.plan_id, t.parent_id, t.kind, t.category, t.title, t.description,
  t.priority, t.state, t.origin, t.spec, t.tags, t.boosted, t.hold_until, t.next_child, t.lease_attempt_id, t.lease_expires_at,
  t.created_at, t.updated_at, t.closed_at`;

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
    checkLeaseMs(opts.leaseMs);
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
        payload: { worker: opts.worker, leaseMs: opts.leaseMs }, requestId: opts.requestId,
      });
      return { task, attemptId: task.leaseAttemptId!, expiresAt: task.leaseExpiresAt! };
    });
  };
}

function checkLeaseMs(leaseMs: number): void {
  if (!(Number.isInteger(leaseMs) && leaseMs > 0 && leaseMs <= MAX_LEASE_MS)) {
    throw new InvalidRequest(`leaseMs must be a whole number of milliseconds from 1 to ${MAX_LEASE_MS} (30 days), not ${leaseMs}`);
  }
}

/** The leased calls (engine spec, "Fencing"): each carries the claim's attempt id, and throws LeaseLost once it no longer holds the task. */
export function leasedApi(as: ActorHandle) {
  const { client } = as.project;
  const projectId = as.project.id;
  const { lifecycle } = client;
  /** Work calls follow their move: heartbeat and resume take the onClaim move's roles. */
  const mayWork = (call: string) => {
    if (!moveNamed(lifecycle, lifecycle.hooks.onClaim).by.includes(as.actor.role)) {
      throw new NotPermitted(call, as.actor.role);
    }
  };

  return {
    /**
     * Pushes the lease out to leaseMs from now. A lapsed lease the sweep
     * hasn't returned still belongs to its holder, so this renews it. Writes
     * no event: heartbeats would swamp the history.
     */
    async heartbeat(claim: Claim, opts: { leaseMs: number }): Promise<Claim> {
      checkLeaseMs(opts?.leaseMs);
      mayWork('heartbeat');
      return client.transaction(async ({ db }) => {
        await as.assertVersion(db);
        const r = await sql<TaskRow>`
          update taskgraph.tasks
             set lease_expires_at = taskgraph.now() + make_interval(secs => ${opts.leaseMs / 1000})
           where project_id = ${projectId} and id = ${claim.task.id} and lease_attempt_id = ${claim.attemptId}
          returning ${TASK_COLUMNS}`.execute(db);
        if (!r.rows[0]) throw new LeaseLost(claim.task.id, claim.attemptId);
        const task = toTask(r.rows[0]);
        return { task, attemptId: claim.attemptId, expiresAt: task.leaseExpiresAt! };
      });
    },

    /** Makes a move on the claimed task while this claim still holds it; throws LeaseLost or MoveRefused. */
    moveClaimed(claim: Claim, moveName: string, opts: MoveOptions = {}): Promise<Task> {
      return as.moveFenced(claim.task.id, moveName, opts, claim.attemptId);
    },

    claims: {
      /**
       * The live claim on a task, for the actor holding it, such as a person
       * whose CLI process ended; throws LeaseHeld, naming the holder, to anyone
       * else, and NotFound when no one holds it.
       */
      async resume(taskId: string): Promise<Claim> {
        mayWork('claims.resume');
        await client.need('0001_core');
        // One statement, so the attempt read is the one holding the lease now.
        const r = await sql<TaskRow & { holder: string | null }>`
          select ${sql.raw(TASK_COLUMNS_T)}, a.actor as holder
            from taskgraph.tasks t
            left join taskgraph.attempts a on a.project_id = t.project_id and a.id = t.lease_attempt_id
           where t.project_id = ${projectId} and t.id = ${taskId}`.execute(client.db);
        const row = r.rows[0];
        if (!row) throw new NotFound('task', taskId);
        const task = toTask(row);
        if (!task.leaseAttemptId) throw new NotFound('claim', taskId);
        if (row.holder !== as.actor.id) throw new LeaseHeld(taskId, row.holder ?? 'an unknown actor');
        return { task, attemptId: task.leaseAttemptId, expiresAt: task.leaseExpiresAt! };
      },
    },
  };
}
