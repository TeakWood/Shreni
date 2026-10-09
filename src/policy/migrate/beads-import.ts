import { randomUUID } from 'crypto';
import type { Lifecycle } from '../../taskgraph';
import { BUNDLE_FORMAT, type BundleEvent, type BundleTask, type ProjectBundle } from '../../taskgraph/bundle';
import { SHRENI_BUNDLE_FORMAT, type ShreniBundle } from '../db/bundle';
import { BEADS_INTERACTION_EVENT } from '../sthapathi/reads';
import type { ProjectMode } from '../init/project';

// The beads importer (migration plan, "The importer"): reads a beads export
// (issues.jsonl, and interactions.jsonl where the beads repo tracks it) and
// turns it into a Shreni project bundle, which importShreniProject loads in one
// transaction. Bead ids, states and times are kept; the engine never learns
// the beads format. The dry run checks the mapping before anything is written.

/** A line of issues.jsonl. */
export type BeadIssue = {
  _type?: 'issue';
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status: string;
  priority: number;
  issue_type: string;
  labels?: string[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  defer_until?: string;
  dependencies?: { issue_id: string; depends_on_id: string; type: string }[];
};
export type BeadMemory = { _type: 'memory'; key: string; value: string };
/** A line of interactions.jsonl: bd's record of a field change, a comment and the like. */
export type BeadInteraction = { id: string; kind: string; created_at: string; actor: string; issue_id?: string; extra?: Record<string, unknown> };

export type BeadsExport = { issues: BeadIssue[]; memories: BeadMemory[]; interactions: BeadInteraction[] };

/** Parses issues.jsonl, and interactions.jsonl when given; a bad line fails, naming it. */
export function parseBeadsExport(issuesJsonl: string, interactionsJsonl = ''): BeadsExport {
  const lines = (text: string, file: string) => text.split('\n').map((l, i) => [l.trim(), i + 1] as const).filter(([l]) => l)
    .map(([l, n]) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`${file} line ${n} isn't JSON: ${(err as Error).message}`);
      }
    });
  const out: BeadsExport = { issues: [], memories: [], interactions: [] };
  for (const r of lines(issuesJsonl, 'issues.jsonl')) {
    if (r._type === 'memory') out.memories.push(r as BeadMemory);
    else out.issues.push(r as unknown as BeadIssue);
  }
  out.interactions = lines(interactionsJsonl, 'interactions.jsonl') as unknown as BeadInteraction[];
  return out;
}

/** Labels that are states on the engine, not tags. */
const AWAITING_MERGE = 'awaiting-merge';
const FOLLOW_UP = 'pr-needs-followup';
/** A planning session's bead, which only Suthradhara's bd path used. */
const SESSION_TYPE = 'suthradhara-session';
/** Non-blocking references, by beads' name: the engine's link kind. */
const LINK_KINDS: Record<string, string> = { 'discovered-from': 'discovered-from', related: 'related', relates_to: 'related' };

/** Who wrote the history the import adds. */
const IMPORTER = { actor: 'beads-importer', actorRole: 'system' } as const;

/** The lifecycle state a bead lands in (migration plan, "States"). */
export function stateOf(b: BeadIssue): string {
  if (b.issue_type === SESSION_TYPE) return 'cancelled';
  const labels = b.labels ?? [];
  // A pending PR follow-up is work to do: open, and boosted, whatever else the bead says.
  if (labels.includes(FOLLOW_UP) && b.status !== 'closed' && b.status !== 'deferred') return 'open';
  switch (b.status) {
    case 'closed': return 'done';
    case 'open': return 'open';
    // An imported task has no live worker, and only a claimed task holds a lease.
    case 'in_progress': return labels.includes(AWAITING_MERGE) ? 'waiting' : 'open';
    case 'blocked': return 'blocked';
    case 'deferred': return 'parked';
    default: throw new Error(`bead ${b.id} has status ${JSON.stringify(b.status)}, which the importer doesn't know`);
  }
}

const date = (s: string | undefined | null) => (s ? new Date(s) : null);

