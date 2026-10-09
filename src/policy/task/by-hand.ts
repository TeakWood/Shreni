import { hostname } from 'os';
import { sql } from 'kysely';
import { InvalidRequest, LeaseHeld, MoveRefused, NotFound, type ActorHandle, type Claim, type ProjectHandle } from '../../taskgraph';
import type { ShreniClient } from '../db/client';
import { taskLifecycle } from '../lifecycle/lifecycle';

// Working by hand (policy spec, "Tracker-only projects"): a person, or a
// Claude Code session acting for them, claims one task by id with the
// developer role, and later calls, in new processes, find that claim again by
// its holder. note, finish and release renew the lease; anyone else gets
// LeaseHeld, naming the holder.

/** A claim by hand lasts 8 hours; each later call renews it. */
export const BY_HAND_LEASE_MS = 8 * 3_600_000;

/** The worker a claim by hand records: cli:<user>@<host>. */
export const byHandWorker = (user: string, host: string = hostname()) => `cli:${user}@${host}`;

/** The states a claim takes a task from, by the lifecycle's claim move. */
const CLAIMABLE = taskLifecycle.moves.find(m => m.name === taskLifecycle.hooks.onClaim)!.from;
const finished = (state: string) => !!taskLifecycle.states[state]?.satisfiesDeps;
const terminal = (state: string) => !!taskLifecycle.states[state]?.terminal;

/**
 * In a Kshetra the worker works its tasks, so a person claims, finishes,
 * releases, cancels or upgrades by hand only from a terminal, and only while
 * the Kshetra is paused; a session never does (the Kshetra block says so too).
 * The paused flag lives on this machine, so a worker holding the Kshetra's
 * lock from anywhere else refuses it outright: its pause can't be seen here.
 */
export function assertHandsOnKshetra(s: {
  call: string; kshetraId: string; interactive: boolean; paused: boolean;
  /** The worker lock's holder (host/pid), or null; and this machine's worker, as host/pid, or null. */
  lockHolder: string | null; localWorker: string | null;
}): void {
  const k = s.kshetraId;
  if (!s.interactive) {
    throw new Error(`${k} is a Kshetra: its worker works its tasks, and shreni task ${s.call} there needs an interactive terminal`);
  }
  if (s.lockHolder !== null && s.lockHolder !== s.localWorker) {
    throw new Error(`a worker on ${s.lockHolder || 'another machine'} runs ${k}; stop or pause it there first`);
  }
  if (!s.paused) {
    throw new Error(`${k} isn't paused; pause it first (shreni pause --kshetra ${k}), so its worker leaves the work to you`);
  }
}

/** Claims the one task `id` for the developer, or says why it can't be claimed. */
export async function claimByHand(tg: ProjectHandle, me: ActorHandle, id: string, opts: { worker: string; leaseMs?: number }): Promise<Claim> {
  const claim = await me.claim({ worker: opts.worker, leaseMs: opts.leaseMs ?? BY_HAND_LEASE_MS, filter: { ids: [id] } });
  if (claim) return claim;
  const t = await tg.tasks.get(id);
  if (t.claim?.actor === me.actor.id) throw new InvalidRequest(`you already hold ${id}, until ${new Date(t.claim.expiresAt).toISOString()}`);
  if (t.claim) throw new LeaseHeld(id, t.claim.actor);
  if (t.kind === 'container') throw new InvalidRequest(`${id} is an epic: it isn't claimed, and is finished once its tasks are done`);
  if (!CLAIMABLE.includes(t.state)) throw new InvalidRequest(`${id} is ${t.state}, not ${CLAIMABLE.join(' or ')}`);
  const waiting = t.deps.filter(d => !finished(d.state));
  if (waiting.length) throw new InvalidRequest(`${id} waits on ${waiting.map(d => `${d.id} (${d.state})`).join(', ')}`);
  if (t.holdUntil && new Date(t.holdUntil) > new Date()) throw new InvalidRequest(`${id} is held until ${new Date(t.holdUntil).toISOString()}`);
  // A container above it that is held, or waits on unfinished work, holds it too.
  for (let p = t.parentId; p;) {
    const c = await tg.tasks.get(p);
    if (!CLAIMABLE.includes(c.state)) throw new InvalidRequest(`${id} is under ${c.id}, which is ${c.state}`);
    const w = c.deps.filter(d => !finished(d.state));
    if (w.length) throw new InvalidRequest(`${id} is under ${c.id}, which waits on ${w.map(d => `${d.id} (${d.state})`).join(', ')}`);
    p = c.parentId;
  }
  throw new InvalidRequest(`${id} isn't ready: a worker may have claimed it first`);
}

/**
 * The developer's live claim on `id`, renewed; null when no one holds it.
 * Throws LeaseHeld, naming the holder, when someone else does.
 */
