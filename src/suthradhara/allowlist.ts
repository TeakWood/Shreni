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

// The final allowlist array to pass to `claude --allowedTools`. Each Bash
// pattern is wrapped in the `Bash(<pattern>:*)` form the CLI expects; anything
// not matching is refused (permission-mode default in a detached session has
// no TTY to prompt on, so an unlisted tool is effectively denied).
export function readOnlyAllowlist(): string[] {
  return [
    ...READ_ONLY_TOOLS,
    ...READ_ONLY_BASH_PATTERNS.map(p => `Bash(${p}:*)`),
  ];
}

// The allowlist for a post-confirm filing turn: the read-only surface PLUS the
// two filing verbs. It is a strict superset of readOnlyAllowlist() — filing
// still wants to Read/Grep and inspect beads — extended with `bd create` and
// `bd dep add` only. allowlistForTurn() (session.ts) decides WHEN this is in
// effect; on its own it is just the enumerated surface, so a test can assert
// the write verbs are present and close/claim are absent without spinning up a
// session.
export function filingAllowlist(): string[] {
  return [
    ...readOnlyAllowlist(),
    ...FILING_BASH_PATTERNS.map(p => `Bash(${p}:*)`),
  ];
}
