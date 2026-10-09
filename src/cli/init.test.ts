import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'js-yaml';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import type { DbProbe } from '../policy/db/checks';
import type { InitEngine, InitKshetraOpts } from './init-kshetra';

// shreni init with modes (policy spec, "Init"): the first question decides
// whether Shreni works the repo's tasks (a Kshetra) or only tracks them.

const HOME = mkdtempSync(join(tmpdir(), 'shreni-init-home-'));
vi.mock('os', async orig => ({ ...(await orig<typeof import('os')>()), homedir: () => HOME }));
vi.mock('../kshetra/user-config', async orig => ({
  ...(await orig<typeof import('../kshetra/user-config')>()),
  loadUserConfig: () => ({ user: 'ann@example.com', databases: { local: { url: 'postgres://localhost:5432/shreni' } } }),
}));
const { runInit, initEngine, trackerAt, startRefusal } = await import('./init');
const { registerProject, projectMode, idPrefixFor } = await import('../policy/init/project');
const { registerKshetra, unregisterKshetra, loadRegistry } = await import('../kshetra/registry');
const { COMMANDS } = await import('./commands');
const { makeContext } = await import('./registry');
type InitDeps = import('./init').InitDeps;

const REGISTRY = join(HOME, '.shreni', 'registry.json');
const ID = '00000000-0000-4000-8000-000000000001';

/** A repo with a .git, so the config walk stops at it. */
function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'shreni-init-repo-'));
  mkdirSync(join(r, '.git'));
  return r;
}

async function engineDb() {
  const t = await createTestDb();
  const shreni: ShreniClient = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  return shreni;
}

/** Deps over a real (PGlite) database; the Database phase is a no-op unless given. */
function deps(shreni: ShreniClient | null, over: Partial<InitDeps> = {}) {
  const out: string[] = [];
  const kshetra = vi.fn<(o: InitKshetraOpts) => Promise<void>>(async () => {});
  const d: InitDeps & { out: string[]; kshetraCalls: typeof kshetra } = {
    out,
    kshetraCalls: kshetra,
    interactive: () => false,
    ask: async () => { throw new Error('not asked'); },
    print: l => out.push(l),
    kshetra,
    engine: project => ({
      database: async () => {},
      project: async ({ existing, repoUrl }) => (await registerProject(shreni!, {
        id: existing, name: project.name, idPrefix: idPrefixFor(project.name), mode: project.mode,
        repoUrl: repoUrl || undefined, actor: { id: 'ann@example.com', role: 'developer' },
      })).id,
    }),
    workerRunning: () => false,
    unregister: vi.fn(),
    ...over,
  };
  return d;
}

describe('shreni init: the mode', { timeout: PGLITE_TIMEOUT }, () => {
  it('given a run that isn\'t interactive and has no --mode, when init runs, then it refuses', async () => {
    const d = deps(null);
    await expect(runInit({ path: repo() }, d)).rejects.toThrow(/needs --mode kshetra or --mode tracker/);
    expect(d.kshetraCalls).not.toHaveBeenCalled();
    await expect(runInit({ path: repo(), mode: 'both' }, d)).rejects.toThrow(/--mode is kshetra or tracker, not "both"/);
  });

  it('given --mode tracker, then it writes tracker.yaml, adds nothing to registry.json, and shreni start then refuses the repo', async () => {
    const shreni = await engineDb();
    const r = repo();
    const before = existsSync(REGISTRY) ? readFileSync(REGISTRY, 'utf8') : null;
    const d = deps(shreni);
    await runInit({ mode: 'tracker', path: r, slug: 'notes' }, d);

    const file = join(r, '.shreni', 'tracker.yaml');
    const config = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ name: 'notes', database: 'local', providers: ['claude'] });
    expect(await projectMode(shreni, config.project as string)).toBe('tracker');
    expect((await shreni.tg.projects.get(config.project as string)).idPrefix).toBe('notes');
    expect(existsSync(REGISTRY) ? readFileSync(REGISTRY, 'utf8') : null).toBe(before);
    expect(d.kshetraCalls).not.toHaveBeenCalled();
    // Its instruction file gets the tracker block, and Claude Code the prime hooks.
    expect(readFileSync(join(r, 'CLAUDE.md'), 'utf8')).toMatch(/^<!-- shreni:begin tracker v1 -->/);
    expect(readFileSync(join(r, '.claude', 'settings.json'), 'utf8')).toContain('shreni task prime');

    // shreni start, run from inside the repo, naming it.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(r, '.shreni'));
    onTestFinished(() => cwd.mockRestore());
    const start = COMMANDS.find(c => c.name === 'start')!;
    await expect(start.run(makeContext(['--kshetra', 'notes']))).rejects.toThrow(/this repo is a tracker project .*Shreni never works its tasks/);
    expect(trackerAt(r)).toBe(file);
  });

  it('asks the mode in a terminal, with no default, until it gets one', async () => {
    const answers = ['', 'maybe', 'kshetra'];
    const d = deps(null, { interactive: () => true, ask: async () => answers.shift() ?? '' });
    const r = repo();
    await runInit({ path: r, slug: 'web' }, d);
    expect(d.out.filter(l => /answer kshetra or tracker/.test(l))).toHaveLength(2);
    expect(d.kshetraCalls).toHaveBeenCalledWith(expect.objectContaining({ slug: 'web', path: resolve(r), engine: expect.any(Object) }));
  });

  it('--mode kshetra runs the Kshetra phases with the engine\'s, passing every option through', async () => {
    const d = deps(null);
    const r = repo();
    await runInit({
      mode: 'kshetra', path: r, slug: 'web', org: 'Acme', language: 'python', provider: 'claude',
      model: 'm', mergePolicy: 'pr', dryRun: true, pack: 'p', noPack: false, upgrade: false,
    }, d);
    expect(d.kshetraCalls).toHaveBeenCalledWith({
      slug: 'web', path: resolve(r), org: 'Acme', language: 'python', provider: 'claude', model: 'm',
      mergePolicy: 'pr', dryRun: true, pack: 'p', noPack: false, upgrade: false, engine: expect.any(Object),
    });
  });
});

