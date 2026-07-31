// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { KshetraCard } from './KshetraCard';
import type { KshetraSummary, ActionResponse } from '../lib/types';

// KshetraCard mounts → fetchTasks(GET) for its rows, and its Pause/Resume button
// → postAction(POST). We stub global fetch and route by method: GET → an empty
// task list; POST → a controllable action response, so we can assert the button
// gating (D1), the wait-for-SSE contract (D2 — no optimistic flip), the hint
// (D3), and the in-flight disable (D4).

const TOKEN = 'secret-token';

const BASE: KshetraSummary = {
  id: 'myapp',
  name: 'Myapp',
  counts: { open: 1, in_progress: 0, blocked: 0, closed: 0 },
  phase: 'WORKING',
  paused: false,
};

// Per-test action response + an optional gate to hold the POST open.
let actionResponse: ActionResponse;
let postGate: Promise<void> | null;
const postCalls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (method === 'POST') {
    postCalls.push({ url, init });
    const respond = () =>
      ({ ok: true, json: () => Promise.resolve(actionResponse) }) as Response;
    return postGate ? postGate.then(respond) : Promise.resolve(respond());
  }
  // fetchTasks
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ kshetraId: 'myapp', tasks: [] }) } as Response);
}

function renderCard(kshetra: KshetraSummary) {
  return render(
    <KshetraCard
      kshetra={kshetra}
      token={TOKEN}
      showClosed={false}
      expandedKey={null}
      onToggleRow={() => {}}
      refreshTick={0}
    />,
  );
}

beforeEach(() => {
  actionResponse = { status: 'paused', id: 'myapp' };
  postGate = null;
  postCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => mockFetch(input, init)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KshetraCard action button (D1: which button)', () => {
  it('a running card shows Pause', () => {
    renderCard(BASE);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('a paused card shows Resume', () => {
    renderCard({ ...BASE, paused: true, phase: undefined });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('a stuck card shows Resume (ACK), never Pause', () => {
    renderCard({
      ...BASE,
      paused: false,
      stuck: { since: '2026-07-31T00:00:00Z', reason: 'agent hung', remediation: 'shreni resume' },
    });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});

describe('KshetraCard action button (behavior)', () => {
  it('click Pause fires POST /actions/pause (token in header, not query)', async () => {
    renderCard(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]!.url).toBe('/api/kshetras/myapp/actions/pause');
    expect(postCalls[0]!.init?.method).toBe('POST');
    expect(postCalls[0]!.init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(postCalls[0]!.url).not.toContain('token=');
  });

  it('D2: does not optimistically flip the chip — the card still offers Pause after the POST resolves', async () => {
    renderCard(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    // No SSE-driven prop update in this unit, so the paused chip must NOT appear
    // and the button must NOT relabel to Resume on its own.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(screen.queryByText('paused')).toBeNull();
  });

  it('D4: the button is disabled while the request is in flight, then re-enabled', async () => {
    let release!: () => void;
    postGate = new Promise<void>(r => { release = r; });
    renderCard(BASE);
    const btn = screen.getByRole('button', { name: 'Pause' });
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
  });

  it('D3: renders the resumed_needs_start hint when the primitive reports one', async () => {
    actionResponse = { status: 'resumed_needs_start', id: 'myapp', hint: 'shreni start --kshetra myapp' };
    renderCard({ ...BASE, paused: true, phase: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.getByText('shreni start --kshetra myapp')).toBeTruthy());
  });

  it('a plain resume shows no hint', async () => {
    actionResponse = { status: 'resumed', id: 'myapp' };
    renderCard({ ...BASE, paused: true, phase: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(screen.queryByText(/shreni start/)).toBeNull();
  });

  it('surfaces an action failure instead of silently swallowing it', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return Promise.resolve({ ok: false, status: 403 } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ kshetraId: 'myapp', tasks: [] }) } as Response);
    }));
    renderCard(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByText(/Action failed/)).toBeTruthy());
  });
});
