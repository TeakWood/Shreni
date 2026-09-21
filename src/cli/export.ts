import { writeFileSync } from 'fs';
import type { CommandContext } from './registry';
import { loadRegistry } from '../kshetra/registry';
import { bd } from '../sthapathi/beads';
import type { KshetraConfig } from '../kshetra/config';

// `shreni export --kshetra <id> [--epic <id>] --format md --out <file>` (epic
// Shreni-beads-3nx / Study C1): the frozen bead graph as a single DETERMINISTIC
// markdown file — what E3's BARE arm receives, and a hand-off artefact for a
// contractor or another tool. C1.1 delivers the core: read the beads, scope to an
// epic's subtree, order them topologically (deterministic tie-break), and render.
// C1.2 layers the executed-bead guard and snapshot provenance on top; C1.3 adds
// --with-context. The writer sits behind a small ExportFormat interface (point 7)
// so json/other formats are additive later without touching the core.

// ── the data model ───────────────────────────────────────────────────────────

// One bead, reduced to exactly the fields the export renders plus the ones the
// C1.2 guard inspects (closeReason/notes/closedAt). Parsed defensively from
// `bd list --json`; absent fields collapse to '' / [] so rendering never throws.
export interface ExportBead {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  design: string;
  priority: number;
  status: string;
  type: string; // bd's issue_type
  labels: string[];
  parent: string | null;
  // Ids this bead is BLOCKED BY (the 'blocks' dependency edges). These are the
  // execution-ordering edges: a blocker must be listed before the bead it blocks.
  // The 'parent-child' edges are structural (subtree membership), never ordering.
  dependsOn: string[];
  // Execution artefacts — populated so the C1.2 guard can reject a leaked export
  // without re-parsing. C1.1 does not render them.
  closeReason: string;
  notes: string;
  closedAt: string;
}

// The assembled, ordered document a format renders. Pure data — no IO, no bd.
export interface ExportDocument {
  goal: string; // the epic title, or a generic heading for a whole-queue export
  epicId: string | null;
  beads: ExportBead[]; // in a valid topological execution order
  edges: { from: string; to: string }[]; // blocker -> blocked, both in scope
}

// The seam that keeps json/other formats additive (C1.1 point 7): the core builds
// one ExportDocument; a format turns it into bytes. Only markdown exists today.
export interface ExportFormat {
  render(doc: ExportDocument): string;
}

// ── parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// bd validates priority as 0–4 and always emits it, so this default is defensive
// only. It is the LOWEST tier (backlog) on purpose: a malformed bead with no
// priority must sort LAST in the tie-break, never ahead of a genuine P0.
const DEFAULT_PRIORITY = 4;

// Parse `bd list --json` (all statuses) into ExportBeads. Order-insensitive: the
// caller re-orders topologically, so the parse just needs to be total and
// deterministic per input. A row missing id/title is skipped rather than throwing.
export function parseBeads(listJson: string): ExportBead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const beads: ExportBead[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    // 'blocks' dependencies where THIS bead is the blocked side → its blockers.
    // Ignore 'parent-child' (subtree structure) and any edge whose issue_id is
    // not this bead (bd only lists this bead's own edges, but stay defensive).
    const dependsOn: string[] = [];
    if (Array.isArray(r.dependencies)) {
      for (const dep of r.dependencies) {
        if (typeof dep !== 'object' || dep === null) continue;
        const d = dep as Record<string, unknown>;
        if (d.type === 'blocks' && str(d.issue_id) === id && str(d.depends_on_id)) {
          dependsOn.push(str(d.depends_on_id));
        }
      }
    }
    const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string') : [];
    beads.push({
      id,
      title: str(r.title),
      description: str(r.description).trim(),
      acceptanceCriteria: str(r.acceptance_criteria).trim(),
      design: str(r.design).trim(),
      priority: typeof r.priority === 'number' ? r.priority : DEFAULT_PRIORITY,
      status: str(r.status) || 'unknown',
      type: str(r.issue_type) || str(r.type) || 'task',
      labels,
      parent: str(r.parent) || null,
      dependsOn,
      closeReason: str(r.close_reason).trim(),
      notes: str(r.notes).trim(),
      closedAt: str(r.closed_at),
    });
  }
  return beads;
}

// ── scope ────────────────────────────────────────────────────────────────────

// The epic's subtree (the epic + every descendant), walked over the `parent`
// pointers bd records — the same relation `bd children` exposes, computed here as
// a pure function over the already-loaded bead set so scoping costs no extra bd
// calls and is directly testable. Beads a backfill files later carry unrelated
// ids and are simply absent from this snapshot, so they never enter scope.
export function collectSubtreeIds(beads: ExportBead[], epicId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const b of beads) {
    if (b.parent) {
      const list = childrenOf.get(b.parent) ?? [];
      list.push(b.id);
      childrenOf.set(b.parent, list);
    }
  }
  const scope = new Set<string>([epicId]);
  const queue = [epicId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent) ?? []) {
      if (!scope.has(child)) {
        scope.add(child);
        queue.push(child);
      }
    }
  }
  return scope;
}

