// Board regression specs (Shreni-beads-zy9.2): a Kshetra card renders its counts
// line; a task row lazy-loads its detail on first open (and only once); the board's
// fleet-wide selection keeps one row open at a time across cards; and the header
// "Show closed" toggle pulls the closed-bead list.
//
// These use a two-Kshetra fixture (Sishya + Guru), so they drive installMockBackend
// directly with fresh data rather than the shared default-data fixture.

import { test, expect } from '@playwright/test';
import { installMockBackend } from './fixtures/mock-backend';
import { boardBackendData } from './fixtures/data';

test('Kshetra card renders with its counts line', async ({ page }) => {
  await installMockBackend(page, boardBackendData());
  await page.goto('/?token=e2e');

  // Scope to the Kshetra card by its heading — "Sishya" also appears as the
  // TriageFeed entry label, so a bare section-hasText match is ambiguous.
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sishya' }) });
  await expect(card.getByRole('heading', { name: 'Sishya' })).toBeVisible();
  await expect(card.getByText('1 open · 0 active · 2 blocked · 5 closed')).toBeVisible();
});

test('a task row lazy-loads its detail on first expand, and fetches it only once', async ({ page }) => {
  await installMockBackend(page, boardBackendData());

  // Count how many times the detail endpoint for sishya-1 is actually hit.
  let detailFetches = 0;
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/kshetras/sishya/tasks/sishya-1') detailFetches++;
  });

  await page.goto('/?token=e2e');

  const row = page.getByText('A blocked bead');
  await expect(row).toBeVisible();
  // Detail is NOT fetched until the row is opened.
  expect(detailFetches).toBe(0);
  await expect(page.getByText('A bead used by the E2E fixture.')).toBeHidden();

  // First open → one fetch, detail shows.
  await row.click();
  await expect(page.getByText('A bead used by the E2E fixture.')).toBeVisible();
  expect(detailFetches).toBe(1);

  // Collapse then re-open → detail is cached, no second fetch.
  await row.click();
  await expect(page.getByText('A bead used by the E2E fixture.')).toBeHidden();
  await row.click();
  await expect(page.getByText('A bead used by the E2E fixture.')).toBeVisible();
  expect(detailFetches).toBe(1);
});

test('opening a row in one card collapses the open row in another (one at a time)', async ({ page }) => {
  await installMockBackend(page, boardBackendData());
  await page.goto('/?token=e2e');

  const sishyaDetail = page.getByText('A bead used by the E2E fixture.');
  const guruDetail = page.getByText('Guru fixture detail — distinct from the Sishya bead.');

  // Open the Sishya bead.
  await page.getByText('A blocked bead').click();
  await expect(sishyaDetail).toBeVisible();

  // Opening the Guru bead collapses Sishya's row — only one detail open fleet-wide.
  await page.getByText('A guru bead').click();
  await expect(guruDetail).toBeVisible();
  await expect(sishyaDetail).toBeHidden();
});

test('the "Show closed" toggle pulls the closed-bead list', async ({ page }) => {
  await installMockBackend(page, boardBackendData());
  await page.goto('/?token=e2e');

  const closed = page.getByText('A closed bead');
  // Active beads only until the toggle is on.
  await expect(page.getByText('A blocked bead')).toBeVisible();
  await expect(closed).toBeHidden();

  await page.getByLabel('Show closed').check();
  await expect(closed).toBeVisible();

  // Toggling back off drops the closed bead again.
  await page.getByLabel('Show closed').uncheck();
  await expect(closed).toBeHidden();
});
