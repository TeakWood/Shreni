import type { KshetraConfig } from '../kshetra/config.js';
import { bd } from './beads.js';
import { emit } from './activity-log.js';

// Epic lifecycle for Sthapathi (Shreni-beads-q08). An epic is a CONTAINER, never
// executable work: pickup never hands one to Silpi (rankCandidates drops type 'epic'
// and pickNextWorkable skips any candidate with open children), and bd refuses to close
// an epic while it has open children — so nothing used to close an epic at all.
// This module closes an epic the moment its last child closes (the push path and
// the PR-reconcile path call closeParentEpicIfComplete right after a child's bd
// close) and sweeps every already-complete epic at worker/drain startup and at
// drain exit, so a crash between the child close and the epic close self-heals.
//
// Deliberately NOT `bd epic close-eligible`: that closes a ZERO-child epic, and
// Suthradhara files the epic seconds before its children — a sweep landing in
// that window would close a freshly-filed plan. Every path here requires >= 1
// child, all closed.
//
// Everything is BEST-EFFORT: the callers have already merged + closed the child,
// so an epic lookup/close failure is logged and swallowed, never thrown into the
// merge path. A missed close self-heals at the next startup/drain-exit sweep.

// Label marking a bead whose approved work is on a PR awaiting a human merge
// (mergePolicy 'pr'). Defined HERE (merge.ts re-exports it — merge.ts imports
// this module, so the reverse import would be a cycle). An epic carrying it is
// owned by reconcilePullRequests, which closes it when its PR merges; the epic
// sweep leaves it alone.
export const AWAITING_MERGE_LABEL = 'awaiting-merge';

// Bound on how far up a parent chain one child close may cascade (epic of epics).
// Real plans are 1-2 levels deep; this only guards against a malformed cycle.
const MAX_PARENT_DEPTH = 10;

interface BeadRow {
  id: string;
  status: string;
  type?: string;
  labels: string[];
  parent?: string;
}

