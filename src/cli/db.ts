import { execFile, spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { basename } from 'path';
import { userInfo } from 'os';
import postgres from 'postgres';
import type { CommandContext } from './registry';
import { NoProjectConfig, parseArgs, resolveProject } from './task';
import { DatabaseLookupError, loadUserConfig, resolveDatabase, type DatabaseTarget } from '../kshetra/user-config';
import { checkDatabase, type CheckReport, type DbProbe, type Install } from '../policy/db/checks';
import {
  backupsDir, dailyFailure, fileSafe, isLocal, parseDumpName, pgTools, RemoteDatabase, startDailyIfDue, takeDump, WAIT_MS, type DumpTools,
} from '../policy/db/backups';
import { openKshetraEngine, type KshetraEngine } from '../policy/sthapathi/connect';
import type { ProjectConfig } from '../kshetra/project-config';
import type { KshetraConfig } from '../kshetra/config';
import { selfExec } from './self-exec';

// shreni db (policy spec, "The database"). `check` runs the checks init's
// Database phase runs, at any time: it finds the server, logs in, checks the
// version and the database, and pg_dump, and says what to do about each.
// dump, restore and migrate are the backups and schema migrations (policy spec,
// "Backups" and "Schema migrations in practice").

export const DB_USAGE = '<check [--create] | dump [--remote] | restore <file> --yes [--remote] [--other-database] | migrate [--remote]>';

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const;

export interface DbDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  probe: DbProbe;
  interactive(): boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
  /** Opens the engine on the database a project config names. */
  open(project: Pick<ProjectConfig, 'database'>): Promise<KshetraEngine>;
  tools: DumpTools;
  backupsDir: string;
  /** Other sessions connected to the target's database, by application name: restore refuses while there are any. */
  otherSessions(target: DatabaseTarget): Promise<string[]>;
}