export async function heldClaim(me: ActorHandle, id: string, leaseMs: number = BY_HAND_LEASE_MS): Promise<Claim | null> {
  let claim: Claim;
  try {
    claim = await me.claims.resume(id);
  } catch (err) {
    if (err instanceof NotFound && err.entity === 'claim') return null;
    throw err;
  }
  return me.heartbeat(claim, { leaseMs });
}

/** A note, through the developer's claim when they hold one, renewing it; refused while someone else holds the task. */
export async function noteByHand(me: ActorHandle, id: string, text: string): Promise<void> {
  await heldClaim(me, id);
  await me.notes.add(id, text);
}

/** The task's acceptance checks, oldest first. */
export async function checksOf(shreni: ShreniClient, projectId: string, taskId: string) {
  return shreni.db.selectFrom('shreni.acceptance_checks').select(['given', 'when', 'then', 'mode'])
    .where('project_id', '=', projectId).where('task_id', '=', taskId).orderBy('created_at').orderBy('id').execute();
}

export class ChecksUnconfirmed extends Error {
  constructor(readonly taskId: string, readonly checks: { given: string; when: string; then: string }[]) {
    super(`${taskId} has acceptance checks; confirm that each holds with --checks-passed:\n` +
      checks.map(c => `  - Given ${c.given}, when ${c.when}, then ${c.then}`).join('\n'));
    this.name = 'ChecksUnconfirmed';
  }
}

/**
 * Finishes the developer's claimed task, or completes an epic whose tasks
 * have settled. No test gate runs by hand, so a task's acceptance checks pass
 * on the developer's confirmation, recorded on the attempt for checksPassed.
 */
export async function finishByHand(
  shreni: ShreniClient, tg: ProjectHandle, me: ActorHandle, id: string,
  opts: { reason: string; checksPassed?: boolean },
): Promise<void> {
  const task = await tg.tasks.get(id);
  if (task.kind === 'container') {
    await me.move(id, 'completeContainer', { reason: opts.reason });
    return;
  }
  const claim = await heldClaim(me, id);
  if (!claim) {
    throw new InvalidRequest(task.state === 'waiting'
      ? `${id} is waiting on its PR; it finishes when the PR merges`
      : `${id} isn't claimed; claim it first (shreni task claim ${id})`);
  }
  const checks = await checksOf(shreni, tg.id, id);
  if (checks.length) {
    if (!opts.checksPassed) throw new ChecksUnconfirmed(id, checks);
    const acceptance = { passed: true, confirmedBy: me.actor.id, checks: checks.length };
    await shreni.transaction(db => sql`
      insert into shreni.attempt_evidence (attempt_id, gates)
      values (${claim.attemptId}, cast(cast(${JSON.stringify({ acceptance })} as text) as jsonb))
      on conflict (attempt_id) do update set gates = shreni.attempt_evidence.gates || excluded.gates`.execute(db));
  }
  await me.moveClaimed(claim, 'finish', { reason: opts.reason });
}

/**
 * Finishes a landed task that was flagged because a manual acceptance check
 * waits on the developer: records their confirmation on its newest attempt,
 * which checksPassed reads, and fires confirm (blocked to done).
 */
export async function confirmable(shreni: ShreniClient, tg: ProjectHandle, id: string) {
  const task = await tg.tasks.get(id);
  if (task.state !== 'blocked') throw new InvalidRequest(`${id} is ${task.state}; confirm finishes a task flagged for its manual checks`);
  const checks = await checksOf(shreni, tg.id, id);
  if (!checks.some(c => c.mode === 'manual')) {
    throw new InvalidRequest(`${id} has no manual check to confirm; it was flagged for something else (shreni task show ${id})`);
  }
  const attempt = await sql<{ id: string; landed: boolean }>`
    select a.id, coalesce(e.gates -> 'landed' = 'true'::jsonb, false) as landed
      from taskgraph.attempts a left join shreni.attempt_evidence e on e.attempt_id = a.id
     where a.project_id = ${tg.id} and a.task_id = ${id}
     order by a.started_at desc, a.id desc limit 1`.execute(shreni.db);
  if (!attempt.rows[0]?.landed) throw new InvalidRequest(`${id}'s work never landed on main, so there is nothing to confirm (shreni task show ${id})`);
  return { checks, attemptId: attempt.rows[0].id };
}

export async function confirmByHand(
  shreni: ShreniClient, tg: ProjectHandle, me: ActorHandle, id: string, opts: { reason: string },
): Promise<void> {
  const { checks, attemptId } = await confirmable(shreni, tg, id);
  const acceptance = { passed: true, confirmedBy: me.actor.id, checks: checks.length };
  await shreni.transaction(db => sql`
    insert into shreni.attempt_evidence (attempt_id, gates)
    values (${attemptId}, cast(cast(${JSON.stringify({ acceptance })} as text) as jsonb))
    on conflict (attempt_id) do update set gates = shreni.attempt_evidence.gates || excluded.gates`.execute(db));
  await me.move(id, 'confirm', { reason: opts.reason });
}

