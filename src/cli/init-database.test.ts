import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initEngine } from './init';
import { loadUserConfig } from '../kshetra/user-config';
import type { DbProbe } from '../policy/db/checks';
import type { DatabaseTarget } from '../kshetra/user-config';

// The Database phase when the machine's ~/.shreni/config.yaml doesn't name the
// repo's database (policy spec, "The database": init asks for that entry if the
// machine lacks it).

/** A probe that records the target it was given, then stops the check there. */
function probe() {
  const seen: DatabaseTarget[] = [];
  const p: DbProbe = {
    platform: 'darwin',
    connect: async t => { seen.push(t); throw new Error('stopped after the lookup'); },
    createDatabase: async () => {},
    installed: async () => ({ via: 'homebrew', formula: 'postgresql@17' }),
    pgDumpMajor: async () => 17,
    run: async () => 0,
    osUser: () => 'ann',
  };
  return { p, seen };
}

function engine(o: { interactive: boolean; answers?: string[]; configPath: string; env?: NodeJS.ProcessEnv }) {
  const { p, seen } = probe();
  const out: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const e = initEngine(
    {
      interactive: () => o.interactive,
      ask: async q => { asked.push(q); if (!answers.length) throw new Error(`not expected: ${q}`); return answers.shift()!; },
      print: l => out.push(l),
    },
    { name: 'notes', mode: 'tracker' },
    {
      probe: p, open: async () => { throw new Error('not opened'); }, env: o.env ?? {},
      dump: async () => '', manifestsDir: '', userConfigPath: o.configPath,
    },
  );
  return { e, seen, out, asked };
}

const home = () => join(mkdtempSync(join(tmpdir(), 'shreni-init-db-')), '.shreni', 'config.yaml');