// ── topological order ────────────────────────────────────────────────────────

export class ExportCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`dependency cycle: ${cycle.join(' -> ')}`);
    this.name = 'ExportCycleError';
  }
}

// Kahn's algorithm with a DETERMINISTIC tie-break: among all nodes whose blockers
// are already emitted, pick the lowest priority number (P0 first), breaking
// further ties by id (lexicographic). Same graph -> same order, every run — the
// property the headline byte-identical test rests on. A cycle (which a well-formed
// bead graph never has) stalls Kahn's with nodes remaining; we then name one cycle
// rather than emit an arbitrary partial order.
export function topoOrder(beads: ExportBead[], edges: { from: string; to: string }[]): ExportBead[] {
  const byId = new Map(beads.map(b => [b.id, b]));
  const indegree = new Map<string, number>(beads.map(b => [b.id, 0]));
  const blocks = new Map<string, string[]>(); // blocker -> [blocked...]
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const list = blocks.get(e.from) ?? [];
    list.push(e.to);
    blocks.set(e.from, list);
  }

  const remaining = new Set(byId.keys());
  const ordered: ExportBead[] = [];
  const pickReady = (): string | null => {
    let best: ExportBead | null = null;
    for (const id of remaining) {
      if ((indegree.get(id) ?? 0) !== 0) continue;
      const b = byId.get(id)!;
      if (best === null || b.priority < best.priority || (b.priority === best.priority && b.id < best.id)) {
        best = b;
      }
    }
    return best ? best.id : null;
  };

  while (remaining.size > 0) {
    const next = pickReady();
    if (next === null) {
      throw new ExportCycleError(findCycle(remaining, blocks));
    }
    remaining.delete(next);
    ordered.push(byId.get(next)!);
    for (const blocked of blocks.get(next) ?? []) {
      indegree.set(blocked, (indegree.get(blocked) ?? 0) - 1);
    }
  }
  return ordered;
}

// Find one concrete cycle among the nodes Kahn's could not drain, for the error
// message. DFS over the blocker->blocked edges restricted to `remaining`; the
// first back-edge closes the cycle. Start nodes are visited in sorted order so the
// reported cycle is itself deterministic.
function findCycle(remaining: Set<string>, blocks: Map<string, string[]>): string[] {
  const onStack: string[] = [];
  const inStack = new Set<string>();
  const visited = new Set<string>();
  const starts = [...remaining].sort();

  const dfs = (node: string): string[] | null => {
    onStack.push(node);
    inStack.add(node);
    const next = (blocks.get(node) ?? []).filter(n => remaining.has(n)).sort();
    for (const n of next) {
      if (inStack.has(n)) {
        return [...onStack.slice(onStack.indexOf(n)), n];
      }
      if (!visited.has(n)) {
        const found = dfs(n);
        if (found) return found;
      }
    }
    onStack.pop();
    inStack.delete(node);
    visited.add(node);
    return null;
  };

  for (const s of starts) {
    if (visited.has(s)) continue;
    const found = dfs(s);
    if (found) return found;
  }
  // Unreachable in practice (Kahn's only stalls on a real cycle) — surface the
  // stuck set rather than claim no cycle.
  return [...remaining].sort();
}

// ── build ────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  epic?: string;
}

// Assemble the ordered ExportDocument from a bead snapshot. Pure: no IO, no bd,
// no clock. Epic-container beads are dropped from the listing (they are never
// worked, exactly as drain excludes them) — an epic contributes its title as the
// goal, not a section. Ordering edges are the in-scope 'blocks' edges only.
export function buildExportDocument(beads: ExportBead[], opts: BuildOptions = {}): ExportDocument {
  let scopeIds: Set<string> | null = null;
  let goal = 'Ready work';
  let epicId: string | null = null;

  if (opts.epic) {
    const epicBead = beads.find(b => b.id === opts.epic);
    if (!epicBead) throw new Error(`Epic not found: ${opts.epic}`);
    epicId = epicBead.id;
    goal = epicBead.title || epicBead.id;
    scopeIds = collectSubtreeIds(beads, epicBead.id);
  }

  // Work beads: in scope (when scoped) and NOT epic containers. Sorted by id for a
  // stable node set before topo ordering re-sequences them.
  const work = beads
    .filter(b => (scopeIds ? scopeIds.has(b.id) : true) && b.type !== 'epic')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodeIds = new Set(work.map(b => b.id));

  // Ordering edges: a bead's 'blocks' dependency, kept only when BOTH endpoints
  // are work beads in scope. An edge to the parent epic or to an out-of-scope
  // bead is dropped — it cannot constrain the order of what we actually list.
  const edges: { from: string; to: string }[] = [];
  for (const b of work) {
    for (const dep of b.dependsOn) {
      if (nodeIds.has(dep)) edges.push({ from: dep, to: b.id });
    }
  }
  edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));

  // Scope each bead's rendered dependsOn to in-scope work beads, so the per-bead
  // "Depends on" line references only ids present in this file and matches the
  // dependency graph exactly. An out-of-scope prerequisite (e.g. an already-closed
  // infrastructure bead) is deliberately dropped: the export must be self-contained
  // — no dangling id, and no out-of-scope bead "appearing" via a dependency line.
  const scopedWork = work.map(b => ({ ...b, dependsOn: b.dependsOn.filter(d => nodeIds.has(d)) }));
  const ordered = topoOrder(scopedWork, edges);
  return { goal, epicId, beads: ordered, edges };
}

