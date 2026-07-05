import { describe, it, expect, vi } from 'vitest';
import type { AgentRunnerOpts } from './providers/types';

// Mock the adapter registry so runAgent spawns a real, controllable long-lived
// process (`sleep`) instead of a provider CLI — lets us prove the abort path
// SIGKILLs the subprocess and rejects, without any provider binary.
const mockGetAdapter = vi.fn();
vi.mock('./providers/index.js', () => ({ getAdapter: mockGetAdapter }));

// Capture what runAgent hands the UsageMeter on a successful run. getSinkRegistry
// is stubbed too because activity-log.ts (imported transitively for
// getCurrentRunId) loads from this same module.
const mockRecord = vi.fn();
vi.mock('../ext/index.js', () => ({
  getUsageMeter: () => ({ record: mockRecord }),
  getSinkRegistry: () => ({ handle: () => {} }),
}));

const { runAgent } = await import('./runner');
const { AgentAbortedError } = await import('../sthapathi/errors');

function sleepAdapter(seconds: number) {
  return {
    name: 'anthropic' as const,
    buildSpawn: () => ({ bin: 'sleep', args: [String(seconds)] }),
    createParser: () => ({ onLine: () => {}, finalize: () => ({ structuredOutput: {}, resultText: '', toolCallCount: 0 }) }),
  };
}

// Spawns `true` (exits 0 immediately) so runAgent resolves and reportUsage fires.
function okAdapter(usage: unknown, toolCallCount = 3) {
  return {
    name: 'anthropic' as const,
    buildSpawn: () => ({ bin: 'true', args: [] }),
    createParser: () => ({ onLine: () => {}, finalize: () => ({ structuredOutput: { ok: true }, resultText: 'done', toolCallCount, usage }) }),
  };
}

const OPTS = (signal?: AbortSignal): AgentRunnerOpts => ({
  provider: 'anthropic',
  systemPrompt: 's',
  userPrompt: 'u',
  cwd: process.cwd(),
  agentName: 'silpi',
  kshetraId: 'myapp',
  beadId: 'bd-1',
  model: 'claude-sonnet-4-6',
  jsonSchema: {},
  signal,
});

describe('runAgent abort wiring', () => {
  it('rejects with AgentAbortedError without spawning when the signal is already aborted', async () => {
    mockGetAdapter.mockReturnValue(sleepAdapter(30));
    const controller = new AbortController();
    controller.abort();
    await expect(runAgent(OPTS(controller.signal))).rejects.toBeInstanceOf(AgentAbortedError);
  });

  it('SIGKILLs the in-flight subprocess and rejects promptly when aborted mid-run', async () => {
    mockGetAdapter.mockReturnValue(sleepAdapter(30));
    const controller = new AbortController();
    const started = Date.now();
    const p = runAgent(OPTS(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(AgentAbortedError);
    // Must return far sooner than the 30s the process would otherwise run.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('runAgent usage metering', () => {
  it('reports usage to the meter keyed by kshetra/beadId/agent/provider/model on success', async () => {
    mockRecord.mockClear();
    mockGetAdapter.mockReturnValue(okAdapter({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2 }));
    await runAgent(OPTS());
    expect(mockRecord).toHaveBeenCalledOnce();
    const rec = mockRecord.mock.calls[0][0];
    expect(rec).toMatchObject({
      kshetra: 'myapp', beadId: 'bd-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2, toolCallCount: 3,
    });
    expect(typeof rec.runId).toBe('string');
  });

  it('records zero token counts when the provider surfaced no usage', async () => {
    mockRecord.mockClear();
    mockGetAdapter.mockReturnValue(okAdapter(undefined, 1));
    await runAgent(OPTS());
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 1,
    });
  });
});