describe('shreni start and tracker projects', () => {
  it('refuses a Kshetra whose repo holds a tracker.yaml, and the tracker repo when it is all there is to start', () => {
    const r = repo();
    mkdirSync(join(r, '.shreni'));
    writeFileSync(join(r, '.shreni', 'tracker.yaml'), 'name: notes\n');
    expect(startRefusal('/', [{ id: 'web', repo: { path: r } }], false)).toMatch(/web: its repo is a tracker project/);
    expect(startRefusal(join(r, '.shreni'), [], false)).toMatch(/this repo is a tracker project/);
    expect(startRefusal(join(r, '.shreni'), [], true)).toMatch(/this repo is a tracker project/);
    // From a tracker checkout, the developer's other Kshetras still start.
    const other = repo();
    expect(startRefusal(join(r, '.shreni'), [{ id: 'api', repo: { path: other } }], false)).toBeNull();
    // The walk ends at a repo's own root.
    const nested = join(r, 'vendor', 'lib');
    mkdirSync(join(nested, '.git'), { recursive: true });
    expect(trackerAt(nested)).toBeNull();
  });

  it('refuses a Kshetra with no project, naming shreni migrate, whether or not it still has beads to move', async () => {
    const kshetraAt = (id: string, extra = '') => {
      const r = repo();
      mkdirSync(join(r, '.shreni'));
      const config = join(r, '.shreni', 'kshetra.yaml');
      writeFileSync(config, `id: ${id}\nname: ${id}\nrepo: { path: ${r}, remote: 'git@x:${id}.git' }\nstack: { language: ts }\n${extra}`);
      registerKshetra(id, config);
      onTestFinished(() => unregisterKshetra(id));
      return r;
    };
    kshetraAt('noproj');
    // An old config still on beads: without a terminal, it isn't offered the move.
    const beads = mkdtempSync(join(tmpdir(), 'shreni-init-beads-'));
    writeFileSync(join(beads, 'issues.jsonl'), '');
    kshetraAt('oldbeads', `beads: { path: ${beads}, remote: 'git@x:b.git' }\n`);
    const start = COMMANDS.find(c => c.name === 'start')!;
    await expect(start.run(makeContext(['--kshetra', 'noproj'])))
      .rejects.toThrow('noproj: not started: noproj has no task graph project: run shreni migrate noproj');
    await expect(start.run(makeContext(['--kshetra', 'oldbeads'])))
      .rejects.toThrow('oldbeads: not started: oldbeads has no task graph project: run shreni migrate oldbeads');
  });
});

