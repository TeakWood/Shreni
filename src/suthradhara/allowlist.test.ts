import { describe, it, expect } from 'vitest';
import {
  readOnlyAllowlist,
  filingAllowlist,
  compileMcpGrants,
  McpGrantError,
} from './allowlist';

describe('readOnlyAllowlist', () => {
  const list = readOnlyAllowlist();

  it('exposes Read, Glob, Grep for repo inspection', () => {
    expect(list).toContain('Read');
    expect(list).toContain('Glob');
    expect(list).toContain('Grep');
  });

  it('exposes read-only bd inspection commands', () => {
    expect(list).toContain('Bash(bd list:*)');
    expect(list).toContain('Bash(bd show:*)');
    expect(list).toContain('Bash(bd ready:*)');
    expect(list).toContain('Bash(bd memories:*)');
    expect(list).toContain('Bash(bd deps:*)');
  });

  it('exposes read-only git inspection commands', () => {
    expect(list).toContain('Bash(git status:*)');
    expect(list).toContain('Bash(git log:*)');
    expect(list).toContain('Bash(git diff:*)');
    expect(list).toContain('Bash(git show:*)');
    expect(list).toContain('Bash(git branch:*)');
    expect(list).toContain('Bash(git blame:*)');
  });

  it('never lists a file-write tool', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(list).not.toContain(tool);
    }
  });

  it('never lists a bd-write pattern', () => {
    for (const pattern of ['bd create', 'bd update', 'bd close', 'bd remember', 'bd dep add']) {
      expect(list.some(t => t.includes(pattern))).toBe(false);
    }
  });

  it('never lists a git-mutating pattern', () => {
    for (const pattern of ['git commit', 'git push', 'git reset', 'git checkout', 'git merge']) {
      expect(list.some(t => t.includes(pattern))).toBe(false);
    }
  });
});

describe('filingAllowlist', () => {
  const list = filingAllowlist();

  it('enumerates the filing write surface: bd create and bd dep add', () => {
    expect(list).toContain('Bash(bd create:*)');
    expect(list).toContain('Bash(bd dep add:*)');
  });

  it('is a strict superset of the read-only surface', () => {
    for (const tool of readOnlyAllowlist()) {
      expect(list).toContain(tool);
    }
  });

  // The mandatory negative test (xa0.4 acceptance criteria): claim and close are
  // provably absent from the filing surface, and no bare `bd` wildcard can
  // silently re-admit them.
  it('NEVER lists bd close or bd update --claim (or any mutation of an existing bead)', () => {
    for (const t of list) {
      expect(t).not.toMatch(/bd close/);
      expect(t).not.toMatch(/bd update/);
      expect(t).not.toMatch(/--claim/);
      expect(t).not.toMatch(/--status/);
      expect(t).not.toMatch(/bd remember/);
    }
  });

  it('has no bare `bd` wildcard that would re-admit close/claim', () => {
    // Only the two-token filing verbs and the specific read-only inspection
    // commands are allowed — never `Bash(bd:*)`.
    expect(list).not.toContain('Bash(bd:*)');
    expect(list).not.toContain('Bash(bd :*)');
    for (const t of list) {
      const m = /^Bash\((bd[^:]*):\*\)$/.exec(t);
      if (m) {
        // Every bd pattern is at least two tokens (`bd <verb>`), never a bare `bd`.
        expect(m[1].trim()).not.toBe('bd');
      }
    }
  });

  it('distinguishes the write `bd dep add` from the read-only `bd deps`', () => {
    expect(list).toContain('Bash(bd dep add:*)');
    expect(list).toContain('Bash(bd deps:*)');
    // Neither pattern is a prefix of the other, so admitting one cannot admit
    // the other by prefix match.
    expect('bd deps'.startsWith('bd dep add')).toBe(false);
    expect('bd dep add'.startsWith('bd deps')).toBe(false);
  });
});

