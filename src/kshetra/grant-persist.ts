import { readFileSync, writeFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { KshetraConfigSchema, type AgentRole } from './config.js';

// Persist an interactive `always` MCP grant into a Kshetra's kshetra.yaml (bead
// pmb.6, ARD §4.2). This is the ONLY writer of an MCP grant into config — the
// durable form of an operator's interactive `always`. It appends the exact tool to
// `agents.<role>.mcp.<server>`, creating the intermediate blocks if absent, and
// round-trips everything else through js-yaml untouched.
//
// Two guards keep the config surface honest:
//   • It refuses a wildcard or an empty tool — config must never carry a `*` grant
//     (the allowlist compiler rejects one anyway; this stops it reaching disk).
//     A mutation verb is already filtered upstream at the grant prompt, so only a
//     read tool ever arrives here.
//   • It re-validates the mutated document against the full schema BEFORE writing.
//     The schema's superRefine rejects a grant to a server not defined under
//     `mcp.servers`; so an `always` on an ambient-only server (connected via a
//     project .mcp.json but never declared in kshetra.yaml) throws here rather than
//     corrupting the file — the caller then keeps the grant session-only.
export function persistMcpGrant(
  configPath: string,
  role: AgentRole,
  server: string,
  tool: string,
): void {
  if (server.includes('*') || tool.includes('*') || tool.trim() === '') {
    throw new Error(
      `refusing to persist non-exact MCP grant "${server}.${tool || '(empty)'}" — ` +
        `grants must name an exact server and tool, never a wildcard.`,
    );
  }

  const raw = readFileSync(configPath, 'utf8');
  const doc = (yaml.load(raw) ?? {}) as Record<string, unknown>;

  // Walk/create agents.<role>.mcp.<server> and append the tool (idempotent).
  const agents = asObject(doc, 'agents');
  const roleCfg = asObject(agents, role);
  const mcp = asObject(roleCfg, 'mcp');
  const existing = mcp[server];
  const tools = Array.isArray(existing) ? (existing as string[]) : (mcp[server] = []);
  if (!tools.includes(tool)) tools.push(tool);

  // Fail before writing if the edit would make the config unloadable (e.g. the
  // server isn't defined under mcp.servers). safeParse does not mutate `doc`, so
  // on success we still dump the minimally-mutated original, not the schema's
  // defaults-expanded copy.
  const result = KshetraConfigSchema.safeParse(doc);
  if (!result.success) {
    const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `persisting grant ${server}.${tool} would make kshetra.yaml invalid — ${detail}`,
    );
  }

  writeFileSync(configPath, yaml.dump(doc, { lineWidth: 100, noRefs: true }), 'utf8');
}

// Fetch `parent[key]` as a plain object, creating an empty one when it is absent
// or not an object. Used to lazily materialize the agents.<role>.mcp nesting.
function asObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = parent[key];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    return cur as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}
