import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './client';
import type { ProcessSnapshot } from '../lib/types';

export type StreamStatus = 'connecting' | 'live' | 'polling';

export interface EventStreamHandlers {
  /** A `process` SSE frame — one process snapshot to upsert. */
  onProcessEvent: (snap: ProcessSnapshot) => void;
  /** `state` / `activity` frames — debounced doorbell to re-fetch the board. */
  onBoardChange: () => void;
  /** Fallback poll tick — refresh the WHOLE page (board + processes) as one unit. */
  onPoll: () => void;
}

// Re-implements the old vanilla bootstrap's one-channel SSE wiring as a hook:
//
//   * ONE EventSource('/api/stream') drives the whole page.
//   * `process` frames upsert the process panel live.
//   * `state` / `activity` frames ring a 300ms-debounced board re-fetch, so a
//     burst drained in one server tick coalesces into a single rebuild.
//   * A 10s poll runs ONLY while the stream is down (no EventSource, connect
//     throw, or after an `error`), and stops the instant `open` fires — never a
//     live stream and a poll at once.
//   * `keepalive` frames need no handler; they just hold the connection open.
//
// Handlers are read through a ref so identity changes never tear down the stream.
export function useEventStream(token: string, handlers: EventStreamHandlers): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let boardDebounce: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const POLL_MS = 10000;

    function refreshBoardSoon() {
      if (boardDebounce) return;
      boardDebounce = setTimeout(() => {
        boardDebounce = null;
        handlersRef.current.onBoardChange();
      }, 300);
    }

    function pollOnce() {
      handlersRef.current.onPoll();
    }
    function startPoll() {
      if (pollTimer || closed) return;
      pollOnce();
      pollTimer = setInterval(pollOnce, POLL_MS);
    }
    function stopPoll() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    // No EventSource (old browser) → straight to the poll fallback.
    if (typeof window === 'undefined' || !window.EventSource) {
      setStatus('polling');
      startPoll();
      return () => stopPoll();
    }

    let es: EventSource;
    try {
      es = new EventSource(apiUrl('/api/stream', token));
    } catch {
      setStatus('polling');
      startPoll();
      return () => stopPoll();
    }

    es.addEventListener('open', () => {
      // Stream is live — cancel the fallback poll; SSE now drives the whole page.
      setStatus('live');
      stopPoll();
    });
    es.addEventListener('process', (e: MessageEvent) => {
      try {
        handlersRef.current.onProcessEvent(JSON.parse(e.data) as ProcessSnapshot);
      } catch {
        /* a corrupt frame never breaks the panel */
      }
    });
    // state.json changed (phase / paused / stuck / counts) — doorbell to re-fetch
    // the richer /api/kshetras, not a direct apply of the raw payload.
    es.addEventListener('state', () => refreshBoardSoon());
    // A task transitioned (claimed / done / synced) — re-fetch the affected board.
    es.addEventListener('activity', () => refreshBoardSoon());
    es.addEventListener('error', () => {
      // Stream dropped. EventSource auto-reconnects; poll meanwhile so the whole
      // page keeps refreshing until `open` fires again and stops the poll.
      setStatus('polling');
      startPoll();
    });

    return () => {
      closed = true;
      es.close();
      stopPoll();
      if (boardDebounce) clearTimeout(boardDebounce);
    };
  }, [token]);

  return status;
}
