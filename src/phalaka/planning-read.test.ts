import { describe, it, expect } from 'vitest';
import { foldPlanningSessions } from './planning-read.js';

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
