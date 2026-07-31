// Streaming regression specs (Shreni-beads-zy9.2): a pushed SSE frame updates the
// UI live, and killing the stream falls back to the 10s poll (see useEventStream.ts).
//
// Drives installMockBackend directly (not the shared fixture) so each test owns a
// fresh, deep-cloned BackendData it can mutate to prove a re-fetch actually landed
// — mutating the module-level fixture consts would leak across specs.

import { test, expect } from '@playwright/test';
import { installMockBackend } from './fixtures/mock-backend';
import { defaultBackendData } from './fixtures/data';
import type { ProcessSnapshot } from '../src/lib/types';

test('a pushed `process` frame updates the process row live', async ({ page }) => {
  const sse = await installMockBackend(page, structuredClone(defaultBackendData()));
  await page.goto('/?token=e2e');

  const panel = page.locator('section', { hasText: 'Processes' });
  await expect(panel.getByText('idle', { exact: true })).toBeVisible();

  // Push the same worker slot (key worker:sishya) flipped to working with an
  // active bead — upserted onto the seeded row, no re-fetch involved.
  const working: ProcessSnapshot = {
    kind: 'worker',
    kshetraId: 'sishya',
    pid: 69751,
    status: 'working',
    phase: 'SILPI',
    heartbeatAgeMs: 200,
    paused: false,
    activeBead: { id: 'sishya-1', title: 'A blocked bead' },
    queueDepth: 0,
  };
  await sse.process(working);

  await expect(panel.getByText('working', { exact: true })).toBeVisible();
  await expect(panel.getByText('idle', { exact: true })).toBeHidden();
  await expect(panel.getByText('sishya-1')).toBeVisible(); // active bead id
});

test('an `activity` frame rings a board re-fetch that picks up changed counts', async ({ page }) => {
  const data = structuredClone(defaultBackendData());
  const sse = await installMockBackend(page, data);
  await page.goto('/?token=e2e');

  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sishya' }) });
  await expect(card.getByText('1 open · 0 active · 2 blocked · 5 closed')).toBeVisible();

  // Change what the backend will serve, then ring the doorbell: the debounced
  // re-fetch pulls the fresh counts (activity never carries the payload itself).
  data.kshetras[0].counts = { open: 7, in_progress: 1, blocked: 0, closed: 5 };
  await sse.activity();

  await expect(card.getByText('7 open · 1 active · 0 blocked · 5 closed')).toBeVisible();
});

test('dropping the stream falls back to polling and keeps the page fresh', async ({ page }) => {
  const data = structuredClone(defaultBackendData());
  const sse = await installMockBackend(page, data);
  await page.goto('/?token=e2e');

  const panel = page.locator('section', { hasText: 'Processes' });
  await expect(panel.getByText('live', { exact: true })).toBeVisible();

  // Stage a backend change, then kill the stream. The fallback poll fires once
  // immediately on the error (before the 10s interval), so the change lands fast.
  data.kshetras[0].counts = { open: 9, in_progress: 0, blocked: 2, closed: 5 };
  await sse.dropStream();

  await expect(panel.getByText('polling', { exact: true })).toBeVisible();
  await expect(panel.getByText('live', { exact: true })).toBeHidden();

  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sishya' }) });
  await expect(card.getByText('9 open · 0 active · 2 blocked · 5 closed')).toBeVisible();
});
