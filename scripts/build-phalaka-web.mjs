// Codegen for the Phalaka dashboard (Shreni-beads-9hk.1).
//
// Builds the standalone React+Tailwind app under src/phalaka/web/ to ONE inlined
// index.html (vite-plugin-singlefile — all JS+CSS inlined, zero external requests)
// and writes that HTML into the INDEX_HTML export of src/phalaka/ui.ts.
//
// The generated ui.ts is COMMITTED, so `pnpm build` / `tsc` / the SEA binary need
// no frontend toolchain — only this script (run when the UI changes) regenerates
// it. src/phalaka/web/ is excluded from the root tsconfig + vitest so the backend
// build never sees the ESM/JSX app.
//
// Usage: pnpm build:web   (from the repo root)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'src/phalaka/web');
const DIST_HTML = join(WEB, 'dist/index.html');
const UI_TS = join(ROOT, 'src/phalaka/ui.ts');

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}

// 1. Install the web toolchain on first run (it is not a root dependency).
if (!existsSync(join(WEB, 'node_modules'))) {
  console.log('→ installing Phalaka web toolchain (first run)');
  run('pnpm', ['install'], WEB);
}

// 2. Build the single-file bundle.
console.log('→ building Phalaka web (vite single-file)');
run('pnpm', ['build'], WEB);

// 3. Read the one inlined HTML and write it into ui.ts as a committed string.
const html = readFileSync(DIST_HTML, 'utf8');
if (!/<div id="root">/.test(html)) {
  throw new Error(`build-phalaka-web: unexpected dist HTML (no #root) at ${DIST_HTML}`);
}

const banner =
  '// GENERATED FILE — do not edit by hand.\n' +
  '//\n' +
  '// The Phalaka dashboard is a React + Tailwind app under src/phalaka/web/, built\n' +
  '// to one inlined index.html by `pnpm build:web` (scripts/build-phalaka-web.mjs).\n' +
  '// server.ts serves this string at GET /. To change the UI, edit src/phalaka/web/\n' +
  '// and re-run `pnpm build:web` — never edit the string below directly.\n\n';

// JSON.stringify yields a valid, fully-escaped double-quoted JS string literal —
// robust against the backticks / ${...} that the minified bundle contains.
const out = `${banner}export const INDEX_HTML = ${JSON.stringify(html)};\n`;
writeFileSync(UI_TS, out, 'utf8');

console.log(`✓ wrote ${UI_TS} (${html.length} bytes of inlined HTML)`);
