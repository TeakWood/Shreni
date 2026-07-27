// The tools Suthradhara may use, split by stage. The READ-ONLY set steers the
// discovery/clarify/decompose/design stages; the FILING set is the exact,
// minimal write surface unlocked only AFTER the operator confirms a
// decomposition (xa0.4). Isolated here (rather than inlined into session.ts) so
// the allowlist a turn runs under is a pure function of session state — that is
// what makes "no bd write before confirm" a property we can test, not a promise.
// xa0.5's design-doc write is deliberately NOT here: the settled Q4 choice is
// server-authors-the-file (designdoc.ts writeDesignDoc), so no native `Write`
// grant is added to any allowlist — the model never holds a file-write tool.
// Neither `bd close` nor
// `bd update --claim` is EVER added: filing is create/link only, so a
// Suthradhara session can never claim, close, or mutate an existing bead —
// those stay Sthapathi's alone, out-of-loop by construction.

import type { McpGrants } from '../kshetra/config';

// Raised when a per-role MCP grant cannot be compiled to exact callability ids —
// today only a wildcard or whole-server grant. Rejecting these at compile time is
// the load-bearing boundary: a `mcp__<server>__<tool>` id can only enter an
// allowlist by being named EXACTLY, so a mutation verb (update_issue, create_issue)
// can never ride in on a `*` expansion. Distinct class so a caller can report it
// as an operator config fix, not an internal fault.
export class McpGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpGrantError';
  }
}

// Bare tool identifiers the claude CLI understands (Read/Glob/Grep).
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

// Bash sub-command patterns claude's tool-permission engine matches with the
// `Bash(<pattern>:*)` form. Only inspection commands — nothing that mutates
// beads state, the work tree, or the remote.
export const READ_ONLY_BASH_PATTERNS = [
  'bd list',
  'bd show',
  'bd ready',
  'bd deps',
  'bd memories',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git blame',
] as const;

// The bead-filing write surface (ARD §6.1). Exactly two verbs — create an issue
// and link a dependency — and nothing else. Notably ABSENT and never to be
// added: `bd close`, `bd update` (which is how a claim happens: `--claim` /
// `--status`), `bd remember`, and any bare `bd` wildcard. A confirmed
// decomposition needs to file a parent epic, its children, and the edges
// between them; it never needs to close or claim anything, so it cannot.
//
// The patterns are intentionally the two-token forms `bd create` / `bd dep add`
// rather than `bd` — a `Bash(bd:*)` wildcard would silently re-admit close and
// claim, defeating the whole gate. `bd dep add` (three tokens, the write) is
// distinct from `bd deps` (read, in READ_ONLY_BASH_PATTERNS): neither is a
// prefix of the other, so admitting one never admits the other.
export const FILING_BASH_PATTERNS = [
  'bd create',
  'bd dep add',
] as const;

// Compile a per-role MCP grant map to the exact `mcp__<server>__<tool>`
// callability ids `claude --allowedTools` matches (pmb.5). A grant
// `{ jira: ['get_issue', 'search'] }` yields exactly
// `['mcp__jira__get_issue', 'mcp__jira__search']` — one id per named tool, in
// grant order, deduped. No wildcards: a `*` in a tool name (a whole-server
// grant like `{ jira: ['*'] }`) or in a server name is REJECTED with
// McpGrantError, never silently expanded — that is what guarantees a tracker's
// mutation verbs cannot enter an allowlist unless they are named one by one.
// An empty tool array names a server without granting anything (yields no ids),
// which the config schema deliberately allows.
export function compileMcpGrants(grants?: McpGrants): string[] {
  if (!grants) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [server, tools] of Object.entries(grants)) {
    if (server.includes('*')) {
      throw new McpGrantError(
        `MCP grant server "${server}" contains a wildcard — grants must name an exact server, never a pattern.`,
      );
    }
    for (const tool of tools) {
      if (tool.trim() === '' || tool.includes('*')) {
        throw new McpGrantError(
          `MCP grant "${server}: ${tool || '(empty)'}" is not an exact tool name — ` +
            `wildcards and whole-server grants are rejected; list each tool explicitly (e.g. get_issue, search).`,
        );
      }
      const id = `mcp__${server}__${tool}`;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

// The final allowlist array to pass to `claude --allowedTools`. Each Bash
// pattern is wrapped in the `Bash(<pattern>:*)` form the CLI expects; anything
// not matching is refused (permission-mode default in a detached session has
// no TTY to prompt on, so an unlisted tool is effectively denied).
//
// The optional `grants` are the per-role MCP tools GRANTED to this Suthradhara
// (agents.suthradhara.mcp): they compile to exact `mcp__<server>__<tool>` ids
// APPENDED to the read-only surface (pmb.5). Grants belong on the read surface
// only — the model reads a tracker (get_issue/search) during discovery; it never
// writes back. filingAllowlist() therefore calls this with NO grants, so the
// post-confirm bd-write turn carries zero MCP tools.
export function readOnlyAllowlist(grants?: McpGrants): string[] {
  return [
    ...READ_ONLY_TOOLS,
    ...READ_ONLY_BASH_PATTERNS.map(p => `Bash(${p}:*)`),
    ...compileMcpGrants(grants),
  ];
}

// The allowlist for a post-confirm filing turn: the read-only surface PLUS the
// two filing verbs. It is a strict superset of readOnlyAllowlist() with no
// grants — filing still wants to Read/Grep and inspect beads — extended with
// `bd create` and `bd dep add` only. Note the deliberate call with NO grants:
// filing writes go to bd, never back to the external tracker, so a filing turn
// carries ZERO `mcp__*` ids however the interview turn was granted (pmb.5).
// allowlistForTurn() (session.ts) decides WHEN this is in effect; on its own it
// is just the enumerated surface, so a test can assert the write verbs are
// present and close/claim are absent without spinning up a session.
export function filingAllowlist(): string[] {
  return [
    ...readOnlyAllowlist(),
    ...FILING_BASH_PATTERNS.map(p => `Bash(${p}:*)`),
  ];
}
