import { describe, it, expect, afterEach } from 'vitest';
import { buildClaudeSpawn, buildFilingSpawn, allowlistForTurn, SuthradharaSpawnError } from './session';
import { newSessionState } from './state';
import { presentProposal } from './confirm';
import type { Decomposition } from './decomposition';
import type { KshetraConfig } from '../kshetra/config';

const KSHETRA = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-opus-4-7', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

describe('buildClaudeSpawn', () => {
  const spec = buildClaudeSpawn({
    kshetra: KSHETRA,
    systemPrompt: 'You are Suthradhara.',
    userPrompt: 'Hello',
  });

  it('resolves claude via SHRENI_CLAUDE_BIN with a `claude` default', () => {
    expect(spec.bin).toBe('claude');
  });

  it('passes the kshetra model on --model', () => {
    const idx = spec.args.indexOf('--model');
    expect(spec.args[idx + 1]).toBe('claude-opus-4-7');
  });

  it('passes the composed allowlist on --allowedTools (comma-joined)', () => {
    const idx = spec.args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const list = spec.args[idx + 1];
    expect(list).toContain('Read');
    expect(list).toContain('Grep');
    expect(list).toContain('Bash(bd show:*)');
    expect(list).toContain('Bash(git log:*)');
  });

  it('never allows a file-write tool via --allowedTools', () => {
    const idx = spec.args.indexOf('--allowedTools');
    const list = spec.args[idx + 1] ?? '';
    expect(list).not.toContain('Write');
    expect(list).not.toContain('Edit');
    expect(list).not.toContain('NotebookEdit');
  });

  it('never allows a bd-write pattern via --allowedTools', () => {
    const idx = spec.args.indexOf('--allowedTools');
    const list = spec.args[idx + 1] ?? '';
    for (const p of ['bd create', 'bd update', 'bd close', 'bd remember']) {
      expect(list).not.toContain(p);
    }
  });

  it('uses --permission-mode default (unlisted tool needs approval; detached => denied)', () => {
    const idx = spec.args.indexOf('--permission-mode');
    expect(spec.args[idx + 1]).toBe('default');
  });

  it('carries the system prompt through unmodified', () => {
    const sysIdx = spec.args.indexOf('--append-system-prompt');
    expect(spec.args[sysIdx + 1]).toBe('You are Suthradhara.');
  });

  it('delivers the operator prompt on stdin, never as a trailing positional', () => {
    // --allowedTools is variadic and would swallow a trailing positional prompt
    // (verified on claude 2.1.212), so the message rides stdin instead.
    expect(spec.stdin).toBe('Hello');
    expect(spec.args).not.toContain('Hello');
    // The last arg is the allowlist value, with nothing positional after it.
    expect(spec.args[spec.args.length - 2]).toBe('--allowedTools');
  });
});

