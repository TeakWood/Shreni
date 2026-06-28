import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, Task, SilpiOutput, ViharapalaOutput } from '../sthapathi/types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockRunClaudeAgent = vi.fn<() => Promise<object>>();
vi.mock('./runner.js', () => ({ runAgent: mockRunClaudeAgent, runClaudeAgent: mockRunClaudeAgent }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { runSilpi } = await import('./silpi.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'sishya',
  name: 'Sishya',
  repo: {
    path: '/projects/sishya',
    remote: 'git@github.com:TeakWood/sishya.git',
    mainBranch: 'main',
    branchPattern: 'bead-{id}/{slug}',
  },
  beads: {
    path: '/projects/sishya-beads',
    remote: 'git@github.com:TeakWood/sishya-beads.git',
    mode: 'embedded',
  },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const TASK: Task = {
  id: 'proj-42',
  slug: 'fix-auth',
  title: 'Fix auth',
  description: 'Auth is broken',
  status: 'pending',
  priority: 2,
};

const CONTEXT: AgentContext = {
  kshetra: KSHETRA,
  task: TASK,
  projectMemory: 'project memory content',
  taskDetails: 'Task ID: proj-42\nTitle: Fix auth\nDescription: Auth is broken',
  universalSkills: '',
  projectSkills: '',
  scopedSkills: '',
  conventions: '',
  architecture: '',
  ragChunks: '',
};

const VALID_OUTPUT: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '- old\n+ new' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth bug by refreshing tokens on 401',
  confidenceScore: 85,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: ['Token refresh logic was missing'],
};

function makeRunnerResult(output: SilpiOutput) {
  return { structuredOutput: output, resultText: null, toolCallCount: 3 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunClaudeAgent.mockResolvedValue(makeRunnerResult(VALID_OUTPUT));
});

// ── runSilpi ──────────────────────────────────────────────────────────────────

describe('runSilpi', () => {
  it('returns parsed SilpiOutput from structured output', async () => {
    const result = await runSilpi(CONTEXT, 1);
    expect(result).toEqual(VALID_OUTPUT);
  });

  it('uses the model from kshetra config', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { model: string };
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('sends a different model when config changes', async () => {
    const ctx = { ...CONTEXT, kshetra: { ...KSHETRA, agents: { ...KSHETRA.agents, provider: 'anthropic', model: 'claude-opus-4-8' } } };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { model: string };
    expect(opts.model).toBe('claude-opus-4-8');
  });

  it('sets cwd to kshetra repo path', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { cwd: string };
    expect(opts.cwd).toBe('/projects/sishya');
  });

  it('sets agentName to silpi', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { agentName: string };
    expect(opts.agentName).toBe('silpi');
  });

  it('includes task id in the system prompt via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('proj-42');
  });

  it('includes task title in the system prompt via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('Fix auth');
  });

  it('includes round number in the TASK section', async () => {
    await runSilpi(CONTEXT, 2);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('Round: 2');
  });

  it('includes task description via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('Auth is broken');
  });

  it('includes PROJECT MEMORY section when projectMemory is set', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== PROJECT MEMORY ==');
    expect(opts.systemPrompt).toContain('project memory content');
  });

  it('omits PROJECT MEMORY section when projectMemory is empty', async () => {
    const ctx = { ...CONTEXT, projectMemory: '' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== PROJECT MEMORY ==');
  });

  it('includes TASK section', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== TASK ==');
  });

  it('includes ROLE BOUNDARY section', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== ROLE BOUNDARY ==');
  });

  it('system prompt tells Silpi not to call bd commands', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt.toLowerCase()).toContain('bd');
  });

  it('includes SKILLS section when skills are provided', async () => {
    const ctx = { ...CONTEXT, projectSkills: 'use pnpm', universalSkills: 'write tests' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== SKILLS ==');
    expect(opts.systemPrompt).toContain('use pnpm');
    expect(opts.systemPrompt).toContain('write tests');
  });

  it('omits SKILLS section when all skills are empty', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== SKILLS ==');
  });

  it('includes CONVENTIONS section when conventions is set', async () => {
    const ctx = { ...CONTEXT, conventions: 'no magic numbers' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== CONVENTIONS ==');
    expect(opts.systemPrompt).toContain('no magic numbers');
  });

  it('includes ARCHITECTURE section when architecture is set', async () => {
    const ctx = { ...CONTEXT, architecture: 'layered architecture' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== ARCHITECTURE ==');
    expect(opts.systemPrompt).toContain('layered architecture');
  });

  it('includes RELEVANT CODE section when ragChunks is set', async () => {
    const ctx = { ...CONTEXT, ragChunks: 'function foo() {}' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== RELEVANT CODE ==');
    expect(opts.systemPrompt).toContain('function foo() {}');
  });

  it('includes branch name in system prompt and user prompt', async () => {
    await runSilpi(CONTEXT, 1, null, 'bead-proj-42/fix-auth');
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string; userPrompt: string };
    expect(opts.systemPrompt).toContain('bead-proj-42/fix-auth');
    expect(opts.userPrompt).toContain('bead-proj-42/fix-auth');
  });

  describe('PRIOR FEEDBACK section', () => {
    const REJECT_FEEDBACK: ViharapalaOutput = {
      verdict: 'REJECT',
      overallScore: 40,
      mustFix: ['Add error handling', 'Fix the type errors'],
      suggestions: [],
      issues: [],
      insights: [],
    };

    it('includes PRIOR FEEDBACK section when feedback has mustFix items', async () => {
      await runSilpi(CONTEXT, 2, REJECT_FEEDBACK);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== PRIOR FEEDBACK');
      expect(opts.systemPrompt).toContain('Add error handling');
      expect(opts.systemPrompt).toContain('Fix the type errors');
    });

    it('includes round number in PRIOR FEEDBACK section', async () => {
      await runSilpi(CONTEXT, 3, REJECT_FEEDBACK);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('(Round 3)');
    });

    it('omits PRIOR FEEDBACK section when feedback is null', async () => {
      await runSilpi(CONTEXT, 1, null);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== PRIOR FEEDBACK');
    });

    it('omits PRIOR FEEDBACK section when feedback has no mustFix', async () => {
      const feedbackNoFix: ViharapalaOutput = { ...REJECT_FEEDBACK, mustFix: [] };
      await runSilpi(CONTEXT, 2, feedbackNoFix);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== PRIOR FEEDBACK');
    });

    it('omits PRIOR FEEDBACK section when no feedback provided', async () => {
      await runSilpi(CONTEXT, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== PRIOR FEEDBACK');
    });
  });

  it('throws ParseError when runner returns no structured output', async () => {
    mockRunClaudeAgent.mockResolvedValue({ structuredOutput: null, resultText: 'some text', toolCallCount: 0 });
    await expect(runSilpi(CONTEXT, 1)).rejects.toThrow('no structured output');
  });
});
