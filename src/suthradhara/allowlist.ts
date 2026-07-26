// The tools Suthradhara may use during its READ-ONLY discovery/clarify stages.
// Isolated here (rather than inlined into session.ts) so later beads can extend
// it — xa0.4 adds a bead-filing surface (bd create / bd dep add) behind a
// confirm gate, and xa0.5 adds a path-scoped design-doc write. Neither claim/
// close nor arbitrary shell/git-writes are ever added: those stay out-of-loop
// by construction.

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
