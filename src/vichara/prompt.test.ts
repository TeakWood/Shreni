import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadState = vi.fn();
vi.mock('../kshetra/state.js', () => ({ loadState: mockLoadState }));

const { buildVicharaSystemPrompt } = await import('./prompt');
import type { KshetraConfig } from '../kshetra/config';

const makeKshetra = (id: string): KshetraConfig =>
  ({
    id,
    name: `${id} Project`,
    repo: { path: `/repos/${id}`, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: '/beads/' + id, remote: '', mode: 'embedded' },
    stack: { language: 'typescript', framework: 'express' },
    conventions: {},
    agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  }) as unknown as KshetraConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadState.mockReturnValue({
    kshetras: {
      'app-a': { paused: false },
      'app-b': { paused: true, reason: 'cooldown' },
    },
  });
});

describe('buildVicharaSystemPrompt', () => {
  const kshetras = [makeKshetra('app-a'), makeKshetra('app-b')];

  it('includes current time', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: [], currentTime: '2026-06-09T10:00:00Z' });
    expect(result).toContain('2026-06-09T10:00:00Z');
  });

  it('lists all registered kshetras', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: kshetras, currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('app-a');
    expect(result).toContain('app-b');
  });

  it('marks paused kshetras with reason', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: kshetras, currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('paused (cooldown)');
  });

  it('marks active kshetras as active', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: kshetras, currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toMatch(/app-a.*active/);
  });

  it('shows ACTIVE PROJECT section when activeKshetra is set', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: kshetras[0]!, allKshetras: kshetras, currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('== ACTIVE PROJECT ==');
    expect(result).toContain('typescript / express');
  });

  it('omits ACTIVE PROJECT section when activeKshetra is null', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: kshetras, currentTime: '2026-06-09T00:00:00Z' });
    expect(result).not.toContain('== ACTIVE PROJECT ==');
  });

  it('shows (none registered) when no kshetras', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: [], currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('(none registered)');
  });

  it('includes role boundary section', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: [], currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('== ROLE BOUNDARY ==');
    expect(result).toContain('READ-ONLY');
  });

  it('mentions available tools', () => {
    const result = buildVicharaSystemPrompt({ activeKshetra: null, allKshetras: [], currentTime: '2026-06-09T00:00:00Z' });
    expect(result).toContain('get_bead');
    expect(result).toContain('read_file');
  });
});