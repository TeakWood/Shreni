// Tracks outstanding asynchronous Parikshaka backfills per kshetra (epic 7h3 /
// Study B3). The post-merge test agent is dispatched fire-and-forget from merge.ts
// with no scheduler handle, yet it may file new beads AFTER the task that spawned
// it has already left WORKING. `shreni drain` must not read the ready queue as
// empty and exit while that backfill is still running, or it strands the beads the
// backfill is about to write. dispatchParikshakaAsync brackets each run with
// begin/end; the scheduler folds `parikshakaInFlight` into its `isInFlight` signal.
//
// A per-kshetra COUNT, not a boolean: two merges can each spawn a backfill that
// overlap, and a single boolean would clear on the first one's completion while the
// second is still writing. The count goes to zero only when the last settles.
const counts = new Map<string, number>();

export function beginParikshaka(kshetraId: string): void {
  counts.set(kshetraId, (counts.get(kshetraId) ?? 0) + 1);
}

export function endParikshaka(kshetraId: string): void {
  const next = (counts.get(kshetraId) ?? 0) - 1;
  // Clamp at zero and drop the key so a stray end() can never drive the count
  // negative and mask a genuinely in-flight backfill.
  if (next <= 0) counts.delete(kshetraId);
  else counts.set(kshetraId, next);
}

export function parikshakaInFlight(kshetraId: string): boolean {
  return (counts.get(kshetraId) ?? 0) > 0;
}
