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

// ── import after mocks ────────────────────────────────────────────────────────

const { runRegister } = await import('./register.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: 'git@github.com:TeakWood/sishya.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: 'git@github.com:TeakWood/sishya-beads.git', mode: 'embedded' as const },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadKshetraConfig.mockReturnValue(VALID_CONFIG);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runRegister', () => {
  it('loads kshetra.yaml from the given path', () => {
    runRegister('/projects/sishya');
    expect(mockLoadKshetraConfig).toHaveBeenCalledWith(join('/projects/sishya', 'kshetra.yaml'));
  });

  it('resolves relative paths to absolute', () => {
    runRegister('./sishya');
    const call = mockLoadKshetraConfig.mock.calls[0][0] as string;
    expect(call).toMatch(/^\/.*kshetra\.yaml$/);
  });

  it('calls registerKshetra with config id and absolute configPath', () => {
    runRegister('/projects/sishya');
    expect(mockRegisterKshetra).toHaveBeenCalledWith(
      'sishya',
      join('/projects/sishya', 'kshetra.yaml'),
    );
  });

  it('returns registered status with id and configPath', () => {
    const result = runRegister('/projects/sishya');
    expect(result.status).toBe('registered');
    expect(result.id).toBe('sishya');
    expect(result.configPath).toBe(join('/projects/sishya', 'kshetra.yaml'));
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