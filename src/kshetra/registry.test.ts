import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The registry reads ~/.shreni/registry.json — we override homedir via env/mock
// so tests don't touch the real file.
const dir = join(tmpdir(), `shreni-registry-test-${process.pid}`);
const registryPath = join(dir, '.shreni', 'registry.json');

// Patch homedir to point at our temp dir before importing the module
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => dir };
});

// Import AFTER the mock is set up
const { loadRegistry, registerKshetra, unregisterKshetra } = await import('./registry.js');

const VALID_YAML = `
id: myapp
name: Myapp
repo:
  path: /projects/myapp
  remote: git@github.com:TeakWood/myapp.git
beads:
  path: /projects/myapp-beads
  remote: git@github.com:TeakWood/myapp-beads.git
stack:
  language: typescript
`;

let kshetraDir: string;

beforeEach(() => {
  kshetraDir = join(tmpdir(), `shreni-ksh-${process.pid}-${Date.now()}`);
  mkdirSync(kshetraDir, { recursive: true });
  // Ensure no leftover registry from previous test
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
});

afterEach(() => {
  rmSync(kshetraDir, { recursive: true, force: true });
});

describe('loadRegistry', () => {
  it('returns empty array when registry file does not exist', () => {
    const configs = loadRegistry();
    expect(configs).toEqual([]);
  });

  it('loads valid kshetra configs from registry', () => {
    const configPath = join(kshetraDir, 'kshetra.yaml');
    writeFileSync(configPath, VALID_YAML);

    registerKshetra('myapp', configPath);
    const configs = loadRegistry();

    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('myapp');
  });

  it('skips entries where config file is missing and logs a warning', () => {
    const missingPath = join(kshetraDir, 'nonexistent.yaml');
    mkdirSync(join(dir, '.shreni'), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      kshetras: [{ id: 'ghost', configPath: missingPath, registeredAt: new Date().toISOString() }],
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configs = loadRegistry();
    warnSpy.mockRestore();

    expect(configs).toHaveLength(0);
  });

  it('skips invalid configs and continues loading others', () => {
    const goodPath = join(kshetraDir, 'good.yaml');
    const badPath = join(kshetraDir, 'bad.yaml');
    writeFileSync(goodPath, VALID_YAML);
    writeFileSync(badPath, 'id: INVALID ID\nname: Bad');

    mkdirSync(join(dir, '.shreni'), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      kshetras: [
        { id: 'myapp', configPath: goodPath, registeredAt: new Date().toISOString() },
        { id: 'bad', configPath: badPath, registeredAt: new Date().toISOString() },
      ],
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configs = loadRegistry();
    warnSpy.mockRestore();

    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('myapp');
  });
});

describe('registerKshetra', () => {
  it('creates registry file if it does not exist', () => {
    const configPath = join(kshetraDir, 'kshetra.yaml');
    writeFileSync(configPath, VALID_YAML);

    registerKshetra('myapp', configPath);

    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(raw.kshetras).toHaveLength(1);
    expect(raw.kshetras[0].id).toBe('myapp');
  });

  it('updates existing entry on re-register with same id', () => {
    const configPath1 = join(kshetraDir, 'v1.yaml');
    const configPath2 = join(kshetraDir, 'v2.yaml');
    writeFileSync(configPath1, VALID_YAML);
    writeFileSync(configPath2, VALID_YAML);

    registerKshetra('myapp', configPath1);
    registerKshetra('myapp', configPath2);

    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(raw.kshetras).toHaveLength(1);
    expect(raw.kshetras[0].configPath).toContain('v2.yaml');
  });
});

describe('unregisterKshetra', () => {
  it('removes a kshetra entry from the registry', () => {
    const configPath = join(kshetraDir, 'kshetra.yaml');
    writeFileSync(configPath, VALID_YAML);

    registerKshetra('myapp', configPath);
    unregisterKshetra('myapp');

    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(raw.kshetras).toHaveLength(0);
  });

  it('is a no-op if kshetra id is not found', () => {
    expect(() => unregisterKshetra('nonexistent')).not.toThrow();
  });
});
