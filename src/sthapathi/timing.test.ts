import { describe, it, expect, vi, afterEach } from 'vitest';
import { performance } from 'perf_hooks';
import { timed, elapsedMs, nowMs } from './timing.js';

// The monotonic clock is performance.now(); stub IT (not Date.now, which these
// sites must never use) and assert exact durations — epic hto / Study A3.
describe('timing (epic hto / Study A3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('timed returns the result and whole-ms monotonic duration', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1050.4);
    const { result, durationMs } = await timed(async () => 'ok');
    expect(result).toBe('ok');
    expect(durationMs).toBe(50); // round(1050.4 - 1000)
  });

  it('elapsedMs rounds and clamps a negative (skewed/coarse clock) to 0', () => {
    const spy = vi.spyOn(performance, 'now');
    spy.mockReturnValue(500);
    expect(elapsedMs(400)).toBe(100);
    expect(elapsedMs(1000)).toBe(0); // never negative
  });

  it('nowMs reads the monotonic clock', () => {
    vi.spyOn(performance, 'now').mockReturnValue(4242);
    expect(nowMs()).toBe(4242);
  });
});
