import type { PlanningSession } from '../lib/types';
import {
  formatCost,
  formatTokens,
  planningKey,
  planningPhaseClass,
  planningPhaseLabel,
} from '../lib/format';

interface Props {
  sessions: PlanningSession[];
  error: string | null;
}

function PlanningRow({ s }: { s: PlanningSession }) {
  const totalTokens = s.inputTokens + s.outputTokens;
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-800 light:border-slate-200">
      <span className={'px-2 py-0.5 rounded text-xs font-medium ' + planningPhaseClass(s.phase)}>
        {planningPhaseLabel(s.phase)}
      </span>
      {s.running ? (
        <span className="text-xs text-emerald-400 light:text-emerald-600" title="session is live">● live</span>
      ) : null}
      <span className="flex-1 text-sm text-slate-200 light:text-slate-800">{s.kshetraId}</span>
      {s.epicId ? (
        <span className="text-xs text-slate-400 light:text-slate-600 font-mono" title={s.summary ?? s.epicId}>
          {s.epicId}
        </span>
      ) : null}
      {/* Token total + cost. A running session that hasn't been metered yet shows
          a dash rather than a misleading $0.00. */}
      {s.usageRecorded ? (
        <>
          <span className="text-xs text-slate-500" title="input + output tokens">
            {formatTokens(totalTokens)} tok
          </span>
          <span className="text-xs text-slate-400 light:text-slate-600 font-mono" title="recovered session cost">
            {formatCost(s.costUsd, s.priced)}
          </span>
        </>
      ) : (
        <span className="text-xs text-slate-600 light:text-slate-400" title="not metered yet">—</span>
      )}
      <span className="text-xs text-slate-600 light:text-slate-400 font-mono" title={s.sessionId}>
        {s.sessionId.slice(-6)}
      </span>
    </div>
  );
}

// The Suthradhara planning-session panel (fnd.5). Rows are seeded and kept fresh
// by the same activity doorbell that refreshes the board — a launched / just-ended
// session appears here with its lifecycle phase and recovered token cost. Hidden
// entirely when no planning has ever run, so it adds no noise to a fleet that
// only executes.
export function PlanningSessionPanel({ sessions, error }: Props) {
  if (!error && sessions.length === 0) return null;
  return (
    <section className="mb-6 rounded border border-slate-800 light:border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-800 light:bg-slate-100">
        <h2 className="text-sm font-semibold text-slate-100 light:text-slate-900">Planning sessions</h2>
        <span className="text-xs text-slate-500">Suthradhara</span>
      </div>
      <div>
        {error ? (
          <div className="px-3 py-2 text-sm text-red-400 light:text-red-600">{error}</div>
        ) : (
          sessions.map(s => <PlanningRow key={planningKey(s)} s={s} />)
        )}
      </div>
    </section>
  );
}
