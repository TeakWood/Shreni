// Build a self-contained `shreni` executable via Node SEA (Shreni-beads-lbx).
//
// Pipeline: esbuild bundles the CLI (+ the worker/phalaka subcommands, which the
// binary re-invokes itself for — see src/cli/self-exec.ts) into one CJS file,
// Node's --experimental-sea-config produces a blob, and postject injects it into
// a copy of the current `node` binary. macOS requires strip+re-sign around the
// injection. SEA cannot cross-compile, so this runs once per OS/arch in CI.
//
// Usage: node scripts/build-binary.mjs            # names by host platform/arch
//        node scripts/build-binary.mjs shreni-x   # explicit output basename

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const BUNDLE = join(BUILD, 'shreni.cjs');
const SEA_CONFIG = join(BUILD, 'sea-config.json');
const BLOB = join(BUILD, 'sea-prep.blob');
// The standard fuse sentinel Node looks for when reading an injected SEA blob.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const isWin = platform === 'win32';
const isMac = platform === 'darwin';
const basename = process.argv[2] ?? `shreni-${platform}-${arch}`;
const OUT = join(BUILD, isWin ? `${basename}.exe` : basename);

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function sha256(file) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', rej).on('data', d => hash.update(d)).on('end', () => res(hash.digest('hex')));
  });
}

async function main() {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  // 1. Bundle the whole CLI into one CommonJS file. node: built-ins stay
  //    external automatically under platform:node; the pure-JS deps are inlined.
  console.log('→ bundling with esbuild');
  await build({
    entryPoints: [join(ROOT, 'src/cli/index.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // Node strips the entry shebang; drop it so the bundle is clean.
    banner: { js: '' },
    logLevel: 'info',
  });

  // 2. SEA config + blob.
  writeFileSync(SEA_CONFIG, JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
  }, null, 2));
  console.log('→ generating SEA blob');
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);

  // 3. Copy the running node binary as the target executable.
  console.log(`→ copying node -> ${OUT}`);
  copyFileSync(process.execPath, OUT);
  if (!isWin) chmodSync(OUT, 0o755);

  // 4. macOS: signature must be removed before injecting, re-applied after.
  if (isMac) run('codesign', ['--remove-signature', OUT]);

  // 5. Inject the blob with postject.
  console.log('→ injecting blob with postject');
  const postjectCli = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  const postjectArgs = [postjectCli, OUT, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE];
  if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  run(process.execPath, postjectArgs);

  // 6. macOS: ad-hoc re-sign so Gatekeeper will at least run it locally
  //    (unsigned/un-notarized still warns on download — documented in RELEASING).
  if (isMac) run('codesign', ['--sign', '-', OUT]);

  // 7. Checksum sidecar.
  const digest = await sha256(OUT);
  const shaFile = `${OUT}.sha256`;
  writeFileSync(shaFile, `${digest}  ${isWin ? `${basename}.exe` : basename}\n`);

  console.log(`\n✓ Built ${OUT}`);
  console.log(`  sha256: ${digest}`);
  console.log(`  wrote:  ${shaFile}`);
}

main().catch(err => {
  console.error('binary build failed:', err);
  process.exit(1);
});