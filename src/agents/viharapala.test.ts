import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, SilpiOutput, Task } from '../sthapathi/types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockCreate = vi.fn<(params: object) => Promise<object>>();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

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

const VALID_APPROVE = {
  verdict: 'APPROVE',
  overallScore: 90,
  mustFix: [],
  suggestions: ['consider caching tokens'],
  issues: [],
  insights: ['token refresh pattern reusable'],
};

const VALID_REJECT = {
  verdict: 'REJECT',
  overallScore: 40,
  mustFix: ['Missing error handling for 500 responses'],
  suggestions: [],
  issues: [{ severity: 'blocker', file: 'src/auth.ts', description: 'No 500 handling' }],
  insights: [],
};

function makeApiResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify(VALID_APPROVE)));
});

// ── runViharapala ─────────────────────────────────────────────────────────────

describe('runViharapala', () => {
  it('returns parsed ViharapalaOutput on APPROVE', async () => {
    const result = await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    expect(result).toEqual(VALID_APPROVE);
  });

  it('returns parsed ViharapalaOutput on REJECT', async () => {
    mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify(VALID_REJECT)));
    const result = await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    expect(result).toEqual(VALID_REJECT);
  });

  it('uses the model from kshetra config', async () => {
    await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('sends a different model when config changes', async () => {
    const ctx = { ...CONTEXT, kshetra: { ...KSHETRA, agents: { ...KSHETRA.agents, model: 'claude-opus-4-8' } } };
    await runViharapala(ctx, SILPI_OUTPUT, 1, '');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-8' }),
    );
  });

  describe('system prompt sections', () => {
    it('identifies Viharapala by project name', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('Viharapala');
      expect(call.system).toContain('Sishya');
    });

    it('includes TASK AND ACCEPTANCE CRITERIA section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== TASK AND ACCEPTANCE CRITERIA ==');
      expect(call.system).toContain('proj-42');
    });

    it("includes SILPI'S OUTPUT section with round number", async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 2, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain("== SILPI'S OUTPUT (Round 2) ==");
    });

    it("includes silpi output JSON in SILPI'S OUTPUT section", async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('Fixed auth bug by refreshing tokens on 401');
    });

    it('includes FULL ROUND HISTORY section when history is provided', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 2, 'Round 1: submitted for review\nRound 1: REJECT');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== FULL ROUND HISTORY ==');
      expect(call.system).toContain('Round 1: REJECT');
    });

    it('omits FULL ROUND HISTORY section when history is empty', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== FULL ROUND HISTORY ==');
    });

    it('includes REVIEW DIMENSIONS section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== REVIEW DIMENSIONS ==');
      expect(call.system).toContain('Correctness');
      expect(call.system).toContain('Test coverage');
    });

    it('includes ROLE BOUNDARY section', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== ROLE BOUNDARY ==');
    });

    it('ROLE BOUNDARY prohibits bd calls', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('do NOT call bd');
    });

    it('includes PROJECT MEMORY section when set', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== PROJECT MEMORY ==');
      expect(call.system).toContain('project memory');
    });

    it('omits PROJECT MEMORY section when empty', async () => {
      const ctx = { ...CONTEXT, projectMemory: '' };
      await runViharapala(ctx, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== PROJECT MEMORY ==');
    });

    it('includes SKILLS section when skills are provided', async () => {
      const ctx = { ...CONTEXT, projectSkills: 'use pnpm' };
      await runViharapala(ctx, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== SKILLS ==');
      expect(call.system).toContain('use pnpm');
    });

    it('omits SKILLS section when all skills are empty', async () => {
      await runViharapala(CONTEXT, SILPI_OUTPUT, 1, '');
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== SKILLS ==');
    });
  });

  describe('error handling', () => {
    it('throws when response has no text block', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
        stop_reason: 'tool_use',
      });
      await expect(runViharapala(CONTEXT, SILPI_OUTPUT, 1, '')).rejects.toThrow('no text block');
    });

    it('throws when content array is empty', async () => {
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
      await expect(runViharapala(CONTEXT, SILPI_OUTPUT, 1, '')).rejects.toThrow();
    });

    it('propagates JSON parse errors for invalid response', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('not json'));
      await expect(runViharapala(CONTEXT, SILPI_OUTPUT, 1, '')).rejects.toThrow();
    });
  });
});