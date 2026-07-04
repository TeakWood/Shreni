import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockLoadKshetraConfig = vi.fn();
const mockKshetraConfigError = class extends Error {
  constructor(public configPath: string, message: string, public cause?: unknown) {
    super(`[${configPath}] ${message}`);
    this.name = 'KshetraConfigError';
  }
};

vi.mock('../kshetra/config.js', () => ({
  loadKshetraConfig: mockLoadKshetraConfig,
  KshetraConfigError: mockKshetraConfigError,
}));

const mockRegisterKshetra = vi.fn();
vi.mock('../kshetra/registry.js', () => ({ registerKshetra: mockRegisterKshetra }));

const mockExistsSync = vi.fn<(p: string) => boolean>();
vi.mock('fs', () => ({ existsSync: mockExistsSync }));

// ── import after mocks ────────────────────────────────────────────────────────

const { runRegister } = await import('./register.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' as const },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadKshetraConfig.mockReturnValue(VALID_CONFIG);
  // Default: no canonical .shreni/ file, so register uses the legacy root path.
  mockExistsSync.mockReturnValue(false);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runRegister', () => {
  it('loads legacy root kshetra.yaml when no .shreni/ config exists', () => {
    runRegister('/projects/myapp');
    expect(mockLoadKshetraConfig).toHaveBeenCalledWith(join('/projects/myapp', 'kshetra.yaml'));
  });

  it('prefers the canonical .shreni/kshetra.yaml when it exists', () => {
    const canonical = join('/projects/myapp', '.shreni', 'kshetra.yaml');
    mockExistsSync.mockImplementation((p: string) => p === canonical);
    const result = runRegister('/projects/myapp');
    expect(mockLoadKshetraConfig).toHaveBeenCalledWith(canonical);
    expect(result.configPath).toBe(canonical);
  });

  it('resolves relative paths to absolute', () => {
    runRegister('./myapp');
    const call = mockLoadKshetraConfig.mock.calls[0][0] as string;
    expect(call).toMatch(/^\/.*kshetra\.yaml$/);
  });

  it('calls registerKshetra with config id and absolute configPath', () => {
    runRegister('/projects/myapp');
    expect(mockRegisterKshetra).toHaveBeenCalledWith(
      'myapp',
      join('/projects/myapp', 'kshetra.yaml'),
    );
  });

  it('returns registered status with id and configPath', () => {
    const result = runRegister('/projects/myapp');
    expect(result.status).toBe('registered');
    expect(result.id).toBe('myapp');
    expect(result.configPath).toBe(join('/projects/myapp', 'kshetra.yaml'));
  });

  it('throws KshetraConfigError when kshetra.yaml is missing or invalid', () => {
    mockLoadKshetraConfig.mockImplementation(() => {
      throw new mockKshetraConfigError('/projects/bad/kshetra.yaml', 'Cannot read file: ENOENT');
    });
    expect(() => runRegister('/projects/bad')).toThrow('Cannot read file: ENOENT');
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });

  it('does not register when config validation fails', () => {
    mockLoadKshetraConfig.mockImplementation(() => {
      throw new mockKshetraConfigError('/projects/bad/kshetra.yaml', 'Schema validation failed');
    });
    expect(() => runRegister('/projects/bad')).toThrow();
    expect(mockRegisterKshetra).not.toHaveBeenCalled();
  });
});