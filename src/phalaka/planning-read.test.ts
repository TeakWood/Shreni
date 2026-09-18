import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { foldPlanningSessions, readPlanningSessions, resetPlanningTailsForTest } from './planning-read.js';
import { logPath } from '../sthapathi/activity-log.js';

// Build an activity.jsonl line the way emit() does: the event body plus a ts
// envelope field. Only the fields the fold reads matter.
const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('foldPlanningSessions', () => {
  it('folds a full lifecycle into one session with its epic + docPath', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: '2026-09-17T10:00:00Z', resume: false }),
      line({ type: 'suthradhara_plan_filed', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'sso' }),
      line({ type: 'suthradhara_doc_pushed', kshetra: 'alpha', sessionId: 's1', docPath: 'd.md' }),
      line({ type: 'suthradhara_menu_choice', kshetra: 'alpha', sessionId: 's1', choice: 'end' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', ts: '2026-09-17T10:05:00Z' }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    expect(s).toMatchObject({
      kshetraId: 'alpha', sessionId: 's1', phase: 'ended', running: false,
      epicId: 'e-1', docPath: 'd.md', summary: 'sso', choice: 'end',
      launchedAt: '2026-09-17T10:00:00Z', endedAt: '2026-09-17T10:05:00Z',
      inputTokens: 0, outputTokens: 0, usageRecorded: false,
    });
  });

  it('marks a session still running until session_ended lands', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_plan_filed', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    expect(s).toMatchObject({ phase: 'plan_filed', running: true });
    expect(s.endedAt).toBeUndefined();
  });

  it('joins run_usage cost by epicId when a plan was filed', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_plan_filed', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', ts: 't1' }),
      // run_usage is keyed by epicId (fnd.6), not sessionId.
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 'e-1', agent: 'suthradhara', inputTokens: 100, outputTokens: 40, costUsd: 0.5, priced: true }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    expect(s).toMatchObject({
      inputTokens: 100, outputTokens: 40, costUsd: 0.5, priced: true, usageRecorded: true,
    });
  });

  it('joins run_usage by sessionId when the session filed no plan', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', ts: 't1' }),
      // No epic filed, so fnd.6 keys run_usage by the session id.
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 's1', agent: 'suthradhara', inputTokens: 7, outputTokens: 3, costUsd: 0, priced: false }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    expect(s).toMatchObject({ inputTokens: 7, outputTokens: 3, usageRecorded: true, priced: false });
  });

  it('ignores executor run_usage (agent != suthradhara) and unrelated events', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 's1', agent: 'silpi', inputTokens: 999, outputTokens: 999, costUsd: 9, priced: true }),
      line({ type: 'task_claimed', kshetra: 'alpha', beadId: 'x' }),
      line({ type: 'agent_text', kshetra: 'alpha', beadId: 'x', text: 'run_usage lookalike' }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    // The silpi run_usage must NOT be folded into the planning session.
    expect(s).toMatchObject({ inputTokens: 0, outputTokens: 0, usageRecorded: false });
  });

  it('separates multiple sessions in one Kshetra (extend creates a new sessionId)', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', ts: 't1' }),
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's2', ts: 't2' }),
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 's1', agent: 'suthradhara', inputTokens: 5, outputTokens: 1, costUsd: 0.1, priced: true }),
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 's2', agent: 'suthradhara', inputTokens: 8, outputTokens: 2, costUsd: 0.2, priced: true }),
    ];
    const out = foldPlanningSessions('alpha', lines);
    expect(out).toHaveLength(2);
    expect(out.find(s => s.sessionId === 's1')).toMatchObject({ running: false, inputTokens: 5 });
    expect(out.find(s => s.sessionId === 's2')).toMatchObject({ running: true, inputTokens: 8 });
  });

  it('clamps a malformed negative token/cost to zero (never sums negative)', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', ts: 't1' }),
      line({ type: 'run_usage', kshetra: 'alpha', beadId: 's1', agent: 'suthradhara', inputTokens: -50, outputTokens: 10, costUsd: -1, priced: true }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    // Negatives clamp to 0 so the strict PlanningSessionSchema (.nonnegative()) at
    // the API boundary can never be handed a negative sum.
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(10);
    expect(s.costUsd).toBe(0);
    expect(s.usageRecorded).toBe(true);
  });

  it('tolerates blank + malformed lines without throwing', () => {
    const lines = [
      '',
      '   ',
      '{ this is not json but mentions suthradhara',
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
    ];
    const out = foldPlanningSessions('alpha', lines);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('s1');
  });

  it('does not let a reordered event rewind the furthest phase', () => {
    const lines = [
      line({ type: 'suthradhara_launched', kshetra: 'alpha', sessionId: 's1', ts: 't0' }),
      line({ type: 'suthradhara_session_ended', kshetra: 'alpha', sessionId: 's1', ts: 't1' }),
      // A late-arriving earlier milestone must not pull phase back from 'ended'.
      line({ type: 'suthradhara_plan_filed', kshetra: 'alpha', sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }),
    ];
    const [s] = foldPlanningSessions('alpha', lines);
    expect(s.phase).toBe('ended');
    // ...but its payload (epicId) is still captured.
    expect(s.epicId).toBe('e-1');
  });
});

