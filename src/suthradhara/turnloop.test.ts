import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { newSessionState, type SessionState } from './state';
import { presentProposal } from './confirm';
import { runInterviewTurn, resumeInterruptedCommit, renderRecentWindow, type TurnDeps } from './turnloop';
import type { CaptureResult } from './capture';
import { applyDelta, DELTA_FENCE } from './distill';
import { makeCommitFn, type CommitDeps } from './commit';
import { newSessionBeadRecord, type SessionPlan, type SessionBeadRecord } from './sessionbead';
import { resolveDesignDir } from './designdoc';
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
  // The operator message rides stdin (buildClaudeSpawn), not a trailing arg —
  // --allowedTools is variadic and would swallow a positional prompt.
  return spec.stdin ?? '';
}

function withDelta(reply: string, json: string): string {
  return `${reply}\n\n\`\`\`${DELTA_FENCE}\n${json}\n\`\`\``;
}

// A capture fake that records every SpawnSpec it received and replies with a
// scripted sequence (one canned raw output per turn). Wraps each canned text in
// the CaptureResult shape the turn loop now consumes; no denials by default.
function scriptedCapture(replies: string[]) {
  const specs: SpawnSpec[] = [];
  let i = 0;
  const capture = (spec: SpawnSpec): Promise<CaptureResult> => {
    specs.push(spec);
    return Promise.resolve({ text: replies[i++] ?? '{}', deniedTools: [] });
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

// A pending state whose held proposal also carries a design-doc body (§8).
function pendingStateWithDoc(docContent = '# CSV import\n\nThe design.'): SessionState {
  const decomposition: Decomposition = {
    epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
    children: [{ ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' }],
    deps: [],
  };
  const held = presentProposal(newSessionState(sid, 'myapp', NOW), decomposition, NOW, docContent);
  if (!held.ok) throw new Error('setup');
  return held.state;
}

const partialCommit = (sessionBeadId = 'myapp-sess'): Promise<CommitReport> =>
  Promise.resolve({ ok: false, sessionBeadId, epicId: 'x', childIds: {}, depsAdded: [], errors: ['bd down'] });

describe('runInterviewTurn — commit doc emission & resume (§7, §8)', () => {
  it('threads the pending doc body into the commit as input.doc', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };
    await runInterviewTurn(pendingStateWithDoc('# CSV\n\nBODY'), KSHETRA, 'confirm', deps);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ doc: { content: '# CSV\n\nBODY' } }),
    );
  });

  it('a proposal with no doc body commits with input.doc undefined', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };
    await runInterviewTurn(pendingState(), KSHETRA, 'confirm', deps);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ doc: undefined }));
  });

  it('a partial-failure commit KEEPS pending and records the in-flight commit marker', async () => {
    const commit = vi.fn(() => partialCommit('myapp-sess'));
    const deps: TurnDeps = { capture: vi.fn(), commit, save: vi.fn(), now: () => NOW };
    const res = await runInterviewTurn(pendingStateWithDoc(), KSHETRA, 'confirm', deps);

    expect(res.committed?.ok).toBe(false);
    expect(res.state.pending).not.toBeNull();                  // still confirmable
    expect(res.state.commit).toEqual({ sessionBeadId: 'myapp-sess' });
    expect(res.reply).toMatch(/did not fully complete/i);
  });

  it('a re-confirm after a partial failure resumes against the SAME session bead', async () => {
    const commit = vi
      .fn<(input: import('./commit').CommitInput) => Promise<CommitReport>>()
      .mockImplementationOnce(() => partialCommit('myapp-sess'))
      .mockImplementationOnce(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: vi.fn(), now: () => NOW };

    const first = await runInterviewTurn(pendingStateWithDoc(), KSHETRA, 'confirm', deps);
    const second = await runInterviewTurn(first.state, KSHETRA, 'confirm', deps);

    // Second commit carried the resume handle for the same bead.
    expect(commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: { sessionBeadId: 'myapp-sess' } }),
    );
    // On success the marker and pending are cleared.
    expect(second.committed?.ok).toBe(true);
    expect(second.state.commit).toBeNull();
    expect(second.state.pending).toBeNull();
  });

  it('a full-success commit clears pending and never sets a commit marker', async () => {
    const deps: TurnDeps = { capture: vi.fn(), commit: vi.fn(okCommit), save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(pendingStateWithDoc(), KSHETRA, 'confirm', deps);
    expect(res.state.pending).toBeNull();
    expect(res.state.commit).toBeNull();
  });

  // The whole wire, end to end: a model turn emits {proposal, doc} → distilled
  // into a pending proposal → a confirm routes through the REAL commit executor →
  // the design doc lands on disk under the guarded design dir (server-authors).
  it('a model-emitted doc reaches disk through the real commit executor on confirm', async () => {
    const REPO = mkdtempSync(join(tmpdir(), 'suthradhara-turnloop-e2e-'));
    const kshetra = { ...KSHETRA, repo: { path: REPO }, beads: { path: `${REPO}-beads` } } as KshetraConfig;
    try {
      // Fake bd + session bead so only the doc write touches the real filesystem.
      const stored = new Map<string, SessionBeadRecord>();
      const sessionBead: NonNullable<CommitDeps['sessionBead']> = {
        create(plan: SessionPlan) {
          const record = newSessionBeadRecord(plan);
          stored.set('s', record);
          return Promise.resolve({ id: 's', record });
        },
        journal(id, r) { stored.set(id, r); return Promise.resolve(); },
        load(id) { return Promise.resolve(stored.get(id) ?? null); },
      };
      let n = 0;
      const bd = (args: string[]) => Promise.resolve(args[0] === 'create' ? `myapp-${++n}` : '');

      const deps: TurnDeps = {
        capture: vi.fn(),
        commit: makeCommitFn({ bd, sessionBead }),
        save: () => {},
        now: () => NOW,
      };

      // Distill a model turn that presents a proposal WITH a doc body.
      const decomposition: Decomposition = {
        epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
        children: [{ ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' }],
        deps: [],
      };
      const { state } = applyDelta(
        newSessionState(sid, 'myapp', NOW),
        { proposal: decomposition, doc: '# CSV import\n\nThe vetted design.' },
        NOW,
      );

      const res = await runInterviewTurn(state, kshetra, 'confirm', { ...deps });

      expect(res.committed?.ok).toBe(true);
      expect(res.committed?.docRelPath).toBe('.shreni/design/csv-import.md');
      const abs = join(resolveDesignDir(kshetra), 'csv-import.md');
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toContain('The vetted design.');
    } finally {
      rmSync(REPO, { recursive: true, force: true });
    }
  });
});

describe('resumeInterruptedCommit (§7, Q2)', () => {
  const withInflight = (): SessionState => ({
    ...pendingStateWithDoc(),
    commit: { sessionBeadId: 'myapp-sess' },
  });

  it('is a no-op (null) when there is no in-flight commit', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: vi.fn(), now: () => NOW };
    // pending but no commit marker → nothing to resume.
    expect(await resumeInterruptedCommit(pendingStateWithDoc(), KSHETRA, deps)).toBeNull();
    // commit marker but no pending → nothing to resume either.
    const noPending: SessionState = { ...newSessionState(sid, 'myapp', NOW), commit: { sessionBeadId: 'x' } };
    expect(await resumeInterruptedCommit(noPending, KSHETRA, deps)).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('reconciles against the marked bead and clears state on success', async () => {
    const commit = vi.fn(okCommit);
    const save = vi.fn();
    const deps: TurnDeps = { capture: vi.fn(), commit, save, now: () => NOW };

    const res = await resumeInterruptedCommit(withInflight(), KSHETRA, deps);

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: { sessionBeadId: 'myapp-sess' },
        doc: { content: '# CSV import\n\nThe design.' },
      }),
    );
    expect(res?.committed?.ok).toBe(true);
    expect(res?.state.commit).toBeNull();
    expect(res?.state.pending).toBeNull();
    expect(save).toHaveBeenCalledWith(res?.state);
  });

  it('keeps the marker when the resume also fails partway', async () => {
    const commit = vi.fn(() => partialCommit('myapp-sess'));
    const deps: TurnDeps = { capture: vi.fn(), commit, save: vi.fn(), now: () => NOW };
    const res = await resumeInterruptedCommit(withInflight(), KSHETRA, deps);
    expect(res?.state.commit).toEqual({ sessionBeadId: 'myapp-sess' });
    expect(res?.state.pending).not.toBeNull();
  });
});

