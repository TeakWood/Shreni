import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DirectedGraph } from 'graphology';
import { hasCycle } from 'graphology-dag';
import { openEngine, type TestEngine } from './test/engine';
import { testLifecycle } from './test/lifecycle';
import { CycleError, InvalidRequest, MoveRefused, NotPermitted } from './errors';
import type { ProjectHandle } from './client';

// Model-based property test (engine spec, "Testing"): random sequences of
// create, edit, add dependency, delete and move run against the engine and a
// simple in-memory model, and after every step the engine must agree with the
// model and keep its invariants. Claims and the clock join in slice 2.

const LC = testLifecycle();
const TERMINAL = new Set(Object.keys(LC.states).filter(s => LC.states[s].terminal));
const SATISFIES = new Set(Object.keys(LC.states).filter(s => LC.states[s].satisfiesDeps));
const CLAIMABLE = Object.keys(LC.states).find(s => LC.states[s].claimable)!;

type MTask = {
  id: string; kind: 'work' | 'container'; state: string; parent: string | null; priority: number; createdAt: number;
  /** hold_until is in the future. */
  held: boolean;
};
/** A hold: none, one already past, or one far ahead. */
type Hold = 'none' | 'past' | 'future';
const HOLD_AT: Record<Hold, Date | null> = { none: null, past: new Date('2000-01-01Z'), future: new Date('2100-01-01Z') };
type Role = 'developer' | 'planner' | 'orchestrator' | 'system';
/** The test lifecycle's tasks.update permission: the states each role may edit in. */
const EDIT_STATES: Record<string, string[]> = { developer: ['proposed', 'open', 'blocked', 'parked'], planner: ['proposed'] };
type Model = { tasks: MTask[]; deps: Set<string>; clock: number };
type Real = { e: TestEngine; tg: ProjectHandle };

/** Commands that ran, by kind and outcome, so a run that does nothing can't pass. */
const RAN = new Map<string, number>();
const ran = (what: string) => RAN.set(what, (RAN.get(what) ?? 0) + 1);

const edge = (a: string, b: string) => `${a}>${b}`;
const pick = (m: Model, i: number) => m.tasks[i % m.tasks.length];
const children = (m: Model, id: string) => m.tasks.filter(t => t.parent === id);
const dependents = (m: Model, id: string) => m.tasks.filter(t => m.deps.has(edge(t.id, id)));

/** Does b already reach a through dependencies (so a -> b would close a cycle)? */
function reaches(m: Model, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const t of m.tasks) if (m.deps.has(edge(n, t.id))) stack.push(t.id);
  }
  return false;
}

function modelReady(m: Model): string[] {
  const byId = new Map(m.tasks.map(t => [t.id, t]));
  const ancestorsClaimable = (t: MTask) => {
    for (let p = t.parent; p; p = byId.get(p)!.parent) if (byId.get(p)!.state !== CLAIMABLE) return false;
    return true;
  };
  return m.tasks
    .filter(t => t.state === CLAIMABLE && t.kind === 'work' && !t.held && ancestorsClaimable(t)
      && m.tasks.every(d => !m.deps.has(edge(t.id, d.id)) || SATISFIES.has(d.state)))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    .map(t => t.id);
}

/** Runs the engine call; checks it succeeds exactly when the model says it should, with the expected error. */
async function expectOutcome<T>(call: Promise<T>, refusal: (new (...a: any[]) => Error) | null): Promise<T | undefined> {
  const r = await call.then(v => ({ ok: true as const, v }), err => ({ ok: false as const, err }));
  if (refusal === null) {
    if (!r.ok) throw r.err;
    ran('ok');
    return r.v;
  }
  ran(`refused:${refusal.name}`);
  expect(r.ok, `expected ${refusal.name}`).toBe(false);
  if (!r.ok) expect(r.err).toBeInstanceOf(refusal);
  return undefined;
}

