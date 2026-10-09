import { execFileSync } from 'child_process';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { sql } from 'kysely';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import { makeContext } from './registry';
import { ensureLifecycleCurrent, findProjectConfig, lifecycleGap, parseCheck, runTask, type TaskDeps } from './task';
import { defineLifecycle } from '../taskgraph';
import type { KshetraConfig } from '../kshetra/config';
import { takeWorkerLock } from '../policy/sthapathi/leases';
import { VersionMismatch } from '../taskgraph';

// shreni task: ready, show, list, create --check, note, remember (policy spec,
// "Working by hand" and "Project config"): each run finds its project from the
// repo's tracker.yaml or kshetra.yaml, sweeps expired leases, then acts as the
// developer.

const ME = 'dev@example.com';

async function setup(kind: 'tracker' | 'kshetra' = 'tracker') {
  const t = await createTestDb();
  const shreni: ShreniClient = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: ME, role: 'developer' } });
  const repo = mkdtempSync(join(tmpdir(), 'shreni-task-repo-'));
  mkdirSync(join(repo, '.shreni'));
  writeFileSync(join(repo, '.shreni', `${kind}.yaml`), kind === 'tracker'
    ? `name: web\nproject: ${p.id}\n`
    : `id: web\nname: web\nproject: ${p.id}\nrepo: { path: ${repo}, remote: 'git@x:y.git' }\nbeads: { path: ${repo}, remote: 'git@x:z.git' }\nstack: { language: ts }\n`);
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  const out: string[] = [];
  const deps: TaskDeps = {
    cwd: join(repo, 'src', 'deep'),
    open: async () => ({ shreni, close: async () => {} }),
    user: () => ME,
    print: line => out.push(line),
    interactive: () => false,
    ask: async () => '',
    kshetra: () => ({ paused: false, localWorker: null }),
  };
  const run = async (...args: string[]) => {
    out.length = 0;
    await runTask(makeContext(args), deps);
    return out.join('\n');
  };
  return { t, shreni, tg: shreni.tg.project(p.id), p, repo, run, deps };
}

