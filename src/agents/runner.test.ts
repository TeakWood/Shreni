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

// Drives the adapter's per-call usage hook: createParser fires emit.usage() once
// per scripted call, so we can assert the runner turns them into turn_usage
// events with the right per-thread turnIndex (epic 408/A1).
function usageEmittingAdapter(
  calls: Array<{ messageId: string; inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; sidechain: boolean }>,
) {
  return {
    name: 'anthropic' as const,
    buildSpawn: () => ({ bin: 'true', args: [] }),
    createParser: (_opts: AgentRunnerOpts, emit: { usage?: (u: unknown) => void }) => {
      for (const c of calls) emit.usage?.(c);
      return { onLine: () => {}, finalize: () => ({ structuredOutput: {}, resultText: '', toolCallCount: 0, usage: undefined }) };
    },
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
      // Session duration recorded at the site (epic hto / Study A3).
      durationMs: expect.any(Number),
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
    // A failed session still consumed real time — durationMs is recorded (epic hto).
    expect(usageEvents[0]).toMatchObject({ inputTokens: 50, outputTokens: 10, outcome: 'error', durationMs: expect.any(Number) });
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

describe('runAgent turn_usage (epic 408/A1)', () => {
  it('emits one turn_usage per call, counting main-thread and sidechain turnIndex separately', async () => {
    mockEmitted.length = 0;
    // main, sidechain, main, sidechain — the sidechain calls must NOT advance the
    // main-thread index, and vice versa.
    mockGetAdapter.mockReturnValue(usageEmittingAdapter([
      { messageId: 'm0', inputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: false },
      { messageId: 's0', inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: true },
      { messageId: 'm1', inputTokens: 200, cacheReadTokens: 5, cacheCreationTokens: 1, sidechain: false },
      { messageId: 's1', inputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: true },
    ]));
    await runAgent(OPTS());
    const turns = mockEmitted.filter(e => e.type === 'turn_usage');
    expect(turns.map(t => ({ messageId: t.messageId, turnIndex: t.turnIndex, sidechain: t.sidechain }))).toEqual([
      { messageId: 'm0', turnIndex: 0, sidechain: false },
      { messageId: 's0', turnIndex: 0, sidechain: true },
      { messageId: 'm1', turnIndex: 1, sidechain: false },
      { messageId: 's1', turnIndex: 1, sidechain: true },
    ]);
    // Provider/model come from the resolved selection; raw counters ride through.
    expect(turns[2]).toMatchObject({
      kshetra: 'myapp', beadId: 'bd-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 200, cacheReadTokens: 5, cacheCreationTokens: 1,
    });
  });
});

describe('runAgent context_compacted is record-only (epic 408/A1)', () => {
  it('emits context_compacted at the last main-thread turnIndex and the run still succeeds', async () => {
    mockEmitted.length = 0;
    // Two main-thread turns happen, THEN compaction fires: the last main-thread
    // turn before the boundary is index 1 (mainTurnIndex is at 2).
    const adapter = {
      name: 'anthropic' as const,
      buildSpawn: () => ({ bin: 'true', args: [] }),
      createParser: (_o: AgentRunnerOpts, emit: { usage?: (u: unknown) => void; compacted?: (c: unknown) => void }) => {
        emit.usage?.({ messageId: 'm0', inputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: false });
        emit.usage?.({ messageId: 'm1', inputTokens: 150000, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: false });
        emit.compacted?.({ trigger: 'auto', preTokens: 150000 });
        return { onLine: () => {}, finalize: () => ({ structuredOutput: { ok: true }, resultText: 'done', toolCallCount: 0, usage: undefined }) };
      },
    };
    mockGetAdapter.mockReturnValue(adapter);
    // The run resolves normally — compaction did not abort/fail it.
    await expect(runAgent(OPTS())).resolves.toMatchObject({ structuredOutput: { ok: true } });
    const compacted = mockEmitted.filter(e => e.type === 'context_compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      kshetra: 'myapp', beadId: 'bd-1', agent: 'silpi', provider: 'anthropic', model: 'claude-sonnet-4-6',
      trigger: 'auto', preTokens: 150000, turnIndex: 1,
    });
  });

  it('clamps turnIndex to 0 when compaction precedes any main-thread turn', async () => {
    mockEmitted.length = 0;
    const adapter = {
      name: 'anthropic' as const,
      buildSpawn: () => ({ bin: 'true', args: [] }),
      createParser: (_o: AgentRunnerOpts, emit: { compacted?: (c: unknown) => void }) => {
        emit.compacted?.({ trigger: 'unknown', preTokens: 0 });
        return { onLine: () => {}, finalize: () => ({ structuredOutput: {}, resultText: '', toolCallCount: 0, usage: undefined }) };
      },
    };
    mockGetAdapter.mockReturnValue(adapter);
    await runAgent(OPTS());
    const compacted = mockEmitted.filter(e => e.type === 'context_compacted');
    expect(compacted[0]).toMatchObject({ trigger: 'unknown', turnIndex: 0 });
  });
});

describe('runAgent contextWindow carry-through (epic 408/A1 part B)', () => {
  it('carries contextWindow onto the meter record and the run_usage ledger fold', async () => {
    mockRecord.mockClear();
    mockEmitted.length = 0;
    mockGetAdapter.mockReturnValue(okAdapter({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2, contextWindow: 200000 }));
    await runAgent(OPTS());
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ contextWindow: 200000 });
    const usageEvents = mockEmitted.filter(e => e.type === 'run_usage');
    expect(usageEvents[0]).toMatchObject({ contextWindow: 200000 });
  });

  it('omits contextWindow entirely when the provider surfaced none (unknown, not 0)', async () => {
    mockRecord.mockClear();
    mockEmitted.length = 0;
    mockGetAdapter.mockReturnValue(okAdapter({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2 }));
    await runAgent(OPTS());
    expect(mockRecord.mock.calls[0][0]).not.toHaveProperty('contextWindow');
    const usageEvents = mockEmitted.filter(e => e.type === 'run_usage');
    expect(usageEvents[0]).not.toHaveProperty('contextWindow');
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
