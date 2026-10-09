import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ProjectMode } from './project';

// Instructions for agent sessions (policy spec): one block in each provider's
// instruction file, in the version the project's mode calls for, between
// markers that name the mode and the version. Shreni rewrites only what is
// between them. A Kshetra's file never carries the tracker block, or an agent
// could start claiming tasks.

/** Each block's current version; prime warns about a file whose block is older. */
export const BLOCK_VERSION: Readonly<Record<ProjectMode, number>> = { tracker: 1, kshetra: 1 };

const TRACKER = `## Task tracking

This repo is tracked with \`shreni task\`. It is tracker-only: Shreni never runs work here.
Use the installed \`shreni\`, never a build from this checkout.

1. \`shreni task ready\` lists open tasks with nothing blocking them.
2. \`shreni task claim <id>\` takes one. It is yours for 8 hours, and any
   \`shreni task note\` on it renews the claim.
3. Do the work. \`shreni task note <id> "…"\` records progress.
4. \`shreni task finish <id> --reason "…"\` once it is reviewed and pushed,
   or \`shreni task release <id>\` to give it back. An epic finishes
   the same way once all its tasks are done.
5. If you stop without finishing, the claim lapses after 8 hours. Three lapses
   in a row block the task for the developer.

Filing and remembering:

    shreni task create --title "…"   # lands as proposed; the developer approves it
    shreni task remember "…"         # an insight for later sessions

Never run \`shreni task approve\` or \`shreni task upgrade\`; those are the developer's.`;

const KSHETRA = `## Shreni

This project is a Kshetra: Shreni's worker picks up its tasks and implements them
with its agents.

If your instructions give you a Shreni agent role for a task (Silpi, Viharapala or
another), this section does not apply to you: do the job you were given. The rules
below are for interactive sessions, which file work and do not do it.

    shreni task create --title "…"   # lands as proposed; the developer approves it
    shreni task ready / show / list  # read the queue
    shreni task remember "…"         # an insight for later sessions

Never, in an interactive session:
- \`shreni task claim\` or \`shreni task finish\`: the worker claims and finishes tasks.
- \`git checkout -b\`: the worker owns every task branch.
- \`shreni task approve\` or \`shreni task upgrade\`: those are the developer's.

Useful: \`shreni status --all\`, \`shreni agents\`, \`shreni logs --kshetra <id>\`,
\`shreni pause --kshetra <id>\`, \`shreni resume --kshetra <id>\`.

### Toolchain config sync

Shreni runs build, test and lint from the pointers in \`.shreni/kshetra.yaml\`.
When you add or change a toolchain config, update the matching pointer in the
same change: \`stack.buildCommand\`, \`stack.testRunner\`, \`stack.lintCommand\`.`;

/** The block's text, without its markers: what prime prints. */
export function blockBody(mode: ProjectMode): string {
  return mode === 'tracker' ? TRACKER : KSHETRA;
}

/** The block as it sits in a file, markers included. */
export function renderBlock(mode: ProjectMode): string {
  return `<!-- shreni:begin ${mode} v${BLOCK_VERSION[mode]} -->\n${blockBody(mode)}\n<!-- shreni:end -->`;
}

const BEGIN = /<!-- shreni:begin (\S+) v(\d+) -->/g;
const END = '<!-- shreni:end -->';

export type FoundBlock = { mode: string; version: number; start: number; end: number };

