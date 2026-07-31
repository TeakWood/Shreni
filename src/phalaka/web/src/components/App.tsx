import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KshetraSummary, ProcessSnapshot } from '../lib/types';
import { processKey } from '../lib/format';
import { collectTriageEntries } from '../lib/triage';
import { fetchKshetras, fetchProcesses, readToken } from '../api/client';
import { useEventStream } from '../api/useEventStream';
import { Board } from './Board';
import { ProcessPanel } from './ProcessPanel';
import { TriageFeed } from './TriageFeed';
import { useTheme } from './useTheme';

type ProcMap = Record<string, ProcessSnapshot>;

// Carry forward the bead enrichment (activeBead/queueDepth) that the file-only
// SSE payloads omit, so a live status flip never blanks it (mirrors upsertProcess).
function upsert(map: ProcMap, snap: ProcessSnapshot): ProcMap {
  const key = processKey(snap);
  const prev = map[key];
  const merged: ProcessSnapshot =
    prev
      ? {
          ...snap,
          activeBead: snap.activeBead ?? prev.activeBead,
          queueDepth: snap.queueDepth ?? prev.queueDepth,
        }
      : snap;
  return { ...map, [key]: merged };
}

export function App() {
  const token = useMemo(() => readToken(), []);
  const [kshetras, setKshetras] = useState<KshetraSummary[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [processes, setProcesses] = useState<ProcMap>({});
  const [processError, setProcessError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [theme, toggleTheme] = useTheme();
  // Bumped on every board (re)load so KshetraCards re-pull their task lists.
  const [refreshTick, setRefreshTick] = useState(0);

  const loadBoard = useCallback(() => {
    return fetchKshetras(token)
      .then(list => {
        setKshetras(list);
        setBoardError(null);
        setRefreshTick(t => t + 1);
      })
      .catch(e => setBoardError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const loadProcesses = useCallback(() => {
    return fetchProcesses(token)
      .then(list => {
        const map: ProcMap = {};
        for (const snap of list) map[processKey(snap)] = snap;
        setProcesses(map);
        setProcessError(null);
      })
      .catch(e => setProcessError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const onProcessEvent = useCallback((snap: ProcessSnapshot) => {
    setProcesses(prev => upsert(prev, snap));
  }, []);

  const onPoll = useCallback(() => {
    loadBoard();
    loadProcesses();
  }, [loadBoard, loadProcesses]);

  const streamStatus = useEventStream(token, {
    onProcessEvent,
    onBoardChange: loadBoard,
    onPoll,
  });

  // Initial paint before the stream opens (matches the old bootstrap ordering).
  useEffect(() => {
    loadBoard();
    loadProcesses();
  }, [loadBoard, loadProcesses]);

  const processList = useMemo(
    () => Object.keys(processes).sort().map(k => processes[k]),
    [processes],
  );
  const triageEntries = useMemo(
    () => collectTriageEntries(processList, kshetras),
    [processList, kshetras],
  );

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 px-4 py-3 bg-slate-900 border-b border-slate-700 light:bg-white light:border-slate-200">
        <h1 className="text-lg font-semibold text-slate-100 light:text-slate-900">Phalaka</h1>
        <span className="text-xs text-slate-500">per-Kshetra task board</span>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400 light:text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              className="accent-slate-500"
              checked={showClosed}
              onChange={e => setShowClosed(e.target.checked)}
            />
            Show closed
          </label>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 light:border-slate-300 light:text-slate-700 light:hover:bg-slate-100"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle color theme"
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>
      <main className="px-4 py-4 max-w-4xl mx-auto">
        <TriageFeed entries={triageEntries} />
        <ProcessPanel processes={processList} streamStatus={streamStatus} error={processError} />
        <Board
          kshetras={kshetras}
          token={token}
          showClosed={showClosed}
          error={boardError}
          refreshTick={refreshTick}
        />
      </main>
    </div>
  );
}
