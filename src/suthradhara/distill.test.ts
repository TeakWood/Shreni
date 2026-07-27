import { describe, it, expect } from 'vitest';
import { newSessionState } from './state';
import { parseTurnOutput, validateDelta, applyDelta, DELTA_FENCE } from './distill';
import { rubricStatus } from './rubric';
import { hasPendingProposal } from './confirm';
import type { Decomposition } from './decomposition';

const NOW = '2026-07-27T10:00:00.000Z';
const sid = 'myapp-20260727T100000-abcd';

function withDelta(reply: string, json: string): string {
  return `${reply}\n\n\`\`\`${DELTA_FENCE}\n${json}\n\`\`\``;
}

describe('parseTurnOutput', () => {
  it('splits the reply from a trailing delta block and strips it', () => {
    const raw = withDelta('Got it — that clarifies the intent.', '{"checkRubric":["intent"]}');
    const { reply, delta } = parseTurnOutput(raw);
    expect(reply).toBe('Got it — that clarifies the intent.');
    expect(reply).not.toContain(DELTA_FENCE);
    expect(delta).toEqual({ checkRubric: ['intent'] });
  });

  it('returns a null delta and the full text when no block is present', () => {
    const { reply, delta } = parseTurnOutput('Just a question back to you.');
    expect(reply).toBe('Just a question back to you.');
    expect(delta).toBeNull();
  });

  it('is fail-safe on malformed JSON — null delta, block still stripped', () => {
    const raw = withDelta('Reply text.', '{ this is not json ]');
    const { reply, delta } = parseTurnOutput(raw);
    expect(delta).toBeNull();
    expect(reply).toBe('Reply text.');
    expect(reply).not.toContain(DELTA_FENCE);
  });

  it('keeps the LAST block when the model emits a draft then a final', () => {
    const raw =
      'thinking...\n' +
      `\`\`\`${DELTA_FENCE}\n{"requirements":["draft"]}\n\`\`\`\n` +
      'final answer\n' +
      `\`\`\`${DELTA_FENCE}\n{"requirements":["final"]}\n\`\`\``;
    const { reply, delta } = parseTurnOutput(raw);
    expect(delta).toEqual({ requirements: ['final'] });
    expect(reply).not.toContain(DELTA_FENCE);
    expect(reply).not.toContain('draft');
  });
});

describe('validateDelta', () => {
  it('drops unknown rubric keys with a warning but keeps valid ones', () => {
    const { delta, warnings } = validateDelta({ checkRubric: ['intent', 'bogus'] });
    expect(delta.checkRubric).toEqual(['intent']);
    expect(warnings.join(' ')).toMatch(/bogus/);
  });

  it('rejects an unknown stage', () => {
    const { delta, warnings } = validateDelta({ advanceStage: 'nope' });
    expect(delta.advanceStage).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/nope/);
  });

  it('keeps well-formed deferrals and drops malformed ones', () => {
    const { delta } = validateDelta({
      deferRubric: [
        { key: 'nonFunctional', question: 'perf budget?' },
        { key: 'nonFunctional' }, // missing question
        { key: 'unknown', question: 'x' },
      ],
    });
    expect(delta.deferRubric).toEqual([{ key: 'nonFunctional', question: 'perf budget?' }]);
  });

  it('ignores a non-object payload entirely', () => {
    const { delta, warnings } = validateDelta(42);
    expect(delta).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('keeps a non-empty locateFeature (trimmed) and drops a blank one', () => {
    expect(validateDelta({ locateFeature: '  SSO login ' }).delta.locateFeature).toBe('SSO login');
    const { delta, warnings } = validateDelta({ locateFeature: '   ' });
    expect(delta.locateFeature).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/locateFeature/);
  });
});

describe('applyDelta — folds through the pure mutators', () => {
  it('adds requirements, checks/defers rubric, appends open questions', () => {
    const { state, warnings } = applyDelta(
      newSessionState(sid, 'myapp', NOW),
      {
        requirements: ['accept CSV and TSV', 'accept CSV and TSV'], // dedup
        checkRubric: ['intent', 'successCriteria'],
        deferRubric: [{ key: 'nonFunctional', question: 'perf budget?' }],
        openQuestions: ['which auth provider?'],
      },
      NOW,
    );
    expect(state.requirements).toEqual(['accept CSV and TSV']);
    expect(state.rubric.intent).toBe(true);
    expect(state.rubric.successCriteria).toBe(true);
    expect(state.rubric.nonFunctional).toBe(true); // deferred satisfies the gate
    expect(state.openQuestions.map(q => q.question)).toContain('perf budget?');
    expect(state.openQuestions.map(q => q.question)).toContain('which auth provider?');
    expect(warnings).toEqual([]);
  });

  it('refuses a gated stage jump when the rubric is unmet and warns', () => {
    const { state, warnings } = applyDelta(
      newSessionState(sid, 'myapp', NOW),
      { advanceStage: 'decompose' },
      NOW,
    );
    expect(state.stage).toBe('discovery');
    expect(warnings.join(' ')).toMatch(/readiness rubric/i);
  });

  it('allows a stage advance once the rubric is satisfied in the SAME delta', () => {
    const { state, warnings } = applyDelta(
      newSessionState(sid, 'myapp', NOW),
      {
        checkRubric: ['intent', 'usersStories', 'successCriteria', 'scopeBoundary', 'nonFunctional', 'dependenciesUnknowns'],
        advanceStage: 'decompose',
      },
      NOW,
    );
    expect(rubricStatus(state).ready).toBe(true);
    expect(state.stage).toBe('decompose');
    expect(warnings).toEqual([]);
  });

  it('holds a valid proposal as pending via the confirm gate', () => {
    const decomposition: Decomposition = {
      epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
      children: [{ ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' }],
      deps: [],
    };
    const { state, warnings } = applyDelta(newSessionState(sid, 'myapp', NOW), { proposal: decomposition }, NOW);
    expect(hasPendingProposal(state)).toBe(true);
    expect(state.pending?.decomposition.epic.title).toBe('CSV import');
    expect(warnings).toEqual([]);
  });

  it('refuses an invalid proposal with a warning and holds nothing', () => {
    const bad: Decomposition = {
      epic: { ref: 'e', title: '', type: 'epic', priority: 2 },
      children: [],
      deps: [],
    };
    const { state, warnings } = applyDelta(newSessionState(sid, 'myapp', NOW), { proposal: bad }, NOW);
    expect(hasPendingProposal(state)).toBe(false);
    expect(warnings.join(' ')).toMatch(/invalid/i);
  });
});
