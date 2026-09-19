// Build step (epic yrk / Study B2, yrk.2): after `tsc` emits dist/, write the
// Shreni build identity to dist/build-info.json. Runs as part of `pnpm build`
// (and so `prepublishOnly`, giving published packages the publishing commit and
// dirty:false for free). Reading git HERE — not at runtime — is deliberate: the
// operator's install is an npm link to the checkout, so what runs is dist/ as of
// the last tsc; a runtime `git rev-parse` would report HEAD, which may not be the
// code executing. Never fails the build: git errors become nulls (see the lib).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildInfo } from './build-info-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const info = computeBuildInfo(root);
const distDir = join(root, 'dist');
// `pnpm build` runs tsc first so dist/ exists, but ensure it so this step also
// succeeds when run standalone (or if tsc emitted nothing).
mkdirSync(distDir, { recursive: true });
const out = join(distDir, 'build-info.json');
writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(
  `[stamp-build-info] wrote dist/build-info.json ` +
    `(version=${info.version}, commit=${info.commit ?? 'null'}, dirty=${info.dirty ?? 'null'})`,
);
