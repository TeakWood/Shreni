import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { hostname, tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from './client';
import { taskLifecycle } from '../lifecycle/lifecycle';
import {
  connection, dailyDue, dailyFailure, dumpName, dumping, dumpSchemas, KEEP_DAILY, listDumps, lockPath, parseDumpName, pruneDumps,
  RETRY_MS, STALE_LOCK_MS, startDailyIfDue, takeDump, type DumpTools,
} from './backups';
import type { KshetraConfig } from '../../kshetra/config';

// Backups and schema migrations (policy spec, "Backups" and "Schema
// migrations in practice").

vi.mock('../../kshetra/user-config', async orig => ({
  ...(await orig<typeof import('../../kshetra/user-config')>()),
  loadUserConfig: () => ({ databases: { local: { url: 'postgres://localhost:5432/shreni' } } }),
}));
const { dailyDumpHook, ensureMigrated, migrateDatabase, runDb } = await import('../../cli/db');
const { makeContext } = await import('../../cli/registry');

const LOCAL = { name: 'local', url: 'postgres://localhost:5432/shreni' };
const NOW = new Date('2026-10-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const dir = () => mkdtempSync(join(tmpdir(), 'shreni-backups-'));
const touch = (d: string, name: string) => writeFileSync(join(d, name), 'x');
/** A lock as a dump writes it. */
const lock = (d: string, over: object = {}) =>
  writeFileSync(lockPath(d, 'local'), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), ...over }));

/** pg_dump and pg_restore stand-ins that write and record. */
function tools(): DumpTools & { dumped: string[]; restored: string[] } {
  const dumped: string[] = [];
  const restored: string[] = [];
  return {
    dumped, restored,
    async dump(_t, file) { dumped.push(file); writeFileSync(file, 'dump'); },
    async restore(_t, file) { restored.push(file); },
  };
}

