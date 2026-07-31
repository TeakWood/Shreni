import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Phalaka web app (src/phalaka/web/) is a standalone package with its own
    // vitest — the root run must not pick up its ESM/JSX tests.
    exclude: [...configDefaults.exclude, 'src/phalaka/web/**'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/phalaka/web/**'],
    },
  },
});