describe('shreni init: tracker projects', { timeout: PGLITE_TIMEOUT }, () => {
  it('init again in the same mode keeps the project, and the settings a person added', async () => {
    const shreni = await engineDb();
    const r = repo();
    await runInit({ mode: 'tracker', path: r, slug: 'notes', providers: 'claude,codex' }, deps(shreni));
    const file = join(r, '.shreni', 'tracker.yaml');
    const first = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, `${readFileSync(file, 'utf8')}description: my notes\n`);
    await runInit({ mode: 'tracker', path: r }, deps(shreni));
    const again = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(again).toMatchObject({ project: first.project, providers: ['claude', 'codex'], description: 'my notes', name: 'notes' });
    expect(await shreni.tg.projects.list()).toHaveLength(1);
    // A file that leaves settings to their defaults isn't rewritten, so its comments stay.
    const r2 = repo();
    mkdirSync(join(r2, '.shreni'));
    const hand = join(r2, '.shreni', 'tracker.yaml');
    writeFileSync(hand, `name: notes\n# our tracker\nproject: ${first.project}\n`);
    await runInit({ mode: 'tracker', path: r2 }, deps(shreni));
    expect(readFileSync(hand, 'utf8')).toBe(`name: notes\n# our tracker\nproject: ${first.project}\n`);
  });

  it('asks which agent CLIs people use, defaulting to Claude, and refuses one it doesn\'t know', async () => {
    const shreni = await engineDb();
    const r = repo();
    const answers = ['', ''];
    await runInit({ mode: 'tracker', path: r }, deps(shreni, { interactive: () => true, ask: async () => answers.shift() ?? '' }));
    expect(yaml.load(readFileSync(join(r, '.shreni', 'tracker.yaml'), 'utf8'))).toMatchObject({ providers: ['claude'] });
    await expect(runInit({ mode: 'tracker', path: repo(), providers: 'claude,cursor' }, deps(shreni))).rejects.toThrow(/agent CLIs are claude, codex, gemini/);
  });

  it('a config naming a project this database lacks fails the Project step, saying what to fix', async () => {
    const shreni = await engineDb();
    const r = repo();
    mkdirSync(join(r, '.shreni'));
    writeFileSync(join(r, '.shreni', 'tracker.yaml'), `name: notes\nproject: ${ID}\n`);
    const d = deps(shreni);
    await expect(runInit({ mode: 'tracker', path: r }, d)).rejects.toThrow(/names project .* which isn't in this database; point database: at the one that holds it, or delete project:/);
    expect(d.out.join('\n')).toMatch(/✗ Project failed[\s\S]*re-run \(finished steps are skipped\): shreni init --mode tracker/);
  });

  it('--dry-run writes nothing', async () => {
    const r = repo();
    const d = deps(null);
    await runInit({ mode: 'tracker', path: r, slug: 'notes', dryRun: true }, d);
    expect(existsSync(join(r, '.shreni'))).toBe(false);
    expect(d.out.join('\n')).toMatch(/mode: +tracker[\s\S]*project: +notes \(new\)/);
  });
});

