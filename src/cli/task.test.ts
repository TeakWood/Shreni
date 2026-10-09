import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { sql } from 'kysely';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import { makeContext } from './registry';
import { findProjectConfig, parseCheck, runTask, type TaskDeps } from './task';

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
