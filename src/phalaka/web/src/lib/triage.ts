// Fleet-wide "needs a human" aggregation, ported verbatim in behaviour from the
// old src/phalaka/ui.ts. One entry per stuck worker, dead/stale process, or
// blocked queue across every Kshetra, each with a copyable CLI line. Derived
// purely from the process snapshots the panel already holds plus the board's
// Kshetra summaries — no new endpoint. (repeated-stall is not a separate source:
// the watchdog folds it into a `stuck` marker whose reason already says
// "…repeated N×", so it surfaces here as a stuck entry.)

import { formatAge, processKey, processLabel } from './format';

export type TriageSeverity = 'stuck' | 'dead' | 'stale-heartbeat' | 'blocked';

export interface TriageEntry {
  key: string; // stable identity — React key + dedupe
  severity: TriageSeverity;
  label: string; // the offending process / Kshetra
  reason: string; // why it needs a human
  remediation: string; // copyable CLI line(s)
  kshetraId?: string;
  beadId?: string;
}

// Urgency order: a wedged (stuck) or crashed (dead) worker outranks an
// early-warning stale heartbeat, which outranks a merely blocked queue.
export function triageSeverityRank(severity: string): number {
  switch (severity) {
    case 'stuck':
      return 0;
    case 'dead':
      return 1;
    case 'stale-heartbeat':
      return 2;
    case 'blocked':
      return 3;
    default:
      return 99;
  }
}

export function triageSeverityClass(severity: string): string {
  switch (severity) {
    case 'stuck':
      return 'bg-red-800 text-red-100 light:bg-red-100 light:text-red-800';
    case 'dead':
      return 'bg-slate-800 text-red-300 light:bg-red-50 light:text-red-700';
    case 'stale-heartbeat':
      return 'bg-yellow-700 text-yellow-100 light:bg-yellow-100 light:text-yellow-800';
    case 'blocked':
      return 'bg-sky-800 text-sky-100 light:bg-sky-100 light:text-sky-800';
    default:
      return 'bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700';
  }
}

// Map one process snapshot to a triage entry, or null when the process is
// healthy/idle/paused (nothing a human must act on). Only stuck/dead/stale rows
// escalate here — mirroring the ProcessStatus derivation in process-read.ts.
export function triageEntryForProcess(snap: {
  kind: string;
  kshetraId?: string;
  status: string;
  phase?: string;
  heartbeatAgeMs?: number;
  stuck?: { reason: string; remediation: string; beadId?: string };
}): TriageEntry | null {
  const label = processLabel(snap);
  const id = snap.kshetraId || '<id>';
  if (snap.status === 'stuck') {
    return {
      key: 'stuck:' + processKey(snap),
      severity: 'stuck',
      label,
      kshetraId: snap.kshetraId,
      beadId: snap.stuck ? snap.stuck.beadId : undefined,
      reason: snap.stuck ? snap.stuck.reason : 'worker is stuck and awaiting a human',
      // The watchdog's own remediation, shown verbatim. Falls back to the
      // ACK/resume line when a snapshot carries the status but not the marker.
      remediation:
        snap.stuck && snap.stuck.remediation ? snap.stuck.remediation : 'shreni resume --kshetra ' + id,
    };
  }
  if (snap.status === 'dead') {
    const restart =
      snap.kind === 'phalaka'
        ? 'shreni phalaka start'
        : snap.kind === 'suthradhara'
          ? 'shreni suthradhara start --kshetra ' + id
          : 'shreni start --kshetra ' + id + '   # RECOVER reconciles the crashed worker on restart';
    return {
      key: 'dead:' + processKey(snap),
      severity: 'dead',
      label,
      kshetraId: snap.kshetraId,
      reason: 'the ' + snap.kind + ' process is not running (crashed or was killed)',
      remediation: restart,
    };
  }
  if (snap.status === 'stale-heartbeat') {
    return {
      key: 'stale:' + processKey(snap),
      severity: 'stale-heartbeat',
      label,
      kshetraId: snap.kshetraId,
      reason:
        'no heartbeat for ' +
        formatAge(snap.heartbeatAgeMs) +
        ' while phase=' +
        (snap.phase || '?') +
        ' — the worker may be hanging',
      remediation:
        'shreni logs --kshetra ' + id + '   # inspect; if truly hung: shreni resume --kshetra ' + id,
    };
  }
  return null;
}

// Map one Kshetra board summary to a blocked-queue triage entry, or null when
// nothing is blocked. One aggregate row per Kshetra (the summary carries only a
// count, not the individual blocked beads).
export function triageEntryForKshetra(k: {
  id: string;
  name?: string;
  counts?: { blocked: number };
}): TriageEntry | null {
  const blocked = k.counts ? k.counts.blocked : 0;
  if (!blocked) return null;
  return {
    key: 'blocked:' + k.id,
    severity: 'blocked',
    label: k.name || k.id,
    kshetraId: k.id,
    reason:
      blocked +
      (blocked === 1 ? ' bead blocked' : ' beads blocked') +
      ' — review the blockers; some may need manual unblocking',
    remediation: 'cd <repo> && bd list --status=blocked   # see what is blocking, then unblock',
  };
}

// Aggregate the whole fleet's needs-a-human items and sort by urgency, then key.
export function collectTriageEntries(
  processes: Array<Parameters<typeof triageEntryForProcess>[0]>,
  kshetras: Array<Parameters<typeof triageEntryForKshetra>[0]>,
): TriageEntry[] {
  const entries: TriageEntry[] = [];
  for (const p of processes) {
    const e = triageEntryForProcess(p);
    if (e) entries.push(e);
  }
  for (const k of kshetras) {
    const e = triageEntryForKshetra(k);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => {
    const d = triageSeverityRank(a.severity) - triageSeverityRank(b.severity);
    if (d !== 0) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return entries;
}
