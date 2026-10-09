import type { DatabaseTarget } from '../../kshetra/user-config';

// Database checks (policy spec, "The database"): what init's Database phase and
// `shreni db check` find, and what they tell the developer. They detect and
// explain, and never install a server: choosing a version and an install
// method is the developer's, and a half-finished install is worse than clear
// instructions. Every probe is injected, so each case is testable without one.

/** The oldest Postgres the engine runs on. */
export const MIN_SERVER_MAJOR = 15;
/** The version the install advice names. */
export const ADVISED_MAJOR = 17;

/** What a connection attempt found. */
export type Connected =
  | { ok: true; serverVersionNum: number }
  /** `code`: a SQLSTATE (28P01, 3D000…) or a socket errno (ECONNREFUSED, ENOENT…). */
  | { ok: false; code: string; message: string };

export interface DbProbe {
  platform: NodeJS.Platform;
  /** Connects to `database` on the target's server (its own database when omitted) and reads server_version_num. */
  connect(target: DatabaseTarget, database?: string): Promise<Connected>;
  /** Creates the database through the server's maintenance database; throws with the server's code on refusal. */
  createDatabase(target: DatabaseTarget, name: string): Promise<void>;
  /** How Postgres is installed here, if it is. */
  installed(): Promise<Install | null>;
  /** `pg_dump --version`'s major, or null when there is none. */
  pgDumpMajor(): Promise<number | null>;
  /** Runs a start command the developer agreed to; resolves to its exit code. */
  run(command: string): Promise<number>;
  /** The OS user libpq logs in as when the target names none. */
  osUser(): string;
}

/** An install found on this machine, and how to start it; a package install may know its major version. */
export type Install = { via: 'homebrew'; formula: string } | { via: 'postgres.app' } | { via: 'package'; major?: number } | { via: 'docker' };

export type Severity = 'ok' | 'warn' | 'fail';
export interface CheckLine { severity: Severity; text: string }

export interface CheckReport {
  ok: boolean;
  lines: CheckLine[];
  /** The server's major version, once it answered. */
  serverMajor?: number;
  /** pg_dump is missing or older than the server: dump-first commands are blocked. */
  dumpBlocked: boolean;
}

export interface CheckOptions {
  /** A person at a terminal, who may be asked y/N. */
  interactive: boolean;
  ask(question: string): Promise<string>;
  /** Create the database when the server answers without it (init does; a check may only report). */
  create: boolean;
  /** Called with each line as it is found, so a question is asked after what led to it. */
  onLine?(line: CheckLine): void;
  /** Waits between tries while a just-started server comes up. */
  sleep?(ms: number): Promise<void>;
  /** The environment postgres.js reads its defaults from (PGUSER, PGDATABASE). */
  env?: NodeJS.ProcessEnv;
}

/** How long a just-started server gets to answer, and how often it is tried. */
export const START_WAIT_MS = 15_000;
const START_POLL_MS = 500;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/**
 * The host, port, database and user a target url names, with postgres.js's
 * defaults: localhost, 5432, PGUSER or the OS user, and PGDATABASE or the user.
 */
export function describeTarget(target: DatabaseTarget, osUser: string, env: NodeJS.ProcessEnv = {}) {
  const u = new URL(target.url);
  const host = decodeURIComponent(u.hostname);
  const user = target.user ?? (decodeURIComponent(u.username) || env.PGUSERNAME || env.PGUSER || osUser);
  return {
    host: host || 'localhost',
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || env.PGDATABASE || user,
    user,
    local: LOCAL_HOSTS.has(host) || host.startsWith('/'),
  };
}

