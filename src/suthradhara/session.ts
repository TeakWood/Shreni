import type { KshetraConfig } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';
import { resolveBin } from '../agents/providers/types';
import { resolveMcpConnection, McpConnectionError } from '../kshetra/mcp-connect';
import { readOnlyAllowlist, filingAllowlist } from './allowlist';
import { mergeGrants } from './grant';
import { buildSystemPrompt } from './prompt';
import type { SessionState } from './state';
import type { McpGrants } from '../kshetra/config';

// Raised when the spawn wiring cannot be built — today only a configured MCP
// server whose `secretEnv` names a host env var that is unset (pmb.4). Failing
// here means the token is missing BEFORE the session starts, never silently at
// the first tool call. Distinct class so the runner can report it as an operator
// fix ("export the token"), not an internal fault.
export class SuthradharaSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuthradharaSpawnError';
  }
}

// Compose the claude-CLI invocation for a Suthradhara interview turn. Pure —
// exported so xa0.2 (stage-aware prompt) can call it per turn and later beads
// (xa0.4/xa0.5) can swap the allowlist without touching lifecycle code.
//
// cwd is the target Kshetra's repo (the detached runner sets it, lifecycle.ts,
// and the child claude inherits it) so claude reads/greps the RIGHT code base
// and `--setting-sources project` / an ambient project `.mcp.json` resolve there.
// --allowedTools is a positive whitelist (Read/Glob/Grep + read-only bd/git)
// and permission-mode 'default' means an unlisted tool needs approval — with
// stdio ignored in a detached process there's nowhere to approve, so an
// unlisted tool is effectively denied. That's what makes xa0.1's "no bd write
// or file write" hold.
//
// MCP grounding (pmb.4): every server DEFINED in kshetra.mcp.servers is connected
// via `--mcp-config <abs path>`, and we deliberately do NOT pass
// `--strict-mcp-config` — so an operator's ambient project `.mcp.json` also
// connects. Connection injects the server's tool SCHEMAS into the model (the
// model SEES `mcp__jira__get_issue`) while callability stays gated by
// --allowedTools, which carries the read-only surface plus Suthradhara's
// statically-granted MCP tools (pmb.5): an ungranted MCP tool stays
// visible-but-denied until pmb.6 grants it interactively. Verified
// against claude 2.1.212: a denied MCP tool_use rides `permission_denials` in the
// `result` message and does NOT error the turn (capture.ts reads exactly that).
export interface SuthradharaSpawnOpts {
  kshetra: KshetraConfig;
  systemPrompt: string;
  userPrompt: string;
  // In-memory session grants from interactive grant-on-demand (pmb.6), merged on
  // top of the statically-configured per-role grants for THIS turn's allowlist.
  // Absent on a fresh turn; the turn loop passes the accumulated map when it
  // re-spawns after an operator `y`/`always`. Never touches disk here — persistence
  // of an `always` grant is a separate step (persistMcpGrant).
  sessionGrants?: McpGrants;
}

export function buildClaudeSpawn(opts: SuthradharaSpawnOpts): SpawnSpec {
  const { kshetra } = opts;
  // Read-only surface PLUS Suthradhara's MCP grants, compiled to exact
  // `mcp__<server>__<tool>` ids (pmb.5). The grant map is the statically-configured
  // per-role grants (agents.suthradhara.mcp) MERGED with any in-memory session
  // grants the operator approved this session via grant-on-demand (pmb.6).
  // buildFilingSpawn swaps this whole value for filingAllowlist(), which takes no
  // grants — so the granted tracker-read tools ride only the interview turn, never
  // the bd-write turn.
  const allowlist = readOnlyAllowlist(
    mergeGrants(kshetra.agents.suthradhara?.mcp, opts.sessionGrants),
  );

  // Ambient MCP connect + secret injection (shared resolver). Suthradhara connects
  // EVERY defined server — callability is separately gated by --allowedTools (it
  // runs --permission-mode default, where an allow-list IS the boundary), so
  // connecting all defined servers is safe; an ungranted tool stays
  // visible-but-denied. --mcp-config points claude at each server's def file
  // (repo-relative → absolute against repo.path); secretEnv resolves the NAMED
  // host env var and carries it into the child env — never the yaml. A secretEnv
  // naming an unset var fails loud here, before the session starts. resolveMcp
  // throws McpConnectionError; rewrap it so the runner still sees the
  // Suthradhara-specific error type.
  let mcpConfigArgs: string[];
  const secretEnv: Record<string, string> = {};
  try {
    const conn = resolveMcpConnection(kshetra, Object.keys(kshetra.mcp?.servers ?? {}));
    mcpConfigArgs = conn.configPaths.flatMap(p => ['--mcp-config', p]);
    Object.assign(secretEnv, conn.secretEnv);
  } catch (err) {
    if (err instanceof McpConnectionError) throw new SuthradharaSpawnError(err.message);
    throw err;
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--append-system-prompt', opts.systemPrompt,
    '--no-session-persistence',
    '--setting-sources', 'project',
    ...mcpConfigArgs,
    '--model', kshetra.agents.model,
    '--allowedTools', allowlist.join(','),
  ];

  return {
    bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
    args,
    // BEADS_DIR is absolute (kshetra.beads.path) and load-bearing once the child
    // runs in a Suthradhara worktree (ARD §4.4): the `.beads/` symlink is
    // gitignored, so a fresh worktree does NOT contain it — cwd auto-discovery
    // would fail. Passing the absolute dir makes every read-only `bd` (and the
    // post-confirm `bd create`) resolve to the one shared dolt DB regardless of
    // cwd, exactly as commit.ts's server-side `bd` runner already does.
    env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', BEADS_DIR: kshetra.beads.path, ...secretEnv },
    // The operator's message rides STDIN, not a trailing positional argument.
    // `claude`'s --allowedTools is variadic (<tools...>) and greedily consumes a
    // following positional — a trailing prompt arg gets swallowed as a "tool" and
    // the CLI then errors "Input must be provided ..." (verified on 2.1.212).
    // Delivering the prompt on stdin sidesteps arg ordering entirely; capture.ts
    // pipes spec.stdin into the child.
    stdin: opts.userPrompt,
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
  sessionGrants?: McpGrants,
): SpawnSpec {
  return buildClaudeSpawn({
    kshetra,
    systemPrompt: buildSystemPrompt(state, kshetra),
    userPrompt,
    sessionGrants,
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
