import { describe, it, expect, vi } from 'vitest';
import { newSessionState, type SessionState } from './state';
import { presentProposal } from './confirm';
import { runInterviewTurn, renderRecentWindow, type TurnDeps } from './turnloop';
import { DELTA_FENCE } from './distill';
import type { SpawnSpec } from '../agents/providers/types';
import type { CommitReport } from './commit';
import type { Decomposition } from './decomposition';
import type { KshetraConfig } from '../kshetra/config';

const NOW = '2026-07-27T10:00:00.000Z';
const sid = 'myapp-20260727T100000-abcd';

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/repos/myapp' },
  beads: { path: '/repos/myapp-beads' },
  agents: { model: 'claude-opus-4-8' },
} as unknown as KshetraConfig;

function systemPromptOf(spec: SpawnSpec): string {
  const i = spec.args.indexOf('--append-system-prompt');
  return spec.args[i + 1] ?? '';
}
function userPromptOf(spec: SpawnSpec): string {
  return spec.args[spec.args.length - 1] ?? '';
}

function withDelta(reply: string, json: string): string {
  return `${reply}\n\n\`\`\`${DELTA_FENCE}\n${json}\n\`\`\``;
}

// A capture fake that records every SpawnSpec it received and replies with a
// scripted sequence (one canned raw output per turn).
function scriptedCapture(replies: string[]) {
  const specs: SpawnSpec[] = [];
  let i = 0;
  const capture = (spec: SpawnSpec): Promise<string> => {
    specs.push(spec);
    return Promise.resolve(replies[i++] ?? '{}');
  };
  return { capture, specs };
}

const okCommit = (): Promise<CommitReport> =>
  Promise.resolve({ ok: true, epicId: 'x', childIds: { c1: 'x.1' }, depsAdded: [], errors: [] });

