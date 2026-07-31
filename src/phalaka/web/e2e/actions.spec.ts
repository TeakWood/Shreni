// Control-plane action E2E (Shreni-beads-8jo.4): the pause/resume buttons on a
// KshetraCard, end-to-end against the hermetic mock backend (the zy9 pattern).
//
// The real control loop is: click → POST (header token) → state.json write →
// SSE `state` frame → board re-fetch → card re-renders. We reproduce it exactly:
// the POST is route-intercepted (asserting the token rides in the Authorization
// HEADER, never the query string), its handler mutates the mocked board's
// `paused` flag to stand in for the state.json write, and the spec then pushes an
// SSE `state` frame so the card flips only via the re-fetch — proving D2
// (wait-for-SSE, no optimistic mutation). No live Phalaka server or bd DB.

import { test, expect, type Page } from '@playwright/test';
import { installMockBackend, SseController } from './fixtures/mock-backend';
import { defaultBackendData, type BackendData } from './fixtures/data';

interface ActionCall {
  method: string;
  path: string;
  search: string;
  authorization: string | undefined;
}

// Intercept the two POST action routes. Registered AFTER installMockBackend so it
// wins over the generic `**/api/**` handler for these paths. Records each call for
// header assertions and mutates `data` (the state.json write stand-in) so the
// subsequent SSE-driven board re-fetch observes the new paused state.
async function routeActions(
  page: Page,
  data: BackendData,
  log: ActionCall[],
  resumeBody: (id: string) => unknown = id => ({ status: 'resumed', id }),
): Promise<void> {
  await page.route('**/api/kshetras/*/actions/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const m = url.pathname.match(/^\/api\/kshetras\/([^/]+)\/actions\/(pause|resume)$/)!;
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    log.push({
      method: req.method(),
      path: url.pathname,
      search: url.search,
      authorization: req.headers()['authorization'],
    });
    const ks = data.kshetras.find(k => k.id === id)!;
    let body: unknown;
    if (action === 'pause') {
      ks.paused = true;
      body = { status: 'paused', id };
    } else {
      ks.paused = false;
      body = resumeBody(id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function sishyaCard(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sishya' }) });
}

test('Pause then Resume: card transitions running↔paused via the SSE state flip', async ({ page }) => {
  const data = structuredClone(defaultBackendData());
  const log: ActionCall[] = [];
  const sse: SseController = await installMockBackend(page, data);
  await routeActions(page, data, log);
  await page.goto('/?token=e2e');

  const card = sishyaCard(page);
  // Running card → Pause offered, no paused chip yet.
  await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(card.getByText('paused', { exact: true })).toBeHidden();

  // ── Pause ──────────────────────────────────────────────────────────────────
  await card.getByRole('button', { name: 'Pause' }).click();

  // The POST fired with the token in the Authorization header, not the URL.
  await expect.poll(() => log.length).toBe(1);
  expect(log[0]).toMatchObject({ method: 'POST', path: '/api/kshetras/sishya/actions/pause', search: '' });
  expect(log[0].authorization).toBe('Bearer e2e');

  // D2: the card must NOT have flipped yet — no SSE frame has arrived.
  await expect(card.getByText('paused', { exact: true })).toBeHidden();

  // state.json "changed" (the route mutated `data`); ring the SSE doorbell → the
  // debounced board re-fetch pulls paused:true and the chip flips.
  await sse.state();
  await expect(card.getByText('paused', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Resume' })).toBeVisible();

  // ── Resume ───────────────────────────────────────────────────────────────────
  await card.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => log.length).toBe(2);
  expect(log[1]).toMatchObject({ method: 'POST', path: '/api/kshetras/sishya/actions/resume', search: '' });
  expect(log[1].authorization).toBe('Bearer e2e');

  await sse.state();
  await expect(card.getByText('paused', { exact: true })).toBeHidden();
  await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('Resume reporting resumed_needs_start renders the restart hint', async ({ page }) => {
  const data = structuredClone(defaultBackendData());
  data.kshetras[0].paused = true; // start paused → the card offers Resume
  data.kshetras[0].phase = undefined;
  const log: ActionCall[] = [];
  await installMockBackend(page, data);
  await routeActions(page, data, log, id => ({
    status: 'resumed_needs_start',
    id,
    hint: `shreni start --kshetra ${id}`,
  }));
  await page.goto('/?token=e2e');

  const card = sishyaCard(page);
  await card.getByRole('button', { name: 'Resume' }).click();

  // D3: the primitive's hint (the `shreni start` command) is surfaced as text —
  // this is client state from the POST body, so it shows without any SSE frame.
  await expect(card.getByText('shreni start --kshetra sishya')).toBeVisible();
  expect(log[0].authorization).toBe('Bearer e2e');
});
