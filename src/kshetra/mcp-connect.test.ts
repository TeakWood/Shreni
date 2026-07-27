import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { resolveMcpConnection, resolveExecutorMcp, McpConnectionError } from './mcp-connect.js';
import type { KshetraConfig } from './config.js';

// A minimal config just rich enough for the connection resolver — only repo.path,
// mcp.servers, and agents.<role>.mcp are read.
function makeKshetra(over: Partial<KshetraConfig> = {}): KshetraConfig {
  return {
    id: 'app',
    name: 'App',
    repo: { path: '/repo', remote: 'git@x', mainBranch: 'main', branchPattern: 'b' },
    beads: { path: '.beads', remote: 'git@x', mode: 'embedded' },
    stack: { language: 'ts' },
    conventions: {},
    agents: { provider: 'anthropic', model: 'claude', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    gates: {} as KshetraConfig['gates'],
    mcp: {
      servers: {
        jira: { config: '.shreni/mcp/jira.json', secretEnv: 'JIRA_TOKEN' },
        localdocs: { config: '.shreni/mcp/localdocs.json' },
      },
    },
    ...over,
  } as KshetraConfig;
}

describe('resolveMcpConnection', () => {
  const saved = process.env.JIRA_TOKEN;
  beforeEach(() => {
    process.env.JIRA_TOKEN = 'secret-value';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = saved;
  });

  it('resolves config paths absolute against repo.path and injects the named secret', () => {
    const conn = resolveMcpConnection(makeKshetra(), ['jira']);
    expect(conn.configPaths).toEqual([resolve('/repo', '.shreni/mcp/jira.json')]);
    expect(conn.secretEnv).toEqual({ JIRA_TOKEN: 'secret-value' });
  });

  it('omits secretEnv for a server that declares none', () => {
    const conn = resolveMcpConnection(makeKshetra(), ['localdocs']);
    expect(conn.configPaths).toEqual([resolve('/repo', '.shreni/mcp/localdocs.json')]);
    expect(conn.secretEnv).toEqual({});
  });

  it('resolves multiple servers in order', () => {
    const conn = resolveMcpConnection(makeKshetra(), ['jira', 'localdocs']);
    expect(conn.configPaths).toEqual([
      resolve('/repo', '.shreni/mcp/jira.json'),
      resolve('/repo', '.shreni/mcp/localdocs.json'),
    ]);
  });

  it('throws McpConnectionError for an unknown server name', () => {
    expect(() => resolveMcpConnection(makeKshetra(), ['ghost'])).toThrowError(McpConnectionError);
  });

  it('fails loud when a required secretEnv is unset', () => {
    delete process.env.JIRA_TOKEN;
    expect(() => resolveMcpConnection(makeKshetra(), ['jira'])).toThrowError(/JIRA_TOKEN.*unset/);
  });
});

describe('resolveExecutorMcp', () => {
  beforeEach(() => {
    process.env.JIRA_TOKEN = 'secret-value';
  });
  afterEach(() => {
    delete process.env.JIRA_TOKEN;
  });

  it('returns undefined when the executor role has no grant (off by default)', () => {
    expect(resolveExecutorMcp(makeKshetra(), 'silpi')).toBeUndefined();
  });

  it('connects exactly the servers the role grants — the tool list does not narrow it', () => {
    const k = makeKshetra({
      agents: {
        provider: 'anthropic',
        model: 'claude',
        maxRoundsPerBead: 3,
        // a lone read tool is listed, but under bypass the whole jira server connects
        silpi: { mcp: { jira: ['get_issue'] } },
      } as KshetraConfig['agents'],
    });
    const conn = resolveExecutorMcp(k, 'silpi');
    expect(conn?.configPaths).toEqual([resolve('/repo', '.shreni/mcp/jira.json')]);
    expect(conn?.secretEnv).toEqual({ JIRA_TOKEN: 'secret-value' });
  });

  it('derives the connection purely from the role that runs (no cross-role bleed)', () => {
    const k = makeKshetra({
      agents: {
        provider: 'anthropic',
        model: 'claude',
        maxRoundsPerBead: 3,
        silpi: { mcp: { jira: ['get_issue'] } },
      } as KshetraConfig['agents'],
    });
    // viharapala/parikshaka got no grant → no MCP, even though silpi did.
    expect(resolveExecutorMcp(k, 'viharapala')).toBeUndefined();
    expect(resolveExecutorMcp(k, 'parikshaka')).toBeUndefined();
  });
});