function toRow(item: unknown): BeadRow | null {
  if (typeof item !== 'object' || item === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  // bd 1.0.3 reports the parent as a top-level `parent` field on `bd show`; older
  // payloads only carry it as a parent-child dependency. Read both.
  let parent = typeof r.parent === 'string' && r.parent ? r.parent : undefined;
  if (!parent && Array.isArray(r.dependencies)) {
    const dep = (r.dependencies as Record<string, unknown>[]).find(
      d => typeof d === 'object' && d !== null && d.dependency_type === 'parent-child' && typeof d.id === 'string',
    );
    if (dep) parent = dep.id as string;
  }
  return {
    id: r.id,
    status: typeof r.status === 'string' ? r.status : '',
    type: typeof r.issue_type === 'string' ? r.issue_type : undefined,
    labels: Array.isArray(r.labels) ? (r.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [],
    parent,
  };
}

function parseRows(raw: string): BeadRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(toRow).filter((r): r is BeadRow => r !== null);
}

// `bd show <id> --json` → the requested bead's row (the payload is an array whose
// first/matching element is the bead). Null when absent or unparseable.
function parseShow(raw: string, id: string): BeadRow | null {
  return parseRows(raw).find(r => r.id === id) ?? null;
}

// Direct children of `id`, via the same bd children helper `drain --epic` walks.
// THROWS on a bd failure — callers decide what a failed lookup means.
async function directChildren(kshetra: KshetraConfig, id: string): Promise<BeadRow[]> {
  return parseRows(await bd(kshetra).children(id));
}

// Structural pickup guard: does this bead have any child that is not closed?
// Throws on a bd failure (selectNext treats a failed lookup conservatively).
export async function hasOpenChildren(kshetra: KshetraConfig, id: string): Promise<boolean> {
  const children = await directChildren(kshetra, id);
  return children.some(c => c.status !== 'closed');
}

// Statuses an epic may be auto-closed from. open is the normal case; in_progress
// is an epic a pre-q08 worker wrongly claimed; blocked is how the pre-q08 failure
// left one (handleCycleError flags the bead when bd refuses the epic close). A
// DEFERRED epic was postponed on purpose — left for its human.
export const CLOSABLE_EPIC_STATUSES = ['open', 'in_progress', 'blocked'] as const;

// Every bead that has at least one non-closed child, from ONE `bd list` over the
// non-closed statuses (each row carries its `parent`). For bulk callers (drain's
// exit classification) where a per-bead children lookup would be N subprocesses.
// Throws on a bd failure.
export async function parentsWithOpenChildren(kshetra: KshetraConfig): Promise<Set<string>> {
  const rows = parseRows(await bd(kshetra).list({ status: 'open,in_progress,blocked,deferred', all: true }));
  return new Set(rows.map(r => r.parent).filter((p): p is string => p !== undefined));
}

// An epic is auto-closable only while it is live and unowned: a closable status
// and NOT awaiting a PR merge (reconcilePullRequests owns that close).
function isClosableEpic(row: BeadRow): boolean {
  return (
    row.type === 'epic' &&
    (CLOSABLE_EPIC_STATUSES as readonly string[]).includes(row.status) &&
    !row.labels.includes(AWAITING_MERGE_LABEL)
  );
}

// Close `epic` iff it has >= 1 child and every child is closed. Emits the
// decision-grade epic_closed ledger event. Returns true when it closed the epic.
// Never throws: a lookup/close failure is logged and reported as false.
async function closeEpicIfComplete(kshetra: KshetraConfig, epic: BeadRow, source: string): Promise<boolean> {
  if (!isClosableEpic(epic)) return false;
  let children: BeadRow[];
  try {
    children = await directChildren(kshetra, epic.id);
  } catch (err) {
    console.warn(`[shreni epics:${kshetra.id}] could not list children of ${epic.id}: ${(err as Error).message}`);
    return false;
  }
  // >= 1 child is load-bearing: a zero-child epic is a plan still being filed.
  if (children.length === 0) return false;
  if (children.some(c => c.status !== 'closed')) return false;
  const ids = children.map(c => c.id);
  try {
    await bd(kshetra).close(epic.id, `all ${ids.length} children closed: ${ids.join(', ')}`);
  } catch (err) {
    console.warn(`[shreni epics:${kshetra.id}] could not close epic ${epic.id}: ${(err as Error).message}`);
    return false;
  }
  try {
    emit({ type: 'epic_closed', kshetra: kshetra.id, beadId: epic.id, epicId: epic.id, children: ids });
  } catch {
    // A ledger-fold failure must never undo or fail an already-applied close.
  }
  console.log(`[shreni epics:${kshetra.id}] closed epic ${epic.id} (${source}): all ${ids.length} children closed`);
  return true;
}

// Called right after a child bead closes (push path: squashMergeAndClose; PR path:
// reconcilePullRequests). Looks up the child's parent; if it is an epic whose
// children are now all closed, closes it — then repeats one level up, so the last
// leaf of an epic-of-epics closes the whole chain. Returns the epic ids closed.
// Never throws.
export async function closeParentEpicIfComplete(kshetra: KshetraConfig, childId: string): Promise<string[]> {
  const closed: string[] = [];
  const client = bd(kshetra);
  let current = childId;
  const seen = new Set<string>([childId]);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    let parentId: string | undefined;
    let parent: BeadRow | null;
    try {
      parentId = parseShow(await client.show(current), current)?.parent;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      parent = parseShow(await client.show(parentId), parentId);
    } catch (err) {
      console.warn(`[shreni epics:${kshetra.id}] parent lookup for ${current} failed: ${(err as Error).message}`);
      break;
    }
    if (!parent || !(await closeEpicIfComplete(kshetra, parent, `last child ${current} closed`))) break;
    closed.push(parent.id);
    current = parent.id;
  }
  return closed;
}

// Sweep: close every live epic with >= 1 child whose children are all closed.
// Runs at worker/drain startup and at drain exit — self-heals a crash between a
// child's close and its epic's close, and closes epics completed before q08.
// Repeats until a pass closes nothing, so a nested epic closing makes its parent
// eligible in the same sweep. Idempotent: a closed epic is no longer listed.
// Never throws. Returns the epic ids closed. `inScope` (a scoped `drain --epic`)
// restricts the sweep to epics inside the trial's subtree, so a scoped trial never
// closes — or records ledger entries for — epics outside it.
export async function sweepCompleteEpics(
  kshetra: KshetraConfig,
  inScope?: (epicId: string) => boolean,
): Promise<string[]> {
  const closed: string[] = [];
  for (let pass = 0; pass < MAX_PARENT_DEPTH; pass++) {
    let epics: BeadRow[];
    try {
      epics = parseRows(await bd(kshetra).list({ status: CLOSABLE_EPIC_STATUSES.join(','), type: 'epic', all: true }));
    } catch (err) {
      console.warn(`[shreni epics:${kshetra.id}] epic sweep skipped: ${(err as Error).message}`);
      break;
    }
    let progressed = false;
    for (const epic of epics) {
      if (closed.includes(epic.id)) continue;
      if (inScope && !inScope(epic.id)) continue;
      if (await closeEpicIfComplete(kshetra, epic, 'sweep')) {
        closed.push(epic.id);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return closed;
}
