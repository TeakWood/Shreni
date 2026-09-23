import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config';
import { costFor } from '../ext/index';

// Hoisted so the vi.mock factory can reference it without TDZ issues.
const { mockQuestion } = vi.hoisted(() => ({ mockQuestion: vi.fn() }));
vi.mock('readline', () => ({
  createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
}));

const mockStartSession = vi.fn();
const mockStopSession = vi.fn();
const mockStatusSession = vi.fn();
const mockResumeSession = vi.fn();
const mockTeardown = vi.fn(async () => {});
const mockListSessions = vi.fn();

vi.mock('../suthradhara/lifecycle', () => ({
  startSession: mockStartSession,
  stopSession: mockStopSession,
  statusSession: mockStatusSession,
  resumeSession: mockResumeSession,
  teardownWorktrees: mockTeardown,
}));

vi.mock('../suthradhara/persistence', () => ({
  listSessions: mockListSessions,
}));

vi.mock('../kshetra/registry', () => ({
  loadRegistry: vi.fn(() => []),
}));

// Base-branch preflight (uvu.6) — default to "exists" so existing launch/loop
// tests are unaffected; individual tests flip it to drive the missing path.
const mockCheckBaseBranch = vi.fn(async () => ({ exists: true }));
const mockCreateBaseBranch = vi.fn(async () => ({ branch: 'main', base: 'main' }));
vi.mock('../sthapathi/base-branch', () => ({
  checkBaseBranch: () => mockCheckBaseBranch(),
  createBaseBranch: () => mockCreateBaseBranch(),
}));

const {
  parseAtMention,
  parseSessionId,
  kshetraIdFromSessionId,
  resolveTargetKshetra,
  runSuthradhara,
  runPlanningLoop,
  mayLaunchSession,
  parseMenuChoice,
  renderSummary,
  ensureBaseBranchForLaunch,
} = await import('./suthradhara');
const { writeHandoff } = await import('../suthradhara/handoff');

const AGENTS = { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 } as const;
const KSHETRA_A = {
  id: 'alpha',
  repo: { path: '/projects/alpha', remote: '', mainBranch: 'main', branchPattern: '' },
  agents: AGENTS,
} as unknown as KshetraConfig;
const KSHETRA_B = {
  id: 'beta',
  repo: { path: '/projects/beta', remote: '', mainBranch: 'main', branchPattern: '' },
  agents: AGENTS,
} as unknown as KshetraConfig;

const ALPHA_SESSION = 'alpha-20260727T140312-a3f2';
const BETA_SESSION = 'beta-20260727T140312-b1c8';

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the base-branch preflight default each test (clearAllMocks
  // keeps implementations, but a per-test override would otherwise leak).
  mockCheckBaseBranch.mockResolvedValue({ exists: true });
  mockCreateBaseBranch.mockResolvedValue({ branch: 'main', base: 'main' });
});

describe('parseAtMention', () => {
  it('extracts the id from @<id> at any position', () => {
    expect(parseAtMention(['@alpha'])).toBe('alpha');
    expect(parseAtMention(['--foo', 'bar', '@myapp'])).toBe('myapp');
  });
  it('ignores non-matching @tokens and returns undefined otherwise', () => {
    expect(parseAtMention(['@Uppercase'])).toBeUndefined();
    expect(parseAtMention(['start', '--kshetra', 'foo'])).toBeUndefined();
  });
});

describe('parseSessionId / kshetraIdFromSessionId', () => {
  it('picks a well-formed session id and derives its kshetra', () => {
    expect(parseSessionId(['resume', ALPHA_SESSION])).toBe(ALPHA_SESSION);
    expect(parseSessionId(['@alpha', '--foo'])).toBeUndefined();
    expect(kshetraIdFromSessionId(BETA_SESSION)).toBe('beta');
  });
});

