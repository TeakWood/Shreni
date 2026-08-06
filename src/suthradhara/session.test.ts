import { describe, it, expect } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import { buildPlanningSession, defaultKickoff } from './session';

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:me/myapp.git', mainBranch: 'main' },
  beads: { path: '/projects/myapp-beads/.beads', remote: 'git@github.com:me/myapp-beads.git' },
  agents: { model: 'claude-opus-4-8' },
  mcp: { servers: {} },
} as unknown as KshetraConfig;

const SID = '11111111-2222-3333-4444-555555555555';

// Pull the value that follows a flag in an argv array.
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildPlanningSession — fresh launch', () => {
  const spec = buildPlanningSession({ kshetra: KSHETRA, claudeSessionId: SID, kickoff: 'go' });

  it('is an INTERACTIVE invocation (no -p / stream-json)', () => {
    expect(spec.args).not.toContain('-p');
    expect(spec.args).not.toContain('--output-format');
    expect(spec.args).not.toContain('--no-session-persistence');
  });

  it('pins the session id and appends the planning system prompt', () => {
    expect(valueAfter(spec.args, '--session-id')).toBe(SID);
    expect(spec.args).not.toContain('--resume');
    const sys = valueAfter(spec.args, '--append-system-prompt');
    expect(sys).toContain('GATE ①');
  });

  it('carries the model, project settings, and the kickoff positional', () => {
    expect(valueAfter(spec.args, '--model')).toBe('claude-opus-4-8');
    expect(valueAfter(spec.args, '--setting-sources')).toBe('project');
    expect(spec.args[spec.args.length - 1]).toBe('go');
  });

  it('resolves the claude bin and sets BEADS_DIR (no --allowedTools whitelist)', () => {
    expect(spec.bin).toBe('claude');
    expect(spec.env?.BEADS_DIR).toBe('/projects/myapp-beads/.beads');
    expect(spec.args).not.toContain('--allowedTools');
  });
});

describe('buildPlanningSession — resume', () => {
  const spec = buildPlanningSession({ kshetra: KSHETRA, claudeSessionId: SID, resume: true });

  it('reattaches via --resume and omits the system prompt + kickoff', () => {
    expect(valueAfter(spec.args, '--resume')).toBe(SID);
    expect(spec.args).not.toContain('--session-id');
    expect(spec.args).not.toContain('--append-system-prompt');
  });
});

describe('defaultKickoff', () => {
  it('nudges into discovery for a fresh topic and into the doc for an extension', () => {
    expect(defaultKickoff(false).toLowerCase()).toContain('discovery');
    expect(defaultKickoff(true).toLowerCase()).toContain('extend');
  });
});
