import type { KshetraConfig } from '../kshetra/config';
import { requireProject, resolveAgentModel } from '../kshetra/config';
import type { SpawnSpec } from '../agents/providers/types';
import { resolveBin } from '../agents/providers/types';
import { resolveMcpConnection, McpConnectionError } from '../kshetra/mcp-connect';
import { buildPlanningPrompt } from './prompt';
import { KSHETRA_ENV, PLAN_ENV } from '../policy/suthradhara/filing';

// Compose the INTERACTIVE `claude` invocation for a launched planning session
// (epic d3y). Unlike the old per-turn headless spawn (buildClaudeSpawn, removed
// with the interview engine), this drops `-p`/`--output-format stream-json`: the
// operator drives a real interactive Claude Code session that holds the
// conversation itself and executes the completion protocol (files the plan,
// writes the doc, pushes the branch). The runner spawns it with inherited
// stdio in the session worktree.
//
// TOOLS. This is a full session — it must Write the design doc and run shreni/git —
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
  // On the task graph engine: the plan the session files into with `shreni plan`.
  planId?: string;
}

// Build the interactive spawn spec. Pure — exported so the runner and tests can
// assemble the invocation without spawning a process.
export function buildPlanningSession(opts: PlanningSessionOpts): SpawnSpec {
  const { kshetra } = opts;
  requireProject(kshetra);
  if (!opts.planId) {
    throw new SuthradharaSpawnError(`${kshetra.id}: a planning session needs the plan it files into`);
  }
  const planId = opts.planId;

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
      planId,
    }));
  }
  args.push('--setting-sources', 'project');
  args.push(...mcpConfigArgs);
  // Suthradhara's session is claude-driven, so only the model override applies
  // here (a per-role provider is honored on the runAgent path, b0f.2).
  args.push('--model', resolveAgentModel(kshetra, 'suthradhara').model);
  // Positional kickoff prompt (fresh launch only). claude treats a trailing
  // positional in interactive mode as the first user message.
  if (!opts.resume && opts.kickoff) {
    args.push(opts.kickoff);
  }

  return {
    bin: resolveBin('SHRENI_CLAUDE_BIN', 'claude'),
    args,
    // The session gets its plan and Kshetra, and files with `shreni plan` as
    // the planner (policy spec, "Approval: humans only"); there is nothing to sync.
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      [PLAN_ENV]: planId,
      [KSHETRA_ENV]: kshetra.id,
      ...secretEnv,
    },
  };
}

// The default kickoff message for a fresh planning session — a short nudge into
// Stage 1 (discovery). Kept here so the runner and tests share one source.
export function defaultKickoff(extend: boolean): string {
  return extend
    ? 'Continue planning — extend the prior topic. Start by reading the seeded design doc, then ask me what to add or change.'
    : "Let's plan a feature. Start the discovery interview: ask me what problem I want to solve, who hits it, and why now.";
}