describe('resolveTargetKshetra', () => {
  it('resolves via @<id>, then --kshetra, then cwd; mention wins', () => {
    expect(resolveTargetKshetra(['@beta'], 'alpha', '/nowhere', [KSHETRA_A, KSHETRA_B]).id).toBe('beta');
    expect(resolveTargetKshetra([], 'alpha', '/nowhere', [KSHETRA_A, KSHETRA_B]).id).toBe('alpha');
    expect(resolveTargetKshetra([], undefined, '/projects/beta/src', [KSHETRA_A, KSHETRA_B]).id).toBe('beta');
  });
  it('throws on a missing id, a missed cwd, or an empty registry', () => {
    expect(() => resolveTargetKshetra(['@missing'], undefined, '/x', [KSHETRA_A])).toThrow(/not found: missing/);
    expect(() => resolveTargetKshetra([], undefined, '/elsewhere', [KSHETRA_A])).toThrow(/No kshetra resolvable.*Hint:/s);
    expect(() => resolveTargetKshetra([], undefined, '/x', [])).toThrow(/No kshetras registered/);
  });
});

describe('runSuthradhara — dispatch that does not enter the loop', () => {
  it('rejects an unknown or missing subcommand', async () => {
    await expect(runSuthradhara('reboot', { args: [], flagKshetra: undefined, cwd: '/', kshetras: [KSHETRA_A] })).rejects.toThrow(/Usage:/);
    await expect(runSuthradhara(undefined, { args: [], flagKshetra: undefined, cwd: '/', kshetras: [KSHETRA_A] })).rejects.toThrow(/Usage:/);
  });

  it('start reports already_running without entering the loop', async () => {
    // Already-running short-circuits the budget gate (fnd.7): no launch, no gate.
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: true, pid: 100 });
    mockStartSession.mockResolvedValue({ status: 'already_running', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('start', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockStartSession).toHaveBeenCalledWith(KSHETRA_A);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
  });

  it('stop reports each variant', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStopSession.mockResolvedValue({ status: 'stopped', kshetraId: 'alpha', pid: 100 });
    await runSuthradhara('stop', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockStopSession).toHaveBeenCalledWith(KSHETRA_A);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stopped (pid 100)'));
    mockStopSession.mockResolvedValue({ status: 'not_running', kshetraId: 'alpha' });
    await runSuthradhara('stop', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    logSpy.mockRestore();
  });

  it('status reports running + log path', async () => {
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: true, pid: 100, logPath: '/tmp/alpha/suthradhara.log' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('status', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('running (pid 100)');
    logSpy.mockRestore();
  });

  it('resume reports already_running, and rejects bad/unknown ids', async () => {
    // Already-running short-circuits the budget gate (fnd.7): no relaunch, no gate.
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: true, pid: 100 });
    mockResumeSession.mockResolvedValue({ status: 'already_running', kshetraId: 'alpha', pid: 100 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('resume', { args: [ALPHA_SESSION], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockResumeSession).toHaveBeenCalledWith(KSHETRA_A, ALPHA_SESSION);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running (pid 100)'));
    logSpy.mockRestore();

    await expect(runSuthradhara('resume', { args: [], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] })).rejects.toThrow(/Usage: shreni suthradhara resume/);
    await expect(runSuthradhara('resume', { args: [BETA_SESSION], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] })).rejects.toThrow(/kshetra "beta", which is not registered/);
  });

  it('list prints sessions by status', async () => {
    mockListSessions.mockReturnValue([
      { id: BETA_SESSION, kshetraId: 'beta', status: 'active', updatedAt: '2026-07-27T14:10:00.000Z' },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('list', { args: [], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A, KSHETRA_B] });
    expect(mockListSessions).toHaveBeenCalledWith(undefined);
    expect(logSpy.mock.calls.map(c => c[0]).join('\n')).toContain('status=active');
    logSpy.mockRestore();
  });
});

describe('parseMenuChoice', () => {
  it('maps digits and words to choices, null otherwise', () => {
    expect(parseMenuChoice('1')).toBe('extend');
    expect(parseMenuChoice('extend')).toBe('extend');
    expect(parseMenuChoice('2')).toBe('new');
    expect(parseMenuChoice(' New Story ')).toBe('new');
    expect(parseMenuChoice('3')).toBe('end');
    expect(parseMenuChoice('quit')).toBe('end');
    expect(parseMenuChoice('huh?')).toBeNull();
  });
});

describe('renderSummary', () => {
  it('renders epic/doc/branch + a merge prompt from the handoff', () => {
    const out = renderSummary(KSHETRA_A, {
      branch: 'suthradhara/sso', epicId: 'alpha-e1', docPath: '.shreni/design/sso.md', summary: 'SSO plan',
    }).join('\n');
    expect(out).toContain('alpha-e1');
    expect(out).toContain('suthradhara/sso');
    expect(out).toContain('.shreni/design/sso.md');
    expect(out).toContain('--base main');
  });
  it('degrades gracefully when the handoff is missing', () => {
    const out = renderSummary(KSHETRA_A, null).join('\n');
    expect(out).toContain('no handoff record');
  });
});

describe('runPlanningLoop transitions', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-wt-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha',
    sessionId: ALPHA_SESSION,
    claudeSessionId: 'cid',
    worktreePath,
    pid: 1,
    wait: vi.fn().mockResolvedValue(0),
  });

  it('end tears down the worktree and stops', async () => {
    const logs: string[] = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => '3', log: (m) => logs.push(m) });
    expect(mockTeardown).toHaveBeenCalledWith(KSHETRA_A);
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('planning ended');
  });

  it('extend relaunches in the SAME worktree seeded with the prior doc, then ends', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e', docPath: '.shreni/design/sso.md', summary: 's' });
    mockStartSession.mockResolvedValueOnce(launched(WT));
    const answers = ['1', '3'];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => answers.shift()!, log: () => {} });
    expect(mockStartSession).toHaveBeenCalledWith(
      KSHETRA_A,
      expect.objectContaining({ reuseWorktree: WT, extendDocRelPath: '.shreni/design/sso.md' }),
    );
  });

  it('new story tears down the old worktree before starting fresh (no reuse)', async () => {
    mockStartSession.mockResolvedValueOnce(launched(WT));
    const answers = ['2', '3'];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => answers.shift()!, log: () => {} });
    const startArgs = mockStartSession.mock.calls[0][1];
    expect(startArgs.reuseWorktree).toBeUndefined();
    // teardown ran twice: once for "new story", once for the final "end".
    expect(mockTeardown).toHaveBeenCalledTimes(2);
  });

  it('re-asks on an unrecognised menu answer', async () => {
    const answers = ['huh', '3'];
    const logs: string[] = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => answers.shift()!, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('Please answer 1, 2, or 3');
  });
});

