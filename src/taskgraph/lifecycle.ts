import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { LifecycleInvalid, type LifecycleViolation } from './errors';
import type { Actor, Task } from './types';
import { runTransaction } from './tx';

// The lifecycle the caller declares (engine spec, "Task lifecycle" and
// "Versions and upgrades"): states, where new tasks land, the moves between
// states and who may make them, permissions for the calls that aren't moves,
// and the hooks the engine fires. The engine stores it as data and refuses
// anything it doesn't declare.

export type StateFlags = { claimable?: true; leased?: true; satisfiesDeps?: true; terminal?: true };

/** Runs inside the move's transaction, after the task row is locked; true allows the move, a string refuses it. */
export type GuardFn = (ctx: { task: Task; actor: Actor; tx: Transaction<any> }) => Promise<true | string>;

/** A guard with the name the lifecycle's hash records. */
export type Guard = GuardFn & { readonly guardName: string };

/**
 * Names a guard. The name, not the code, goes into the lifecycle's hash; a
 * function's own name isn't used, since an inline guard takes its property's
 * name and a bundler may rename one.
 */
export function defineGuard(name: string, fn: GuardFn): Guard {
  if (!name) throw new TypeError('a guard needs a name');
  const guard: GuardFn = ctx => fn(ctx);
  return Object.defineProperty(guard, 'guardName', { value: name, enumerable: true }) as Guard;
}

export type Move = {
  name: string;
  /** States the move may start from. */
  from: string[];
  /** The state it lands in. */
  to: string;
  /** Roles that may make it. */
  by: string[];
  guard?: Guard;
  /** Put the task ahead of all unboosted work. */
  boost?: true;
  /** Take it out of the boosted lane. */
  clearsBoost?: true;
};

export const CALLS = [
  'tasks.create', 'tasks.update', 'tasks.delete', 'deps.add', 'deps.remove',
  'links.add', 'notes.add', 'plans.create', 'plans.validate', 'lifecycles.activate',
] as const;
export type Call = (typeof CALLS)[number];

export type Lifecycle = {
  /** e.g. 'shreni.task'. */
  name: string;
  /** Bump on every change. */
  version: number;
  states: Record<string, StateFlags>;
  /** Where new tasks land, by the creator's role. */
  create: { state: string; byRole?: Record<string, string> };
  moves: Move[];
  /** Role -> any state (true), or the states the task must be in. A call not listed is refused for every role. */
  permissions: Partial<Record<Call, Record<string, true | string[]>>>;
  hooks: {
    /** Fired by plans.approve and tasks.approve, as the approver. */
    onApprove: string;
    /** Fired by claim, as the claimer. */
    onClaim: string;
    /** Fired by plans.discard on each proposed task, as the discarder. */
    onDiscard: string;
    /** Fired when a lease lapses, as system. */
    onLeaseExpiry: string;
    /** Fired instead, on the after-th expiry in a row, as system. */
    onRepeatedExpiry?: { after: number; move: string };
  };
  /** On upgrade: where tasks in a removed or renamed state go. */
  migrate?: Record<string, string>;
};

/** The role the expiry hooks act as; the only role the engine names. */
export const SYSTEM_ROLE = 'system';

const name = z.string().min(1);
const LifecycleSchema = z.strictObject({
  name,
  version: z.number().int().positive(),
  states: z.record(name, z.strictObject({
    claimable: z.literal(true).optional(),
    leased: z.literal(true).optional(),
    satisfiesDeps: z.literal(true).optional(),
    terminal: z.literal(true).optional(),
  })),
  create: z.strictObject({ state: name, byRole: z.record(name, name).optional() }),
  moves: z.array(z.strictObject({
    name,
    from: z.array(name).min(1),
    to: name,
    by: z.array(name).min(1),
    guard: z.custom<Guard>(v => typeof v === 'function', 'a guard is a function').optional(),
    boost: z.literal(true).optional(),
    clearsBoost: z.literal(true).optional(),
  })),
  permissions: z.partialRecord(z.enum(CALLS), z.record(name, z.union([z.literal(true), z.array(name)]))),
  hooks: z.strictObject({
    onApprove: name,
    onClaim: name,
    onDiscard: name,
    onLeaseExpiry: name,
    onRepeatedExpiry: z.strictObject({ after: z.number().int().positive(), move: name }).optional(),
  }),
  migrate: z.record(name, name).optional(),
});