describe('the Database phase adds a missing database entry', () => {
  it('(a) asks for the url at a terminal, defaulting to localhost for local, writes it and goes on to the checks', async () => {
    const configPath = home();
    const { e, seen, asked, out } = engine({ interactive: true, answers: [''], configPath });
    await expect(e.database('local')).rejects.not.toThrow(/doesn't name/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/"local".*\[postgres:\/\/localhost:5432\/shreni\]/);
    expect(loadUserConfig(configPath, { gitEmail: () => undefined }).databases).toEqual({ local: { url: 'postgres://localhost:5432/shreni' } });
    expect(seen[0]).toMatchObject({ name: 'local', url: 'postgres://localhost:5432/shreni' });
    expect(out.join('\n')).toMatch(/added database "local"/);
  });

  it('(a) takes the url the developer types', async () => {
    const configPath = home();
    const { e, seen } = engine({ interactive: true, answers: ['postgres://db.local:6543/tasks'], configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(seen[0]).toMatchObject({ url: 'postgres://db.local:6543/tasks' });
  });

  it('(b) without a terminal, local gets the default and says so', async () => {
    const configPath = home();
    const { e, seen, out } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(seen[0]).toMatchObject({ url: 'postgres://localhost:5432/shreni' });
    expect(out.join('\n')).toMatch(/added database "local" \(postgres:\/\/localhost:5432\/shreni\)/);
  });

  it('(b) without a terminal, any other name fails naming the entry to add, and writes nothing', async () => {
    const configPath = home();
    const { e, seen } = engine({ interactive: false, configPath });
    await expect(e.database('acme')).rejects.toThrow(/database "acme".*config\.yaml.*databases/);
    expect(seen).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });

  it('(b) at a terminal, another name has no default: an empty answer writes nothing', async () => {
    const configPath = home();
    const { e } = engine({ interactive: true, answers: [''], configPath });
    await expect(e.database('acme')).rejects.toThrow(/database "acme"/);
    expect(existsSync(configPath)).toBe(false);
  });

  it('(c) refuses a url with a password, pointing at passwordEnv', async () => {
    const configPath = home();
    const { e } = engine({ interactive: true, answers: ['postgres://ann:secret@localhost/shreni'], configPath });
    await expect(e.database('local')).rejects.toThrow(/password.*passwordEnv/);
    expect(existsSync(configPath)).toBe(false);
  });

  it('(c) refuses a url that is not postgres://', async () => {
    const configPath = home();
    const { e } = engine({ interactive: true, answers: ['mysql://localhost/x'], configPath });
    await expect(e.database('local')).rejects.toThrow(/postgres:\/\//);
    expect(existsSync(configPath)).toBe(false);
  });

  it('(d) keeps the other entries, the user and the comments of an existing config', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    const before = '# my machine\nuser: ann@example.com\ndatabases:\n  # the company one\n  acme: { url: postgres://db.acme.internal/shreni, passwordEnv: ACME_PW }\n';
    writeFileSync(configPath, before);
    const { e } = engine({ interactive: true, answers: [''], configPath });
    await expect(e.database('local')).rejects.toThrow();
    const after = readFileSync(configPath, 'utf8');
    // Every line written before is still there, in its order; only the entry is new.
    expect(after.split('\n').filter(l => !l.includes('"local"'))).toEqual(before.split('\n'));
    expect(loadUserConfig(configPath)).toEqual({
      user: 'ann@example.com',
      databases: {
        acme: { url: 'postgres://db.acme.internal/shreni', passwordEnv: 'ACME_PW' },
        local: { url: 'postgres://localhost:5432/shreni' },
      },
    });
  });

  it('(d) adds a databases section to a config that has none', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, 'user: ann@example.com # me\n');
    const { e } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(readFileSync(configPath, 'utf8')).toContain('user: ann@example.com # me');
    expect(loadUserConfig(configPath).databases).toEqual({ local: { url: 'postgres://localhost:5432/shreni' } });
  });

  it('(d) a flow-style databases map still gets the entry', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, 'databases: {}\n');
    const { e } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(loadUserConfig(configPath, { gitEmail: () => undefined }).databases).toEqual({ local: { url: 'postgres://localhost:5432/shreni' } });
  });

  it('(d) a quoted databases key gets the entry, not a second section', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, '"databases":\n  acme: { url: postgres://db.acme.internal/shreni }\n');
    const { e } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow('stopped after the lookup');
    expect(Object.keys(loadUserConfig(configPath, { gitEmail: () => undefined }).databases)).toEqual(['local', 'acme']);
  });

  it('(d) says so when the file had to be rewritten, dropping its comments', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, '# keep\ndatabases: { acme: { url: postgres://db.acme.internal/shreni } }\n');
    const { e, out } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow('stopped after the lookup');
    expect(out.join('\n')).toMatch(/rewritten to add it, and its comments were dropped/);
    expect(Object.keys(loadUserConfig(configPath, { gitEmail: () => undefined }).databases).sort()).toEqual(['acme', 'local']);
  });

  it('(e) with SHRENI_DATABASE_URL set, nothing is asked or written', async () => {
    const configPath = home();
    const { e, seen, asked } = engine({ interactive: true, configPath, env: { SHRENI_DATABASE_URL: 'postgres://ci/shreni' } });
    await expect(e.database('local')).rejects.toThrow();
    expect(asked).toEqual([]);
    expect(seen[0]).toMatchObject({ name: 'SHRENI_DATABASE_URL', url: 'postgres://ci/shreni' });
    expect(existsSync(configPath)).toBe(false);
  });

  it('(e) an entry already there is used as it is', async () => {
    const configPath = home();
    const { mkdirSync } = await import('fs');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, 'databases:\n  local: { url: postgres://elsewhere/shreni }\n');
    const { e, seen, asked } = engine({ interactive: true, configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(asked).toEqual([]);
    expect(seen[0]).toMatchObject({ url: 'postgres://elsewhere/shreni' });
  });

  it.skipIf(process.platform === 'win32')('(f) a new file is readable by its owner only', async () => {
    const configPath = home();
    const { e } = engine({ interactive: false, configPath });
    await expect(e.database('local')).rejects.toThrow();
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
