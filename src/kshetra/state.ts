import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { KshetraConfig } from './config.js';

const STATE_PATH = resolve(homedir(), '.shreni', 'state.json');

interface KshetraState {
  paused: boolean;
  reason?: string;
  message?: string;
  pausedAt?: string;
  requiresManualResume?: boolean;
  // Accepted count of known-failing tests. The health gate treats the suite as
  // green when current failures are <= this. Bumped (quarantine) when a repair
  // task can't reach zero, so unrelated failures never wedge the whole Kshetra.
  healthBaseline?: number;
  // Per-bead restart/recovery attempt counts. RECOVER reopens a stranded bead
  // until its count exceeds the budget, then leaves it blocked (see recover.ts).
  beadAttempts?: Record<string, number>;
  // Watchdog progress tracking (see watchdog.ts). lastProgressAt is stamped on
  // forward progress (claim/done); lastOutcome + outcomeRepeatCount track a
  // repeating non-advancing outcome (e.g. "branch already exists" ×N).
  lastProgressAt?: string;
  lastOutcome?: string;
  outcomeRepeatCount?: number;
  // Set when the watchdog declares the worker stuck — surfaced by Phalaka.
  stuck?: { since: string; reason: string; remediation: string; phase?: string; beadId?: string };
  // Current worker lifecycle phase (IDLE/SELECTING/PREPARING/WORKING), persisted
  // by the scheduler so `shreni status` / Phalaka can show it cross-process.
  phase?: string;
}

interface State {
  kshetras: Record<string, KshetraState>;
}

export function loadState(): State {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw) as State;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { kshetras: {} };
    throw new Error(`Cannot read state at ${STATE_PATH}: ${e.message}`);
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function pauseKshetra(
  kshetra: KshetraConfig,
  opts: { cooldownMs?: number; manual?: boolean; reason: string; message: string },
): void {
  const state = loadState();
  state.kshetras[kshetra.id] = {
    ...state.kshetras[kshetra.id],
    paused: true,
    reason: opts.reason,
    message: opts.message,
    pausedAt: new Date().toISOString(),
    requiresManualResume: opts.manual ?? false,
  };
  saveState(state);
}

export function resumeKshetra(kshetra: KshetraConfig): void {
  const state = loadState();
  // Resume IS the circuit-breaker ACK (the watchdog design §3.3): the human has
  // acted, so clear the stuck marker AND the manual-resume gate AND the stall counter,
  // and start the worker fresh rather than re-tripping on a stale count or coming up
  // still gated. Without clearing requiresManualResume the chip stays dimmed after an
  // ACK even though the latch is gone (RC3 cosmetic leak).
  const { stuck: _stuck, ...rest } = state.kshetras[kshetra.id] ?? { paused: false };
  state.kshetras[kshetra.id] = {
    ...rest,
    paused: false,
    requiresManualResume: false,
    outcomeRepeatCount: 0,
    lastOutcome: undefined,
  };
  saveState(state);
}

// Forward progress: stamp the time and clear the stall counter.
export function recordProgress(kshetra: KshetraConfig): void {
  const state = loadState();
  const current = state.kshetras[kshetra.id] ?? { paused: false };
  state.kshetras[kshetra.id] = {
    ...current,
    lastProgressAt: new Date().toISOString(),
    lastOutcome: undefined,
    outcomeRepeatCount: 0,
  };
  saveState(state);
}

// A non-advancing outcome (preflight reject, off-branch abort, cycle error…).
// Increments the repeat counter when the same outcome recurs; returns the count.
export function recordStall(kshetra: KshetraConfig, outcome: string): number {
  const state = loadState();
  const current = state.kshetras[kshetra.id] ?? { paused: false };
  const count = current.lastOutcome === outcome ? (current.outcomeRepeatCount ?? 0) + 1 : 1;
  state.kshetras[kshetra.id] = { ...current, lastOutcome: outcome, outcomeRepeatCount: count };
  saveState(state);
  return count;
}

export function setStuck(
  kshetra: KshetraConfig,
  info: { reason: string; remediation: string; phase?: string; beadId?: string },
): void {
  const state = loadState();
  const current = state.kshetras[kshetra.id] ?? { paused: false };
  state.kshetras[kshetra.id] = {
    ...current,
    stuck: { since: new Date().toISOString(), ...info },
  };
  saveState(state);
}