/** The rules every lifecycle must meet; an empty list means it may register. */
export function lifecycleViolations(def: Lifecycle): LifecycleViolation[] {
  const parsed = LifecycleSchema.safeParse(def);
  if (!parsed.success) {
    return parsed.error.issues.map(i => ({ rule: 'shape', message: `${i.path.join('.') || '(root)'}: ${i.message}` }));
  }
  const out: LifecycleViolation[] = [];
  const fail = (rule: string, message: string) => out.push({ rule, message });
  const states = Object.entries(def.states);
  const flagged = (flag: keyof StateFlags) => states.filter(([, f]) => f[flag]).map(([s]) => s);
  const isState = (s: string) => Object.hasOwn(def.states, s);

  const claimable = flagged('claimable');
  const leased = flagged('leased');
  if (claimable.length !== 1) fail('one-claimable-state', `exactly one state must be claimable, found ${claimable.length}`);
  if (leased.length !== 1) fail('one-leased-state', `exactly one state must be leased, found ${leased.length}`);
  if (flagged('satisfiesDeps').length === 0) fail('deps-satisfiable', 'at least one state must satisfy dependencies');
  for (const [s, f] of states) {
    if (f.claimable && f.leased) fail('flags-consistent', `state ${s} can't be both claimable and leased`);
    if (f.terminal && (f.claimable || f.leased)) fail('flags-consistent', `terminal state ${s} can't be claimable or leased`);
  }

  const unknown = (where: string, s: string) => {
    if (!isState(s)) fail('known-states', `${where} names undeclared state ${s}`);
  };
  unknown('create.state', def.create.state);
  for (const [role, s] of Object.entries(def.create.byRole ?? {})) unknown(`create.byRole.${role}`, s);
  for (const m of def.moves) {
    for (const s of m.from) unknown(`move ${m.name}`, s);
    unknown(`move ${m.name}`, m.to);
  }
  for (const [call, roles] of Object.entries(def.permissions)) {
    for (const [role, allowed] of Object.entries(roles ?? {})) {
      if (allowed !== true) for (const s of allowed) unknown(`permissions.${call}.${role}`, s);
    }
  }
  for (const [from, to] of Object.entries(def.migrate ?? {})) unknown(`migrate.${from}`, to);

  const moves = new Map<string, Move>();
  for (const m of def.moves) {
    if (moves.has(m.name)) fail('unique-move-names', `two moves are named ${m.name}`);
    moves.set(m.name, m);
    for (const s of m.from) {
      if (def.states[s]?.terminal) fail('terminal-final', `move ${m.name} leaves terminal state ${s}`);
    }
    if (m.guard && !(typeof m.guard.guardName === 'string' && m.guard.guardName)) {
      fail('guards-named', `move ${m.name} has a guard not made with defineGuard; the hash records guard names`);
    }
  }

  const hook = (label: string, moveName: string): Move | undefined => {
    const m = moves.get(moveName);
    if (!m) fail('hook-moves-exist', `${label} names move ${moveName}, which isn't declared`);
    return m;
  };
  // Checks that need the claimable or the leased state run only when it is
  // unique, so one missing flag reports one rule, not a cascade.
  const claimableState = claimable.length === 1 ? claimable[0] : undefined;
  const leasedState = leased.length === 1 ? leased[0] : undefined;

  const approve = hook('onApprove', def.hooks.onApprove);
  if (approve && claimableState && approve.to !== claimableState) {
    fail('approve-hook', `onApprove move ${approve.name} must land in the claimable state`);
  }
  if (approve && !approve.from.includes(def.create.state)) {
    fail('create-rules', `create.state ${def.create.state} must be a state the onApprove move ${approve.name} starts from`);
  }
  if (claimableState) {
    for (const [role, s] of Object.entries(def.create.byRole ?? {})) {
      if (s !== def.create.state && s !== claimableState) {
        fail('create-rules', `create.byRole.${role} may name only create.state or the claimable state, not ${s}`);
      }
    }
  }
  if (def.create.state === leasedState) fail('create-rules', `create.state can't be the leased state ${leasedState}`);

  // The claim is one SKIP LOCKED update: it can't run a guard, and it is the
  // only way into the leased state, so every leased task has a lease.
  const claim = hook('onClaim', def.hooks.onClaim);
  if (claim && claimableState && leasedState && (!claim.from.includes(claimableState) || claim.to !== leasedState)) {
    fail('claim-hook', `onClaim move ${claim.name} must go from the claimable state to the leased one`);
  }
  if (claim?.guard) fail('claim-hook', `onClaim move ${claim.name} can't have a guard: the claim is one SKIP LOCKED update`);
  if (leasedState) {
    for (const m of def.moves) {
      if (m.to === leasedState && m.name !== def.hooks.onClaim) {
        fail('leased-by-claim', `move ${m.name} lands in the leased state ${leasedState}; only the onClaim move may`);
      }
    }
  }

  const discard = hook('onDiscard', def.hooks.onDiscard);
  if (discard && !def.states[discard.to]?.terminal) fail('discard-hook', `onDiscard move ${discard.name} must land in a terminal state`);
  if (discard && !discard.from.includes(def.create.state)) {
    fail('discard-hook', `onDiscard move ${discard.name} must start from create.state ${def.create.state}`);
  }

  // The sweep applies expiry moves to many tasks in one statement, as system,
  // so it can't run a guard.
  const expiries: [string, string][] = [['onLeaseExpiry', def.hooks.onLeaseExpiry]];
  if (def.hooks.onRepeatedExpiry) expiries.push(['onRepeatedExpiry', def.hooks.onRepeatedExpiry.move]);
  for (const [label, moveName] of expiries) {
    const m = hook(label, moveName);
    if (!m) continue;
    if (leasedState && !m.from.includes(leasedState)) fail('expiry-hooks', `${label} move ${m.name} must start from the leased state`);
    if (!m.by.includes(SYSTEM_ROLE)) fail('expiry-hooks', `${label} move ${m.name} must list ${SYSTEM_ROLE} in by`);
    if (m.guard) fail('expiry-hooks', `${label} move ${m.name} can't have a guard: the sweep applies it to many tasks in one statement`);
  }
  return out;
}

