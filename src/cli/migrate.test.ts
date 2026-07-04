import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';

// Mock only the registry so migrate never touches the real ~/.shreni/registry.json.
const mockRegisterKshetra = vi.fn();
vi.mock('../kshetra/registry.js', () => ({ registerKshetra: mockRegisterKshetra }));

const { runMigrate } = await import('./migrate.js');

// A valid legacy config with relative + ~ paths that migration must absolutize.
function legacyConfig(overrides: Record<string, unknown> = {}): string {
  return yaml.dump({
    id: 'myapp',
    name: 'Myapp',
    repo: { path: '.', remote: 'git@github.com:TeakWood/myapp.git' },
    beads: { path: '~/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git' },
    stack: { language: 'typescript' },
    ...overrides,
  });
}

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'shreni-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runMigrate', () => {
  it('moves a root kshetra.yaml into .shreni/, absolutizes paths, re-registers, and removes the root', () => {
    writeFileSync(join(dir, 'kshetra.yaml'), legacyConfig(), 'utf8');

    const result = runMigrate(dir);

    const canonical = join(dir, '.shreni', 'kshetra.yaml');
    expect(result.status).toBe('migrated');
    expect(result.id).toBe('myapp');
    expect(result.configPath).toBe(canonical);
    // Root removed; canonical written.
    expect(existsSync(join(dir, 'kshetra.yaml'))).toBe(false);
    expect(existsSync(canonical)).toBe(true);
    // Paths absolutized: '.' → the Kshetra dir; '~' expanded to home.
    const migrated = yaml.load(readFileSync(canonical, 'utf8')) as {
      repo: { path: string };
      beads: { path: string };
    };
    expect(migrated.repo.path).toBe(dir);
    expect(migrated.beads.path).toBe(join(homedir(), 'projects/myapp-beads'));
    // Re-registered to the canonical path.
    expect(mockRegisterKshetra).toHaveBeenCalledWith('myapp', canonical);
  });

  it('is idempotent — a second run is a no-op once canonical exists', () => {
    writeFileSync(join(dir, 'kshetra.yaml'), legacyConfig(), 'utf8');
    runMigrate(dir);
    mockRegisterKshetra.mockClear();

    const second = runMigrate(dir);
    expect(second.status).toBe('already_canonical');
    // No config rewrite / re-register on the idempotent run.
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.shreni', 'kshetra.yaml'))).toBe(true);
  });

  it('removes a stale root file when a canonical config already exists', () => {
    mkdirSync(join(dir, '.shreni'), { recursive: true });
    writeFileSync(join(dir, '.shreni', 'kshetra.yaml'), legacyConfig({ repo: { path: dir, remote: 'x' } }), 'utf8');
    writeFileSync(join(dir, 'kshetra.yaml'), legacyConfig(), 'utf8');

    const result = runMigrate(dir);
    expect(result.status).toBe('migrated');
    expect(existsSync(join(dir, 'kshetra.yaml'))).toBe(false);
  });

  it('reports nothing_to_migrate when neither file exists', () => {
    const result = runMigrate(dir);
    expect(result.status).toBe('nothing_to_migrate');
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('leaves the root file in place and throws when the migrated config is invalid', () => {
    // Missing required fields (name/beads/stack) → loadKshetraConfig rejects.
    writeFileSync(join(dir, 'kshetra.yaml'), yaml.dump({ id: 'x', repo: { path: '.' } }), 'utf8');
    expect(() => runMigrate(dir)).toThrow();
    // Root must survive a failed migration so no data is lost.
    expect(existsSync(join(dir, 'kshetra.yaml'))).toBe(true);
  });
});