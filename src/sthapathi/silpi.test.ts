import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';
import type { Task } from './types.js';

// ── module mocks (hoisted) ───────────────────────────────────────────────────

const mockCreate = vi.fn<(params: object) => Promise<object>>();
const mockAddNote = vi.fn<() => Promise<string>>();

vi.mock('@anthropic-ai/sdk', () => {
  // The SDK exports module.exports as a function; vitest CJS interop maps
  // `import Anthropic from '...'` to module.exports (not .default), so we
  // must return a constructable class, not a plain arrow function.
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

vi.mock('./beads.js', () => ({
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
    const result = await runSilpi(TASK, KSHETRA, 1);
    expect(result).toEqual(VALID_OUTPUT);
  });

  it('uses the model from kshetra config', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('sends a different model when config changes', async () => {
    const kshetra = { ...KSHETRA, agents: { ...KSHETRA.agents, model: 'claude-opus-4-8' } };
    await runSilpi(TASK, kshetra, 1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-8' }),
    );
  });

  it('includes task id in the user message', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain('proj-42');
  });

  it('includes task title in the user message', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain('Fix auth');
  });

  it('includes round number in the user message', async () => {
    await runSilpi(TASK, KSHETRA, 2);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain('Round: 2');
  });

  it('includes description in the user message when present', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain('Auth is broken');
  });

  it('includes prior notes when task has notes', async () => {
    const task = { ...TASK, notes: 'round 1: tried X, failed' };
    await runSilpi(task, KSHETRA, 2);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain('round 1: tried X, failed');
  });

  it('omits description section when task has no description', async () => {
    const task = { ...TASK, description: undefined };
    await runSilpi(task, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).not.toContain('Description:');
  });

  it('sends a system prompt', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(typeof call.system).toBe('string');
    expect(call.system.length).toBeGreaterThan(0);
  });

  it('system prompt tells Silpi never to call issue tracker', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const call = mockCreate.mock.calls[0][0] as { system: string };
    expect(call.system.toLowerCase()).toMatch(/never.*issue tracker|issue tracker.*never/);
  });

  it('calls addNote with the task id', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    expect(mockAddNote).toHaveBeenCalledWith('proj-42', expect.any(String));
  });

  it('note contains "Round N"', async () => {
    await runSilpi(TASK, KSHETRA, 3);
    expect(mockAddNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Round 3'),
    );
  });

  it('note contains confidenceScore', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    expect(mockAddNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('confidence=85'),
    );
  });

  it('note contains lintPassed and testsPassed', async () => {
    await runSilpi(TASK, KSHETRA, 1);
    const note = (mockAddNote.mock.calls[0] as unknown as [string, string])[1];
    expect(note).toContain('lint=true');
    expect(note).toContain('tests=true');
  });

  it('propagates JSON parse errors when response is not valid JSON', async () => {
    mockCreate.mockResolvedValue(makeApiResponse('not json at all'));
    await expect(runSilpi(TASK, KSHETRA, 1)).rejects.toThrow();
  });

  it('throws when response has no text block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }], stop_reason: 'tool_use' });
    await expect(runSilpi(TASK, KSHETRA, 1)).rejects.toThrow('no text block');
  });

  it('throws when content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    await expect(runSilpi(TASK, KSHETRA, 1)).rejects.toThrow();
  });
});