import { writeFileSync } from 'fs';
import type { CommandContext } from './registry';
import { loadRegistry } from '../kshetra/registry';
import { bd } from '../sthapathi/beads';
import { git } from '../sthapathi/git';
import { readBeadStats, readManifest } from '../kshetra/snapshot';
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

// Where an export's input state came from, so a trial's plan file is traceable to
// an exact frozen state (C1.2 point 3). The three values are computed the SAME way
// `shreni freeze` computes them, so a reader can confirm export and freeze manifest
// describe the same state: beadsHeadSha (git HEAD of the beads repo) and beadIdHash
// (sha256 over the sorted bead ids in issues.jsonl) are state-derived; snapshotId
// is copied from a named freeze manifest when --snapshot points at one.
export interface ExportProvenance {
  snapshotId: string | null; // from the --snapshot manifest, else null
  beadsHeadSha: string | null;
  beadIdHash: string;
  // True when --allow-executed was used to export beads that carry execution
  // history — the header must then say so, loudly and never silently.
  containsExecutionHistory: boolean;
}

// The assembled, ordered document a format renders. Pure data — no IO, no bd.
// `provenance` is attached by the IO layer (runExport) after the pure build; the
// pure buildExportDocument leaves it undefined and the format omits the section.
export interface ExportDocument {
  goal: string; // the epic title, or a generic heading for a whole-queue export
  epicId: string | null;
  beads: ExportBead[]; // in a valid topological execution order
  edges: { from: string; to: string }[]; // blocker -> blocked, both in scope
  provenance?: ExportProvenance;
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

// ── executed-bead guard ──────────────────────────────────────────────────────

export interface ExecutedBead {
  id: string;
  fields: string[]; // the execution artefacts that tripped the guard, named
}

// Scan beads for EXECUTION ARTEFACTS — the fields a bead only carries AFTER it has
// been worked: a non-open status, a close reason, or loop-added notes (round notes
// and review feedback both land in `notes`). Their presence means the export would
// leak how the work was done: a close reason describes the implementation, so
// handing it to E3's bare baseline would give away the answers. Returns one entry
// per offending bead naming exactly which field tripped it.
export function findExecutedBeads(beads: ExportBead[]): ExecutedBead[] {
  const offenders: ExecutedBead[] = [];
  for (const b of beads) {
    const fields: string[] = [];
    if (b.status !== 'open') fields.push(`status=${b.status}`);
    if (b.closeReason) fields.push('close reason');
    if (b.notes) fields.push('notes');
    if (fields.length > 0) offenders.push({ id: b.id, fields });
  }
  return offenders;
}

// The rationale, surfaced AT THE POINT OF FAILURE (C1.2 point 4: document why the
// guard exists). Reused verbatim in the thrown error so an operator who trips it
// learns the reason, not just the rule.
const GUARD_RATIONALE =
  'A post-run bead carries its implementation in its close reason and round notes; ' +
  'exporting it would hand a baseline the answers. Freeze and export at PLAN TIME, ' +
  'or pass --allow-executed to export the history anyway (the header will be marked).';

export class ExecutedBeadError extends Error {
  constructor(public readonly offenders: ExecutedBead[]) {
    super(
      `Refusing to export ${offenders.length} executed bead${offenders.length === 1 ? '' : 's'} ` +
        `(no output written):\n` +
        offenders.map(o => `  ${o.id} — ${o.fields.join(', ')}`).join('\n') +
        `\n${GUARD_RATIONALE}`,
    );
    this.name = 'ExecutedBeadError';
  }
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
    // Provenance block (C1.2): ties this export to an exact frozen state. All three
    // values are content-derived, so they stay byte-stable across runs of the same
    // state — they never break C1.1's determinism.
    const p = doc.provenance;
    if (p) {
      out.push('');
      out.push(`- Source snapshot: ${p.snapshotId ?? '(not linked to a freeze snapshot)'}`);
      out.push(`- Beads repo HEAD: ${p.beadsHeadSha ?? '(unavailable)'}`);
      out.push(`- Bead-id hash: ${p.beadIdHash}`);
      if (p.containsExecutionHistory) {
        out.push('');
        out.push(
          '> ⚠ WARNING: this export CONTAINS EXECUTION HISTORY (--allow-executed). Closed ' +
            'beads and their close reasons / notes are included — it is NOT a clean plan-time ' +
            'baseline and must not be used as one.',
        );
      }
    }
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
      // Execution history — the leak the guard exists to stop. These fields are only
      // present on a bead that has been worked, so a clean plan-time export never
      // reaches them; they render ONLY under --allow-executed (the guard rejects the
      // export otherwise), where the header already warns the reader.
      if (b.closeReason) {
        out.push('');
        out.push('**Close reason (execution history)**');
        out.push('');
        out.push(b.closeReason);
      }
      if (b.notes) {
        out.push('');
        out.push('**Notes (execution history)**');
        out.push('');
        out.push(b.notes);
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

// State-derived provenance for an export: the beads repo HEAD and the bead-id hash
// (the two fields freeze also records), computed the SAME way freeze computes them.
export interface ExportProvenanceInputs {
  beadsHeadSha: string | null;
  beadIdHash: string;
}

// The IO seam: production loads the bead snapshot through the bd wrapper and the
// provenance from the beads repo; tests inject fixtures so the whole command can be
// exercised without a real beads database, git repo, or freeze snapshot.
export interface ExportDeps {
  loadBeadsJson(kshetra: KshetraConfig): Promise<string>;
  registry(): KshetraConfig[];
  loadProvenance(kshetra: KshetraConfig): Promise<ExportProvenanceInputs>;
  // Read a freeze snapshot's manifest for the --snapshot cross-check. Returns just
  // the two fields the cross-check needs — the snapshot id to cite and the bead-id
  // hash to match against the exported state. Throws if the directory is not a
  // snapshot (readManifest's contract).
  readSnapshotManifest(dir: string): { snapshotId: string; beadIdHash: string };
}

const defaultDeps: ExportDeps = {
  loadBeadsJson: kshetra => bd(kshetra).list({ status: 'open,in_progress,blocked,deferred,closed' }),
  registry: () => loadRegistry(),
  async loadProvenance(kshetra) {
    // Beads HEAD is best-effort (a beads dir that is not a git checkout records
    // null rather than failing the export) — mirrors freeze's own handling.
    let beadsHeadSha: string | null = null;
    try {
      beadsHeadSha = await git(kshetra.beads.path).headSha();
    } catch {
      beadsHeadSha = null;
    }
    return { beadsHeadSha, beadIdHash: readBeadStats(kshetra.beads.path).beadIdHash };
  },
  readSnapshotManifest(dir) {
    const m = readManifest(dir);
    return { snapshotId: m.snapshotId, beadIdHash: m.beads.beadIdHash };
  },
};

export async function runExport(ctx: CommandContext, overrides: Partial<ExportDeps> = {}): Promise<void> {
  const deps: ExportDeps = { ...defaultDeps, ...overrides };
  const id = ctx.flag('--kshetra');
  if (!id) throw new Error('export requires --kshetra <id>.');
  const out = ctx.flag('--out');
  if (!out) throw new Error('export requires --out <file>.');
  const format = ctx.flag('--format') ?? 'md';
  const writer = FORMATS[format];
  if (!writer) {
    throw new Error(`Unsupported --format "${format}": expected one of ${Object.keys(FORMATS).join(', ')}.`);
  }
  const allowExecuted = ctx.has('--allow-executed');
  const snapshotDir = ctx.flag('--snapshot');

  const kshetra = deps.registry().find(k => k.id === id);
  if (!kshetra) throw new Error(`Kshetra not found: ${id}`);

  const beads = parseBeads(await deps.loadBeadsJson(kshetra));
  const doc = buildExportDocument(beads, { epic: ctx.flag('--epic') });

  // THE GUARD (C1.2): refuse to export beads that carry execution history, which
  // would leak the answers, UNLESS --allow-executed. Runs before any provenance IO
  // or file write, so a rejected export touches nothing. Scans the beads that would
  // actually ship (the scoped, ordered set).
  const offenders = findExecutedBeads(doc.beads);
  if (offenders.length > 0 && !allowExecuted) {
    throw new ExecutedBeadError(offenders);
  }

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

  // Provenance: the state-derived values always; the snapshot id only when
  // --snapshot names a freeze manifest. A named snapshot whose recorded state does
  // NOT match the beads being exported is a provenance falsehood — fail loudly
  // (write nothing) rather than stamp a citation the export doesn't satisfy.
  const { beadsHeadSha, beadIdHash } = await deps.loadProvenance(kshetra);
  let snapshotId: string | null = null;
  if (snapshotDir) {
    const m = deps.readSnapshotManifest(snapshotDir);
    if (m.beadIdHash !== beadIdHash) {
      throw new Error(
        `--snapshot ${snapshotDir} does not match the exported state (no output written): ` +
          `manifest bead-id hash ${m.beadIdHash} ≠ current ${beadIdHash}. ` +
          `The snapshot describes a different bead graph than the one being exported.`,
      );
    }
    snapshotId = m.snapshotId;
  }
  doc.provenance = {
    snapshotId,
    beadsHeadSha,
    beadIdHash,
    containsExecutionHistory: offenders.length > 0,
  };

  const body = writer.render(doc);
  writeFileSync(out, body, 'utf8');

  const scope = doc.epicId ? `epic ${doc.epicId}` : 'all beads';
  const warn = offenders.length > 0 ? ' ⚠ WITH EXECUTION HISTORY' : '';
  console.log(`exported ${doc.beads.length} bead${doc.beads.length === 1 ? '' : 's'} (${scope})${warn} → ${out}`);
}
