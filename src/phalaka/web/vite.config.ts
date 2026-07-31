import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Phalaka runs on loopback with no CSP and must work fully offline (and inside
// the SEA binary, where there is no filesystem to serve assets from). So the
// build inlines EVERYTHING — JS + CSS — into one self-contained index.html with
// zero external requests. `scripts/build-phalaka-web.mjs` reads that single
// dist/index.html and writes it into the INDEX_HTML export of ../ui.ts.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    target: 'es2020',
    // One chunk, no code-splitting — viteSingleFile inlines it into the HTML.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
    // Keep the generated string diff-stable across builds where the source is
    // unchanged; hashed asset names would churn ../ui.ts needlessly.
    rollupOptions: { output: { entryFileNames: 'app.js' } },
  },
});
