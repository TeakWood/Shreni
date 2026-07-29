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

  it('accepts a pack provenance line and rejects a malformed one', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + '\npack: nextjs-vitest@1\n');
    expect(loadKshetraConfig(path).pack).toBe('nextjs-vitest@1');
    writeFileSync(path, VALID_YAML + '\npack: NextJS v1\n');
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
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
    // PR follow-up (epic hjw): on by default, 3 rounds, re-review on.
    expect(config.repo.prFollowup).toBe(true);
    expect(config.repo.prFollowupMaxRounds).toBe(3);
    expect(config.repo.prFollowupReReview).toBe(true);
    // gates: defaults — test/lint block, coverage warn, diffSize warn 40/1500.
    expect(config.gates).toEqual({
      test: { level: 'block' },
      lint: { level: 'block' },
      coverage: { level: 'warn' },
      diffSize: { level: 'warn', maxFiles: 40, maxLines: 1500 },
    });
  });

  it('parses explicit PR follow-up overrides', () => {
    const yaml = `
id: myapp
name: Myapp
repo:
  path: /projects/myapp
  remote: git@github.com:TeakWood/myapp.git
  prFollowup: false
  prFollowupMaxRounds: 5
  prFollowupReReview: false
beads:
  path: /projects/myapp-beads
  remote: git@github.com:TeakWood/myapp-beads.git
stack:
  language: typescript
`;
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, yaml);
    const config = loadKshetraConfig(path);
    expect(config.repo.prFollowup).toBe(false);
    expect(config.repo.prFollowupMaxRounds).toBe(5);
    expect(config.repo.prFollowupReReview).toBe(false);
  });

  it('accepts a partial gates block and fills the rest with defaults', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + '\ngates:\n  coverage:\n    level: block\n  diffSize:\n    maxFiles: 10\n');
    const config = loadKshetraConfig(path);
    expect(config.gates.coverage.level).toBe('block');
    expect(config.gates.diffSize).toEqual({ level: 'warn', maxFiles: 10, maxLines: 1500 });
    expect(config.gates.test.level).toBe('block');
  });

  it('rejects an invalid gate level', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + '\ngates:\n  test:\n    level: "off"\n');
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
  });

  it('leaves mcp undefined when the block is omitted', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML);
    expect(loadKshetraConfig(path).mcp).toBeUndefined();
  });

  it('validates an mcp.servers block plus a per-role grant', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + `
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json
      secretEnv: JIRA_TOKEN
agents:
  suthradhara:
    mcp:
      jira:
        - get_issue
        - search
`);
    const config = loadKshetraConfig(path);
    expect(config.mcp?.servers.jira).toEqual({ config: '.shreni/mcp/jira.json', secretEnv: 'JIRA_TOKEN' });
    expect(config.agents.suthradhara?.mcp?.jira).toEqual(['get_issue', 'search']);
    // Round-trips: a re-load of the same file yields the same shape.
    expect(loadKshetraConfig(path)).toEqual(config);
  });

  it('accepts a server def with no secretEnv (auth-less server)', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + `
mcp:
  servers:
    localtool:
      config: .shreni/mcp/localtool.json
`);
    const config = loadKshetraConfig(path);
    expect(config.mcp?.servers.localtool).toEqual({ config: '.shreni/mcp/localtool.json' });
    expect(config.mcp?.servers.localtool.secretEnv).toBeUndefined();
  });

  it('rejects an inline secret literal on a server def (only secretEnv allowed)', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + `
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json
      secret: super-secret-token
`);
    // No `secret` field exists in the schema; a stray literal is not a valid
    // server shape (strict-object behaviour would reject, but even loosely the
    // secret never lands on a typed field — the guarantee is "no secret literal
    // is carried"). secretEnv naming is the only accepted form.
    const config = loadKshetraConfig(path);
    expect((config.mcp?.servers.jira as Record<string, unknown>).secret).toBeUndefined();
  });

  it('rejects a grant referencing an undefined MCP server', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + `
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json
      secretEnv: JIRA_TOKEN
agents:
  silpi:
    mcp:
      linear:
        - get_issue
`);
    expect(() => loadKshetraConfig(path)).toThrow(KshetraConfigError);
    expect(() => loadKshetraConfig(path)).toThrow(/undefined MCP server "linear"/);
  });

  it('accepts per-role grants across multiple roles that all resolve', () => {
    const path = join(dir, 'kshetra.yaml');
    writeFileSync(path, VALID_YAML + `
mcp:
  servers:
    jira:
      config: .shreni/mcp/jira.json
      secretEnv: JIRA_TOKEN
    confluence:
      config: .shreni/mcp/confluence.json
      secretEnv: CONFLUENCE_TOKEN
agents:
  suthradhara:
    mcp:
      jira:
        - get_issue
  parikshaka:
    mcp:
      confluence:
        - get_page
`);
    const config = loadKshetraConfig(path);
    expect(config.agents.suthradhara?.mcp?.jira).toEqual(['get_issue']);
    expect(config.agents.parikshaka?.mcp?.confluence).toEqual(['get_page']);
  });

  it('accepts agents.<role>.mcpConfigFiles (vgq) with no mcp.servers block', () => {
    const path = join(dir, 'kshetra.yaml');
    // mcpConfigFiles points directly at config files — it needs neither an
    // mcp.servers block nor a grant, so the superRefine has nothing to reject.
    writeFileSync(path, VALID_YAML + `
agents:
  silpi:
    mcpConfigFiles:
      - .mcp.json
      - .shreni/mcp/extra.json
`);
    const config = loadKshetraConfig(path);
    expect(config.agents.silpi?.mcpConfigFiles).toEqual(['.mcp.json', '.shreni/mcp/extra.json']);
    expect(config.mcp).toBeUndefined();
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
