import type { ProcessSnapshot } from '../lib/types';
import type { StreamStatus } from '../api/useEventStream';
import { formatAge, processKey, processLabel, processStatusPillClass } from '../lib/format';

interface Props {
  processes: ProcessSnapshot[];
  streamStatus: StreamStatus;
  error: string | null;
}

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: 'connecting…',
  live: 'live',
  polling: 'polling',
};

function ProcessRow({ snap }: { snap: ProcessSnapshot }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-800">
      <span className={'px-2 py-0.5 rounded text-xs font-medium ' + processStatusPillClass(snap.status)}>
        {snap.status}
      </span>
      <span className="text-xs text-slate-500 font-mono">{snap.kind}</span>
      <span className="flex-1 text-sm text-slate-200">{processLabel(snap)}</span>
      {snap.activeBead ? (
        <span className="text-xs text-slate-400 font-mono" title={snap.activeBead.title}>
          {snap.activeBead.id}
        </span>
      ) : null}
      {snap.phase ? (
        <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">{snap.phase}</span>
      ) : null}
      {snap.heartbeatAgeMs !== undefined && snap.heartbeatAgeMs !== null ? (
        <span className="text-xs text-slate-500" title="heartbeat age">
          ♥ {formatAge(snap.heartbeatAgeMs)}
        </span>
      ) : null}
      <span className="text-xs text-slate-600 font-mono">pid {snap.pid}</span>
    </div>
  );
}

// The control-plane process panel. Rows are seeded by /api/processes and kept
// fresh by `process` SSE frames; the stream-status chip reflects live vs polling.
export function ProcessPanel({ processes, streamStatus, error }: Props) {
  return (
    <section className="mb-6 rounded border border-slate-800 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-800">
        <h2 className="text-sm font-semibold text-slate-100">Processes</h2>
        <span className={'text-xs ' + (streamStatus === 'live' ? 'text-emerald-400' : 'text-slate-500')}>
          {STREAM_LABEL[streamStatus]}
        </span>
      </div>
      <div>
        {error ? (
          <div className="px-3 py-2 text-sm text-red-400">{error}</div>
        ) : processes.length === 0 ? (
          <div className="px-3 py-2 text-sm text-slate-500">No processes.</div>
        ) : (
          processes.map(snap => <ProcessRow key={processKey(snap)} snap={snap} />)
        )}
      </div>
    </section>
  );
}