async function otherSessions(target: DatabaseTarget): Promise<string[]> {
  const sql = postgres(target.url, {
    max: 1, connect_timeout: 5, onnotice: () => {},
    ...(target.user ? { username: target.user } : {}), ...(target.password ? { password: target.password } : {}),
  });
  try {
    const rows = await sql<{ app: string }[]>`
      select coalesce(nullif(application_name, ''), usename, 'unknown') as app from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
    return rows.map(r => r.app);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Runs a command, resolving to its exit code and output; never rejects. */
function exec(bin: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 5_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout ?? '') });
    });
  });
}

/** Whether a command is on PATH; `command -v` through sh, since minimal systems lack `which`. */
const onPath = async (bin: string) => (process.platform === 'win32'
  ? await exec('where', [bin])
  : await exec('sh', ['-c', `command -v ${bin}`])).code === 0;

/** The newest Homebrew postgresql formula among a directory's entries, by version, not by name. */
export function newestFormula(entries: string[]): string | undefined {
  const version = (f: string) => Number(/@(\d+)/.exec(f)?.[1] ?? Infinity); // a bare `postgresql` is Homebrew's current one
  return entries.filter(f => /^postgresql(@\d+)?$/.test(f)).sort((a, b) => version(a) - version(b)).at(-1);
}

/** The major version `pg_dump --version` prints, e.g. 17 from "pg_dump (PostgreSQL) 17.2". */
export function pgDumpVersion(out: string): number | null {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(out) ?? /(\d+)(?:\.\d+)?/.exec(out);
  return m ? Number(m[1]) : null;
}

/** Probes this machine and the target server. */
export function realProbe(): DbProbe {
  const open = (target: DatabaseTarget, database?: string) => postgres(target.url, {
    max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {},
    ...(database ? { database } : {}),
    ...(target.user ? { username: target.user } : {}),
    ...(target.password ? { password: target.password } : {}),
  });
  return {
    platform: process.platform,
    async connect(target, database) {
      const sql = open(target, database);
      try {
        const [row] = await sql<{ server_version_num: string }[]>`show server_version_num`;
        return { ok: true, serverVersionNum: Number(row.server_version_num) };
      } catch (err) {
        const e = err as { code?: string; errno?: string; message: string };
        return { ok: false, code: String(e.code ?? e.errno ?? 'UNKNOWN'), message: e.message };
      } finally {
        await sql.end({ timeout: 1 }).catch(() => {});
      }
    },
    async createDatabase(target, name) {
      // Through the maintenance database, or template1 where it was dropped, as createdb does.
      for (const via of ['postgres', 'template1']) {
        const sql = open(target, via);
        try {
          await sql`create database ${sql(name)}`;
          return;
        } catch (err) {
          if ((err as { code?: string }).code !== '3D000' || via === 'template1') throw err;
        } finally {
          await sql.end({ timeout: 1 }).catch(() => {});
        }
      }
    },
    async installed(): Promise<Install | null> {
      if (process.platform === 'darwin') {
        for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
          const formula = existsSync(root) ? newestFormula(readdirSync(root)) : undefined;
          if (formula) return { via: 'homebrew', formula };
        }
        if (existsSync('/Applications/Postgres.app')) return { via: 'postgres.app' };
      }
      if ((await exec('docker', ['inspect', 'shreni-postgres'])).code === 0) return { via: 'docker' };
      if (process.platform === 'win32') {
        // The EDB installer puts each major under its own directory, which its service is named after.
        const root = 'C:\\Program Files\\PostgreSQL';
        const majors = existsSync(root) ? readdirSync(root).map(Number).filter(n => n > 0).sort((a, b) => a - b) : [];
        return majors.length ? { via: 'package', major: majors.at(-1)! } : null;
      }
      // A server binary, not just the client tools (Debian's postgresql-client also fills /usr/lib/postgresql).
      const debian = existsSync('/usr/lib/postgresql')
        && readdirSync('/usr/lib/postgresql').some(v => existsSync(`/usr/lib/postgresql/${v}/bin/postgres`));
      if (debian || await onPath('postgres') || await onPath('pg_ctlcluster')) return { via: 'package' };
      return null;
    },
    async pgDumpMajor() {
      const r = await exec('pg_dump', ['--version']);
      return r.code === 0 ? pgDumpVersion(r.stdout) : null;
    },
    run: command => new Promise(resolve => {
      const child = spawn(command, { shell: true, stdio: 'inherit' });
      child.on('exit', code => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    }),
    osUser: () => userInfo().username,
  };
}

const defaultDeps = (): DbDeps => ({
  cwd: process.cwd(),
  env: process.env,
  probe: realProbe(),
  interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  async ask(question) {
    const { createInterface } = await import('readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  print: line => console.log(line),
  open: project => openKshetraEngine(project, { name: 'shreni-db' }),
  tools: pgTools,
  backupsDir: backupsDir(),
  otherSessions,
});

/** What the migration check before a start uses, for callers outside this module. */
export const migrateDeps = (): DbDeps => defaultDeps();

/** The database this repo uses: its config's `database`, else `local`; SHRENI_DATABASE_URL over both. */
function targetFor(deps: Pick<DbDeps, 'cwd' | 'env'>): DatabaseTarget {
  return projectTarget(deps).target;
}

function projectTarget(deps: Pick<DbDeps, 'cwd' | 'env'>): { target: DatabaseTarget; project: Pick<ProjectConfig, 'database'> } {
  // The repo's `database`, even before init has given it a project; outside a repo, the machine's local one.
  let project: { database: string } | undefined;
  try {
    project = resolveProject(deps.cwd, deps.env, { requireProject: false }).config;
  } catch (err) {
    if (!(err instanceof NoProjectConfig)) throw err;
  }
  try {
    return { target: resolveDatabase(project, loadUserConfig(), deps.env), project: project ?? { database: 'local' } };
  } catch (err) {
    if (!(err instanceof DatabaseLookupError)) throw err;
    throw new Error(`${err.message}\n  For example, in ~/.shreni/config.yaml:\n    databases:\n      ${project?.database ?? 'local'}: { url: postgres://localhost:5432/shreni }`);
  }
}

export async function runDb(ctx: CommandContext, overrides: Partial<DbDeps> = {}): Promise<CheckReport | undefined> {
  const deps: DbDeps = { ...defaultDeps(), ...overrides };
  const sub = ctx.args[0];
  if (sub === 'dump') return void await dumpCommand(ctx, deps);
  if (sub === 'restore') return void await restoreCommand(ctx, deps);
  if (sub === 'migrate') {
    const a = parseArgs(ctx.args, { command: 'shreni db migrate', bool: ['--remote'] });
    const { target, project } = projectTarget(deps);
    return void await migrateDatabase(target, project, deps, { remote: a.bools.has('--remote') });
  }
  if (sub !== 'check') throw new Error(`Usage: shreni db ${DB_USAGE}`);
  const a = parseArgs(ctx.args, { command: 'shreni db check', bool: ['--create'] });
  // Each line as it is found, so the y/N to start a server follows what led to it.
  const report = await checkDatabase(targetFor(deps), deps.probe, {
    interactive: deps.interactive(), ask: q => deps.ask(q), create: a.bools.has('--create'), env: deps.env,
    onLine: l => deps.print(`${MARK[l.severity]} ${l.text}`),
  });
  if (!report.ok) throw new Error('the database check failed');
  return report;
}

async function dumpCommand(ctx: CommandContext, deps: DbDeps): Promise<void> {
  const a = parseArgs(ctx.args, { command: 'shreni db dump', bool: ['--remote', '--daily'] });
  const target = targetFor(deps);
  // The background daily dump: quiet, and skipped when another process is already dumping.
  const daily = a.bools.has('--daily');
  const file = await takeDump(target, daily ? 'daily' : 'manual', deps.tools, {
    dir: deps.backupsDir, remote: a.bools.has('--remote'), ifIdle: daily,
  });
  if (!daily) deps.print(file ? `dumped database "${target.name}" to ${file}` : 'another dump is running');
}

async function restoreCommand(ctx: CommandContext, deps: DbDeps): Promise<void> {
  const a = parseArgs(ctx.args, { command: 'shreni db restore', bool: ['--yes', '--remote', '--other-database'], positionals: 1 });
  const [file] = a.positionals;
  if (!file) throw new Error('Usage: shreni db restore <file> --yes');
  if (!existsSync(file)) throw new Error(`no dump at ${file}`);
  const target = targetFor(deps);
  if (!a.bools.has('--remote') && !isLocal(target)) throw new RemoteDatabase(target.name);
  // The file name says which database a dump is of; another's needs saying so.
  const of = parseDumpName(basename(file))?.database;
  if (of && of !== fileSafe(target.name) && !a.bools.has('--other-database')) {
    throw new Error(`${file} is a dump of database "${of}", not "${target.name}"; pass --other-database to restore it anyway`);
  }
  if (!a.bools.has('--yes')) {
    throw new Error(`restore replaces database "${target.name}" with ${file}; work since that dump is lost. Pass --yes to go ahead`);
  }
  // Every worker stopped: anything else connected would write into, or across, the restore.
  const others = await deps.otherSessions(target);
  if (others.length) {
    throw new Error(`database "${target.name}" has other sessions (${[...new Set(others)].join(', ')}); stop every worker and Phalaka first`);
  }
  await deps.tools.restore(target, file);
  deps.print(`restored database "${target.name}" from ${file}`);
}

/** The migrations each schema lacks. */
async function pendingFor(conn: KshetraEngine): Promise<{ engine: string[]; shreni: string[] }> {
  return { engine: await conn.shreni.tg.pendingMigrations(), shreni: await conn.shreni.pending() };
}

const listPending = (p: { engine: string[]; shreni: string[] }) =>
  [...p.engine.map(m => `taskgraph ${m}`), ...p.shreni.map(m => `shreni ${m}`)];

/**
 * Applies pending migrations to both schemas, the engine's first, after a dump
 * it waits for. A database on another machine is its owner's to back up, so
 * there it migrates without one, saying so, unless `remote` asks for one.
 */
export async function migrateDatabase(
  target: DatabaseTarget, project: Pick<ProjectConfig, 'database'>,
  deps: Pick<DbDeps, 'open' | 'tools' | 'backupsDir' | 'print'>, opts: { remote?: boolean } = {},
): Promise<void> {
  const conn = await deps.open(project);
  try {
    const pending = listPending(await pendingFor(conn));
    if (!pending.length) return deps.print(`database "${target.name}" is up to date`);
    deps.print(`pending: ${pending.join(', ')}`);
    if (isLocal(target) || opts.remote) {
      const file = await takeDump(target, 'pre-migrate', deps.tools, { dir: deps.backupsDir, remote: opts.remote, wait: WAIT_MS });
      deps.print(`dumped first: ${file}`);
    } else {
      deps.print(`database "${target.name}" isn't on this machine: no dump taken (its owner backs it up; --remote takes one)`);
    }
    const report = await conn.shreni.migrate();
    deps.print(`migrated: ${[...report.engine.applied.map(m => `taskgraph ${m}`), ...report.shreni.map(m => `shreni ${m}`)].join(', ')}`);
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Before a worker starts on a Kshetra on the engine: with migrations pending,
 * a terminal is shown them and offered the migration; a detached start
 * refuses, printing the command (policy spec, "Schema migrations in practice").
 */
export async function ensureMigrated(
  kshetra: Pick<KshetraConfig, 'id' | 'database'>,
  deps: Pick<DbDeps, 'open' | 'tools' | 'backupsDir' | 'print' | 'interactive' | 'ask' | 'env'>,
): Promise<void> {
  const conn = await deps.open(kshetra);
  let pending: string[];
  try {
    pending = listPending(await pendingFor(conn));
  } finally {
    await conn.close().catch(() => {});
  }
  if (!pending.length) return;
  if (!deps.interactive()) {
    throw new Error(`${kshetra.id}: the database has pending migrations (${pending.join(', ')}); run shreni db migrate`);
  }
  deps.print(`${kshetra.id}: the database has pending migrations: ${pending.join(', ')}`);
  if (!/^y(es)?$/i.test((await deps.ask('Run shreni db migrate now? [y/N] ')).trim())) {
    throw new Error(`${kshetra.id}: the migrations weren't run; run shreni db migrate first`);
  }
  await migrateDatabase(resolveDatabase(kshetra, loadUserConfig(), deps.env), kshetra, deps);
}

/**
 * The first command after the newest dump turns a day old starts a daily dump
 * in the background. Best effort: a repo without a database, or a machine
 * without a config, has nothing to dump. A daily dump that failed is said, to
 * a terminal, until one succeeds.
 */
export function dailyDumpHook(deps: {
  cwd: string; env: NodeJS.ProcessEnv; dir?: string; now?: Date; start?: () => void; warn?: (line: string) => void;
}): boolean {
  let target: DatabaseTarget;
  try {
    target = targetFor(deps);
  } catch {
    return false;
  }
  const dir = deps.dir ?? backupsDir();
  const failed = dailyFailure(dir, target.name);
  if (failed) deps.warn?.(`shreni: the daily dump of database "${target.name}" failed at ${failed.at.toISOString()}: ${failed.error}; shreni db dump tries again`);
  return startDailyIfDue(target, deps.start ?? (() => {
    const launch = selfExec('db', ['dump', '--daily']);
    const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', cwd: deps.cwd, windowsHide: true });
    // A spawn that fails says so later, as an event; never in the way of the command.
    child.on('error', () => {});
    child.unref();
  }), { dir, now: deps.now });
}
