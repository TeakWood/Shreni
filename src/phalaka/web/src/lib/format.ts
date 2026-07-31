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
