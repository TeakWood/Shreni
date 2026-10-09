import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, PGLITE_TIMEOUT } from '../taskgraph/test/pglite';
import { openShreni, type ShreniClient } from '../policy/db/client';
import { taskLifecycle } from '../policy/lifecycle/lifecycle';
import type { KshetraConfig } from '../kshetra/config';
import { makeContext } from './registry';

// Suthradhara on the task graph engine (policy spec, "Approval: humans only"):
// the launcher creates the plan, the session files into it with shreni plan as
// the planner, and the developer approves, revises, discards or leaves it in
// the launcher's menu.

const mockStartSession = vi.fn();
const mockTeardown = vi.fn(async () => {});
vi.mock('../suthradhara/lifecycle', () => ({
  startSession: mockStartSession, stopSession: vi.fn(), statusSession: vi.fn(() => ({ running: false })),
  resumeSession: vi.fn(), teardownWorktrees: mockTeardown,
}));

let registry: KshetraConfig[] = [];
vi.mock('../kshetra/registry', () => ({ loadRegistry: () => registry }));

const { runPlanningLoop, parsePlanDecision, planForResume } = await import('./suthradhara');
const { runPlan } = await import('./plan');
const { planStore } = await import('../policy/suthradhara/filing');
const { buildPlanningSession } = await import('../suthradhara/session');
const { buildPlanningPrompt } = await import('../suthradhara/prompt');

const ME = 'dev@example.com';

beforeEach(() => vi.clearAllMocks());

async function setup() {
  const t = await createTestDb();
  const shreni: ShreniClient = await openShreni({ db: t.db, lifecycle: taskLifecycle });
  onTestFinished(async () => { await shreni.close(); await t.close(); });
  await shreni.migrate();
  const p = await shreni.tg.projects.create({ name: 'web', idPrefix: 'web', actor: { id: ME, role: 'developer' } });
  const tg = shreni.tg.project(p.id);
  const open = async () => ({ shreni, close: async () => {} });
  const plans = planStore(p.id, ME, open);
  const planId = await plans.create('Planning session');
  const repo = mkdtempSync(join(tmpdir(), 'shreni-plan-repo-'));
  mkdirSync(join(repo, '.shreni'));
  writeFileSync(join(repo, '.shreni', 'tracker.yaml'), `name: web\nproject: ${p.id}\n`);
  const kshetra = {
    id: 'web', name: 'web', project: p.id, database: 'local',
    repo: { path: repo, remote: 'git@x:web.git', mainBranch: 'main', branchPattern: '' },
    beads: { path: join(repo, 'no-beads'), remote: '' },
    agents: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
  } as unknown as KshetraConfig;
  /** What a planning session runs: shreni plan, inside SHRENI_PLAN, printing the id it files. */
  const plan = async (...args: string[]) => {
    const out: string[] = [];
    await runPlan(makeContext(args), {
      cwd: repo, env: { SHRENI_PLAN: planId }, open: async () => ({ shreni, close: async () => {} }), print: l => out.push(l),
    });
    return out.join('\n');
  };
  return { t, shreni, tg, p, plans, planId, kshetra, plan, repo };
}

/** Suthradhara's gate ①: an epic with two children and a dependency. */
async function fileEpic(plan: (...a: string[]) => Promise<string>) {
  const epic = await plan('task', 'add', '--title', 'Accounts', '--epic', '--priority', '1');
  const a = await plan('task', 'add', '--title', 'Sign in', '--parent', epic, '--check', 'given a user when they sign in then they see home');
  const b = await plan('task', 'add', '--title', 'Sign out', '--parent', epic);
  await plan('dep', 'add', b, a);
  return { epic, a, b };
}

const launched = (worktreePath: string, planId: string) => ({
  status: 'launched' as const, kshetraId: 'web', sessionId: 'web-20261009T120000-abcd', claudeSessionId: 'cid',
  worktreePath, pid: 1, wait: vi.fn().mockResolvedValue(0), planId,
});

const quiet = {
  log: () => {}, emit: () => {}, meter: { record: () => {} },
  readUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallCount: 0 }),
  policy: { mayProceed: () => ({ allowed: true as const }) } as never,
  ensureBaseBranch: async () => true,
};