describe('dumps', () => {
  it('given the newest dump 25 hours old, when any shreni command runs, then a dump starts in the background', () => {
    const d = dir();
    touch(d, dumpName('local', 'daily', hoursAgo(25)));
    const start = vi.fn();
    expect(dailyDumpHook({ cwd: '/', env: { SHRENI_DATABASE_URL: LOCAL.url }, dir: d, now: NOW, start })).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts none while the newest dump is under a day old, for a remote database, or while one is running', () => {
    const d = dir();
    touch(d, dumpName('local', 'pre-migrate', hoursAgo(23)));
    const start = vi.fn();
    expect(startDailyIfDue(LOCAL, start, { dir: d, now: NOW })).toBe(false);
    expect(startDailyIfDue({ name: 'acme', url: 'postgres://db.acme.internal/shreni' }, start, { dir: d, now: NOW })).toBe(false);
    const e = dir();
    lock(e);
    expect(dumping(e, 'local')).toBe(true);
    expect(startDailyIfDue(LOCAL, start, { dir: e, now: NOW })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('names dumps by database, time and kind, and reads them back', () => {
    const name = dumpName('my db', 'pre-upgrade', NOW);
    expect(name).toBe('my_db-20261009T120000Z-pre-upgrade.dump');
    expect(parseDumpName(name)).toMatchObject({ database: 'my_db', kind: 'pre-upgrade', at: NOW });
    expect(parseDumpName('notes.txt')).toBeNull();
    expect(dailyDue(dir(), 'local', NOW)).toBe(true);
  });

  it('keeps the last 14 daily dumps and every dump taken before a change', () => {
    const d = dir();
    for (let i = 0; i < KEEP_DAILY + 3; i++) touch(d, dumpName('local', 'daily', hoursAgo(24 * i)));
    touch(d, dumpName('local', 'pre-import', hoursAgo(24 * 40)));
    touch(d, dumpName('other', 'daily', hoursAgo(24 * 90)));
    expect(pruneDumps(d, 'local')).toHaveLength(3);
    expect(listDumps(d, 'local').filter(x => x.kind === 'daily')).toHaveLength(KEEP_DAILY);
    expect(listDumps(d, 'local').some(x => x.kind === 'pre-import')).toBe(true);
    expect(listDumps(d, 'other')).toHaveLength(1);
  });

  it('writes a dump whole, under a temporary name, then prunes the dailies', async () => {
    const d = dir();
    const t = tools();
    const file = await takeDump(LOCAL, 'daily', t, { dir: d, now: NOW });
    expect(file).toBe(join(d, dumpName('local', 'daily', NOW)));
    expect(t.dumped).toEqual([`${file}.partial`]);
    expect(readdirSync(d)).toEqual([dumpName('local', 'daily', NOW)]);
  });

  it('leaves nothing behind when pg_dump fails', async () => {
    const d = dir();
    const failing: DumpTools = {
      async dump(_t, file) { writeFileSync(file, 'half'); throw new Error('pg_dump failed: disk full'); },
      async restore() {},
    };
    await expect(takeDump(LOCAL, 'manual', failing, { dir: d, now: NOW })).rejects.toThrow(/disk full/);
    expect(readdirSync(d)).toEqual([]);
  });

  it('refuses a database on another machine unless --remote', async () => {
    const remote = { name: 'acme', url: 'postgres://db.acme.internal:5432/shreni' };
    await expect(takeDump(remote, 'manual', tools(), { dir: dir() })).rejects.toThrow(/isn't on this machine.*--remote/);
    expect(await takeDump(remote, 'manual', tools(), { dir: dir(), remote: true })).toMatch(/acme-.*-manual\.dump$/);
  });

  it('runs one dump at a time: the daily one skips while another runs', async () => {
    const d = dir();
    lock(d);
    expect(await takeDump(LOCAL, 'daily', tools(), { dir: d, ifIdle: true })).toBeNull();
    await expect(takeDump(LOCAL, 'manual', tools(), { dir: d })).rejects.toThrow(/another process is dumping database "local" \(lock .*\.local\.dumping\)/);
    // A lock its process left behind is taken over.
    lock(d, { pid: 999999 });
    expect(await takeDump(LOCAL, 'manual', tools(), { dir: d })).toMatch(/manual\.dump$/);
    expect(existsSync(lockPath(d, 'local'))).toBe(false);
  });

  it('takes over a lock older than a dump runs, whatever its pid now names, and one from before locks held a time', async () => {
    const d = dir();
    lock(d, { at: Date.now() - STALE_LOCK_MS });
    expect(dumping(d, 'local')).toBe(false);
    lock(d, { host: 'another-machine' });
    expect(dumping(d, 'local')).toBe(true);
    writeFileSync(lockPath(d, 'local'), String(process.pid));
    expect(await takeDump(LOCAL, 'manual', tools(), { dir: d })).toMatch(/manual\.dump$/);
  });

  it('a dump before a change waits for one already running', async () => {
    const d = dir();
    lock(d);
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); if (waits.length === 3) rmSync(lockPath(d, 'local')); };
    expect(await takeDump(LOCAL, 'pre-migrate', tools(), { dir: d, wait: 60_000, sleep })).toMatch(/pre-migrate\.dump$/);
    expect(waits).toHaveLength(3);
  });

  it('removes what a killed dump left half written, for that database only', async () => {
    const d = dir();
    touch(d, `${dumpName('local', 'daily', hoursAgo(30))}.partial`);
    touch(d, `${dumpName('other', 'daily', hoursAgo(30))}.partial`);
    await takeDump(LOCAL, 'manual', tools(), { dir: d, now: NOW });
    expect(readdirSync(d).sort()).toEqual([`${dumpName('other', 'daily', hoursAgo(30))}.partial`, dumpName('local', 'manual', NOW)].sort());
  });

  it('a failed daily dump is said, and retried only after a wait, until one succeeds', async () => {
    const d = dir();
    const failing: DumpTools = { async dump() { throw new Error('pg_dump: command not found'); }, async restore() {} };
    await expect(takeDump(LOCAL, 'daily', failing, { dir: d, now: NOW })).rejects.toThrow(/not found/);
    expect(dailyFailure(d, 'local')).toEqual({ at: NOW, error: 'pg_dump: command not found' });
    const start = vi.fn();
    expect(startDailyIfDue(LOCAL, start, { dir: d, now: new Date(NOW.getTime() + RETRY_MS - 1) })).toBe(false);
    const warned: string[] = [];
    expect(dailyDumpHook({ cwd: '/', env: {}, dir: d, now: new Date(NOW.getTime() + RETRY_MS), start, warn: l => warned.push(l) })).toBe(true);
    expect(warned).toEqual([`shreni: the daily dump of database "local" failed at ${NOW.toISOString()}: pg_dump: command not found; shreni db dump tries again`]);
    await takeDump(LOCAL, 'manual', tools(), { dir: d, now: NOW });
    expect(dailyFailure(d, 'local')).toBeNull();
  });

  it('a daily dump that fails before pg_dump is recorded too, and the error is kept when even the record fails', async () => {
    const d = dir();
    // The lock of a run that never ends, on another machine: the daily dump skips, others refuse.
    lock(d, { host: 'another-machine' });
    await expect(takeDump(LOCAL, 'daily', tools(), { dir: d, now: NOW, ifIdle: false })).rejects.toThrow(/another process is dumping/);
    expect(dailyFailure(d, 'local')?.error).toMatch(/another process is dumping/);
    const file = join(dir(), 'not-a-dir');
    touch(file.replace(/not-a-dir$/, ''), 'not-a-dir');
    await expect(takeDump(LOCAL, 'daily', tools(), { dir: file, now: NOW })).rejects.toThrow(/EEXIST|ENOTDIR/);
  });

  it('keeps the password out of the client tools\' arguments', () => {
    expect(connection({ name: 'local', url: 'postgres://shreni:s%3Fcret@localhost:5432/shreni' }))
      .toEqual({ url: 'postgres://shreni@localhost:5432/shreni', env: { PGPASSWORD: 's?cret' } });
    expect(connection({ name: 'local', url: 'postgres://localhost/shreni', user: 'ann', password: 'pw' }))
      .toEqual({ url: 'postgres://localhost/shreni', env: { PGUSER: 'ann', PGPASSWORD: 'pw' } });
  });

  it('reads the schemas a dump creates from its table of contents', () => {
    const toc = [
      ';', '; Archive created at 2026-10-09', '5; 2615 16385 SCHEMA - taskgraph postgres', '6; 2615 16386 SCHEMA - shreni postgres',
      '7; 2615 2200 SCHEMA - public pg_database_owner', '220; 1259 16390 TABLE taskgraph tasks postgres',
    ].join('\n');
    expect(dumpSchemas(toc)).toEqual(['taskgraph', 'shreni']);
  });
});

describe('shreni db restore', () => {
  const deps = (over: object = {}) => ({
    cwd: '/', env: { SHRENI_DATABASE_URL: LOCAL.url }, print: () => {}, tools: tools(), otherSessions: async () => [] as string[], ...over,
  });

  it('needs --yes, and every other session gone', async () => {
    const d = dir();
    touch(d, 'x.dump');
    const file = join(d, 'x.dump');
    await expect(runDb(makeContext(['restore', file]), deps())).rejects.toThrow(/Pass --yes/);
    await expect(runDb(makeContext(['restore', file, '--yes']), deps({ otherSessions: async () => ['my-laptop/4821', 'shreni-phalaka'] })))
      .rejects.toThrow(/other sessions \(my-laptop\/4821, shreni-phalaka\); stop every worker/);
    const t = tools();
    await runDb(makeContext(['restore', file, '--yes']), deps({ tools: t }));
    expect(t.restored).toEqual([file]);
  });

  it('refuses a database on another machine unless --remote, and another database\'s dump unless --other-database', async () => {
    const d = dir();
    const file = join(d, dumpName('acme', 'daily', NOW));
    touch(d, dumpName('acme', 'daily', NOW));
    const remote = { env: { SHRENI_DATABASE_URL: 'postgres://db.acme.internal/shreni' } };
    await expect(runDb(makeContext(['restore', file, '--yes']), deps(remote))).rejects.toThrow(/isn't on this machine/);
    await expect(runDb(makeContext(['restore', file, '--yes']), deps()))
      .rejects.toThrow(/is a dump of database "acme", not "\S+"; pass --other-database/);
    const t = tools();
    await runDb(makeContext(['restore', file, '--yes', '--other-database']), deps({ tools: t }));
    expect(t.restored).toEqual([file]);
  });
});

describe('schema migrations', { timeout: PGLITE_TIMEOUT }, () => {
  /** A database with the engine's schema but none of Shreni's. */
  async function behind() {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.tg.migrate();
    return { shreni, open: async () => ({ shreni, close: async () => {} }) };
  }
  const kshetra = { id: 'web', project: '00000000-0000-0000-0000-000000000001', database: 'local' } as unknown as KshetraConfig;

  it('given a pending migration, when shreni start runs detached, then it refuses and prints shreni db migrate', async () => {
    const { open } = await behind();
    await expect(ensureMigrated(kshetra, {
      open, tools: tools(), backupsDir: dir(), print: () => {}, env: {}, interactive: () => false, ask: async () => 'y',
    })).rejects.toThrow(/web: the database has pending migrations \(shreni 0001_tables.*\); run shreni db migrate/);
  });

  it('in a terminal, offers the migration and runs it after a dump', async () => {
    const { shreni, open } = await behind();
    const t = tools();
    const out: string[] = [];
    await ensureMigrated(kshetra, {
      open, tools: t, backupsDir: dir(), print: l => out.push(l), env: {}, interactive: () => true, ask: async () => 'y',
    });
    expect(t.dumped).toHaveLength(1);
    expect(t.dumped[0]).toMatch(/local-.*-pre-migrate\.dump\.partial$/);
    expect(await shreni.pending()).toEqual([]);
    expect(out.join('\n')).toMatch(/migrated: shreni 0001_tables/);
  });

  it('a declined migration doesn\'t start, and an up-to-date database needs none', async () => {
    const { shreni, open } = await behind();
    const base = { open, tools: tools(), backupsDir: dir(), print: () => {}, env: {}, interactive: () => true };
    await expect(ensureMigrated(kshetra, { ...base, ask: async () => 'n' })).rejects.toThrow(/not started; run shreni db migrate first/);
    await shreni.migrate();
    await ensureMigrated(kshetra, { ...base, ask: async () => { throw new Error('not asked'); } });
    const out: string[] = [];
    await migrateDatabase(LOCAL, kshetra, { ...base, print: l => out.push(l) });
    expect(out).toEqual(['database "local" is up to date']);
  });

  it('migrates a database on another machine without a dump, saying so', async () => {
    const { open } = await behind();
    const t = tools();
    const out: string[] = [];
    await migrateDatabase({ name: 'acme', url: 'postgres://db.acme.internal/shreni' }, kshetra, { open, tools: t, backupsDir: dir(), print: l => out.push(l) });
    expect(t.dumped).toEqual([]);
    expect(out.join('\n')).toMatch(/isn't on this machine: no dump taken/);
  });
});

