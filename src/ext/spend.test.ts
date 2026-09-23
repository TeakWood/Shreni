import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { computeSpend, readUsageEntries, readSpendSoFar } from './spend.js';
import { USAGE_SCHEMA_VERSION } from './types.js';
import type { UsageEntry } from './types.js';

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const mockedRead = vi.mocked(readFileSync);

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    kshetra: 'myapp', beadId: 'b-1', runId: 'r-1', agent: 'silpi',
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, outcome: 'ok',
    ts: '2026-09-15T00:00:00Z', schemaVersion: USAGE_SCHEMA_VERSION,
    costUsd: 0, priced: true, ...over,
  };
}

afterEach(() => mockedRead.mockReset());

describe('computeSpend', () => {
  it('sums cost for the requested bead and for the whole Kshetra', () => {
    const spend = computeSpend([
      entry({ beadId: 'b-1', costUsd: 1.5 }),
      entry({ beadId: 'b-1', costUsd: 0.25 }),
      entry({ beadId: 'b-2', costUsd: 4 }),
    ], 'b-1');
    expect(spend.beadUsd).toBe(1.75);
    expect(spend.kshetraUsd).toBe(5.75);
  });

  it('returns zeros for a bead with no entries (Kshetra total still counts others)', () => {
    const spend = computeSpend([entry({ beadId: 'b-2', costUsd: 3 })], 'b-1');
    expect(spend.beadUsd).toBe(0);
    expect(spend.kshetraUsd).toBe(3);
  });

  it('returns all zeros for an empty ledger', () => {
    expect(computeSpend([], 'b-1')).toEqual({
      beadUsd: 0, kshetraUsd: 0, beadUnpricedRuns: 0, kshetraUnpricedRuns: 0,
    });
  });

  it('counts unpriced runs per bead and per Kshetra (spend is a lower bound)', () => {
    const spend = computeSpend([
      entry({ beadId: 'b-1', costUsd: 2, priced: true }),
      entry({ beadId: 'b-1', costUsd: 0, priced: false }), // unpriced → 0 placeholder
      entry({ beadId: 'b-2', costUsd: 0, priced: false }),
    ], 'b-1');
    expect(spend.beadUsd).toBe(2);
    expect(spend.beadUnpricedRuns).toBe(1);
    expect(spend.kshetraUnpricedRuns).toBe(2);
  });

  it('includes failed runs — they burned real tokens (1tg)', () => {
    const spend = computeSpend([
      entry({ beadId: 'b-1', costUsd: 1, outcome: 'ok' }),
      entry({ beadId: 'b-1', costUsd: 0.5, outcome: 'error' }),
    ], 'b-1');
    expect(spend.beadUsd).toBe(1.5);
  });

  it('rounds summed cost to micro-dollars (no float drift)', () => {
    const spend = computeSpend([
      entry({ beadId: 'b-1', costUsd: 0.1 }),
      entry({ beadId: 'b-1', costUsd: 0.2 }),
    ], 'b-1');
    expect(spend.beadUsd).toBe(0.3); // not 0.30000000000000004
  });
});

describe('readUsageEntries', () => {
  it('parses a JSONL ledger, skipping blank and corrupt lines', () => {
    mockedRead.mockReturnValue(
      JSON.stringify(entry({ costUsd: 1 })) + '\n' +
      '\n' +
      '{ not json\n' +
      JSON.stringify(entry({ costUsd: 2 })) + '\n',
    );
    const entries = readUsageEntries('myapp');
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.costUsd)).toEqual([1, 2]);
  });

  it('parses a pre-dt7 entry with no durationMs — absence reads as unknown', () => {
    // entry() sets no durationMs — the shape every pre-dt7 line has on disk.
    mockedRead.mockReturnValue(JSON.stringify(entry()) + '\n' + JSON.stringify(entry({ durationMs: 1234 })) + '\n');
    const entries = readUsageEntries('myapp');
    expect(entries).toHaveLength(2);
    expect(entries[0].durationMs).toBeUndefined();
    expect(entries[1].durationMs).toBe(1234);
  });

  it('returns [] when the ledger file is missing (ENOENT)', () => {
    mockedRead.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(readUsageEntries('myapp')).toEqual([]);
  });

  it('rethrows a non-ENOENT read error (does not fail open as zero spend)', () => {
    mockedRead.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(() => readUsageEntries('myapp')).toThrow('EACCES');
  });
});

describe('readSpendSoFar', () => {
  it('reads the ledger and returns spend-so-far for a bead + Kshetra', () => {
    mockedRead.mockReturnValue(
      JSON.stringify(entry({ beadId: 'b-1', costUsd: 3 })) + '\n' +
      JSON.stringify(entry({ beadId: 'b-2', costUsd: 7 })) + '\n',
    );
    const spend = readSpendSoFar('myapp', 'b-1');
    expect(spend.beadUsd).toBe(3);
    expect(spend.kshetraUsd).toBe(10);
  });

  it('treats a missing ledger as zero spend', () => {
    mockedRead.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(readSpendSoFar('myapp', 'b-1')).toEqual({
      beadUsd: 0, kshetraUsd: 0, beadUnpricedRuns: 0, kshetraUnpricedRuns: 0,
    });
  });
});
