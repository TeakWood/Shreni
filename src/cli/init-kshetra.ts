import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  writeFileSync, appendFileSync, symlinkSync,
  existsSync, mkdirSync, readFileSync, readlinkSync,
} from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import { registerKshetra } from '../kshetra/registry';

const execAsync = promisify(execFile);

export interface InitKshetraOpts {
  slug: string;
  path: string;
  org?: string;
  language?: string;
  beadsPath?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await execAsync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// ── Step 1: Create GitHub beads repo ─────────────────────────────────────────

export async function createGitHubRepo(org: string, slug: string): Promise<string> {
  const repoName = `${slug}-beads`;
  const remote = `git@github.com:${org}/${repoName}.git`;
  try {
    await exec('gh', ['repo', 'view', `${org}/${repoName}`], {});
    return remote; // already exists
  } catch {
    await exec('gh', ['repo', 'create', `${org}/${repoName}`, '--private', '--confirm'], {});
    return remote;
  }
}

// ── Step 2: Clone beads repo ──────────────────────────────────────────────────

export async function cloneBeadsRepo(remoteUrl: string, localPath: string): Promise<void> {
  if (existsSync(localPath)) return;
  await exec('git', ['clone', remoteUrl, localPath]);
}

// ── Step 3: bd init --stealth ─────────────────────────────────────────────────

export async function initBeadsDb(beadsPath: string): Promise<void> {
  if (existsSync(join(beadsPath, '.dolt')) || existsSync(join(beadsPath, 'embeddeddolt'))) return;
  await exec('bd', ['init', '--stealth'], {
    cwd: beadsPath,
    env: { ...process.env, BEADS_DIR: beadsPath },
  });
}

// ── Step 4: Create .beads symlink ─────────────────────────────────────────────

export function createBeadsSymlink(repoPath: string, beadsPath: string): void {
  const symlinkPath = join(repoPath, '.beads');
  const target = resolve(beadsPath);
  try {
    const current = readlinkSync(symlinkPath);
    if (resolve(current) === target) return;
    throw new Error(`.beads symlink exists but points to "${current}" instead of "${target}"`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') {
      throw new Error(
        `.beads already exists as a directory at "${symlinkPath}". ` +
        `Remove it first: rm -rf "${symlinkPath}"`
      );
    }
    if (code !== 'ENOENT') throw err;
    symlinkSync(target, symlinkPath);
  }
}

// ── Step 5: Update .gitignore ─────────────────────────────────────────────────

export function addToGitignore(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore');
  const marker = '.beads';

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf8');
    if (content.split('\n').some(l => l.trim() === marker)) return;
    appendFileSync(gitignorePath, `\n${marker}\n`, 'utf8');
  } else {
    writeFileSync(gitignorePath, `${marker}\n`, 'utf8');
  }
}

// ── Step 6: bd setup claude ───────────────────────────────────────────────────

export async function setupClaudeHooks(repoPath: string, beadsPath: string): Promise<void> {
  await exec('bd', ['setup', 'claude'], {
    cwd: repoPath,
    env: { ...process.env, BEADS_DIR: beadsPath },
  });
}

// ── Step 7: Generate kshetra.yaml ─────────────────────────────────────────────

export function generateKshetraYaml(opts: {
  slug: string;
  repoPath: string;
  repoRemote: string;
  beadsPath: string;
  beadsRemote: string;
  language: string;
}): string {
  const config = {
    id: opts.slug,
    name: toName(opts.slug),
    repo: {
      path: opts.repoPath,
      remote: opts.repoRemote,
      mainBranch: 'main',
      branchPattern: 'bead-{id}/{slug}',
    },
    beads: {
      path: opts.beadsPath,
      remote: opts.beadsRemote,
      mode: 'embedded',
    },
    stack: { language: opts.language },
    agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  };
  return yaml.dump(config, { lineWidth: -1 });
}

