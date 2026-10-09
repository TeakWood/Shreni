import { describe, it, expect } from 'vitest';
import { openEngine, type TestEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { defineGuard } from './lifecycle';
import { InvalidRequest, MoveRefused, NotFound } from './errors';

/** Puts a task in the leased state with a live attempt, as a claim would. */
async function lease(e: TestEngine, taskId: string): Promise<string> {
  const [{ id }] = await e.rows(`select gen_random_uuid()::text as id`);
  await e.t.pglite.query(`insert into taskgraph.attempts (id, project_id, task_id, worker, actor) values ($1, $2, $3, 'w1', 'orchestrator')`,
    [id, e.tg.id, taskId]);
  await e.t.pglite.query(`update taskgraph.tasks set state = 'claimed', lease_attempt_id = $1, lease_expires_at = now() + interval '1 minute'
    where project_id = $2 and id = $3`, [id, e.tg.id, taskId]);
  return id;
}

describe('move', { timeout: 30_000 }, () => {
  it('makes a declared move and writes move:<name> with the states, actor and reason', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    const moved = await e.as('developer').move(t.id, 'approve', { reason: 'looks right', payload: { via: 'cli' }, requestId: 'r1' });
    expect(moved).toMatchObject({ id: t.id, state: 'open' });
    expect(await e.rows(`select kind, from_state, to_state, actor_role, payload, request_id from taskgraph.events where kind like 'move:%'`))
      .toEqual([{ kind: 'move:approve', from_state: 'proposed', to_state: 'open', actor_role: 'developer', payload: { reason: 'looks right', via: 'cli' }, request_id: 'r1' }]);
  });

  it('refuses a role not in the move\'s by, with NotPermitted', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    const err = await e.as('planner').move(t.id, 'approve').catch(x => x);
    expect(err).toBeInstanceOf(MoveRefused);
    expect(err).toMatchObject({ reason: 'NotPermitted', state: 'proposed' });
  });

  it('refuses a move that can\'t start from the task\'s state', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await expect(e.as('developer').move(t.id, 'unpark')).rejects.toMatchObject({ code: 'MoveRefused', reason: 'WrongState', state: 'proposed' });
  });

  it('keeps the reason over a payload key of the same name', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await e.as('developer').move(t.id, 'approve', { reason: 'mine', payload: { reason: 'theirs' } });
    expect(await e.rows(`select payload->>'reason' as r from taskgraph.events where kind = 'move:approve'`)).toEqual([{ r: 'mine' }]);
  });

  it('runs the guard after locking the row, and refuses with its reason', async () => {
    const l = testLifecycle();
    const seen: string[] = [];
    l.moves.find(m => m.name === 'park')!.guard = defineGuard('notOnFridays', async ({ task, actor }) => {
      seen.push(`${task.id}:${task.state}:${actor.id}`);
      return 'not on Fridays';
    });
    const e = await openEngine(l);
    const t = await e.as('planner').tasks.create({ title: 't' });
    await expect(e.as('developer').move(t.id, 'park')).rejects.toMatchObject({ reason: 'not on Fridays' });
    expect(seen).toEqual([`${t.id}:proposed:developer`]);
    expect((await e.rows(`select state from taskgraph.tasks`))[0].state).toBe('proposed');
  });

  it('sets the boost on a boost move, keeps it through others, and clears it on a clearsBoost move', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    await lease(e, t.id);
    await e.as('orchestrator').move(t.id, 'submit');
    expect(await e.as('orchestrator').move(t.id, 'followUp')).toMatchObject({ state: 'open', boosted: true });
    expect(await e.as('orchestrator').move(t.id, 'flag')).toMatchObject({ state: 'blocked', boosted: true });
    expect(await e.as('developer').move(t.id, 'unblock')).toMatchObject({ boosted: true });
    expect(await e.as('developer').move(t.id, 'cancel')).toMatchObject({ state: 'cancelled', boosted: false });
  });

  it('sets closed_at on entering a terminal state', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    expect((await e.as('developer').move(t.id, 'approve')).closedAt).toBeNull();
    const done = await e.as('developer').move(t.id, 'cancel');
    expect(done.closedAt).toBeInstanceOf(Date);
  });

  it('ends the attempt and clears the lease on any move out of the leased state', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    const attempt = await lease(e, t.id);
    const released = await e.as('developer').move(t.id, 'release');
    expect(released).toMatchObject({ state: 'open', leaseAttemptId: null, leaseExpiresAt: null });
    const [a] = await e.rows(`select outcome, ended_at is not null as ended from taskgraph.attempts where id = $1`, [attempt]);
    expect(a).toEqual({ outcome: 'release', ended: true });
    expect(await e.rows(`select attempt_id from taskgraph.events where kind = 'move:release'`)).toEqual([{ attempt_id: attempt }]);
  });

  it('leaves the claim to claim(): the onClaim move can\'t be made with move()', async () => {
    const e = await openEngine();
    const t = await e.as('system').tasks.create({ title: 't' });
    await expect(e.as('orchestrator').move(t.id, 'claim')).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('refuses an unknown move, and an unknown task', async () => {
    const e = await openEngine();
    const t = await e.as('planner').tasks.create({ title: 't' });
    await expect(e.as('developer').move(t.id, 'teleport')).rejects.toBeInstanceOf(InvalidRequest);
    await expect(e.as('developer').move('web-nope', 'approve')).rejects.toBeInstanceOf(NotFound);
  });
});
