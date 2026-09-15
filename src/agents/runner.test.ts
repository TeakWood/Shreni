import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentRunnerOpts } from './providers/types';

// Mock the adapter registry so runAgent spawns a real, controllable long-lived
// process (`sleep`) instead of a provider CLI — lets us prove the abort path
// SIGKILLs the subprocess and rejects, without any provider binary.
const mockGetAdapter = vi.fn();
vi.mock('./providers/index.js', () => ({ getAdapter: mockGetAdapter }));

// Capture what runAgent hands the UsageMeter on a successful run. getSinkRegistry
// is stubbed too because activity-log.ts (imported transitively for
// getCurrentRunId) loads from this same module. getPolicySource is swappable via
// policyRef so tests can exercise model override + a mayProceed denial.
const mockRecord = vi.fn();
// Captures every event runAgent emits (via the stubbed sink registry) so tests
// can assert the run_usage ledger summary (4a2.5) alongside the meter record.
const mockEmitted: Array<{ type: string; [k: string]: unknown }> = [];
const staticPolicy = {
  selectModel: (req: { default: unknown }) => req.default,
  mayProceed: () => ({ allowed: true as const }),
};
const policyRef: { current: unknown } = { current: staticPolicy };
vi.mock('../ext/index.js', () => ({
  getUsageMeter: () => ({ record: mockRecord }),
  getSinkRegistry: () => ({ handle: (ev: { type: string }) => { mockEmitted.push(ev as { type: string }); } }),
  getPolicySource: () => policyRef.current,
  costFor: (u: { inputTokens: number; outputTokens: number }) => ({
    costUsd: (u.inputTokens + u.outputTokens) * 0.001,
    priced: true,
  }),
}));

const { runAgent } = await import('./runner');
const { AgentAbortedError, RunNotPermittedError } = await import('../sthapathi/errors');
const { AgentRunError } = await import('./providers/types');

// Spawns `true` (exits 0) but the parser's finalize throws — models a run the
// provider reported as errored. `usage` is the token block the provider surfaced
// before failing (undefined when it surfaced none, e.g. a no-result exit).
function failAdapter(usage: unknown, message = 'silpi: agent returned error — boom', toolCallCount = 2) {
  return {
    name: 'anthropic' as const,
    buildSpawn: () => ({ bin: 'true', args: [] }),
    createParser: () => ({
      onLine: () => {},
      finalize: () => {
        throw new AgentRunError(message, usage as undefined, toolCallCount);
      },
    }),
  };
}

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
      outcome: 'ok',
    });
    expect(typeof rec.runId).toBe('string');
  });

  it('folds a run_usage summary into the ledger on success, without the full record (4a2.5)', async () => {
    mockEmitted.length = 0;
    mockGetAdapter.mockReturnValue(okAdapter({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2 }));
    await runAgent(OPTS());
    const usageEvents = mockEmitted.filter(e => e.type === 'run_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      kshetra: 'myapp', beadId: 'bd-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 100, outputTokens: 20, costUsd: 0.12, priced: true, outcome: 'ok',
    });
    // The cache/tool breakdown stays in usage.jsonl — not duplicated into the ledger.
    expect(usageEvents[0]).not.toHaveProperty('cacheReadTokens');
    expect(usageEvents[0]).not.toHaveProperty('toolCallCount');
  });

  it('still folds a run_usage entry (zeroed) when the provider surfaced no usage (4a2.5)', async () => {
    mockEmitted.length = 0;
    mockGetAdapter.mockReturnValue(okAdapter(undefined, 1));
    await runAgent(OPTS());
    const usageEvents = mockEmitted.filter(e => e.type === 'run_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, outcome: 'ok' });
  });

  it('folds a run_usage entry with outcome:error for a failed run (4a2.5)', async () => {
    mockEmitted.length = 0;
    mockGetAdapter.mockReturnValue(failAdapter({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 3, cacheCreationTokens: 1 }));
    await expect(runAgent(OPTS())).rejects.toBeInstanceOf(AgentRunError);
    const usageEvents = mockEmitted.filter(e => e.type === 'run_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ inputTokens: 50, outputTokens: 10, outcome: 'error' });
  });

  it('records zero token counts when the provider surfaced no usage', async () => {
    mockRecord.mockClear();
    mockGetAdapter.mockReturnValue(okAdapter(undefined, 1));
    await runAgent(OPTS());
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 1,
      outcome: 'ok',
    });
  });

  it('meters a failed run’s tokens as outcome:error, then rejects (Shreni-beads-1tg)', async () => {
    mockRecord.mockClear();
    // A non-transient error message so the loop records once and breaks (no retry backoff).
    mockGetAdapter.mockReturnValue(failAdapter({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 3, cacheCreationTokens: 1 }));
    await expect(runAgent(OPTS())).rejects.toBeInstanceOf(AgentRunError);
    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      kshetra: 'myapp', beadId: 'bd-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 50, outputTokens: 10, cacheReadTokens: 3, cacheCreationTokens: 1, toolCallCount: 2,
      outcome: 'error',
    });
  });

  it('records nothing when a failed run surfaced no usage (no-result exit)', async () => {
    mockRecord.mockClear();
    mockGetAdapter.mockReturnValue(failAdapter(undefined));
    await expect(runAgent(OPTS())).rejects.toBeInstanceOf(AgentRunError);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records nothing when a run is aborted', async () => {
    mockRecord.mockClear();
    mockGetAdapter.mockReturnValue(sleepAdapter(30));
    const controller = new AbortController();
    const p = runAgent(OPTS(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(AgentAbortedError);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('runAgent policy routing', () => {
  afterEach(() => { policyRef.current = staticPolicy; });

  it('runs with the policy-selected provider/model (reflected in the usage record)', async () => {
    mockRecord.mockClear();
    policyRef.current = {
      selectModel: () => ({ provider: 'openai', model: 'gpt-5' }),
      mayProceed: () => ({ allowed: true as const }),
    };
    mockGetAdapter.mockReturnValue(okAdapter(undefined));
    await runAgent(OPTS());
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ provider: 'openai', model: 'gpt-5' });
  });

  it('throws RunNotPermittedError and never spawns when mayProceed denies', async () => {
    mockGetAdapter.mockClear();
    policyRef.current = {
      selectModel: (req: { default: unknown }) => req.default,
      mayProceed: () => ({ allowed: false as const, reason: 'gated tier' }),
    };
    await expect(runAgent(OPTS())).rejects.toBeInstanceOf(RunNotPermittedError);
    expect(mockGetAdapter).not.toHaveBeenCalled();
  });
});
