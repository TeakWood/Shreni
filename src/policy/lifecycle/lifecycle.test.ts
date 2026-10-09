import { describe, it, expect, onTestFinished } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { taskLifecycle } from './lifecycle';
import { GUARD_SOURCES, checksConfirmed, checksPassed, childrenSettled, hasOpenPr } from './guards';
import { guardSnapshotProblems, hashGuardSources, normalizeSource, type GuardSnapshot } from './guard-snapshot';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { MoveRefused } from '../../taskgraph';
import type { GuardFn } from '../../taskgraph';

// Shreni's lifecycle and guards (policy spec, "The lifecycle").

const SNAPSHOT = join(__dirname, 'guards.snapshot.json');

describe('the guard source snapshot', () => {
  it('matches the lifecycle version: a guard changed without a bump fails here', () => {
    const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as GuardSnapshot;
    if (process.env.SHRENI_RECORD_GUARDS) {
      // Recording never excuses a changed guard under the same version.
      if (recorded.version === taskLifecycle.version) {
        expect(guardSnapshotProblems(taskLifecycle.version, GUARD_SOURCES, recorded)).toEqual([]);
      }
      writeFileSync(SNAPSHOT, `${JSON.stringify({ version: taskLifecycle.version, guards: hashGuardSources(GUARD_SOURCES) }, null, 2)}\n`);
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as GuardSnapshot;
    expect(guardSnapshotProblems(taskLifecycle.version, GUARD_SOURCES, snapshot)).toEqual([]);
  });

  it('covers exactly the guards the lifecycle uses, as the lifecycle uses them', () => {
    const used = [...new Set(taskLifecycle.moves.filter(m => m.guard).map(m => m.guard!.guardName))].sort();
    expect(used).toEqual(Object.keys(GUARD_SOURCES).sort());
    const exported = { hasOpenPr, checksPassed, checksConfirmed, childrenSettled };
    for (const m of taskLifecycle.moves) if (m.guard) expect(m.guard).toBe(exported[m.guard.guardName as keyof typeof exported]);
  });

  it('ignores comments, whitespace and bundler import names', () => {
    expect(normalizeSource('async () => {\n  // why\n  return __vite_ssr_import_3__.sql`a   b`; /* x */\n}'))
      .toBe(normalizeSource('async () => { return sql`a b`; }'));
  });

  it('reports a guard whose source changed under the same version', () => {
    const snapshot = { version: 1, guards: hashGuardSources(GUARD_SOURCES) };
    const stricter: GuardFn = async () => 'nothing may finish';
    const problems = guardSnapshotProblems(1, { ...GUARD_SOURCES, checksPassed: stricter }, snapshot);
    expect(problems).toEqual([expect.stringMatching(/checksPassed's source changed under version 1: bump/)]);
    expect(guardSnapshotProblems(2, GUARD_SOURCES, snapshot)).toEqual([expect.stringMatching(/record it/)]);
  });
});

describe('taskLifecycle', () => {
  it('has the spec\'s eight states and fourteen moves, and registers', () => {
    expect(Object.keys(taskLifecycle.states)).toHaveLength(8);
    expect(taskLifecycle.moves).toHaveLength(14);
    expect(taskLifecycle.name).toBe('shreni.task');
  });
});

async function engine() {
  const t = await createTestDb();
  const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'a', role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  return { t, shreni, p, tg, as: (role: string) => tg.as({ id: role, role }) };
}

describe('the guards', { timeout: PGLITE_TIMEOUT }, () => {
  it('hasOpenPr: submit needs the attempt\'s PR in its evidence', async () => {
    const { shreni, as } = await engine();
    await as('system').tasks.create({ title: 't' });
    const c = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    await expect(as('orchestrator').moveClaimed(c, 'submit')).rejects.toMatchObject({ reason: 'the attempt has no open PR recorded' });
    await shreni.transaction(db => db.insertInto('shreni.attempt_evidence').values({ attempt_id: c.attemptId, pr_url: 'https://github.com/x/y/pull/1' }).execute());
    expect(await as('orchestrator').moveClaimed(c, 'submit')).toMatchObject({ state: 'waiting' });
  });

  it('checksPassed: an imported task with no checks finishes; a task with checks needs them passed', async () => {
    const { shreni, tg, p, as } = await engine();
    // an imported task, through the engine's import
    const bundle = await shreni.tg.projects.export(p.id);
    await shreni.tg.projects.purge(p.id, { actor: { id: 'a', role: 'developer' }, confirmName: 'web' });
    const at = new Date();
    await shreni.tg.projects.import({ ...bundle, tasks: [{
      id: 'web-imp', key: null, planId: null, parentId: null, kind: 'work', category: null, title: 'from beads', description: null,
      priority: 2, state: 'open', origin: 'imported', spec: {}, tags: [], boosted: false, holdUntil: null, nextChild: 1,
      leaseAttemptId: null, leaseExpiresAt: null, createdAt: at, updatedAt: at, closedAt: null,
    }] }, { actor: { id: 'a', role: 'developer' } });
    const c = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    expect(await as('orchestrator').moveClaimed(c, 'finish')).toMatchObject({ state: 'done' });

    const t = await as('system').tasks.create({ title: 'checked' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute());
    const c2 = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    await shreni.transaction(db => db.insertInto('shreni.attempt_evidence').values({ attempt_id: c2.attemptId }).execute());
    await expect(as('orchestrator').moveClaimed(c2, 'finish')).rejects.toBeInstanceOf(MoveRefused);
    await shreni.transaction(db => db.updateTable('shreni.attempt_evidence')
      .set({ gates: { acceptance: { passed: true } } }).where('attempt_id', '=', c2.attemptId).execute());
    expect(await as('orchestrator').moveClaimed(c2, 'finish')).toMatchObject({ state: 'done' });
  });

  it('childrenSettled: a container with every child terminal and one done; never a work task or an all-cancelled one', async () => {
    const { as } = await engine();
    const work = await as('system').tasks.create({ title: 'work' });
    await expect(as('developer').move(work.id, 'completeContainer')).rejects.toMatchObject({ reason: expect.stringMatching(/only a container/) });

    const epic = await as('system').tasks.create({ title: 'epic', kind: 'container' });
    const a = await as('system').tasks.create({ title: 'a', parent: epic.id });
    await as('developer').move(a.id, 'cancel');
    await expect(as('developer').move(epic.id, 'completeContainer')).rejects.toMatchObject({ reason: expect.stringMatching(/no child is done/) });

    await as('system').tasks.create({ title: 'b', parent: epic.id, priority: 0 });
    const c = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000, filter: { within: epic.id } }))!;
    await as('orchestrator').moveClaimed(c, 'finish');
    expect(await as('orchestrator').move(epic.id, 'completeContainer')).toMatchObject({ state: 'done' });
  });
});

describe('checksPassed reads the current attempt', { timeout: PGLITE_TIMEOUT }, () => {
  it('a newer attempt without evidence has not passed, even after an older one did', async () => {
    const { shreni, tg, as } = await engine();
    const t = await as('system').tasks.create({ title: 't' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute());
    const c1 = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    await shreni.transaction(db => db.insertInto('shreni.attempt_evidence')
      .values({ attempt_id: c1.attemptId, pr_url: 'https://x/pr/1', gates: { acceptance: { passed: true } } }).execute());
    await as('orchestrator').moveClaimed(c1, 'submit');
    await as('orchestrator').move(t.id, 'followUp');
    const c2 = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    await expect(as('orchestrator').moveClaimed(c2, 'finish')).rejects.toBeInstanceOf(MoveRefused);
    // a gate value that isn't a boolean refuses, rather than failing in SQL
    await shreni.transaction(db => db.insertInto('shreni.attempt_evidence')
      .values({ attempt_id: c2.attemptId, gates: { acceptance: { passed: 'PASS' } } }).execute());
    await expect(as('orchestrator').moveClaimed(c2, 'finish')).rejects.toBeInstanceOf(MoveRefused);
  });

  it('a finish from waiting reads the newest attempt, whose lease has ended', async () => {
    const { shreni, tg, as } = await engine();
    const t = await as('system').tasks.create({ title: 't' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks')
      .values({ project_id: tg.id, task_id: t.id, given: 'g', when: 'w', then: 't', mode: 'auto' }).execute());
    const c = (await as('orchestrator').claim({ worker: 'w', leaseMs: 60_000 }))!;
    await shreni.transaction(db => db.insertInto('shreni.attempt_evidence')
      .values({ attempt_id: c.attemptId, pr_url: 'https://x/pr/1', gates: { acceptance: { passed: true } } }).execute());
    await as('orchestrator').moveClaimed(c, 'submit');
    expect(await as('orchestrator').move(t.id, 'finish')).toMatchObject({ state: 'done' });
  });
});
