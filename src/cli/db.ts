import { execFile, spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { userInfo } from 'os';
import postgres from 'postgres';
import type { CommandContext } from './registry';
import { NoProjectConfig, parseArgs, resolveProject } from './task';
import { DatabaseLookupError, loadUserConfig, resolveDatabase, type DatabaseTarget } from '../kshetra/user-config';
import { checkDatabase, type CheckReport, type DbProbe, type Install } from '../policy/db/checks';

// shreni db (policy spec, "The database"). `check` runs the checks init's
// Database phase runs, at any time: it finds the server, logs in, checks the
// version and the database, and pg_dump, and says what to do about each.
// dump, restore and migrate come with backups.

export const DB_USAGE = '<check> [--create]';

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const;

export interface DbDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  probe: DbProbe;
  interactive(): boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
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
});

/** The database this repo uses: its config's `database`, else `local`; SHRENI_DATABASE_URL over both. */
function targetFor(deps: DbDeps): DatabaseTarget {
  // The repo's `database`, even before init has given it a project; outside a repo, the machine's local one.
  let project: { database: string } | undefined;
  try {
    project = resolveProject(deps.cwd, deps.env, { requireProject: false }).config;
  } catch (err) {
    if (!(err instanceof NoProjectConfig)) throw err;
  }
  try {
    return resolveDatabase(project, loadUserConfig(), deps.env);
  } catch (err) {
    if (!(err instanceof DatabaseLookupError)) throw err;
    throw new Error(`${err.message}\n  For example, in ~/.shreni/config.yaml:\n    databases:\n      ${project?.database ?? 'local'}: { url: postgres://localhost:5432/shreni }`);
  }
}

export async function runDb(ctx: CommandContext, overrides: Partial<DbDeps> = {}): Promise<CheckReport | undefined> {
  const deps: DbDeps = { ...defaultDeps(), ...overrides };
  const sub = ctx.args[0];
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