describe('shreni task', { timeout: PGLITE_TIMEOUT }, () => {
  it('create with a title and one --check files the task proposed with that check, absent from ready', async () => {
    const { shreni, tg, p, run } = await setup();
    // Another task that is ready, so "absent from ready" is shown against a non-empty ready set.
    const other = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'already open' });
    const id = (await run('create', '--title', 'Sign in', '--check', 'given a user when they sign in then they see the home page', '--json'))
      .trim();
    const created = JSON.parse(id);
    const task = await tg.tasks.get(created.id);
    expect(task).toMatchObject({ title: 'Sign in', state: 'proposed', origin: 'manual' });
    const checks = await shreni.db.selectFrom('shreni.acceptance_checks').selectAll()
      .where('project_id', '=', p.id).where('task_id', '=', task.id).execute();
    expect(checks).toEqual([expect.objectContaining({ given: 'a user', when: 'they sign in', then: 'they see the home page', mode: 'auto' })]);
    expect(JSON.parse(await run('ready', '--json')).map((t: { id: string }) => t.id)).toEqual([other.id]);
    expect(await run('ready')).not.toContain(task.id);
  });

  it('refuses a malformed --check before filing anything', async () => {
    const { tg, run } = await setup();
    await expect(run('create', '--title', 'x', '--check', 'it works')).rejects.toThrow(/given … when … then/);
    expect(await tg.tasks.list({})).toEqual([]);
  });

  it('files every repeated --check, in order', async () => {
    const { shreni, run } = await setup();
    await run('create', '--title', 'x', '--check', 'Given a, when b, then c.', '--check', 'given d when e then f');
    const checks = await shreni.db.selectFrom('shreni.acceptance_checks').select(['given', 'when', 'then', 'created_at']).orderBy('created_at').execute();
    expect(checks.map(({ created_at: _, ...c }) => c)).toEqual([{ given: 'a', when: 'b', then: 'c' }, { given: 'd', when: 'e', then: 'f' }]);
    // Distinct times, so the order doesn't rest on a tie.
    const [{ n }] = (await shreni.db.selectFrom('shreni.acceptance_checks').select(sql<number>`count(distinct created_at)::int`.as('n')).execute());
    expect(n).toBe(2);
    const shown = await run('show', (await shreni.db.selectFrom('shreni.acceptance_checks').select('task_id').executeTakeFirstOrThrow()).task_id!);
    expect(shown.indexOf('Given a')).toBeLessThan(shown.indexOf('Given d'));
  });

  it('refuses flags it doesn\'t take, the = form, a missing value and stray words', async () => {
    const { tg, run } = await setup();
    await expect(run('create', '--title', '--check', 'given a when b then c')).rejects.toThrow(/--title needs a value/);
    await expect(run('create', '--title', 'x', '--check=given a when b then c')).rejects.toThrow(/not --check=/);
    await expect(run('create', '--title', 'x', '--colour', 'red')).rejects.toThrow(/takes no --colour/);
    await expect(run('create', '--title', 'Fix', 'login')).rejects.toThrow(/unexpected "login"/);
    await expect(run('create', '--title', 'x', '--priority', '7')).rejects.toThrow(/0 to 4/);
    await expect(run('create', '--title', 'x', '--epic', '--check', 'given a when b then c')).rejects.toThrow(/epic takes no --check/);
    await expect(run('list', '--state', 'opne')).rejects.toThrow(/no state "opne"/);
    await expect(run('list', '--state', 'open', '--all')).rejects.toThrow(/not both/);
    expect(await tg.tasks.list({})).toEqual([]);
  });

  it('files an epic, and a task under it with a priority', async () => {
    const { tg, run } = await setup();
    const epic = JSON.parse(await run('create', '--title', 'Accounts', '--epic', '--json'));
    expect(await run('create', '--title', 'Sign in', '--parent', epic.id, '--priority', '1')).toMatch(/filed .* \(proposed\): Sign in/);
    expect(await tg.tasks.list({ parent: epic.id })).toEqual([expect.objectContaining({ title: 'Sign in', priority: 1 })]);
    expect(epic.kind).toBe('container');
  });

  it('removes the task when its checks fail to land, and names it when that fails too', async () => {
    const { t, tg, shreni, run } = await setup();
    await t.pglite.query(`update shreni.schema_meta set min_writer = 99`);
    await expect(run('create', '--title', 'x', '--check', 'given a when b then c')).rejects.toThrow(/older than|min_writer|writer/);
    expect(await tg.tasks.list({})).toEqual([]);

    // When the delete fails as well, the error names the task left behind.
    const project = shreni.tg.project.bind(shreni.tg);
    shreni.tg.project = (id: string) => {
      const h = project(id);
      const as = h.as.bind(h);
      h.as = actor => {
        const me = as(actor);
        (me.tasks as { delete: unknown }).delete = async () => { throw new Error('connection lost'); };
        return me;
      };
      return h;
    };
    onTestFinished(() => { shreni.tg.project = project; });
    await expect(run('create', '--title', 'y', '--check', 'given a when b then c'))
      .rejects.toThrow(/filed web-\w+, but its checks failed .* could not be removed \(connection lost\)/);
  });

  it('ready, list and show read the project', async () => {
    const { tg, run } = await setup();
    const dev = tg.as({ id: ME, role: 'developer' });
    const epic = await dev.tasks.create({ title: 'Accounts', kind: 'container' });
    const a = await dev.tasks.create({ title: 'Sign in', parent: epic.id, priority: 1, description: 'the form' });
    const b = await dev.tasks.create({ title: 'Sign out', parent: epic.id });
    await dev.deps.add(b.id, a.id);
    for (const id of [epic.id, a.id, b.id]) await dev.move(id, 'approve');
    await dev.notes.add(a.id, 'started on the form');

    expect(await run('ready')).toMatch(new RegExp(`${a.id}\\s+P1\\s+Sign in`));
    expect(await run('ready')).not.toContain(b.id);
    const listed = await run('list');
    expect(listed).toContain(epic.id);
    expect(listed).toContain(b.id);
    expect(JSON.parse(await run('list', '--state', 'proposed', '--json'))).toEqual([]);

    const shown = await run('show', a.id);
    expect(shown).toMatch(/Sign in/);
    expect(shown).toMatch(/open/);
    expect(shown).toMatch(/the form/);
    expect(shown).toMatch(/started on the form/);
    expect(await run('show', b.id)).toMatch(new RegExp(`depends on.*${a.id}`, 's'));
  });

  it('note adds a note as the developer', async () => {
    const { tg, run } = await setup();
    const a = await tg.as({ id: ME, role: 'developer' }).tasks.create({ title: 'a' });
    await run('note', a.id, 'halfway', 'there');
    const notes = (await tg.tasks.history(a.id)).filter(e => e.kind === 'note');
    expect(notes).toEqual([expect.objectContaining({ actor: ME, actorRole: 'developer', payload: { text: 'halfway there' } })]);
  });

  it('remember keeps an insight, and the same key replaces it', async () => {
    const { shreni, run } = await setup();
    await run('remember', 'Tests live under src, beside the code');
    await run('remember', 'naming', '--key', 'style');
    await run('remember', 'kebab-case files', '--key', 'style');
    const rows = await shreni.db.selectFrom('shreni.memories').select(['key', 'content']).orderBy('key').execute();
    expect(rows).toEqual([
      { key: 'style', content: 'kebab-case files' },
      { key: expect.stringMatching(/^tests-live-under-src-beside-the-code-[0-9a-f]{6}$/), content: 'Tests live under src, beside the code' },
    ]);
    expect(await run('remember', 'other', '--key', 'style')).toMatch(/^replaced style/);
    await expect(run('remember', 'x', '--key', ' ')).rejects.toThrow(/--key needs a value/);
    // Insights with no ASCII words, or the same first words, keep apart.
    await run('remember', 'テストは src にある');
    await run('remember', '日本語のコメント');
    expect((await shreni.db.selectFrom('shreni.memories').select('key').where('key', 'like', 'memory-%').execute())).toHaveLength(1);
    expect((await shreni.db.selectFrom('shreni.memories').select('key').where('key', 'like', 'src-%').execute())).toHaveLength(1);
  });

  it('every run sweeps expired leases first', async () => {
    const { t, tg, run } = await setup();
    const a = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'a' });
    await tg.as({ id: 'o', role: 'orchestrator' }).claim({ worker: 'w', leaseMs: 60_000 });
    await t.pglite.query(`update taskgraph.tasks set lease_expires_at = now() - interval '1 minute' where id = $1`, [a.id]);
    expect(await run('ready')).toContain(a.id);
  });

  it('finds the project from a Kshetra\'s kshetra.yaml too', async () => {
    const { run, tg } = await setup('kshetra');
    await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'from the kshetra' });
    expect(await run('list')).toMatch(/from the kshetra/);
  });

  it('refuses outside a Shreni repo, and a repo not yet registered', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'shreni-task-bare-'));
    expect(() => findProjectConfig(bare)).toThrow(/no \.shreni\/tracker\.yaml or \.shreni\/kshetra\.yaml/);
    mkdirSync(join(bare, '.shreni'));
    writeFileSync(join(bare, '.shreni', 'tracker.yaml'), 'name: web\n');
    expect(() => findProjectConfig(bare)).toThrow(/shreni init/);
    writeFileSync(join(bare, '.shreni', 'kshetra.yaml'), 'id: web\n');
    expect(() => findProjectConfig(bare)).toThrow(/both/);
  });

  it('stops looking at the repo\'s own root', async () => {
    const { repo } = await setup();
    const nested = join(repo, 'scratch-clone');
    mkdirSync(join(nested, '.git'), { recursive: true });
    expect(() => findProjectConfig(nested)).toThrow(/no \.shreni\/tracker\.yaml/);
  });

  it('refuses without a developer to act as', async () => {
    const { run, deps } = await setup();
    deps.user = () => undefined;
    await expect(run('list')).rejects.toThrow(/user/);
  });

  it('refuses an unknown subcommand, naming the ones there are', async () => {
    const { run } = await setup();
    await expect(run('frobnicate')).rejects.toThrow(/ready.*show.*list.*create.*note.*remember/);
  });
});

