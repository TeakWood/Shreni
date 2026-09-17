// Pure formatting / classification helpers, ported verbatim in behaviour from the
// old src/phalaka/ui.ts (which serialized these into the page via .toString()).
// No DOM, no React — unit-tested in format.test.ts. React renders class strings;
// there is no escapeHtml here (JSX escapes for us).

// Active states are shown by default; closed sits behind the filter toggle.
export function isActiveStatus(status: string): boolean {
  return status === 'open' || status === 'in_progress' || status === 'blocked';
}

export function priorityLabel(priority: number): string {
  return 'P' + String(priority);
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-sky-700 text-sky-100 light:bg-sky-100 light:text-sky-800';
    case 'in_progress':
      return 'bg-amber-700 text-amber-100 light:bg-amber-100 light:text-amber-800';
    case 'blocked':
      return 'bg-red-800 text-red-100 light:bg-red-100 light:text-red-800';
    case 'closed':
      return 'bg-slate-600 text-slate-200 light:bg-slate-200 light:text-slate-700';
    case 'deferred':
      return 'bg-slate-700 text-slate-400 light:bg-slate-200 light:text-slate-600';
    default:
      return 'bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700';
  }
}

// Stable identity of a process "slot" — one worker / Suthradhara per Kshetra, one
// singleton Phalaka. MUST match keyOf() in stream.ts so an SSE `process` event
// upserts the row seeded by /api/processes (not a duplicate).
export function processKey(snap: { kind: string; kshetraId?: string }): string {
  return snap.kind + ':' + (snap.kshetraId ?? '');
}

// Colour per derived ProcessStatus (ADR §4.3). working/healthy read green, idle
// neutral, paused amber, the two escalations (stale-heartbeat → stuck) warm→red,
// dead muted-red. Unknown falls back to neutral slate.
export function processStatusPillClass(status: string): string {
  switch (status) {
    case 'working':
      return 'bg-emerald-700 text-emerald-100 light:bg-emerald-100 light:text-emerald-800';
    case 'healthy':
      return 'bg-emerald-800 text-emerald-100 light:bg-emerald-100 light:text-emerald-800';
    case 'idle':
      return 'bg-slate-600 text-slate-200 light:bg-slate-200 light:text-slate-700';
    case 'paused-manual':
      return 'bg-amber-700 text-amber-100 light:bg-amber-100 light:text-amber-800';
    case 'stale-heartbeat':
      return 'bg-yellow-700 text-yellow-100 light:bg-yellow-100 light:text-yellow-800';
    case 'stuck':
      return 'bg-red-800 text-red-100 light:bg-red-100 light:text-red-800';
    case 'dead':
      return 'bg-slate-800 text-red-300 light:bg-red-50 light:text-red-700';
    default:
      return 'bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700';
  }
}

// Human-readable age from a millisecond delta: 45s / 3m / 2h / 1d. Returns '—'
// for the missing-heartbeat case (services carry no heartbeat).
export function formatAge(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// Display name for a process row. Workers/Suthradhara are named by their Kshetra;
// the singleton Phalaka has no Kshetra.
export function processLabel(snap: { kind: string; kshetraId?: string }): string {
  return snap.kshetraId || (snap.kind === 'phalaka' ? 'dashboard' : snap.kind);
}

// ── Planning-session formatting (Suthradhara monitoring, fnd.5) ──────────────

// Stable identity of a planning-session row across re-fetches: a session id is
// globally unique (kshetra-prefixed), so it keys the row on its own.
export function planningKey(s: { sessionId: string }): string {
  return s.sessionId;
}

// Compact token count: 940 / 1.2k / 3.4M. Keeps a busy session's totals legible
// in a single row without a full thousands-separated number.
export function formatTokens(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

// USD cost for a session. `priced` false means the run wasn't in the price table,
// so the number is an unknown placeholder, not a real $0 — shown as 'unpriced'.
// A metered $0 (usageRecorded, priced) still reads '$0.00', distinct from a
// not-yet-metered running session ('—', handled by the caller via usageRecorded).
export function formatCost(costUsd: number, priced: boolean): string {
  if (!priced) return 'unpriced';
  if (!isFinite(costUsd) || costUsd < 0) return '—';
  return '$' + costUsd.toFixed(costUsd > 0 && costUsd < 0.01 ? 4 : 2);
}

// The furthest lifecycle milestone a session reached, as a short label + pill
// colour: launched (neutral) → plan filed (sky) → doc pushed (amber) → ended
// (slate). A still-running session reads by its phase; `ended` is terminal.
export function planningPhaseLabel(phase: string): string {
  switch (phase) {
    case 'launched': return 'launched';
    case 'plan_filed': return 'plan filed';
    case 'doc_pushed': return 'doc pushed';
    case 'ended': return 'ended';
    default: return phase;
  }
}

export function planningPhaseClass(phase: string): string {
  switch (phase) {
    case 'launched':
      return 'bg-slate-600 text-slate-200 light:bg-slate-200 light:text-slate-700';
    case 'plan_filed':
      return 'bg-sky-700 text-sky-100 light:bg-sky-100 light:text-sky-800';
    case 'doc_pushed':
      return 'bg-amber-700 text-amber-100 light:bg-amber-100 light:text-amber-800';
    case 'ended':
      return 'bg-slate-700 text-slate-400 light:bg-slate-200 light:text-slate-600';
    default:
      return 'bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700';
  }
}