describe('Suthradhara files through shreni plan', { timeout: PGLITE_TIMEOUT }, () => {
  it('given a planning session, when Suthradhara files an epic with two children and a dependency, then all three are proposed in one plan', async () => {
    const { tg, planId, plan } = await setup();
    const { epic, a, b } = await fileEpic(plan);
    const tasks = await tg.tasks.list({ plan: planId });
    expect(tasks.map(t => t.id).sort()).toEqual([epic, a, b].sort());
    expect(tasks.every(t => t.state === 'proposed' && t.origin === 'plan')).toBe(true);
    expect((await tg.tasks.get(b)).deps).toEqual([{ id: a, state: 'proposed' }]);
    expect((await tg.tasks.get(epic)).kind).toBe('container');
    const shown = await plan('show');
    expect(shown).toMatch(/Given a user, when they sign in, then they see home/);
    expect(await plan('validate')).toMatch(/passes/);
  });

  it('when the developer picks discard, then all three are cancelled', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    const { epic, a, b } = await fileEpic(plan);
    const answers = ['d', '3'];
    const logs: string[] = [];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()!, log: m => logs.push(m) });
    for (const id of [epic, a, b]) expect((await tg.tasks.get(id)).state).toBe('cancelled');
    expect(logs.join('\n')).toMatch(/discarded plan/);
    // The menu showed the plan and its checks first.
    expect(logs.join('\n')).toMatch(/Given a user, when they sign in/);
  });

  it('approve opens the plan\'s tasks', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    const { a } = await fileEpic(plan);
    const answers = ['a', '3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()! });
    expect((await tg.tasks.get(a)).state).toBe('open');
    expect((await tg.plans.get(planId)).approvedBy).toBe(ME);
  });

  it('revise relaunches on the same plan and worktree, then asks again', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    await fileEpic(plan);
    mockStartSession.mockResolvedValueOnce(launched(repo, planId));
    const answers = ['r', 'l', '3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()! });
    expect(mockStartSession).toHaveBeenCalledWith(kshetra, expect.objectContaining({
      planId, reuseWorktree: repo, kickoff: expect.stringContaining(`Revise plan ${planId}`),
    }));
    // Left for later: still open, still proposed.
    expect((await tg.plans.get(planId)).approvedAt).toBeNull();
    expect((await tg.tasks.list({ plan: planId, states: ['proposed'] }))).toHaveLength(3);
  });

  it('extend after "decide later" keeps filing into the open plan; after approval it gets a new plan', async () => {
    const { planId, plans, plan, kshetra, repo } = await setup();
    await fileEpic(plan);
    mockStartSession.mockResolvedValue(launched(repo, planId));
    let answers = ['l', '1', 'l', '3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()! });
    expect(mockStartSession.mock.calls[0][1].planId).toBe(planId);

    // A new story after "decide later" is its own plan: a plan is approved or discarded as one.
    mockStartSession.mockClear();
    mockStartSession.mockImplementation(async (_k, o) => launched(repo, o.planId));
    answers = ['l', '2', '3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()! });
    expect(mockStartSession.mock.calls[0][1].planId).not.toBe(planId);

    mockStartSession.mockClear();
    answers = ['a', '2', '3'];
    mockStartSession.mockImplementation(async (_k, o) => launched(repo, o.planId));
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()! });
    const next = mockStartSession.mock.calls[0][1].planId;
    expect(next).toMatch(/^web-plan-/);
    expect(next).not.toBe(planId);
  });

  it('a plan decided elsewhere meanwhile skips the plan menu', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    await fileEpic(plan);
    await tg.as({ id: ME, role: 'developer' }).plans.approve(planId, { via: 'test' });
    const logs: string[] = [];
    const answers = ['3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()!, log: m => logs.push(m) });
    expect(logs.join('\n')).not.toMatch(/\[a\] approve/);
  });

  it('a refused discard says why and asks again', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    const { a } = await fileEpic(plan);
    // A task outside the plan waits on one inside it, so discarding would strand it.
    const outside = await tg.as({ id: ME, role: 'developer' }).tasks.create({ title: 'outside' });
    await tg.as({ id: ME, role: 'developer' }).deps.add(outside.id, a);
    const logs: string[] = [];
    const answers = ['d', 'l', '3'];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => answers.shift()!, log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/not discarded/);
    expect(logs.join('\n')).toMatch(/left for later/);
    expect((await tg.tasks.get(a)).state).toBe('proposed');
  });

  it('approves only what was shown: a plan that grew meanwhile is refused, and the menu asks again', async () => {
    const { tg, planId, plans, plan, kshetra, repo } = await setup();
    await fileEpic(plan);
    const events: { type: string; decision?: string }[] = [];
    const answers = ['a', 'l', '3'];
    let grew = false;
    const ask = async () => {
      if (!grew) {
        grew = true;
        await plan('task', 'add', '--title', 'slipped in');
      }
      return answers.shift()!;
    };
    const logs: string[] = [];
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask, log: m => logs.push(m), emit: e => events.push(e as never) });
    expect(logs.join('\n')).toMatch(/not approved: plan .* changed while you looked/);
    expect((await tg.plans.get(planId)).approvedAt).toBeNull();
    // Only what happened is recorded: the refused approval isn't.
    expect(events.filter(e => e.type === 'suthradhara_plan_decision').map(e => e.decision)).toEqual(['later']);
  });

  it('discards an empty plan when planning ends', async () => {
    const { tg, planId, plans, kshetra, repo } = await setup();
    await runPlanningLoop(kshetra, launched(repo, planId), { ...quiet, plans, ask: async () => '3' });
    expect((await tg.plans.get(planId)).discardedAt).not.toBeNull();
  });

  it('revise passes the budget gate, like extend and new', async () => {
    const { planId, plans, plan, kshetra, repo } = await setup();
    await fileEpic(plan);
    const logs: string[] = [];
    await runPlanningLoop(kshetra, launched(repo, planId), {
      ...quiet, plans, ask: async () => 'r', log: m => logs.push(m),
      policy: { mayProceed: () => ({ allowed: false, reason: 'over budget' }) } as never,
    });
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/over budget — not relaunching to revise/);
  });

  it('a resumed session keeps its plan while open, else gets a new one', async () => {
    const { tg, planId, plans, kshetra, plan } = await setup();
    expect(await planForResume(plans, kshetra, planId)).toBe(planId);
    expect(await planForResume(plans, kshetra, undefined)).toMatch(/^web-plan-/);
    await fileEpic(plan);
    await tg.as({ id: ME, role: 'developer' }).plans.approve(planId, { via: 'test' });
    const next = await planForResume(plans, kshetra, planId);
    expect(next).not.toBe(planId);
    expect(await plans.isOpen(next)).toBe(true);
  });

  it('never changes approved work, and waits only on its own plan or approved work', async () => {
    const { t, tg, planId, plan, plans } = await setup();
    const { a } = await fileEpic(plan);
    const dev = tg.as({ id: ME, role: 'developer' });
    // Another plan's proposal can't be waited on; approved work can.
    const other = await plans.create('other');
    const elsewhere = await tg.as({ id: 'p', role: 'planner' }).tasks.create({ title: 'elsewhere', plan: other });
    const approved = await dev.tasks.create({ title: 'approved work' });
    await dev.tasks.approve(approved.id, { via: 'test' });
    const x = await plan('task', 'add', '--title', 'x');
    await expect(plan('dep', 'add', x, elsewhere.id)).rejects.toThrow(/proposed in plan .*; wait only on this plan's tasks or approved work/);
    await plan('dep', 'add', x, approved.id);

    await dev.plans.approve(planId, { via: 'test' });
    // A checks-only update once approved: refused, the checks untouched.
    await expect(plan('task', 'update', a, '--check', 'given x when y then z')).rejects.toThrow(/is open: once approved, a change is a new plan/);
    const checks = (await t.pglite.query<{ given: string }>(`select given from shreni.acceptance_checks where task_id = $1`, [a])).rows;
    expect(checks).toEqual([{ given: 'a user' }]);
  });

  it('finds the project from SHRENI_KSHETRA, since a session\'s worktree may not carry the config', async () => {
    const { shreni, tg, planId, kshetra } = await setup();
    registry = [kshetra];
    onTestFinished(() => { registry = []; });
    const out: string[] = [];
    await runPlan(makeContext(['task', 'add', '--title', 'from the worktree']), {
      cwd: mkdtempSync(join(tmpdir(), 'shreni-wt-')), env: { SHRENI_PLAN: planId, SHRENI_KSHETRA: 'web' },
      open: async () => ({ shreni, close: async () => {} }), print: l => out.push(l),
    });
    expect((await tg.tasks.get(out[0])).planId).toBe(planId);
  });

  it('shreni plan works only on its own plan, and only inside a session', async () => {
    const { tg, plan, shreni, repo } = await setup();
    const outside = await tg.as({ id: ME, role: 'developer' }).tasks.create({ title: 'not in the plan' });
    await expect(plan('task', 'update', outside.id, '--title', 'x')).rejects.toThrow(/isn't in plan/);
    await expect(plan('task', 'delete', outside.id)).rejects.toThrow(/isn't in plan/);
    await expect(plan('dep', 'add', outside.id, outside.id)).rejects.toThrow(/isn't in plan/);
    await expect(plan('task', 'add', '--title', 'x', '--parent', outside.id)).rejects.toThrow(/isn't in plan/);
    await expect(runPlan(makeContext(['show']), { cwd: repo, env: {}, open: async () => ({ shreni, close: async () => {} }), print: () => {} }))
      .rejects.toThrow(/SHRENI_PLAN/);
    await expect(plan('task', 'approve', 'x')).rejects.toThrow(/unknown shreni plan command/);
  });

  it('revise edits and deletes its own proposed tasks; checks are replaced', async () => {
    const { shreni, tg, plan } = await setup();
    const { a, b } = await fileEpic(plan);
    await plan('task', 'update', a, '--title', 'Sign in with SSO', '--check', 'given SSO when they sign in then home');
    expect((await tg.tasks.get(a)).title).toBe('Sign in with SSO');
    const checks = await shreni.db.selectFrom('shreni.acceptance_checks').select('given').where('task_id', '=', a).execute();
    expect(checks).toEqual([{ given: 'SSO' }]);
    await plan('dep', 'remove', b, a);
    await plan('task', 'delete', b);
    await expect(tg.tasks.get(b)).rejects.toThrow(/not found/);
  });

});

describe('the session and prompt on the engine', () => {
  it('gives the session its plan and Kshetra in place of BEADS_DIR, and gate ① files with shreni plan', () => {
    const kshetra = {
      id: 'web', project: '00000000-0000-0000-0000-000000000001', repo: { path: '/r', remote: 'git@x:web.git', mainBranch: 'main' },
      agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, mcp: { servers: {} },
    } as unknown as KshetraConfig;
    const spec = buildPlanningSession({ kshetra, claudeSessionId: 'c', planId: 'web-plan-ab12' });
    expect(spec.env).toMatchObject({ SHRENI_PLAN: 'web-plan-ab12', SHRENI_KSHETRA: 'web' });
    expect(spec.env).not.toHaveProperty('BEADS_DIR');
    expect(() => buildPlanningSession({ kshetra, claudeSessionId: 'c' })).toThrow(/needs the plan/);
    const prompt = buildPlanningPrompt(kshetra, { planId: 'web-plan-ab12' });
    expect(prompt).toContain('shreni plan task add');
    expect(prompt).toContain('shreni plan validate');
    expect(prompt).not.toContain('bd create');
    expect(prompt).not.toContain('BEADS_DIR');
    expect(prompt).toContain('you never approve it');
  });

  it('refuses a Kshetra still on beads, naming shreni migrate', () => {
    const kshetra = {
      id: 'old', repo: { path: '/r', remote: 'git@x:old.git', mainBranch: 'main' },
      agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 }, mcp: { servers: {} },
    } as unknown as KshetraConfig;
    expect(() => buildPlanningSession({ kshetra, claudeSessionId: 'c', planId: 'p' })).toThrow('old has no task graph project: run shreni migrate old');
  });

  it('reads the developer\'s decision', () => {
    expect(parsePlanDecision('A')).toBe('approve');
    expect(parsePlanDecision('decide later')).toBe('later');
    expect(parsePlanDecision('x')).toBeNull();
  });
});

