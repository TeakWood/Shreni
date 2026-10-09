import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, hostname, tmpdir } from 'os';
import { join } from 'path';
import type { DatabaseTarget } from '../../kshetra/user-config';
import { describeTarget } from './checks';

// Backups (policy spec, "Backups"): Shreni runs its own Postgres, so it dumps
// it itself, to ~/.shreni/backups/, named by database, time and why. A daily
// dump starts in the background on the first command after the newest dump
// turns 24 hours old; an import, an upgrade and a migration take one first and
// wait for it. The last 14 daily dumps are kept, and every other one.

/** Why a dump was taken; only daily ones are pruned. A manual one is shreni db dump's. */
export type DumpKind = 'daily' | 'manual' | 'pre-import' | 'pre-upgrade' | 'pre-migrate';
const KINDS: readonly DumpKind[] = ['daily', 'manual', 'pre-import', 'pre-upgrade', 'pre-migrate'];

/** How many daily dumps are kept; dumps taken before a change are all kept. */
export const KEEP_DAILY = 14;
/** How old the newest dump may get before a command starts a daily one. */
export const DAILY_MS = 24 * 3_600_000;

export const backupsDir = (home: string = homedir()) => join(home, '.shreni', 'backups');

/** A database name as it appears in a file name. */
export const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_');

/** 20261009T143005Z: sortable, and safe on every filesystem. */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function dumpName(database: string, kind: DumpKind, at: Date): string {
  return `${fileSafe(database)}-${stamp(at)}-${kind}.dump`;
}

export type DumpFile = { file: string; database: string; at: Date; kind: DumpKind };

export function parseDumpName(file: string): DumpFile | null {
  const m = /^(.+)-(\d{8}T\d{6}Z)-([a-z-]+)\.dump$/.exec(file);
  if (!m || !KINDS.includes(m[3] as DumpKind)) return null;
  const s = m[2];
  const at = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(at.getTime()) ? null : { file, database: m[1], at, kind: m[3] as DumpKind };
}

/** The database's dumps in `dir`, newest first. */
export function listDumps(dir: string, database: string): DumpFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(parseDumpName)
    .filter((d): d is DumpFile => !!d && d.database === fileSafe(database))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Whether the newest dump of any kind is older than a day, or there is none. */
export function dailyDue(dir: string, database: string, now: Date): boolean {
  const [newest] = listDumps(dir, database);
  return !newest || now.getTime() - newest.at.getTime() >= DAILY_MS;
}

/** Removes daily dumps past the newest KEEP_DAILY; returns the removed files. */
export function pruneDumps(dir: string, database: string): string[] {
  const old = listDumps(dir, database).filter(d => d.kind === 'daily').slice(KEEP_DAILY);
  for (const d of old) unlinkSync(join(dir, d.file));
  return old.map(d => d.file);
}

/** Whether the target's server is on this machine; only those are Shreni's to back up. */
export function isLocal(target: DatabaseTarget): boolean {
  try {
    return describeTarget(target, '').local;
  } catch {
    return false;
  }
}

export class RemoteDatabase extends Error {
  constructor(name: string) {
    super(`database "${name}" isn't on this machine; whoever runs it backs it up. Pass --remote to dump it anyway`);
    this.name = 'RemoteDatabase';
  }
}

/** Runs pg_dump and pg_restore; injected so the rules are testable without them. */
export interface DumpTools {
  /** pg_dump of the whole database, custom format, to `file`. */
  dump(target: DatabaseTarget, file: string): Promise<void>;
  /** pg_restore of `file` over the database, replacing what is there. */
  restore(target: DatabaseTarget, file: string): Promise<void>;
}

/** The lock a dump holds, so two commands starting the daily dump at once run one. */
export const lockPath = (dir: string, database: string) => join(dir, `.${fileSafe(database)}.dumping`);

/** A lock older than this is one a killed dump left behind, whatever its pid now names. */
export const STALE_LOCK_MS = 12 * 3_600_000;