export function setPhase(kshetra: KshetraConfig, phase: string): void {
  const state = loadState();
  const current = state.kshetras[kshetra.id] ?? { paused: false };
  state.kshetras[kshetra.id] = { ...current, phase };
  saveState(state);
}

export function getProgressState(kshetra: KshetraConfig): {
  lastProgressAt?: string;
  lastOutcome?: string;
  outcomeRepeatCount: number;
  stuck?: KshetraState['stuck'];
} {
  const s = loadState().kshetras[kshetra.id];
  return {
    lastProgressAt: s?.lastProgressAt,
    lastOutcome: s?.lastOutcome,
    outcomeRepeatCount: s?.outcomeRepeatCount ?? 0,
    stuck: s?.stuck,
  };
}

// Accepted count of known-failing tests for the health gate. Defaults to 0
// (suite must be fully green) until quarantine bumps it.
export function getHealthBaseline(kshetra: KshetraConfig): number {
  return loadState().kshetras[kshetra.id]?.healthBaseline ?? 0;
}

export function setHealthBaseline(kshetra: KshetraConfig, count: number): void {
  const state = loadState();
  state.kshetras[kshetra.id] = {
    ...(state.kshetras[kshetra.id] ?? { paused: false }),
    healthBaseline: count,
  };
  saveState(state);
}

// Record one more recovery attempt for a bead and return the new total.
export function recordBeadAttempt(kshetra: KshetraConfig, beadId: string): number {
  const state = loadState();
  const current = state.kshetras[kshetra.id] ?? { paused: false };
  const attempts = { ...(current.beadAttempts ?? {}) };
  attempts[beadId] = (attempts[beadId] ?? 0) + 1;
  state.kshetras[kshetra.id] = { ...current, beadAttempts: attempts };
  saveState(state);
  return attempts[beadId];
}

export function getBeadAttempts(kshetra: KshetraConfig, beadId: string): number {
  return loadState().kshetras[kshetra.id]?.beadAttempts?.[beadId] ?? 0;
}

// Clear a bead's attempt count — called when it finally succeeds, so a later
// unrelated reuse of the id (or a re-filed follow-up) starts fresh.
export function clearBeadAttempts(kshetra: KshetraConfig, beadId: string): void {
  const state = loadState();
  const current = state.kshetras[kshetra.id];
  if (!current?.beadAttempts || !(beadId in current.beadAttempts)) return;
  const attempts = { ...current.beadAttempts };
  delete attempts[beadId];
  state.kshetras[kshetra.id] = { ...current, beadAttempts: attempts };
  saveState(state);
}

export function isKshetraManuallyPaused(kshetra: KshetraConfig): boolean {
  const state = loadState();
  const s = state.kshetras[kshetra.id];
  return s?.paused === true && s.requiresManualResume === true;
}

// Clear a stale *stuck* pause on worker (re)start. The watchdog escalates a hung
// worker with paused+requiresManualResume and reason:'stuck'; its remediation
// tells the human to `shreni stop && shreni start` so RECOVER reconciles the
// drift. But RECOVER only reconciles git/beads/phase — without this, the fresh
// worker inherits the previous worker's pause and is dead-on-arrival (selectNext
// returns null, and the watchdog short-circuits on the leftover stuck marker),
// flying a stale banner forever. Once RECOVER has run the stuck condition is
// reconciled by definition, so clear it. A deliberate user pause (reason:
// 'manual', via `shreni pause`) is preserved — a restart must not silently
// un-pause work a human paused on purpose. Returns whether it cleared anything.
//
export function clearStuckPauseOnRecover(kshetra: KshetraConfig): boolean {
  const state = loadState();
  const s = state.kshetras[kshetra.id];
  if (!s?.paused || s.reason !== 'stuck') return false;
  const { stuck: _stuck, ...rest } = s;
  state.kshetras[kshetra.id] = {
    ...rest,
    paused: false,
    requiresManualResume: false,
    reason: undefined,
    message: undefined,
    outcomeRepeatCount: 0,
    lastOutcome: undefined,
  };
  saveState(state);
  return true;
}

export function clearCooldownPauses(): void {
  const state = loadState();
  for (const [id, s] of Object.entries(state.kshetras)) {
    if (s.paused && !s.requiresManualResume) {
      state.kshetras[id] = { ...s, paused: false };
    }
  }
  saveState(state);
}