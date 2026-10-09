import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, resolve } from 'path';
import * as yaml from 'js-yaml';
import type { ProjectConfig } from './project-config.js';

// The user's config, ~/.shreni/config.yaml (policy spec, "The database"):
// who the developer is, and the databases this machine uses, by name. A repo's
// config names one (`database: acme`); SHRENI_DATABASE_URL overrides both, for
// CI. Secrets stay out of repos: a password comes from the environment
// variable an entry names, or from this file only when no one else can read it.

const DatabaseEntry = z.object({
  url: z.string().regex(/^postgres(ql)?:\/\//, 'a database url starts with postgres://'),
  user: z.string().optional(),
  /** The environment variable holding the password. */
  passwordEnv: z.string().optional(),
  /** Allowed only in a file only its owner can read. */
  password: z.string().optional(),
}).strict().refine(d => !(d.password !== undefined && d.passwordEnv !== undefined), {
  message: 'give password or passwordEnv, not both',
});

const UserConfigSchema = z.object({
  /** The developer on attempts and events; defaults to git config user.email. */
  user: z.string().optional(),
  databases: z.record(z.string(), DatabaseEntry).default({}),
}).strict();
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type DatabaseEntry = z.infer<typeof DatabaseEntry>;

export const USER_CONFIG_PATH = join(homedir(), '.shreni', 'config.yaml');

export class UserConfigError extends Error {
  constructor(readonly configPath: string, message: string) {
    super(`[${configPath}] ${message}`);
    this.name = 'UserConfigError';
  }
}

function gitUserEmail(): string | undefined {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A url with a password in it: postgres://user:secret@host/db, or ?password=secret. */
const urlHasPassword = (url: string) => {
  try {
    const u = new URL(url);
    return u.password !== '' || u.searchParams.has('password');
  } catch {
    return true; // unparseable: assume the worst
  }
};

/**
 * Loads the user config; a missing file is an empty one. Refuses a file that
 * group or others can read when it holds a password.
 */
export function loadUserConfig(
  configPath: string = USER_CONFIG_PATH, opts: { gitEmail?: () => string | undefined } = {},
): UserConfig {
  const resolved = resolve(configPath);
  const gitEmail = opts.gitEmail ?? gitUserEmail;
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { user: gitEmail(), databases: {} };
    throw new UserConfigError(resolved, `Cannot read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw) ?? {};
  } catch (err) {
    throw new UserConfigError(resolved, `Invalid YAML: ${(err as Error).message}`);
  }
  const result = UserConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new UserConfigError(resolved, `Schema validation failed:\n${result.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const config = result.data;
  const secrets = Object.entries(config.databases).filter(([, d]) => d.password || urlHasPassword(d.url)).map(([n]) => n);
  if (secrets.length && process.platform === 'win32') {
    // File modes don't show who can read a file on Windows, so a password here is never safe to assume private.
    throw new UserConfigError(resolved,
      `holds a password (databases: ${secrets.join(', ')}); on Windows, give it through passwordEnv instead`);
  }
  if (secrets.length && (statSync(resolved).mode & 0o077) !== 0) {
    throw new UserConfigError(resolved,
      `holds a password (databases: ${secrets.join(', ')}) but others can read it; run chmod 600 ${resolved}, or use passwordEnv`);
  }
  return { ...config, user: config.user ?? gitEmail() };
}

/** How to reach a database: its url, and the user and password to log in with when they aren't in the url. */
export type DatabaseTarget = { name: string; url: string; user?: string; password?: string };

export class DatabaseLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseLookupError';
  }
}

/**
 * The database a repo uses: SHRENI_DATABASE_URL when set, else the repo's
 * `database` name (default local) looked up in the user config.
 */
export function resolveDatabase(
  project: Pick<ProjectConfig, 'database'> | undefined, user: UserConfig, env: NodeJS.ProcessEnv = process.env,
): DatabaseTarget {
  if (env.SHRENI_DATABASE_URL) return { name: 'SHRENI_DATABASE_URL', url: env.SHRENI_DATABASE_URL };
  const name = project?.database ?? 'local';
  const entry = user.databases[name];
  if (!entry) {
    throw new DatabaseLookupError(
      `this repo uses database "${name}", which ~/.shreni/config.yaml doesn't name; add it under databases, or run shreni init`);
  }
  let password = entry.password;
  if (entry.passwordEnv) {
    password = env[entry.passwordEnv];
    if (password === undefined) {
      throw new DatabaseLookupError(`database "${name}" takes its password from ${entry.passwordEnv}, which isn't set`);
    }
  }
  return {
    name, url: entry.url,
    ...(entry.user ? { user: entry.user } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}