class Create implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly role: 'planner' | 'system', readonly kind: 'work' | 'container', readonly parentIdx: number | null,
    readonly priority: number, readonly hold: Hold,
  ) {}
  check() { return true; }
  async run(m: Model, r: Real) {
    const parent = this.parentIdx !== null && m.tasks.length ? pick(m, this.parentIdx) : null;
    const refusal = parent && TERMINAL.has(parent.state) ? InvalidRequest : null;
    const t = await expectOutcome(r.tg.as({ id: this.role, role: this.role }).tasks.create({
      title: 't', kind: this.kind, parent: parent?.id, priority: this.priority,
      ...(HOLD_AT[this.hold] ? { holdUntil: HOLD_AT[this.hold]! } : {}),
    }), refusal);
    if (t) {
      expect(t.state).toBe(this.role === 'system' ? 'open' : 'proposed');
      m.tasks.push({ id: t.id, kind: this.kind, state: t.state, parent: parent?.id ?? null, priority: this.priority, createdAt: m.clock++, held: this.hold === 'future' });
    }
  }
  toString() { return `create(${this.role}, ${this.kind}, parent#${this.parentIdx}, p${this.priority}, hold ${this.hold})`; }
}

class Edit implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly idx: number, readonly role: 'developer' | 'planner', readonly priority: number,
    readonly parentIdx: number | null | undefined, readonly kind: 'work' | 'container' | undefined, readonly hold: Hold | undefined,
  ) {}
  check(m: Readonly<Model>) { return m.tasks.length > 0; }
  async run(m: Model, r: Real) {
    const t = pick(m, this.idx);
    const parent = this.parentIdx === undefined ? undefined : this.parentIdx === null ? null : pick(m, this.parentIdx);
    // in the engine's order: permission, then the kind change, then the reparent
    let refusal: (new (...a: any[]) => Error) | null = EDIT_STATES[this.role].includes(t.state) ? null : NotPermitted;
    if (!refusal && this.kind !== undefined && this.kind !== t.kind && children(m, t.id).length) refusal = InvalidRequest;
    if (!refusal && parent && parent.id !== t.parent) {
      let inside = false;
      for (let p: string | null = parent.id; p; p = m.tasks.find(x => x.id === p)!.parent) if (p === t.id) inside = true;
      if (inside || (TERMINAL.has(parent.state) && !TERMINAL.has(t.state))) refusal = InvalidRequest;
    }
    const out = await expectOutcome(r.tg.as({ id: this.role, role: this.role }).tasks.update(t.id, {
      priority: this.priority,
      ...(parent !== undefined ? { parent: parent?.id ?? null } : {}),
      ...(this.kind !== undefined ? { kind: this.kind } : {}),
      ...(this.hold !== undefined ? { holdUntil: HOLD_AT[this.hold] } : {}),
    }), refusal);
    if (out) {
      t.priority = this.priority;
      if (parent !== undefined) t.parent = parent?.id ?? null;
      if (this.kind !== undefined) t.kind = this.kind;
      if (this.hold !== undefined) t.held = this.hold === 'future';
    }
  }
  toString() { return `edit(#${this.idx} as ${this.role}, p${this.priority}, parent#${this.parentIdx}, ${this.kind}, hold ${this.hold})`; }
}

class AddDep implements fc.AsyncCommand<Model, Real> {
  constructor(readonly a: number, readonly b: number) {}
  check(m: Readonly<Model>) { return m.tasks.length > 0; }
  async run(m: Model, r: Real) {
    const a = pick(m, this.a);
    const b = pick(m, this.b);
    // the engine checks the target's state before the cycle
    const refusal = TERMINAL.has(b.state) && !SATISFIES.has(b.state) ? InvalidRequest
      : a.id === b.id || reaches(m, b.id, a.id) ? CycleError : null;
    await expectOutcome(r.tg.as({ id: 'dev', role: 'developer' }).deps.add(a.id, b.id), refusal);
    if (!refusal) m.deps.add(edge(a.id, b.id));
  }
  toString() { return `dep(#${this.a} -> #${this.b})`; }
}

class Delete implements fc.AsyncCommand<Model, Real> {
  constructor(readonly idx: number) {}
  check(m: Readonly<Model>) { return m.tasks.length > 0; }
  async run(m: Model, r: Real) {
    const t = pick(m, this.idx);
    const refusal = t.state !== 'proposed' ? NotPermitted : children(m, t.id).length ? InvalidRequest : null;
    await expectOutcome(r.tg.as({ id: 'planner', role: 'planner' }).tasks.delete(t.id), refusal);
    if (!refusal) {
      m.tasks = m.tasks.filter(x => x.id !== t.id);
      for (const k of [...m.deps]) if (k.startsWith(`${t.id}>`) || k.endsWith(`>${t.id}`)) m.deps.delete(k);
    }
  }
  toString() { return `delete(#${this.idx})`; }
}

