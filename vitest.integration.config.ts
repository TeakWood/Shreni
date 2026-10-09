import { defineConfig } from 'vitest/config';

// The engine's concurrency tier (engine spec, "Testing"): real Postgres, one
// container for the run (or TASKGRAPH_TEST_DATABASE_URL), a fresh database
// per test. Run with pnpm test:integration; it needs Docker.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['src/taskgraph/test/postgres-setup.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
