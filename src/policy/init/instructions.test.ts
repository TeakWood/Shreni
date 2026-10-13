import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { beadsLeftovers, blockProblem, findBlock, installPrimeHooks, leftoverWarning, renderBlock, writeBlock } from './instructions';
import { LEGACY_SECTION as SHRENI_SECTION } from './instructions';

// Instructions for agent sessions (policy spec): one block per instruction
// file, between markers naming its mode and version; only that text changes.

const dir = () => mkdtempSync(join(tmpdir(), 'shreni-instructions-'));

describe('the block', () => {
  it('given a CLAUDE.md with text around an old block, when setup runs, then only the text between the markers changes', () => {
    const file = join(dir(), 'CLAUDE.md');
    const before = '# My project\n\nSome rules of ours.\n\n';
    const after = '\n\n## Later section\n\nMore of ours.\n';
    writeFileSync(file, `${before}<!-- shreni:begin tracker v0 -->\nold words\n<!-- shreni:end -->${after}`);
    expect(writeBlock(file, 'tracker')).toBe('updated');
    expect(readFileSync(file, 'utf8')).toBe(`${before}${renderBlock('tracker')}${after}`);
    expect(writeBlock(file, 'tracker')).toBe('unchanged');
  });

  it('given a Kshetra, then its file never gets the tracker block', () => {
    const file = join(dir(), 'CLAUDE.md');
    writeFileSync(file, `intro\n${renderBlock('tracker')}\noutro\n`);
    writeBlock(file, 'kshetra');
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(`intro\n${renderBlock('kshetra')}\noutro\n`);
    expect(text).not.toContain('shreni task claim <id>');
    expect(findBlock(text)).toMatchObject({ mode: 'kshetra', version: 1 });
  });

  it('creates the file, appends to one without a block, and replaces the old SHRENI INTEGRATION section', () => {
    const d = dir();
    expect(writeBlock(join(d, 'AGENTS.md'), 'tracker')).toBe('created');
    expect(readFileSync(join(d, 'AGENTS.md'), 'utf8')).toBe(`${renderBlock('tracker')}\n`);

    const plain = join(d, 'GEMINI.md');
    writeFileSync(plain, '# Ours\nno newline at the end');
    expect(writeBlock(plain, 'tracker')).toBe('added');
    expect(readFileSync(plain, 'utf8')).toBe(`# Ours\nno newline at the end\n\n${renderBlock('tracker')}\n`);

    const legacy = join(d, 'CLAUDE.md');
    writeFileSync(legacy, `# Ours\n${SHRENI_SECTION}\n## After\nkept\n`);
    writeBlock(legacy, 'kshetra');
    const text = readFileSync(legacy, 'utf8');
    expect(text).not.toContain('SHRENI INTEGRATION');
    expect(text).toMatch(/^# Ours\n\n<!-- shreni:begin kshetra v1 -->[\s\S]*<!-- shreni:end -->\n\n## After\nkept\n$/);
  });

  it('says when a file\'s block is missing, of the other kind, or behind', () => {
    const d = dir();
    const file = join(d, 'CLAUDE.md');
    expect(blockProblem(file, 'tracker')).toMatch(/has no Shreni block; run shreni task setup/);
    writeFileSync(file, renderBlock('kshetra'));
    expect(blockProblem(file, 'tracker')).toMatch(/has the kshetra block, but this is a tracker project/);
    writeFileSync(file, '<!-- shreni:begin tracker v0 -->\nx\n<!-- shreni:end -->');
    expect(blockProblem(file, 'tracker')).toMatch(/block is v0, behind v2/);
    writeFileSync(file, renderBlock('tracker'));
    expect(blockProblem(file, 'tracker')).toBeNull();
  });
});

describe('what setup never guesses at', () => {
  it('replaces exactly the old section, keeping whatever followed it', () => {
    const file = join(dir(), 'CLAUDE.md');
    writeFileSync(file, `# Ours\n${SHRENI_SECTION}\n# My notes\nkeep me\n### Sub\nkeep me too\n`);
    writeBlock(file, 'kshetra');
    expect(readFileSync(file, 'utf8')).toBe(`# Ours\n\n${renderBlock('kshetra')}\n\n# My notes\nkeep me\n### Sub\nkeep me too\n`);
  });

  it('refuses a begin marker with no end, rather than taking the text after it', () => {
    const file = join(dir(), 'CLAUDE.md');
    const text = `<!-- shreni:begin tracker v1 -->\nimportant user text\n${renderBlock('tracker')}\n`;
    writeFileSync(file, text);
    expect(() => writeBlock(file, 'tracker')).toThrow(/has no end marker; fix the Shreni markers by hand/);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(blockProblem(file, 'tracker')).toMatch(/has no end marker/);
  });

  it('removes a second block, so a stale one never survives, and prime notices it first', () => {
    const file = join(dir(), 'CLAUDE.md');
    writeFileSync(file, `a\n${renderBlock('kshetra')}\nb\n${renderBlock('tracker')}\nc\n`);
    expect(blockProblem(file, 'kshetra')).toMatch(/has 2 Shreni blocks/);
    writeBlock(file, 'kshetra');
    expect(readFileSync(file, 'utf8')).toBe(`a\n${renderBlock('kshetra')}\nb\n\nc\n`);
  });

  it('leaves a block shown inside a code fence alone', () => {
    const file = join(dir(), 'CLAUDE.md');
    const example = `Our docs show the format:\n\n\`\`\`markdown\n<!-- shreni:begin tracker v0 -->\nexample\n<!-- shreni:end -->\n\`\`\`\n`;
    writeFileSync(file, example);
    expect(writeBlock(file, 'tracker')).toBe('added');
    expect(readFileSync(file, 'utf8')).toBe(`${example}\n${renderBlock('tracker')}\n`);
  });

  it('keeps a CRLF file\'s line endings, and finds its old section', () => {
    const file = join(dir(), 'CLAUDE.md');
    writeFileSync(file, `# Ours\r\n${SHRENI_SECTION.replace(/\n/g, '\r\n')}`);
    writeBlock(file, 'tracker');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('SHRENI INTEGRATION');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('beads instructions left behind', () => {
  const HAND_WRITTEN = [
    '# Project',
    '',
    '## Beads Issue Tracker',
    '',
    'This project uses **bd (beads)** for issue tracking.',
    '',
    '```bash',
    'bd ready              # Find available work',
    'bd update <id> --claim',
    '```',
    '',
    '## Build & Test',
    '',
    'pnpm build',
    '',
    '## Beads Repository & Sync',
    '',
    'bd export -o .beads/issues.jsonl',
    'cd .beads && git push',
    '',
  ].join('\n');

  const lines = (text: string) => beadsLeftovers(text).map(l => [l.line, l.text]);

  it('finds the headings, the bd commands and the .beads paths, with their line numbers', () => {
    expect(lines(HAND_WRITTEN)).toEqual([
      [3, '## Beads Issue Tracker'],
      [5, 'This project uses **bd (beads)** for issue tracking.'],
      [8, 'bd ready              # Find available work'],
      [9, 'bd update <id> --claim'],
      [16, '## Beads Repository & Sync'],
      [18, 'bd export -o .beads/issues.jsonl'],
      [19, 'cd .beads && git push'],
    ]);
  });

  it('catches bd named by a path or quoted, never words that only contain bd', () => {
    expect(lines('/usr/local/bin/bd ready\nrun "bd prime"\nbdd tests\nembedded db\nkbd layout\nbd 1.0.3\n').map(l => l[0])).toEqual([1, 2]);
  });

  it('never counts Shreni\'s own block, or a file with nothing of beads in it', () => {
    expect(beadsLeftovers(`# Ours\n\n${renderBlock('tracker')}\n`)).toEqual([]);
    expect(beadsLeftovers(`# Ours\n\n${renderBlock('kshetra')}\n`)).toEqual([]);
    expect(beadsLeftovers('# Ours\n\nWe build with pnpm; bdd tests live in e2e/.\n')).toEqual([]);
  });

  it('skips every line inside a block, wherever it sits, and counts all of a broken one', () => {
    const inside = 'bd x\n<!-- shreni:begin tracker v0 -->\nbd ready\n<!-- shreni:end -->\nbd y\n';
    expect(lines(inside).map(l => l[0])).toEqual([1, 5]);
    expect(lines(inside.replace(/\n/g, '\r\n'))).toEqual([[1, 'bd x'], [5, 'bd y']]);
    expect(lines('<!-- shreni:begin tracker v0 -->\nbd ready\n<!-- shreni:end -->\nbd y')).toEqual([[4, 'bd y']]);
    expect(lines('bd x\n<!-- shreni:begin tracker v0 -->\nbd ready\n<!-- shreni:end -->')).toEqual([[1, 'bd x']]);
    expect(lines('<!-- shreni:begin tracker v0 -->\nbd ready\n').map(l => l[0])).toEqual([2]);
  });

  it('given the leftovers beside the written block, still finds them outside it', () => {
    const text = `${HAND_WRITTEN}\n${renderBlock('tracker')}\n`;
    expect(beadsLeftovers(text).map(l => l.line)).toEqual([3, 5, 8, 9, 16, 18, 19]);
  });

  it('warns naming the file and each section with all its lines, never editing it', () => {
    const d = dir();
    const file = join(d, 'CLAUDE.md');
    writeFileSync(file, `intro: run bd ready\n${HAND_WRITTEN.replace('# Project\n', '')}\n## Notes\n\n\`\`\`bash\n# not a heading\nbd sync\n\`\`\`\n`);
    writeBlock(file, 'tracker');
    const before = readFileSync(file, 'utf8');
    expect(leftoverWarning(file)).toEqual([
      `${file}: beads instructions are still there, outside Shreni's block; remove them, or rewrite them for shreni task:`,
      '  before any heading — line 1',
      '  line 3: ## Beads Issue Tracker — lines 3, 5, 8, 9',
      '  line 16: ## Beads Repository & Sync — lines 16, 18, 19',
      '  line 21: ## Notes — line 25',
    ]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(leftoverWarning(join(d, 'none.md'))).toBeNull();
    writeFileSync(file, '# clean\n');
    expect(leftoverWarning(file)).toBeNull();
  });

  it('names every line however many there are', () => {
    const d = dir();
    const file = join(d, 'CLAUDE.md');
    writeFileSync(file, Array.from({ length: 60 }, (_, i) => `bd show x-${i}`).join('\n'));
    expect(leftoverWarning(file)![1]).toBe(`  before any heading — lines ${Array.from({ length: 60 }, (_, i) => i + 1).join(', ')}`);
  });
});

describe('Claude Code hooks', () => {
  it('replace bd prime with shreni task prime on session start and compaction, keeping every other hook', () => {
    const repo = dir();
    mkdirSync(join(repo, '.claude'));
    const file = join(repo, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }, { type: 'command', command: 'echo hi' }] }],
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'bd prime' }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'sync' }] }],
      },
    }));
    expect(installPrimeHooks(repo)).toBe(true);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.hooks.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'sync' }] }]);
    expect(s.hooks.SessionStart).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'shreni task prime' }] },
    ]);
    expect(s.hooks.PreCompact).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'shreni task prime' }] }]);
    expect(installPrimeHooks(repo)).toBe(false);
  });

  it('refuses settings it can\'t read safely, naming the file', () => {
    const repo = dir();
    mkdirSync(join(repo, '.claude'));
    const file = join(repo, '.claude', 'settings.json');
    for (const [text, why] of [
      ['{ not json', /isn't valid JSON/],
      ['{"hooks": []}', /"hooks" isn't an object of events/],
      ['{"hooks": {"SessionStart": {"hooks": []}}}', /hooks\.SessionStart isn't a list/],
      ['{"hooks": {"PreCompact": [{"hooks": {}}]}}', /hooks\.PreCompact isn't a list/],
    ] as const) {
      writeFileSync(file, text);
      expect(() => installPrimeHooks(repo)).toThrow(why);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });

  it('creates the settings file when there is none', () => {
    const repo = dir();
    expect(installPrimeHooks(repo)).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
  });
});
