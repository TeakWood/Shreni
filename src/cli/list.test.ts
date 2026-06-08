import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry.js', () => ({ loadRegistry: mockLoadRegistry }));

const mockLoadState = vi.fn();
vi.mock('../kshetra/state.js', () => ({ loadState: mockLoadState }));

// ── import after mocks ────────────────────────────────────────────────────────

const { buildKshetraRows, formatKshetraList, runList } = await import('./list.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeKshetra(overrides: Partial<KshetraConfig> = {}): KshetraConfig {
  return {
    id: 'sishya',
    name: 'Sishya',
    repo: { path: '/projects/sishya', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: '/projects/sishya-beads', remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadState.mockReturnValue({ kshetras: {} });
});

// ── buildKshetraRows ──────────────────────────────────────────────────────────

describe('buildKshetraRows', () => {
  it('returns empty array when no kshetras are registered', () => {
    mockLoadRegistry.mockReturnValue([]);
    expect(buildKshetraRows()).toEqual([]);
  });

  it('returns active status for non-paused kshetra', () => {
    mockLoadRegistry.mockReturnValue([makeKshetra()]);
    const [row] = buildKshetraRows();
    expect(row?.status).toBe('active');
  });

  it('returns paused status for paused kshetra without manual resume', () => {
    mockLoadRegistry.mockReturnValue([makeKshetra()]);
    mockLoadState.mockReturnValue({
      kshetras: { sishya: { paused: true, requiresManualResume: false } },
    });
    const [row] = buildKshetraRows();
    expect(row?.status).toBe('paused');
  });

  it('returns paused (manual resume required) for kshetras requiring manual resume', () => {
    mockLoadRegistry.mockReturnValue([makeKshetra()]);
    mockLoadState.mockReturnValue({
      kshetras: { sishya: { paused: true, requiresManualResume: true } },
    });
    const [row] = buildKshetraRows();
    expect(row?.status).toContain('manual resume required');
  });

  it('includes id, name, and repoPath from kshetra config', () => {
    mockLoadRegistry.mockReturnValue([makeKshetra()]);
    const [row] = buildKshetraRows();
    expect(row?.id).toBe('sishya');
    expect(row?.name).toBe('Sishya');
    expect(row?.repoPath).toBe('/projects/sishya');
  });

  it('returns one row per registered kshetra', () => {
    mockLoadRegistry.mockReturnValue([
      makeKshetra({ id: 'sishya', name: 'Sishya' }),
      makeKshetra({ id: 'mandira', name: 'Mandira' }),
    ]);
    expect(buildKshetraRows()).toHaveLength(2);
  });
});

// ── formatKshetraList ─────────────────────────────────────────────────────────

describe('formatKshetraList', () => {
  it('returns no-kshetras message when rows is empty', () => {
    expect(formatKshetraList([])).toContain('No kshetras registered');
  });

  it('includes a header with ID, NAME, STATUS, PATH columns', () => {
    const output = formatKshetraList([
      { id: 'sishya', name: 'Sishya', status: 'active', repoPath: '/projects/sishya' },
    ]);
    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('STATUS');
    expect(output).toContain('PATH');
  });

  it('includes each row with correct fields', () => {
    const output = formatKshetraList([
      { id: 'sishya', name: 'Sishya', status: 'active', repoPath: '/projects/sishya' },
    ]);
    expect(output).toContain('sishya');
    expect(output).toContain('Sishya');
    expect(output).toContain('active');
    expect(output).toContain('/projects/sishya');
  });

  it('includes a separator line', () => {
    const output = formatKshetraList([
      { id: 'a', name: 'A', status: 'active', repoPath: '/a' },
    ]);
    expect(output).toContain('---');
  });

  it('renders multiple rows', () => {
    const output = formatKshetraList([
      { id: 'sishya', name: 'Sishya', status: 'active', repoPath: '/p/sishya' },
      { id: 'mandira', name: 'Mandira', status: 'paused', repoPath: '/p/mandira' },
    ]);
    expect(output).toContain('sishya');
    expect(output).toContain('mandira');
  });
});

// ── runList ───────────────────────────────────────────────────────────────────

describe('runList', () => {
  it('prints the formatted list to stdout', () => {
    mockLoadRegistry.mockReturnValue([makeKshetra()]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runList();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sishya'));
    logSpy.mockRestore();
  });
});