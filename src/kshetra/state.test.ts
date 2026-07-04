import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = join(tmpdir(), `shreni-state-test-${process.pid}`);
const statePath = join(dir, '.shreni', 'state.json');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => dir };
});

const {
  loadState, pauseKshetra, resumeKshetra, isKshetraManuallyPaused, clearCooldownPauses,
  clearStuckPauseOnRecover,
  recordBeadAttempt, getBeadAttempts, clearBeadAttempts,
  recordProgress, recordStall, setStuck, getProgressState,
} = await import('./state.js');

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads', remote: '' },
  agents: { maxRoundsPerBead: 5 },
} as unknown as import('./config.js').KshetraConfig;

const KSHETRA2 = { ...KSHETRA, id: 'bms' } as unknown as import('./config.js').KshetraConfig;

beforeEach(() => {
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
  mkdirSync(join(dir, '.shreni'), { recursive: true });
});

afterEach(() => {
  try { rmSync(join(dir, '.shreni'), { recursive: true }); } catch { /* ok */ }
});

describe('loadState', () => {
  it('returns empty kshetras when state file does not exist', () => {
    rmSync(join(dir, '.shreni'), { recursive: true, force: true });
    const state = loadState();
    expect(state.kshetras).toEqual({});
  });

  it('reads existing state file', () => {
    mkdirSync(join(dir, '.shreni'), { recursive: true });
    const raw = { kshetras: { myapp: { paused: false } } };
    require('fs').writeFileSync(statePath, JSON.stringify(raw));
    const state = loadState();
    expect(state.kshetras.myapp.paused).toBe(false);
  });
});

describe('pauseKshetra', () => {
  it('writes paused=true with reason and message to state.json', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'API unavailable' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(true);
    expect(raw.kshetras.myapp.reason).toBe('api_down');
    expect(raw.kshetras.myapp.message).toBe('API unavailable');
    expect(raw.kshetras.myapp.requiresManualResume).toBe(false);
  });

  it('sets requiresManualResume:true when manual:true', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'Push rejected', manual: true });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.requiresManualResume).toBe(true);
  });

  it('writes pausedAt timestamp', () => {
    pauseKshetra(KSHETRA, { reason: 'bd_failed', message: 'bd error' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(typeof raw.kshetras.myapp.pausedAt).toBe('string');
    expect(new Date(raw.kshetras.myapp.pausedAt).getTime()).toBeGreaterThan(0);
  });

  it('creates state file if it does not exist', () => {
    rmSync(statePath, { force: true });
    pauseKshetra(KSHETRA, { reason: 'test', message: 'test' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(true);
  });

  it('preserves state of other kshetras when pausing one', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(true);
    expect(raw.kshetras.bms.paused).toBe(true);
    expect(raw.kshetras.bms.requiresManualResume).toBe(true);
  });
});

describe('resumeKshetra', () => {
  it('sets paused:false for the kshetra', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down', manual: true });
    resumeKshetra(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
  });

  it('does not affect other kshetras', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    resumeKshetra(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
    expect(raw.kshetras.bms.paused).toBe(true);
  });

  it('clears requiresManualResume (ACK ungates the worker — RC3 cosmetic leak)', () => {
    pauseKshetra(KSHETRA, { reason: 'stuck', message: 'hung', manual: true });
    resumeKshetra(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.requiresManualResume).toBe(false);
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
  });
});

describe('clearStuckPauseOnRecover', () => {
  it('clears an auto-escalated stuck pause (reason:stuck)', () => {
    setStuck(KSHETRA, { reason: 'hung', remediation: 'restart' });
    recordStall(KSHETRA, 'base suite red');
    pauseKshetra(KSHETRA, { reason: 'stuck', message: 'hung', manual: true });
    expect(clearStuckPauseOnRecover(KSHETRA)).toBe(true);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
    expect(raw.kshetras.myapp.requiresManualResume).toBe(false);
    expect(raw.kshetras.myapp.stuck).toBeUndefined();
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
    const ps = getProgressState(KSHETRA);
    expect(ps.outcomeRepeatCount).toBe(0);
    expect(ps.lastOutcome).toBeUndefined();
  });

  it('leaves a deliberate user pause (reason:manual) untouched', () => {
    pauseKshetra(KSHETRA, { reason: 'manual', message: 'Paused via CLI', manual: true });
    expect(clearStuckPauseOnRecover(KSHETRA)).toBe(false);
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(true);
  });

  it('is a no-op when the kshetra is not paused', () => {
    resumeKshetra(KSHETRA);
    expect(clearStuckPauseOnRecover(KSHETRA)).toBe(false);
  });

  it('is a no-op for an unknown kshetra', () => {
    expect(clearStuckPauseOnRecover(KSHETRA2)).toBe(false);
  });

  it('does not disturb other kshetras', () => {
    pauseKshetra(KSHETRA, { reason: 'stuck', message: 'hung', manual: true });
    pauseKshetra(KSHETRA2, { reason: 'manual', message: 'Paused via CLI', manual: true });
    clearStuckPauseOnRecover(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
    expect(raw.kshetras.bms.paused).toBe(true);
  });
});

describe('isKshetraManuallyPaused', () => {
  it('returns false when state file does not exist', () => {
    rmSync(statePath, { force: true });
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
  });

  it('returns false when kshetra is not paused', () => {
    resumeKshetra(KSHETRA);
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
  });

  it('returns false when paused with requiresManualResume:false (cooldown)', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
  });

  it('returns true when paused with requiresManualResume:true', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'push failed', manual: true });
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(true);
  });
});