export function writeKshetraConfig(repoPath: string, content: string): string {
  const configPath = join(repoPath, 'kshetra.yaml');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

// ── Step 8: Append SHRENI INTEGRATION to CLAUDE.md ───────────────────────────

export const SHRENI_SECTION = `
## SHRENI INTEGRATION

This project is managed by Shreni. The Sthapathi daemon picks up beads issues
and implements them via Claude Code agents.

**Your role in interactive sessions: task producer only.**
Create beads issues for the daemon to implement — do NOT implement tasks yourself.

Prohibited in interactive sessions:
  bd update --claim            Sthapathi claims tasks, not interactive agents
  bd close                     Sthapathi closes tasks on completion
  git checkout -b / git branch Sthapathi owns all bead-* branches

Useful commands:
  shreni status --all          Show all kshetra states
  shreni agents                Show live agent activity
  shreni logs --kshetra <id>   Round-by-round agent logs
  shreni pause --kshetra <id>  Pause task pickup
  shreni resume --kshetra <id> Resume task pickup
`;

export function appendShreniIntegration(repoPath: string): void {
  const claudePath = join(repoPath, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const content = readFileSync(claudePath, 'utf8');
    if (content.includes('SHRENI INTEGRATION')) return;
  }
  appendFileSync(claudePath, SHRENI_SECTION, 'utf8');
}

// ── Step 9: RAG index stub ────────────────────────────────────────────────────

export function createRagIndexStub(slug: string): void {
  const ragDir = resolve(homedir(), '.shreni', 'rag', slug);
  mkdirSync(ragDir, { recursive: true });
  const indexPath = join(ragDir, 'index.json');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, JSON.stringify({ chunks: [], version: 1 }, null, 2), 'utf8');
  }
}

// ── Step 10: Register ─────────────────────────────────────────────────────────

export function registerWithSthapathi(slug: string, configPath: string): void {
  registerKshetra(slug, configPath);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function initKshetra(opts: InitKshetraOpts): Promise<void> {
  const org = opts.org ?? 'TeakWood';
  const language = opts.language ?? 'typescript';
  const repoPath = resolve(opts.path);
  const beadsPath = opts.beadsPath
    ? resolve(opts.beadsPath)
    : resolve(join(dirname(repoPath), `${basename(repoPath)}-beads`));

  const log = (step: number, msg: string) => console.log(`[${step}/10] ${msg}`);

  let beadsRemote: string;
  if (opts.beadsPath && existsSync(beadsPath)) {
    log(1, `Using existing beads repo at ${beadsPath} — skipping GitHub create`);
    log(2, `Using existing beads repo at ${beadsPath} — skipping clone`);
    try {
      beadsRemote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: beadsPath });
    } catch {
      beadsRemote = '';
    }
  } else {
    log(1, `Creating GitHub repo ${org}/${opts.slug}-beads...`);
    beadsRemote = await createGitHubRepo(org, opts.slug);

    log(2, `Cloning beads repo to ${beadsPath}...`);
    await cloneBeadsRepo(beadsRemote, beadsPath);
  }

  log(3, 'Initialising beads database (stealth mode)...');
  await initBeadsDb(beadsPath);

  log(4, 'Creating .beads symlink...');
  createBeadsSymlink(repoPath, beadsPath);

  log(5, 'Updating .gitignore...');
  addToGitignore(repoPath);

  log(6, 'Installing Claude Code hooks (bd setup claude)...');
  await setupClaudeHooks(repoPath, beadsPath);

  log(7, 'Generating kshetra.yaml...');
  const repoRemote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
  const yamlContent = generateKshetraYaml({
    slug: opts.slug,
    repoPath,
    repoRemote,
    beadsPath,
    beadsRemote,
    language,
  });
  const configPath = writeKshetraConfig(repoPath, yamlContent);

  log(8, 'Appending SHRENI INTEGRATION to CLAUDE.md...');
  appendShreniIntegration(repoPath);

  log(9, 'Creating RAG index stub...');
  createRagIndexStub(opts.slug);

  log(10, 'Registering kshetra with Sthapathi...');
  registerWithSthapathi(opts.slug, configPath);

  console.log(`\nKshetra "${opts.slug}" initialised. Run \`shreni start\` to begin.`);
}