/** Gives the task back: the developer's own claim, or with `force` anyone's, the event naming who took it. */
export async function releaseByHand(me: ActorHandle, id: string, opts: { force?: boolean; reason?: string } = {}): Promise<void> {
  try {
    const claim = await heldClaim(me, id);
    if (!claim) throw new InvalidRequest(`${id} isn't claimed`);
    await me.moveClaimed(claim, 'release', { reason: opts.reason ?? 'released by hand' });
  } catch (err) {
    if (!(err instanceof LeaseHeld) || !opts.force) throw err;
    // Fenced on the attempt read here, so a claim taken since is never released in its place.
    const held = (await me.project.tasks.get(id)).claim;
    if (!held || held.actor !== err.holder) throw new InvalidRequest(`${id} changed hands meanwhile; look again (shreni task show ${id})`);
    await me.moveFenced(id, 'release', {
      reason: opts.reason ?? `taken back from ${held.actor} with --force`, payload: { forcedFrom: held.actor },
    }, held.attemptId);
  }
}

/**
 * Cancels a task. With `withChildren`, its live descendants first, each
 * before what it waits on; `dropDeps` removes the edges of live tasks outside
 * that set which wait on a cancelled one. Returns the ids cancelled, in order.
 */
export async function cancelByHand(
  shreni: ShreniClient, tg: ProjectHandle, me: ActorHandle, id: string,
  opts: { withChildren?: boolean; dropDeps?: boolean; reason: string },
): Promise<string[]> {
  const root = await tg.tasks.get(id);
  if (terminal(root.state)) throw new InvalidRequest(`${id} is already ${root.state}`);
  const below = opts.withChildren ? (await tg.tasks.subtree(id)).filter(t => t.id !== id && !terminal(t.state)) : [];
  // Deepest first, so each container's children are cancelled before it.
  const depth = new Map<string, number>([[id, 0]]);
  const parentOf = new Map(below.map(t => [t.id, t.parentId]));
  const depthOf = (t: string): number => depth.get(t) ?? (depth.set(t, 1 + depthOf(parentOf.get(t)!)), depth.get(t)!);
  let pending = [...below.map(t => t.id).sort((a, b) => depthOf(b) - depthOf(a)), id];
  const inSet = new Set(pending);
  // Checked before anything is cancelled, so a refusal leaves the set as it was.
  if (!opts.dropDeps) {
    const outside = await sql<{ task_id: string; depends_on_id: string }>`
      select d.task_id, d.depends_on_id from taskgraph.task_deps d
        join taskgraph.tasks t on t.project_id = d.project_id and t.id = d.task_id
       where d.project_id = ${tg.id} and d.depends_on_id = any(${sql.val([...inSet])}::text[])
         and not (d.task_id = any(${sql.val([...inSet])}::text[]))
         and not (t.state = any(${sql.val(Object.keys(taskLifecycle.states).filter(terminal))}::text[]))`.execute(shreni.db);
    if (outside.rows.length) {
      const by = outside.rows.map(r => `${r.task_id} on ${r.depends_on_id}`).join(', ');
      throw new InvalidRequest(`live tasks wait on what would be cancelled (${by}); remove those dependencies with --drop-deps`);
    }
  }
  const done: string[] = [];
  try {
    await cancelInPasses();
  } catch (err) {
    // One move per task, so a failure part way says what is already cancelled.
    if (!done.length) throw err;
    throw new Error(`${(err as Error).message} (already cancelled: ${done.join(', ')})`);
  }
  return done;

  async function cancelInPasses() {
    // Passes, since a task one of the set waits on is cancelled after its dependents.
    for (let progressed = true; pending.length && progressed;) {
      progressed = false;
      const left: string[] = [];
      let last: unknown;
      for (const t of pending) {
        try {
          await me.move(t, 'cancel', { reason: opts.reason, ...(opts.dropDeps ? { dropDeps: true } : {}) });
          done.push(t);
          progressed = true;
        } catch (err) {
          const inside = err instanceof MoveRefused
            && ((err.reason === 'DependentsLive' && err.waiting.every(w => inSet.has(w)))
              || (err.reason === 'ChildrenLive' && err.children.every(c => inSet.has(c))));
          if (!inside) throw refusal(err, t, opts);
          left.push(t);
          last = err;
        }
      }
      pending = left;
      if (pending.length && !progressed) throw refusal(last, pending[0], opts);
    }
  }
}

/** A cancel refusal, with the flag that gets past it. */
function refusal(err: unknown, id: string, opts: { withChildren?: boolean; dropDeps?: boolean }): unknown {
  if (!(err instanceof MoveRefused)) return err;
  if (err.reason === 'ChildrenLive' && !opts.withChildren) {
    return new InvalidRequest(`${id} has live tasks under it (${err.children.join(', ')}); cancel them too with --with-children`);
  }
  if (err.reason === 'DependentsLive' && !opts.dropDeps) {
    return new InvalidRequest(`live tasks wait on ${id} (${err.waiting.join(', ')}); remove those dependencies with --drop-deps`);
  }
  return err;
}
