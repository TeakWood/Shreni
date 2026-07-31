// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { App } from './App';

// Integration smoke test: mount the whole App against a mocked backend and assert
// the board, process panel and triage feed render the fetched data end-to-end.
// jsdom has no EventSource, so the App exercises its poll-fallback path here.

const KSHETRAS = [
  {
    id: 'sishya',
    name: 'Sishya',
    counts: { open: 1, in_progress: 0, blocked: 2, closed: 5 },
    phase: 'IDLE',
    paused: false,
  },
];
const PROCESSES = [
  { kind: 'worker', kshetraId: 'sishya', pid: 69751, status: 'idle', phase: 'IDLE', heartbeatAgeMs: 9785, paused: false, queueDepth: 0 },
  { kind: 'phalaka', pid: 51338, status: 'healthy', paused: false },
];
const TASKS = [
  { id: 'sishya-1', title: 'A blocked bead', status: 'blocked', priority: 1, type: 'task', updatedAt: '2026-07-30' },
];

function mockFetch(url: string): Promise<Response> {
  const path = url.split('?')[0];
  let body: unknown = {};
  if (path === '/api/kshetras') body = KSHETRAS;
  else if (path === '/api/processes') body = PROCESSES;
  else if (path.endsWith('/tasks')) body = { kshetraId: 'sishya', tasks: TASKS };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => mockFetch(String(input))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App integration', () => {
  it('renders the shell, board, process rows and derived triage from fetched data', async () => {
    render(<App />);

    // Shell
    expect(screen.getByText('Phalaka')).toBeTruthy();

    // Board: the Kshetra card (name appears in the card head AND the triage entry)
    // + its lazily-listed task row.
    await waitFor(() => expect(screen.getAllByText('Sishya').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('A blocked bead')).toBeTruthy());
    // Interpolated counts render as several text nodes — assert on concatenated text.
    expect(document.body.textContent).toContain('1 open · 0 active · 2 blocked · 5 closed');

    // Process panel: both process rows (worker + phalaka service)
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(document.body.textContent).toContain('pid 69751');

    // Triage: 2 blocked beads → one blocked entry surfaces "needs a human"
    expect(screen.getByText('Needs a human')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/2 beads blocked/)).toBeTruthy());
  });
});