// ── markdown format ──────────────────────────────────────────────────────────

// The fixed lead paragraph. States, in plain prose, that the listing IS a valid
// execution order but not the only one, and that a bead's dependencies must be
// respected — so an agent handed this file knows how to read the ordering.
const ORDER_NOTE =
  'The beads below are listed in a valid execution order: every bead appears after ' +
  'the beads it depends on. This is one valid order, not the only one — what a worker ' +
  'must honour is the dependency: do not start a bead until every id under its ' +
  '"Depends on" line is complete.';

export const markdownFormat: ExportFormat = {
  render(doc: ExportDocument): string {
    const out: string[] = [];
    out.push(`# ${doc.goal}`);
    out.push('');
    out.push(`${doc.beads.length} bead${doc.beads.length === 1 ? '' : 's'}.`);
    out.push('');
    out.push(ORDER_NOTE);
    out.push('');
    out.push('## Beads');

    for (const b of doc.beads) {
      out.push('');
      out.push(`### ${b.id} — ${b.title}`);
      out.push('');
      // Fixed metadata order; empty fields omitted consistently.
      out.push(`- Priority: P${b.priority}`);
      if (b.dependsOn.length > 0) {
        out.push(`- Depends on: ${[...b.dependsOn].sort().join(', ')}`);
      }
      if (b.labels.length > 0) {
        out.push(`- Labels: ${[...b.labels].sort().join(', ')}`);
      }
      if (b.description) {
        out.push('');
        out.push(b.description);
      }
      if (b.acceptanceCriteria) {
        out.push('');
        out.push('**Acceptance criteria**');
        out.push('');
        out.push(b.acceptanceCriteria);
      }
      if (b.design) {
        out.push('');
        out.push('**Design notes**');
        out.push('');
        out.push(b.design);
      }
    }

    out.push('');
    out.push('## Dependency graph');
    out.push('');
    if (doc.edges.length === 0) {
      out.push('No dependencies between the listed beads.');
    } else {
      for (const e of doc.edges) out.push(`${e.from} -> ${e.to}`);
    }
    // Exactly one trailing newline — deterministic and diff-friendly.
    return out.join('\n') + '\n';
  },
};

const FORMATS: Record<string, ExportFormat> = { md: markdownFormat };

// ── command ──────────────────────────────────────────────────────────────────

// The IO seam: production loads the bead snapshot through the bd wrapper; tests
// inject a fixture JSON string so the whole command can be exercised without a
// real beads database.
export interface ExportDeps {
  loadBeadsJson(kshetra: KshetraConfig): Promise<string>;
  registry(): KshetraConfig[];
}

const defaultDeps: ExportDeps = {
  loadBeadsJson: kshetra => bd(kshetra).list({ status: 'open,in_progress,blocked,deferred,closed' }),
  registry: () => loadRegistry(),
};

export async function runExport(ctx: CommandContext, deps: ExportDeps = defaultDeps): Promise<void> {
  const id = ctx.flag('--kshetra');
  if (!id) throw new Error('export requires --kshetra <id>.');
  const out = ctx.flag('--out');
  if (!out) throw new Error('export requires --out <file>.');
  const format = ctx.flag('--format') ?? 'md';
  const writer = FORMATS[format];
  if (!writer) {
    throw new Error(`Unsupported --format "${format}": expected one of ${Object.keys(FORMATS).join(', ')}.`);
  }

  const kshetra = deps.registry().find(k => k.id === id);
  if (!kshetra) throw new Error(`Kshetra not found: ${id}`);

  const beads = parseBeads(await deps.loadBeadsJson(kshetra));
  const doc = buildExportDocument(beads, { epic: ctx.flag('--epic') });

  // An --epic scope that resolves to zero work beads is almost always a mistake —
  // a typo'd epic id, or a kshetra whose hierarchy is expressed through 'blocks'
  // edges rather than the `parent` field this walks. Writing a hollow file with no
  // signal would let that pass unnoticed; warn (don't fail — a genuinely empty
  // epic is legal) so the operator can tell the two apart.
  if (doc.epicId && doc.beads.length === 0) {
    console.warn(
      `warning: epic ${doc.epicId} has no work beads in its subtree — ` +
        `the export is empty. Check the epic id, or that its children are linked as sub-beads.`,
    );
  }

  const body = writer.render(doc);
  writeFileSync(out, body, 'utf8');

  const scope = doc.epicId ? `epic ${doc.epicId}` : 'all beads';
  console.log(`exported ${doc.beads.length} bead${doc.beads.length === 1 ? '' : 's'} (${scope}) → ${out}`);
}
