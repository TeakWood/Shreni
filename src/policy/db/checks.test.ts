import { describe, it, expect, vi } from 'vitest';
// The machine's own ~/.shreni/config.yaml stays out of it.
vi.mock('../../kshetra/user-config', async orig => ({
  ...(await orig<typeof import('../../kshetra/user-config')>()), loadUserConfig: () => ({ databases: {} }),
}));

import { checkDatabase, describeTarget, installAdvice, type Connected, type DbProbe, type Install } from './checks';
import { newestFormula, pgDumpVersion, runDb } from '../../cli/db';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makeContext } from '../../cli/registry';

// Database checks (policy spec, "The database"): the six cases init's Database
// phase and shreni db check find, each with what it tells the developer.

const LOCAL = { name: 'local', url: 'postgres://localhost:5432/shreni' };
const REFUSED: Connected = { ok: false, code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' };
const v = (major: number): Connected => ({ ok: true, serverVersionNum: major * 10_000 + 2 });

function probe(over: Partial<DbProbe> & { answers?: Connected[] } = {}): DbProbe & { ran: string[] } {
  const answers = [...(over.answers ?? [v(17)])];
  const ran: string[] = [];
  return {
    platform: 'darwin',
    connect: vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0])),
    createDatabase: vi.fn(async () => {}),
    installed: async () => null as Install | null,
    pgDumpMajor: async () => 17,
    run: async (c: string) => { ran.push(c); return 0; },
    osUser: () => 'dev',
    ...over,
    ran,
  };
}

const opts = (o: Partial<{ interactive: boolean; answer: string; create: boolean }> = {}) => ({
  interactive: o.interactive ?? false, ask: async () => o.answer ?? 'n', create: o.create ?? false,
});
const text = (r: { lines: { text: string }[] }) => r.lines.map(l => l.text).join('\n');

