import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { AgentContext, Task, SilpiOutput, ViharapalaOutput, PrReviewFeedback } from '../sthapathi/types.js';
import type { PrReview } from '../sthapathi/gh.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockRunClaudeAgent = vi.fn<() => Promise<object>>();
vi.mock('./runner.js', () => ({ runAgent: mockRunClaudeAgent, runClaudeAgent: mockRunClaudeAgent }));

// ── imports after mocks ──────────────────────────────────────────────────────

const { runSilpi, adaptPrReview } = await import('./silpi.js');

// ── fixtures ─────────────────────────────────────────────────────────────────

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: {
    path: '/projects/myapp',
    remote: 'git@github.com:TeakWood/myapp.git',
    mainBranch: 'main',
    branchPattern: 'bead-{id}/{slug}',
  },
  beads: {
    path: '/projects/myapp-beads',
    remote: 'git@github.com:TeakWood/myapp-beads.git',
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
  reviewGuide: '',
  repoMap: '',
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
    expect(opts.cwd).toBe('/projects/myapp');
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

  // Native execution loads the repo CLAUDE.md, whose SHRENI INTEGRATION block is
  // interactive-only. Silpi's injected prompt must override it so Silpi still
  // implements.
  it('overrides the repo interactive-only "do not implement" rule', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('NOT an interactive session');
    expect(opts.systemPrompt).toContain('does NOT apply to you: implement');
  });

  it('system prompt tells Silpi not to call bd commands', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt.toLowerCase()).toContain('bd');
  });

  it('includes SKILLS section with the cross-project universalSkills', async () => {
    const ctx = { ...CONTEXT, universalSkills: 'write tests' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== SKILLS ==');
    expect(opts.systemPrompt).toContain('write tests');
  });

  it('omits SKILLS section when universalSkills is empty', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== SKILLS ==');
  });

  // Native execution (the agent-execution design §3.1): the CONVENTIONS/ARCHITECTURE
  // docs are no longer injected — the provider CLI @-imports them via the
  // instruction file, so the prompt must NOT carry them (no double-load).
  it('never injects a CONVENTIONS or ARCHITECTURE section (loaded natively)', async () => {
    await runSilpi(CONTEXT, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== CONVENTIONS ==');
    expect(opts.systemPrompt).not.toContain('== ARCHITECTURE ==');
  });

  // The reviewGuide is reviewer-only (the agent-execution design §3.3): even when it is
  // present on the context, Silpi's prompt must never carry it.
  it('never injects the reviewer-only REVIEW GUIDE section', async () => {
    const ctx = { ...CONTEXT, reviewGuide: 'reviewer-only rubric' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).not.toContain('== REVIEW GUIDE');
    expect(opts.systemPrompt).not.toContain('reviewer-only rubric');
  });

  it('includes REPO MAP section when repoMap is set', async () => {
    const ctx = { ...CONTEXT, repoMap: '## src\n- `auth.ts` — token refresh' };
    await runSilpi(ctx, 1);
    const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('== REPO MAP ==');
    expect(opts.systemPrompt).toContain('`auth.ts` — token refresh');
  });

  // Command-drift fix: the prompt carries the exact toolchain-resolved commands
  // the gate enforces, so Silpi never iterates against a different command.
  describe('QUALITY GATES section', () => {
    it('injects the resolved toolchain commands', async () => {
      await runSilpi(CONTEXT, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== QUALITY GATES ==');
      expect(opts.systemPrompt).toContain('- build: `pnpm build`');
      expect(opts.systemPrompt).toContain('- test: `pnpm test`');
      expect(opts.systemPrompt).toContain('- lint: `pnpm lint`');
      expect(opts.systemPrompt).toContain('- coverage: `pnpm test:coverage`');
    });

    it('stack overrides win and empty commands are omitted', async () => {
      const ctx = {
        ...CONTEXT,
        kshetra: {
          ...KSHETRA,
          stack: { language: 'typescript', testRunner: 'vitest run', coverageCommand: '' },
        },
      };
      await runSilpi(ctx, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('- test: `vitest run`');
      expect(opts.systemPrompt).not.toContain('- coverage:');
    });

    it('omits the section entirely when no command resolves (unknown language)', async () => {
      const ctx = { ...CONTEXT, kshetra: { ...KSHETRA, stack: { language: 'brainfuck' } } };
      await runSilpi(ctx, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== QUALITY GATES ==');
    });

    it('no longer tells Silpi to discover commands from the instruction file', async () => {
      await runSilpi(CONTEXT, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('check the project instruction file for commands');
    });
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

  describe('PR follow-up (epic hjw)', () => {
    const PR_FEEDBACK: PrReviewFeedback = {
      reviewBody: 'Please handle the null case and justify the retry count',
      comments: [
        { id: 'c0', author: 'human', path: 'src/a.ts', line: 42, body: 'this can throw on null' },
        { id: 'c1', author: 'human', path: 'src/b.ts', line: 7, body: 'why retry 3 times?' },
      ],
      failingChecks: [{ name: 'build', summary: 'tsc: 2 type errors in src/a.ts' }],
    };

    it('injects the PR REVIEW FEEDBACK section with comment ids, summary, and failing checks', async () => {
      await runSilpi(CONTEXT, 5, null, undefined, undefined, PR_FEEDBACK);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).toContain('== PR REVIEW FEEDBACK (follow-up round) ==');
      expect(opts.systemPrompt).toContain('Please handle the null case');
      expect(opts.systemPrompt).toContain('[c0] src/a.ts:42');
      expect(opts.systemPrompt).toContain('[c1] src/b.ts:7');
      expect(opts.systemPrompt).toContain('- build: tsc: 2 type errors in src/a.ts');
      // instructs the {change|reply|escalate} triage contract
      expect(opts.systemPrompt).toContain('commentResponses');
      expect(opts.systemPrompt).toContain('escalate');
    });

    it('omits the PR REVIEW FEEDBACK section on an ordinary round', async () => {
      await runSilpi(CONTEXT, 1);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { systemPrompt: string };
      expect(opts.systemPrompt).not.toContain('== PR REVIEW FEEDBACK');
    });

    it('passes a jsonSchema that carries the commentResponses contract', async () => {
      await runSilpi(CONTEXT, 5, null, undefined, undefined, PR_FEEDBACK);
      const opts = mockRunClaudeAgent.mock.calls[0][0] as { jsonSchema: { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> } };
      const cr = opts.jsonSchema.properties.commentResponses;
      expect(cr).toBeDefined();
      expect(Object.keys(cr.items?.properties ?? {})).toEqual(['commentId', 'disposition', 'reply']);
    });

    it('returns commentResponses from structured output with the {change|reply|escalate} split intact', async () => {
      const followup: SilpiOutput = {
        ...VALID_OUTPUT,
        filesChanged: [{ path: 'src/a.ts', diff: '- old\n+ null-guarded' }],
        commentResponses: [
          { commentId: 'c0', disposition: 'change', reply: 'Added a null guard in src/a.ts.' },
          { commentId: 'c1', disposition: 'reply', reply: 'Retry count matches the upstream SLA.' },
        ],
      };
      mockRunClaudeAgent.mockResolvedValue(makeRunnerResult(followup));
      const result = await runSilpi(CONTEXT, 5, null, undefined, undefined, PR_FEEDBACK);
      expect(result.commentResponses).toEqual(followup.commentResponses);
      // the 'change' item corresponds to a code edit in filesChanged
      const changed = result.commentResponses!.find((r) => r.disposition === 'change')!;
      expect(result.filesChanged.some((f) => f.diff.includes('null-guarded'))).toBe(true);
      expect(changed.commentId).toBe('c0');
    });
  });

  it('throws ParseError when runner returns no structured output', async () => {
    mockRunClaudeAgent.mockResolvedValue({ structuredOutput: null, resultText: 'some text', toolCallCount: 0 });
    await expect(runSilpi(CONTEXT, 1)).rejects.toThrow('no structured output');
  });
});

describe('adaptPrReview', () => {
  const REVIEW: PrReview = {
    author: 'human',
    state: 'CHANGES_REQUESTED',
    body: 'needs work',
    submittedAt: '2026-07-29T12:00:00Z',
    comments: [
      { author: 'human', body: 'null check here', path: 'src/a.ts', line: 42 },
      { author: 'human', body: 'rename this', path: 'src/b.ts', line: 3 },
    ],
  };

  it('adapts a gh review into PrReviewFeedback with stable c<n> comment ids', () => {
    const fb = adaptPrReview(REVIEW, [{ name: 'build', summary: 'red' }]);
    expect(fb.reviewBody).toBe('needs work');
    expect(fb.comments).toEqual([
      { id: 'c0', author: 'human', path: 'src/a.ts', line: 42, body: 'null check here' },
      { id: 'c1', author: 'human', path: 'src/b.ts', line: 3, body: 'rename this' },
    ]);
    expect(fb.failingChecks).toEqual([{ name: 'build', summary: 'red' }]);
  });

  it('defaults failingChecks to empty when none are supplied', () => {
    expect(adaptPrReview({ ...REVIEW, comments: [] }).failingChecks).toEqual([]);
  });
});
