import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { emit, emitLotManifest, getCurrentRunId, getCurrentLotId, logPath, SCHEMA_VERSION, type LoggedEvent } from './activity-log.js';

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

describe('lot manifest (epic yrk / Study B2)', () => {
  it('emits exactly one worker_started with an envelope lotId, no beadId, no pre-claim runId', () => {
    const k = 'yrk-manifest';
    const lotId = emitLotManifest(k, 'worker', { arm: 'A' });
    const log = readLog(k);
    expect(log).toHaveLength(1);
    const [wev] = log;
    expect(wev.type).toBe('worker_started');
    expect(wev.lotId).toBe(lotId);
    expect(wev.runId).toBeUndefined(); // no task claimed yet
    // worker_started is lot-level — it carries no beadId at all.
    expect((wev as Record<string, unknown>).beadId).toBeUndefined();
    expect(wev).toMatchObject({ entrypoint: 'worker', subject: {}, process: {}, labels: { arm: 'A' } });
    expect(getCurrentLotId(k)).toBe(lotId);
  });

  it('stamps the same lotId on every subsequent event in the process', () => {
    const k = 'yrk-stamp';
    const lotId = emitLotManifest(k, 'worker');
    emit({ type: 'beads_synced', kshetra: k });
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-1', title: 'T' });
    const log = readLog(k);
    expect(log).toHaveLength(3);
    expect(log.every(e => e.lotId === lotId)).toBe(true);
  });

  it('defaults labels to {} and supports entrypoint "run"', () => {
    const k = 'yrk-run';
    emitLotManifest(k, 'run');
    const [wev] = readLog(k);
    expect(wev).toMatchObject({ type: 'worker_started', entrypoint: 'run', labels: {} });
  });

  it('mints a distinct lotId per worker start', () => {
    const k = 'yrk-distinct';
    const first = emitLotManifest(k, 'worker');
    const second = emitLotManifest(k, 'worker');
    expect(second).not.toBe(first);
    expect(getCurrentLotId(k)).toBe(second);
  });

  it('stamps no lotId on events emitted before any worker_started', () => {
    const k = 'yrk-prelot';
    emit({ type: 'beads_synced', kshetra: k });
    expect(readLog(k)[0].lotId).toBeUndefined();
    expect(getCurrentLotId(k)).toBe('');
  });

  it('passes subject/process sections through to worker_started (yrk.2/yrk.3 collectors)', () => {
    const k = 'yrk-sections';
    const shreni = { version: '1.0.0', commit: 'deadbeef', dirty: false, builtAt: '2026-01-01T00:00:00.000Z' };
    emitLotManifest(k, 'worker', { arm: 'A' }, { subject: { baseSha: 'sha1' }, process: { shreni } });
    const [wev] = readLog(k);
    expect(wev).toMatchObject({
      type: 'worker_started', subject: { baseSha: 'sha1' }, process: { shreni }, labels: { arm: 'A' },
    });
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

describe('study A1 event kinds (408.1)', () => {
  it('emits and round-trips a turn_usage row with its raw per-call counters', () => {
    const k = 'a1-turn-usage';
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-1', title: 'T' });
    emit({
      type: 'turn_usage', kshetra: k, beadId: 'b-1', agent: 'silpi', provider: 'claude',
      model: 'claude-opus-4-8', turnIndex: 3, messageId: 'msg_abc',
      inputTokens: 1200, cacheReadTokens: 40000, cacheCreationTokens: 800, sidechain: false,
    });
    const row = readLog(k)[1];
    expect(row.type).toBe('turn_usage');
    if (row.type !== 'turn_usage') throw new Error('unreachable');
    // Envelope stamped, and the runId from task_claimed propagates onto the row.
    expect(row.schemaVersion).toBe(SCHEMA_VERSION);
    expect(row.runId).toBe(getCurrentRunId(k));
    // Raw counters stored as-is; effective_context is derived at read time, not stored.
    expect(row.inputTokens).toBe(1200);
    expect(row.cacheReadTokens).toBe(40000);
    expect(row.cacheCreationTokens).toBe(800);
    expect(row.messageId).toBe('msg_abc');
    expect(row.sidechain).toBe(false);
    expect('effective_context' in row).toBe(false);
  });

  it('emits and round-trips a context_compacted event', () => {
    const k = 'a1-compacted';
    emit({ type: 'task_claimed', kshetra: k, beadId: 'b-1', title: 'T' });
    emit({
      type: 'context_compacted', kshetra: k, beadId: 'b-1', agent: 'silpi', provider: 'claude',
      model: 'claude-opus-4-8', trigger: 'auto', preTokens: 155000, turnIndex: 20,
    });
    const ev = readLog(k)[1];
    expect(ev.type).toBe('context_compacted');
    if (ev.type !== 'context_compacted') throw new Error('unreachable');
    expect(ev.trigger).toBe('auto');
    expect(ev.preTokens).toBe(155000);
    expect(ev.turnIndex).toBe(20);
    expect(ev.runId).toBe(getCurrentRunId(k));
  });
});
