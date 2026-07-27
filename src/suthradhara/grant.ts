// Interactive grant-on-demand — the pure logic behind the `[y / always / N]`
// prompt (bead pmb.6, ARD §4.2/§4.3). capture.ts surfaces the MCP tool_use blocks
// the `--allowedTools` whitelist refused this turn (DeniedTool[]); this module
// decides which of those may be OFFERED to the operator, renders the prompt,
// parses the answer, and folds a grant into the in-memory session-grant map.
//
// The load-bearing rule (§4.3, "read by default"): the prompt presents ONLY read
// tools and never a wildcard, so a single keystroke can never silently open
// write-back. Two guards enforce it here — an exact `mcp__<server>__<tool>` id is
// required (a native denial like `Write` is never grantable this way) and a tool
// whose leading verb is a recognized MUTATION is filtered out before it can be
// offered. A write reaches an external system only through a deliberate static
// config edit plus the server-side confirm gate, never this convenience prompt.
//
// The actual stdin prompt and the yaml persistence are I/O and live in the REPL
// runner; the turn loop depends only on the injected GrantPrompt / PersistGrant
// shapes, so it stays testable without a TTY or a filesystem.

import type { McpGrants } from '../kshetra/config';
import type { DeniedTool } from './capture';

// The operator's answer to one grant prompt. 'session' = grant for the remainder
// of this running session (in memory, re-spawn the turn, nothing on disk);
// 'always' = additionally persist the per-role grant to kshetra.yaml; 'deny' =
// no grant, the model proceeds without the tool.
export type GrantDecision = 'session' | 'always' | 'deny';

// Ask the operator about one denied MCP tool. Injected into the turn loop so tests
// answer with a canned decision and the REPL supplies the real `[y / always / N]`
// stdin prompt. `server`/`tool` are the parsed, exact identifiers (e.g. jira /
// get_issue) — never a wildcard, never a mutation verb (selectGrantable excluded
// those before this is called).
export type GrantPrompt = (server: string, tool: string) => Promise<GrantDecision>;

// Durably persist an 'always' grant. The REPL writes it into
// agents.suthradhara.mcp.<server> in .shreni/kshetra.yaml; tests inject a spy.
// May throw (e.g. the write would invalidate the config) — the turn loop catches
// it and downgrades the grant to session-only with a warning.
export type PersistGrant = (server: string, tool: string) => void;

// A denied tool eligible for the grant prompt, split into its exact parts plus the
// original id (used to dedup and to mark it as already-asked within a turn).
export interface GrantableTool {
  server: string;
  tool: string;
  id: string;
}

// Parse an exact MCP tool id `mcp__<server>__<tool>` into its parts. Returns null
// for anything that is not one — a native tool (`Write`, `Bash`), a malformed id,
// or a bare `mcp__server` with no tool. Splitting on the FIRST `__` after the
// prefix means a tool name carrying single underscores (get_issue) round-trips
// intact while the server stays the segment before it.
export function parseMcpToolId(id: string): { server: string; tool: string } | null {
  if (!id.startsWith('mcp__')) return null;
  const rest = id.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

// Leading verbs that unambiguously MUTATE a system of record. A denied tool whose
// first token (split on `_`/`-`) is one of these is never offered for
// grant-on-demand: the interactive path is read-first, and admitting a write here
// would let a keystroke open write-back. The set is deliberately conservative —
// only clearly-mutating verbs — so an UNRECOGNIZED verb stays offerable (the
// operator, who reads the tool name, is the final classifier) while an obvious
// create_/update_/delete_ is filtered structurally. Read-ish verbs (get, list,
// search, read, fetch, find, query, describe, show, view, lookup, retrieve) are
// intentionally absent, so they pass through.
const MUTATION_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'put', 'post', 'patch',
  'edit', 'write', 'transition', 'merge', 'assign', 'unassign', 'archive',
  'unarchive', 'rename', 'upsert', 'insert', 'modify', 'comment', 'cancel',
  'approve', 'reject', 'submit', 'publish', 'unpublish', 'restore', 'revert',
  'promote', 'demote', 'close', 'reopen', 'move', 'destroy', 'purge', 'replace',
  'upload', 'revoke', 'grant', 'disable', 'enable', 'send',
]);

// Whether a tool name reads as a mutation (write) by its leading verb. Used to keep
// clearly-mutating tools off the interactive grant prompt (§4.3).
export function isMutationTool(tool: string): boolean {
  const verb = tool.toLowerCase().split(/[_-]/, 1)[0];
  return MUTATION_VERBS.has(verb);
}

// Whether a session-grant map already grants `tool` on `server`.
export function grantsInclude(grants: McpGrants, server: string, tool: string): boolean {
  return grants[server]?.includes(tool) ?? false;
}

// Select the denied tools eligible for the interactive prompt: exact MCP ids only
// (native denials excluded), no wildcard, no mutation verb, not already granted
// this session, and not already asked this turn. Deduped by id, first-seen order —
// so a turn that reached for the same tool twice prompts once.
export function selectGrantable(
  denied: DeniedTool[],
  sessionGrants: McpGrants,
  alreadyAsked: ReadonlySet<string>,
): GrantableTool[] {
  const out: GrantableTool[] = [];
  const seen = new Set<string>();
  for (const d of denied) {
    const id = d.name;
    if (seen.has(id) || alreadyAsked.has(id)) continue;
    if (id.includes('*')) continue; // never offer a wildcard
    const parsed = parseMcpToolId(id);
    if (!parsed) continue; // native / malformed → not grantable here
    if (isMutationTool(parsed.tool)) continue; // never offer a write
    if (grantsInclude(sessionGrants, parsed.server, parsed.tool)) continue;
    seen.add(id);
    out.push({ server: parsed.server, tool: parsed.tool, id });
  }
  return out;
}

// Immutably add a granted tool to a session-grant map (dedup, stable order). The
// input map is never mutated so the turn loop can compare before/after cheaply.
export function addGrant(grants: McpGrants, server: string, tool: string): McpGrants {
  const existing = grants[server] ?? [];
  if (existing.includes(tool)) return grants;
  return { ...grants, [server]: [...existing, tool] };
}

// Merge two grant maps (config grants + in-memory session grants) into one for the
// re-spawn allowlist. Tool order is stable and deduped per server; neither input
// is mutated.
export function mergeGrants(a?: McpGrants, b?: McpGrants): McpGrants {
  const out: McpGrants = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [server, tools] of Object.entries(src)) {
      const cur = out[server] ?? (out[server] = []);
      for (const t of tools) if (!cur.includes(t)) cur.push(t);
    }
  }
  return out;
}

// The operator-facing prompt line (§4.2). Names the exact server.tool so the
// operator sees what is being granted; offers only `[y / always / N]`, never a
// wildcard or a mutation verb (selectGrantable already excluded those).
export function renderGrantPrompt(server: string, tool: string): string {
  return `The turn wanted ${server}.${tool} — grant it? [y / always / N]`;
}

// Map a raw operator answer line to a decision. 'always'/'a' → always; 'y'/'yes' →
// session; everything else (empty, 'n', 'no', anything unrecognized) → deny, the
// safe default — an ambiguous keystroke never grants.
export function parseGrantAnswer(line: string): GrantDecision {
  const s = line.trim().toLowerCase();
  if (s === 'always' || s === 'a') return 'always';
  if (s === 'y' || s === 'yes') return 'session';
  return 'deny';
}