describe('shreni db check', () => {
  it('given a Mac with no Postgres, when shreni db check runs, then it exits non-zero and prints brew install postgresql@17 and the start command', async () => {
    const out: string[] = [];
    await expect(runDb(makeContext(['check']), {
      cwd: '/', env: { SHRENI_DATABASE_URL: LOCAL.url }, probe: probe({ answers: [REFUSED] }),
      interactive: () => false, ask: async () => '', print: l => out.push(l),
    })).rejects.toThrow(/database check failed/);
    const printed = out.join('\n');
    expect(printed).toContain('brew install postgresql@17');
    expect(printed).toContain('brew services start postgresql@17');
  });

  it('given a server older than 15, then it stops and says so', async () => {
    const r = await checkDatabase(LOCAL, probe({ answers: [v(14)] }), opts());
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/Postgres 14 .* is older than 15/);
    expect(r.serverMajor).toBe(14);
  });

  it('a server older than 15 is reported even when the database is missing', async () => {
    const p = probe({ answers: [{ ok: false, code: '3D000', message: 'database "shreni" does not exist' }, v(13)] });
    const r = await checkDatabase(LOCAL, p, opts({ create: true }));
    expect(text(r)).toMatch(/Postgres 13 .* older than 15/);
    expect(p.createDatabase).not.toHaveBeenCalled();
  });

  it('installed but stopped: prints the start command, and runs it on yes when it needs no sudo', async () => {
    const p = probe({ answers: [REFUSED, v(17)], installed: async () => ({ via: 'homebrew', formula: 'postgresql@17' }) });
    const r = await checkDatabase(LOCAL, p, opts({ interactive: true, answer: 'y' }));
    expect(p.ran).toEqual(['brew services start postgresql@17']);
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/Started Postgres/);
  });

  it('installed but stopped: never offers, and never runs, a start that needs sudo, or without a terminal', async () => {
    const linux = probe({ platform: 'linux', answers: [REFUSED], installed: async () => ({ via: 'package' }) });
    const r = await checkDatabase(LOCAL, linux, opts({ interactive: true, answer: 'y' }));
    expect(r.ok).toBe(false);
    expect(text(r)).toContain('sudo systemctl start postgresql');
    expect(linux.ran).toEqual([]);
    const mac = probe({ answers: [REFUSED], installed: async () => ({ via: 'postgres.app' }) });
    expect(text(await checkDatabase(LOCAL, mac, opts()))).toContain('open -a Postgres');
    expect(mac.ran).toEqual([]);
  });

  it('a login failure names the user tried and the fix', async () => {
    const role = probe({ answers: [{ ok: false, code: '28000', message: 'role "dev" does not exist' }] });
    const r = await checkDatabase(LOCAL, role, opts());
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/refused the login as "dev"/);
    expect(text(r)).toMatch(/createuser -h localhost -p 5432 -U postgres -s dev[\s\S]*sudo -u postgres createuser -s dev/);
    const password = probe({ answers: [{ ok: false, code: '28P01', message: 'password authentication failed for user "app"' }] });
    const named = { ...LOCAL, user: 'app' };
    expect(text(await checkDatabase(named, password, opts()))).toMatch(/as "app"[\s\S]*passwordEnv/);
  });

  it('a missing database is created when asked, or the command is printed', async () => {
    const missing: Connected = { ok: false, code: '3D000', message: 'database "shreni" does not exist' };
    const created = probe({ answers: [missing, v(17), v(17)] });
    const r = await checkDatabase(LOCAL, created, opts({ create: true }));
    expect(created.createDatabase).toHaveBeenCalledWith(LOCAL, 'shreni');
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/Created the database "shreni"/);

    const checkOnly = await checkDatabase(LOCAL, probe({ answers: [missing, v(17)] }), opts());
    expect(checkOnly.ok).toBe(false);
    expect(text(checkOnly)).toMatch(/createdb -h localhost -p 5432 -U dev shreni/);

    const denied = probe({
      answers: [missing, v(17)],
      createDatabase: async () => { throw Object.assign(new Error('permission denied to create database'), { code: '42501' }); },
    });
    expect(text(await checkDatabase(LOCAL, denied, opts({ create: true })))).toMatch(/may not create databases.*createdb -h localhost -p 5432 -O dev shreni/);
  });

  it('pg_dump missing or older than the server warns, and blocks only the dump-first commands', async () => {
    const none = await checkDatabase(LOCAL, probe({ pgDumpMajor: async () => null }), opts());
    expect(none.ok).toBe(true);
    expect(none.dumpBlocked).toBe(true);
    expect(none.lines.find(l => l.severity === 'warn')?.text).toMatch(/pg_dump is missing/);
    const old = await checkDatabase(LOCAL, probe({ pgDumpMajor: async () => 16 }), opts());
    expect(old.ok).toBe(true);
    expect(text(old)).toMatch(/pg_dump 16 is older than the server \(17\)/);
    const fine = await checkDatabase(LOCAL, probe(), opts());
    expect(fine.dumpBlocked).toBe(false);
  });

  it('a remote server that doesn\'t answer gets no install advice', async () => {
    const r = await checkDatabase({ name: 'acme', url: 'postgres://db.acme.internal:5432/shreni' }, probe({ answers: [REFUSED] }), opts());
    expect(text(r)).toMatch(/No Postgres answers at db\.acme\.internal:5432/);
    expect(text(r)).not.toMatch(/brew/);
  });

  it('names the platform\'s install commands', () => {
    expect(installAdvice('linux').join('\n')).toMatch(/apt install postgresql[\s\S]*systemctl start postgresql/);
    expect(installAdvice('win32').join('\n')).toMatch(/EDB installer[\s\S]*net start postgresql-x64-17/);
  });

  it('reads the database and user a url names', () => {
    expect(describeTarget({ name: 'x', url: 'postgres://ann@db:6543/work' }, 'dev')).toMatchObject({ host: 'db', port: '6543', database: 'work', user: 'ann', local: false });
    expect(describeTarget({ name: 'x', url: 'postgres://localhost' }, 'dev')).toMatchObject({ database: 'dev', user: 'dev', local: true });
  });

  it('says how to name the database when the user config lacks it', async () => {
    await expect(runDb(makeContext(['check']), {
      cwd: '/', env: {}, probe: probe(), interactive: () => false, ask: async () => '', print: () => {},
    })).rejects.toThrow(/databases:\n\s+local: \{ url: postgres:\/\/localhost:5432\/shreni \}/);
  });

  it('waits for a just-started server: refused and starting-up answers are tried again', async () => {
    const starting: Connected = { ok: false, code: '57P03', message: 'the database system is starting up' };
    const p = probe({ answers: [REFUSED, REFUSED, starting, v(17)], installed: async () => ({ via: 'homebrew', formula: 'postgresql@17' }) });
    const slept: number[] = [];
    const r = await checkDatabase(LOCAL, p, { ...opts({ interactive: true, answer: 'y' }), sleep: async ms => { slept.push(ms); } });
    expect(r.ok).toBe(true);
    expect(slept.length).toBe(2);
  });

  it('gives up on a started server that never answers', async () => {
    const p = probe({ answers: [REFUSED], installed: async () => ({ via: 'docker' }) });
    const r = await checkDatabase(LOCAL, p, { ...opts({ interactive: true, answer: 'y' }), sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/nothing answers at localhost:5432 after 15s/);
  });

  it('says what it found before it asks', async () => {
    const seen: string[] = [];
    const p = probe({ answers: [REFUSED, v(17)], installed: async () => ({ via: 'postgres.app' }) });
    await checkDatabase(LOCAL, p, {
      interactive: true, create: false, sleep: async () => {},
      onLine: l => seen.push(l.text), ask: async q => { seen.push(`ASK ${q}`); return 'y'; },
    });
    expect(seen.findIndex(x => x.includes('open -a Postgres'))).toBeLessThan(seen.findIndex(x => x.startsWith('ASK')));
  });

  it('tells a pg_hba refusal from a bad password, and points CI at its url', async () => {
    const hba = probe({ answers: [{ ok: false, code: '28000', message: 'no pg_hba.conf entry for host "10.0.0.5"' }] });
    expect(text(await checkDatabase(LOCAL, hba, opts()))).toMatch(/pg_hba\.conf/);
    const ci = probe({ answers: [{ ok: false, code: '28P01', message: 'password authentication failed' }] });
    const fromEnv = { name: 'SHRENI_DATABASE_URL', url: 'postgres://ci:x@localhost/shreni' };
    const out = text(await checkDatabase(fromEnv, ci, opts()));
    expect(out).toMatch(/in SHRENI_DATABASE_URL/);
    expect(out).not.toMatch(/config\.yaml/);
  });

  it('names the failure\'s code when Node gave no message, and refuses a malformed url', async () => {
    const remote = { name: 'acme', url: 'postgres://db.acme.internal/shreni' };
    expect(text(await checkDatabase(remote, probe({ answers: [{ ok: false, code: 'ECONNREFUSED', message: '' }] }), opts())))
      .toMatch(/\(database "acme"\): ECONNREFUSED\./);
    const bad = await checkDatabase({ name: 'local', url: 'postgres://u:p@ss@h:x/db' }, probe(), opts());
    expect(bad.ok).toBe(false);
    expect(text(bad)).toMatch(/isn't a valid postgres:\/\/ url/);
  });

  it('reads the server version through template1 when the postgres database was dropped', async () => {
    const missing: Connected = { ok: false, code: '3D000', message: 'database does not exist' };
    const p = probe({ answers: [missing, missing, v(14)] });
    const r = await checkDatabase(LOCAL, p, opts({ create: true }));
    expect(p.connect).toHaveBeenCalledWith(LOCAL, 'template1');
    expect(text(r)).toMatch(/Postgres 14/);
  });

  it('honours PGUSER and PGDATABASE as postgres.js does', () => {
    expect(describeTarget({ name: 'x', url: 'postgres://localhost' }, 'dev', { PGUSER: 'ann', PGDATABASE: 'work' }))
      .toMatchObject({ user: 'ann', database: 'work' });
    expect(describeTarget({ name: 'x', url: 'postgres://%2Ftmp/x' }, 'dev')).toMatchObject({ host: '/tmp', local: true });
  });

  it('checks the database a repo names, even before init has given it a project', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'shreni-db-repo-'));
    mkdirSync(join(repo, '.shreni'));
    writeFileSync(join(repo, '.shreni', 'tracker.yaml'), 'name: web\ndatabase: acme\n');
    await expect(runDb(makeContext(['check']), {
      cwd: repo, env: {}, probe: probe(), interactive: () => false, ask: async () => '', print: () => {},
    })).rejects.toThrow(/uses database "acme"[\s\S]*acme: \{ url/);
    // A broken config is reported, not passed over for the local database.
    writeFileSync(join(repo, '.shreni', 'tracker.yaml'), 'name: web\nrepo: {}\n');
    await expect(runDb(makeContext(['check']), {
      cwd: repo, env: {}, probe: probe(), interactive: () => false, ask: async () => '', print: () => {},
    })).rejects.toThrow(/repo is not a tracker setting/);
  });

  it('refuses a flag it doesn\'t take', async () => {
    await expect(runDb(makeContext(['check', '--creat']), {
      cwd: '/', env: { SHRENI_DATABASE_URL: LOCAL.url }, probe: probe(), interactive: () => false, ask: async () => '', print: () => {},
    })).rejects.toThrow(/takes no --creat/);
  });

  it('picks the newest Homebrew formula by version, and reads pg_dump\'s version', () => {
    expect(newestFormula(['postgresql@9', 'postgresql@17', 'redis'])).toBe('postgresql@17');
    expect(newestFormula(['postgresql@16', 'postgresql'])).toBe('postgresql');
    expect(pgDumpVersion('pg_dump (PostgreSQL) 17.2 (Homebrew)')).toBe(17);
    expect(pgDumpVersion('nothing')).toBeNull();
  });
});
