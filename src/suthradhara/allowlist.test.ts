import { describe, it, expect } from 'vitest';
import { readOnlyAllowlist, filingAllowlist } from './allowlist';

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