/** A word for a shell command line, quoted when it needs to be. */
const shq = (w: string) => (/^[A-Za-z0-9_.@:/-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** How to install Postgres on this platform, as commands to print. */
export function installAdvice(platform: NodeJS.Platform): string[] {
  const docker = `docker run -d --name shreni-postgres -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:${ADVISED_MAJOR}`;
  if (platform === 'darwin') {
    return [
      `brew install postgresql@${ADVISED_MAJOR}`,
      `brew services start postgresql@${ADVISED_MAJOR}`,
      `(or Postgres.app from https://postgresapp.com, or Docker: ${docker})`,
    ];
  }
  if (platform === 'win32') {
    return [
      `Install PostgreSQL ${ADVISED_MAJOR} with the EDB installer: https://www.postgresql.org/download/windows/`,
      `net start postgresql-x64-${ADVISED_MAJOR}`,
      `(or Docker: ${docker})`,
    ];
  }
  return [
    'sudo apt install postgresql        # Debian and Ubuntu; sudo dnf install postgresql-server on Fedora',
    'sudo systemctl start postgresql',
    `(or Docker: ${docker})`,
  ];
}

/** The command that starts an installed server, and whether it needs sudo (only one that doesn't is offered). */
export function startCommand(install: Install, platform: NodeJS.Platform): { command: string; sudo: boolean } {
  switch (install.via) {
    case 'homebrew': return { command: `brew services start ${install.formula}`, sudo: false };
    case 'postgres.app': return { command: 'open -a Postgres', sudo: false };
    case 'docker': return { command: 'docker start shreni-postgres', sudo: false };
    case 'package':
      return platform === 'win32'
        ? { command: `net start postgresql-x64-${install.major ?? ADVISED_MAJOR}`, sudo: true }
        : { command: 'sudo systemctl start postgresql', sudo: true };
  }
}

/** A socket that nothing answers on. */
const unreachable = (code: string) => ['ECONNREFUSED', 'ENOENT', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'CONNECT_TIMEOUT'].includes(code);
/** A server that answered too early: still starting up, or in recovery. */
const starting = (code: string) => unreachable(code) || code === '57P03';
/** The failure's message, or its code when Node gave none (an AggregateError over several addresses). */
const why = (c: { code: string; message: string }) => c.message || c.code;

/** Runs every check against the target and says what to do; never throws for what it finds. */
export async function checkDatabase(target: DatabaseTarget, probe: DbProbe, opts: CheckOptions): Promise<CheckReport> {
  const lines: CheckLine[] = [];
  const say = (severity: Severity, text: string) => {
    const line = { severity, text };
    lines.push(line);
    opts.onLine?.(line);
  };
  const report = (ok: boolean, extra: Partial<CheckReport> = {}): CheckReport => ({ ok, lines, dumpBlocked: false, ...extra });
  let t: ReturnType<typeof describeTarget>;
  try {
    t = describeTarget(target, probe.osUser(), opts.env ?? {});
  } catch {
    say('fail', `The url for database "${target.name}" isn't a valid postgres:// url; a password with @ or / in it must be percent-encoded.`);
    return report(false);
  }
  const where = `${t.host}:${t.port}`;
  // The flags that point a client tool at the checked server, not libpq's defaults.
  const at = `-h ${shq(t.host)} -p ${t.port}`;
  const fromEnv = target.name === 'SHRENI_DATABASE_URL';

  let conn = await probe.connect(target);

  // No server answers: not installed, or installed and stopped.
  if (!conn.ok && unreachable(conn.code)) {
    if (!t.local) {
      say('fail', `No Postgres answers at ${where} (database "${target.name}"): ${why(conn)}. Check the server is up and reachable.`);
      return report(false);
    }
    const install = await probe.installed();
    if (!install) {
      say('fail', `Postgres isn't installed. Install it and start it:`);
      for (const c of installAdvice(probe.platform)) say('fail', `  ${c}`);
      return report(false);
    }
    const start = startCommand(install, probe.platform);
    say('fail', `Postgres is installed but not running at ${where}. Start it with:`);
    say('fail', `  ${start.command}`);
    if (start.sudo || !opts.interactive) return report(false);
    if (!/^y(es)?$/i.test((await opts.ask(`Run ${start.command} now? [y/N] `)).trim())) return report(false);
    const code = await probe.run(start.command);
    if (code !== 0) {
      say('fail', `${start.command} exited ${code}.`);
      return report(false);
    }
    // A start command returns before the server accepts connections: try again for a while.
    const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    for (let waited = 0; ; waited += START_POLL_MS) {
      conn = await probe.connect(target);
      if (conn.ok || !starting(conn.code) || waited >= START_WAIT_MS) break;
      await sleep(START_POLL_MS);
    }
    if (!conn.ok && starting(conn.code)) {
      say('fail', `Started, but nothing answers at ${where} after ${START_WAIT_MS / 1000}s; run shreni db check again in a moment.`);
      return report(false);
    }
    say('ok', `Started Postgres (${start.command}).`);
  }

  // The login fails: name the user and how to fix it.
  if (!conn.ok && (conn.code === '28P01' || conn.code === '28000')) {
    say('fail', `Postgres at ${where} refused the login as "${t.user}": ${why(conn)}`);
    const where2 = fromEnv ? 'in SHRENI_DATABASE_URL' : `under databases.${target.name} in ~/.shreni/config.yaml`;
    if (conn.code === '28000' && /role .* does not exist/.test(conn.message)) {
      say('fail', `  Create the role as a superuser: createuser ${at} -U postgres -s ${shq(t.user)}`);
      say('fail', `  (on Linux: sudo -u postgres createuser -s ${shq(t.user)}; or name another user ${where2})`);
    } else if (conn.code === '28000') {
      say('fail', `  The server's pg_hba.conf doesn't let "${t.user}" in from here; allow it there, or check sslmode ${where2}`);
    } else {
      say('fail', fromEnv
        ? '  Check the user and password in SHRENI_DATABASE_URL'
        : `  Check the password: the passwordEnv ${where2} names the variable that holds it`);
    }
    return report(false);
  }

  // The database is missing: create it, or say how.
  if (!conn.ok && conn.code === '3D000') {
    // Through the maintenance database, or template1 where it was dropped, as createdb does.
    let server = await probe.connect(target, 'postgres');
    if (!server.ok && server.code === '3D000') server = await probe.connect(target, 'template1');
    if (server.ok && server.serverVersionNum < MIN_SERVER_MAJOR * 10_000) {
      lines.push(tooOld(server.serverVersionNum, where));
      return report(false, { serverMajor: major(server.serverVersionNum) });
    }
    if (!opts.create) {
      say('fail', `The database "${t.database}" doesn't exist at ${where}. shreni init creates it, or: createdb ${at} -U ${shq(t.user)} ${shq(t.database)}`);
      return report(false);
    }
    try {
      await probe.createDatabase(target, t.database);
      say('ok', `Created the database "${t.database}".`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      say('fail', code === '42501'
        ? `"${t.user}" may not create databases. Ask an admin to run: createdb ${at} -O ${shq(t.user)} ${shq(t.database)}`
        : `Couldn't create the database "${t.database}": ${(err as Error).message}`);
      return report(false);
    }
    conn = await probe.connect(target);
  }

  if (!conn.ok) {
    say('fail', `Couldn't connect to ${where} (database "${target.name}"): ${why(conn)}`);
    return report(false);
  }
  if (conn.serverVersionNum < MIN_SERVER_MAJOR * 10_000) {
    lines.push(tooOld(conn.serverVersionNum, where));
    return report(false, { serverMajor: major(conn.serverVersionNum) });
  }
  const serverMajor = major(conn.serverVersionNum);
  say('ok', `Postgres ${serverMajor} answers at ${where}, database "${t.database}" as "${t.user}".`);

  // pg_dump only warns: it blocks the commands that take a dump first.
  const dump = await probe.pgDumpMajor();
  const dumpBlocked = dump === null || dump < serverMajor;
  if (dump === null) say('warn', 'pg_dump is missing. An import, shreni task upgrade and shreni db migrate need it; install the Postgres client tools.');
  else if (dump < serverMajor) say('warn', `pg_dump ${dump} is older than the server (${serverMajor}). An import, shreni task upgrade and shreni db migrate need one at least as new.`);
  else say('ok', `pg_dump ${dump}.`);
  return { ok: true, lines, serverMajor, dumpBlocked };
}

const major = (num: number) => Math.floor(num / 10_000);

function tooOld(num: number, where: string): CheckLine {
  return { severity: 'fail', text: `Postgres ${major(num)} at ${where} is older than ${MIN_SERVER_MAJOR}, which Shreni needs. Upgrade the server (${ADVISED_MAJOR} is advised).` };
}
