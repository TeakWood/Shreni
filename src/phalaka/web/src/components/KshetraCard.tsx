import { useEffect, useState } from 'react';
import type { BeadSummary, KshetraSummary } from '../lib/types';
import { fetchTasks, postAction } from '../api/client';
import { TaskRow } from './TaskRow';

interface Props {
  kshetra: KshetraSummary;
  token: string;
  showClosed: boolean;
  /** Fleet-wide "which bead is open" — one expanded row at a time across the board. */
  expandedKey: string | null;
  onToggleRow: (key: string | null) => void;
  /** Bumps whenever a live refresh lands, so cards re-pull their task lists. */
  refreshTick: number;
}

function rowKey(kshetraId: string, beadId: string): string {
  return kshetraId + '::' + beadId;
}

function CountsLine({ kshetra }: { kshetra: KshetraSummary }) {
  if (kshetra.error) return <span className="text-xs text-red-400 light:text-red-600">{kshetra.error}</span>;
  const c = kshetra.counts;
  if (!c) return null;
  return (
    <span className="text-xs text-slate-400 light:text-slate-600">
      {c.open} open · {c.in_progress} active · {c.blocked} blocked · {c.closed} closed
    </span>
  );
}

// One Kshetra section: header chips + optional stuck banner + its task rows. Pulls
// its own task list (active always, closed when the toggle is on) and re-pulls on
// each live refresh tick — mirroring loadBoard→loadTasks in the old bootstrap.
export function KshetraCard({ kshetra, token, showClosed, expandedKey, onToggleRow, refreshTick }: Props) {
  const [tasks, setTasks] = useState<BeadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Action (pause/resume) state. D2 (wait-for-SSE): we never flip the chip
  // locally — a click fires the POST and shows a brief pending state; the paused
  // chip changes only when the next board re-fetch (rung by the SSE `state`
  // event) delivers fresh props, keeping state.json the single source of truth.
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // D3: resume can report the pause is cleared but no worker is running to
  // self-heal — surface that primitive's hint (the `shreni start` command) as
  // text. No inline restart button in this slice (P2a).
  const [needsStartHint, setNeedsStartHint] = useState<string | null>(null);

  // D1: a running card offers Pause; a paused OR stuck card offers Resume (ACK).
  // Pausing an already-latched Kshetra is a no-op, so a stuck card never shows Pause.
  const isPausedOrStuck = kshetra.paused === true || kshetra.stuck != null;

  useEffect(() => {
    let cancelled = false;
    const calls = [fetchTasks(token, kshetra.id)];
    if (showClosed) calls.push(fetchTasks(token, kshetra.id, 'closed'));
    Promise.all(calls)
      .then(results => {
        if (cancelled) return;
        if (results[0].error) {
          setError(results[0].error);
          setTasks([]);
          return;
        }
        setError(null);
        setTasks(results.flatMap(r => r.tasks ?? []));
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, kshetra.id, showClosed, refreshTick]);

  async function onAction() {
    // D4: the in-flight guard — ignore re-clicks while a request is pending.
    if (pending) return;
    setPending(true);
    setActionError(null);
    setNeedsStartHint(null);
    try {
      const res = await postAction(token, kshetra.id, isPausedOrStuck ? 'resume' : 'pause');
      if (res.status === 'resumed_needs_start') setNeedsStartHint(res.hint);
      // D2: intentionally NO local chip flip — the SSE `state` event drives the refresh.
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  const statusChip = kshetra.paused ? (
    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900 text-amber-300 light:bg-amber-100 light:text-amber-800">paused</span>
  ) : kshetra.phase ? (
    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 light:bg-slate-200 light:text-slate-700 font-mono">{kshetra.phase}</span>
  ) : null;

  return (
    <section className="mb-6 rounded border border-slate-800 light:border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-800 light:bg-slate-100">
        <h2 className="text-sm font-semibold text-slate-100 light:text-slate-900">{kshetra.name}</h2>
        <span className="text-xs text-slate-600 light:text-slate-400 font-mono">{kshetra.id}</span>
        {statusChip}
        {kshetra.followup ? (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-sky-900 text-sky-300 light:bg-sky-100 light:text-sky-800"
            title="beads addressing open-PR feedback"
          >
            {kshetra.followup} PR follow-up
          </span>
        ) : null}
        <CountsLine kshetra={kshetra} />
        <button
          type="button"
          onClick={onAction}
          disabled={pending}
          aria-busy={pending}
          className="ml-auto text-xs px-2 py-0.5 rounded border border-slate-600 text-slate-200 hover:bg-slate-700 light:border-slate-300 light:text-slate-700 light:hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? '…' : isPausedOrStuck ? 'Resume' : 'Pause'}
        </button>
      </div>
      {needsStartHint ? (
        <div className="px-3 py-1.5 bg-slate-800/60 border-t border-slate-700 text-xs text-slate-300 light:bg-slate-50 light:border-slate-200 light:text-slate-700">
          Resumed — no live worker to self-heal. Run <code className="font-mono text-sky-300 light:text-sky-700">{needsStartHint}</code> to restart it.
        </div>
      ) : null}
      {actionError ? (
        <div className="px-3 py-1.5 border-t border-red-800 text-xs text-red-400 light:border-red-300 light:text-red-600">
          Action failed: {actionError}
        </div>
      ) : null}
      {kshetra.stuck ? (
        <div className="px-3 py-2 bg-red-950 border-t border-red-800 text-xs text-red-200 light:bg-red-50 light:border-red-300 light:text-red-800">
          <div className="font-semibold">⚠️ STUCK — {kshetra.stuck.reason}</div>
          <pre className="mt-1 whitespace-pre-wrap text-red-300/80 light:text-red-700/80">Try:{'\n'}{kshetra.stuck.remediation}</pre>
        </div>
      ) : null}
      <div>
        {error ? (
          <div className="px-3 py-2 text-sm text-red-400 light:text-red-600">{error}</div>
        ) : tasks.length === 0 ? (
          <div className="px-3 py-2 text-sm text-slate-500">No tasks.</div>
        ) : (
          tasks.map(task => {
            const key = rowKey(kshetra.id, task.id);
            return (
              <TaskRow
                key={task.id}
                kshetraId={kshetra.id}
                task={task}
                token={token}
                expanded={expandedKey === key}
                onToggle={() => onToggleRow(expandedKey === key ? null : key)}
              />
            );
          })
        )}
      </div>
    </section>
  );
}
