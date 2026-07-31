// Reusable hermetic mock-backend fixture for the Phalaka Playwright suite.
//
// Two moving parts, both installed BEFORE navigation so the app never sees a real
// network:
//
//   1. REST — page.route('**/api/**') fulfils GET /api/kshetras, /api/processes,
//      /api/kshetras/:id/tasks and /api/kshetras/:id/tasks/:beadId from BackendData
//      (see ./data). The shared `?token=…` query the client appends is ignored.
//
//   2. SSE — window.EventSource is replaced (via addInitScript) with an in-page
//      mock so the stream is fully driver-controlled: no real /api/stream request
//      is ever made. The mock fires `open` on construction (so useEventStream flips
//      to 'live' and cancels its poll fallback), and exposes emit()/emitError() on
//      window.__mockSSE. The `sse` handle below pokes those from the Node side, so a
//      spec can push process/state/activity/keepalive frames — or drop the stream —
//      on demand (src/phalaka/stream.ts is the event contract being emulated).
//
// Later specs (Shreni-beads-zy9.2) import { test, expect } from this file and get a
// page with the backend already mocked, plus `sse` to drive live updates.

import { test as base, expect, type Page } from '@playwright/test';
import { type BackendData, defaultBackendData } from './data';

// Shape of the in-page EventSource mock, as seen from page.evaluate callbacks.
interface MockSse {
  emit(type: string, payload: unknown): void;
  emitError(): void;
}
declare global {
  interface Window {
    __mockSSE?: MockSse;
  }
}

// Route-intercept every /api/* REST call and answer from `data`. Query strings
// (the token, ?status=…) are stripped before matching. /api/stream is never hit
// here — EventSource is mocked in-page — but is fulfilled empty as a backstop.
export async function routeRestApi(page: Page, data: BackendData): Promise<void> {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/stream') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      return;
    }

    let body: unknown = {};
    let taskList: RegExpMatchArray | null;
    if (path === '/api/kshetras') {
      body = data.kshetras;
    } else if (path === '/api/processes') {
      body = data.processes;
    } else if ((taskList = path.match(/^\/api\/kshetras\/([^/]+)\/tasks$/))) {
      const kshetraId = decodeURIComponent(taskList[1]);
      // Honour ?status=closed exactly like the backend: the card fires a second
      // request for closed beads only when the "Show closed" toggle is on.
      const tasks =
        url.searchParams.get('status') === 'closed'
          ? (data.closedTasksByKshetra?.[kshetraId] ?? [])
          : (data.tasksByKshetra[kshetraId] ?? []);
      body = { kshetraId, tasks };
    } else {
      const detail = path.match(/^\/api\/kshetras\/([^/]+)\/tasks\/([^/]+)$/);
      if (detail) body = data.detailsByBead[decodeURIComponent(detail[2])] ?? {};
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

// Install the in-page EventSource mock. Runs in the browser on every navigation.
async function installSseMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (ev: { type: string; data: string }) => void;
    class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 0;
      onopen: Listener | null = null;
      onerror: Listener | null = null;
      onmessage: Listener | null = null;
      private readonly listeners = new Map<string, Set<Listener>>();

      constructor(public readonly url: string) {
        window.__mockSSE = {
          emit: (type: string, payload: unknown) =>
            this.dispatch(type, payload === undefined ? '' : JSON.stringify(payload)),
          emitError: () => {
            this.readyState = MockEventSource.CONNECTING;
            this.dispatch('error', '');
          },
        };
        // Open on the next tick so listeners attached synchronously after
        // construction (useEventStream adds them right away) still catch it.
        setTimeout(() => {
          this.readyState = MockEventSource.OPEN;
          this.dispatch('open', '');
        }, 0);
      }

      addEventListener(type: string, fn: Listener): void {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, (set = new Set()));
        set.add(fn);
      }
      removeEventListener(type: string, fn: Listener): void {
        this.listeners.get(type)?.delete(fn);
      }
      close(): void {
        this.readyState = MockEventSource.CLOSED;
      }

      private dispatch(type: string, data: string): void {
        const ev = { type, data };
        if (type === 'open') this.onopen?.(ev);
        else if (type === 'error') this.onerror?.(ev);
        else if (type === 'message') this.onmessage?.(ev);
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  });
}

// Node-side handle to the in-page SSE mock. Waits for construction, then pushes
// named frames matching src/phalaka/stream.ts (process/state/activity/keepalive).
export class SseController {
  constructor(private readonly page: Page) {}

  /** Resolve once the app has constructed its EventSource (stream is 'live'). */
  async waitUntilConnected(): Promise<void> {
    await this.page.waitForFunction(() => window.__mockSSE !== undefined);
  }

  async emit(type: string, payload?: unknown): Promise<void> {
    await this.waitUntilConnected();
    await this.page.evaluate(
      ({ type, payload }) => window.__mockSSE!.emit(type, payload),
      { type, payload },
    );
  }

  /** A `process` frame — one ProcessSnapshot the client upserts by kind+kshetraId. */
  process(snap: unknown): Promise<void> {
    return this.emit('process', snap);
  }
  /** A `state` frame — state.json changed; rings a debounced board re-fetch. */
  state(payload: unknown = {}): Promise<void> {
    return this.emit('state', payload);
  }
  /** An `activity` frame — a task transitioned; rings a board re-fetch. */
  activity(payload: unknown = {}): Promise<void> {
    return this.emit('activity', payload);
  }
  /** A `keepalive` ping (no handler client-side; holds the stream open). */
  keepalive(): Promise<void> {
    return this.emit('keepalive', { t: '2026-07-31T00:00:00.000Z' });
  }
  /** Drop the stream — the client flips to 'polling' and starts its poll. */
  async dropStream(): Promise<void> {
    await this.waitUntilConnected();
    await this.page.evaluate(() => window.__mockSSE!.emitError());
  }
}

// Set up the whole hermetic backend (REST + SSE) on a page. Call before goto.
export async function installMockBackend(
  page: Page,
  data: BackendData = defaultBackendData(),
): Promise<SseController> {
  await installSseMock(page);
  await routeRestApi(page, data);
  return new SseController(page);
}

// Playwright fixture: every spec that imports { test } from here gets a `backend`
// (the mocked BackendData + a `sse` controller). Override the data per-test by
// re-calling installMockBackend, or start from this default.
interface Fixtures {
  backendData: BackendData;
  backend: { data: BackendData; sse: SseController };
}

export const test = base.extend<Fixtures>({
  // Override in a spec with test.use({ backendData: {...} }) for custom fixtures.
  backendData: async ({}, use) => {
    await use(defaultBackendData());
  },
  backend: async ({ page, backendData }, use) => {
    const sse = await installMockBackend(page, backendData);
    await use({ data: backendData, sse });
  },
});

export { expect };
