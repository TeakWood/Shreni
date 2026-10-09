import { describe, it, expect, onTestFinished } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { exportShreniProject } from '../policy/db/bundle';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import { loadKshetraConfig } from '../kshetra/config';
import { manifestPath, onBeads } from '../policy/migrate/kshetra';
import { LEGACY_SECTION as SHRENI_SECTION } from '../policy/init/instructions';
import { kshetraTarget, migrateKshetra, type MigrateDeps } from './migrate';

// shreni migrate (migration plan, "Upgrading a Kshetra" and "Migration test"):
// a fixture Kshetra built from the beads importer's fixture moves to the
// engine, a second run changes nothing, and --undo before any write puts the
// repo back byte for byte.

const FIXTURE = join(__dirname, '..', 'policy', 'migrate', 'fixtures', 'shreni-beads.jsonl');

/** A Kshetra on beads: its repo, config, instruction file, gitignore and .beads link, and the beads repo. */
function fixtureKshetra() {
  const root = mkdtempSync(join(tmpdir(), 'shreni-migrate-'));
  const repo = join(root, 'web');
  const beads = join(root, 'web-beads');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.shreni'));
  mkdirSync(beads);
  copyFileSync(FIXTURE, join(beads, 'issues.jsonl'));
  const configPath = join(repo, '.shreni', 'kshetra.yaml');
  writeFileSync(configPath, [
    'id: web', 'name: Web', `repo: { path: ${repo}, remote: 'git@example.com:web.git' }`,
    `beads: { path: ${beads}, remote: 'git@example.com:web-beads.git' }`, 'stack: { language: ts }', '',
  ].join('\n'));
  writeFileSync(join(repo, 'CLAUDE.md'), `# Web\n${SHRENI_SECTION}`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.beads\n.shreni/kshetra.yaml\n');
  symlinkSync(beads, join(repo, '.beads'));
  return { root, repo, beads, configPath };
}

/** Every file the migration may touch, as bytes, and the link. */
function snapshot(repo: string) {
  const files = ['.shreni/kshetra.yaml', 'CLAUDE.md', '.gitignore', '.claude/settings.json']
    .map(f => [f, existsSync(join(repo, f)) ? readFileSync(join(repo, f)).toString('base64') : null]);
  const link = join(repo, '.beads');
  return { files, link: existsSync(link) ? readlinkSync(link) : null };
}

async function setup() {
  const t = await createTestDb();
  const shreni: ShreniClient = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const k = fixtureKshetra();
  const out: string[] = [];
  const deps: MigrateDeps = {
    open: async () => ({ shreni, close: async () => {} }),
    workerRunning: () => false,
    kshetras: () => [loadKshetraConfig(k.configPath)],
    configPath: () => k.configPath,
    dump: async () => 'dumped first: test.dump',
    interactive: () => false,
    ask: async () => { throw new Error('not asked'); },
    print: l => out.push(l),
    manifestsDir: join(k.root, 'migrations'),
    now: new Date('2026-10-09T06:00:00Z'),
  };
  return { shreni, k, deps, out };
}

describe('shreni migrate', { timeout: PGLITE_TIMEOUT }, () => {
  it('given the fixture, when migrate runs twice, then the second run changes nothing', async () => {
    const { shreni, k, deps, out } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    expect(out.join('\n')).toMatch(/✓ the dry run checks pass[\s\S]*dumped first: test\.dump[\s\S]*imported 457 tasks as project web/);

    // Moved: the config names the project, the link and its ignore are gone, the block replaced the old section.
    const config = loadKshetraConfig(k.configPath);
    expect(config.project).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.database).toBe('local');
    expect(existsSync(join(k.repo, '.beads'))).toBe(false);
    expect(readFileSync(join(k.repo, '.gitignore'), 'utf8')).toBe('node_modules\n.shreni/kshetra.yaml\n');
    expect(readFileSync(join(k.repo, 'CLAUDE.md'), 'utf8')).toMatch(/^# Web\n\n<!-- shreni:begin kshetra v1 -->/);
    expect(readFileSync(join(k.repo, '.claude', 'settings.json'), 'utf8')).toContain('shreni task prime');
    expect(existsSync(join(k.beads, 'issues.jsonl'))).toBe(true);
    expect(onBeads(config, k.configPath)).toBeUndefined();

    const files = snapshot(k.repo);
    const db = await exportShreniProject(shreni, config.project!);
    out.length = 0;
    await migrateKshetra('web', deps, { yes: true });
    expect(out).toEqual(['web is already on the engine; nothing to do']);
    expect(snapshot(k.repo)).toEqual(files);
    expect(await exportShreniProject(shreni, config.project!)).toEqual(db);
    expect(await shreni.tg.projects.list()).toHaveLength(1);
  });

  it('given --undo before any write, then the fixture is restored byte for byte', async () => {
    const { shreni, k, deps } = await setup();
    const before = snapshot(k.repo);
    const issues = readFileSync(join(k.beads, 'issues.jsonl'));
    expect(onBeads(loadKshetraConfig(k.configPath), k.configPath)).toBe(k.beads);

    await migrateKshetra('web', deps, { yes: true });
    expect(snapshot(k.repo)).not.toEqual(before);
    await migrateKshetra('web', deps, { undo: true });
    expect(snapshot(k.repo)).toEqual(before);
    expect(readFileSync(join(k.beads, 'issues.jsonl'))).toEqual(issues);
    expect(await shreni.tg.projects.list()).toEqual([]);
    expect(existsSync(manifestPath(deps, 'web', k.configPath))).toBe(false);
    expect(onBeads(loadKshetraConfig(k.configPath), k.configPath)).toBe(k.beads);
  });

  it('refuses --undo after the first write to the new store', async () => {
    const { shreni, k, deps } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    const id = loadKshetraConfig(k.configPath).project!;
    await shreni.tg.project(id).as({ id: 'ann', role: 'developer' }).tasks.create({ title: 'new work' });
    await expect(migrateKshetra('web', deps, { undo: true })).rejects.toThrow(/has changed since the import .* no way back into beads/);
    expect(await shreni.tg.projects.list()).toHaveLength(1);
  });

  it('a run stopped before the import leaves nothing in the database, and a rerun imports under the same id', async () => {
    const { shreni, k, deps } = await setup();
    await expect(migrateKshetra('web', { ...deps, dump: async () => { throw new Error('pg_dump: not found'); } }, { yes: true }))
      .rejects.toThrow(/pg_dump: not found/);
    expect(await shreni.tg.projects.list()).toEqual([]);
    const planned = JSON.parse(readFileSync(manifestPath(deps, 'web', k.configPath), 'utf8')).projectId;
    await migrateKshetra('web', deps, { yes: true });
    expect(loadKshetraConfig(k.configPath).project).toBe(planned);
  });

  it('never imports again a Kshetra whose config names a project, manifest or not', async () => {
    const { shreni, k, deps, out } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    rmSync(manifestPath(deps, 'web', k.configPath));
    out.length = 0;
    await migrateKshetra('web', { ...deps, kshetras: () => [loadKshetraConfig(k.configPath)] }, { yes: true });
    expect(out).toEqual(['web is already on the engine; nothing to do']);
    expect(await shreni.tg.projects.list()).toHaveLength(1);
  });

  it('keeps one manifest per repo, so another repo of the same name migrates on its own', async () => {
    const { shreni, k, deps } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    const other = fixtureKshetra();
    await migrateKshetra('web', { ...deps, kshetras: () => [loadKshetraConfig(other.configPath)], configPath: () => other.configPath }, { yes: true });
    expect(await shreni.tg.projects.list()).toHaveLength(2);
    expect(loadKshetraConfig(other.configPath).project).not.toBe(loadKshetraConfig(k.configPath).project);
  });

  it('refuses --undo once a memory was written, though memories write no event', async () => {
    const { shreni, k, deps } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    const id = loadKshetraConfig(k.configPath).project!;
    await shreni.transaction(db => db.insertInto('shreni.memories').values({ project_id: id, key: 'new', content: 'learned on the engine' }).execute());
    await expect(migrateKshetra('web', deps, { undo: true })).rejects.toThrow(/has changed since the import/);
  });

  it('leaves a real .beads directory, and its ignore line, alone', async () => {
    const { k, deps } = await setup();
    rmSync(join(k.repo, '.beads'));
    mkdirSync(join(k.repo, '.beads'));
    await migrateKshetra('web', deps, { yes: true });
    expect(existsSync(join(k.repo, '.beads'))).toBe(true);
    expect(readFileSync(join(k.repo, '.gitignore'), 'utf8')).toContain('.beads\n');
  });

  it('a run that stopped right after the import commits can still be undone', async () => {
    const { shreni, k, deps } = await setup();
    await migrateKshetra('web', deps, { yes: true });
    const file = manifestPath(deps, 'web', k.configPath);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), importedThrough: null, importedRows: null }));
    writeFileSync(k.configPath, readFileSync(k.configPath, 'utf8').replace(/^project:.*\n/m, ''));
    await migrateKshetra('web', deps, { yes: true });
    await migrateKshetra('web', deps, { undo: true });
    expect(await shreni.tg.projects.list()).toEqual([]);
  });

  it('asks after the dry run, refuses without a terminal or --yes, and needs no worker and no pending migration', async () => {
    const { shreni, k, deps, out } = await setup();
    const before = snapshot(k.repo);
    await expect(migrateKshetra('web', deps)).rejects.toThrow(/needs a confirmation; run it in a terminal, or pass --yes/);
    const asked: string[] = [];
    await expect(migrateKshetra('web', { ...deps, interactive: () => true, ask: async q => { asked.push(q); return 'n'; } }))
      .rejects.toThrow(/web wasn't migrated/);
    expect(asked).toEqual(['Import 457 tasks into the database and move web off beads? [y/N] ']);
    expect(out).toContain('✓ the dry run checks pass');
    expect(snapshot(k.repo)).toEqual(before);
    expect(await shreni.tg.projects.list()).toEqual([]);

    await expect(migrateKshetra('web', { ...deps, workerRunning: () => true })).rejects.toThrow(/has a worker running; shreni stop --kshetra web first/);
    await expect(migrateKshetra('nope', deps)).rejects.toThrow(/Kshetra not found: nope/);
  });

  it('reads the legacy beads.path straight from the YAML, and the committed export, never running bd', async () => {
    const { k, deps, out } = await setup();
    const config = loadKshetraConfig(k.configPath);
    // The schema strips beads:, so the path comes from the file.
    expect((config as Record<string, unknown>).beads).toBeUndefined();
    expect(kshetraTarget(config, k.configPath).beadsDir).toBe(k.beads);
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      await migrateKshetra('web', deps, { yes: true });
    } finally {
      process.env.PATH = path;
    }
    const issues = join(k.beads, 'issues.jsonl');
    expect(out).toContain(`reading the committed ${issues}; if bd is installed, run \`bd export -o ${issues}\` first for the latest`);
    expect(loadKshetraConfig(k.configPath).project).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('without a beads.path in the config, looks behind the repo\'s .beads link', () => {
    const k = fixtureKshetra();
    writeFileSync(k.configPath, readFileSync(k.configPath, 'utf8').replace(/^beads:.*\n/m, ''));
    expect(kshetraTarget(loadKshetraConfig(k.configPath), k.configPath).beadsDir).toBe(join(k.repo, '.beads'));
    // start's check looks where migrate does: behind the .beads link when the config names no path.
    expect(onBeads(loadKshetraConfig(k.configPath), k.configPath)).toBe(join(k.repo, '.beads'));
  });

  it('runs as the command line gives it: shreni migrate <kshetra> --yes', async () => {
    const { k, deps } = await setup();
    const { runMigrateCommand } = await import('./migrate');
    const { makeContext } = await import('./registry');
    await runMigrateCommand(makeContext(['web', '--yes']), deps);
    expect(loadKshetraConfig(k.configPath).project).toMatch(/^[0-9a-f-]{36}$/);
    await expect(runMigrateCommand(makeContext([]), deps)).rejects.toThrow(/Usage: shreni migrate/);
  });

  it('onBeads: the beads dir only with no project and an issues.jsonl at the legacy path', () => {
    const k = fixtureKshetra();
    expect(onBeads({}, k.configPath)).toBe(k.beads);
    expect(onBeads({ project: 'p' }, k.configPath)).toBeUndefined();
    rmSync(join(k.beads, 'issues.jsonl'));
    expect(onBeads({}, k.configPath)).toBeUndefined();
    expect(onBeads({}, join(k.root, 'missing.yaml'))).toBeUndefined();
  });
});
