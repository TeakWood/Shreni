import { describe, it, expect } from 'vitest';
import {
  isActiveStatus,
  priorityLabel,
  statusBadgeClass,
  processKey,
  processStatusPillClass,
  formatAge,
  processLabel,
  formatTokens,
  formatCost,
  planningKey,
  planningPhaseLabel,
  planningPhaseClass,
} from './format';

describe('isActiveStatus', () => {
  it('treats open/in_progress/blocked as active', () => {
    expect(isActiveStatus('open')).toBe(true);
    expect(isActiveStatus('in_progress')).toBe(true);
    expect(isActiveStatus('blocked')).toBe(true);
  });
  it('treats closed/deferred as inactive', () => {
    expect(isActiveStatus('closed')).toBe(false);
    expect(isActiveStatus('deferred')).toBe(false);
  });
});

describe('priorityLabel', () => {
  it('formats as P<n>', () => {
    expect(priorityLabel(0)).toBe('P0');
    expect(priorityLabel(2)).toBe('P2');
  });
});

describe('statusBadgeClass', () => {
  it('returns distinct classes per known status and a fallback', () => {
    expect(statusBadgeClass('open')).not.toBe(statusBadgeClass('blocked'));
    expect(statusBadgeClass('closed')).toContain('slate');
    expect(statusBadgeClass('weird')).toContain('slate');
  });
});

describe('processKey', () => {
  it('matches keyOf() in stream.ts: kind:kshetraId', () => {
    expect(processKey({ kind: 'worker', kshetraId: 'proj' })).toBe('worker:proj');
  });
  it('leaves the kshetra segment empty for the singleton Phalaka', () => {
    expect(processKey({ kind: 'phalaka' })).toBe('phalaka:');
  });
});

describe('processStatusPillClass', () => {
  it('greens the healthy states and reds the escalations', () => {
    expect(processStatusPillClass('working')).toContain('emerald');
    expect(processStatusPillClass('healthy')).toContain('emerald');
    expect(processStatusPillClass('stuck')).toContain('red');
    expect(processStatusPillClass('dead')).toContain('red');
  });
  it('distinguishes idle, paused and stale from one another', () => {
    const idle = processStatusPillClass('idle');
    const paused = processStatusPillClass('paused-manual');
    const stale = processStatusPillClass('stale-heartbeat');
    expect(new Set([idle, paused, stale]).size).toBe(3);
  });
  it('falls back to neutral slate for an unknown status', () => {
    expect(processStatusPillClass('weird')).toContain('slate');
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(3 * 60_000)).toBe('3m');
    expect(formatAge(2 * 3_600_000)).toBe('2h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
  it('renders a dash for a missing/invalid age', () => {
    expect(formatAge(undefined)).toBe('—');
    expect(formatAge(null)).toBe('—');
    expect(formatAge(-5)).toBe('—');
  });
});

describe('processLabel', () => {
  it('names a worker/suthradhara by its Kshetra', () => {
    expect(processLabel({ kind: 'worker', kshetraId: 'proj' })).toBe('proj');
    expect(processLabel({ kind: 'suthradhara', kshetraId: 'proj' })).toBe('proj');
  });
  it('labels the kshetra-less Phalaka singleton', () => {
    expect(processLabel({ kind: 'phalaka' })).toBe('dashboard');
  });
});

describe('formatTokens', () => {
  it('formats magnitudes compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(34_000)).toBe('34k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
  });
  it('renders a dash for an invalid count', () => {
    expect(formatTokens(-1)).toBe('—');
    expect(formatTokens(Infinity)).toBe('—');
  });
});

describe('formatCost', () => {
  it('formats a priced cost as USD', () => {
    expect(formatCost(0.5, true)).toBe('$0.50');
    expect(formatCost(12.3, true)).toBe('$12.30');
  });
  it('shows extra precision for sub-cent costs, and a plain zero', () => {
    expect(formatCost(0.0004, true)).toBe('$0.0004');
    expect(formatCost(0, true)).toBe('$0.00');
  });
  it('reads unpriced when the run was not in the price table', () => {
    expect(formatCost(0, false)).toBe('unpriced');
    expect(formatCost(999, false)).toBe('unpriced');
  });
});

describe('planning session helpers', () => {
  it('keys a session by its (globally-unique) session id', () => {
    expect(planningKey({ sessionId: 'alpha-abc123' })).toBe('alpha-abc123');
  });
  it('labels each lifecycle phase', () => {
    expect(planningPhaseLabel('launched')).toBe('launched');
    expect(planningPhaseLabel('plan_filed')).toBe('plan filed');
    expect(planningPhaseLabel('doc_pushed')).toBe('doc pushed');
    expect(planningPhaseLabel('ended')).toBe('ended');
  });
  it('gives every phase a non-empty pill class', () => {
    for (const p of ['launched', 'plan_filed', 'doc_pushed', 'ended']) {
      expect(planningPhaseClass(p).length).toBeGreaterThan(0);
    }
  });
});
