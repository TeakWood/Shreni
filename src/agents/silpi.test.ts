import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, Task, ViharapalaOutput } from '../sthapathi/types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockCreate = vi.fn<(params: object) => Promise<object>>();
const mockAddNote = vi.fn<() => Promise<string>>();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

vi.mock('../sthapathi/beads.js', () => ({
  bd: vi.fn(() => ({ addNote: mockAddNote })),
}));

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
  projectMemory: 'project memory content',
  taskDetails: 'Task ID: proj-42\nTitle: Fix auth\nDescription: Auth is broken',
  universalSkills: '',
  projectSkills: '',
  scopedSkills: '',
  conventions: '',
  architecture: '',
  ragChunks: '',
};

const VALID_OUTPUT = {
  filesChanged: [{ path: 'src/auth.ts', diff: '- old\n+ new' }],
  testFiles: ['src/auth.test.ts'],
  summary: 'Fixed auth bug by refreshing tokens on 401',
  confidenceScore: 85,
  questionsForReviewer: [],
  lintPassed: true,
  testsPassed: true,
  insights: ['Token refresh logic was missing'],
};

function makeApiResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify(VALID_OUTPUT)));
  mockAddNote.mockResolvedValue('');
});

// ── runSilpi ──────────────────────────────────────────────────────────────────

describe('runSilpi', () => {
  it('returns parsed SilpiOutput', async () => {
    const result = await runSilpi(CONTEXT, 1);
    expect(result).toEqual(VALID_OUTPUT);
  });

  it('uses the model from kshetra config', async () => {
    await runSilpi(CONTEXT, 1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('sends a different model when config changes', async () => {
    const ctx = { ...CONTEXT, kshetra: { ...KSHETRA, agents: { ...KSHETRA.agents, model: 'claude-opus-4-8' } } };
    await runSilpi(ctx, 1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-8' }),
    );
  });

  it('includes task id in the system prompt via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('proj-42');
  });

  it('includes task title in the system prompt via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('Fix auth');
  });

  it('includes round number in the TASK section', async () => {
    await runSilpi(CONTEXT, 2);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('Round: 2');
  });

  it('includes task description via taskDetails', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('Auth is broken');
  });

  it('includes PROJECT MEMORY section when projectMemory is set', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== PROJECT MEMORY ==');
    expect(call.system).toContain('project memory content');
  });

  it('omits PROJECT MEMORY section when projectMemory is empty', async () => {
    const ctx = { ...CONTEXT, projectMemory: '' };
    await runSilpi(ctx, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).not.toContain('== PROJECT MEMORY ==');
  });

  it('includes TASK section', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== TASK ==');
  });

  it('includes ROLE BOUNDARY section', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== ROLE BOUNDARY ==');
  });

  it('system prompt tells Silpi never to call the issue tracker', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system.toLowerCase()).toMatch(/never.*issue tracker|issue tracker.*never/);
  });

  it('includes SKILLS section when skills are provided', async () => {
    const ctx = { ...CONTEXT, projectSkills: 'use pnpm', universalSkills: 'write tests' };
    await runSilpi(ctx, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== SKILLS ==');
    expect(call.system).toContain('use pnpm');
    expect(call.system).toContain('write tests');
  });

  it('omits SKILLS section when all skills are empty', async () => {
    await runSilpi(CONTEXT, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).not.toContain('== SKILLS ==');
  });

  it('includes CONVENTIONS section when conventions is set', async () => {
    const ctx = { ...CONTEXT, conventions: 'no magic numbers' };
    await runSilpi(ctx, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== CONVENTIONS ==');
    expect(call.system).toContain('no magic numbers');
  });

  it('includes ARCHITECTURE section when architecture is set', async () => {
    const ctx = { ...CONTEXT, architecture: 'layered architecture' };
    await runSilpi(ctx, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== ARCHITECTURE ==');
    expect(call.system).toContain('layered architecture');
  });

  it('includes RELEVANT CODE section when ragChunks is set', async () => {
    const ctx = { ...CONTEXT, ragChunks: 'function foo() {}' };
    await runSilpi(ctx, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system).toContain('== RELEVANT CODE ==');
    expect(call.system).toContain('function foo() {}');
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
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('== PRIOR FEEDBACK');
      expect(call.system).toContain('Add error handling');
      expect(call.system).toContain('Fix the type errors');
    });

    it('includes round number in PRIOR FEEDBACK section', async () => {
      await runSilpi(CONTEXT, 3, REJECT_FEEDBACK);
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('(Round 3)');
    });

    it('omits PRIOR FEEDBACK section when feedback is null', async () => {
      await runSilpi(CONTEXT, 1, null);
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== PRIOR FEEDBACK');
    });

    it('omits PRIOR FEEDBACK section when feedback has no mustFix', async () => {
      const feedbackNoFix: ViharapalaOutput = { ...REJECT_FEEDBACK, mustFix: [] };
      await runSilpi(CONTEXT, 2, feedbackNoFix);
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== PRIOR FEEDBACK');
    });

    it('omits PRIOR FEEDBACK section when no feedback provided', async () => {
      await runSilpi(CONTEXT, 1);
      const call = mockCreate.mock.calls[0][0] as { system: string };
      expect(call.system).not.toContain('== PRIOR FEEDBACK');
    });
  });

  it('calls addNote with the task id', async () => {
    await runSilpi(CONTEXT, 1);
    expect(mockAddNote).toHaveBeenCalledWith('proj-42', expect.any(String));
  });

  it('note contains "Round N"', async () => {
    await runSilpi(CONTEXT, 3);
    expect(mockAddNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Round 3'),
    );
  });

  it('note contains confidenceScore', async () => {
    await runSilpi(CONTEXT, 1);
    expect(mockAddNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('confidence=85'),
    );
  });

  it('note contains lintPassed and testsPassed', async () => {
    await runSilpi(CONTEXT, 1);
    const note = (mockAddNote.mock.calls[0] as unknown as [string, string])[1];
    expect(note).toContain('lint=true');
    expect(note).toContain('tests=true');
  });

  it('propagates JSON parse errors when response is not valid JSON', async () => {
    mockCreate.mockResolvedValue(makeApiResponse('not json at all'));
    await expect(runSilpi(CONTEXT, 1)).rejects.toThrow();
  });

  it('throws when response has no text block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }], stop_reason: 'tool_use' });
    await expect(runSilpi(CONTEXT, 1)).rejects.toThrow('no text block');
  });

  it('throws when content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    await expect(runSilpi(CONTEXT, 1)).rejects.toThrow();
  });
});