/** Checks a lifecycle against every registration rule; returns it unchanged, or throws LifecycleInvalid. */
export function defineLifecycle(def: Lifecycle): Lifecycle {
  const violations = lifecycleViolations(def);
  if (violations.length) throw new LifecycleInvalid(`${def?.name}@${def?.version}`, violations);
  return def;
}

/** The stored form: the definition as JSON, with each guard replaced by its name. */
export type StoredMove = Omit<Move, 'guard'> & { guard?: string };
export type StoredLifecycle = Omit<Lifecycle, 'moves'> & { moves: StoredMove[] };

export function serializeLifecycle(def: Lifecycle): StoredLifecycle {
  return {
    ...def,
    moves: def.moves.map(({ guard, ...m }) => (guard ? { ...m, guard: guard.guardName } : m)),
  };
}

/** JSON with object keys sorted at every level, so the hash ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * sha256 of the stored form. It covers guard names, not their code, and
 * ignores order where order means nothing: moves, and the states and roles a
 * move or permission lists.
 */
export function lifecycleHash(def: Lifecycle): string {
  const stored = serializeLifecycle(def);
  const normal = {
    ...stored,
    moves: stored.moves
      .map(m => ({ ...m, from: sorted(m.from), by: sorted(m.by) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    permissions: Object.fromEntries(Object.entries(stored.permissions).map(([call, roles]) => [
      call,
      Object.fromEntries(Object.entries(roles ?? {}).map(([role, a]) => [role, a === true ? true : sorted(a)])),
    ])),
  };
  return createHash('sha256').update(canonical(normal)).digest('hex');
}

/**
 * Stores a lifecycle version, after checking every rule. Registering the same
 * definition again does nothing; a changed definition under a version already
 * stored is refused. Registering doesn't make a version active.
 */
export async function registerLifecycle(db: Kysely<any>, def: Lifecycle): Promise<void> {
  defineLifecycle(def);
  const hash = lifecycleHash(def);
  const storedHash = await runTransaction(db, async ({ db: tx }) => {
    await sql`
      insert into taskgraph.lifecycles (name, version, definition, hash)
      values (${def.name}, ${def.version}, cast(${JSON.stringify(serializeLifecycle(def))} as jsonb), ${hash})
      on conflict (name, version) do nothing`.execute(tx);
    const stored = await sql<{ hash: string }>`
      select hash from taskgraph.lifecycles where name = ${def.name} and version = ${def.version}`.execute(tx);
    return stored.rows[0].hash;
  });
  if (storedHash !== hash) {
    throw new LifecycleInvalid(`${def.name}@${def.version}`, [{
      rule: 'version-bumped',
      message: `version ${def.version} is already registered with a different definition; bump the version`,
    }]);
  }
}
