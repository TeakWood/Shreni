import { describe, it, expect, vi } from 'vitest';
import { withRetry, AGENT_RETRY_CONFIG, type RetryConfig } from './retry.js';

// Zero-delay config avoids fake timer complexity while testing retry logic
const INSTANT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 0,
  backoffMultiplier: 2,
  maxDelayMs: 0,
  retryableStatuses: [429, 502, 503, 529],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
};

describe('withRetry', () => {
  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry('test', fn, INSTANT_CONFIG);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable HTTP status 429', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValue('ok');

    expect(await withRetry('test', fn, INSTANT_CONFIG)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on retryable HTTP statuses 502, 503, 529', async () => {
    for (const status of [502, 503, 529]) {
      const fn = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error(`HTTP ${status}`), { status }))
        .mockResolvedValue('ok');

      expect(await withRetry('test', fn, INSTANT_CONFIG)).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('retries on retryable network error codes', async () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error(code))
        .mockResolvedValue('ok');

      expect(await withRetry('test', fn, INSTANT_CONFIG)).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('throws immediately on non-retryable error without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 }),
    );

    await expect(withRetry('test', fn, INSTANT_CONFIG)).rejects.toThrow('Not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after maxAttempts when all retries are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error('overloaded'), { status: 503 }),
    );

    await expect(withRetry('test', fn, INSTANT_CONFIG)).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(INSTANT_CONFIG.maxAttempts);
  });

  it('applies exponential backoff and caps at maxDelayMs', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      if (typeof ms === 'number' && ms > 0) delays.push(ms);
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const cappedConfig: RetryConfig = {
      ...INSTANT_CONFIG,
      initialDelayMs: 100,
      backoffMultiplier: 10,
      maxDelayMs: 150,
    };
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('err'), { status: 503 }));

    await expect(withRetry('test', fn, cappedConfig)).rejects.toThrow();
    vi.restoreAllMocks();

    expect(delays[0]).toBe(100);
    expect(delays[1]).toBeLessThanOrEqual(150);
  });

  it('default config has correct values', () => {
    expect(AGENT_RETRY_CONFIG.maxAttempts).toBe(3);
    expect(AGENT_RETRY_CONFIG.initialDelayMs).toBe(5_000);
    expect(AGENT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    expect(AGENT_RETRY_CONFIG.maxDelayMs).toBe(60_000);
    expect(AGENT_RETRY_CONFIG.retryableStatuses).toEqual([429, 502, 503, 529]);
    expect(AGENT_RETRY_CONFIG.retryableErrors).toEqual(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
  });
});