type Lock = { pid: number; host: string; at: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file's content, or null when there is none. */
function readLock(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether a lock's holder may still be dumping: on this machine, alive; anywhere, younger than STALE_LOCK_MS. */
function held(raw: string, now: number): boolean {
  let lock: Lock;
  try {
    lock = JSON.parse(raw) as Lock;
  } catch {
    return false;
  }
  if (typeof lock?.pid !== 'number' || typeof lock.at !== 'number' || now - lock.at >= STALE_LOCK_MS) return false;
  return lock.host !== hostname() || alive(lock.pid);
}

/** Whether another process is dumping the database now. */
export function dumping(dir: string, database: string, now: Date = new Date()): boolean {
  const raw = readLock(lockPath(dir, database));
  return raw !== null && held(raw, now.getTime());
}

/** Takes the lock with its content already whole (written aside, then linked); returns that content, or null when held. */
function acquire(path: string, now: Date): string | null {
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: now.getTime() } satisfies Lock);
  const aside = `${path}.${randomBytes(6).toString('hex')}`;
  writeFileSync(aside, mine, { mode: 0o600 });
  try {
    linkSync(aside, path);
    return mine;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  } finally {
    unlinkSync(aside);
  }
}

/**
 * Removes a lock its process left behind, unless someone replaced it since it
 * was read: moved aside first, so no one else's fresh lock is removed by a
 * check that has gone stale; one moved by mistake is put back.
 */