describe('runPlanningLoop lifecycle events (fnd.2)', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-ev-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha',
    sessionId: ALPHA_SESSION,
    claudeSessionId: 'cid',
    worktreePath,
    pid: 1,
    wait: vi.fn().mockResolvedValue(0),
  });

  it('emits launched -> plan_filed -> doc_pushed -> session_ended -> menu_choice for a filed session', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => '3', log: () => {}, emit: (e) => events.push(e) });

    expect(events.map(e => e.type)).toEqual([
      'suthradhara_launched', 'suthradhara_plan_filed', 'suthradhara_doc_pushed',
      'suthradhara_session_ended', 'run_usage', 'suthradhara_menu_choice',
    ]);
    expect(events[0]).toMatchObject({ sessionId: ALPHA_SESSION, claudeSessionId: 'cid', resume: false });
    expect(events[1]).toMatchObject({ epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    expect(events[2]).toMatchObject({ branch: 'suthradhara/sso' });
    expect(events[3]).toMatchObject({ epicId: 'e-1' });
    // run_usage is keyed by the filed epic id (the same beadId the meter record uses).
    expect(events[4]).toMatchObject({ type: 'run_usage', agent: 'suthradhara', beadId: 'e-1' });
    expect(events[5]).toMatchObject({ choice: 'end' });
  });

  it('omits plan_filed/doc_pushed when the session filed no handoff', async () => {
    const events: Array<{ type: string; epicId?: string; beadId?: string }> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => '3', log: () => {}, emit: (e) => events.push(e) });
    expect(events.map(e => e.type)).toEqual([
      'suthradhara_launched', 'suthradhara_session_ended', 'run_usage', 'suthradhara_menu_choice',
    ]);
    // session_ended carries no epicId when nothing was filed.
    expect(events[1].epicId).toBeUndefined();
    // With no handoff, run_usage falls back to keying on the shreni session id.
    expect(events[2]).toMatchObject({ type: 'run_usage', beadId: ALPHA_SESSION });
  });

  it('emits one launched + session_ended per session across extend -> end', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    mockStartSession.mockResolvedValueOnce(launched(WT));
    const answers = ['1', '3'];
    const events: Array<{ type: string; resume?: boolean; choice?: string }> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => answers.shift()!, log: () => {}, emit: (e) => events.push(e) });

    expect(events.filter(e => e.type === 'suthradhara_launched')).toHaveLength(2);
    expect(events.filter(e => e.type === 'suthradhara_session_ended')).toHaveLength(2);
    expect(events.filter(e => e.type === 'suthradhara_menu_choice').map(e => e.choice)).toEqual(['extend', 'end']);
    // Loop relaunches are fresh, never resumes.
    expect(events.filter(e => e.type === 'suthradhara_launched').every(e => e.resume === false)).toBe(true);
  });

  it('marks the first session as a resume when firstResume is set', async () => {
    const events: Array<{ type: string; resume?: boolean }> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), { ask: async () => '3', log: () => {}, emit: (e) => events.push(e) }, true);
    expect(events[0]).toMatchObject({ type: 'suthradhara_launched', resume: true });
  });
});

