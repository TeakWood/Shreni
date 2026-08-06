import type { KshetraConfig } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';
import { resolveBin } from '../agents/providers/types';
import { resolveMcpConnection, McpConnectionError } from '../kshetra/mcp-connect';
import { buildPlanningPrompt } from './prompt';

// Compose the INTERACTIVE `claude` invocation for a launched planning session
// (epic d3y). Unlike the old per-turn headless spawn (buildClaudeSpawn, removed
// with the interview engine), this drops `-p`/`--output-format stream-json`: the
// operator drives a real interactive Claude Code session that holds the
// conversation itself and executes the completion protocol (files beads, writes
// the doc, syncs beads, pushes the branch). The runner spawns it with inherited
// stdio in the session worktree.
//
// TOOLS. This is a full session — it must Write the design doc and run bd/git —
// so there is NO `--allowedTools` whitelist and no grant-on-demand layer: the
// operator is at the keyboard and approves Claude Code's own permission prompts.
// The read-only/grant machinery the headless turns needed is gone.
//
// MCP grounding. Every server DEFINED in kshetra.mcp.servers is connected via
// `--mcp-config <abs path>` (secretEnv injected into the child env), so the model
// can reach the operator's tickets during discovery; callability is governed by
// Claude Code's interactive permission prompts, not a compiled allowlist.
//
// SESSION IDENTITY. A fresh launch pins the Claude Code session id with
// `--session-id <uuid>` so `resume` can later reattach with `--resume <uuid>`;
// on resume we pass `--resume` alone and let Claude Code restore the prior
// conversation (system prompt included), so we do not re-append it.

export class SuthradharaSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuthradharaSpawnError';
  }
}

export interface PlanningSessionOpts {
  kshetra: KshetraConfig;
  // The Claude Code session id to pin (fresh) or reattach (resume).
  claudeSessionId: string;
  // Resume an existing Claude Code conversation rather than starting fresh. When
  // true we pass `--resume <id>` and omit the system prompt + kickoff (Claude
  // Code restores them); when false we pass `--session-id <id>` +
  // `--append-system-prompt` + the kickoff message.
  resume?: boolean;
  // The first operator-facing message that kicks the interview off (fresh launch
  // only). Delivered as claude's initial positional prompt.
  kickoff?: string;
  // When the operator chose "extend this topic", the prior session's design-doc
  // repo-relative path — seeded into the planning prompt (fresh launch only).
  extendDocRelPath?: string;
}

// Build the interactive spawn spec. Pure — exported so the runner and tests can
// assemble the invocation without spawning a process.
export function buildPlanningSession(opts: PlanningSessionOpts): SpawnSpec {
  const { kshetra } = opts;

  // Connect every defined MCP server (secretEnv resolved into the child env). A
  // secretEnv naming an unset host var fails loud here, before the session
  // starts. Rewrap McpConnectionError as the Suthradhara-specific type.
  let mcpConfigArgs: string[] = [];
  const secretEnv: Record<string, string> = {};
  try {
    const conn = resolveMcpConnection(kshetra, Object.keys(kshetra.mcp?.servers ?? {}));
    mcpConfigArgs = conn.configPaths.flatMap(p => ['--mcp-config', p]);
    Object.assign(secretEnv, conn.secretEnv);
  } catch (err) {
    if (err instanceof McpConnectionError) throw new SuthradharaSpawnError(err.message);
    throw err;
  }

  const args: string[] = [];
  if (opts.resume) {
    args.push('--resume', opts.claudeSessionId);
  } else {
    args.push('--session-id', opts.claudeSessionId);
    args.push('--append-system-prompt', buildPlanningPrompt(kshetra, {
      extendDocRelPath: opts.extendDocRelPath,
    }));
  }
  args.push('--setting-sources', 'project');
  args.push(...mcpConfigArgs);
  args.push('--model', kshetra.agents.model);
  // Positional kickoff prompt (fresh launch only). claude treats a trailing
  // positional in interactive mode as the first user message.
  if (!opts.resume && opts.kickoff) {
    args.push(opts.kickoff);
  }

  return {
    bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
    args,
    // BEADS_DIR is absolute (kshetra.beads.path) and load-bearing in a worktree:
    // the `.beads/` symlink is gitignored, so a fresh worktree has none and cwd
    // auto-discovery would fail. Passing the absolute dir makes every `bd` (read
    // and the completion-protocol `bd create`/`bd export`) resolve to the one
    // shared dolt DB regardless of cwd.
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli', BEADS_DIR: kshetra.beads.path, ...secretEnv },
  };
}

// The default kickoff message for a fresh planning session — a short nudge into
// Stage 1 (discovery). Kept here so the runner and tests share one source.
export function defaultKickoff(extend: boolean): string {
  return extend
    ? 'Continue planning — extend the prior topic. Start by reading the seeded design doc, then ask me what to add or change.'
    : "Let's plan a feature. Start the discovery interview: ask me what problem I want to solve, who hits it, and why now.";
}
