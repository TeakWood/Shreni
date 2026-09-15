import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { emit, getCurrentRunId, logPath, SCHEMA_VERSION, type LoggedEvent } from './activity-log.js';

// test-setup.ts redirects HOME to a throwaway dir, so emit()'s default
// localFileSink writes activity.jsonl there. Each test uses a unique kshetra id
// so the module-level runId map never bleeds between cases.
function readLog(kshetra: string): LoggedEvent[] {
  return readFileSync(logPath(kshetra), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as LoggedEvent);
}

describe('emit envelope', () => {
  it('routes through the registry to activity.jsonl and stamps ts + schemaVersion', () => {
    const k = 'epg2-envelope';
    emit({ type: 'beads_synced', kshetra: k });
    const [ev] = readLog(k);
    expect(ev.type).toBe('beads_synced');
    expect(ev.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof ev.ts).toBe('string');
  });

  it('mints a runId at task_claimed and propagates it to downstream events', () => {
    const k = 'epg2-runid';
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-1', title: 'T' });
    emit({ type: 'round_start', kshetra: k, beadId: 'b-1', round: 1, agent: 'silpi' });
    emit({ type: 'task_done', kshetra: k, beadId: 'b-1', title: 'T', approved: true, rounds: 1 });
    const log = readLog(k);
    const runId = log[0].runId;
    expect(runId).toBeTruthy();
    // stable across the whole attempt
    expect(log.every(e => e.runId === runId)).toBe(true);
    expect(getCurrentRunId(k)).toBe(runId);
  });

  it('mints a fresh runId for the next task attempt', () => {
    const k = 'epg2-newattempt';
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-1', title: 'A' });
    const first = getCurrentRunId(k);
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-2', title: 'B' });
    const second = getCurrentRunId(k);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('omits runId for events emitted before any task is claimed', () => {
    const k = 'epg2-noclaim';
    emit({ type: 'beads_synced', kshetra: k });
    expect(readLog(k)[0].runId).toBeUndefined();
    expect(getCurrentRunId(k)).toBe('');
  });
});

describe('Suthradhara lifecycle events (fnd.1)', () => {
  it('emits and round-trips every Suthradhara lifecycle variant with its fields', () => {
    const k = 'fnd-suthra';
    emit({ type: 'suthradhara_launched', kshetra: k, sessionId: 's-1', claudeSessionId: 'c-1', resume: false });
    emit({ type: 'suthradhara_plan_filed', kshetra: k, sessionId: 's-1', epicId: 'e-1', docPath: '.shreni/design/x.md', summary: 'planned x' });
    emit({ type: 'suthradhara_doc_pushed', kshetra: k, sessionId: 's-1', branch: 'suthradhara/x', docPath: '.shreni/design/x.md' });
    emit({ type: 'suthradhara_menu_choice', kshetra: k, sessionId: 's-1', choice: 'extend' });
    emit({ type: 'suthradhara_session_ended', kshetra: k, sessionId: 's-1', epicId: 'e-1' });

    const log = readLog(k);
    expect(log.map(e => e.type)).toEqual([
      'suthradhara_launched', 'suthradhara_plan_filed', 'suthradhara_doc_pushed',
      'suthradhara_menu_choice', 'suthradhara_session_ended',
    ]);
    // Envelope stamped like any other event; fields survive the round-trip.
    expect(log.every(e => e.schemaVersion === SCHEMA_VERSION && typeof e.ts === 'string')).toBe(true);
    const filed = log[1];
    expect(filed.type === 'suthradhara_plan_filed' && filed.epicId).toBe('e-1');
    const menu = log[3];
    expect(menu.type === 'suthradhara_menu_choice' && menu.choice).toBe('extend');
  });

  it('session_ended may omit the optional epicId (session that filed nothing)', () => {
    const k = 'fnd-suthra-noepic';
    emit({ type: 'suthradhara_session_ended', kshetra: k, sessionId: 's-9' });
    const [ev] = readLog(k);
    expect(ev.type).toBe('suthradhara_session_ended');
    expect((ev as { epicId?: string }).epicId).toBeUndefined();
  });
});