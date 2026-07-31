import { describe, it, expect } from 'vitest';
import {
  triageSeverityRank,
  triageSeverityClass,
  triageEntryForProcess,
  triageEntryForKshetra,
  collectTriageEntries,
} from './triage';

describe('triageSeverityRank', () => {
  it('orders stuck < dead < stale-heartbeat < blocked, unknown last', () => {
    expect(triageSeverityRank('stuck')).toBeLessThan(triageSeverityRank('dead'));
    expect(triageSeverityRank('dead')).toBeLessThan(triageSeverityRank('stale-heartbeat'));
    expect(triageSeverityRank('stale-heartbeat')).toBeLessThan(triageSeverityRank('blocked'));
    expect(triageSeverityRank('weird')).toBeGreaterThan(triageSeverityRank('blocked'));
  });
});

describe('triageSeverityClass', () => {
  it('gives each severity a distinct class and a fallback', () => {
    const classes = ['stuck', 'dead', 'stale-heartbeat', 'blocked'].map(triageSeverityClass);
    expect(new Set(classes).size).toBe(4);
    expect(triageSeverityClass('weird')).toContain('slate');
  });
});

describe('triageEntryForProcess', () => {
  it('surfaces a stuck worker with the watchdog remediation verbatim', () => {
    const e = triageEntryForProcess({
      kind: 'worker',
      kshetraId: 'proj',
      status: 'stuck',
      stuck: { reason: 'repeated 5× without progress', remediation: '  1) do the thing\n  2) shreni resume', beadId: 'proj-7' },
    });
    expect(e).not.toBeNull();
    expect(e!.severity).toBe('stuck');
    expect(e!.key).toBe('stuck:worker:proj');
    expect(e!.reason).toBe('repeated 5× without progress');
    expect(e!.remediation).toBe('  1) do the thing\n  2) shreni resume'); // verbatim
    expect(e!.beadId).toBe('proj-7');
  });

  it('falls back to a resume line when a stuck row lacks the marker payload', () => {
    const e = triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'stuck' });
    expect(e!.remediation).toBe('shreni resume --kshetra proj');
  });

  it('gives a dead process a kind-appropriate restart command', () => {
    const worker = triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'dead' });
    expect(worker!.severity).toBe('dead');
    expect(worker!.remediation).toContain('shreni start --kshetra proj');
    expect(triageEntryForProcess({ kind: 'phalaka', status: 'dead' })!.remediation).toBe('shreni phalaka start');
    expect(triageEntryForProcess({ kind: 'suthradhara', kshetraId: 'proj', status: 'dead' })!.remediation).toBe(
      'shreni suthradhara start --kshetra proj',
    );
  });

  it('surfaces a stale heartbeat with its age and an inspect command', () => {
    const e = triageEntryForProcess({
      kind: 'worker',
      kshetraId: 'proj',
      status: 'stale-heartbeat',
      phase: 'CODING',
      heartbeatAgeMs: 3 * 60_000,
    });
    expect(e!.severity).toBe('stale-heartbeat');
    expect(e!.reason).toContain('3m');
    expect(e!.reason).toContain('phase=CODING');
    expect(e!.remediation).toContain('shreni logs --kshetra proj');
  });

  it('returns null for a healthy/working/idle/paused process', () => {
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'working' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'idle' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'paused-manual' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'phalaka', status: 'healthy' })).toBeNull();
  });
});

describe('triageEntryForKshetra', () => {
  it('emits one aggregate entry when beads are blocked', () => {
    const e = triageEntryForKshetra({ id: 'proj', name: 'Project', counts: { blocked: 3 } });
    expect(e!.severity).toBe('blocked');
    expect(e!.key).toBe('blocked:proj');
    expect(e!.label).toBe('Project');
    expect(e!.reason).toContain('3 beads blocked');
    expect(e!.remediation).toContain('bd list --status=blocked');
  });

  it('uses the singular when exactly one bead is blocked', () => {
    expect(triageEntryForKshetra({ id: 'p', counts: { blocked: 1 } })!.reason).toContain('1 bead blocked');
  });

  it('returns null when nothing is blocked or counts are absent', () => {
    expect(triageEntryForKshetra({ id: 'p', counts: { blocked: 0 } })).toBeNull();
    expect(triageEntryForKshetra({ id: 'p' })).toBeNull();
  });
});

describe('collectTriageEntries', () => {
  it('aggregates process + Kshetra items and sorts by urgency then key', () => {
    const processes = [
      { kind: 'worker', kshetraId: 'b', status: 'stale-heartbeat', phase: 'CODING', heartbeatAgeMs: 180000 },
      { kind: 'worker', kshetraId: 'a', status: 'stuck', stuck: { reason: 'hung', remediation: 'fix it', beadId: 'a-1' } },
      { kind: 'worker', kshetraId: 'c', status: 'working' }, // healthy → dropped
      { kind: 'suthradhara', kshetraId: 'd', status: 'dead' },
    ];
    const kshetras = [{ id: 'e', name: 'E', counts: { blocked: 2 } }];
    const entries = collectTriageEntries(processes, kshetras);
    expect(entries.map(e => e.severity)).toEqual(['stuck', 'dead', 'stale-heartbeat', 'blocked']);
  });

  it('returns an empty array when the whole fleet is healthy', () => {
    expect(collectTriageEntries([{ kind: 'worker', kshetraId: 'a', status: 'idle' }], [])).toEqual([]);
  });
});
