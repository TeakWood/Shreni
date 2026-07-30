import { statSync } from 'fs';
import type { KshetraConfig } from '../kshetra/config.js';
import { loadRegistry } from '../kshetra/registry.js';
import { loadState } from '../kshetra/state.js';
import { readPid, isAlive, workerPidPath } from '../cli/pid.js';
import { heartbeatPath } from '../sthapathi/activity-log.js';
import { STUCK_THRESHOLD_MS } from '../sthapathi/watchdog.js';
import { readPhalakaPid } from './pid.js';
import { readSuthradharaPid } from '../suthradhara/pid.js';

// Process snapshot read layer for the Phalaka control plane (observe-only).
// Enumerates every long-lived Shreni process across all Kshetras — workers,
// Phalaka, Suthradhara sessions — purely from the files the fleet already writes
// (registry.json, worker.pid + heartbeat mtime, state.json, phalaka.pid,
// suthradhara.pid), and derives a single health status per process per
// docs/ard/Shreni-ARD-Control-Plane.md §4.3.
//
// This layer is file-only and synchronous: it never calls `bd`. The bead-derived
// enrichment (activeBead / queueDepth) comes from assembleKshetraStatus() and is
// merged in by the /api/processes endpoint (bead 6gd.3) — kept out of here so the
// status derivation stays fast and table-testable without mocking bd.

export type ProcessKind = 'worker' | 'phalaka' | 'suthradhara';

export type ProcessStatus =
  | 'working'
  | 'idle'
  | 'paused-manual'
  | 'stuck'
  | 'stale-heartbeat'
  | 'dead'
  | 'healthy';

export interface ProcessSnapshot {
  kind: ProcessKind;
  kshetraId?: string;
  pid: number;
  status: ProcessStatus;
  phase?: string;
  heartbeatAgeMs?: number;
  paused: boolean;
  stuck?: { since: string; reason: string; remediation: string; phase?: string; beadId?: string };
  // Enriched by the /api/processes endpoint via assembleKshetraStatus() — never
  // populated here (this layer does not call bd).
  activeBead?: { id: string; title: string; agent?: string; round?: number };
  queueDepth?: number;
  lastProgressAt?: string;
}

// A worker in a non-IDLE phase stamps its heartbeat every 30s (activity-log.ts).
// A busy worker silent longer than this — but not yet at the watchdog's 20-min
// escalation — is flagged `stale-heartbeat` as an early warning. Deliberately
// below STUCK_THRESHOLD_MS so the two windows don't overlap.
export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

// The raw file-derived signals for one worker, isolated from I/O so the status
// derivation is a pure, table-testable function (ADR §4.3 / §4.4).
export interface WorkerStatusSignals {
  // process.kill(pid, 0) against the worker.pid — the OS says a process with this
  // pid exists. NOT proof it is *our* worker: a crashed worker's pid can be reused.
  pidAlive: boolean;
  phase?: string;
  // Age of the heartbeat file's mtime; null when no heartbeat file exists yet.
  heartbeatAgeMs: number | null;
  // Age of the worker.pid mtime (≈ worker start time); the fallback liveness clock
  // when the worker has never stamped a heartbeat, and the cross-check that stops a
  // reused OS pid from reading as a live worker (ADR §4.4).
  pidAgeMs: number | null;
  paused: boolean;
  reason?: string;
  requiresManualResume?: boolean;
  // A watchdog stuck marker is present in state.json.
  stuck: boolean;
  thresholds?: { staleMs?: number; deadMs?: number };
}