describe('runPlanningLoop usage recording (fnd.4)', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-usage-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha', sessionId: ALPHA_SESSION, claudeSessionId: 'cid',
    worktreePath, pid: 1, wait: vi.fn().mockResolvedValue(0),
  });

  const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20, toolCallCount: 3 };
  const noEmit = { emit: () => {}, log: () => {} };

  it('records exactly one usage entry per session with the correct keys', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    const records: Array<Record<string, unknown>> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ...noEmit, ask: async () => '3',
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kshetra: 'alpha', beadId: 'e-1', runId: 'cid', agent: 'suthradhara',
      provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20,
      toolCallCount: 3, outcome: 'ok',
    });
  });

  it('falls back to sessionId as beadId when no handoff was filed', async () => {
    const records: Array<Record<string, unknown>> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ...noEmit, ask: async () => '3',
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    });
    expect(records).toHaveLength(1);
    expect(records[0].beadId).toBe(ALPHA_SESSION);
  });

  it('records one entry per session across an extend -> end run', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    mockStartSession.mockResolvedValueOnce(launched(WT));
    const answers = ['1', '3'];
    const records: Array<Record<string, unknown>> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ...noEmit, ask: async () => answers.shift()!,
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    });
    expect(records).toHaveLength(2);
  });

  it('still records a zero-usage entry when transcript recovery yields zeros', async () => {
    const records: Array<Record<string, unknown>> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ...noEmit, ask: async () => '3',
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0 }),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ inputTokens: 0, toolCallCount: 0, agent: 'suthradhara' });
  });

  it('does not crash the loop when the meter throws', async () => {
    const logs: string[] = [];
    await expect(runPlanningLoop(KSHETRA_A, launched(WT), {
      emit: () => {}, log: (m) => logs.push(m), ask: async () => '3',
      meter: { record: () => { throw new Error('disk full'); } },
      readUsage: () => ({ ...USAGE }),
    })).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('usage metering failed');
  });
});

