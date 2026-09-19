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

  it('classifies the study kinds (408.1): turn_usage run-log, context_compacted decision-grade', () => {
    expect(isDecisionGrade(ev({ type: 'turn_usage', beadId: 'b1' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'context_compacted', beadId: 'b1' } as LoggedEvent))).toBe(true);
  });

  it('rejects pure telemetry and planning-session lifecycle', () => {
    expect(isDecisionGrade(ev({ type: 'round_start', beadId: 'b1' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'beads_synced' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'error', message: 'x' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'suthradhara_launched' } as LoggedEvent))).toBe(false);
    expect(isDecisionGrade(ev({ type: 'suthradhara_session_ended' } as LoggedEvent))).toBe(false);
  });

  it('accepts the lot manifest worker_started (epic yrk / Study B2)', () => {
    expect(isDecisionGrade(ev({ type: 'worker_started', entrypoint: 'worker', subject: {}, process: {}, labels: {} } as unknown as LoggedEvent))).toBe(true);
  });

  it('rejects phase_changed run-log (epic hto / Study A3)', () => {
    expect(isDecisionGrade(ev({ type: 'phase_changed', from: 'IDLE', to: 'SELECTING', heldMs: 10 } as unknown as LoggedEvent))).toBe(false);
  });

  it('accepts review_ablated (epic 8wi / Study B1)', () => {
    expect(isDecisionGrade(ev({ type: 'review_ablated', beadId: 'b1', round: 1, ablations: ['review'] } as unknown as LoggedEvent))).toBe(true);
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

  it('classifies the study kinds (408.1) as audit — never agent-visible', () => {
    // turn_usage is run-log (follows agent_tool_call); context_compacted describes
    // the agent's own memory loss and must not be folded into an agent prompt.
    expect(audienceFor('turn_usage')).toBe<LedgerAudience>('audit');
    expect(audienceFor('context_compacted')).toBe<LedgerAudience>('audit');
  });

  it('classifies the lot manifest worker_started as audit (epic yrk / Study B2)', () => {
    // Provenance about the machinery, never the task — must not reach an agent.
    expect(audienceFor('worker_started')).toBe<LedgerAudience>('audit');
  });

  it('classifies phase_changed as operator (epic hto / Study A3)', () => {
    expect(audienceFor('phase_changed')).toBe<LedgerAudience>('operator');
  });

  it('classifies review_ablated as audit (epic 8wi / Study B1)', () => {
    expect(audienceFor('review_ablated')).toBe<LedgerAudience>('audit');
  });
});

describe('lot manifest worker_started ledger mapping (epic yrk / Study B2)', () => {
  const manifest = (over: Partial<LoggedEvent> = {}): LoggedEvent =>
    ev({
      type: 'worker_started', lotId: 'lot-1', entrypoint: 'worker',
      subject: {}, process: {}, labels: { arm: 'A' }, ...over,
    } as unknown as LoggedEvent);

  it('lifts lotId to the envelope and defaults the missing beadId to ""', () => {
    const entry = toLedgerEntry(manifest());
    expect(entry.beadId).toBe('');
    expect(entry.lotId).toBe('lot-1');
    expect(entry.kind).toBe('worker_started');
    expect(entry.payload).toEqual({ entrypoint: 'worker', subject: {}, process: {}, labels: { arm: 'A' } });
    // Neither the lifted lotId nor a beadId leaks back into the payload.
    expect('lotId' in entry.payload).toBe(false);
    expect('beadId' in entry.payload).toBe(false);
  });

  it('is never returned to an agent- or operator-clearance reader, but is to audit', () => {
    const entries = [toLedgerEntry(manifest())];
    // worker_started has beadId '' — query it directly to prove the audience gate,
    // not the bead filter, is what withholds it.
    expect(readLedger(entries, '', { audience: 'agent' })).toEqual([]);
    expect(readLedger(entries, '', { audience: 'operator' })).toEqual([]);
    expect(readLedger(entries, '', { audience: 'audit' })).toHaveLength(1);
  });
});

describe('toLedgerEntry lifts lotId alongside runId (epic yrk / Study B2)', () => {
  it('lifts both correlation ids out of a normal event envelope', () => {
    const entry = toLedgerEntry(
      ev({ type: 'merge_done', beadId: 'b1', mergePolicy: 'push', sha: 'abc', runId: 'r1', lotId: 'lot-1' } as unknown as LoggedEvent),
    );
    expect(entry).toMatchObject({ beadId: 'b1', runId: 'r1', lotId: 'lot-1', kind: 'merge_done' });
    expect(entry.payload).toEqual({ mergePolicy: 'push', sha: 'abc' });
  });

  it('parses a pre-B2 ledger line that carries no lotId', () => {
    const raw = JSON.stringify({ ts: 'x', schemaVersion: 1, kshetra: 'k', beadId: 'b1', kind: 'merge_done', payload: {} }) + '\n';
    const [entry] = parseLedgerLines(raw);
    expect(entry.beadId).toBe('b1');
    expect(entry.lotId).toBeUndefined();
  });
});

describe('readLedger never surfaces context_compacted to an agent (408.1)', () => {
  it('withholds context_compacted from an agent-clearance reader', () => {
    const entries: LedgerEntry[] = [
      toLedgerEntry(ev({ type: 'task_claimed', beadId: 'b1', title: 't' } as LoggedEvent)),
      toLedgerEntry(
        ev({
          type: 'context_compacted', beadId: 'b1', agent: 'silpi', provider: 'claude',
          model: 'claude-opus-4-8', trigger: 'auto', preTokens: 150000, turnIndex: 12, runId: 'r1',
        } as LoggedEvent),
      ),
    ];
    const asAgent = readLedger(entries, 'b1', { audience: 'agent' });
    expect(asAgent.some(e => e.kind === 'context_compacted')).toBe(false);
    // But an audit reviewer sees it — it is decision-grade provenance.
    const asAudit = readLedger(entries, 'b1', { audience: 'audit' });
    expect(asAudit.some(e => e.kind === 'context_compacted')).toBe(true);
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
