import { describe, it, expect, onTestFinished } from 'vitest';
import { createMigratedTestDb, PGLITE_TIMEOUT, type TestDb } from './test/pglite';
import { testLifecycle } from './test/lifecycle';
import { defineLifecycle, defineGuard, registerLifecycle, lifecycleHash, serializeLifecycle, type Lifecycle } from './lifecycle';
import { LifecycleInvalid } from './errors';

async function openDb(): Promise<TestDb> {
  const t = await createMigratedTestDb();
  onTestFinished(() => t.close());
  return t;
}

const move = (l: Lifecycle, name: string) => l.moves.find(m => m.name === name)!;
const someGuard = defineGuard('someGuard', async () => true);

/** The rules a broken lifecycle is refused under. */
function brokenRules(change: (l: Lifecycle) => void): string[] {
  const l = testLifecycle();
  change(l);
  try {
    defineLifecycle(l);
  } catch (err) {
    expect(err).toBeInstanceOf(LifecycleInvalid);
    return (err as LifecycleInvalid).violations.map(v => v.rule);
  }
  return [];
}

describe('defineLifecycle', () => {
  it('accepts a lifecycle shaped like Shreni\'s', () => {
    const l = testLifecycle();
    expect(defineLifecycle(l)).toBe(l);
  });

  it.each<[string, (l: Lifecycle) => void, string]>([
    ['a missing hook', l => { delete (l.hooks as any).onClaim; }, 'shape'],
    ['an unknown call in permissions', l => { (l.permissions as any)['tasks.explode'] = { developer: true }; }, 'shape'],
    ['two claimable states', l => { l.states.waiting = { claimable: true }; }, 'one-claimable-state'],
    ['no leased state', l => { l.states.claimed = {}; }, 'one-leased-state'],
    ['no state that satisfies dependencies', l => { l.states.done = { terminal: true }; }, 'deps-satisfiable'],
    ['a terminal claimable state', l => { l.states.open = { claimable: true, terminal: true }; }, 'flags-consistent'],
    ['a move to an undeclared state', l => { move(l, 'park').to = 'shelved'; }, 'known-states'],
    ['a permission naming an undeclared state', l => { l.permissions['tasks.update']!.planner = ['drafted']; }, 'known-states'],
    ['a migrate target that is undeclared', l => { l.migrate = { parked: 'shelved' }; }, 'known-states'],
    ['two moves with one name', l => { l.moves.push({ ...move(l, 'park') }); }, 'unique-move-names'],
    ['a move out of a terminal state', l => { move(l, 'unpark').from = ['parked', 'done']; }, 'terminal-final'],
    ['a create state the approve move does not start from', l => { l.create.state = 'parked'; }, 'create-rules'],
    ['a byRole state that is neither create.state nor claimable', l => { l.create.byRole = { system: 'waiting' }; }, 'create-rules'],
    ['a hook naming no move', l => { l.hooks.onDiscard = 'shred'; }, 'hook-moves-exist'],
    ['an onClaim move that does not land leased', l => { move(l, 'claim').to = 'waiting'; }, 'claim-hook'],
    ['an onApprove move that does not land claimable', l => { move(l, 'approve').to = 'parked'; }, 'approve-hook'],
    ['an onDiscard move that does not land terminal', l => { l.hooks.onDiscard = 'park'; }, 'discard-hook'],
    ['an expiry move with a guard', l => { move(l, 'expire').guard = someGuard; }, 'expiry-hooks'],
    ['an expiry move system may not make', l => { move(l, 'expire').by = ['orchestrator']; }, 'expiry-hooks'],
    ['an expiry move that does not start leased', l => { move(l, 'expire').from = ['open']; }, 'expiry-hooks'],
    ['a repeated-expiry move with a guard', l => { move(l, 'flag').guard = someGuard; }, 'expiry-hooks'],
    ['a guard not made with defineGuard', l => { (move(l, 'submit') as any).guard = async () => true; }, 'guards-named'],
    ['a guarded onClaim move', l => { move(l, 'claim').guard = someGuard; }, 'claim-hook'],
    ['another move landing in the leased state', l => { move(l, 'unblock').to = 'claimed'; }, 'leased-by-claim'],
    ['an expiry move landing in the leased state', l => { move(l, 'expire').to = 'claimed'; }, 'leased-by-claim'],
    ['a leased create state', l => { l.create.state = 'claimed'; move(l, 'approve').from = ['claimed']; }, 'create-rules'],
    ['an onDiscard move that does not start from create.state', l => {
      l.moves.push({ name: 'abandon', from: ['open'], to: 'cancelled', by: ['developer'] });
      l.hooks.onDiscard = 'abandon';
    }, 'discard-hook'],
  ])('refuses %s', (_, change, rule) => {
    expect(brokenRules(change)).toContain(rule);
  });

  it('reports one rule, not a cascade, for one missing flag', () => {
    expect(brokenRules(l => { l.states.claimed = {}; })).toEqual(['one-leased-state']);
    expect(brokenRules(l => { l.states.open = {}; })).toEqual(['one-claimable-state']);
  });

  it('names the rule in the message', () => {
    const l = testLifecycle();
    move(l, 'expire').guard = someGuard;
    expect(() => defineLifecycle(l)).toThrow(/expiry-hooks.*guard/);
  });
});