// Pure status derivation for a worker (ADR §4.3). Order encodes precedence:
// liveness first, then the watchdog's own escalations, then heartbeat freshness.
export function deriveWorkerStatus(s: WorkerStatusSignals): ProcessStatus {
  const staleMs = s.thresholds?.staleMs ?? STALE_HEARTBEAT_MS;
  const deadMs = s.thresholds?.deadMs ?? STUCK_THRESHOLD_MS;
  const busy = s.phase !== undefined && s.phase !== 'IDLE';
  // Silence clock: prefer the heartbeat mtime; fall back to the pidfile mtime when
  // the worker has never beaten (so a fresh worker reads young, an orphan old).
  const silenceMs = s.heartbeatAgeMs ?? s.pidAgeMs;

  // The OS pid is gone → the worker crashed/was killed, leaving a stale pidfile.
  if (!s.pidAlive) return 'dead';

  // Watchdog already escalated. Wins over paused-manual because a stuck worker is
  // *also* paused+requiresManualResume (reason:'stuck'); the marker is the honest
  // signal that a human is needed, not that a human deliberately paused it.
  if (s.stuck) return 'stuck';

  // A deliberate `shreni pause` (reason:'manual'), distinct from a watchdog pause.
  if (s.paused && (s.reason === 'manual' || s.requiresManualResume)) return 'paused-manual';

  // Reused-PID / wedged-loop guard (ADR §4.4): the OS reports the pid alive, but a
  // busy worker silent past the point its own watchdog would have set a stuck marker
  // (and none is set) is not really our worker — the pid was recycled after a crash,
  // or the event loop is fully wedged so the watchdog never ran. Either way it is not
  // "working"; treat as dead so a recycled pid never reads as live.
  if (busy && silenceMs !== null && silenceMs >= deadMs) return 'dead';

  // Busy but liveness has gone stale before the watchdog's escalation window.
  if (busy && silenceMs !== null && silenceMs > staleMs) return 'stale-heartbeat';

  // Busy and beating.
  if (busy) return 'working';

  // phase IDLE (or not yet recorded): idle by design — nothing to do. The watchdog
  // never trips an empty-queue worker, so no stuck marker is the proof this is safe;
  // this is the key idle-vs-stuck separation (ADR §4.3).
  return 'idle';
}

// Phalaka / Suthradhara have no phase or heartbeat — liveness is the whole story.
export function deriveServiceStatus(pidAlive: boolean): ProcessStatus {
  return pidAlive ? 'healthy' : 'dead';
}

function ageOf(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Enumerate every long-lived Shreni process across the fleet with its derived
// status. File-only and synchronous — safe to call on a fast liveness poll. A row
// is emitted only for a process that has a pidfile (i.e. is running or crashed);
// a cleanly-stopped Kshetra contributes no worker row.
export function readProcessSnapshots(now: number = Date.now()): ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  const state = loadState();

  let configs: KshetraConfig[];
  try {
    configs = loadRegistry();
  } catch {
    configs = [];
  }

  // Workers — one per registered Kshetra with a worker.pid present.
  for (const cfg of configs) {
    const pid = readPid(cfg.id);
    if (pid === null) continue;

    const ks = state.kshetras[cfg.id];
    const heartbeatAgeMs = ageOf(heartbeatPath(cfg.id), now);
    const pidAgeMs = ageOf(workerPidPath(cfg.id), now);

    const status = deriveWorkerStatus({
      pidAlive: isAlive(pid),
      phase: ks?.phase,
      heartbeatAgeMs,
      pidAgeMs,
      paused: ks?.paused ?? false,
      reason: ks?.reason,
      requiresManualResume: ks?.requiresManualResume,
      stuck: !!ks?.stuck,
      // Align the dead ceiling with when this Kshetra's watchdog would have
      // escalated, so stale-heartbeat → dead hands off exactly at that boundary.
      thresholds: { deadMs: cfg.watchdog?.stuckThresholdMs ?? STUCK_THRESHOLD_MS },
    });

    snapshots.push({
      kind: 'worker',
      kshetraId: cfg.id,
      pid,
      status,
      phase: ks?.phase,
      heartbeatAgeMs: heartbeatAgeMs ?? undefined,
      paused: ks?.paused ?? false,
      stuck: ks?.stuck,
      lastProgressAt: ks?.lastProgressAt,
    });
  }

  // Phalaka dashboard server (singleton).
  const phalakaPid = readPhalakaPid();
  if (phalakaPid !== null) {
    snapshots.push({
      kind: 'phalaka',
      pid: phalakaPid,
      status: deriveServiceStatus(isAlive(phalakaPid)),
      paused: false,
    });
  }

  // Suthradhara interview sessions — one per Kshetra holding a session pidfile.
  for (const cfg of configs) {
    const sPid = readSuthradharaPid(cfg.id);
    if (sPid === null) continue;
    snapshots.push({
      kind: 'suthradhara',
      kshetraId: cfg.id,
      pid: sPid,
      status: deriveServiceStatus(isAlive(sPid)),
      paused: false,
    });
  }

  return snapshots;
}
