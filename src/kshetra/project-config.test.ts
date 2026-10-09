import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadTrackerConfig, TrackerConfigError, ProjectConfigBase, VALIDATOR_DEFAULTS, validatorSettings,
} from './project-config.js';
import { KshetraConfigSchema } from './config.js';
import { loadUserConfig, UserConfigError, resolveDatabase, DatabaseLookupError } from './user-config.js';

const dir = () => mkdtempSync(join(tmpdir(), 'shreni-config-'));
const write = (d: string, name: string, body: string, mode = 0o600) => {
  const p = join(d, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};
const UUID = '0b9a3c5e-1d2f-4a6b-8c7d-9e0f1a2b3c4d';

describe('tracker.yaml', () => {
  it('loads the shared base plus providers, with the base defaults', () => {
    const p = write(dir(), 'tracker.yaml', `name: shreni\nproject: ${UUID}\n`);
    expect(loadTrackerConfig(p)).toEqual({
      name: 'shreni', project: UUID, database: 'local', plan: { validators: {} }, providers: ['claude'],
    });
  });

  it('fails on a Kshetra-only key, naming it', () => {
    const p = write(dir(), 'tracker.yaml', `name: shreni\nrepo:\n  path: /x\n`);
    expect(() => loadTrackerConfig(p)).toThrow(TrackerConfigError);
    expect(() => loadTrackerConfig(p)).toThrow(/repo/);
  });

  it('takes per-project validator settings; a bad level fails', () => {
    const d = dir();
    const ok = write(d, 'tracker.yaml', [
      'name: shreni', 'plan:', '  validators:', '    collisions: off',
      '    graphShape: { level: warning, maxTasks: 8, maxDepth: 4 }',
    ].join('\n'));
    const c = loadTrackerConfig(ok);
    expect(validatorSettings(c)).toEqual({
      ...VALIDATOR_DEFAULTS, collisions: { level: 'off' }, graphShape: { level: 'warning', maxTasks: 8, maxDepth: 4 },
    });
    const bad = write(d, 'bad.yaml', 'name: shreni\nplan:\n  validators:\n    coverage: loud\n');
    expect(() => loadTrackerConfig(bad)).toThrow(/plan\.validators\.coverage/);
  });
});

describe('the shared base', () => {
  it('is extended by both kinds: a Kshetra gets the same database and validator defaults', () => {
    const base = Object.keys(ProjectConfigBase.shape).sort();
    expect(base).toEqual(['database', 'description', 'name', 'plan', 'project']);
    const k = KshetraConfigSchema.parse({
      id: 'web', name: 'web', repo: { path: '/r', remote: 'git@x:y.git' }, beads: { path: '/r/.beads', remote: 'git@x:b.git' },
      stack: { language: 'typescript' },
    });
    expect(k).toMatchObject({ database: 'local', plan: { validators: {} } });
    expect(validatorSettings(k)).toEqual(VALIDATOR_DEFAULTS);
  });
});

describe('~/.shreni/config.yaml', () => {
  it('loads the user and the databases; the user defaults to git config user.email', () => {
    const d = dir();
    const p = write(d, 'config.yaml', [
      'databases:', '  local: { url: "postgres://localhost:5432/shreni" }',
      '  acme: { url: "postgres://db.acme.internal:5432/shreni", user: dev, passwordEnv: ACME_PG_PASSWORD }',
    ].join('\n'));
    expect(loadUserConfig(p, { gitEmail: () => 'dev@example.com' })).toEqual({
      user: 'dev@example.com',
      databases: {
        local: { url: 'postgres://localhost:5432/shreni' },
        acme: { url: 'postgres://db.acme.internal:5432/shreni', user: 'dev', passwordEnv: 'ACME_PG_PASSWORD' },
      },
    });
    expect(loadUserConfig(join(d, 'missing.yaml'), { gitEmail: () => undefined })).toEqual({ user: undefined, databases: {} });
  });

  it('refuses a file others can read when it holds a password', () => {
    const d = dir();
    const inUrl = write(d, 'a.yaml', 'databases:\n  local: { url: "postgres://u:secret@localhost/shreni" }\n', 0o644);
    const field = write(d, 'b.yaml', 'databases:\n  local: { url: "postgres://localhost/shreni", password: secret }\n', 0o640);
    expect(() => loadUserConfig(inUrl, { gitEmail: () => undefined })).toThrow(UserConfigError);
    expect(() => loadUserConfig(field, { gitEmail: () => undefined })).toThrow(/others can read/);
    chmodSync(field, 0o600);
    expect(loadUserConfig(field, { gitEmail: () => undefined }).databases.local.password).toBe('secret');
    const noSecret = write(d, 'c.yaml', 'user: me\ndatabases:\n  local: { url: "postgres://localhost/shreni" }\n', 0o644);
    expect(loadUserConfig(noSecret, { gitEmail: () => undefined }).user).toBe('me');
  });
});

describe('database lookup', () => {
  const user = {
    user: 'me',
    databases: {
      local: { url: 'postgres://localhost:5432/shreni' },
      acme: { url: 'postgres://db.acme.internal:5432/shreni', user: 'dev', passwordEnv: 'ACME_PG_PASSWORD' },
    },
  };

  it('takes the repo\'s database name, then its config entry; SHRENI_DATABASE_URL overrides both', () => {
    expect(resolveDatabase({ database: 'local' }, user, {})).toEqual({ name: 'local', url: 'postgres://localhost:5432/shreni' });
    expect(resolveDatabase({ database: 'acme' }, user, { ACME_PG_PASSWORD: 'pw' }))
      .toEqual({ name: 'acme', url: 'postgres://db.acme.internal:5432/shreni', user: 'dev', password: 'pw' });
    expect(resolveDatabase({ database: 'acme' }, user, { SHRENI_DATABASE_URL: 'postgres://ci/db' }))
      .toEqual({ name: 'SHRENI_DATABASE_URL', url: 'postgres://ci/db' });
    expect(resolveDatabase(undefined, user, {})).toMatchObject({ name: 'local' });
  });

  it('names a missing entry, and a missing password variable', () => {
    expect(() => resolveDatabase({ database: 'other' }, user, {})).toThrow(DatabaseLookupError);
    expect(() => resolveDatabase({ database: 'other' }, user, {})).toThrow(/other.*config\.yaml/);
    expect(() => resolveDatabase({ database: 'acme' }, user, {})).toThrow(/ACME_PG_PASSWORD/);
  });
});

describe('review follow-ups (T4.1)', () => {
  it('refuses unknown validator names, unknown options and unknown plan keys', () => {
    const d = dir();
    expect(() => loadTrackerConfig(write(d, 'a.yaml', 'name: s\nplan:\n  validators:\n    colisions: off\n'))).toThrow(/colisions/);
    expect(() => loadTrackerConfig(write(d, 'b.yaml', 'name: s\nplan:\n  validators:\n    graphShape: { level: warning, maxTask: 8 }\n'))).toThrow(/maxTask/);
    expect(() => loadTrackerConfig(write(d, 'c.yaml', 'name: s\nplan:\n  validator:\n    coverage: off\n'))).toThrow(/validator/);
  });

  it('treats a password in the url\'s query as a secret, and refuses a url that isn\'t postgres://', () => {
    const d = dir();
    const q = write(d, 'q.yaml', 'databases:\n  local: { url: "postgres://localhost/shreni?password=secret" }\n', 0o644);
    expect(() => loadUserConfig(q, { gitEmail: () => undefined })).toThrow(/others can read/);
    const dsn = write(d, 'dsn.yaml', 'databases:\n  local: { url: "host=h password=secret" }\n');
    expect(() => loadUserConfig(dsn, { gitEmail: () => undefined })).toThrow(/postgres:\/\//);
  });

  it('refuses an entry with both password and passwordEnv', () => {
    const p = write(dir(), 'x.yaml', 'databases:\n  a: { url: "postgres://h/d", password: p, passwordEnv: X }\n');
    expect(() => loadUserConfig(p, { gitEmail: () => undefined })).toThrow(/password.*passwordEnv|passwordEnv.*password/);
  });
});

describe('the resolved-config hash', () => {
  it('ignores the base defaults while they are unchanged, and records them once set', async () => {
    const { hashResolvedConfig } = await import('../sthapathi/lot-manifest.js');
    const raw = { id: 'web', name: 'web', repo: { path: '/r', remote: 'git@x:y.git' }, beads: { path: '/b', remote: 'git@x:b.git' }, stack: { language: 'ts' } };
    const k = KshetraConfigSchema.parse(raw);
    const { database: _d, plan: _p, ...withoutBase } = k;
    expect(hashResolvedConfig(k)).toBe(hashResolvedConfig(withoutBase as typeof k));
    expect(hashResolvedConfig(KshetraConfigSchema.parse({ ...raw, database: 'acme' }))).not.toBe(hashResolvedConfig(k));
  });
});