describe('shreni init: changing mode', { timeout: PGLITE_TIMEOUT }, () => {
  /** A tracker repo, registered. */
  async function trackerRepo(shreni: ShreniClient) {
    const r = repo();
    await runInit({ mode: 'tracker', path: r, slug: 'notes' }, deps(shreni));
    return { r, id: (yaml.load(readFileSync(join(r, '.shreni', 'tracker.yaml'), 'utf8')) as { project: string }).project };
  }

  it('tracker to Kshetra needs a terminal and the project\'s name typed back, then carries the project over', async () => {
    const shreni = await engineDb();
    const { r } = await trackerRepo(shreni);
    await expect(runInit({ mode: 'kshetra', path: r }, deps(shreni))).rejects.toThrow(/needs a terminal, to confirm by typing the project's name/);
    const wrong = deps(shreni, { interactive: () => true, ask: async q => (q.startsWith('Kshetra slug') ? '' : 'nope') });
    await expect(runInit({ mode: 'kshetra', path: r }, wrong)).rejects.toThrow(/not changed/);
    expect(wrong.kshetraCalls).not.toHaveBeenCalled();

    const ok = deps(shreni, { interactive: () => true, ask: async q => (q.startsWith('Kshetra slug') ? '' : 'notes') });
    await runInit({ mode: 'kshetra', path: r }, ok);
    expect(ok.kshetraCalls).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'notes', replaces: join(resolve(r), '.shreni', 'tracker.yaml'), engine: expect.any(Object),
    }));
  });

  it('a switch to Kshetra stopped part way resumes without asking again', async () => {
    const shreni = await engineDb();
    const { r } = await trackerRepo(shreni);
    writeFileSync(join(r, '.shreni', 'kshetra.yaml'), 'id: notes\n');
    const d = deps(shreni);
    await runInit({ mode: 'kshetra', path: r }, d);
    expect(d.kshetraCalls).toHaveBeenCalledWith(expect.objectContaining({ replaces: join(resolve(r), '.shreni', 'tracker.yaml') }));
  });

  it('a switch to tracker stopped before the Project step resumes, reusing the Kshetra\'s project', async () => {
    const shreni = await engineDb();
    const r = repo();
    const p = await registerProject(shreni, { name: 'web', idPrefix: 'web', mode: 'kshetra', actor: { id: 'ann', role: 'developer' } });
    mkdirSync(join(r, '.shreni'));
    const kshetraYaml = join(r, '.shreni', 'kshetra.yaml');
    writeFileSync(kshetraYaml, [
      'id: web', 'name: Web', `project: ${p.id}`, `repo: { path: ${r}, remote: 'git@x:y.git' }`,
      `beads: { path: ${r}, remote: 'git@x:z.git' }`, 'stack: { language: ts }', '',
    ].join('\n'));
    const failing = deps(shreni);
    const realEngine = failing.engine;
    failing.engine = proj => ({ ...realEngine(proj), project: async () => { throw new Error('connection lost'); } });
    await expect(runInit({ mode: 'tracker', path: r }, failing)).rejects.toThrow(/connection lost/);
    expect(existsSync(kshetraYaml) && existsSync(join(r, '.shreni', 'tracker.yaml'))).toBe(true);
    await runInit({ mode: 'tracker', path: r }, deps(shreni));
    expect(yaml.load(readFileSync(join(r, '.shreni', 'tracker.yaml'), 'utf8'))).toMatchObject({ project: p.id, name: 'web' });
    expect(await shreni.tg.projects.list()).toHaveLength(1);
  });

  it('Kshetra to tracker refuses while a worker runs, then leaves the registry and keeps the project', async () => {
    const shreni = await engineDb();
    const r = repo();
    const p = await registerProject(shreni, { name: 'web', idPrefix: 'web', mode: 'kshetra', actor: { id: 'ann', role: 'developer' } });
    mkdirSync(join(r, '.shreni'));
    const kshetraYaml = join(r, '.shreni', 'kshetra.yaml');
    writeFileSync(kshetraYaml, [
      'id: web', 'name: Web', `project: ${p.id}`, 'database: local',
      `repo: { path: ${r}, remote: 'git@x:y.git' }`, `beads: { path: ${r}, remote: 'git@x:z.git' }`, 'stack: { language: ts }', '',
    ].join('\n'));
    registerKshetra('web', kshetraYaml);
    expect(loadRegistry().map(k => k.id)).toContain('web');

    await expect(runInit({ mode: 'tracker', path: r }, deps(shreni, { workerRunning: id => id === 'web' })))
      .rejects.toThrow(/Kshetra web has a worker running; shreni stop --kshetra web first/);

    const unregister = vi.fn();
    // In a terminal it asks first, and a no changes nothing.
    await expect(runInit({ mode: 'tracker', path: r }, deps(shreni, { interactive: () => true, ask: async q => (q.startsWith('Make') ? 'n' : '') })))
      .rejects.toThrow(/not changed/);
    expect(existsSync(kshetraYaml)).toBe(true);
    // The name defaults to the Kshetra's id, not the folder's.
    await runInit({ mode: 'tracker', path: r }, deps(shreni, { unregister }));
    expect(yaml.load(readFileSync(join(r, '.shreni', 'tracker.yaml'), 'utf8'))).toMatchObject({ name: 'web' });
    expect(unregister).toHaveBeenCalledWith('web');
    expect(existsSync(kshetraYaml)).toBe(false);
    // Its settings are kept aside: the file is gitignored, so nothing else holds them.
    expect(readFileSync(`${kshetraYaml}.bak`, 'utf8')).toContain('stack: { language: ts }');
    expect(yaml.load(readFileSync(join(r, '.shreni', 'tracker.yaml'), 'utf8'))).toMatchObject({ project: p.id, database: 'local' });
    expect(await projectMode(shreni, p.id)).toBe('tracker');
  });
});