/** The id prefix the beads' own ids use: a top-level id is `<prefix>-<short>`. */
export function beadsIdPrefix(issues: BeadIssue[]): string {
  const prefixes = new Set(issues.filter(b => !b.id.includes('.')).map(b => b.id.slice(0, b.id.lastIndexOf('-'))).filter(Boolean));
  if (prefixes.size !== 1) throw new Error(`the beads use ${prefixes.size ? [...prefixes].join(', ') : 'no'} id prefixes; the importer needs exactly one`);
  return [...prefixes][0];
}

export type ImportOptions = {
  name: string;
  mode: ProjectMode;
  lifecycle: Lifecycle;
  /** The project's uuid: the one the repo's config names, or a new one. */
  projectId?: string;
  repoUrl?: string;
  now?: Date;
};

export type Mapped = {
  bundle: ShreniBundle;
  /** What the mapping dropped or chose, each a line for the dry run. */
  notes: string[];
  /** Edges left out, by beads' edge type: missing ends, duplicates, waits on a session. */
  dropped: Record<string, number>;
};

/** Maps a beads export to a Shreni project bundle. */
export function beadsToBundle(src: BeadsExport, opts: ImportOptions): Mapped {
  const now = opts.now ?? new Date();
  const projectId = opts.projectId ?? randomUUID();
  const notes: string[] = [];
  const dropped: Record<string, number> = {};
  const drop = (type: string, line?: string) => {
    dropped[type] = (dropped[type] ?? 0) + 1;
    if (line) notes.push(line);
  };
  const ids = new Set(src.issues.map(b => b.id));
  const sessions = new Set(src.issues.filter(b => b.issue_type === SESSION_TYPE).map(b => b.id));
  const edges = src.issues.flatMap(b => (b.dependencies ?? []).map(d => ({ ...d, issue_id: d.issue_id ?? b.id })));
  const known = (e: { issue_id: string; depends_on_id: string; type: string }) => {
    if (ids.has(e.issue_id) && ids.has(e.depends_on_id)) return true;
    drop(e.type, `dropped a ${e.type} edge ${e.issue_id} -> ${e.depends_on_id}: ${ids.has(e.issue_id) ? e.depends_on_id : e.issue_id} isn't in the export`);
    return false;
  };

  const parent = new Map<string, string>();
  for (const e of edges.filter(e => e.type === 'parent-child')) {
    if (!known(e)) continue;
    const had = parent.get(e.issue_id);
    if (had) drop(e.type, had === e.depends_on_id ? undefined : `${e.issue_id} has two parents, ${had} and ${e.depends_on_id}; kept ${had}`);
    else parent.set(e.issue_id, e.depends_on_id);
  }
  const hasChildren = new Set(parent.values());

  const tasks: BundleTask[] = src.issues.map(b => {
    const labels = b.labels ?? [];
    const spec: Record<string, unknown> = {};
    if (b.acceptance_criteria) spec.acceptanceCriteria = b.acceptance_criteria;
    if (b.design) spec.design = b.design;
    return {
      id: b.id, key: null, planId: null, parentId: parent.get(b.id) ?? null,
      // Today's rule: a parent is never worked.
      kind: b.issue_type === 'epic' || hasChildren.has(b.id) ? 'container' : 'work',
      category: b.issue_type ?? null,
      title: b.title, description: b.description || null, priority: b.priority ?? 2,
      state: stateOf(b), origin: 'imported', spec,
      tags: labels.filter(l => l !== AWAITING_MERGE && l !== FOLLOW_UP),
      boosted: labels.includes(FOLLOW_UP) && b.status !== 'closed',
      holdUntil: date(b.defer_until), nextChild: 1,
      leaseAttemptId: null, leaseExpiresAt: null,
      createdAt: new Date(b.created_at), updatedAt: new Date(b.updated_at ?? b.created_at), closedAt: date(b.closed_at),
    };
  });

  const deps = new Map<string, { taskId: string; dependsOnId: string }>();
  for (const e of edges.filter(e => e.type === 'blocks')) {
    if (!known(e)) continue;
    const key = `${e.issue_id} ${e.depends_on_id}`;
    // A planning session's bead is cancelled, and never meant work to wait on.
    if (sessions.has(e.depends_on_id) && !sessions.has(e.issue_id)) drop(e.type, `dropped ${e.issue_id}'s wait on ${e.depends_on_id}, a planning session`);
    else if (deps.has(key)) drop(e.type);
    else deps.set(key, { taskId: e.issue_id, dependsOnId: e.depends_on_id });
  }
  const links = new Map<string, { a: string; b: string; kind: string }>();
  for (const e of edges.filter(e => LINK_KINDS[e.type])) {
    if (!known(e)) continue;
    const key = `${e.issue_id} ${LINK_KINDS[e.type]} ${e.depends_on_id}`;
    if (links.has(key)) drop(e.type);
    else links.set(key, { a: e.issue_id, b: e.depends_on_id, kind: LINK_KINDS[e.type] });
  }
  for (const e of edges) {
    if (e.type !== 'parent-child' && e.type !== 'blocks' && !LINK_KINDS[e.type]) drop(e.type, `dropped a ${e.type} edge ${e.issue_id} -> ${e.depends_on_id}: an edge type the engine has no place for`);
  }

  // History: notes, then the move that closed each task, then bd's interactions, oldest first.
  const event = (e: Partial<BundleEvent> & Pick<BundleEvent, 'kind' | 'at' | 'payload'>): BundleEvent => ({
    taskId: null, planId: null, attemptId: null, fromState: null, toState: null, requestId: null, ...IMPORTER, ...e,
  });
  const events: BundleEvent[] = [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const b of src.issues) {
    const t = byId.get(b.id)!;
    if (b.notes) events.push(event({ taskId: b.id, kind: 'note', payload: { text: b.notes }, at: t.updatedAt }));
    if (t.state === 'done' || t.state === 'cancelled') {
      events.push(event({
        taskId: b.id, kind: t.state === 'done' ? (t.kind === 'container' ? 'move:completeContainer' : 'move:finish') : 'move:cancel',
        fromState: 'open', toState: t.state, payload: b.close_reason ? { reason: b.close_reason } : {}, at: t.closedAt ?? t.updatedAt,
      }));
    }
  }
  for (const i of src.interactions) {
    if (i.issue_id && !ids.has(i.issue_id)) {
      notes.push(`dropped interaction ${i.id}: ${i.issue_id} isn't in the export`);
      continue;
    }
    events.push(event({
      taskId: i.issue_id ?? null, kind: BEADS_INTERACTION_EVENT, actor: i.actor || IMPORTER.actor,
      payload: { id: i.id, kind: i.kind, ...(i.extra ?? {}) }, at: new Date(i.created_at),
    }));
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const engine: ProjectBundle = {
    format: BUNDLE_FORMAT, version: 1,
    project: {
      id: projectId, name: opts.name, idPrefix: beadsIdPrefix(src.issues),
      lifecycleName: opts.lifecycle.name, lifecycleVersion: opts.lifecycle.version,
      createdAt: new Date(Math.min(...tasks.map(t => t.createdAt.getTime()), now.getTime())),
    },
    plans: [], tasks, deps: [...deps.values()], links: [...links.values()], attempts: [], events,
  };
  const stamp = now.toISOString();
  return {
    notes,
    dropped,
    bundle: {
      format: SHRENI_BUNDLE_FORMAT, version: 1, engine,
      shreni: {
        projects: [{ project_id: projectId, mode: opts.mode, repo_url: opts.repoUrl ?? null, team: null, created_at: stamp }],
        intents: [], acceptance_checks: [], attempt_evidence: [],
        memories: src.memories.map(m => ({ project_id: projectId, key: m.key, content: m.value, created_at: stamp, updated_at: stamp })),
      },
    },
  };
}

// ── The dry run ───────────────────────────────────────────────────────────────

const closed = (b: BeadIssue | undefined) => b?.status === 'closed';

/** What `bd ready` lists: open, not deferred to later, and neither it nor any parent above it waiting on an open blocker. */
export function bdReady(issues: BeadIssue[], now: Date): string[] {
  const byId = new Map(issues.map(b => [b.id, b]));
  const parentOf = (b: BeadIssue) => (b.dependencies ?? []).find(d => d.type === 'parent-child')?.depends_on_id;
  const waits = (b: BeadIssue) =>
    (b.dependencies ?? []).some(d => d.type === 'blocks' && byId.has(d.depends_on_id) && !closed(byId.get(d.depends_on_id)));
  const blocked = (b: BeadIssue): boolean => {
    for (let x: BeadIssue | undefined = b, n = 0; x && n < 1000; x = byId.get(parentOf(x) ?? ''), n++) if (waits(x)) return true;
    return false;
  };
  return issues.filter(b => b.status === 'open' && !(b.defer_until && new Date(b.defer_until) > now) && !blocked(b))
    .map(b => b.id).sort();
}

/** What a worker on beads hands out: bd ready, less epics, planning sessions and any parent with open children (Sthapathi's pickup). */
export function beadsHandOut(issues: BeadIssue[], now: Date): string[] {
  const openChildren = new Set(issues.flatMap(b => (b.dependencies ?? [])
    .filter(d => d.type === 'parent-child' && !closed(b)).map(d => d.depends_on_id)));
  const byId = new Map(issues.map(b => [b.id, b]));
  return bdReady(issues, now).filter(id => !['epic', SESSION_TYPE].includes(byId.get(id)!.issue_type) && !openChildren.has(id));
}

/** The engine's ready predicate (taskgraph/ready.ts) over a bundle: what a claim may pick after the import. */
export function engineReady(b: ProjectBundle, lifecycle: Lifecycle, now: Date): string[] {
  const claimable = Object.keys(lifecycle.states).find(s => lifecycle.states[s].claimable)!;
  const satisfies = (s: string) => !!lifecycle.states[s]?.satisfiesDeps;
  const byId = new Map(b.tasks.map(t => [t.id, t]));
  const waits = new Map<string, string[]>();
  for (const d of b.deps) waits.set(d.taskId, [...(waits.get(d.taskId) ?? []), d.dependsOnId]);
  const depsSatisfied = (t: BundleTask) => (waits.get(t.id) ?? []).every(d => satisfies(byId.get(d)!.state));
  // Every container above claimable, with its own dependencies satisfied.
  const aboveAllClaimable = (t: BundleTask) => {
    for (let p = t.parentId; p; p = byId.get(p)!.parentId) {
      if (byId.get(p)!.state !== claimable || !depsSatisfied(byId.get(p)!)) return false;
    }
    return true;
  };
  return b.tasks.filter(t => t.state === claimable && t.kind === 'work'
    && !(t.holdUntil && new Date(t.holdUntil) > now)
    && depsSatisfied(t) && aboveAllClaimable(t))
    .map(t => t.id).sort();
}

/** Every dependency cycle, each as the ids around it. */
export function findCycles(deps: { taskId: string; dependsOnId: string }[]): string[][] {
  const out = new Map<string, string[]>();
  for (const d of deps) out.set(d.taskId, [...(out.get(d.taskId) ?? []), d.dependsOnId]);
  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    path.push(n);
    for (const m of out.get(n) ?? []) {
      if (state.get(m) === 1) cycles.push(path.slice(path.indexOf(m)));
      else if (!state.has(m)) visit(m);
    }
    path.pop();
    state.set(n, 2);
  };
  for (const n of [...out.keys()].sort()) if (!state.has(n)) visit(n);
  return cycles;
}

