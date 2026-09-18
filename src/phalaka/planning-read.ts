import { statSync, openSync, readSync, closeSync } from 'fs';
import { logPath } from '../sthapathi/activity-log.js';
import { loadRegistry } from '../kshetra/registry.js';

// Planning-session read layer for the Phalaka control plane (observe-only, epic
// fnd.5). Folds the Suthradhara activity stream — the interactive planning
// session's ONLY monitoring surface (it runs with no stream-json, so it emits
// lifecycle events, not the per-token agent_text the executors do) — into one
// row per session so an operator can watch a running or just-ended planning unit
// and see its recovered token cost, alongside the executor process rows.
//
// File-only and synchronous, like process-read.ts: it never calls `bd`. The
// source is each Kshetra's activity.jsonl (the same file stream.ts tails); a
// missing/rotated file or a malformed line is tolerated (skip), never thrown —
// the dashboard degrades to "no sessions" rather than 500ing.

// Lifecycle milestones, in order. `phase` is the furthest milestone a session has
// reached; `running` is true until the session-ended event lands.
export type PlanningPhase = 'launched' | 'plan_filed' | 'doc_pushed' | 'ended';

export interface PlanningSessionSnapshot {
  kshetraId: string;
  sessionId: string;
  phase: PlanningPhase;
  running: boolean;
  launchedAt?: string;
  endedAt?: string;
  resume?: boolean;
  // Filled once the session files its plan (suthradhara_plan_filed / _session_ended).
  epicId?: string;
  docPath?: string;
  summary?: string;
  // The operator's last menu decision for the unit (extend / new / end).
  choice?: 'extend' | 'new' | 'end';
  // Recovered token usage folded from the session's run_usage event (fnd.6). Zero
  // when no run_usage matched yet (a still-running session hasn't been metered).
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  // `priced` mirrors run_usage: false means costUsd is an "unknown" placeholder,
  // not a real $0. `usageRecorded` distinguishes "metered at $0/unpriced" from
  // "not metered yet".
  priced: boolean;
  usageRecorded: boolean;
}

// A raw activity.jsonl line, parsed. Only the fields this layer reads are typed;
// the envelope (ts) and event body are a soft, defensively-read contract.
interface RawEvent {
  type?: unknown;
  ts?: unknown;
  kshetra?: unknown;
  sessionId?: unknown;
  agent?: unknown;
  beadId?: unknown;
  epicId?: unknown;
  docPath?: unknown;
  summary?: unknown;
  branch?: unknown;
  resume?: unknown;
  choice?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  costUsd?: unknown;
  priced?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
// Coerce to a NON-NEGATIVE finite number. Token counts and cost are sums that
// feed the strict PlanningSessionSchema (.nonnegative()) at the API boundary, so
// a malformed negative in the (soft, Claude-Code-internal) transcript must clamp
// to 0 here rather than sum through and 500 the endpoint — this layer never throws.
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// Fold one Kshetra's activity lines into its planning sessions. Pure and
// table-testable (no I/O). Two passes: build a record per sessionId from the
// suthradhara_* lifecycle events, then attach each suthradhara run_usage event to
// its session. run_usage carries `beadId` (= the filed epic id, else the session
// id — exactly how fnd.6 keys it), NOT a sessionId, so it is matched by epicId
// first, then by sessionId.
export function foldPlanningSessions(kshetraId: string, lines: string[]): PlanningSessionSnapshot[] {
  const byId = new Map<string, PlanningSessionSnapshot>();
  const usage: RawEvent[] = [];

  const ensure = (sessionId: string): PlanningSessionSnapshot => {
    let s = byId.get(sessionId);
    if (!s) {
      s = {
        kshetraId, sessionId, phase: 'launched', running: true,
        inputTokens: 0, outputTokens: 0, costUsd: 0, priced: true, usageRecorded: false,
      };
      byId.set(sessionId, s);
    }
    return s;
  };
  // Only advance the phase forward — events are appended in order, but guard
  // against a reordered/replayed line rewinding a session's furthest milestone.
  const RANK: Record<PlanningPhase, number> = { launched: 0, plan_filed: 1, doc_pushed: 2, ended: 3 };
  const advance = (s: PlanningSessionSnapshot, to: PlanningPhase): void => {
    if (RANK[to] > RANK[s.phase]) s.phase = to;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Cheap pre-filter: activity.jsonl is dominated by executor per-token events;
    // only parse lines that could be ours. A false match (e.g. an executor
    // run_usage) is discarded by the type/agent checks below.
    if (!trimmed.includes('suthradhara') && !trimmed.includes('run_usage')) continue;
    let ev: RawEvent;
    try {
      ev = JSON.parse(trimmed) as RawEvent;
    } catch {
      continue;
    }
    const type = str(ev.type);
    if (!type) continue;

    if (type === 'run_usage') {
      if (str(ev.agent) === 'suthradhara') usage.push(ev);
      continue;
    }

    const sessionId = str(ev.sessionId);
    if (!sessionId) continue; // every suthradhara_* lifecycle event carries one
    switch (type) {
      case 'suthradhara_launched': {
        const s = ensure(sessionId);
        s.launchedAt = str(ev.ts);
        s.resume = ev.resume === true;
        break;
      }
      case 'suthradhara_plan_filed': {
        const s = ensure(sessionId);
        advance(s, 'plan_filed');
        s.epicId = str(ev.epicId) ?? s.epicId;
        s.docPath = str(ev.docPath) ?? s.docPath;
        s.summary = str(ev.summary) ?? s.summary;
        break;
      }
      case 'suthradhara_doc_pushed': {
        const s = ensure(sessionId);
        advance(s, 'doc_pushed');
        s.docPath = str(ev.docPath) ?? s.docPath;
        break;
      }
      case 'suthradhara_menu_choice': {
        const s = ensure(sessionId);
        const c = str(ev.choice);
        if (c === 'extend' || c === 'new' || c === 'end') s.choice = c;
        break;
      }
      case 'suthradhara_session_ended': {
        const s = ensure(sessionId);
        advance(s, 'ended');
        s.running = false;
        s.endedAt = str(ev.ts);
        s.epicId = str(ev.epicId) ?? s.epicId;
        break;
      }
      default:
        break; // a suthradhara-substring line that isn't a known lifecycle event
    }
  }

  // Second pass: attach usage. Match by epicId (a session that filed a plan), else
  // by sessionId (a session that filed nothing) — the two keys fnd.6 records under.
  for (const u of usage) {
    const beadId = str(u.beadId);
    if (!beadId) continue;
    const target =
      [...byId.values()].find(s => s.epicId !== undefined && s.epicId === beadId) ??
      byId.get(beadId);
    if (!target) continue; // usage for a session whose lifecycle events we didn't see
    target.inputTokens += num(u.inputTokens);
    target.outputTokens += num(u.outputTokens);
    target.costUsd += num(u.costUsd);
    target.usageRecorded = true;
    if (u.priced === false) target.priced = false;
  }

  return [...byId.values()];
}

// Decide, ONCE at ingest, whether to retain a line (fnd.8). A cheap substring
// gate first skips the executor per-token bulk without parsing; then a single
// parse keeps ONLY the lines foldPlanningSessions actually uses — the
// suthradhara_* lifecycle events and suthradhara-agent run_usage. Crucially this
// also drops EXECUTOR run_usage (one per run, O(runs)): retaining it would make
// the retained set — and the re-fold cost on every poll — grow without bound on a
// busy fleet, undercutting the point of tailing. The retained set is thus bounded
// by planning activity, not by execution volume. foldPlanningSessions re-parses
// (harmlessly) and re-applies its own filter, so its semantics are unchanged.
function isRetainablePlanningLine(line: string): boolean {
  if (!line.includes('suthradhara') && !line.includes('run_usage')) return false;
  let ev: { type?: unknown; agent?: unknown };
  try {
    ev = JSON.parse(line) as { type?: unknown; agent?: unknown };
  } catch {
    return false; // a half-written/corrupt line — foldPlanningSessions would skip it too
  }
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type.startsWith('suthradhara_')) return true;
  if (type === 'run_usage') return ev.agent === 'suthradhara';
  return false;
}

