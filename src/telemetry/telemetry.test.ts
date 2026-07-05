import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  emit,
  enableTelemetry,
  disableTelemetry,
  telemetryStatus,
  isTelemetryEnabled,
  loadTelemetryConfig,
  _internal,
  type TelemetryEvent,
} from './telemetry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shreni-tel-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sinkEvents(): TelemetryEvent[] {
  const path = _internal.localSinkPath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('opt-in default', () => {
  it('is disabled with no config', () => {
    expect(telemetryStatus(dir, {}).enabled).toBe(false);
    expect(loadTelemetryConfig(dir)).toEqual({ enabled: false });
  });

  it('emit is a no-op when disabled — nothing is written', () => {
    emit('task_merged', undefined, { dir, env: {} });
    expect(existsSync(_internal.localSinkPath(dir))).toBe(false);
  });
});

describe('enable / disable', () => {
  it('enable persists enabled=true and mints a stable anonymous id', () => {
    const cfg = enableTelemetry(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(cfg.consentedAt).toBeTruthy();
    expect(telemetryStatus(dir, {}).enabled).toBe(true);
  });

  it('re-enabling reuses the same anonymous id (same install, not a new one)', () => {
    const id1 = enableTelemetry(dir).anonymousId;
    disableTelemetry(dir);
    const id2 = enableTelemetry(dir).anonymousId;
    expect(id2).toBe(id1);
  });

  it('disable stops sending but keeps the id', () => {
    const id = enableTelemetry(dir).anonymousId;
    const cfg = disableTelemetry(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.anonymousId).toBe(id);
    emit('session_start', undefined, { dir, env: {} });
    expect(sinkEvents()).toEqual([]);
  });
});

describe('env overrides', () => {
  it('hard opt-out (DO_NOT_TRACK / SHRENI_TELEMETRY=0) wins over enabled config', () => {
    enableTelemetry(dir);
    expect(isTelemetryEnabled(loadTelemetryConfig(dir), { DO_NOT_TRACK: '1' })).toBe(false);
    expect(isTelemetryEnabled(loadTelemetryConfig(dir), { SHRENI_TELEMETRY: '0' })).toBe(false);
    expect(isTelemetryEnabled(loadTelemetryConfig(dir), { SHRENI_TELEMETRY: 'off' })).toBe(false);
  });

  it('env opt-in (SHRENI_TELEMETRY=1) forces on even with disabled config', () => {
    expect(isTelemetryEnabled({ enabled: false }, { SHRENI_TELEMETRY: '1' })).toBe(true);
    expect(isTelemetryEnabled({ enabled: false }, { SHRENI_TELEMETRY: 'on' })).toBe(true);
  });
});

describe('local sink event shape (no PII)', () => {
  it('writes a well-formed, non-identifying event when enabled with no endpoint', () => {
    enableTelemetry(dir);
    emit('task_merged', { policy: 'push' }, { dir, env: {} });
    const events = sinkEvents();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.name).toBe('task_merged');
    expect(e.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(typeof e.ts).toBe('string');
    expect(e.platform).toBe(process.platform);
    expect(e.props).toEqual({ policy: 'push' });
    // Guard against PII leakage: no path/repo/user/email-ish keys anywhere.
    const blob = JSON.stringify(e).toLowerCase();
    for (const banned of ['/users/', 'repo', 'path', 'email', 'slug', 'remote', 'token']) {
      expect(blob).not.toContain(banned);
    }
  });

  it('accumulates multiple events as jsonl', () => {
    enableTelemetry(dir);
    emit('session_start', undefined, { dir, env: {} });
    emit('kshetra_init', { provider: 'anthropic' }, { dir, env: {} });
    expect(sinkEvents().map(e => e.name)).toEqual(['session_start', 'kshetra_init']);
  });
});

describe('never throws', () => {
  it('swallows errors from a bad directory rather than surfacing them', () => {
    // A NUL byte makes the path invalid; emit must still not throw.
    expect(() => emit('task_merged', undefined, { dir: '\0bad', env: { SHRENI_TELEMETRY: '1' } })).not.toThrow();
  });
});