describe('the Database and Project phases on the database', { timeout: PGLITE_TIMEOUT }, () => {
  /** A probe of a server that answers, at version 17, with pg_dump. */
  const probe: DbProbe = {
    platform: 'darwin',
    connect: async () => ({ ok: true, serverVersionNum: 170000 }),
    createDatabase: async () => {},
    installed: async () => ({ via: 'homebrew', formula: 'postgresql@17' }),
    pgDumpMajor: async () => 17,
    run: async () => 0,
    osUser: () => 'ann',
  };

  it('sets up a fresh database\'s schemas without asking, then registers the project', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    const out: string[] = [];
    const engine: InitEngine = initEngine(
      { interactive: () => false, ask: async () => { throw new Error('not asked'); }, print: l => out.push(l) },
      { name: 'notes', mode: 'tracker' },
      { probe, open: async () => ({ shreni, close: async () => {} }), env: {} },
    );
    await engine.database('local');
    expect(await shreni.pending()).toEqual([]);
    const id = await engine.project({ database: 'local', repoUrl: 'git@x:notes.git' });
    expect(await projectMode(shreni, id)).toBe('tracker');
    expect(await engine.project({ database: 'local', existing: id, repoUrl: '' })).toBe(id);
    expect(out.join('\n')).toMatch(/registered project notes \(.*\) as a tracker[\s\S]*found project notes/);
  });

  it('the Import phase: a repo with beads and no project yet moves its beads over instead of starting empty', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const r = repo();
    const beads = mkdtempSync(join(tmpdir(), 'shreni-init-beads-'));
    copyFileSync(join(__dirname, '..', 'policy', 'migrate', 'fixtures', 'shreni-beads.jsonl'), join(beads, 'issues.jsonl'));
    symlinkSync(beads, join(r, '.beads'));
    writeFileSync(join(r, '.gitignore'), '.beads\n');
    mkdirSync(join(r, '.shreni'));
    const config = join(r, '.shreni', 'tracker.yaml');
    writeFileSync(config, 'name: shreni\n');
    const out: string[] = [];
    const dumps: string[] = [];
    const engine = initEngine(
      { interactive: () => false, ask: async () => { throw new Error('not asked'); }, print: l => out.push(l) },
      { name: 'shreni', mode: 'tracker' },
      {
        probe, open: async () => ({ shreni, close: async () => {} }), env: {},
        dump: async db => { dumps.push(db); return 'dumped'; }, manifestsDir: join(r, 'm'),
      },
    );
    // Without a terminal the import needs its confirmation, so it stops before writing.
    await expect(engine.project({ database: 'local', repoUrl: '', beads: { dir: join(r, '.beads'), repo: r, configPath: config } }))
      .rejects.toThrow(/needs a confirmation/);
    expect(await shreni.tg.projects.list()).toEqual([]);

    const yes = initEngine(
      { interactive: () => true, ask: async () => 'y', print: l => out.push(l) },
      { name: 'shreni', mode: 'tracker' },
      {
        probe, open: async () => ({ shreni, close: async () => {} }), env: {},
        dump: async db => { dumps.push(db); return 'dumped'; }, manifestsDir: join(r, 'm'),
      },
    );
    const id = await yes.project({ database: 'local', repoUrl: '', beads: { dir: join(r, '.beads'), repo: r, configPath: config } });
    expect(dumps).toEqual(['local']);
    expect(await projectMode(shreni, id)).toBe('tracker');
    expect((await shreni.tg.project(id).tasks.list({ limit: 1000 })).length).toBe(457);
    expect(readFileSync(config, 'utf8')).toBe(`name: shreni\nproject: ${id}\ndatabase: local\n`);
    expect(existsSync(join(r, '.beads'))).toBe(false);
    expect(out.join('\n')).toMatch(/held by parked epic/);
    // The committed export is read; Shreni never runs bd.
    expect(out.join('\n')).toContain(`reading the committed ${join(r, '.beads', 'issues.jsonl')}; if bd is installed, run`);
    // Init keeps no record to undo: the config names the project, and the dump is the way back.
    expect(existsSync(join(r, 'm')) ? readdirSync(join(r, 'm')) : []).toEqual([]);
  });

  it('an existing database with pending migrations refuses a run that can\'t ask', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.tg.migrate();
    const engine = initEngine(
      { interactive: () => false, ask: async () => 'y', print: () => {} },
      { name: 'notes', mode: 'tracker' },
      { probe, open: async () => ({ shreni, close: async () => {} }), env: {} },
    );
    await expect(engine.database('local')).rejects.toThrow(/notes: the database has pending migrations .*run shreni db migrate/);
  });

  it('makes a task id prefix from a name', () => {
    expect(idPrefixFor('my notes!')).toBe('my-notes-');
    expect(idPrefixFor('-x')).toBe('x');
    expect(() => idPrefixFor('!!')).toThrow(/can't make a task id prefix/);
  });
});