function takeOverStale(path: string, stale: string): void {
  const aside = `${path}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    if (readLock(aside) !== stale) linkSync(aside, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    rmSync(aside, { force: true });
  }
}

/** How long a dump before a change waits for one already running. */
export const WAIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** What the last daily dump that failed left: when, and why. */
const failurePath = (dir: string, database: string) => join(dir, `.${fileSafe(database)}.daily-failed`);

/** After a failed daily dump, how long before a command starts another. */
export const RETRY_MS = 6 * 3_600_000;

export type DailyFailure = { at: Date; error: string };

/** The last daily dump's failure, if no dump has succeeded since. */
export function dailyFailure(dir: string, database: string): DailyFailure | null {
  const raw = readLock(failurePath(dir, database));
  if (raw === null) return null;
  try {
    const f = JSON.parse(raw) as { at: number; error: string };
    return { at: new Date(f.at), error: String(f.error) };
  } catch {
    return null;
  }
}

type DumpOpts = { dir?: string; now?: Date; remote?: boolean; ifIdle?: boolean; wait?: number; sleep?: (ms: number) => Promise<void> };

/**
 * Dumps the database to `dir`, written under a temporary name and renamed when
 * complete, so a dump in the directory is always whole. Refuses a database on
 * another machine unless `remote`. With another dump running, a daily one
 * (`ifIdle`) returns null, one before a change (`wait`) waits for it, and any
 * other refuses. A daily dump that fails is recorded, so the next commands
 * wait RETRY_MS and then say so.
 */
export async function takeDump(target: DatabaseTarget, kind: DumpKind, tools: DumpTools, opts: DumpOpts = {}): Promise<string | null> {
  try {
    return await dumpOnce(target, kind, tools, opts);
  } catch (err) {
    if (kind === 'daily') {
      // Best effort, and never in place of the error: a full disk fails both.
      try {
        const dir = opts.dir ?? backupsDir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(failurePath(dir, target.name), JSON.stringify({ at: (opts.now ?? new Date()).getTime(), error: (err as Error).message }), { mode: 0o600 });
      } catch {
        // Nothing more to do.
      }
    }
    throw err;
  }
}

async function dumpOnce(target: DatabaseTarget, kind: DumpKind, tools: DumpTools, opts: DumpOpts): Promise<string | null> {
  if (!opts.remote && !isLocal(target)) throw new RemoteDatabase(target.name);
  const dir = opts.dir ?? backupsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = lockPath(dir, target.name);
  const now = () => opts.now ?? new Date();
  const deadline = Date.now() + (opts.wait ?? 0);
  let mine = acquire(lock, now());
  while (!mine) {
    const raw = readLock(lock);
    if (raw !== null && held(raw, now().getTime())) {
      if (opts.ifIdle) return null;
      if (Date.now() >= deadline) {
        throw new Error(`another process is dumping database "${target.name}" (lock ${lock}); wait for it and try again`);
      }
      await (opts.sleep ?? sleep)(1_000);
    } else if (raw !== null) {
      takeOverStale(lock, raw);
    }
    mine = acquire(lock, now());
  }
  try {
    // A .partial a killed dump left: no one else is dumping this database now.
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.dump.partial') && parseDumpName(f.slice(0, -'.partial'.length))?.database === fileSafe(target.name)) {
        rmSync(join(dir, f), { force: true });
      }
    }
    const file = join(dir, dumpName(target.name, kind, now()));
    const partial = `${file}.partial`;
    try {
      await tools.dump(target, partial);
      renameSync(partial, file);
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
    rmSync(failurePath(dir, target.name), { force: true });
    if (kind === 'daily') pruneDumps(dir, target.name);
    return file;
  } finally {
    if (readLock(lock) === mine) rmSync(lock, { force: true });
  }
}

/**
 * Starts a daily dump in the background when the newest is a day old: on the
 * first command after that, for a database on this machine, unless one is
 * already running, or the last one failed under RETRY_MS ago. Returns whether
 * it started one.
 */
export function startDailyIfDue(
  target: DatabaseTarget, start: () => void, opts: { dir?: string; now?: Date } = {},
): boolean {
  const dir = opts.dir ?? backupsDir();
  const now = opts.now ?? new Date();
  if (!isLocal(target) || !dailyDue(dir, target.name, now) || dumping(dir, target.name, now)) return false;
  const failed = dailyFailure(dir, target.name);
  if (failed && now.getTime() - failed.at.getTime() < RETRY_MS) return false;
  start();
  return true;
}

/**
 * How a client tool reaches the target: the url without its password, which
 * goes in the environment, so `ps` never shows it.
 */
export function connection(target: DatabaseTarget): { url: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (target.user) env.PGUSER = target.user;
  let url = target.url;
  let password = target.password;
  try {
    const u = new URL(target.url);
    if (u.password) {
      password ??= decodeURIComponent(u.password);
      u.password = '';
      url = u.toString();
    }
  } catch {
    // Not a url (a conninfo string): passed as it is.
  }
  if (password) env.PGPASSWORD = password;
  return { url, env };
}

/** Runs a client tool, rejecting with its stderr. */
function tool(bin: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH, ...env },
    }, (err, out, stderr) => (err ? reject(new Error(`${bin} failed: ${String(stderr).trim() || err.message}`)) : resolve(String(out))));
  });
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Shreni's schemas: a restore drops them even when the dump predates one. */
const SHRENI_SCHEMAS = ['taskgraph', 'shreni'];

/** The schemas a dump creates, from its table of contents; public is the database's own. */
export function dumpSchemas(toc: string): string[] {
  return [...toc.matchAll(/^\d+; \d+ \d+ SCHEMA - (\S+) /gm)].map(m => m[1]).filter(s => s !== 'public');
}

/** pg_dump, and pg_restore through psql, on PATH. */
export const pgTools: DumpTools = {
  async dump(target, file) {
    const c = connection(target);
    await tool('pg_dump', ['--format=custom', `--file=${file}`, `--dbname=${c.url}`], c.env);
  },
  // pg_restore --clean drops only what the dump holds, so it can't undo a
  // migration that added a table or a key. Instead the dump's schemas are
  // dropped whole and loaded again, in one transaction: a restore that fails
  // leaves the database as it was.
  async restore(target, file) {
    const c = connection(target);
    const schemas = [...new Set([...SHRENI_SCHEMAS, ...dumpSchemas(await tool('pg_restore', ['--list', file], c.env))])];
    const tmp = mkdtempSync(join(tmpdir(), 'shreni-restore-'));
    try {
      const script = join(tmp, 'restore.sql');
      await tool('pg_restore', ['--no-owner', `--file=${script}`, file], c.env);
      await tool('psql', [
        '--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--single-transaction',
        `--command=DROP SCHEMA IF EXISTS ${schemas.map(ident).join(', ')} CASCADE`,
        `--file=${script}`, `--dbname=${c.url}`,
      ], c.env);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};
