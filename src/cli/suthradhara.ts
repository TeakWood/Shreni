import { loadRegistry } from '../kshetra/registry';
import { resolveKshetra } from './status';
import { startSession, stopSession, statusSession } from '../suthradhara/lifecycle';
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

export type SuthradharaSubcommand = 'start' | 'stop' | 'status';

export function isSubcommand(x: string | undefined): x is SuthradharaSubcommand {
  return x === 'start' || x === 'stop' || x === 'status';
}

export interface RunOpts {
  args: string[];
  flagKshetra: string | undefined;
  cwd: string;
  kshetras?: KshetraConfig[];
}

export function runSuthradhara(sub: string | undefined, opts: RunOpts): void {
  if (!isSubcommand(sub)) {
    throw new Error('Usage: shreni suthradhara <start|stop|status> [@<id> | --kshetra <id>]');
  }
  const kshetras = opts.kshetras ?? loadRegistry();
  const kshetra = resolveTargetKshetra(opts.args, opts.flagKshetra, opts.cwd, kshetras);

  if (sub === 'start') {
    const result = startSession(kshetra);
    if (result.status === 'already_running') {
      console.log(`suthradhara[${result.kshetraId}]: already running (pid ${result.pid})`);
    } else {
      console.log(`suthradhara[${result.kshetraId}]: started (pid ${result.pid})`);
    }
  } else if (sub === 'stop') {
    const result = stopSession(kshetra.id);
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
