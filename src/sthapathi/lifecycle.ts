// Worker lifecycle phase machine — the typed transition table + guard (yds.10).
//
// The scheduler already enforces "one task at a time" structurally (runCycle
// only starts from IDLE and advances the phase synchronously). This module makes
// the *shape* of that machine explicit and checkable: every legal edge is listed
// once, so an illegal jump (a skipped phase) or a write-only latch (a phase with
// no way back to IDLE) is a test failure and a runtime tripwire rather than a
// silent bug — the class of defect the Watchdog ARD was written about.
//
// Deliberately NOT a state-machine library: no dependency, no durable snapshot
// (bd + git + state.json remain the sources of truth), no change to retry/guards.
// A heavier XState-style engine is explicitly deferred to post-launch.

export type Phase = 'IDLE' | 'SELECTING' | 'PREPARING' | 'WORKING';

// For each phase, the phases it may legally advance to. Reading it as a
// statechart:
//   IDLE ──▶ SELECTING ──▶ PREPARING ──▶ WORKING ──▶ IDLE
//                │              │
//                └──▶ IDLE      └──▶ IDLE      (nothing selected / prepare rejected)
export const PHASE_TRANSITIONS: Record<Phase, readonly Phase[]> = {
  IDLE: ['SELECTING'],
  SELECTING: ['PREPARING', 'IDLE'],
  PREPARING: ['WORKING', 'IDLE'],
  WORKING: ['IDLE'],
};

export const PHASES = Object.keys(PHASE_TRANSITIONS) as Phase[];

// The phase every cycle returns to — the machine's home/rest state.
export const REST_PHASE: Phase = 'IDLE';

// True when `to` is a legal successor of `from`. A no-op re-set (from === to) is
// treated as allowed so an idempotent write never trips the guard.
export function canTransition(from: Phase, to: Phase): boolean {
  if (from === to) return true;
  return PHASE_TRANSITIONS[from].includes(to);
}

// The legal successors of a phase (excluding the idempotent self-edge).
export function nextPhases(from: Phase): readonly Phase[] {
  return PHASE_TRANSITIONS[from];
}