describe('runPlanningLoop run_usage fold (fnd.6)', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-runusage-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha', sessionId: ALPHA_SESSION, claudeSessionId: 'cid',
    worktreePath, pid: 1, wait: vi.fn().mockResolvedValue(0),
  });
  const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20, toolCallCount: 3 };

  it('emits one run_usage summary per session, cost matching the meter record 1:1', async () => {
    writeHandoff(WT, { branch: 'suthradhara/sso', epicId: 'e-1', docPath: '.shreni/design/sso.md', summary: 's' });
    const events: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      log: () => {}, ask: async () => '3',
      emit: (e) => events.push(e),
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    });
    const usageEvents = events.filter(e => e.type === 'run_usage');
    expect(usageEvents).toHaveLength(1);
    // Same beadId/agent/provider/model + headline totals as the meter record, and
    // the cost derived from the very same price lookup the meter uses.
    const { costUsd, priced } = costFor(records[0] as never);
    expect(usageEvents[0]).toMatchObject({
      kshetra: 'alpha', beadId: 'e-1', agent: 'suthradhara',
      provider: 'anthropic', model: 'claude-sonnet-4-6',
      inputTokens: 10, outputTokens: 5, costUsd, priced, outcome: 'ok',
    });
    // The summary carries no cache/tool breakdown — that stays in usage.jsonl.
    expect(usageEvents[0]).not.toHaveProperty('toolCallCount');
    expect(usageEvents[0]).not.toHaveProperty('cacheReadTokens');
  });

  it('times the planning session and carries durationMs on both the meter record and run_usage (Shreni-beads-27a)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const session = launched(WT);
    session.wait = vi.fn(() => new Promise(r => setTimeout(() => r(0), 30)));
    await runPlanningLoop(KSHETRA_A, session, {
      log: () => {}, ask: async () => '3',
      emit: (e) => events.push(e),
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    });
    expect(records[0].durationMs as number).toBeGreaterThanOrEqual(25);
    const usageEvents = events.filter(e => e.type === 'run_usage');
    expect(usageEvents[0].durationMs).toBe(records[0].durationMs);
  });

  it('meters even if the run_usage fold throws, and logs the fold failure without crashing', async () => {
    // A meter that succeeds, but an emit that throws only on run_usage — the
    // record must still land and the loop must survive.
    const records: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    await expect(runPlanningLoop(KSHETRA_A, launched(WT), {
      log: (m) => logs.push(m), ask: async () => '3',
      emit: (e) => { if ((e as { type: string }).type === 'run_usage') throw new Error('sink down'); },
      meter: { record: (r) => records.push(r) },
      readUsage: () => ({ ...USAGE }),
    })).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
    expect(logs.join('\n')).toContain('run_usage fold failed');
  });
});

describe('mayLaunchSession budget gate (fnd.7)', () => {
  const allowPolicy = { selectModel: () => ({ provider: 'anthropic', model: 'm' }), mayProceed: () => ({ allowed: true as const }) };
  const denyPolicy = {
    selectModel: () => ({ provider: 'anthropic', model: 'm' }),
    mayProceed: () => ({ allowed: false as const, reason: 'Kshetra alpha has spent $12 of its $10 per-Kshetra budget cap' }),
  };

  it('passes the decision through and records an allowed policy_decision', () => {
    const events: Array<Record<string, unknown>> = [];
    const decision = mayLaunchSession(KSHETRA_A, (e) => events.push(e), allowPolicy);
    expect(decision).toEqual({ allowed: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'policy_decision', kshetra: 'alpha', beadId: 'suthradhara:alpha',
      agent: 'suthradhara', policy: 'mayProceed', provider: 'anthropic', model: 'claude-sonnet-4-6',
      allowed: true,
    });
    // An allowed decision carries no reason.
    expect(events[0]).not.toHaveProperty('reason');
  });

  it('passes a denial through with its reason and records it on the ledger', () => {
    const events: Array<Record<string, unknown>> = [];
    const decision = mayLaunchSession(KSHETRA_A, (e) => events.push(e), denyPolicy);
    expect(decision).toMatchObject({ allowed: false });
    expect(events[0]).toMatchObject({
      type: 'policy_decision', agent: 'suthradhara', policy: 'mayProceed',
      allowed: false, reason: expect.stringContaining('per-Kshetra budget cap'),
    });
  });
});

describe('runPlanningLoop budget gate (fnd.7)', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-gate-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha', sessionId: ALPHA_SESSION, claudeSessionId: 'cid',
    worktreePath, pid: 1, wait: vi.fn().mockResolvedValue(0),
  });
  const denyPolicy = {
    selectModel: () => ({ provider: 'anthropic', model: 'm' }),
    mayProceed: () => ({ allowed: false as const, reason: 'over budget' }),
  };

  it('refuses to relaunch on an extend when the budget gate denies, and ends cleanly', async () => {
    const logs: string[] = [];
    const events: Array<{ type: string }> = [];
    // choice '1' == extend; the relaunch must be gated and denied before any spawn.
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ask: async () => '1', log: (m) => logs.push(m), emit: (e) => events.push(e),
      meter: { record: () => {} },
      readUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0 }),
      policy: denyPolicy,
    });
    // No relaunch happened, and the loop tore down + returned.
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockTeardown).toHaveBeenCalled();
    expect(logs.join('\n')).toContain('over budget');
    // The denial is on the ledger as a policy_decision.
    expect(events.some(e => e.type === 'policy_decision')).toBe(true);
  });
});