describe('buildClaudeSpawn — MCP grounding (pmb.4)', () => {
  const mcpKshetra = (): KshetraConfig => ({
    ...KSHETRA,
    mcp: {
      servers: {
        jira: { config: '.shreni/mcp/jira.json', secretEnv: 'JIRA_TOKEN' },
        localtool: { config: '.shreni/mcp/local.json' },
      },
    },
  }) as unknown as KshetraConfig;

  afterEach(() => {
    delete process.env.JIRA_TOKEN;
  });

  it('connects each defined server via --mcp-config with an absolute path', () => {
    process.env.JIRA_TOKEN = 'secret-abc';
    const spec = buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' });
    const cfgs = spec.args.reduce<string[]>((acc, a, i) => {
      if (spec.args[i - 1] === '--mcp-config') acc.push(a);
      return acc;
    }, []);
    expect(cfgs).toContain('/projects/myapp/.shreni/mcp/jira.json');
    expect(cfgs).toContain('/projects/myapp/.shreni/mcp/local.json');
  });

  it('never passes --strict-mcp-config (ambient project .mcp.json stays connected)', () => {
    process.env.JIRA_TOKEN = 'secret-abc';
    const spec = buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' });
    expect(spec.args).not.toContain('--strict-mcp-config');
  });

  it('does not grant any mcp__ tool on --allowedTools (visible-but-denied, pmb.5 grants)', () => {
    process.env.JIRA_TOKEN = 'secret-abc';
    const spec = buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' });
    const idx = spec.args.indexOf('--allowedTools');
    expect(spec.args[idx + 1]).not.toContain('mcp__');
  });

  it('injects secretEnv values into the child env, keyed by the named var', () => {
    process.env.JIRA_TOKEN = 'secret-abc';
    const spec = buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' });
    expect(spec.env?.JIRA_TOKEN).toBe('secret-abc');
  });

  it('fails loud (before spawn) when a secretEnv names an unset host var', () => {
    delete process.env.JIRA_TOKEN;
    expect(() => buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' }))
      .toThrowError(SuthradharaSpawnError);
    expect(() => buildClaudeSpawn({ kshetra: mcpKshetra(), systemPrompt: 's', userPrompt: 'u' }))
      .toThrowError(/JIRA_TOKEN/);
  });

  it('connects an auth-less server (no secretEnv) without injecting any secret', () => {
    const kshetra = {
      ...KSHETRA,
      mcp: { servers: { localtool: { config: '.shreni/mcp/local.json' } } },
    } as unknown as KshetraConfig;
    const spec = buildClaudeSpawn({ kshetra, systemPrompt: 's', userPrompt: 'u' });
    expect(spec.args).toContain('/projects/myapp/.shreni/mcp/local.json');
    expect(spec.env).toEqual({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
  });

  it('adds no --mcp-config when the Kshetra defines no servers', () => {
    const spec = buildClaudeSpawn({ kshetra: KSHETRA, systemPrompt: 's', userPrompt: 'u' });
    expect(spec.args).not.toContain('--mcp-config');
    expect(spec.env).toEqual({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
  });
});

function decomp(): Decomposition {
  return {
    epic: { ref: 'epic', title: 'X', type: 'epic', priority: 2 },
    children: [{ ref: 'c', title: 'Y', type: 'task', priority: 1, acceptanceCriteria: 'done' }],
    deps: [],
  };
}

describe('allowlistForTurn — server is authority', () => {
  it('is read-only for a fresh interview turn', () => {
    const list = allowlistForTurn(newSessionState('myapp-20260727T100000-abcd', 'myapp'));
    expect(list).toContain('Read');
    expect(list.some(t => t.includes('bd create'))).toBe(false);
    expect(list.some(t => t.includes('bd dep add'))).toBe(false);
  });

  it('stays read-only even while a proposal is pending confirmation', () => {
    // The write surface is NEVER reachable from persisted session state — even
    // at the confirm gate, the conversational turn cannot file. Filing is only
    // the post-confirm step's buildFilingSpawn.
    const held = presentProposal(newSessionState('myapp-20260727T100000-abcd', 'myapp'), decomp());
    if (!held.ok) throw new Error('setup');
    const list = allowlistForTurn(held.state);
    expect(list.some(t => t.includes('bd create'))).toBe(false);
    expect(list.some(t => t.includes('bd dep add'))).toBe(false);
  });
});

describe('buildFilingSpawn', () => {
  const spec = buildFilingSpawn({
    kshetra: KSHETRA,
    systemPrompt: 'You are Suthradhara, filing.',
    userPrompt: 'file it',
  });

  it('carries the filing write verbs on --allowedTools', () => {
    const idx = spec.args.indexOf('--allowedTools');
    const list = spec.args[idx + 1] ?? '';
    expect(list).toContain('Bash(bd create:*)');
    expect(list).toContain('Bash(bd dep add:*)');
  });

  it('still never carries bd close / bd update / claim on the filing turn', () => {
    const idx = spec.args.indexOf('--allowedTools');
    const list = spec.args[idx + 1] ?? '';
    for (const p of ['bd close', 'bd update', '--claim', 'bd remember']) {
      expect(list).not.toContain(p);
    }
  });
});
