import { defineConfig } from 'vitest/config';

// The lib/ tests are pure logic (node env); the component smoke tests use jsdom.
// Per-file environment is chosen with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