describe('compileMcpGrants', () => {
  it('compiles a grant to exactly the named mcp__server__tool ids, in order', () => {
    expect(compileMcpGrants({ jira: ['get_issue', 'search'] })).toEqual([
      'mcp__jira__get_issue',
      'mcp__jira__search',
    ]);
  });

  it('compiles across multiple servers', () => {
    expect(
      compileMcpGrants({ jira: ['get_issue'], linear: ['issue', 'search_issues'] }),
    ).toEqual(['mcp__jira__get_issue', 'mcp__linear__issue', 'mcp__linear__search_issues']);
  });

  it('returns [] for undefined grants and for a server named with no tools', () => {
    expect(compileMcpGrants(undefined)).toEqual([]);
    expect(compileMcpGrants({})).toEqual([]);
    expect(compileMcpGrants({ jira: [] })).toEqual([]);
  });

  it('dedupes a tool named twice', () => {
    expect(compileMcpGrants({ jira: ['get_issue', 'get_issue'] })).toEqual([
      'mcp__jira__get_issue',
    ]);
  });

  it('rejects a whole-server wildcard grant', () => {
    expect(() => compileMcpGrants({ jira: ['*'] })).toThrow(McpGrantError);
  });

  it('rejects a wildcard embedded in a tool name', () => {
    expect(() => compileMcpGrants({ jira: ['get_*'] })).toThrow(McpGrantError);
    expect(() => compileMcpGrants({ jira: ['*_issue'] })).toThrow(McpGrantError);
  });

  it('rejects a wildcard in a server name', () => {
    expect(() => compileMcpGrants({ 'jira*': ['get_issue'] })).toThrow(McpGrantError);
  });

  it('rejects an empty/whitespace tool name', () => {
    expect(() => compileMcpGrants({ jira: [''] })).toThrow(McpGrantError);
    expect(() => compileMcpGrants({ jira: ['  '] })).toThrow(McpGrantError);
  });
});

// The load-bearing boundary (pmb.5 acceptance): granted tracker-READ tools ride
// the read surface only, mutation verbs never enter any Suthradhara allowlist,
// and no grant reaches the filing turn.
describe('MCP grants on the Suthradhara surfaces', () => {
  const grants = { jira: ['get_issue', 'search'] };

  it('appends the compiled ids to the read-only surface', () => {
    const list = readOnlyAllowlist(grants);
    expect(list).toContain('mcp__jira__get_issue');
    expect(list).toContain('mcp__jira__search');
    // The base read-only surface is still fully present.
    for (const base of readOnlyAllowlist()) {
      expect(list).toContain(base);
    }
  });

  it('never appears on the filing surface — filing writes go to bd, not the tracker', () => {
    const filing = filingAllowlist();
    for (const t of filing) {
      expect(t.startsWith('mcp__')).toBe(false);
    }
    // Concretely: the ids that were granted to the read turn are absent here.
    for (const id of compileMcpGrants(grants)) {
      expect(filing).not.toContain(id);
    }
  });

  it('NEVER admits a tracker mutation verb — not in the read set, not in filing', () => {
    const readSurfaces = [readOnlyAllowlist(), readOnlyAllowlist(grants)];
    for (const list of [...readSurfaces, filingAllowlist()]) {
      expect(list).not.toContain('mcp__jira__update_issue');
      expect(list).not.toContain('mcp__jira__create_issue');
      expect(list).not.toContain('mcp__jira__delete_issue');
      expect(list).not.toContain('mcp__jira__add_comment');
    }
  });

  it('cannot sweep in mutation verbs via a wildcard — the wildcard is rejected', () => {
    // The only way update_issue/create_issue could reach the allowlist is a
    // whole-server grant; that is rejected, so they can only ever appear if named
    // one by one (which no read-only grounding grant does).
    expect(() => readOnlyAllowlist({ jira: ['*'] })).toThrow(McpGrantError);
  });
});
