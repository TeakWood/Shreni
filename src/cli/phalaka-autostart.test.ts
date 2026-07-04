import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PhalakaStartResult, PhalakaStopResult } from './phalaka';

const mockStartPhalaka = vi.fn<() => PhalakaStartResult>();
const mockStopPhalaka = vi.fn<() => PhalakaStopResult>();

vi.mock('./phalaka', () => ({
  startPhalaka: () => mockStartPhalaka(),
  stopPhalaka: () => mockStopPhalaka(),
}));

const { isDashboardDisabled, autoStartPhalaka, autoStopPhalaka } = await import('./phalaka-autostart');

const STARTED: PhalakaStartResult = {
  status: 'started',
  pid: 4242,
  port: 7348,
  url: 'http://127.0.0.1:7348/?token=t',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStartPhalaka.mockReturnValue(STARTED);
  mockStopPhalaka.mockReturnValue({ status: 'stopped', pid: 4242 });
});

describe('isDashboardDisabled', () => {
  it('is false by default (auto-start on)', () => {
    expect(isDashboardDisabled([], {})).toBe(false);
  });

  it('is true with --no-dashboard', () => {
    expect(isDashboardDisabled(['--no-dashboard'], {})).toBe(true);
  });

  it('is true with PHALAKA_DISABLE=1', () => {
    expect(isDashboardDisabled([], { PHALAKA_DISABLE: '1' })).toBe(true);
  });

  it('ignores PHALAKA_DISABLE values other than "1"', () => {
    expect(isDashboardDisabled([], { PHALAKA_DISABLE: '0' })).toBe(false);
  });
});

describe('autoStartPhalaka', () => {
  it('starts the dashboard by default', () => {
    const result = autoStartPhalaka([], {});
    expect(result).toEqual(STARTED);
    expect(mockStartPhalaka).toHaveBeenCalledOnce();
  });

  it('does not start when --no-dashboard is passed', () => {
    const result = autoStartPhalaka(['--no-dashboard'], {});
    expect(result.status).toBe('disabled');
    expect(mockStartPhalaka).not.toHaveBeenCalled();
  });

  it('does not start when PHALAKA_DISABLE=1', () => {
    const result = autoStartPhalaka([], { PHALAKA_DISABLE: '1' });
    expect(result.status).toBe('disabled');
    expect(mockStartPhalaka).not.toHaveBeenCalled();
  });

  it('still starts even when a --kshetra filter is present', () => {
    autoStartPhalaka(['--kshetra', 'myapp'], {});
    expect(mockStartPhalaka).toHaveBeenCalledOnce();
  });
});

describe('autoStopPhalaka', () => {
  it('stops the dashboard on a full stop (no --kshetra)', () => {
    const result = autoStopPhalaka([]);
    expect(result).toEqual({ status: 'stopped', pid: 4242 });
    expect(mockStopPhalaka).toHaveBeenCalledOnce();
  });

  it('skips stopping when a single Kshetra is targeted', () => {
    const result = autoStopPhalaka(['--kshetra', 'myapp']);
    expect(result.status).toBe('skipped');
    expect(mockStopPhalaka).not.toHaveBeenCalled();
  });
});