const tally = <T>(items: T[], key: (x: T) => string) =>
  items.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});

export type DryRun = {
  ok: boolean;
  counts: {
    beads: { issues: number; byStatus: Record<string, number>; epics: number; memories: number; interactions: number; edges: Record<string, number> };
    engine: { tasks: number; byState: Record<string, number>; containers: number; memories: number; events: number; parents: number; deps: number; links: number };
  };
  /** Count checks that failed, each a line. */
  mismatches: string[];
  cycles: string[][];
  ready: {
    beads: string[];
    engine: string[];
    /** On beads' list, held back on the engine by a parked container above them: the one expected difference. */
    heldByParkedEpic: { id: string; epic: string }[];
    /** In progress on beads, open again on the engine with no worker: an expected difference. */
    reopened: string[];
    /** A parent whose children are all done: beads would work it, the engine completes it. An expected difference. */
    nowContainers: string[];
    onlyBeads: string[];
    onlyEngine: string[];
  };
  notes: string[];
};

/**
 * Maps everything and checks it: counts by state, kind and edge type; no
 * dependency cycles; and the same ready set as beads, apart from the tasks a
 * parked epic holds back, which it lists.
 */
export function dryRun(src: BeadsExport, opts: ImportOptions): DryRun & { mapped: Mapped } {
  const now = opts.now ?? new Date();
  const mapped = beadsToBundle(src, { ...opts, now });
  const b = mapped.bundle.engine;
  const edges = src.issues.flatMap(i => i.dependencies ?? []);
  const counts: DryRun['counts'] = {
    beads: {
      issues: src.issues.length, byStatus: tally(src.issues, i => i.status), epics: src.issues.filter(i => i.issue_type === 'epic').length,
      memories: src.memories.length, interactions: src.interactions.length, edges: tally(edges, e => e.type),
    },
    engine: {
      tasks: b.tasks.length, byState: tally(b.tasks, t => t.state), containers: b.tasks.filter(t => t.kind === 'container').length,
      memories: mapped.bundle.shreni.memories.length, events: b.events.length,
      parents: b.tasks.filter(t => t.parentId).length, deps: b.deps.length, links: b.links.length,
    },
  };
  const mismatches: string[] = [];
  const expect = (what: string, beads: number, engine: number) => {
    if (beads !== engine) mismatches.push(`${what}: ${beads} in beads, ${engine} on the engine`);
  };
  expect('tasks', counts.beads.issues, counts.engine.tasks);
  expect('memories', counts.beads.memories, counts.engine.memories);
  for (const [state, n] of Object.entries(tally(src.issues, i => stateOf(i)))) expect(`tasks ${state}`, n, counts.engine.byState[state] ?? 0);
  // Edges the mapping left out, and said why, aren't missing.
  const kept = (type: string) => (counts.beads.edges[type] ?? 0) - (mapped.dropped[type] ?? 0);
  expect('parent-child edges', kept('parent-child'), counts.engine.parents);
  expect('blocks edges', kept('blocks'), counts.engine.deps);
  expect('link edges', Object.keys(LINK_KINDS).reduce((n, k) => n + kept(k), 0), counts.engine.links);
  if (counts.engine.containers < counts.beads.epics) mismatches.push(`containers: ${counts.engine.containers}, fewer than the ${counts.beads.epics} epics`);

  // What the engine's import refuses, said here with what to fix in beads first.
  const flags = (state: string) => opts.lifecycle.states[state] ?? {};
  const tasksById = new Map(b.tasks.map(t => [t.id, t]));
  for (const t of b.tasks) {
    const p = t.parentId ? tasksById.get(t.parentId)! : null;
    if (p && flags(p.state).terminal && !flags(t.state).terminal) {
      mismatches.push(`${p.id} is closed with a live child, ${t.id} (${t.state}); close or move ${t.id} in beads first`);
    }
  }
  for (const d of b.deps) {
    const [t, on] = [tasksById.get(d.taskId)!, tasksById.get(d.dependsOnId)!];
    if (!flags(t.state).terminal && flags(on.state).terminal && !flags(on.state).satisfiesDeps) {
      mismatches.push(`${t.id} waits on ${on.id}, which is ${on.state} and never finishes; remove the dependency in beads first`);
    }
    for (const [x, y] of [[t, on], [on, t]]) {
      for (let p = x.parentId; p; p = tasksById.get(p)!.parentId) {
        if (p === y.id) mismatches.push(`${d.taskId} waits on ${d.dependsOnId}, and one contains the other, so neither ever settles; remove the dependency in beads first`);
      }
    }
  }

  const beadsList = beadsHandOut(src.issues, now);
  const engineList = engineReady(b, opts.lifecycle, now);
  const byId = new Map(b.tasks.map(t => [t.id, t]));
  const parkedAbove = (id: string) => {
    for (let p = byId.get(id)?.parentId; p; p = byId.get(p)!.parentId) if (byId.get(p)!.state === 'parked') return p;
    return null;
  };
  const inProgress = new Set(src.issues.filter(i => i.status === 'in_progress').map(i => i.id));
  const container = (id: string) => byId.get(id)?.kind === 'container';
  const onlyBeads = beadsList.filter(id => !engineList.includes(id));
  const onlyEngine = engineList.filter(id => !beadsList.includes(id));
  const ready: DryRun['ready'] = {
    beads: beadsList, engine: engineList,
    heldByParkedEpic: onlyBeads.filter(id => parkedAbove(id)).map(id => ({ id, epic: parkedAbove(id)! })),
    reopened: onlyEngine.filter(id => inProgress.has(id)),
    nowContainers: onlyBeads.filter(id => !parkedAbove(id) && container(id)),
    onlyBeads: onlyBeads.filter(id => !parkedAbove(id) && !container(id)),
    onlyEngine: onlyEngine.filter(id => !inProgress.has(id)),
  };
  // An imported hold outlasts an unpark, so the person sees each one before confirming.
  const held = b.tasks.filter(t => t.state === 'parked' && t.holdUntil && t.holdUntil > now);
  if (held.length) {
    mapped.notes.push(`${held.length} parked task${held.length > 1 ? 's keep their' : ' keeps its'} beads defer date as a hold, which outlasts an unpark: ${held.map(t => `${t.id} (${t.holdUntil!.toISOString().slice(0, 10)})`).join(', ')}`);
  }
  const cycles = findCycles(b.deps);
  return {
    ok: !mismatches.length && !cycles.length && !ready.onlyBeads.length && !ready.onlyEngine.length,
    counts, mismatches, cycles, ready, notes: mapped.notes, mapped,
  };
}

