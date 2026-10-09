import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { blockProblem, findBlock, installPrimeHooks, renderBlock, writeBlock } from './instructions';
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
    expect(blockProblem(file, 'tracker')).toMatch(/block is v0, behind v1/);
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
