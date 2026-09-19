import { describe, it, expect } from 'vitest';
import { parseLabels, labelsToArgs } from './labels.js';

describe('parseLabels (epic yrk / Study B2, yrk.4)', () => {
  it('collects repeatable --label key=value verbatim, ignoring other flags', () => {
    // The acceptance example: `shreni start --kshetra x --label arm=A --label rep=2`.
    expect(parseLabels(['--kshetra', 'x', '--label', 'arm=A', '--label', 'rep=2'])).toEqual({
      arm: 'A', rep: '2',
    });
  });

  it('returns {} when there are no labels', () => {
    expect(parseLabels(['--kshetra', 'x'])).toEqual({});
    expect(parseLabels([])).toEqual({});
  });

  it('keeps a value verbatim, including = and CHG-style team tags', () => {
    expect(parseLabels(['--label', 'change=CHG-1234', '--label', 'note=a=b=c'])).toEqual({
      change: 'CHG-1234', note: 'a=b=c',
    });
  });

  it('accepts keys of [a-z0-9_.-]', () => {
    expect(parseLabels(['--label', 'a.b_c-1=v'])).toEqual({ 'a.b_c-1': 'v' });
  });

  it('rejects a duplicate key', () => {
    expect(() => parseLabels(['--label', 'arm=A', '--label', 'arm=B'])).toThrow(/Duplicate --label key "arm"/);
  });

  it('rejects a malformed pair (no =)', () => {
    expect(() => parseLabels(['--label', 'armA'])).toThrow(/expected <key>=<value>/);
  });

  it('rejects an empty value', () => {
    expect(() => parseLabels(['--label', 'arm='])).toThrow(/value must be non-empty/);
  });

  it('rejects an empty key', () => {
    expect(() => parseLabels(['--label', '=A'])).toThrow(/expected <key>=<value>/);
  });

  it('rejects an invalid key character (uppercase)', () => {
    expect(() => parseLabels(['--label', 'Arm=A'])).toThrow(/expected \[a-z0-9_\.-\]\+/);
  });

  it('rejects a missing value (--label at end or followed by another flag)', () => {
    expect(() => parseLabels(['--label'])).toThrow(/missing value/);
    expect(() => parseLabels(['--label', '--kshetra', 'x'])).toThrow(/missing value/);
  });

  it('enforces max key/value lengths', () => {
    expect(() => parseLabels(['--label', `${'k'.repeat(65)}=v`])).toThrow(/chars/);
    expect(() => parseLabels(['--label', `k=${'v'.repeat(257)}`])).toThrow(/chars/);
  });
});

describe('labelsToArgs (yrk.4)', () => {
  it('round-trips through parseLabels — the start → worker threading path', () => {
    const labels = { arm: 'A', rep: '2', change: 'CHG-1' };
    const args = labelsToArgs(labels);
    expect(args).toEqual(['--label', 'arm=A', '--label', 'rep=2', '--label', 'change=CHG-1']);
    // The worker re-parses exactly what start encoded.
    expect(parseLabels(['myapp', ...args])).toEqual(labels);
  });

  it('encodes an empty map to no args', () => {
    expect(labelsToArgs({})).toEqual([]);
  });
});