const MOVES = ['approve', 'park', 'unpark', 'flag', 'unblock', 'cancel', 'completeContainer'] as const;

class Move implements fc.AsyncCommand<Model, Real> {
  constructor(readonly idx: number, readonly move: typeof MOVES[number], readonly dropDeps: boolean, readonly role: Role) {}
  check(m: Readonly<Model>) { return m.tasks.length > 0; }
  async run(m: Model, r: Real) {
    const t = pick(m, this.idx);
    const def = LC.moves.find(x => x.name === this.move)!;
    const { role } = this;
    const to = def.to;
    let reason: string | null = null;
    if (!def.by.includes(role)) reason = 'NotPermitted';
    else if (!def.from.includes(t.state)) reason = 'WrongState';
    else if (TERMINAL.has(to) && children(m, t.id).some(c => !TERMINAL.has(c.state))) reason = 'ChildrenLive';
    else if (TERMINAL.has(to) && !SATISFIES.has(to) && !this.dropDeps
      && dependents(m, t.id).some(d => !TERMINAL.has(d.state))) reason = 'DependentsLive';
    const out = await r.tg.as({ id: role, role }).move(t.id, this.move, { dropDeps: this.dropDeps })
      .then(v => v, err => err);
    ran(reason ? `move refused:${reason}` : `move:${this.move}`);
    if (reason) {
      expect(out).toBeInstanceOf(MoveRefused);
      expect((out as MoveRefused).reason).toBe(reason);
      return;
    }
    if (out instanceof Error) throw out;
    if (TERMINAL.has(to) && !SATISFIES.has(to)) {
      for (const d of dependents(m, t.id)) if (!TERMINAL.has(d.state)) m.deps.delete(edge(d.id, t.id));
    }
    t.state = to;
  }
  toString() { return `move(#${this.idx}, ${this.move} as ${this.role}${this.dropDeps ? ', dropDeps' : ''})`; }
}

/** Cancels a task that live tasks wait on, so DependentsLive and dropDeps come up in every run. */
class CancelWaitedOn implements fc.AsyncCommand<Model, Real> {
  constructor(readonly idx: number, readonly dropDeps: boolean) {}
  private targets(m: Readonly<Model>) {
    return m.tasks.filter(t => !TERMINAL.has(t.state) && dependents(m as Model, t.id).some(d => !TERMINAL.has(d.state)));
  }
  check(m: Readonly<Model>) { return this.targets(m).length > 0; }
  async run(m: Model, r: Real) {
    const targets = this.targets(m);
    await new Move(m.tasks.indexOf(targets[this.idx % targets.length]), 'cancel', this.dropDeps, 'developer').run(m, r);
  }
  toString() { return `cancelWaitedOn(#${this.idx}${this.dropDeps ? ', dropDeps' : ''})`; }
}

const idx = fc.nat({ max: 8 });
const hold = fc.constantFrom<Hold>('none', 'none', 'past', 'future');
const create = fc.tuple(fc.constantFrom('planner' as const, 'system' as const), fc.constantFrom('work' as const, 'container' as const),
  fc.option(idx, { nil: null }), fc.integer({ min: 0, max: 4 }), hold)
  .map(([role, kind, p, prio, h]) => new Create(role, kind, p, prio, h));
/** The move's own role most of the time, sometimes a random one, to reach NotPermitted. */
const move = fc.tuple(idx, fc.constantFrom(...MOVES), fc.boolean(), fc.option(fc.constantFrom<Role>('developer', 'planner', 'orchestrator', 'system'), { freq: 4 }))
  .map(([i, mv, d, role]) => new Move(i, mv, d, role ?? LC.moves.find(x => x.name === mv)!.by[0] as Role));
