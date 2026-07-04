import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadKshetraConfig, KshetraConfigError } from './config.js';

const VALID_YAML = `
id: myapp
name: Myapp
description: Test platform

repo:
  path: /projects/myapp
  remote: git@github.com:TeakWood/myapp.git
  mainBranch: main
  branchPattern: "bead-{id}/{slug}"

beads:
  path: /projects/myapp-beads
  remote: git@github.com:TeakWood/myapp-beads.git
  mode: embedded

stack:
  language: typescript
  framework: nextjs
  testRunner: vitest
  linter: eslint
`;

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `shreni-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadKshetraConfig', () => {
  it('parses a valid kshetra.yaml', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML);
    const config = loadKshetraConfig(path);

    expect(config.id).toBe('myapp');
    expect(config.name).toBe('Myapp');
    expect(config.repo.mainBranch).toBe('main');
    expect(config.beads.mode).toBe('embedded');
    expect(config.stack.language).toBe('typescript');
  });

  it('leaves watchdog undefined when the block is omitted', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML);
    expect(loadKshetraConfig(path).watchdog).toBeUndefined();
  });

  it('parses an optional watchdog override block', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + '\nwatchdog:\n  stuckThresholdMs: 600000\n  maxOutcomeRepeat: 3\n  maxRecoverAttempts: 2\n');
    const config = loadKshetraConfig(path);
    expect(config.watchdog).toEqual({ stuckThresholdMs: 600000, maxOutcomeRepeat: 3, maxRecoverAttempts: 2 });
  });

  it('rejects an invalid watchdog value (maxOutcomeRepeat < 1)', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + '\nwatchdog:\n  maxOutcomeRepeat: 0\n');
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
  });

  it('fills in default values when optional sections are omitted', () => {
    const minimal = `
id: minimal
name: Minimal
repo:
  path: /x
  remote: git@github.com:Org/x.git
beads:
  path: /x-beads
  remote: git@github.com:Org/x-beads.git
stack:
  language: go
`;
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, minimal);
    const config = loadKshetraConfig(path);

    expect(config.agents.model).toBe('claude-sonnet-4-6');
    expect(config.agents.maxRoundsPerBead).toBe(3);
    expect(config.priority.p0AutoAssign).toBe(true);
    expect(config.priority.maxConcurrentBeads).toBe(1);
    expect(config.repo.mainBranch).toBe('main');
  });

  it('throws KshetraConfigError when file does not exist', () => {
    expect(() => loadKshetraConfig(join(dir, 'missing.yaml'))).toThrow(KshetraConfigError);
    expect(() => loadKshetraConfig(join(dir, 'missing.yaml'))).toThrow(/Cannot read file/);
  });

  it('throws KshetraConfigError on invalid YAML syntax', () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, 'id: [unclosed bracket\nname: broken');
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
    expect(() => loadKshetraConfig(path)).toThrow(/Invalid YAML/);
  });

  it('throws KshetraConfigError when required fields are missing', () => {
    const path = join(dir, 'incomplete.yaml');
    writeFileSync(path, 'id: test\nname: Test');
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
    expect(() => loadKshetraConfig(path)).toThrow(/Schema validation failed/);
  });

  it('throws KshetraConfigError when id contains invalid characters', () => {
    const path = join(dir, 'invalid-id.yaml');
    writeFileSync(path, `
id: "My Project"
name: Test
repo:
  path: /x
  remote: git@github.com:Org/x.git
beads:
  path: /x-beads
  remote: git@github.com:Org/x-beads.git
stack:
  language: ts
`);
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
    expect(() => loadKshetraConfig(path)).toThrow(/Schema validation failed/);
  });

  it('includes the config path in error messages', () => {
    const path = join(dir, 'missing.yaml');
    try {
      loadKshetraConfig(path);
    } catch (err) {
      expect(err).toBeInstanceOf(KshetraConfigError);
      expect((err as KshetraConfigError).configPath).toBe(path);
      expect((err as KshetraConfigError).message).toContain(path);
    }
  });
});