/** Where the file's ``` and ~~~ code fences are: a marker inside one is an example, not a block. */
function fences(text: string): [number, number][] {
  const out: [number, number][] = [];
  let open: { at: number; fence: string } | null = null;
  const re = /^ {0,3}(`{3,}|~{3,})/gm;
  for (let m; (m = re.exec(text));) {
    if (!open) open = { at: m.index, fence: m[1] };
    else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
      out.push([open.at, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) out.push([open.at, text.length]);
  return out;
}

export class BrokenBlock extends Error {
  constructor(file: string, why: string) {
    super(`${file}: ${why}; fix the Shreni markers by hand, then run shreni task setup`);
    this.name = 'BrokenBlock';
  }
}

/**
 * Every Shreni block in a file's text, in order, outside code fences. A begin
 * marker with no end before the next begin is refused rather than guessed at,
 * since a guess would take the text between them.
 */
export function findBlocks(text: string, file = 'the file'): FoundBlock[] {
  const fenced = fences(text);
  const inFence = (i: number) => fenced.some(([a, b]) => i >= a && i < b);
  const begins = [...text.matchAll(BEGIN)].filter(m => !inFence(m.index!));
  return begins.map((m, i) => {
    const end = text.indexOf(END, m.index!);
    const next = begins[i + 1]?.index ?? Infinity;
    if (end < 0 || end > next || inFence(end)) throw new BrokenBlock(file, `a "shreni:begin ${m[1]}" marker has no end marker`);
    return { mode: m[1], version: Number(m[2]), start: m.index!, end: end + END.length };
  });
}

/** The first Shreni block in a file's text, or null. */
export function findBlock(text: string): FoundBlock | null {
  return findBlocks(text)[0] ?? null;
}

/** The section appendShreniIntegration appended once, before the block existed: a block replaces exactly it. */
export const LEGACY_SECTION = `
## SHRENI INTEGRATION

This project is managed by Shreni. The Sthapathi daemon picks up beads issues and
implements them via autonomous agents (Silpi, Viharapala, Parikshaka).

**If your system prompt assigns you a Silpi/Viharapala/Parikshaka role for a
specific bead, this section does NOT apply to you** — do your assigned job
(implement / review / analyze) with your tools. The rules below govern
interactive human sessions only.

**Interactive sessions: task producer only.**
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

### Toolchain config sync

Shreni runs build/test/lint from the pointers in \`.shreni/kshetra.yaml\` (stack.*),
not by re-discovering your toolchain. Whenever you add or change a toolchain
config file — a new test runner (vitest/jest/pytest), linter (eslint), tsconfig,
a new package.json/Makefile script, or you switch package managers — update the
matching pointer in \`.shreni/kshetra.yaml\` in the same change:

  stack.buildCommand   the build/compile gate (e.g. \`pnpm build\`)
  stack.testRunner     the test command (e.g. \`pnpm test\`)
  stack.lintCommand    the lint gate (e.g. \`pnpm lint\`); omit to skip lint

Prefer pointing at a project script (\`pnpm test\`) over duplicating globs. The
escape hatches stack.testFileGlobs / stack.failCountPattern are for non-standard
setups only — set them only when the harness must find tests WITHOUT running the
runner. A stale pointer means Shreni runs the wrong gate.
`;

export type WriteOutcome = 'created' | 'added' | 'updated' | 'unchanged';

/**
 * Writes the mode's block into an instruction file: over the file's block
 * when it has one (whatever its mode or version; any further block is
 * removed, so no stale one survives), in place of the old SHRENI INTEGRATION
 * section when it has exactly that, else at the end. Nothing outside the
 * markers changes.
 */
export function writeBlock(file: string, mode: ProjectMode): WriteOutcome {
  const block = renderBlock(mode);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${block}\n`, 'utf8');
    return 'created';
  }
  const text = readFileSync(file, 'utf8');
  const blocks = findBlocks(text, file);
  const crlf = text.includes('\r\n');
  const eol = (t: string) => (crlf ? t.replace(/\r?\n/g, '\r\n') : t);
  let next: string;
  if (blocks.length) {
    next = text;
    for (const b of [...blocks].reverse()) {
      next = next.slice(0, b.start) + (b === blocks[0] ? eol(block) : '') + next.slice(b.end);
    }
  } else if (text.includes(eol(LEGACY_SECTION))) {
    next = text.replace(eol(LEGACY_SECTION), eol(`\n${block}\n`));
  } else {
    const nl = crlf ? '\r\n' : '\n';
    next = `${text}${text.endsWith('\n') || !text ? '' : nl}${text ? nl : ''}${eol(block)}${nl}`;
  }
  if (next === text) return 'unchanged';
  writeFileSync(file, next, 'utf8');
  return blocks.length ? 'updated' : 'added';
}

/** What prime says about a file's block: missing, of the other kind, or behind. */
export function blockProblem(file: string, mode: ProjectMode): string | null {
  if (!existsSync(file)) return `${file} has no Shreni block; run shreni task setup`;
  let blocks: FoundBlock[];
  try {
    blocks = findBlocks(readFileSync(file, 'utf8'), file);
  } catch (err) {
    return (err as Error).message;
  }
  const found = blocks[0];
  if (!found) return `${file} has no Shreni block; run shreni task setup`;
  if (blocks.length > 1) return `${file} has ${blocks.length} Shreni blocks; run shreni task setup`;
  if (found.mode !== mode) return `${file} has the ${found.mode} block, but this is a ${mode} project; run shreni task setup`;
  if (found.version < BLOCK_VERSION[mode]) return `${file}'s block is v${found.version}, behind v${BLOCK_VERSION[mode]}; run shreni task setup`;
  return null;
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

/** The command the session-start and pre-compaction hooks run. */
export const PRIME = 'shreni task prime';
const HOOK_EVENTS = ['SessionStart', 'PreCompact'] as const;

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/**
 * Installs the session-start and pre-compaction hooks that run shreni task
 * prime in the repo's .claude/settings.json, in place of bd prime's; every
 * other hook stays. Returns whether the file changed.
 */
export function installPrimeHooks(repo: string): boolean {
  const file = join(repo, '.claude', 'settings.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let settings: { hooks?: Record<string, HookEntry[]> };
  try {
    settings = before ? JSON.parse(before) : {};
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${(err as Error).message}); fix it, then run shreni task setup`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(settings) || (settings.hooks !== undefined && !isObject(settings.hooks))) {
    throw new Error(`${file}: "hooks" isn't an object of events; fix it, then run shreni task setup`);
  }
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const list = settings.hooks[event] ?? [];
    if (!Array.isArray(list) || list.some(e => !isObject(e) || (e.hooks !== undefined && !Array.isArray(e.hooks)))) {
      throw new Error(`${file}: hooks.${event} isn't a list of { matcher, hooks: [...] }; fix it, then run shreni task setup`);
    }
  }
  for (const event of HOOK_EVENTS) {
    const entries = (settings.hooks[event] ?? [])
      .map(e => ({ ...e, hooks: (e.hooks ?? []).filter(h => h.command?.trim() !== 'bd prime') }))
      .filter(e => e.hooks.length);
    if (!entries.some(e => e.hooks.some(h => h.command?.trim() === PRIME))) {
      entries.push({ matcher: '', hooks: [{ type: 'command', command: PRIME }] });
    }
    settings.hooks[event] = entries;
  }
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(settings)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after, 'utf8');
  return true;
}