describe('parseCheck', () => {
  it('reads given, when and then, in any case, with or without commas', () => {
    expect(parseCheck('GIVEN x, WHEN y, THEN z.')).toEqual({ given: 'x', when: 'y', then: 'z' });
    expect(parseCheck('given a when b then c')).toEqual({ given: 'a', when: 'b', then: 'c' });
  });
  it('allows a colon after each word, and drops the punctuation around a clause', () => {
    expect(parseCheck('Given: a user; When: they sign in; Then: home')).toEqual({ given: 'a user', when: 'they sign in', then: 'home' });
  });
  it('refuses a check without all three, or with an empty part', () => {
    expect(() => parseCheck('when b then c')).toThrow(/given … when … then/);
    expect(() => parseCheck('given   when x then y')).toThrow(/each part/);
    expect(() => parseCheck('given a when b then .')).toThrow(/each part/);
  });
});

describe('shreni task by hand: claim, finish, release, cancel, approve, upgrade', { timeout: PGLITE_TIMEOUT }, () => {
  /** An approved, ready task. */
  async function ready(tg: Awaited<ReturnType<typeof setup>>['tg'], title = 'a') {
    return tg.as({ id: 's', role: 'system' }).tasks.create({ title });
  }

  it('given developer A\'s claim, when developer B finishes it, then LeaseHeld names A', async () => {
    const { tg, run, deps } = await setup();
    const a = await ready(tg);
    expect(await run('claim', a.id)).toMatch(new RegExp(`claimed ${a.id}`));
    deps.user = () => 'bea@example.com';
    await expect(run('finish', a.id, '--reason', 'done')).rejects.toThrow(new RegExp(`${a.id} is held by ${ME}`));
    await expect(run('note', a.id, 'mine now')).rejects.toThrow(new RegExp(`held by ${ME}`));
    await expect(run('release', a.id)).rejects.toThrow(new RegExp(`held by ${ME}`));
    expect((await tg.tasks.get(a.id)).state).toBe('claimed');
  });

  it('a claim under an epic that waits on unfinished work says which epic, and on what', async () => {
    const { tg, run } = await setup();
    const sys = tg.as({ id: 's', role: 'system' });
    const first = await sys.tasks.create({ title: 'first' });
    const epic = await sys.tasks.create({ title: 'epic', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    await tg.as({ id: ME, role: 'developer' }).deps.add(epic.id, first.id);
    await expect(run('claim', a.id)).rejects.toThrow(new RegExp(`${a.id} is under ${epic.id}, which waits on ${first.id} \\(open\\)`));
  });

  it('given a shell that isn\'t interactive, when approve runs, then it refuses', async () => {
    const { tg, run } = await setup();
    const t = await tg.as({ id: ME, role: 'developer' }).tasks.create({ title: 'lone' });
    await expect(run('approve', t.id)).rejects.toThrow(/interactive terminal/);
    await expect(run('upgrade')).rejects.toThrow(/interactive terminal/);
    expect((await tg.tasks.get(t.id)).state).toBe('proposed');
  });

  it('given a running worker, when someone claims a Kshetra task by hand, then it refuses', async () => {
    const { tg, run, deps } = await setup('kshetra');
    const a = await ready(tg);
    deps.interactive = () => true;
    // The worker on this machine, holding the Kshetra's lock under its host/pid.
    const release = await takeWorkerLock(tg);
    onTestFinished(() => release());
    const local = await tg.locks.holder('worker');
    deps.kshetra = () => ({ paused: false, localWorker: local });
    await expect(run('claim', a.id)).rejects.toThrow(/isn't paused; pause it first/);
    // A worker elsewhere: this machine's paused flag says nothing about it.
    deps.kshetra = () => ({ paused: true, localWorker: null });
    await expect(run('claim', a.id)).rejects.toThrow(/a worker on .* runs web/);
    // This machine's worker, paused: a person may.
    deps.kshetra = () => ({ paused: true, localWorker: local });
    expect(await run('claim', a.id)).toMatch(/claimed/);
  });

  it('works a Kshetra by hand only while it is paused, even with no worker running', async () => {
    const { tg, run, deps } = await setup('kshetra');
    const a = await ready(tg);
    deps.interactive = () => true;
    await expect(run('claim', a.id)).rejects.toThrow(/isn't paused/);
    expect((await tg.tasks.get(a.id)).state).toBe('open');
  });

  it('never works a Kshetra\'s tasks from a session that isn\'t interactive', async () => {
    const { tg, run, deps } = await setup('kshetra');
    const a = await ready(tg);
    deps.kshetra = () => ({ paused: true, localWorker: null });
    for (const args of [['claim', a.id], ['cancel', a.id, '--reason', 'r'], ['release', a.id, '--force'], ['finish', a.id, '--reason', 'r']]) {
      await expect(run(...args)).rejects.toThrow(/needs an interactive terminal/);
    }
    expect((await tg.tasks.get(a.id)).state).toBe('open');
    // Reading and filing stay open to sessions.
    expect(await run('list')).toContain(a.id);
  });

  it('claim takes that one task for 8 hours, recording the developer and cli worker', async () => {
    const { tg, run } = await setup();
    await ready(tg, 'first');
    const b = await ready(tg, 'second');
    await run('claim', b.id);
    const t = await tg.tasks.get(b.id);
    expect(t.claim).toMatchObject({ actor: ME, worker: expect.stringMatching(new RegExp(`^cli:${ME}@`)) });
    const hours = (new Date(t.claim!.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    await expect(run('claim', b.id)).rejects.toThrow(/you already hold/);
  });

  it('says why a task can\'t be claimed', async () => {
    const { tg, run } = await setup();
    const dev = tg.as({ id: ME, role: 'developer' });
    const proposed = await dev.tasks.create({ title: 'p' });
    await expect(run('claim', proposed.id)).rejects.toThrow(/is proposed, not open/);
    const a = await ready(tg, 'a');
    const b = await ready(tg, 'b');
    await dev.deps.add(b.id, a.id);
    await expect(run('claim', b.id)).rejects.toThrow(new RegExp(`waits on ${a.id} \\(open\\)`));
    const epic = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'e', kind: 'container' });
    await expect(run('claim', epic.id)).rejects.toThrow(/is an epic/);
  });

  it('note renews the developer\'s own claim', async () => {
    const { t, tg, run } = await setup();
    const a = await ready(tg);
    await run('claim', a.id);
    await t.pglite.query(`update taskgraph.tasks set lease_expires_at = now() + interval '1 minute' where id = $1`, [a.id]);
    await run('note', a.id, 'progress');
    const hours = (new Date((await tg.tasks.get(a.id)).claim!.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
  });

  it('finish needs the claim and, for a task with checks, the developer\'s confirmation', async () => {
    const { shreni, tg, run } = await setup();
    const id = JSON.parse(await run('create', '--title', 'x', '--check', 'given a when b then c', '--json')).id;
    await tg.as({ id: ME, role: 'developer' }).tasks.approve(id, { via: 'test' });
    await expect(run('finish', id, '--reason', 'done')).rejects.toThrow(/isn't claimed; claim it first/);
    await run('claim', id);
    await expect(run('finish', id, '--reason', 'done')).rejects.toThrow(/confirm that each holds with --checks-passed[\s\S]*Given a, when b, then c/);
    expect(await run('finish', id, '--reason', 'done', '--checks-passed')).toMatch(/finished/);
    const t = await tg.tasks.get(id);
    expect(t.state).toBe('done');
    const ev = await shreni.db.selectFrom('shreni.attempt_evidence').select('gates').executeTakeFirstOrThrow();
    expect(ev.gates).toMatchObject({ acceptance: { passed: true, confirmedBy: ME } });
  });

  it('finish on an epic completes it once its tasks have settled', async () => {
    const { tg, run } = await setup();
    const sys = tg.as({ id: 's', role: 'system' });
    const epic = await sys.tasks.create({ title: 'e', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    await expect(run('finish', epic.id, '--reason', 'all done')).rejects.toThrow(/ChildrenLive/);
    await run('claim', a.id);
    await run('finish', a.id, '--reason', 'did it');
    await run('finish', epic.id, '--reason', 'all done');
    expect((await tg.tasks.get(epic.id)).state).toBe('done');
  });

  it('release gives back the developer\'s claim; --force takes back anyone\'s, the event naming who', async () => {
    const { tg, run, deps } = await setup();
    const a = await ready(tg);
    await run('claim', a.id);
    await run('release', a.id);
    expect((await tg.tasks.get(a.id)).state).toBe('open');
    await run('claim', a.id);
    deps.user = () => 'bea@example.com';
    await run('release', a.id, '--force');
    expect((await tg.tasks.get(a.id)).state).toBe('open');
    const ev = (await tg.tasks.history(a.id)).filter(e => e.kind === 'move:release').at(-1)!;
    expect(ev).toMatchObject({ actor: 'bea@example.com', payload: { forcedFrom: ME } });
    await expect(run('release', a.id)).rejects.toThrow(/isn't claimed/);
  });

  it('cancel refuses live children and live dependents unless asked, and then cancels them', async () => {
    const { tg, run } = await setup();
    const sys = tg.as({ id: 's', role: 'system' });
    const epic = await sys.tasks.create({ title: 'e', kind: 'container' });
    const a = await sys.tasks.create({ title: 'a', parent: epic.id });
    const b = await sys.tasks.create({ title: 'b', parent: epic.id });
    const outside = await sys.tasks.create({ title: 'outside' });
    const dev = tg.as({ id: ME, role: 'developer' });
    await dev.deps.add(b.id, a.id);          // inside the set: fine
    await dev.deps.add(outside.id, a.id);    // outside: needs --drop-deps
    await expect(run('cancel', epic.id, '--reason', 'r')).rejects.toThrow(/--with-children/);
    await expect(run('cancel', epic.id, '--reason', 'r', '--with-children')).rejects.toThrow(/--drop-deps/);
    // Refused before anything was cancelled.
    expect((await tg.tasks.list({ states: ['cancelled'] }))).toEqual([]);
    const out = await run('cancel', epic.id, '--reason', 'r', '--with-children', '--drop-deps');
    expect(out).toMatch(new RegExp(`cancelled .*${epic.id}$`));
    expect((await tg.tasks.list({ states: ['cancelled'] })).map(t => t.id).sort()).toEqual([epic.id, a.id, b.id].sort());
    expect((await tg.tasks.get(outside.id)).deps).toEqual([]);
  });

  it('approve, at a terminal, approves a lone task or a plan once its id is typed back', async () => {
    const { t, tg, run, deps } = await setup();
    deps.interactive = () => true;
    const dev = tg.as({ id: ME, role: 'developer' });
    const lone = await dev.tasks.create({ title: 'lone' });
    deps.ask = async () => 'nope';
    await expect(run('approve', lone.id)).rejects.toThrow(/not approved/);
    expect((await tg.tasks.get(lone.id)).state).toBe('proposed');
    deps.ask = async () => lone.id;
    expect(await run('approve', lone.id)).toMatch(/approved/);
    expect((await tg.tasks.get(lone.id)).state).toBe('open');

    await t.pglite.query(`insert into taskgraph.plans (project_id, id, title, meta) values ($1, 'web-plan-1', 'Accounts', '{}')`, [tg.id]);
    const planned = await tg.as({ id: 'p', role: 'planner' }).tasks.create({ title: 'in the plan', plan: 'web-plan-1' });
    deps.ask = async () => 'web-plan-1';
    const shown = await run('approve', 'web-plan-1');
    expect(shown).toMatch(/plan web-plan-1: Accounts/);
    expect(shown).toContain(planned.id);
    expect((await tg.tasks.get(planned.id)).state).toBe('open');
  });

  it('approve shows a task\'s checks, and refuses a plan that grew while the developer looked', async () => {
    const { t, tg, run, deps } = await setup();
    deps.interactive = () => true;
    await t.pglite.query(`insert into taskgraph.plans (project_id, id, title, meta) values ($1, 'web-plan-2', 'P', '{}')`, [tg.id]);
    const planner = tg.as({ id: 'p', role: 'planner' });
    await planner.tasks.create({ title: 'first', plan: 'web-plan-2' });
    deps.ask = async () => {
      await planner.tasks.create({ title: 'slipped in', plan: 'web-plan-2' });
      return 'web-plan-2';
    };
    await expect(run('approve', 'web-plan-2')).rejects.toThrow(/changed while you looked/);
    expect(await tg.tasks.list({ plan: 'web-plan-2', states: ['open'] })).toEqual([]);

    const id = JSON.parse(await run('create', '--title', 'x', '--check', 'given a when b then c', '--json')).id;
    const printed: string[] = [];
    deps.print = l => printed.push(l);
    deps.ask = async () => 'no';
    await expect(run('approve', id)).rejects.toThrow(/not approved/);
    expect(printed.join('\n')).toMatch(/Given a, when b, then c/);
  });

  it('upgrade, at a terminal, says when the project is already on this lifecycle', async () => {
    const { run, deps } = await setup();
    deps.interactive = () => true;
    expect(await run('upgrade')).toMatch(/already on shreni\.task@\d+/);
  });
});


const e = async (shreni: ShreniClient, q: string) => (await sql.raw(q).execute(shreni.db)).rows as Record<string, unknown>[];

describe('shreni task confirm', { timeout: PGLITE_TIMEOUT }, () => {
  /** A task with a manual check that the worker landed: finish refused by checksPassed, so it was flagged. */
  async function landedAndFlagged(shreni: ShreniClient, tg: Awaited<ReturnType<typeof setup>>['tg']) {
    const t = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'needs a person' });
    await shreni.transaction(db => db.insertInto('shreni.acceptance_checks').values({
      project_id: tg.id, task_id: t.id, given: 'the dashboard', when: 'a person opens it', then: 'it reads well', mode: 'manual',
    }).execute());
    const worker = tg.as({ id: 'sthapathi', role: 'orchestrator' });
    const claim = (await worker.claim({ worker: 'host/1', leaseMs: 3_600_000 }))!;
    // Green gates and an approval pass the auto checks only.
    await shreni.transaction(db => sql`insert into shreni.attempt_evidence (attempt_id, gates)
      values (${claim.attemptId}, '{"acceptance":{"passed":false}}'::jsonb)`.execute(db));
    // The work is on main: the store records that before it finishes, and the finish is refused.
    await shreni.transaction(db => sql`update shreni.attempt_evidence set gates = gates || '{"landed":true}'::jsonb
      where attempt_id = ${claim.attemptId}`.execute(db));
    await expect(worker.moveClaimed(claim, 'finish', { reason: 'merged' })).rejects.toThrow(/acceptance checks haven't passed/);
    await worker.moveClaimed(claim, 'flag', { reason: 'a manual check waits on the developer' });
    return { t, claim };
  }

  it('given a task landed with a manual check and flagged, when the developer confirms its checks, then acceptance passes on its attempt and the task finishes', async () => {
    const { shreni, tg, run, deps } = await setup('kshetra');
    const { t, claim } = await landedAndFlagged(shreni, tg);
    expect((await tg.tasks.get(t.id)).state).toBe('blocked');
    deps.interactive = () => true;
    const asked: string[] = [];
    deps.ask = async q => { asked.push(q); return 'y'; };
    const out = await run('confirm', t.id);
    expect(out).toMatch(/\(manual\) Given the dashboard, when a person opens it, then it reads well[\s\S]*confirmed and finished/);
    expect(asked).toEqual(['Do all of these hold? [y/N] ']);
    expect((await tg.tasks.get(t.id)).state).toBe('done');
    const ev = await shreni.db.selectFrom('shreni.attempt_evidence').select('gates').where('attempt_id', '=', claim.attemptId).executeTakeFirstOrThrow();
    expect(ev.gates).toMatchObject({ acceptance: { passed: true, confirmedBy: ME, checks: 1 } });
    const [move] = await e(shreni, `select kind, actor, actor_role, payload from taskgraph.events where task_id = '${t.id}' and kind = 'move:confirm'`);
    expect(move).toMatchObject({ actor: ME, actor_role: 'developer', payload: { reason: `acceptance checks confirmed by ${ME}` } });
  });

  it('needs a terminal and a yes, and only finishes a task flagged for its checks', async () => {
    const { shreni, tg, run, deps } = await setup('kshetra');
    const { t } = await landedAndFlagged(shreni, tg);
    await expect(run('confirm', t.id)).rejects.toThrow(/needs an interactive terminal/);
    deps.interactive = () => true;
    deps.ask = async () => 'n';
    await expect(run('confirm', t.id)).rejects.toThrow(/not confirmed/);
    expect((await tg.tasks.get(t.id)).state).toBe('blocked');

    // Refused before the question when there is nothing to confirm.
    deps.ask = async () => { throw new Error('not asked'); };
    const open = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'open' });
    await expect(run('confirm', open.id)).rejects.toThrow(/is open; confirm finishes a task flagged for its manual checks/);
  });

  it('on a project still on an older lifecycle, says to upgrade, and upgrade itself skips the sweep', async () => {
    const { run, deps, shreni } = await setup();
    const real = shreni.tg.project.bind(shreni.tg);
    const behind = { ...shreni, tg: { ...shreni.tg, project: (id: string) => Object.assign(Object.create(real(id)), {
      expireLeases: async () => { throw new VersionMismatch('the project is on shreni.task@1; this process runs shreni.task@2'); },
    }) } } as unknown as ShreniClient;
    deps.open = async () => ({ shreni: behind, close: async () => {} });
    await expect(run('ready')).rejects.toThrow(/on shreni\.task@1; this process runs shreni\.task@2; run shreni task upgrade in a terminal/);
    deps.interactive = () => true;
    expect(await run('upgrade')).toMatch(/already on shreni\.task@\d+/);
  });
});

describe('shreni task unblock', { timeout: PGLITE_TIMEOUT }, () => {
  it('given a blocked task, when the developer unblocks it in a terminal, then it is open again and ready', async () => {
    const { tg, run, deps, shreni } = await setup('kshetra');
    const t = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'flagged' });
    const worker = tg.as({ id: 'sthapathi', role: 'orchestrator' });
    const claim = (await worker.claim({ worker: 'host/1', leaseMs: 3_600_000 }))!;
    await worker.moveClaimed(claim, 'flag', { reason: 'PR closed without merging' });

    await expect(run('unblock', t.id, '--reason', 'fixed')).rejects.toThrow(/needs an interactive terminal/);
    deps.interactive = () => true;
    await expect(run('unblock', t.id)).rejects.toThrow(/Usage: shreni task unblock <id> --reason/);
    expect(await run('unblock', t.id, '--reason', 'rebased onto main')).toBe(`unblocked ${t.id}: open again`);
    expect((await tg.tasks.get(t.id)).state).toBe('open');
    expect((await tg.ready()).map(x => x.id)).toEqual([t.id]);
    const [ev] = await e(shreni, `select actor, actor_role, payload from taskgraph.events where task_id = '${t.id}' and kind = 'move:unblock'`);
    expect(ev).toMatchObject({ actor: ME, actor_role: 'developer', payload: { reason: 'rebased onto main' } });
    await expect(run('unblock', t.id, '--reason', 'again')).rejects.toThrow(/is open, not blocked/);
  });

  it('names a branch a declined PR left behind, with the command that deletes it, and keeps it', async () => {
    const { tg, run, deps, repo } = await setup('kshetra');
    const t = await tg.as({ id: 's', role: 'system' }).tasks.create({ title: 'Add login' });
    const worker = tg.as({ id: 'sthapathi', role: 'orchestrator' });
    await worker.moveClaimed((await worker.claim({ worker: 'host/1', leaseMs: 3_600_000 }))!, 'flag', { reason: 'PR closed without merging' });
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, PATH: process.env.PATH }, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('branch', `bead-${t.id}/add-login`);
    deps.interactive = () => true;
    const out = await run('unblock', t.id, '--reason', 'reviewer was wrong');
    expect(out).toContain(`bead-${t.id}/add-login is still there, so the worker won't start ${t.id} afresh; delete it first: git -C ${repo} branch -D bead-${t.id}/add-login`);
    expect(git('branch', '--list', `bead-${t.id}/*`).toString()).toContain(`bead-${t.id}/add-login`);
  });
});

describe('a project on an older lifecycle', { timeout: PGLITE_TIMEOUT }, () => {
  /** A project made on v1 (the lifecycle without confirm), opened by this Shreni. */
  async function behind() {
    const t = await createTestDb();
    const v1 = defineLifecycle({ ...taskLifecycle, version: 1, moves: taskLifecycle.moves.filter(m => m.name !== 'confirm') });
    const old = await openShreni({ db: t.db, lifecycle: v1 });
    await old.migrate();
    const p = await old.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: ME, role: 'developer' } });
    await old.close();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    const k = { id: 'web', project: p.id, database: 'local', repo: { path: '/repos/web' } } as unknown as KshetraConfig;
    return { shreni, p, k };
  }

  it('shreni start, detached, refuses and prints the command; in a terminal, shows the change and upgrades on the version typed back', async () => {
    const { shreni, p, k } = await behind();
    expect(await lifecycleGap(shreni, p.id)).toEqual({ on: 'shreni.task@1', runs: 'shreni.task@2', newer: false });
    const out: string[] = [];
    const base = {
      open: async () => ({ shreni, close: async () => {} }), user: () => ME, print: (l: string) => out.push(l),
      backup: async () => 'dumped first: test.dump',
    };
    await expect(ensureLifecycleCurrent(k, { ...base, interactive: () => false }))
      .rejects.toThrow(/web: its project is on shreni\.task@1, older than this Shreni's shreni\.task@2; run shreni start in a terminal/);
    await expect(ensureLifecycleCurrent(k, { ...base, interactive: () => true, ask: async () => 'no' })).rejects.toThrow(/not upgraded/);
    await ensureLifecycleCurrent(k, { ...base, interactive: () => true, ask: async () => 'shreni.task@2' });
    expect(out.join('\n')).toMatch(/shreni\.task@1 → shreni\.task@2[\s\S]*moves added: confirm[\s\S]*dumped first[\s\S]*upgraded to shreni\.task@2/);
    expect(await lifecycleGap(shreni, p.id)).toBeNull();
    // Current now: nothing asked.
    await ensureLifecycleCurrent(k, { ...base, interactive: () => true, ask: async () => { throw new Error('not asked'); } });
  });

  it('never upgrades under a worker that holds the Kshetra, and refuses a project newer than this Shreni', async () => {
    const { shreni, p, k } = await behind();
    const base = { open: async () => ({ shreni, close: async () => {} }), user: () => ME, print: () => {}, backup: async () => 'no dump' };
    const lock = await takeWorkerLock(shreni.tg.project(p.id));
    await expect(ensureLifecycleCurrent(k, { ...base, interactive: () => true, ask: async () => 'shreni.task@2' }))
      .rejects.toThrow(/older than this Shreni's shreni\.task@2, and a worker .* still holds it; stop that worker first/);
    await lock();

    // This Shreni on v1, the project on v2.
    await ensureLifecycleCurrent(k, { ...base, interactive: () => true, ask: async () => 'shreni.task@2' });
    const v1 = defineLifecycle({ ...taskLifecycle, version: 1, moves: taskLifecycle.moves.filter(m => m.name !== 'confirm') });
    const older = await openShreni({ db: shreni.db, lifecycle: v1 });
    await expect(ensureLifecycleCurrent(k, { ...base, open: async () => ({ shreni: older, close: async () => {} }), interactive: () => true }))
      .rejects.toThrow(/web: its project is on shreni\.task@2, newer than this Shreni's shreni\.task@1; upgrade Shreni instead/);
  });
});

describe('shreni task setup and prime', { timeout: PGLITE_TIMEOUT }, () => {
  it('setup writes the tracker block for each agent CLI and the prime hooks; prime prints it with the memories', async () => {
    const { repo, run } = await setup();
    writeFileSync(join(repo, '.shreni', 'tracker.yaml'), `${readFileSync(join(repo, '.shreni', 'tracker.yaml'), 'utf8')}providers: [claude, codex]\n`);
    writeFileSync(join(repo, 'CLAUDE.md'), '# Ours\n');
    expect(await run('setup')).toMatch(/CLAUDE\.md: added\n.*AGENTS\.md: created\n.*settings\.json: prime hooks installed/);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toMatch(/^# Ours\n\n<!-- shreni:begin tracker v1 -->/);

    await run('remember', 'use pnpm, never npm', '--key', 'pnpm');
    const primed = await run('prime');
    expect(primed).toMatch(/^## Task tracking\n/);
    expect(primed).toContain('- **pnpm**: use pnpm, never npm');
    expect(primed).not.toContain('Warning:');
  });

  it('prime warns about a file whose block is missing or behind, and still prints when the database is down', async () => {
    const { repo, run, deps } = await setup();
    writeFileSync(join(repo, 'CLAUDE.md'), '<!-- shreni:begin tracker v0 -->\nold\n<!-- shreni:end -->\n');
    deps.open = async () => { throw new Error('connect ECONNREFUSED'); };
    const primed = await run('prime');
    expect(primed).toMatch(/^## Task tracking/);
    expect(primed).toContain('(memories unavailable: connect ECONNREFUSED)');
    expect(primed).toMatch(/Warning: .*CLAUDE\.md's block is v0, behind v1; run shreni task setup/);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('tracker v0');
  });

  it('in a Kshetra, setup and prime use the Kshetra block, never the tracker one', async () => {
    const { repo, run } = await setup('kshetra');
    writeFileSync(join(repo, 'CLAUDE.md'), `x\n<!-- shreni:begin tracker v1 -->\nclaim away\n<!-- shreni:end -->\n`);
    // A tracker block another agent CLI's file kept from before the Kshetra goes too.
    writeFileSync(join(repo, 'AGENTS.md'), `y\n<!-- shreni:begin tracker v1 -->\nclaim away\n<!-- shreni:end -->\n`);
    writeFileSync(join(repo, 'GEMINI.md'), 'no block here\n');
    await run('setup');
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toMatch(/^y\n<!-- shreni:begin kshetra v1 -->/);
    expect(readFileSync(join(repo, 'GEMINI.md'), 'utf8')).toBe('no block here\n');
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    expect(text).toMatch(/^x\n<!-- shreni:begin kshetra v1 -->\n## Shreni\n/);
    expect(text).not.toContain('claim away');
    expect(await run('prime')).toMatch(/^## Shreni\n\nThis project is a Kshetra/);
  });

  it('setup leaves a Kshetra still on beads alone, and prime waits only briefly for the database', async () => {
    const { repo, run } = await setup('kshetra');
    const file = join(repo, '.shreni', 'kshetra.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^project: .*\n/m, ''));
    await expect(run('setup')).rejects.toThrow('web has no task graph project: run shreni migrate web');
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);

    const { run: run2, deps: deps2 } = await setup();
    const seen: unknown[] = [];
    const open = deps2.open;
    deps2.open = async (c, o) => { seen.push(o); return open(c); };
    await run2('prime');
    expect(seen).toEqual([{ connectTimeout: 3 }]);
  });
});
