// Hermetic fixture data for the Playwright E2E suite. Mirrors the response shapes
// of the real Phalaka backend (src/phalaka/api.ts zod schemas, typed in
// src/lib/types.ts) so specs run with NO live Phalaka server or bd database.
//
// The board/process/triage shapes are kept in sync with the jsdom integration
// fixtures in src/components/App.test.tsx — one blocked Kshetra with a couple of
// blocked beads so the triage feed surfaces a "needs a human" entry.

import type {
  BeadDetail,
  BeadSummary,
  KshetraSummary,
  ProcessSnapshot,
} from '../../src/lib/types';

export const KSHETRAS: KshetraSummary[] = [
  {
    id: 'sishya',
    name: 'Sishya',
    counts: { open: 1, in_progress: 0, blocked: 2, closed: 5 },
    phase: 'IDLE',
    paused: false,
  },
];

export const PROCESSES: ProcessSnapshot[] = [
  {
    kind: 'worker',
    kshetraId: 'sishya',
    pid: 69751,
    status: 'idle',
    phase: 'IDLE',
    heartbeatAgeMs: 9785,
    paused: false,
    queueDepth: 0,
  },
  { kind: 'phalaka', pid: 51338, status: 'healthy', paused: false },
];

export const TASKS: BeadSummary[] = [
  {
    id: 'sishya-1',
    title: 'A blocked bead',
    status: 'blocked',
    priority: 1,
    type: 'task',
    updatedAt: '2026-07-30',
  },
];

export const TASK_DETAIL: BeadDetail = {
  id: 'sishya-1',
  title: 'A blocked bead',
  status: 'blocked',
  priority: 1,
  type: 'task',
  updatedAt: '2026-07-30',
  createdAt: '2026-07-29',
  description: 'A bead used by the E2E fixture.',
  dependencies: [],
  blockedBy: [],
  labels: [],
};

// The default backend snapshot a spec sees unless it overrides a slice.
export interface BackendData {
  kshetras: KshetraSummary[];
  processes: ProcessSnapshot[];
  /** Task lists keyed by Kshetra id (what GET /api/kshetras/:id/tasks returns). */
  tasksByKshetra: Record<string, BeadSummary[]>;
  /** Bead details keyed by bead id (GET /api/kshetras/:id/tasks/:beadId). */
  detailsByBead: Record<string, BeadDetail>;
}

export function defaultBackendData(): BackendData {
  return {
    kshetras: KSHETRAS,
    processes: PROCESSES,
    tasksByKshetra: { sishya: TASKS },
    detailsByBead: { 'sishya-1': TASK_DETAIL },
  };
}
