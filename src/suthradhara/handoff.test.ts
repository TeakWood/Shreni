import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  handoffRelPath,
  handoffPath,
  writeHandoff,
  readHandoff,
  clearHandoff,
  type Handoff,
} from './handoff';

let WT: string;
beforeEach(() => { WT = mkdtempSync(join(tmpdir(), 'suthradhara-handoff-')); });
afterEach(() => { rmSync(WT, { recursive: true, force: true }); });

const SAMPLE: Handoff = {
  branch: 'suthradhara/sso-login',
  epicId: 'myapp-abc',
  docPath: '.shreni/design/sso-login.md',
  summary: 'SSO login epic with 4 children',
};

describe('handoff round-trip', () => {
  it('writes and reads back the record', () => {
    writeHandoff(WT, SAMPLE);
    expect(readHandoff(WT)).toEqual(SAMPLE);
  });

  it('places the file at the fixed dot-prefixed worktree path', () => {
    expect(handoffRelPath()).toBe('.suthradhara-handoff.json');
    expect(handoffPath(WT)).toBe(join(WT, '.suthradhara-handoff.json'));
  });

  it('clearHandoff removes it and is tolerant of an absent file', () => {
    writeHandoff(WT, SAMPLE);
    clearHandoff(WT);
    expect(readHandoff(WT)).toBeNull();
    expect(() => clearHandoff(WT)).not.toThrow();
  });
});

describe('readHandoff tolerance (degraded menu, never a throw)', () => {
  it('returns null when the file is absent', () => {
    expect(readHandoff(WT)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    writeFileSync(handoffPath(WT), '{ not json', 'utf8');
    expect(readHandoff(WT)).toBeNull();
  });

  it('returns null when a required field is missing or wrong-typed', () => {
    writeFileSync(handoffPath(WT), JSON.stringify({ branch: 'b', epicId: 'e', docPath: 'd' }), 'utf8');
    expect(readHandoff(WT)).toBeNull();
    writeFileSync(handoffPath(WT), JSON.stringify({ ...SAMPLE, epicId: 42 }), 'utf8');
    expect(readHandoff(WT)).toBeNull();
  });
});
