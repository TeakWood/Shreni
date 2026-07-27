import { describe, it, expect } from 'vitest';
import { buildClaudeSpawn, buildFilingSpawn, allowlistForTurn } from './session';
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

  it('carries the caller-supplied prompts through unmodified', () => {
    const sysIdx = spec.args.indexOf('--append-system-prompt');
    expect(spec.args[sysIdx + 1]).toBe('You are Suthradhara.');
    expect(spec.args[spec.args.length - 1]).toBe('Hello');
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