describe('lifecycle hash', () => {
  it('covers guard names, not guard code, and ignores key order', () => {
    const a = testLifecycle();
    const b = testLifecycle();
    const finish = move(b, 'finish');
    finish.guard = defineGuard('checksPassed', async () => 'stricter now'); // same name, different code
    b.states = Object.fromEntries(Object.entries(b.states).reverse());
    expect(lifecycleHash(b)).toBe(lifecycleHash(a));
    expect(serializeLifecycle(a).moves.find(m => m.name === 'finish')?.guard).toBe('checksPassed');

    finish.guard = defineGuard('renamed', async () => true);
    expect(lifecycleHash(b)).not.toBe(lifecycleHash(a));
  });

  it('ignores the order of moves and of the states and roles they list', () => {
    const a = testLifecycle();
    const b = testLifecycle();
    b.moves.reverse();
    for (const m of b.moves) { m.from.reverse(); m.by.reverse(); }
    b.permissions['tasks.update']!.developer = ['parked', 'blocked', 'open', 'proposed'];
    expect(lifecycleHash(b)).toBe(lifecycleHash(a));
  });

  it('changes when a move changes', () => {
    const b = testLifecycle();
    move(b, 'park').from = ['proposed', 'open'];
    expect(lifecycleHash(b)).not.toBe(lifecycleHash(testLifecycle()));
  });
});

describe('registerLifecycle', { timeout: PGLITE_TIMEOUT }, () => {
  it('stores the definition by name and version with its hash, once', async () => {
    const t = await openDb();
    const l = testLifecycle();
    await registerLifecycle(t.db, l);
    await registerLifecycle(t.db, testLifecycle());
    const rows = (await t.pglite.query<{ name: string; version: number; hash: string; definition: any }>(
      `select name, version, hash, definition from taskgraph.lifecycles`,
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'test.task', version: 1, hash: lifecycleHash(l) });
    expect(rows[0].definition).toEqual(serializeLifecycle(l));
  });

  it('refuses a changed definition under the same version, and takes it under a new one', async () => {
    const t = await openDb();
    await registerLifecycle(t.db, testLifecycle());

    const changed = testLifecycle();
    move(changed, 'park').from = ['proposed', 'open'];
    const err = await registerLifecycle(t.db, changed).catch(e => e);
    expect(err).toBeInstanceOf(LifecycleInvalid);
    expect(err.violations.map((v: { rule: string }) => v.rule)).toEqual(['version-bumped']);

    changed.version = 2;
    await registerLifecycle(t.db, changed);
    expect((await t.pglite.query(`select version from taskgraph.lifecycles order by version`)).rows)
      .toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('checks the rules before storing anything', async () => {
    const t = await openDb();
    const l = testLifecycle();
    move(l, 'expire').guard = someGuard;
    await expect(registerLifecycle(t.db, l)).rejects.toBeInstanceOf(LifecycleInvalid);
    expect((await t.pglite.query(`select 1 from taskgraph.lifecycles`)).rows).toEqual([]);
  });
});