describe('clearCooldownPauses', () => {
  it('clears pauses where requiresManualResume is false', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    clearCooldownPauses();
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
  });

  it('preserves manual pauses', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'failed', manual: true });
    clearCooldownPauses();
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(true);
  });

  it('clears cooldown pauses while keeping manual pauses', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    clearCooldownPauses();
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.myapp.paused).toBe(false);
    expect(raw.kshetras.bms.paused).toBe(true);
  });
});

describe('bead attempt budget', () => {
  it('records and returns an incrementing attempt count', () => {
    expect(getBeadAttempts(KSHETRA, 'bead-1')).toBe(0);
    expect(recordBeadAttempt(KSHETRA, 'bead-1')).toBe(1);
    expect(recordBeadAttempt(KSHETRA, 'bead-1')).toBe(2);
    expect(getBeadAttempts(KSHETRA, 'bead-1')).toBe(2);
  });

  it('tracks beads and kshetras independently', () => {
    recordBeadAttempt(KSHETRA, 'bead-1');
    recordBeadAttempt(KSHETRA, 'bead-2');
    recordBeadAttempt(KSHETRA2, 'bead-1');
    expect(getBeadAttempts(KSHETRA, 'bead-1')).toBe(1);
    expect(getBeadAttempts(KSHETRA, 'bead-2')).toBe(1);
    expect(getBeadAttempts(KSHETRA2, 'bead-1')).toBe(1);
  });

  it('does not disturb other state fields (e.g. pause)', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'x', manual: true });
    recordBeadAttempt(KSHETRA, 'bead-1');
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(true);
  });

  it('clearBeadAttempts removes only that bead', () => {
    recordBeadAttempt(KSHETRA, 'bead-1');
    recordBeadAttempt(KSHETRA, 'bead-2');
    clearBeadAttempts(KSHETRA, 'bead-1');
    expect(getBeadAttempts(KSHETRA, 'bead-1')).toBe(0);
    expect(getBeadAttempts(KSHETRA, 'bead-2')).toBe(1);
  });

  it('clearBeadAttempts is a no-op for unknown bead', () => {
    expect(() => clearBeadAttempts(KSHETRA, 'ghost')).not.toThrow();
  });
});

describe('watchdog progress tracking', () => {
  it('recordStall increments for the same outcome, resets for a new one', () => {
    expect(recordStall(KSHETRA, 'branch exists')).toBe(1);
    expect(recordStall(KSHETRA, 'branch exists')).toBe(2);
    expect(recordStall(KSHETRA, 'dirty tree')).toBe(1); // different outcome resets
    expect(getProgressState(KSHETRA).outcomeRepeatCount).toBe(1);
    expect(getProgressState(KSHETRA).lastOutcome).toBe('dirty tree');
  });

  it('recordProgress clears the stall counter and stamps lastProgressAt', () => {
    recordStall(KSHETRA, 'branch exists');
    recordStall(KSHETRA, 'branch exists');
    recordProgress(KSHETRA);
    const ps = getProgressState(KSHETRA);
    expect(ps.outcomeRepeatCount).toBe(0);
    expect(ps.lastOutcome).toBeUndefined();
    expect(ps.lastProgressAt).toBeTruthy();
  });

  it('recordProgress does NOT clear the stuck latch (only an ACK does — circuit-breaker)', () => {
    setStuck(KSHETRA, { reason: 'hung', remediation: 'm' });
    recordProgress(KSHETRA);
    expect(getProgressState(KSHETRA).stuck?.reason).toBe('hung');
  });

  it('setStuck records reason + remediation, surfaced by getProgressState', () => {
    setStuck(KSHETRA, { reason: 'hung', remediation: 'restart it', phase: 'WORKING', beadId: 'bd-1' });
    const stuck = getProgressState(KSHETRA).stuck;
    expect(stuck?.reason).toBe('hung');
    expect(stuck?.remediation).toBe('restart it');
    expect(stuck?.since).toBeTruthy();
  });

  it('resumeKshetra clears the stuck marker and the stall counter', () => {
    recordStall(KSHETRA, 'branch exists');
    setStuck(KSHETRA, { reason: 'r', remediation: 'm' });
    pauseKshetra(KSHETRA, { reason: 'stuck', message: 'r', manual: true });
    resumeKshetra(KSHETRA);
    const ps = getProgressState(KSHETRA);
    expect(ps.stuck).toBeUndefined();
    expect(ps.outcomeRepeatCount).toBe(0);
    expect(isKshetraManuallyPaused(KSHETRA)).toBe(false);
  });
});