// Shared build-identity computation (epic yrk / Study B2, yrk.2). Used by both
// `stamp-build-info.mjs` (the `pnpm build` step that writes dist/build-info.json)
// and `build-binary.mjs` (which embeds the same object into the SEA bundle). This
// is BUILD-TIME code — it is the ONLY place git is consulted for the Shreni
// commit. Runtime (src/sthapathi/build-info.ts) never shells out to git; it only
// reads what was stamped here.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Run a git command in `root`, returning trimmed stdout or null when git is
// unavailable / this is not a checkout / the command fails. Never throws, so a
// build outside a git checkout still succeeds (writing nulls).
function git(root, args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// Compute the build identity for the checkout at `root`. `builtAt` is stamped at
// call time (this runs as a build script, not in the harness). `commit` is null
// outside a git checkout; `dirty` is null when git is unavailable (indistinct
// from clean otherwise), true when the working tree has uncommitted changes.
export function computeBuildInfo(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commit = git(root, 'rev-parse HEAD');
  const status = git(root, 'status --porcelain');
  const dirty = status === null ? null : status.length > 0;
  return {
    version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
    commit,
    dirty,
    builtAt: new Date().toISOString(),
  };
}
