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

const { loadState, pauseKshetra, resumeKshetra, isKshetraManuallyPaused, clearCooldownPauses } =
  await import('./state.js');

const KSHETRA = {
  id: 'sishya',
  name: 'Sishya',
  repo: { path: '/projects/sishya', remote: '', mainBranch: 'main' },
  beads: { path: '/projects/sishya-beads', remote: '' },
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
    const raw = { kshetras: { sishya: { paused: false } } };
    require('fs').writeFileSync(statePath, JSON.stringify(raw));
    const state = loadState();
    expect(state.kshetras.sishya.paused).toBe(false);
  });
});

describe('pauseKshetra', () => {
  it('writes paused=true with reason and message to state.json', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'API unavailable' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(true);
    expect(raw.kshetras.sishya.reason).toBe('api_down');
    expect(raw.kshetras.sishya.message).toBe('API unavailable');
    expect(raw.kshetras.sishya.requiresManualResume).toBe(false);
  });

  it('sets requiresManualResume:true when manual:true', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'Push rejected', manual: true });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.requiresManualResume).toBe(true);
  });

  it('writes pausedAt timestamp', () => {
    pauseKshetra(KSHETRA, { reason: 'bd_failed', message: 'bd error' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(typeof raw.kshetras.sishya.pausedAt).toBe('string');
    expect(new Date(raw.kshetras.sishya.pausedAt).getTime()).toBeGreaterThan(0);
  });

  it('creates state file if it does not exist', () => {
    rmSync(statePath, { force: true });
    pauseKshetra(KSHETRA, { reason: 'test', message: 'test' });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(true);
  });

  it('preserves state of other kshetras when pausing one', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(true);
    expect(raw.kshetras.bms.paused).toBe(true);
    expect(raw.kshetras.bms.requiresManualResume).toBe(true);
  });
});

describe('resumeKshetra', () => {
  it('sets paused:false for the kshetra', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down', manual: true });
    resumeKshetra(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(false);
  });

  it('does not affect other kshetras', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    resumeKshetra(KSHETRA);
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(false);
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
    expect(raw.kshetras.sishya.paused).toBe(false);
  });

  it('preserves manual pauses', () => {
    pauseKshetra(KSHETRA, { reason: 'git_failed', message: 'failed', manual: true });
    clearCooldownPauses();
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(true);
  });

  it('clears cooldown pauses while keeping manual pauses', () => {
    pauseKshetra(KSHETRA, { reason: 'api_down', message: 'down' });
    pauseKshetra(KSHETRA2, { reason: 'git_failed', message: 'push failed', manual: true });
    clearCooldownPauses();
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(raw.kshetras.sishya.paused).toBe(false);
    expect(raw.kshetras.bms.paused).toBe(true);
  });
});