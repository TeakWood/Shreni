import { defineConfig, devices } from '@playwright/test';

// Playwright config for the Phalaka web E2E suite (Shreni-beads-zy9).
//
// Hermetic by construction: specs mock the whole backend via page.route + an
// in-page EventSource mock (see e2e/fixtures/mock-backend.ts), so NO live Phalaka
// server or bd database is needed. The webServer below only serves the built
// front-end assets; every /api/* call is intercepted in the browser.
//
// We test the SHIPPED artifact: `pnpm build` produces the single inlined
// dist/index.html that gets codegen'd into ../ui.ts, and `vite preview` serves
// exactly that. Chromium only — this is a regression guard, not a browser matrix
// (see the epic's "out of scope").
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Build the single-file bundle, then serve dist/ with `vite preview`. Bind to
  // 127.0.0.1 explicitly: vite preview's default `localhost` resolves to IPv6
  // (::1) on macOS, but Playwright polls the IPv4 `url` below — the mismatch would
  // hang the webServer until timeout. Reuse an already-running preview locally for
  // fast iteration; always start fresh in CI.
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
