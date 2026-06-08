import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

const mockPauseKshetra = vi.fn<() => void>();
const mockResumeKshetra = vi.fn<() => void>();
vi.mock('../kshetra/state', () => ({
  pauseKshetra: mockPauseKshetra,
  resumeKshetra: mockResumeKshetra,
  loadState: vi.fn(() => ({ kshetras: {} })),
  isKshetraManuallyPaused: vi.fn(() => false),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

const { pauseKshetraById, resumeKshetraById } = await import('./pause');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRegistry.mockReturnValue([KSHETRA]);
});

// ── pauseKshetraById ──────────────────────────────────────────────────────────

describe('pauseKshetraById', () => {
  it('returns paused for a known kshetra id', () => {
    const result = pauseKshetraById('sishya');
    expect(result).toEqual({ status: 'paused', id: 'sishya' });
  });

  it('calls pauseKshetra with manual:true', () => {
    pauseKshetraById('sishya');
    expect(mockPauseKshetra).toHaveBeenCalledWith(
      KSHETRA,
      expect.objectContaining({ manual: true }),
    );
  });

  it('sets reason to "manual"', () => {
    pauseKshetraById('sishya');
    expect(mockPauseKshetra).toHaveBeenCalledWith(
      KSHETRA,
      expect.objectContaining({ reason: 'manual' }),
    );
  });

  it('returns not_found for an unknown id', () => {
    const result = pauseKshetraById('unknown-id');
    expect(result).toEqual({ status: 'not_found', id: 'unknown-id' });
    expect(mockPauseKshetra).not.toHaveBeenCalled();
  });
});

// ── resumeKshetraById ─────────────────────────────────────────────────────────

describe('resumeKshetraById', () => {
  it('returns resumed for a known kshetra id', () => {
    const result = resumeKshetraById('sishya');
    expect(result).toEqual({ status: 'resumed', id: 'sishya' });
  });

  it('calls resumeKshetra with the correct kshetra', () => {
    resumeKshetraById('sishya');
    expect(mockResumeKshetra).toHaveBeenCalledWith(KSHETRA);
  });

  it('returns not_found for an unknown id', () => {
    const result = resumeKshetraById('ghost');
    expect(result).toEqual({ status: 'not_found', id: 'ghost' });
    expect(mockResumeKshetra).not.toHaveBeenCalled();
  });
});