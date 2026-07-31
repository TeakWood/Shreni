// TriageFeed regression specs (Shreni-beads-zy9.2): the fleet-wide "Needs a human"
// feed renders an entry with its severity pill, and the Copy button copies the
// entry's remediation verbatim (the seam the Phase-2 action buttons will replace).
//
// Clipboard read/write is granted so the copy assertion can read back what the
// button wrote. 127.0.0.1 is a secure context, so navigator.clipboard is present.

import { test, expect } from '@playwright/test';
import { installMockBackend } from './fixtures/mock-backend';
import { defaultBackendData } from './fixtures/data';
import type { ProcessSnapshot } from '../src/lib/types';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('a blocked Kshetra surfaces a triage entry with its severity pill + reason', async ({ page }) => {
  await installMockBackend(page, defaultBackendData());
  await page.goto('/?token=e2e');

  const feed = page.locator('section', { hasText: 'Needs a human' });
  const row = feed.locator('div').filter({ hasText: '2 beads blocked' }).first();

  // Sishya's counts carry 2 blocked → one aggregate blocked-queue entry.
  await expect(feed.getByText('Sishya')).toBeVisible();
  await expect(row.getByText('blocked', { exact: true })).toBeVisible(); // severity pill
  await expect(feed.getByText(/2 beads blocked/)).toBeVisible();
});

test('the Copy button copies the entry remediation verbatim', async ({ page }) => {
  await installMockBackend(page, defaultBackendData());
  await page.goto('/?token=e2e');

  const feed = page.locator('section', { hasText: 'Needs a human' });
  const copy = feed.getByRole('button', { name: 'Copy' });

  await copy.click();
  await expect(feed.getByRole('button', { name: 'Copied!' })).toBeVisible();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('cd <repo> && bd list --status=blocked   # see what is blocking, then unblock');
});

test('a stuck worker renders with the stuck severity pill above the blocked entry', async ({ page }) => {
  // Prepend a stuck worker so the feed carries a higher-severity entry that must
  // sort ahead of the blocked-queue one (triageSeverityRank: stuck < blocked).
  const data = defaultBackendData();
  const stuck: ProcessSnapshot = {
    kind: 'worker',
    kshetraId: 'sishya',
    pid: 4242,
    status: 'stuck',
    phase: 'REVIEW',
    paused: false,
    stuck: {
      since: '2026-07-31T00:00:00.000Z',
      reason: 'wedged in REVIEW — 3 rounds with no verdict',
      remediation: 'shreni resume --kshetra sishya',
      beadId: 'sishya-1',
    },
  };
  // Replace the idle worker rather than prepend: both share processKey
  // "worker:sishya", so a second row would just overwrite the first in the map.
  data.processes = data.processes.map(p => (p.kind === 'worker' ? stuck : p));
  await installMockBackend(page, data);
  await page.goto('/?token=e2e');

  const feed = page.locator('section', { hasText: 'Needs a human' });
  await expect(feed.getByText('wedged in REVIEW — 3 rounds with no verdict')).toBeVisible();

  // The stuck pill precedes the blocked pill in DOM order (urgency sort).
  const pills = feed.getByText(/^(stuck|blocked)$/);
  await expect(pills.first()).toHaveText('stuck');
});
