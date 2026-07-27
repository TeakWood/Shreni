import type { KshetraConfig } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';
import { resolveBin } from '../agents/providers/types';
import { readOnlyAllowlist, filingAllowlist } from './allowlist';
import { buildSystemPrompt } from './prompt';
import type { SessionState } from './state';

// Compose the claude-CLI invocation for a Suthradhara interview turn. Pure —
// exported so xa0.2 (stage-aware prompt) can call it per turn and later beads
// (xa0.4/xa0.5) can swap the allowlist without touching lifecycle code.
//
// cwd is the target Kshetra's repo so claude reads/greps the RIGHT code base;
// --allowedTools is a positive whitelist (Read/Glob/Grep + read-only bd/git)
// and permission-mode 'default' means an unlisted tool needs approval — with
// stdio ignored in a detached process there's nowhere to approve, so an
// unlisted tool is effectively denied. That's what makes xa0.1's "no bd write
// or file write" hold.
export interface SuthradharaSpawnOpts {
  kshetra: KshetraConfig;
  systemPrompt: string;
  userPrompt: string;
}

export function buildClaudeSpawn(opts: SuthradharaSpawnOpts): SpawnSpec {
  const allowlist = readOnlyAllowlist();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--append-system-prompt', opts.systemPrompt,
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--model', opts.kshetra.agents.model,
    '--allowedTools', allowlist.join(','),
    opts.userPrompt,
  ];

  return {
    bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
    args,
    env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
  };
}

// The single entry point a turn loop calls: derive the stage-aware system prompt
// from the live session state (xa0.2) and compose the read-only spawn. Kept here
// so the runner doesn't need to know how the prompt is assembled — it hands over
// state + the operator's message and gets a ready-to-spawn spec back.
export function buildInterviewSpawn(
  state: SessionState,
  kshetra: KshetraConfig,
  userPrompt: string,
): SpawnSpec {
  return buildClaudeSpawn({
    kshetra,
    systemPrompt: buildSystemPrompt(state, kshetra),
    userPrompt,
  });
}

// The allowlist an interview/proposal turn runs under. It is ALWAYS the
// read-only surface — no persisted session state ever grants a conversational
// turn the filing verbs. That is the concrete meaning of "server is authority
// / no bd write before confirm" (ARD §6.1): the model can propose a
// decomposition and have it held (`pending`), but it can never file one on its
// own initiative. Filing is reachable only through the post-confirm step, which
// builds its own spawn (buildFilingSpawn) after applyConfirmFrame returns
// `confirmed` — a path the interview loop cannot enter by itself.
export function allowlistForTurn(_state: SessionState): string[] {
  return readOnlyAllowlist();
}

// The spawn for the server's post-confirm filing turn: the read-only surface
// PLUS `bd create` / `bd dep add` (filingAllowlist). This is the ONLY spawn
// that carries the write verbs, and the confirm handler is its only caller —
// it is never built from persisted state, so it cannot be reached without an
// explicit confirm frame having just been processed.
export function buildFilingSpawn(opts: SuthradharaSpawnOpts): SpawnSpec {
  const spec = buildClaudeSpawn(opts);
  const idx = spec.args.indexOf('--allowedTools');
  if (idx >= 0) spec.args[idx + 1] = filingAllowlist().join(',');
  return spec;
}