// Per-Kshetra incremental tail state (fnd.8). `offset` is the byte count consumed
// so far; `partial` carries a trailing partial line across calls (a line still
// being appended when we read); `relevant` retains only the planning-relevant
// lines seen so far. Module-scoped: the Phalaka process is long-lived, so this
// survives across dashboard polls.
interface PlanningTail {
  offset: number;
  partial: string;
  relevant: string[];
}
const planningTails = new Map<string, PlanningTail>();

// Reset the incremental tail cache. Test-only seam so cases don't leak retained
// state into one another; the live process never calls it.
export function resetPlanningTailsForTest(): void {
  planningTails.clear();
}

// Return a Kshetra's planning-relevant activity lines, reading ONLY the bytes
// appended since the last call (fnd.8) rather than the whole activity.jsonl. This
// is what keeps /api/planning-sessions from scaling with the multi-MB per-token
// bulk of the log: after the first read, per-call work is O(new bytes) + O(the
// retained planning/run_usage lines), independent of total file size. Mirrors the
// byte-offset tail in stream.ts (offset + partial-line carry + truncation reset).
function planningRelevantLines(id: string): string[] {
  const path = logPath(id);
  let tail = planningTails.get(id);
  if (!tail) {
    tail = { offset: 0, partial: '', relevant: [] };
    planningTails.set(id, tail);
  }

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return tail.relevant; // no activity file (yet) — keep whatever we have
  }
  if (size < tail.offset) {
    // Truncated or rotated — restart from the top so we don't read past EOF.
    tail.offset = 0;
    tail.partial = '';
    tail.relevant = [];
  }
  if (size > tail.offset) {
    let chunk: string;
    try {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(size - tail.offset);
        readSync(fd, buf, 0, buf.length, tail.offset);
        chunk = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return tail.relevant; // transient read failure — degrade to what we have
    }
    tail.offset = size;
    // Prepend the carried partial; the last split element is the new trailing
    // partial (or '' when the chunk ended on a newline). Only whole lines are
    // ingested — the partial is re-read next call once completed.
    const lines = (tail.partial + chunk).split('\n');
    tail.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (isRetainablePlanningLine(line)) tail.relevant.push(line);
    }
  }
  return tail.relevant;
}

// Read + fold the planning sessions for the given Kshetras (default: all
// registered). Newest first (a just-ended or live session sorts to the top), so
// the dashboard shows the current planning unit without the client sorting.
// Scaling (fnd.8): each Kshetra's activity.jsonl is tailed incrementally by byte
// offset — only bytes appended since the last call are read, and only planning-
// relevant lines are retained — so this no longer scales with the full log size.
export function readPlanningSessions(kshetraIds?: string[]): PlanningSessionSnapshot[] {
  const ids = kshetraIds ?? loadRegistry().map(k => k.id);
  const sessions: PlanningSessionSnapshot[] = [];
  for (const id of ids) {
    sessions.push(...foldPlanningSessions(id, planningRelevantLines(id)));
  }
  // A running session (no endedAt) sorts above ended ones; within each group, most
  // recent timestamp first. Sessions with no timestamps sink to the bottom.
  return sessions.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    const at = a.endedAt ?? a.launchedAt ?? '';
    const bt = b.endedAt ?? b.launchedAt ?? '';
    return bt.localeCompare(at);
  });
}
