import { useEffect, useState } from 'react';
import type { BeadSummary, KshetraSummary } from '../lib/types';
import { fetchTasks } from '../api/client';
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
      </div>
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
