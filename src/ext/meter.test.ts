import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileUsageMeter } from './defaults.js';
import { resetPricingCache } from './pricing.js';
import { USAGE_SCHEMA_VERSION } from './types.js';
import type { UsageRecord, UsageEntry } from './types.js';

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, appendFileSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(actual.readFileSync) };
});

const mockedAppend = vi.mocked(appendFileSync);
const mockedMkdir = vi.mocked(mkdirSync);

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kshetra: 'myapp', beadId: 'b-1', runId: 'r-1', agent: 'silpi',
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 3, ...over,
  };
}

beforeEach(() => resetPricingCache());
afterEach(() => vi.clearAllMocks());

describe('fileUsageMeter', () => {
  it('appends one JSON-per-line UsageEntry to the Kshetra usage.jsonl with a derived cost', () => {
    fileUsageMeter.record(record());

    const expectedPath = join(homedir(), '.shreni', 'kshetra', 'myapp', 'usage.jsonl');
    expect(mockedMkdir).toHaveBeenCalledWith(join(homedir(), '.shreni', 'kshetra', 'myapp'), { recursive: true });
    expect(mockedAppend).toHaveBeenCalledTimes(1);
    const [path, line] = mockedAppend.mock.calls[0];
    expect(path).toBe(expectedPath);
    expect(line as string).toMatch(/\n$/);

    const entry = JSON.parse((line as string).trimEnd()) as UsageEntry;
    expect(entry.kshetra).toBe('myapp');
    expect(entry.beadId).toBe('b-1');
    expect(entry.runId).toBe('r-1');
    expect(entry.agent).toBe('silpi');
    expect(entry.toolCallCount).toBe(3);
    expect(entry.schemaVersion).toBe(USAGE_SCHEMA_VERSION);
    expect(typeof entry.ts).toBe('string');
    expect(entry.priced).toBe(true);
    expect(entry.costUsd).toBeCloseTo(3, 6); // 1M input @ $3/M
  });

  it('records a gemini 0-token run with costUsd 0', () => {
    fileUsageMeter.record(record({
      provider: 'gemini', model: 'gemini-2.5-pro',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0,
    }));
    const line = mockedAppend.mock.calls[0][1] as string;
    const entry = JSON.parse(line.trimEnd()) as UsageEntry;
    expect(entry.costUsd).toBe(0);
    // gemini has no built-in price → unpriced, so 0 here means "unknown".
    expect(entry.priced).toBe(false);
  });
});
