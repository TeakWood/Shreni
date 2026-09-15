import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { untrackInteractions } from './beads-gitignore.js';

// A faithful slice of the bd-written beads .gitignore.
const BD_GITIGNORE = [
  '# Dolt database (managed by Dolt, not git)',
  'dolt/',
  'embeddeddolt/',
  '',
  '# Interactions log (runtime, not versioned)',
  'interactions.jsonl',
  '',
  '# Push state (runtime, per-machine)',
  'push-state.json',
  '',
].join('\n');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'beads-gi-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function gitignore(): string {
  return readFileSync(join(dir, '.gitignore'), 'utf8');
}

describe('untrackInteractions', () => {
  it('removes the active interactions.jsonl ignore entry and its bd comment', () => {
    writeFileSync(join(dir, '.gitignore'), BD_GITIGNORE);
    expect(untrackInteractions(dir)).toBe('changed');
    const out = gitignore();
    // No active ignore line for interactions.jsonl remains.
    expect(out.split('\n').some(l => l.trim() === 'interactions.jsonl')).toBe(false);
    // bd's now-misleading comment is gone; a Shreni marker explains the change.
    expect(out).not.toContain('# Interactions log (runtime, not versioned)');
    expect(out).toContain('tracked by Shreni');
  });

  it('leaves every other bd ignore entry byte-for-byte intact', () => {
    writeFileSync(join(dir, '.gitignore'), BD_GITIGNORE);
    untrackInteractions(dir);
    const out = gitignore();
    for (const kept of ['dolt/', 'embeddeddolt/', 'push-state.json', '# Push state (runtime, per-machine)']) {
      expect(out).toContain(kept);
    }
  });

  it('is idempotent — a second run makes no further change', () => {
    writeFileSync(join(dir, '.gitignore'), BD_GITIGNORE);
    expect(untrackInteractions(dir)).toBe('changed');
    const afterFirst = gitignore();
    expect(untrackInteractions(dir)).toBe('already');
    expect(gitignore()).toBe(afterFirst);
  });

  it('never introduces a negation pattern (which bd warns overrides fork protection)', () => {
    writeFileSync(join(dir, '.gitignore'), BD_GITIGNORE);
    untrackInteractions(dir);
    expect(gitignore()).not.toContain('!interactions.jsonl');
  });

  it('reports no_gitignore when the beads repo has no .gitignore', () => {
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(untrackInteractions(dir)).toBe('no_gitignore');
  });

  it('treats an already-commented line as already done (no active entry)', () => {
    writeFileSync(join(dir, '.gitignore'), '# interactions.jsonl\ndolt/\n');
    expect(untrackInteractions(dir)).toBe('already');
  });
});
