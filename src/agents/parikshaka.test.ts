import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task, ParikshakaOutput } from '../sthapathi/types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockRunClaudeAgent = vi.fn<() => Promise<object>>();
vi.mock('./runner.js', () => ({ runClaudeAgent: mockRunClaudeAgent }));

// ── import after mocks ────────────────────────────────────────────────────────

const { runParikshaka } = await import('./parikshaka.js');

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

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    kshetra: KSHETRA,
    task: TASK,
    mergedDiff: '--- src/auth.ts\n+new code',
    existingTestFiles: ['src/login.test.ts'],
    ...overrides,
  };
}

function makeRunnerResult(output: ParikshakaOutput) {
  return { structuredOutput: output, resultText: null, toolCallCount: 4 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunClaudeAgent.mockResolvedValue(makeRunnerResult(VALID_OUTPUT));
});

// ── buildParikshakaSystemPrompt (via runner capture) ──────────────────────────

describe('buildParikshakaSystemPrompt', () => {
  it('includes the kshetra name', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('Sishya');
  });

  it('includes existing test files', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('src/login.test.ts');
  });

  it('shows (none) when no test files exist', async () => {
    await runParikshaka(makeCtx({ existingTestFiles: [] }));
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('(none)');
  });

  it('includes the merged diff', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('--- src/auth.ts');
  });

  it('includes the task id and title', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('proj-42');
    expect(opts.systemPrompt).toContain('Fix auth');
  });

  it('includes personas when provided', async () => {
    await runParikshaka(makeCtx({ personas: 'admin: can do everything' }));
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('admin: can do everything');
  });

  it('omits PERSONAS section when not provided', async () => {
    await runParikshaka(makeCtx({ personas: undefined }));
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== PERSONAS ==');
  });

  it('contains the role boundary prohibiting bd calls', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('Do NOT call bd');
  });
});

// ── runParikshaka ─────────────────────────────────────────────────────────────

describe('runParikshaka', () => {
  it('calls runner with the kshetra model', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { model: string };
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('sets agentName to parikshaka', async () => {
    await runParikshaka(makeCtx());
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { agentName: string };
    expect(opts.agentName).toBe('parikshaka');
  });

  it('returns parsed ParikshakaOutput on success', async () => {
    const result = await runParikshaka(makeCtx());
    expect(result.testFilesAdded).toEqual(['src/auth.e2e.ts']);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].priority).toBe(2);
  });

  it('throws ParseError when runner returns no structured output', async () => {
    mockRunClaudeAgent.mockResolvedValue({ structuredOutput: null, resultText: 'some text', toolCallCount: 0 });
    await expect(runParikshaka(makeCtx())).rejects.toThrow('no structured output');
  });
});
