import { describe, it, expect } from 'vitest';
import {
  LEDGER_SCHEMA_VERSION,
  isDecisionGrade,
  audienceFor,
  readLedger,
  parseLedgerLines,
  toLedgerEntry,
  type LedgerEntry,
  type LedgerAudience,
} from './ledger.js';
import type { LoggedEvent } from '../sthapathi/activity-log.js';

// Build a fully-stamped LoggedEvent (envelope + payload) for tests.
function ev(e: Partial<LoggedEvent> & { type: LoggedEvent['type'] }): LoggedEvent {
  return {
    ts: '2026-09-16T00:00:00.000Z',
    schemaVersion: 1,
    kshetra: 'myapp',
    ...e,
  } as LoggedEvent;
}

describe('isDecisionGrade', () => {
  it('accepts the lifecycle turning points', () => {
    expect(isDecisionGrade(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'silpi_done', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'viharapala_done', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'task_done', beadId: 'b1' } as LoggedEvent))).toBe(true);
  });

  it('accepts the new decision-grade kinds (4a2.2)', () => {
    expect(isDecisionGrade(ev({ type: 'run_started', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'policy_decision', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'gate_result', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'merge_done', beadId: 'b1' } as LoggedEvent))).toBe(true);
    expect(isDecisionGrade(ev({ type: 'run_usage', beadId: 'b1' } as LoggedEvent))).toBe(true);
  });

  it('rejects the high-volume run-log tier', () => {
    expect(isDecisionGrade(ev({ type: 'agent_text', beadId: 'b1' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'agent_tool_call', beadId: 'b1' } as LoggedEvent))).toBe(false);
  });

  it('rejects pure telemetry and planning-session lifecycle', () => {
    expect(isDecisionGrade(ev({ type: 'round_start', beadId: 'b1' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'beads_synced' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'error', message: 'x' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'suthradhara_launched' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'suthradhara_session_ended' } as LoggedEvent))).toBe(false);
  });
});

describe('audienceFor', () => {
  it('classifies lifecycle turning points as agent-visible', () => {
    for (const kind of ['task_claimed', 'silpi_done', 'viharapala_done', 'task_done'] as const) {
      expect(audienceFor(kind)).toBe<LedgerAudience>('agent');
    }
  });

  it('classifies the new decision-grade kinds by audience (4a2.2)', () => {
    for (const kind of ['run_started', 'policy_decision', 'gate_result', 'run_usage'] as const) {
      expect(audienceFor(kind)).toBe<LedgerAudience>('operator');
    }
    expect(audienceFor('merge_done')).toBe<LedgerAudience>('audit');
  });

  it('classifies non-decision kinds as audit-only (most restrictive)', () => {
    for (const kind of ['agent_text', 'round_start', 'beads_synced', 'error', 'suthradhara_launched'] as const) {
      expect(audienceFor(kind)).toBe<LedgerAudience>('audit');
    }
  });
});

describe('toLedgerEntry', () => {
  it('lifts the envelope out and folds the rest into payload', () => {
    const source = ev({
      type: 'task_claimed',
      beadId: 'b7',
      title: 'Do the thing',
      runId: 'run-123',
    } as LoggedEvent);
    const entry = toLedgerEntry(source);
    expect(entry).toEqual<LedgerEntry>({
      ts: '2026-09-16T00:00:00.000Z',
      schemaVersion: LEDGER_SCHEMA_VERSION,
      kshetra: 'myapp',
      beadId: 'b7',
      runId: 'run-123',
      kind: 'task_claimed',
      payload: { title: 'Do the thing' },
    });
  });

  it('stamps the ledger schema version, not the source activity version', () => {
    const source = { ...ev({ type: 'task_done', beadId: 'b1' } as LoggedEvent), schemaVersion: 99 };
    expect(toLedgerEntry(source).schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
  });

  it('omits runId when the source event has none', () => {
    const entry = toLedgerEntry(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent));
    expect('runId' in entry).toBe(false);
  });

  it('round-trips through JSON', () => {
    const entry = toLedgerEntry(
      ev({ type: 'viharapala_done', beadId: 'b1', round: 2, verdict: 'APPROVE', score: 9, mustFix: [], runId: 'r1' } as LoggedEvent),
    );
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });
});

describe('parseLedgerLines', () => {
  it('parses one JSON object per line and skips blanks', () => {
    const a = toLedgerEntry(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent));
    const b = toLedgerEntry(ev({ type: 'task_done', beadId: 'b1' } as LoggedEvent));
    const raw = `\n${JSON.stringify(a)}\n\n${JSON.stringify(b)}\n`;
    expect(parseLedgerLines(raw)).toEqual([a, b]);
  });

  it('drops a corrupt/half-written line rather than failing the whole read', () => {
    const good = toLedgerEntry(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent));
    const raw = `${JSON.stringify(good)}\n{ this is not json\n`;
    expect(parseLedgerLines(raw)).toEqual([good]);
  });

  it('drops valid-JSON non-object lines (null / primitive / array) so readLedger never derefs a primitive', () => {
    const good = toLedgerEntry(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent));
    const raw = ['null', '123', '"a string"', '[1,2,3]', JSON.stringify(good)].join('\n');
    const parsed = parseLedgerLines(raw);
    expect(parsed).toEqual([good]);
    // The null line, if it had leaked through, would crash this read.
    expect(() => readLedger(parsed, 'b1', { audience: 'audit' })).not.toThrow();
  });
});

describe('readLedger (gated read path)', () => {
  const entries: LedgerEntry[] = [
    { ts: '1', schemaVersion: 1, kshetra: 'k', beadId: 'b1', kind: 'task_claimed', payload: {} }, // agent
    { ts: '2', schemaVersion: 1, kshetra: 'k', beadId: 'b1', kind: 'silpi_done', payload: {} }, // agent
    { ts: '3', schemaVersion: 1, kshetra: 'k', beadId: 'b2', kind: 'task_claimed', payload: {} }, // other bead
    // A forward-compat entry with a kind this build cannot classify → audit-only.
    { ts: '4', schemaVersion: 1, kshetra: 'k', beadId: 'b1', kind: 'future_kind' as LoggedEvent['type'], payload: {} },
  ];

  it('filters to the requested bead', () => {
    const seen = readLedger(entries, 'b1', { audience: 'audit' });
    expect(seen.every(e => e.beadId === 'b1')).toBe(true);
    expect(seen.some(e => e.beadId === 'b2')).toBe(false);
  });

  it('an agent-clearance reader sees only agent-audience kinds', () => {
    const seen = readLedger(entries, 'b1', { audience: 'agent' });
    expect(seen.map(e => e.kind)).toEqual(['task_claimed', 'silpi_done']);
  });

  it('withholds an unknown (forward-compat) kind from a non-audit reader', () => {
    const asAgent = readLedger(entries, 'b1', { audience: 'agent' });
    expect(asAgent.some(e => e.kind === 'future_kind')).toBe(false);
    const asAudit = readLedger(entries, 'b1', { audience: 'audit' });
    expect(asAudit.some(e => e.kind === 'future_kind')).toBe(true);
  });

  it('an audit-clearance reader sees every entry for the bead', () => {
    const seen = readLedger(entries, 'b1', { audience: 'audit' });
    expect(seen).toHaveLength(3);
  });
});
