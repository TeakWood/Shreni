import { createInterface } from 'readline';
import { loadRegistry } from '../kshetra/registry';
import { resolveKshetra } from './status';
import {
  startSession,
  stopSession,
  statusSession,
  resumeSession,
  teardownWorktrees,
  type LaunchResult,
  type StartOpts,
} from '../suthradhara/lifecycle';
import { listSessions } from '../suthradhara/persistence';
import { readHandoff, type Handoff } from '../suthradhara/handoff';
import type { KshetraConfig } from '../kshetra/config';

// Resolve the target Kshetra for a Suthradhara subcommand. Precedence:
//   1. @<id> as a bare positional token (at-mention)
//   2. --kshetra <id> flag
//   3. cwd falls inside a registered Kshetra's repo path
// Any explicit id (1 or 2) must resolve; a cwd fallback that misses returns an
// error mentioning both alternatives so the operator knows their options.

const AT_MENTION = /^@([a-z0-9-]+)$/;

export function parseAtMention(args: string[]): string | undefined {
  for (const arg of args) {
    const match = AT_MENTION.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

export function resolveTargetKshetra(
  args: string[],
  flagValue: string | undefined,
  cwd: string,
  kshetras: KshetraConfig[],
): KshetraConfig {
  if (kshetras.length === 0) {
    throw new Error('No kshetras registered. Run `shreni register` first.');
  }

  const atId = parseAtMention(args);
  const explicitId = atId ?? flagValue;

  if (explicitId) {
    const found = kshetras.find(k => k.id === explicitId);
    if (!found) throw new Error(`Kshetra not found: ${explicitId}`);
    return found;
  }

  const cwdMatch = resolveKshetra(kshetras, cwd);
  if (cwdMatch) return cwdMatch;

  throw new Error(
    `No kshetra resolvable from cwd: ${cwd}\n` +
      'Hint: pass @<id> or --kshetra <id> to select one.',
  );
}

export type SuthradharaSubcommand = 'start' | 'stop' | 'status' | 'resume' | 'list';

export function isSubcommand(x: string | undefined): x is SuthradharaSubcommand {
  return x === 'start' || x === 'stop' || x === 'status' || x === 'resume' || x === 'list';
}

// A session id lands as a bare positional (no leading @), sitting alongside an
// optional @<kshetra> mention on `resume`. Distinguish by the id shape — the
// generator's format matches this pattern exactly.
const SESSION_ID_ARG_RE = /^[a-z0-9-]+-\d{8}T\d{6}-[0-9a-f]{4}$/;

export function parseSessionId(args: string[]): string | undefined {
  for (const arg of args) {
    if (SESSION_ID_ARG_RE.test(arg)) return arg;
  }
  return undefined;
}

// The kshetra id is embedded in the session id — infer it so `resume <id>`
// works without a redundant @<kshetra> mention.
export function kshetraIdFromSessionId(sessionId: string): string {
  return sessionId.replace(/-\d{8}T\d{6}-[0-9a-f]{4}$/, '');
}

export interface RunOpts {
  args: string[];
  flagKshetra: string | undefined;
  cwd: string;
  kshetras?: KshetraConfig[];
}

export async function runSuthradhara(sub: string | undefined, opts: RunOpts): Promise<void> {
  if (!isSubcommand(sub)) {
    throw new Error(
      'Usage: shreni suthradhara <start|resume <session-id>|stop|status|list> [@<id> | --kshetra <id>]',
    );
  }
  const kshetras = opts.kshetras ?? loadRegistry();

  if (sub === 'resume') {
    await runResume(opts, kshetras);
    return;
  }

  if (sub === 'list') {
    runList(opts, kshetras);
    return;
  }

  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);

  if (sub === 'start') {
    const result = await startSession(kshetra);
    if (result.status === 'already_running') {
      console.log(`suthradhara[${result.kshetraId}]: already running (pid ${result.pid})`);
    } else {
      await runPlanningLoop(kshetra, result);
    }
  } else if (sub === 'stop') {
    const result = await stopSession(kshetra);
    if (result.status === 'stopped') {
      console.log(`suthradhara[${result.kshetraId}]: stopped (pid ${result.pid})`);
    } else if (result.status === 'stale_pid_cleared') {
      console.log(`suthradhara[${result.kshetraId}]: was not running (stale PID file cleared)`);
    } else {
      console.log(`suthradhara[${result.kshetraId}]: not running`);
    }
  } else {
    const result = statusSession(kshetra.id);
    if (result.running) {
      console.log(`suthradhara[${result.kshetraId}]: running (pid ${result.pid})`);
      console.log(`Log: ${result.logPath}`);
    } else {
      console.log(`suthradhara[${result.kshetraId}]: not running`);
    }
  }
}

async function runResume(opts: RunOpts, kshetras: KshetraConfig[]): Promise<void> {
  const sessionId = parseSessionId(opts.args);
  if (!sessionId) {
    throw new Error(
      'Usage: shreni suthradhara resume <session-id>\n' +
        'Hint: run `shreni suthradhara list` to see available sessions.',
    );
  }
  const kshetraId = kshetraIdFromSessionId(sessionId);
  const kshetra = kshetras.find(k => k.id === kshetraId);
  if (!kshetra) {
    throw new Error(
      `Session "${sessionId}" refers to kshetra "${kshetraId}", which is not registered.`,
    );
  }

  const result = await resumeSession(kshetra, sessionId);
  if (result.status === 'already_running') {
    console.log(
      `suthradhara[${result.kshetraId}]: already running (pid ${result.pid}); resume is a no-op`,
    );
  } else {
    await runPlanningLoop(kshetra, result);
  }
}

// The launcher-owned control loop (epic d3y). Each iteration is ONE short-lived,
// single-purpose Claude Code planning session: we block on it, then — on exit —
// read its handoff, print the summary + merge prompt, and offer extend / new /
// end. The operator is never left in a free-roaming session: completion always
// returns here, to the bounded menu.
//
// "extend" relaunches a FRESH claude session in the SAME worktree seeded with
// the just-written doc; "new story" reaps the worktree and starts fresh; "end"
// tears the worktree down and returns. SIGINT is swallowed while a child runs so
// Ctrl-C reaches the interactive session, not this parent.
export interface PlanningLoopDeps {
  // Read one line from the operator (the menu answer). Injected so tests drive
  // the loop without a TTY.
  ask?: (prompt: string) => Promise<string>;
  // Passed through to startSession — the spawn/uuid seams a test uses to avoid
  // launching real claude.
  startOpts?: Pick<StartOpts, 'spawn' | 'uuid'>;
  log?: (msg: string) => void;
}

export type MenuChoice = 'extend' | 'new' | 'end';

// Map a raw menu answer to a choice, or null if unrecognised (the loop re-asks).
export function parseMenuChoice(raw: string): MenuChoice | null {
  const s = raw.trim().toLowerCase();
  if (s === '1' || s === 'extend' || s === 'e') return 'extend';
  if (s === '2' || s === 'new' || s === 'new story' || s === 'n') return 'new';
  if (s === '3' || s === 'end' || s === 'quit' || s === 'q') return 'end';
  return null;
}

// Render the post-session summary + merge instructions. Degrades gracefully when
// the handoff is missing (a session that exited before completing the push).
export function renderSummary(kshetra: KshetraConfig, handoff: Handoff | null): string[] {
  const lines: string[] = ['', '─ planning unit complete ─'];
  if (handoff) {
    lines.push(
      `  epic:   ${handoff.epicId}`,
      `  doc:    ${handoff.docPath}`,
      `  branch: ${handoff.branch}`,
      `  ${handoff.summary}`,
      '',
      'Merge this branch when you are ready (it was pushed, not merged):',
      `  gh pr create --base ${kshetra.repo.mainBranch} --head ${handoff.branch}   # or your merge flow`,
    );
  } else {
    lines.push(
      '  (no handoff record found — the session may have exited before completing the push.)',
      '  Check `bd list` and the worktree branch to see what landed.',
    );
  }
  return lines;
}

async function runPlanningLoop(
  kshetra: KshetraConfig,
  first: LaunchResult,
  deps: PlanningLoopDeps = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const ask = deps.ask ?? defaultAsk;
  let current = first;

  for (;;) {
    log(`suthradhara[${kshetra.id}]: planning session live (${current.sessionId}).`);
    log('Interview, approve the plan, and end the session (Ctrl-D / /exit) to return here.');

    const swallow = (): void => {};
    process.on('SIGINT', swallow);
    try {
      await current.wait();
    } finally {
      process.off('SIGINT', swallow);
    }

    const handoff = readHandoff(current.worktreePath);
    for (const line of renderSummary(kshetra, handoff)) log(line);

    let choice: MenuChoice | null = null;
    while (choice === null) {
      const answer = await ask('\nWhat next?  [1] extend this topic   [2] new story   [3] end\n> ');
      choice = parseMenuChoice(answer);
      if (choice === null) log('Please answer 1, 2, or 3.');
    }

    if (choice === 'end') {
      await teardownWorktrees(kshetra);
      log(`suthradhara[${kshetra.id}]: planning ended.`);
      return;
    }

    const startOpts: StartOpts =
      choice === 'extend'
        ? { ...deps.startOpts, reuseWorktree: current.worktreePath, extendDocRelPath: handoff?.docPath }
        : { ...deps.startOpts };
    if (choice === 'new') await teardownWorktrees(kshetra);

    const next = await startSession(kshetra, startOpts);
    if (next.status === 'already_running') {
      log(`suthradhara[${kshetra.id}]: another session is already running (pid ${next.pid}); stopping the loop.`);
      return;
    }
    current = next;
  }
}

// Read one line from stdin for the menu. Isolated so tests inject their own.
function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function runList(opts: RunOpts, kshetras: KshetraConfig[]): void {
  // A kshetra filter is optional — with no @<id> or --kshetra, we list every
  // session on disk so the operator can pick from across projects.
  const atId = parseAtMention(opts.args) ?? opts.flagKshetra;
  const sessions = listSessions(atId);
  if (sessions.length === 0) {
    console.log(atId ? `No suthradhara sessions for ${atId}.` : 'No suthradhara sessions.');
    return;
  }
  for (const s of sessions) {
    console.log(`${s.id}  kshetra=${s.kshetraId}  status=${s.status}  updated=${s.updatedAt}`);
  }
}

// Exported for tests: drive the loop directly with injected deps.
export { runPlanningLoop };
