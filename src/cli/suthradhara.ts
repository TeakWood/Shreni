import { loadRegistry } from '../kshetra/registry';
import { resolveKshetra } from './status';
import {
  startSession,
  stopSession,
  statusSession,
  resumeSession,
} from '../suthradhara/lifecycle';
import { listSessions } from '../suthradhara/persistence';
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
      console.log(`suthradhara[${result.kshetraId}]: started (pid ${result.pid})`);
      console.log(`Session: ${result.sessionId}`);
      console.log(`Resume with: shreni suthradhara resume ${result.sessionId}`);
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
    console.log(`suthradhara[${result.kshetraId}]: resumed (pid ${result.pid})`);
    console.log(`Session: ${result.sessionId}`);
  }
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
    console.log(`${s.id}  kshetra=${s.kshetraId}  stage=${s.stage}  updated=${s.updatedAt}`);
  }
}
