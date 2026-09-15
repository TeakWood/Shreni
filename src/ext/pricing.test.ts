import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { costFor, priceFor, resetPricingCache, BUILT_IN_PRICES } from './pricing.js';
import type { UsageRecord } from './types.js';

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const mockedRead = vi.mocked(readFileSync);

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kshetra: 'myapp', beadId: 'b-1', runId: 'r-1', agent: 'silpi',
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, outcome: 'ok', ...over,
  };
}

afterEach(() => {
  resetPricingCache();
  mockedRead.mockReset();
});

describe('costFor', () => {
  it('derives cost from the built-in price table across all four token lanes', () => {
    mockedRead.mockImplementation(() => { throw new Error('ENOENT'); }); // no override file
    const { costUsd, priced } = costFor(record({
      inputTokens: 1_000_000,        // $3
      outputTokens: 1_000_000,       // $15
      cacheReadTokens: 1_000_000,    // $0.30
      cacheCreationTokens: 1_000_000,// $3.75
    }));
    expect(priced).toBe(true);
    expect(costUsd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });

  it('handles gemini 0-token runs as a genuine $0, not "unknown"', () => {
    mockedRead.mockImplementation(() => { throw new Error('ENOENT'); });
    // gemini surfaces no tokens; add an override so the model is priced.
    mockedRead.mockReturnValue(JSON.stringify({
      gemini: { 'gemini-2.5-pro': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } },
    }));
    const { costUsd, priced } = costFor(record({ provider: 'gemini', model: 'gemini-2.5-pro' }));
    expect(priced).toBe(true);
    expect(costUsd).toBe(0);
  });

  it('flags an unpriced model: cost 0 placeholder, priced=false', () => {
    mockedRead.mockImplementation(() => { throw new Error('ENOENT'); });
    const { costUsd, priced } = costFor(record({ provider: 'openai', model: 'gpt-mystery', inputTokens: 5_000_000 }));
    expect(priced).toBe(false);
    expect(costUsd).toBe(0);
  });

  it('rounds to micro-dollar precision', () => {
    mockedRead.mockImplementation(() => { throw new Error('ENOENT'); });
    const { costUsd } = costFor(record({ inputTokens: 1 })); // 3 / 1e6 = 0.000003
    expect(costUsd).toBe(0.000003);
  });
});

describe('priceFor with ~/.shreni/pricing.json override', () => {
  it('overrides a built-in rate per model without touching the code table', () => {
    mockedRead.mockReturnValue(JSON.stringify({
      anthropic: { 'claude-sonnet-4-6': { inputPerMTok: 99, outputPerMTok: 99, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } },
    }));
    expect(priceFor('anthropic', 'claude-sonnet-4-6')?.inputPerMTok).toBe(99);
    // A model NOT in the override keeps its built-in rate.
    expect(priceFor('anthropic', 'claude-opus-4-1')?.outputPerMTok)
      .toBe(BUILT_IN_PRICES.anthropic['claude-opus-4-1'].outputPerMTok);
  });

  it('ignores a malformed override file (fails open to built-ins)', () => {
    mockedRead.mockReturnValue('{ not json');
    expect(priceFor('anthropic', 'claude-sonnet-4-6')?.inputPerMTok).toBe(3);
  });
});
