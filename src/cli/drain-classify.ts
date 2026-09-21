import { bd } from '../sthapathi/beads';
import type { KshetraConfig } from '../kshetra/config';

// Per-bead stall classification for `shreni drain` (epic 7h3 / Study B3, bead
// B3.4). At the exit point every OPEN in-scope bead is classified with the reason
// it did not close, so a stalled trial can never be read as a completed one — and
// so an operator (or the study) sees WHY it stalled, per bead.
//
// `budget` is special: it is derived from the bead's own note (the budget policy's
// denial reason, persisted by handleCycleError), and its presence flips the whole
// drain's exit code to 11. Everything else is a flavour of exit-10 'stalled'.
export type StallCategory =
  | 'budget'
  | 'needs-human'
  | 'blocked-by'
  | 'exhausted'
  | 'blocked'
  | 'paused'
  | 'ready-but-unworked'
  | 'open';

export interface StalledBead {
  beadId: string;
  category: StallCategory;
  // Human-readable reason (e.g. 'blocked-by Shreni-beads-7h3.2', or the budget
  // cap text). Rendered in the summary and folded into the drain_finished ledger.
  reason: string;
}

export interface BeadDetail {
  notes: string;
  status: string;
  openBlockers: string[];
}

// Parse a `bd show <id> --json` payload — a JSON array whose FIRST element is the
// requested bead and whose remaining elements are its dependencies. Returns the
// bead's notes + status and the ids of its OPEN blockers (deps with
// dependency_type 'blocks' that are not closed). Parent-child links are NOT
// blockers. Null when the payload is unparseable or the bead is absent.
export function parseBeadDetail(showJson: string, id: string): BeadDetail | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(showJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const rows = parsed.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null);
  const bead = rows.find(b => (b as { id?: unknown }).id === id);
  if (!bead) return null;
  // Dependencies come from bd two ways across versions: nested on the bead as a
  // `dependencies` array (what this project's bd emits), OR as the REMAINING
  // elements of the `[bead, ...deps]` array (the shape parseAcceptanceCriteria
  // documents). Read BOTH and dedup, so blocked-by classification is robust either
  // way. Only 'blocks' deps that are not closed are open blockers; parent-child
  // links are containers, not blockers.
  const nested = Array.isArray(bead.dependencies) ? (bead.dependencies as Record<string, unknown>[]) : [];
  const siblings = rows.filter(b => b !== bead);
  const openBlockers = [
    ...new Set(
      [...nested, ...siblings]
        .filter(d => d.dependency_type === 'blocks' && d.status !== 'closed')
        .map(d => String(d.id)),
    ),
  ];
  return {
    notes: typeof bead.notes === 'string' ? bead.notes : '',
    status: typeof bead.status === 'string' ? bead.status : '',
    openBlockers,
  };
}

const BUDGET_RE = /budget cap/i;
// The feature loop flags "Blocked after N rounds — …"; the health-repair loop
// "Could not restore green after N rounds …"; RECOVER "exceeded N restart
// attempts". All mean the automatic budget of attempts was exhausted.
const EXHAUSTED_RE = /after \d+ rounds|exceeded \d+ .*attempt/i;

// Pull the single note line that names the budget cap, so the summary can name it
// without dumping the whole note blob.
function budgetCapLine(notes: string): string {
  const line = notes.split('\n').find(l => BUDGET_RE.test(l));
  return (line ?? notes).trim();
}

// Classify one bead from its detail. Precedence is deliberate: the most specific,
// most actionable reason wins. `budget` first because it flips the exit code;
// `needs-human` before `blocked-by` so the ROOT flagged bead is named as
// needs-human while its dependents read as blocked-by it; `paused` before
// `ready-but-unworked` because a ready bead left unworked under a pause is
// explained by the pause, not the "should never happen" case.
export function classifyBeadDetail(
  beadId: string,
  detail: BeadDetail,
  ctx: { paused: boolean; ready: boolean },
): StalledBead {
  const { notes, status, openBlockers } = detail;
  if (BUDGET_RE.test(notes)) return { beadId, category: 'budget', reason: budgetCapLine(notes) };
  if (notes.includes('[needs-human]')) return { beadId, category: 'needs-human', reason: 'needs-human' };
  if (openBlockers.length > 0) return { beadId, category: 'blocked-by', reason: `blocked-by ${openBlockers.join(', ')}` };
  if (EXHAUSTED_RE.test(notes)) return { beadId, category: 'exhausted', reason: 'exhausted (round/attempt cap reached)' };
  if (status === 'blocked') return { beadId, category: 'blocked', reason: 'blocked (flagged — see bead notes)' };
  if (ctx.paused) return { beadId, category: 'paused', reason: 'kshetra paused' };
  // A bead the pickup would have selected, yet the drain exited leaving it: a real
  // anomaly (the loop only exits when pickup returns 'no-work'), so flag it loudly.
  if (ctx.ready) return { beadId, category: 'ready-but-unworked', reason: 'READY BUT UNWORKED — investigate (should not happen)' };
  return { beadId, category: 'open', reason: `open (status ${status || 'unknown'})` };
}

// Classify every open in-scope bead. `paused` is the kshetra-level pause; `readyIds`
// is the set of beads pickup currently considers ready (for the ready-but-unworked
// anomaly). One `bd show` per bead — bounded by the open-in-scope count.
export async function classifyOpenBeads(
  kshetra: KshetraConfig,
  openIds: string[],
  ctx: { paused: boolean; readyIds: Set<string> },
): Promise<StalledBead[]> {
  const client = bd(kshetra);
  const out: StalledBead[] = [];
  for (const id of openIds) {
    let detail: BeadDetail | null = null;
    try {
      detail = parseBeadDetail(await client.show(id), id);
    } catch {
      detail = null;
    }
    // A bead we cannot read is still open and unexplained — surface it, don't drop
    // it (dropping would risk reading a stalled drain as complete).
    out.push(
      detail
        ? classifyBeadDetail(id, detail, { paused: ctx.paused, ready: ctx.readyIds.has(id) })
        : { beadId: id, category: 'open', reason: 'open (details unavailable)' },
    );
  }
  return out;
}
