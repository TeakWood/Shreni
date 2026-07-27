import { resolve } from 'path';
import type { KshetraConfig } from './config.js';

// Raised when an MCP connection cannot be resolved for a spawn — an unknown
// server name, or a `secretEnv` naming a host env var that is unset. Failing here
// means the connection is misconfigured BEFORE the session/agent starts, never
// silently at the first tool call. Distinct class so a caller can report it as an
// operator config fix, not an internal fault. (Suthradhara wraps this as
// SuthradharaSpawnError to preserve its own error surface.)
export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

// The resolved MCP connection for a spawn: absolute paths to each server's
// mcp-config file (repo-relative in yaml → absolute against repo.path so it does
// not depend on the inherited cwd) and the secretEnv values to inject into the
// child process's environment. A plain shape so the provider-agnostic
// AgentRunnerOpts can carry it without importing kshetra config.
export interface McpConnection {
  configPaths: string[];
  secretEnv: Record<string, string>;
}

// Resolve the named MCP servers to their config-file paths + secret env values.
// `serverNames` must each be defined under `kshetra.mcp.servers`; an unknown name
// throws (the config schema's superRefine already rejects a grant to an undefined
// server, so this is a belt-and-suspenders guard for callers that pass a name
// list directly). A server's `secretEnv` names a host env var; its value is
// resolved here and returned for injection — never read from the yaml. A
// secretEnv naming an unset var throws, so a missing token fails loud before the
// spawn rather than at the first authenticated call.
export function resolveMcpConnection(kshetra: KshetraConfig, serverNames: string[]): McpConnection {
  const defined = kshetra.mcp?.servers ?? {};
  const configPaths: string[] = [];
  const secretEnv: Record<string, string> = {};

  for (const name of serverNames) {
    const server = defined[name];
    if (!server) {
      throw new McpConnectionError(
        `MCP server "${name}" is not defined under mcp.servers — define it before granting it.`,
      );
    }
    configPaths.push(resolve(kshetra.repo.path, server.config));
    if (server.secretEnv) {
      const value = process.env[server.secretEnv];
      if (!value) {
        throw new McpConnectionError(
          `MCP server "${name}" requires env var ${server.secretEnv}, but it is unset — ` +
            `export it before starting the run (the token is never stored in kshetra.yaml).`,
        );
      }
      secretEnv[server.secretEnv] = value;
    }
  }

  return { configPaths, secretEnv };
}

// The executor roles that may carry a static MCP grant. Sthapathi runs no
// tool-bearing session; Suthradhara has its own (interactive) connect path.
export type ExecutorRole = 'silpi' | 'viharapala' | 'parikshaka';

// Resolve the static MCP connection for a headless executor role (pmb.8). Unlike
// Suthradhara — which connects EVERY defined server and gates callability with
// --allowedTools — an executor runs under bypassPermissions, where an allow-list
// is inert (allow rules are a no-op in bypass). So an executor connects ONLY the
// servers its role explicitly grants in `agents.<role>.mcp`, and every tool on a
// connected server is callable. The grant is therefore a whole-server decision:
// list a server here only if this autonomous agent may use ALL of its tools.
//
// Returns undefined when the role has no grant — the caller then passes no MCP
// connection and the executor spawns with --strict-mcp-config alone, i.e. zero
// MCP (off by default). The connection derives PURELY from static config; there
// is no session-grant or interactive path for an executor (the grant-on-demand
// loop is wired only into Suthradhara's REPL), so the supervised/autonomous split
// holds by construction.
export function resolveExecutorMcp(kshetra: KshetraConfig, role: ExecutorRole): McpConnection | undefined {
  const serverNames = Object.keys(kshetra.agents[role]?.mcp ?? {});
  if (serverNames.length === 0) return undefined;
  return resolveMcpConnection(kshetra, serverNames);
}