// ── base-branch preflight (uvu.6) ─────────────────────────────────────────────

describe('ensureBaseBranchForLaunch', () => {
  it('proceeds without prompting when the base branch exists', async () => {
    const ask = vi.fn();
    const ok = await ensureBaseBranchForLaunch(KSHETRA_A, {
      ask, check: async () => ({ exists: true }), log: () => {},
    });
    expect(ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('creates+pushes and proceeds when missing and the operator says yes', async () => {
    const create = vi.fn(async () => ({ branch: 'main', base: 'main' }));
    const ok = await ensureBaseBranchForLaunch(KSHETRA_A, {
      ask: async () => 'y', check: async () => ({ exists: false }), create, log: () => {},
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith(KSHETRA_A);
  });

  it('aborts (no create) when missing and the operator declines', async () => {
    const create = vi.fn();
    const logs: string[] = [];
    const ok = await ensureBaseBranchForLaunch(KSHETRA_A, {
      ask: async () => 'n', check: async () => ({ exists: false }), create, log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('launch aborted');
  });

  it('aborts when the origin check throws (does not dive into a doomed cut)', async () => {
    const ok = await ensureBaseBranchForLaunch(KSHETRA_A, {
      check: async () => { throw new Error('origin unreachable'); }, log: () => {},
    });
    expect(ok).toBe(false);
  });

  it('aborts when creation fails after a yes', async () => {
    const ok = await ensureBaseBranchForLaunch(KSHETRA_A, {
      ask: async () => 'y',
      check: async () => ({ exists: false }),
      create: async () => { throw new Error('push rejected'); },
      log: () => {},
    });
    expect(ok).toBe(false);
  });
});

describe('base-branch preflight wired into the launch paths (uvu.6)', () => {
  it('start aborts before startSession when the base is missing and declined', async () => {
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: false });
    mockCheckBaseBranch.mockResolvedValue({ exists: false });
    // Drive the [y/N] prompt (real defaultAsk → mocked readline) to answer 'n'.
    mockQuestion.mockImplementation((_q: string, cb: (a: string) => void) => cb('n'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('start', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockStartSession).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('start proceeds to startSession when the base exists', async () => {
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: false });
    mockCheckBaseBranch.mockResolvedValue({ exists: true });
    mockStartSession.mockResolvedValue({ status: 'already_running', kshetraId: 'alpha', pid: 1 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('start', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockStartSession).toHaveBeenCalledWith(KSHETRA_A);
    logSpy.mockRestore();
  });

  it('skips the base check when a session is already running', async () => {
    mockStatusSession.mockReturnValue({ kshetraId: 'alpha', running: true, pid: 9 });
    mockStartSession.mockResolvedValue({ status: 'already_running', kshetraId: 'alpha', pid: 9 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSuthradhara('start', { args: ['@alpha'], flagKshetra: undefined, cwd: '/x', kshetras: [KSHETRA_A] });
    expect(mockCheckBaseBranch).not.toHaveBeenCalled();
    expect(mockStartSession).toHaveBeenCalledWith(KSHETRA_A);
    logSpy.mockRestore();
  });
});

describe('runPlanningLoop base-branch preflight (uvu.6)', () => {
  let WT: string;
  beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'loop-base-')); });
  afterEach(() => { rmSync(WT, { recursive: true, force: true }); });
  const launched = (worktreePath: string) => ({
    status: 'launched' as const,
    kshetraId: 'alpha', sessionId: ALPHA_SESSION, claudeSessionId: 'cid',
    worktreePath, pid: 1, wait: vi.fn().mockResolvedValue(0),
  });

  it('a relaunch aborts + tears down when the base branch has gone missing', async () => {
    await runPlanningLoop(KSHETRA_A, launched(WT), {
      ask: async () => '2', // new story → relaunch
      log: () => {},
      emit: () => {},
      meter: { record: () => {} },
      readUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0 }),
      ensureBaseBranch: async () => false,
    });
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockTeardown).toHaveBeenCalledWith(KSHETRA_A);
  });
});
