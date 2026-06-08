import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, AgentContext, SilpiOutput, ViharapalaOutput } from './types.js';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockBdAddNote = vi.fn<() => Promise<string>>();

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ addNote: mockBdAddNote })),
  syncBeads: vi.fn(),
  BeadsError: class BeadsError extends Error {},
}));

const mockRunSilpi = vi.fn<() => Promise<SilpiOutput>>();
vi.mock('../agents/silpi.js', () => ({ runSilpi: mockRunSilpi }));

const mockRunViharapala = vi.fn<() => Promise<ViharapalaOutput>>();
vi.mock('../agents/viharapala.js', () => ({ runViharapala: mockRunViharapala }));

// withRetry passes through unless the error is retryable — use zero-delay config
vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  // Re-export withRetry with zero delays so tests don't wait
  return {
    ...actual,
    AGENT_RETRY_CONFIG: { ...actual.AGENT_RETRY_CONFIG, initialDelayMs: 0, maxDelayMs: 0 },
  };
});

// ── imports after mocks ───────────────────────────────────────────────────────

const { runSilpiSafe, runViharapalaSafe } = await import('./dispatch.js');
const { ParseError, AgentError } = await import('./errors.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/sishya-beads', remote: '' },
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
} as unknown as KshetraConfig;

const TASK: Task = {
  id: 'bead-42',
  slug: 'fix-bug',
  title: 'Fix bug',
  status: 'in_progress',
  priority: 1,
};

const CONTEXT = {
  kshetra: KSHETRA,
  task: TASK,
  taskDetails: 'task details',
  projectMemory: '',
  universalSkills: '',
  projectSkills: '',
  scopedSkills: '',
  conventions: '',
  architecture: '',
  ragChunks: '',
} as AgentContext;

const SILPI_OK: SilpiOutput = {
  filesChanged: [{ path: 'src/a.ts', diff: '+1' }],
  testFiles: ['src/a.test.ts'],
  summary: 'done',
  confidenceScore: 90,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

const VIHARAPALA_OK: ViharapalaOutput = {
  verdict: 'APPROVE',
  overallScore: 95,
  mustFix: [],
  suggestions: [],
  issues: [],
  insights: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBdAddNote.mockResolvedValue('ok');
});

// ── runSilpiSafe ──────────────────────────────────────────────────────────────

describe('runSilpiSafe', () => {
  it('adds "dispatching Silpi" note before calling runSilpi', async () => {
    mockRunSilpi.mockResolvedValue(SILPI_OK);
    await runSilpiSafe(KSHETRA, TASK, CONTEXT, 1);
    expect(mockBdAddNote).toHaveBeenCalledWith('bead-42', 'Round 1: dispatching Silpi');
  });

  it('adds "Silpi submitted" note after success', async () => {
    mockRunSilpi.mockResolvedValue(SILPI_OK);
    await runSilpiSafe(KSHETRA, TASK, CONTEXT, 1);
    expect(mockBdAddNote).toHaveBeenCalledWith('bead-42', 'Round 1: Silpi submitted');
  });

  it('returns SilpiOutput on success', async () => {
    mockRunSilpi.mockResolvedValue(SILPI_OK);
    const result = await runSilpiSafe(KSHETRA, TASK, CONTEXT, 1);
    expect(result).toEqual(SILPI_OK);
  });

  it('throws AgentError MALFORMED_OUTPUT on ParseError', async () => {
    mockRunSilpi.mockRejectedValue(new ParseError('bad json'));
    await expect(runSilpiSafe(KSHETRA, TASK, CONTEXT, 1)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentError && (e as AgentError).kind === 'MALFORMED_OUTPUT',
    );
  });

  it('adds malformed note on ParseError', async () => {
    mockRunSilpi.mockRejectedValue(new ParseError('unexpected token'));
    await expect(runSilpiSafe(KSHETRA, TASK, CONTEXT, 1)).rejects.toThrow();
    expect(mockBdAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('Silpi output malformed'),
    );
  });

  it('throws AgentError API_FAILURE on non-parse error', async () => {
    const apiErr = Object.assign(new Error('network failure'), { status: 500 });
    mockRunSilpi.mockRejectedValue(apiErr);
    await expect(runSilpiSafe(KSHETRA, TASK, CONTEXT, 1)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentError && (e as AgentError).kind === 'API_FAILURE',
    );
  });

  it('adds "failed after retries" note on API failure', async () => {
    mockRunSilpi.mockRejectedValue(new Error('timeout'));
    await expect(runSilpiSafe(KSHETRA, TASK, CONTEXT, 1)).rejects.toThrow();
    expect(mockBdAddNote).toHaveBeenCalledWith(
      'bead-42',
      expect.stringContaining('Silpi failed after retries'),
    );
  });
});

// ── runViharapalaSafe ─────────────────────────────────────────────────────────

describe('runViharapalaSafe', () => {
  it('adds "dispatching Viharapala" note before calling runViharapala', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_OK);
    await runViharapalaSafe(KSHETRA, TASK, CONTEXT, SILPI_OK, 1);
    expect(mockBdAddNote).toHaveBeenCalledWith('bead-42', 'Round 1: dispatching Viharapala');
  });

  it('adds verdict note after success', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_OK);
    await runViharapalaSafe(KSHETRA, TASK, CONTEXT, SILPI_OK, 1);
    expect(mockBdAddNote).toHaveBeenCalledWith('bead-42', 'Round 1: APPROVE');
  });

  it('returns ViharapalaOutput on success', async () => {
    mockRunViharapala.mockResolvedValue(VIHARAPALA_OK);
    const result = await runViharapalaSafe(KSHETRA, TASK, CONTEXT, SILPI_OK, 1);
    expect(result).toEqual(VIHARAPALA_OK);
  });

  it('throws AgentError MALFORMED_OUTPUT on ParseError', async () => {
    mockRunViharapala.mockRejectedValue(new ParseError('bad json'));
    await expect(runViharapalaSafe(KSHETRA, TASK, CONTEXT, SILPI_OK, 1)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentError && (e as AgentError).kind === 'MALFORMED_OUTPUT',
    );
  });

  it('throws AgentError API_FAILURE on non-parse error', async () => {
    mockRunViharapala.mockRejectedValue(new Error('API error'));
    await expect(runViharapalaSafe(KSHETRA, TASK, CONTEXT, SILPI_OK, 1)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentError && (e as AgentError).kind === 'API_FAILURE',
    );
  });
});