// The incremental byte-offset reader (fnd.8). test-setup redirects HOME to a
// throwaway dir, so logPath(id) writes there. Unique kshetra ids per test keep
// the module-level tail cache from bleeding, and resetPlanningTailsForTest()
// clears it defensively before each case.
describe('readPlanningSessions incremental read (fnd.8)', () => {
  beforeEach(() => resetPlanningTailsForTest());

  const writeLog = (id: string, contents: string): void => {
    const p = logPath(id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents, 'utf8');
  };
  const appendLog = (id: string, contents: string): void => appendFileSync(logPath(id), contents, 'utf8');

  it('folds new appends across successive calls WITHOUT re-reading the whole file', () => {
    const id = 'fnd8-incremental';
    writeLog(id, line({ type: 'suthradhara_launched', kshetra: id, sessionId: 's1', ts: 't0', resume: false }) + '\n');
    let out = readPlanningSessions([id]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: 's1', phase: 'launched', running: true });

    // Append later lifecycle events; the next call reads ONLY the appended bytes
    // but the fold reflects the full history (retained lines + new).
    appendLog(id, line({ type: 'suthradhara_plan_filed', kshetra: id, sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }) + '\n');
    appendLog(id, line({ type: 'suthradhara_session_ended', kshetra: id, sessionId: 's1', epicId: 'e-1', ts: 't1' }) + '\n');
    out = readPlanningSessions([id]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: 's1', phase: 'ended', running: false, epicId: 'e-1' });
  });

  it('ignores the executor per-token bulk — only planning-relevant lines are retained/folded', () => {
    const id = 'fnd8-bulk';
    const noise = Array.from({ length: 500 }, (_, i) =>
      line({ type: 'agent_text', kshetra: id, beadId: 'b1', agent: 'silpi', text: `token ${i}` })).join('\n') + '\n';
    writeLog(id, noise + line({ type: 'suthradhara_launched', kshetra: id, sessionId: 's1', ts: 't0' }) + '\n');
    const out = readPlanningSessions([id]);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('s1');
  });

  it('attaches a suthradhara run_usage (matched by epicId) even when it arrives in a later append', () => {
    const id = 'fnd8-usage';
    writeLog(id,
      line({ type: 'suthradhara_launched', kshetra: id, sessionId: 's1', ts: 't0' }) + '\n' +
      line({ type: 'suthradhara_plan_filed', kshetra: id, sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }) + '\n');
    readPlanningSessions([id]);
    // A run_usage for the filed epic lands in a later poll's bytes.
    appendLog(id, line({ type: 'run_usage', kshetra: id, beadId: 'e-1', agent: 'suthradhara', provider: 'anthropic', model: 'm', inputTokens: 120, outputTokens: 30, costUsd: 0.5, priced: true, outcome: 'ok' }) + '\n');
    const out = readPlanningSessions([id]);
    expect(out[0]).toMatchObject({ epicId: 'e-1', inputTokens: 120, outputTokens: 30, costUsd: 0.5, usageRecorded: true });
  });

  it('does not retain executor run_usage (only suthradhara-agent usage is kept — bounded growth)', () => {
    const id = 'fnd8-exec-usage';
    writeLog(id,
      line({ type: 'suthradhara_launched', kshetra: id, sessionId: 's1', ts: 't0' }) + '\n' +
      line({ type: 'suthradhara_plan_filed', kshetra: id, sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' }) + '\n' +
      // An executor run_usage keyed to the SAME id must NOT be folded into the session.
      line({ type: 'run_usage', kshetra: id, beadId: 'e-1', agent: 'silpi', provider: 'anthropic', model: 'm', inputTokens: 999, outputTokens: 111, costUsd: 9, priced: true, outcome: 'ok' }) + '\n');
    const out = readPlanningSessions([id]);
    expect(out[0]).toMatchObject({ epicId: 'e-1', inputTokens: 0, outputTokens: 0, usageRecorded: false });
  });

  it('does not fold a partial (still-being-written) trailing line until it is completed', () => {
    const id = 'fnd8-partial';
    writeLog(id, line({ type: 'suthradhara_launched', kshetra: id, sessionId: 's1', ts: 't0' }) + '\n');
    expect(readPlanningSessions([id])).toHaveLength(1);
    // A half-written next line (no trailing newline yet) must not be folded…
    const partial = line({ type: 'suthradhara_plan_filed', kshetra: id, sessionId: 's1', epicId: 'e-1', docPath: 'd.md', summary: 'x' });
    appendLog(id, partial.slice(0, 20));
    expect(readPlanningSessions([id])[0].phase).toBe('launched');
    // …until the rest of the line + newline arrives.
    appendLog(id, partial.slice(20) + '\n');
    expect(readPlanningSessions([id])[0].phase).toBe('plan_filed');
  });

  it('restarts from the top when the log is truncated/rotated (size < offset)', () => {
    const id = 'fnd8-rotate';
    // Start with a two-line log so the post-rotation file is strictly smaller —
    // byte-offset tailing detects a rotation only when size < offset (same
    // tradeoff as stream.ts; an exactly-equal-size rotation is undetectable).
    writeLog(id,
      line({ type: 'suthradhara_launched', kshetra: id, sessionId: 'old1', ts: 't0' }) + '\n' +
      line({ type: 'suthradhara_session_ended', kshetra: id, sessionId: 'old1', ts: 't1' }) + '\n');
    expect(readPlanningSessions([id])[0].sessionId).toBe('old1');
    // Rotate to a fresh, smaller file referencing a new session.
    writeLog(id, line({ type: 'suthradhara_launched', kshetra: id, sessionId: 'new', ts: 't2' }) + '\n');
    const out = readPlanningSessions([id]);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('new');
  });

  it('returns nothing for a Kshetra with no activity file yet', () => {
    expect(readPlanningSessions(['fnd8-absent'])).toEqual([]);
  });
});
