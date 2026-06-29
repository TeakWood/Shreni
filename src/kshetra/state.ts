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
  state.kshetras[kshetra.id] = { ...state.kshetras[kshetra.id], paused: false };
  saveState(state);
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

export function isKshetraManuallyPaused(kshetra: KshetraConfig): boolean {
  const state = loadState();
  const s = state.kshetras[kshetra.id];
  return s?.paused === true && s.requiresManualResume === true;
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