/** The dry run as lines for a person to read before confirming. */
export function renderDryRun(r: DryRun): string[] {
  const kv = (o: Record<string, number>) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join(', ');
  const out = [
    `beads: ${r.counts.beads.issues} issues (${kv(r.counts.beads.byStatus)}), ${r.counts.beads.epics} epics, ${r.counts.beads.memories} memories, ${r.counts.beads.interactions} interactions`,
    `  edges: ${kv(r.counts.beads.edges)}`,
    `engine: ${r.counts.engine.tasks} tasks (${kv(r.counts.engine.byState)}), ${r.counts.engine.containers} containers, ${r.counts.engine.memories} memories, ${r.counts.engine.events} events`,
    `  parents ${r.counts.engine.parents}, dependencies ${r.counts.engine.deps}, links ${r.counts.engine.links}`,
    `ready: ${r.ready.engine.length} on the engine, ${r.ready.beads.length} on beads`,
    ...r.ready.heldByParkedEpic.map(h => `  held by parked epic ${h.epic}: ${h.id}`),
    ...r.ready.reopened.map(id => `  in progress on beads, open again on the engine: ${id}`),
    ...r.ready.nowContainers.map(id => `  every child done: the engine completes ${id} rather than working it`),
    ...r.ready.onlyBeads.map(id => `  ✗ ready on beads only: ${id}`),
    ...r.ready.onlyEngine.map(id => `  ✗ ready on the engine only: ${id}`),
    ...r.mismatches.map(m => `✗ ${m}`),
    ...r.cycles.map(c => `✗ dependency cycle: ${[...c, c[0]].join(' -> ')}`),
    ...r.notes.map(n => `  note: ${n}`),
  ];
  out.push(r.ok ? '✓ the dry run checks pass' : '✗ the dry run found problems; nothing was imported');
  return out;
}
