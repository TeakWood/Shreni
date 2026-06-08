import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, ParikshakaOutput } from '../sthapathi/types.js';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockCreate = vi.fn<(params: object) => Promise<object>>();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

vi.mock('../sthapathi/errors.js', () => ({
  ParseError: class ParseError extends Error {
    constructor(message: string, public cause?: unknown) { super(message); }
  },
}));

// ── import after mocks ────────────────────────────────────────────────────────

const { runParikshaka, buildParikshakaSystemPrompt } = await import('./parikshaka.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: 'git@github.com:TeakWood/sishya.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/sishya-beads', remote: 'git@github.com:TeakWood/sishya-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  status: 'in_progress',
  priority: 2,
};

const VALID_OUTPUT: ParikshakaOutput = {
  testFilesAdded: ['src/auth.e2e.ts'],
  coverageGaps: [{ feature: 'refresh', description: 'Test token refresh flow', priority: 2 }],
};

function makeCtx(overrides = {}) {
  return {
    kshetra: KSHETRA,
    task: TASK,
    mergedDiff: '--- src/auth.ts\n+new code',
    existingTestFiles: ['src/login.test.ts'],
    ...overrides,
  };
}

function apiResponse(output: unknown) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(output) }],
  });
}

beforeEach(() => vi.clearAllMocks());

// ── buildParikshakaSystemPrompt ───────────────────────────────────────────────

describe('buildParikshakaSystemPrompt', () => {
  it('includes the kshetra name', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx());
    expect(prompt).toContain('Sishya');
  });

  it('includes existing test files', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx());
    expect(prompt).toContain('src/login.test.ts');
  });

  it('shows (none) when no test files exist', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx({ existingTestFiles: [] }));
    expect(prompt).toContain('(none)');
  });

  it('includes the merged diff', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx());
    expect(prompt).toContain('--- src/auth.ts');
  });

  it('includes the task id and title', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx());
    expect(prompt).toContain('proj-42');
    expect(prompt).toContain('Fix auth');
  });

  it('includes personas when provided', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx({ personas: 'admin: can do everything' }));
    expect(prompt).toContain('admin: can do everything');
  });

  it('omits PERSONAS section when not provided', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx({ personas: undefined }));
    expect(prompt).not.toContain('== PERSONAS ==');
  });

  it('contains the role boundary prohibiting bd calls', () => {
    const prompt = buildParikshakaSystemPrompt(makeCtx());
    expect(prompt).toContain('Do NOT call bd');
  });
});

// ── runParikshaka ─────────────────────────────────────────────────────────────

describe('runParikshaka', () => {
  it('calls Claude with the kshetra model', async () => {
    apiResponse(VALID_OUTPUT);
    await runParikshaka(makeCtx());
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('returns parsed ParikshakaOutput on success', async () => {
    apiResponse(VALID_OUTPUT);
    const result = await runParikshaka(makeCtx());
    expect(result.testFilesAdded).toEqual(['src/auth.e2e.ts']);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].priority).toBe(2);
  });

  it('throws ParseError when Claude returns invalid JSON', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }],
    });
    await expect(runParikshaka(makeCtx())).rejects.toThrow('Parikshaka: invalid JSON');
  });

  it('throws when Claude response has no text block', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    await expect(runParikshaka(makeCtx())).rejects.toThrow('no text block');
  });
});