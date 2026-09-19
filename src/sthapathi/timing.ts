// Monotonic time-at-the-site measurement (epic hto / Study A3). Durations are
// measured AT THE SITE of the work with a MONOTONIC clock and recorded as
// durationMs on the event that closes each unit of work — never derived at read
// time by subtracting adjacent event timestamps (that silently charges any
// unlogged step to the next event; see the epic's decision 1).
//
// performance.now() is monotonic: immune to wall-clock (NTP) jumps, unlike
// Date.now() deltas. Event `ts` stays wall-clock for ordering; only durations use
// this. Routed through nowMs() so a test can stub the clock and assert an exact
// value.

import { performance } from 'perf_hooks';

// The monotonic clock, in fractional milliseconds. The single seam every timing
// helper reads, so tests stub here rather than at each call site.
export function nowMs(): number {
  return performance.now();
}

// Whole milliseconds elapsed since a nowMs() start marker. Clamped at 0 so a
// stubbed or coarse clock can never yield a negative duration.
export function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(nowMs() - startMs));
}

// Time one async op, returning its result and the monotonic ms it took. The
// common site where the duration is only needed on the success path.
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = nowMs();
  const result = await fn();
  return { result, durationMs: elapsedMs(start) };
}
