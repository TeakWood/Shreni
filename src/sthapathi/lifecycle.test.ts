import { describe, it, expect } from 'vitest';
import { PHASE_TRANSITIONS, PHASES, REST_PHASE, canTransition, nextPhases, type Phase } from './lifecycle.js';

describe('phase transition table', () => {
  it('covers exactly the four worker phases', () => {
    expect(new Set(PHASES)).toEqual(new Set(['IDLE', 'SELECTING', 'PREPARING', 'WORKING']));
  });

  it('matches the scheduler runCycle edges', () => {
    // IDLE→SELECTING→(PREPARING|IDLE)→(WORKING|IDLE)→IDLE — the exact set runCycle drives.
    expect(canTransition('IDLE', 'SELECTING')).toBe(true);
    expect(canTransition('SELECTING', 'PREPARING')).toBe(true);
    expect(canTransition('SELECTING', 'IDLE')).toBe(true); // nothing selected
    expect(canTransition('PREPARING', 'WORKING')).toBe(true);
    expect(canTransition('PREPARING', 'IDLE')).toBe(true); // prepare rejected
    expect(canTransition('WORKING', 'IDLE')).toBe(true);
  });

  it('rejects skipped-phase jumps', () => {
    expect(canTransition('IDLE', 'PREPARING')).toBe(false);
    expect(canTransition('IDLE', 'WORKING')).toBe(false);
    expect(canTransition('SELECTING', 'WORKING')).toBe(false);
    expect(canTransition('WORKING', 'SELECTING')).toBe(false);
    expect(canTransition('WORKING', 'PREPARING')).toBe(false);
  });

  it('treats an idempotent re-set (from === to) as allowed', () => {
    for (const p of PHASES) expect(canTransition(p, p)).toBe(true);
  });

  it('nextPhases returns the table row', () => {
    expect(nextPhases('SELECTING')).toEqual(['PREPARING', 'IDLE']);
  });
});

describe('no write-only latch (the Watchdog-ARD bug class)', () => {
  // A write-only latch is a phase you can enter but never leave back toward the
  // rest state. Prove every phase can reach IDLE, and no non-rest phase is a sink.
  function reaches(from: Phase, target: Phase): boolean {
    const seen = new Set<Phase>();
    const stack: Phase[] = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target && cur !== from) return true;
      if (cur === target && from === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...PHASE_TRANSITIONS[cur]);
    }
    return false;
  }

  it('every phase has at least one outgoing edge', () => {
    for (const p of PHASES) expect(PHASE_TRANSITIONS[p].length).toBeGreaterThan(0);
  });

  it('every phase can reach the rest phase (IDLE)', () => {
    for (const p of PHASES) {
      expect(reaches(p, REST_PHASE)).toBe(true);
    }
  });

  it('every non-rest phase is reachable from IDLE', () => {
    for (const p of PHASES) {
      if (p === REST_PHASE) continue;
      expect(reaches('IDLE', p)).toBe(true);
    }
  });

  it('references no phase outside the declared set (no dangling edge)', () => {
    for (const p of PHASES) {
      for (const to of PHASE_TRANSITIONS[p]) {
        expect(PHASES).toContain(to);
      }
    }
  });
});