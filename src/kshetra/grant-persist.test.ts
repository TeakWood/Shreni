import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistMcpGrant } from './grant-persist';
import { loadKshetraConfig } from './config';
import { compileMcpGrants } from '../suthradhara/allowlist';

// A minimal valid kshetra.yaml. `mcp.servers.jira` is DEFINED so a grant to it
// passes the schema's superRefine; `secretEnv` names an env var (never a literal).
function baseConfig(extra = ''): string {
  return `id: myapp
name: My App
repo:
  path: /repos/myapp
  remote: git@example.com:me/myapp.git
beads:
  path: /repos/myapp/.beads
  remote: git@example.com:me/myapp-beads.git
stack:
  language: typescript
mcp:
  servers:
    jira:
      config: .mcp/jira.json
      secretEnv: JIRA_API_TOKEN
${extra}`;
}

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grant-persist-'));
  cfgPath = join(dir, 'kshetra.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('persistMcpGrant', () => {
  it('writes a grant a later load reads back — so the next session needs no prompt', () => {
    writeFileSync(cfgPath, baseConfig(), 'utf8');
    persistMcpGrant(cfgPath, 'suthradhara', 'jira', 'get_issue');

    const cfg = loadKshetraConfig(cfgPath);
    expect(cfg.agents.suthradhara?.mcp).toEqual({ jira: ['get_issue'] });
    // and the compiler admits it → the tool is granted from the start, no denial
    expect(compileMcpGrants(cfg.agents.suthradhara?.mcp)).toContain('mcp__jira__get_issue');
  });

  it('is idempotent and accumulates tools', () => {
    writeFileSync(cfgPath, baseConfig(), 'utf8');
    persistMcpGrant(cfgPath, 'suthradhara', 'jira', 'get_issue');
    persistMcpGrant(cfgPath, 'suthradhara', 'jira', 'get_issue'); // dup
    persistMcpGrant(cfgPath, 'suthradhara', 'jira', 'search_issues');

    expect(loadKshetraConfig(cfgPath).agents.suthradhara?.mcp).toEqual({
      jira: ['get_issue', 'search_issues'],
    });
  });

  it('preserves other config (does not disturb an existing grant on another server)', () => {
    writeFileSync(
      cfgPath,
      baseConfig(`    linear:
      config: .mcp/linear.json
agents:
  suthradhara:
    mcp:
      linear:
        - list_issues
`),
      'utf8',
    );
    persistMcpGrant(cfgPath, 'suthradhara', 'jira', 'get_issue');

    const cfg = loadKshetraConfig(cfgPath);
    expect(cfg.agents.suthradhara?.mcp).toEqual({
      linear: ['list_issues'],
      jira: ['get_issue'],
    });
  });

  it('refuses a wildcard grant without touching the file', () => {
    writeFileSync(cfgPath, baseConfig(), 'utf8');
    expect(() => persistMcpGrant(cfgPath, 'suthradhara', 'jira', '*')).toThrow(/exact/i);
    // file unchanged → no grant landed
    expect(loadKshetraConfig(cfgPath).agents.suthradhara?.mcp).toBeUndefined();
  });

  it('refuses when the grant would reference an undefined server (schema would reject)', () => {
    writeFileSync(cfgPath, baseConfig(), 'utf8');
    expect(() => persistMcpGrant(cfgPath, 'suthradhara', 'confluence', 'read_page')).toThrow(/invalid|undefined/i);
    // file unchanged → still loads and has no grant
    expect(loadKshetraConfig(cfgPath).agents.suthradhara?.mcp).toBeUndefined();
  });
});
