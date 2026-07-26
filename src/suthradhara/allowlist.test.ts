import { describe, it, expect } from 'vitest';
import { readOnlyAllowlist } from './allowlist';

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