describe('runInterviewTurn — distillation & faithfulness', () => {
  it('folds a turn’s new facts into state and appends BOTH turns to the transcript', async () => {
    const { capture } = scriptedCapture([
      withDelta('Understood — CSV import for analysts.', '{"requirements":["CSV import for analysts"],"checkRubric":["intent"]}'),
    ]);
    const save = vi.fn();
    const deps: TurnDeps = { capture, commit: okCommit, save, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'we need CSV import', deps);

    expect(res.state.requirements).toEqual(['CSV import for analysts']);
    expect(res.state.rubric.intent).toBe(true);
    // user turn + assistant turn
    expect(res.state.transcript.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(res.state.transcript[0].content).toBe('we need CSV import');
    expect(res.reply).toBe('Understood — CSV import for analysts.');
    // saved after the turn
    expect(save).toHaveBeenCalledWith(res.state);
  });

  it('the delta block is stripped from the persisted assistant reply', async () => {
    const { capture } = scriptedCapture([withDelta('Visible reply only.', '{"checkRubric":["intent"]}')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'hi', deps);
    const assistant = res.state.transcript.find(t => t.role === 'assistant');
    expect(assistant?.content).toBe('Visible reply only.');
    expect(assistant?.content).not.toContain(DELTA_FENCE);
  });

  it('this turn’s new facts survive into the NEXT turn’s distilled system prompt', async () => {
    const { capture, specs } = scriptedCapture([
      withDelta('Captured.', '{"requirements":["accept CSV and TSV"],"checkRubric":["intent"]}'),
      withDelta('Next question.', '{}'),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'turn one', deps);
    await runInterviewTurn(t1.state, KSHETRA, 'turn two', deps);

    const secondSystemPrompt = systemPromptOf(specs[1]);
    expect(secondSystemPrompt).toContain('accept CSV and TSV'); // requirement carried forward
    expect(secondSystemPrompt).toMatch(/\[x] Intent/);          // rubric mark carried forward
  });

  it('does NOT splice the raw transcript into the system prompt (distilled state only)', async () => {
    const { capture, specs } = scriptedCapture([
      withDelta('Reply one.', '{"checkRubric":["intent"]}'),
      withDelta('Reply two.', '{}'),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'RAW_OPERATOR_CHATTER_XYZ', deps);
    await runInterviewTurn(t1.state, KSHETRA, 'turn two', deps);

    const secondSystemPrompt = systemPromptOf(specs[1]);
    expect(secondSystemPrompt).not.toContain('RAW_OPERATOR_CHATTER_XYZ');
    expect(secondSystemPrompt).not.toContain('Reply one.');
  });

  it('the optional last-N window rides on the USER prompt, not the system prompt', async () => {
    const { capture, specs } = scriptedCapture([
      withDelta('Reply one.', '{}'),
      withDelta('Reply two.', '{}'),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, recentWindow: 4 };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'FIRST_MESSAGE', deps);
    await runInterviewTurn(t1.state, KSHETRA, 'second message', deps);

    expect(userPromptOf(specs[1])).toContain('FIRST_MESSAGE');      // window on user prompt
    expect(systemPromptOf(specs[1])).not.toContain('FIRST_MESSAGE'); // never on system prompt
  });

  it('recentWindow:0 sends only the bare operator message as the user prompt', async () => {
    const { capture, specs } = scriptedCapture([withDelta('ok', '{}')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, recentWindow: 0 };
    await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'just this', deps);
    expect(userPromptOf(specs[0])).toBe('just this');
  });
});

function pendingState(): SessionState {
  const decomposition: Decomposition = {
    epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
    children: [{ ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' }],
    deps: [],
  };
  const held = presentProposal(newSessionState(sid, 'myapp', NOW), decomposition, NOW);
  if (!held.ok) throw new Error('setup');
  return held.state;
}

describe('runInterviewTurn — confirm gate routing', () => {
  it('a clean confirm frame commits the bundle and never spawns an interview turn', async () => {
    const capture = vi.fn();
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture, commit, save: () => {}, now: () => NOW };

    const res = await runInterviewTurn(pendingState(), KSHETRA, 'confirm', deps);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(res.committed?.ok).toBe(true);
    expect(res.state.pending).toBeNull();
    expect(res.reply).toMatch(/Filed the bundle/);
  });

  it('passes the pending decomposition to commit before the gate clears it', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };
    await runInterviewTurn(pendingState(), KSHETRA, 'looks good, ship it', deps);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ decomposition: expect.objectContaining({ epic: expect.objectContaining({ title: 'CSV import' }) }) }),
    );
  });

  it('an edit frame reopens the interview and files nothing', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(pendingState(), KSHETRA, 'actually, change the title', deps);
    expect(commit).not.toHaveBeenCalled();
    expect(res.state.pending).toBeNull();
    expect(res.reply).toMatch(/reopened|revise/i);
  });

  it('a cancel frame discards the proposal and files nothing', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(pendingState(), KSHETRA, 'cancel that', deps);
    expect(commit).not.toHaveBeenCalled();
    expect(res.state.pending).toBeNull();
    expect(res.reply).toMatch(/discarded/i);
  });

  it('a non-frame message while pending is treated as an ordinary interview turn', async () => {
    const { capture } = scriptedCapture([withDelta('Answering your question.', '{}')]);
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture, commit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(pendingState(), KSHETRA, 'what does child c1 cover?', deps);
    expect(commit).not.toHaveBeenCalled();
    expect(res.reply).toBe('Answering your question.');
    // proposal is still held (a question mid-gate doesn’t clear it)
    expect(res.state.pending).not.toBeNull();
  });
});

describe('renderRecentWindow', () => {
  it('is empty when disabled or the transcript is empty', () => {
    expect(renderRecentWindow(newSessionState(sid, 'myapp', NOW), 0)).toBe('');
    expect(renderRecentWindow(newSessionState(sid, 'myapp', NOW), 4)).toBe('');
  });

  it('labels operator vs assistant lines and keeps only the last N', () => {
    let s = newSessionState(sid, 'myapp', NOW);
    s = { ...s, transcript: [
      { role: 'user', content: 'a', at: NOW },
      { role: 'assistant', content: 'b', at: NOW },
      { role: 'user', content: 'c', at: NOW },
    ] };
    const w = renderRecentWindow(s, 2);
    expect(w).toContain('You: b');
    expect(w).toContain('Operator: c');
    expect(w).not.toContain('Operator: a');
  });
});
