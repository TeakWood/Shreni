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

// A closed bead for `sishya`, served only for GET …/tasks?status=closed — the
// request the card fires when "Show closed" is toggled on.
export const CLOSED_TASKS: BeadSummary[] = [
  {
    id: 'sishya-9',
    title: 'A closed bead',
    status: 'closed',
    priority: 2,
    type: 'task',
    updatedAt: '2026-07-28',
  },
];

// A second, healthy Kshetra so a spec can prove the board's fleet-wide
// "one expanded row at a time" selection collapses a row in another card.
export const GURU: KshetraSummary = {
  id: 'guru',
  name: 'Guru',
  counts: { open: 1, in_progress: 0, blocked: 0, closed: 0 },
  phase: 'IDLE',
  paused: false,
};

export const GURU_TASKS: BeadSummary[] = [
  {
    id: 'guru-1',
    title: 'A guru bead',
    status: 'open',
    priority: 3,
    type: 'task',
    updatedAt: '2026-07-30',
  },
];

export const GURU_TASK_DETAIL: BeadDetail = {
  id: 'guru-1',
  title: 'A guru bead',
  status: 'open',
  priority: 3,
  type: 'task',
  updatedAt: '2026-07-30',
  createdAt: '2026-07-29',
  description: 'Guru fixture detail — distinct from the Sishya bead.',
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
  /** Closed-bead lists keyed by Kshetra id (GET …/tasks?status=closed). */
  closedTasksByKshetra?: Record<string, BeadSummary[]>;
  /** Bead details keyed by bead id (GET /api/kshetras/:id/tasks/:beadId). */
  detailsByBead: Record<string, BeadDetail>;
}

export function defaultBackendData(): BackendData {
  return {
    kshetras: KSHETRAS,
    processes: PROCESSES,
    tasksByKshetra: { sishya: TASKS },
    closedTasksByKshetra: { sishya: CLOSED_TASKS },
    detailsByBead: { 'sishya-1': TASK_DETAIL },
  };
}

// A two-Kshetra board (Sishya + Guru), each with one active task and its detail,
// plus a closed bead behind the toggle for Sishya. Used by the board specs to
// exercise cross-card row selection and the show-closed toggle.
export function boardBackendData(): BackendData {
  return {
    kshetras: [KSHETRAS[0], GURU],
    processes: PROCESSES,
    tasksByKshetra: { sishya: TASKS, guru: GURU_TASKS },
    closedTasksByKshetra: { sishya: CLOSED_TASKS },
    detailsByBead: { 'sishya-1': TASK_DETAIL, 'guru-1': GURU_TASK_DETAIL },
  };
}
