// ProcessPanel regression specs (Shreni-beads-zy9.2): the panel seeds its rows
// from GET /api/processes, and the stream-status chip reads "live" once the SSE
// stream opens. The "polling" side of the chip is covered by sse.spec.ts, which
// drops the stream and asserts the fallback.

import { test, expect } from './fixtures/mock-backend';

// `backend` must be destructured for the fixture to install the REST/SSE mocks,
// even though this test only reads REST-seeded rows.
test('process rows render from /api/processes', async ({ page, backend }) => {
  void backend;
  await page.goto('/?token=e2e');

  const panel = page.locator('section', { hasText: 'Processes' });

  // The worker row (idle) and the singleton Phalaka service row (healthy).
  await expect(panel.getByText('idle', { exact: true })).toBeVisible();
  await expect(panel.getByText('healthy', { exact: true })).toBeVisible();
  await expect(panel.getByText('pid 69751')).toBeVisible();
  await expect(panel.getByText('pid 51338')).toBeVisible();
});

test('the stream-status chip reads "live" once the SSE stream opens', async ({ page, backend }) => {
  await page.goto('/?token=e2e');
  await backend.sse.waitUntilConnected();

  const panel = page.locator('section', { hasText: 'Processes' });
  await expect(panel.getByText('live', { exact: true })).toBeVisible();
  await expect(panel.getByText('polling', { exact: true })).toBeHidden();
});