function locatedDoc(relPath: string, content = 'body', score = 9): import('./evolve').LocatedDoc {
  return { relPath, content, matchedVia: ['name'], linkedBeadIds: [], score };
}

describe('runInterviewTurn — evolve locate (§8.1)', () => {
  it('a single located doc folds an evolve target into state and notes it in the reply', async () => {
    const { capture } = scriptedCapture([
      withDelta('This changes SSO login.', '{"locateFeature":"SSO login"}'),
    ]);
    const locate = vi.fn(async () => [locatedDoc('.shreni/design/sso-login.md', '# SSO\nSAML')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locate };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'add MFA to SSO', deps);

    expect(locate).toHaveBeenCalledWith('SSO login');
    expect(res.state.evolving?.targetRelPath).toBe('.shreni/design/sso-login.md');
    expect(res.state.evolving?.targetContent).toBe('# SSO\nSAML');
    expect(res.reply).toMatch(/evolve it in place/i);
  });

  it('the loaded existing doc rides into the NEXT turn’s system prompt for reconcile', async () => {
    const { capture, specs } = scriptedCapture([
      withDelta('Detected a change.', '{"locateFeature":"SSO login"}'),
      withDelta('Next.', '{}'),
    ]);
    const locate = vi.fn(async () => [locatedDoc('.shreni/design/sso-login.md', 'EXISTING_APPROACH_SAML')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locate };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'change SSO', deps);
    await runInterviewTurn(t1.state, KSHETRA, 'here is the change', deps);

    const sp = systemPromptOf(specs[1]);
    expect(sp).toContain('UPDATE IN PLACE');
    expect(sp).toContain('.shreni/design/sso-login.md');
    expect(sp).toContain('EXISTING_APPROACH_SAML');
  });

  it('multiple matches park candidates and ask the operator which to evolve', async () => {
    const { capture } = scriptedCapture([
      withDelta('Ambiguous feature.', '{"locateFeature":"auth"}'),
    ]);
    const locate = vi.fn(async () => [
      locatedDoc('.shreni/design/sso-login.md', 'a', 10),
      locatedDoc('.shreni/design/auth-tokens.md', 'b', 9),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locate };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'change auth', deps);

    expect(res.state.evolving?.candidates).toEqual([
      '.shreni/design/sso-login.md',
      '.shreni/design/auth-tokens.md',
    ]);
    expect(res.state.evolving?.targetRelPath).toBeUndefined();
    expect(res.reply).toMatch(/which one should I evolve/i);
  });

  it('the operator’s choice resolves a candidate WITHOUT spawning an interview turn', async () => {
    const capture = vi.fn();
    const locate = vi.fn(async () => [
      locatedDoc('.shreni/design/sso-login.md', 'SSO_BODY', 10),
      locatedDoc('.shreni/design/auth-tokens.md', 'TOK_BODY', 9),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locate };

    // Seed a session already awaiting a doc choice.
    let s = newSessionState(sid, 'myapp', NOW);
    s = { ...s, evolving: { feature: 'auth', candidates: ['.shreni/design/sso-login.md', '.shreni/design/auth-tokens.md'], locatedAt: NOW } };

    const res = await runInterviewTurn(s, KSHETRA, '1', deps);

    expect(capture).not.toHaveBeenCalled();
    expect(res.state.evolving?.targetRelPath).toBe('.shreni/design/sso-login.md');
    expect(res.state.evolving?.targetContent).toBe('SSO_BODY'); // re-located for the body
    expect(res.reply).toMatch(/Evolving the existing design doc in place/i);
  });

  it('choosing "none of these" drops the evolve context (a new-doc interview)', async () => {
    const deps: TurnDeps = { capture: vi.fn(), commit: okCommit, save: () => {}, now: () => NOW, locate: vi.fn() };
    let s = newSessionState(sid, 'myapp', NOW);
    s = { ...s, evolving: { feature: 'auth', candidates: ['.shreni/design/a.md', '.shreni/design/b.md'], locatedAt: NOW } };

    const res = await runInterviewTurn(s, KSHETRA, '3', deps); // the "none" tail
    expect(res.state.evolving).toBeNull();
    expect(res.reply).toMatch(/create a NEW design doc/i);
  });

  it('an unrecognizable reply while awaiting a choice falls through to an interview turn', async () => {
    const { capture } = scriptedCapture([withDelta('Let me clarify.', '{}')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locate: vi.fn() };
    let s = newSessionState(sid, 'myapp', NOW);
    s = { ...s, evolving: { feature: 'auth', candidates: ['.shreni/design/a.md', '.shreni/design/b.md'], locatedAt: NOW } };

    const res = await runInterviewTurn(s, KSHETRA, 'wait what are my options again', deps);
    expect(res.reply).toBe('Let me clarify.');
    // candidates remain parked for another attempt
    expect(res.state.evolving?.candidates).toHaveLength(2);
  });

  it('no locate dep → an evolve signal is a harmless no-op', async () => {
    const { capture } = scriptedCapture([withDelta('ok', '{"locateFeature":"SSO"}')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'x', deps);
    expect(res.state.evolving).toBeUndefined();
    expect(res.reply).toBe('ok');
  });
});

function sourceDoc(relPath: string, content = 'body', score = 6): import('./evolve').LocatedDoc {
  return { relPath, content, matchedVia: ['bead'], linkedBeadIds: ['X.1'], score };
}

describe('runInterviewTurn — source grounding + re-consult routing (pmb.7)', () => {
  it('distils the source ref into state (fetched once) and carries it into the next prompt', async () => {
    const { capture, specs } = scriptedCapture([
      withDelta('Pulled PROJ-123.', '{"source":"jira:PROJ-123","requirements":["ship the widget"]}'),
      withDelta('Next.', '{}'),
    ]);
    const locateBySource = vi.fn(async () => []); // first consult: nothing filed yet
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locateBySource };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, "let's work on PROJ-123", deps);
    expect(t1.state.source).toEqual({ ref: 'jira:PROJ-123', pulledAt: NOW });
    expect(locateBySource).toHaveBeenCalledWith('jira:PROJ-123');

    // Turn 2: the source rides the system prompt as already-pulled context.
    await runInterviewTurn(t1.state, KSHETRA, 'more detail', deps);
    const sp = systemPromptOf(specs[1]);
    expect(sp).toContain('GROUNDED IN AN EXTERNAL SOURCE OF RECORD');
    expect(sp).toContain('jira:PROJ-123');
    expect(sp).toMatch(/do NOT re-fetch/i);
  });

  it('re-searches only on the FIRST pull — a re-emitted ref does not consult again', async () => {
    const { capture } = scriptedCapture([
      withDelta('Pulled.', '{"source":"jira:PROJ-123"}'),
      withDelta('Re-mentions it.', '{"source":"jira:PROJ-123"}'),
    ]);
    const locateBySource = vi.fn(async () => []);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locateBySource };

    const t1 = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'a', deps);
    await runInterviewTurn(t1.state, KSHETRA, 'b', deps);
    expect(locateBySource).toHaveBeenCalledTimes(1);
  });

  it('a prior consult of the same ticket routes to evolve-in-place (no duplicate epic)', async () => {
    const { capture } = scriptedCapture([
      withDelta('Pulled PROJ-123 again.', '{"source":"jira:PROJ-123"}'),
    ]);
    const locateBySource = vi.fn(async () => [sourceDoc('.shreni/design/widget.md', '# Widget\nv1')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locateBySource };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'work on PROJ-123', deps);
    expect(res.state.evolving?.targetRelPath).toBe('.shreni/design/widget.md');
    expect(res.state.evolving?.targetContent).toBe('# Widget\nv1');
    expect(res.reply).toMatch(/consulted before/i);
    expect(res.reply).toMatch(/evolve it in place/i);
  });

  it('several prior-consult docs park candidates and ask which to evolve', async () => {
    const { capture } = scriptedCapture([withDelta('Pulled.', '{"source":"jira:PROJ-123"}')]);
    const locateBySource = vi.fn(async () => [
      sourceDoc('.shreni/design/a.md', 'a', 6),
      sourceDoc('.shreni/design/b.md', 'b', 6),
    ]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW, locateBySource };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'x', deps);
    expect(res.state.evolving?.candidates).toEqual(['.shreni/design/a.md', '.shreni/design/b.md']);
    expect(res.reply).toMatch(/which one should I evolve/i);
  });

  it('no locateBySource dep → the source is still distilled, no routing', async () => {
    const { capture } = scriptedCapture([withDelta('ok', '{"source":"jira:PROJ-123"}')]);
    const deps: TurnDeps = { capture, commit: okCommit, save: () => {}, now: () => NOW };
    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'x', deps);
    expect(res.state.source).toEqual({ ref: 'jira:PROJ-123', pulledAt: NOW });
    expect(res.state.evolving).toBeUndefined();
  });

  it('a confirmed commit stamps the source ref onto the filed bundle', async () => {
    const commit = vi.fn(okCommit);
    const deps: TurnDeps = { capture: vi.fn(), commit, save: () => {}, now: () => NOW };

    // Seed a session grounded in a ticket with a pending proposal awaiting confirm.
    let s = newSessionState(sid, 'myapp', NOW);
    s = { ...s, source: { ref: 'jira:PROJ-123', pulledAt: NOW } };
    const decomposition: Decomposition = {
      epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
      children: [{ ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' }],
      deps: [],
    };
    const present = presentProposal(s, decomposition, NOW);
    if (!present.ok) throw new Error('seed proposal invalid');
    s = present.state;

    await runInterviewTurn(s, KSHETRA, 'confirm', deps);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].source).toBe('jira:PROJ-123');
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

// ── interactive grant-on-demand (pmb.6) ──────────────────────────────────────

// The list passed to `claude --allowedTools` for a spawn.
function allowlistOf(spec: SpawnSpec): string[] {
  const i = spec.args.indexOf('--allowedTools');
  return i >= 0 ? (spec.args[i + 1] ?? '').split(',') : [];
}

// A capture fake that models the real CLI: the MCP tool `deniedId` is refused
// (surfaced on `deniedTools`) until it appears on the spawn's allowlist — i.e.
// after a grant re-spawns the turn — at which point the call succeeds with
// `successText`. Records every spec so tests can count spawns.
function grantAwareCapture(deniedId: string, successText: string, waitingText = 'Waiting on permission.') {
  const specs: SpawnSpec[] = [];
  const capture = (spec: SpawnSpec): Promise<CaptureResult> => {
    specs.push(spec);
    if (allowlistOf(spec).includes(deniedId)) {
      return Promise.resolve({ text: successText, deniedTools: [] });
    }
    return Promise.resolve({ text: waitingText, deniedTools: [{ name: deniedId, input: { issue: 'PROJ-123' } }] });
  };
  return { capture, specs };
}

const ID = 'mcp__jira__get_issue';

describe('runInterviewTurn — grant-on-demand (pmb.6)', () => {
  it('y: a denied read tool prompts, the grant re-spawns the turn to success, and does not persist', async () => {
    const { capture, specs } = grantAwareCapture(ID, withDelta('Pulled PROJ-123.', '{"requirements":["from PROJ-123"]}'));
    const askGrant = vi.fn().mockResolvedValue('session');
    const persistGrant = vi.fn();
    const save = vi.fn();
    const deps: TurnDeps = { capture, commit: okCommit, save, askGrant, persistGrant, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, "let's work on PROJ-123", deps);

    // prompted once with the parsed server/tool
    expect(askGrant).toHaveBeenCalledExactlyOnceWith('jira', 'get_issue');
    // re-spawned: first spawn denied, second (with grant) succeeded
    expect(specs.length).toBe(2);
    expect(allowlistOf(specs[0])).not.toContain(ID);
    expect(allowlistOf(specs[1])).toContain(ID);
    // the successful turn's output was distilled, not the waiting text
    expect(res.state.requirements).toEqual(['from PROJ-123']);
    expect(res.reply).toBe('Pulled PROJ-123.');
    // session-scoped: returned in memory, NOT persisted to config
    expect(res.sessionGrants).toEqual({ jira: ['get_issue'] });
    expect(persistGrant).not.toHaveBeenCalled();
  });

  it('always: also persists the per-role grant', async () => {
    const { capture } = grantAwareCapture(ID, withDelta('Pulled.', '{}'));
    const askGrant = vi.fn().mockResolvedValue('always');
    const persistGrant = vi.fn();
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, persistGrant, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123', deps);

    expect(persistGrant).toHaveBeenCalledExactlyOnceWith('jira', 'get_issue');
    expect(res.sessionGrants).toEqual({ jira: ['get_issue'] });
    expect(res.warnings).toEqual([]);
  });

  it('always with no persistGrant hook: keeps the grant session-only and warns', async () => {
    const { capture } = grantAwareCapture(ID, withDelta('Pulled.', '{}'));
    const askGrant = vi.fn().mockResolvedValue('always');
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123', deps);

    expect(res.sessionGrants).toEqual({ jira: ['get_issue'] });
    expect(res.warnings.join(' ')).toMatch(/session only/i);
  });

  it('always: a failing persist downgrades to session-only with a warning', async () => {
    const { capture } = grantAwareCapture(ID, withDelta('Pulled.', '{}'));
    const askGrant = vi.fn().mockResolvedValue('always');
    const persistGrant = vi.fn(() => { throw new Error('server not defined'); });
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, persistGrant, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123', deps);

    expect(res.sessionGrants).toEqual({ jira: ['get_issue'] });
    expect(res.warnings.join(' ')).toMatch(/could not persist.*server not defined/i);
  });

  it('N: no grant, no re-spawn, no persist — the turn proceeds without the tool', async () => {
    const { capture, specs } = grantAwareCapture(ID, 'unreachable');
    const askGrant = vi.fn().mockResolvedValue('deny');
    const persistGrant = vi.fn();
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, persistGrant, now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123', deps);

    expect(askGrant).toHaveBeenCalledOnce();
    expect(specs.length).toBe(1); // no re-spawn
    expect(res.sessionGrants).toEqual({}); // unchanged
    expect(persistGrant).not.toHaveBeenCalled();
    expect(res.reply).toBe('Waiting on permission.'); // proceeds on the text it got
  });

  it('never prompts for a mutation verb — a denied write is not offered', async () => {
    const { capture, specs } = grantAwareCapture('mcp__jira__update_issue', 'unreachable');
    const askGrant = vi.fn().mockResolvedValue('session');
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, now: () => NOW };

    await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'transition PROJ-123', deps);

    expect(askGrant).not.toHaveBeenCalled();
    expect(specs.length).toBe(1);
  });

  it('a grant carried in from a prior turn is not re-prompted', async () => {
    const { capture, specs } = grantAwareCapture(ID, withDelta('Pulled again.', '{}'));
    const askGrant = vi.fn().mockResolvedValue('deny');
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), askGrant, now: () => NOW };

    const res = await runInterviewTurn(
      newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123 again', deps,
      { jira: ['get_issue'] }, // already granted this session
    );

    expect(askGrant).not.toHaveBeenCalled();
    expect(specs.length).toBe(1);
    expect(allowlistOf(specs[0])).toContain(ID); // granted from the start of the turn
    expect(res.reply).toBe('Pulled again.');
  });

  it('without an askGrant hook, denials are ignored (pre-pmb.6 behaviour)', async () => {
    const { capture, specs } = grantAwareCapture(ID, 'unreachable');
    const deps: TurnDeps = { capture, commit: okCommit, save: vi.fn(), now: () => NOW };

    const res = await runInterviewTurn(newSessionState(sid, 'myapp', NOW), KSHETRA, 'PROJ-123', deps);

    expect(specs.length).toBe(1);
    expect(res.reply).toBe('Waiting on permission.');
  });
});
