// The one green smoke spec for the scaffold (Shreni-beads-zy9.1): the app shell
// and board render in a real chromium against the route-mocked backend, with no
// live Phalaka server or bd DB. The full regression suite lands in zy9.2.

import { test, expect } from './fixtures/mock-backend';

test('app shell + board render against the mocked backend', async ({ page, backend }) => {
  // `backend` fixture has already installed the REST + SSE mocks; navigate with a
  // token in the query the way the real Phalaka link does.
  await page.goto('/?token=e2e');

  // Shell header.
  await expect(page.getByRole('heading', { name: 'Phalaka' })).toBeVisible();

  // Board: the mocked Kshetra card renders (name appears in the card head).
  await expect(page.getByText('Sishya').first()).toBeVisible();
  await expect(page.getByText('1 open · 0 active · 2 blocked · 5 closed')).toBeVisible();

  // The SSE mock connected — useEventStream flipped to 'live' (no poll fallback).
  await backend.sse.waitUntilConnected();
});