const dep = fc.tuple(idx, idx).map(([a, b]) => new AddDep(a, b));
// Entries repeat to weight them: creates build the graph the others act on.
const COMMANDS = [
  create, create, create, create,
  fc.tuple(idx, fc.constantFrom('developer' as const, 'developer' as const, 'planner' as const), fc.integer({ min: 0, max: 4 }),
    fc.option(fc.option(idx, { nil: null }), { nil: undefined }),
    fc.option(fc.constantFrom('work' as const, 'container' as const), { nil: undefined, freq: 4 }),
    fc.option(hold, { nil: undefined }))
    .map(([i, role, prio, p, kind, h]) => new Edit(i, role, prio, p, kind, h)),
  dep, dep, dep,
  idx.map(i => new Delete(i)),
  move, move, move,
  fc.tuple(idx, fc.boolean()).map(([i, d]) => new CancelWaitedOn(i, d)),
  fc.tuple(idx, fc.boolean()).map(([i, d]) => new CancelWaitedOn(i, d)),
];

/** The invariants the spec lists, plus agreement with the model on every task's state and the ready set. */
async function checkInvariants(m: Model, r: Real) {
  const rows = await r.e.rows<{ id: string; state: string; lease_attempt_id: string | null } & Record<string, unknown>>(
    `select id, state, lease_attempt_id, kind, parent_id as parent, priority,
            coalesce(hold_until > taskgraph.now(), false) as held
       from taskgraph.tasks where project_id = $1`, [r.tg.id]);
  for (const row of rows) expect(LC.states[row.state], `undeclared state ${row.state}`).toBeDefined();
  const shape = (x: Record<string, unknown>) => [x.id, { state: x.state, kind: x.kind, parent: x.parent, priority: x.priority, held: x.held }];
  expect(Object.fromEntries(rows.map(shape))).toEqual(Object.fromEntries(m.tasks.map(shape)));
  // nothing is leased in slice 1
  expect(rows.filter(x => x.lease_attempt_id !== null)).toEqual([]);

  const g = new DirectedGraph();
  for (const t of rows) g.addNode(t.id);
  for (const d of await r.e.rows<{ task_id: string; depends_on_id: string }>(
    `select task_id, depends_on_id from taskgraph.task_deps where project_id = $1`, [r.tg.id])) {
    g.addEdge(d.task_id, d.depends_on_id);
  }
  expect(hasCycle(g)).toBe(false);
  expect(new Set(g.edges().map(k => edge(g.source(k), g.target(k))))).toEqual(m.deps);

  expect((await r.tg.ready()).map(t => t.id)).toEqual(modelReady(m));
}

/** Runs `numRuns` random sequences, each in a fresh project, checking the invariants after every step. */
async function runModel(e: TestEngine, numRuns: number, seed?: number) {
  let n = 0;
  await fc.assert(
    fc.asyncProperty(fc.commands(COMMANDS, { maxCommands: 30, size: 'max' }), async cmds => {
      const p = await e.client.projects.create({ name: `m${n++}`, idPrefix: 'm', actor: { id: 'a', role: 'developer' } });
      const real: Real = { e, tg: e.client.project(p.id) };
      const model: Model = { tasks: [], deps: new Set(), clock: 0 };
      await fc.asyncModelRun(() => ({ model, real }), [...cmds].map(c => ({
        check: (mm: Readonly<Model>) => c.check(mm),
        run: async (mm: Model, rr: Real) => { await c.run(mm, rr); await checkInvariants(mm, rr); },
        toString: () => c.toString(),
      })));
    }),
    { numRuns, ...(seed !== undefined ? { seed } : {}) },
  );
}

describe('the engine against a model', () => {
  it('keeps the graph acyclic, every state declared, and the ready set the model\'s, over 200 random sequences', async () => {
    await runModel(await openEngine(), Number(process.env.MODEL_RUNS ?? 200));
  }, 600_000);

  it('reaches every interesting outcome, on a fixed seed', async () => {
    // Seeded, so whether a rare outcome comes up never depends on luck; the
    // random run above explores, this one guards against a generator that
    // stopped reaching the engine's rules.
    RAN.clear();
    await runModel(await openEngine(), 100, 20261009);
    for (const what of ['ok', 'refused:CycleError', 'refused:InvalidRequest', 'refused:NotPermitted', 'move:approve',
      'move:cancel', 'move:park', 'move refused:NotPermitted', 'move refused:WrongState', 'move refused:ChildrenLive',
      'move refused:DependentsLive']) {
      expect(RAN.get(what) ?? 0, `${what} in ${JSON.stringify([...RAN])}`).toBeGreaterThan(0);
    }
  }, 600_000);
});
