import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, SilpiOutput, Task, ViharapalaOutput } from '../sthapathi/types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockRunClaudeAgent = vi.fn<() => Promise<object>>();
vi.mock('./runner.js', () => ({ runClaudeAgent: mockRunClaudeAgent }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { runViharapala } = await import('./viharapala.js');

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
  agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
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
  projectMemory: 'project memory',
  taskDetails: 'Task ID: proj-42\nTitle: Fix auth\nAcceptance: tokens refresh on 401',
  universalSkills: '',
  projectSkills: '',
  scopedSkills: '',
  conventions: '',
  architecture: '',
  ragChunks: '',
};

const SILPI_OUTPUT: SilpiOutput = {
  filesChanged: [{ path: 'src/auth.ts', diff: '- old\n+ new' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth bug by refreshing tokens on 401',
  confidenceScore: 85,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: [],
};

const VALID_APPROVE: ViharapalaOutput = {
  verdict: 'APPROVE',
  overallScore: 90,
  mustFix: [],
  suggestions: ['consider caching tokens'],
  issues: [],
  insights: ['token refresh pattern reusable'],
};

const VALID_REJECT: ViharapalaOutput = {
  verdict: 'REJECT',
  overallScore: 40,
  mustFix: ['Missing error handling for 500 responses'],
  suggestions: [],
  issues: [{ severity: 'blocker', file: 'src/auth.ts', description: 'No 500 handling' }],
  insights: [],
};

function makeRunnerResult(output: ViharapalaOutput) {
  return { structuredOutput: output, resultText: null, toolCallCount: 2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunClaudeAgent.mockResolvedValue(makeRunnerResult(VALID_APPROVE));
});

// ── runViharapala ─────────────────────────────────────────────────────────────

describe('runViharapala', () => {
  it('returns parsed ViharapalaOutput on APPROVE', async () => {
    const result = await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    expect(result).toEqual(VALID_APPROVE);
  });

  it('returns parsed ViharapalaOutput on REJECT', async () => {
    mockRunClaudeAgent.mockResolvedValue(makeRunnerResult(VALID_REJECT));
    const result = await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    expect(result).toEqual(VALID_REJECT);
  });

  it('uses the model from kshetra config', async () => {
    await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { model: string };
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('sends a different model when config changes', async () => {
    const ctx = { ...CONTEXT, kshetra: { ...KSHETRA, agents: { ...KSHETRA.agents, model: 'claude-opus-4-8' } } };
    await runViharapala(ctx, SILPI_OUTPUT, 1, '');
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { model: string };
    expect(opts.model).toBe('claude-opus-4-8');
  });

  it('sets agentName to viharapala', async () => {
    await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { agentName: string };
    expect(opts.agentName).toBe('viharapala');
  });

  it('sets cwd to kshetra repo path', async () => {
    await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { cwd: string };
    expect(opts.cwd).toBe('/projects/sishya');
  });

  describe('system prompt sections', () => {
    it('identifies Viharapala by project name', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('Viharapala');
      expect(opts.systemPrompt).toContain('Sishya');
    });

    it('includes TASK AND ACCEPTANCE CRITERIA section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== TASK AND ACCEPTANCE CRITERIA ==');
      expect(opts.systemPrompt).toContain('proj-42');
    });

    it("includes SILPI'S SUMMARY section with round number", async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 2, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain("== SILPI'S SUMMARY (Round 2");
    });

    it("includes silpi output JSON in SILPI'S SUMMARY section", async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('Fixed auth bug by refreshing tokens on 401');
    });

    it('includes FULL ROUND HISTORY section when history is provided', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 2, 'Round 1: submitted for review\nRound 1: REJECT');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== FULL ROUND HISTORY ==');
      expect(opts.systemPrompt).toContain('Round 1: REJECT');
    });

    it('omits FULL ROUND HISTORY section when history is empty', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== FULL ROUND HISTORY ==');
    });

    it('includes REVIEW DIMENSIONS section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== REVIEW DIMENSIONS ==');
      expect(opts.systemPrompt).toContain('Correctness');
      expect(opts.systemPrompt).toContain('Test coverage');
    });

    it('includes ROLE BOUNDARY section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== ROLE BOUNDARY ==');
    });

    it('ROLE BOUNDARY prohibits bd calls', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt.toLowerCase()).toContain('bd');
    });

    it('includes PROJECT MEMORY section when set', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== PROJECT MEMORY ==');
      expect(opts.systemPrompt).toContain('project memory');
    });

    it('omits PROJECT MEMORY section when empty', async () => {
      const ctx = { ...CONTEXT, projectMemory: '' };
      await runViharapala(ctx, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== PROJECT MEMORY ==');
    });

    it('includes SKILLS section when skills are provided', async () => {
      const ctx = { ...CONTEXT, projectSkills: 'use pnpm' };
      await runViharapala(ctx, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== SKILLS ==');
      expect(opts.systemPrompt).toContain('use pnpm');
    });

    it('omits SKILLS section when all skills are empty', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== SKILLS ==');
    });
  });

  describe('error handling', () => {
    it('throws ParseError when runner returns no structured output', async () => {
      mockRunClaudeAgent.mockResolvedValue({ structuredOutput: null, resultText: 'some text', toolCallCount: 0 });
      await expect(runViharapala(CONTEXT, SILPI_OUTPUT, 1, '')).rejects.toThrow('no structured output');
    });
  });
});
