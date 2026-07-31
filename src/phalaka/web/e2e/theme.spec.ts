// Theme regression specs (Shreni-beads-zy9.2) — the exact behaviour this epic was
// created to guard. The header toggle flips <html data-theme> dark↔light, the
// `light:` Tailwind variant repaints (header bg-slate-900 → light:bg-white), and
// the choice PERSISTS across a full page reload (the head script in index.html
// applies the stored theme before first paint).
//
// Two independent signals are asserted so both halves of the theming stay honest:
//   • body background — driven by the --bg var in index.css (:root[data-theme]).
//     Authored as hex, so getComputedStyle returns a stable rgb() to match on.
//   • header background — driven by the Tailwind `light:bg-white` override. Its
//     computed value is format-sensitive (Tailwind v4 emits oklch), so we assert
//     it *changes* rather than matching a literal; deleting the override makes the
//     two themes' header colour equal and fails the check.

import { test, expect, type Page } from '@playwright/test';

const DARK_BODY = 'rgb(15, 23, 42)'; // --bg slate-900
const LIGHT_BODY = 'rgb(248, 250, 252)'; // --bg slate-50

const bodyBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const headerBg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('header')!).backgroundColor);

test('the header toggle flips the theme dark↔light', async ({ page }) => {
  await page.goto('/?token=e2e');
  const toggle = page.getByRole('button', { name: 'Toggle color theme' });

  // Default is dark: data-theme=dark, dark body var, button offers "Light".
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg(page)).toBe(DARK_BODY);
  await expect(toggle).toHaveText(/Light/);
  const darkHeader = await headerBg(page);

  // Flip to light: attribute + body var + the `light:` header override all switch.
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveText(/Dark/);
  expect(await bodyBg(page)).toBe(LIGHT_BODY);
  expect(await headerBg(page)).not.toBe(darkHeader);

  // Flip back to dark: everything returns.
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg(page)).toBe(DARK_BODY);
  expect(await headerBg(page)).toBe(darkHeader);
});

test('the light choice persists across a full page reload', async ({ page }) => {
  await page.goto('/?token=e2e');
  const toggle = page.getByRole('button', { name: 'Toggle color theme' });
  const darkHeader = await headerBg(page);

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightHeader = await headerBg(page);
  expect(lightHeader).not.toBe(darkHeader);

  // Full reload: the head script must re-apply light BEFORE paint, and useTheme
  // must rehydrate to light — no dark flash, no reset to the default.
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bodyBg(page)).toBe(LIGHT_BODY); // --bg light survived
  expect(await headerBg(page)).toBe(lightHeader); // light: override survived
  await expect(page.getByRole('button', { name: 'Toggle color theme' })).toHaveText(/Dark/);
});
