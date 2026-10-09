import { describe, it, expect, vi } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';

// A Kshetra with no task graph project is still on beads: drain (and so
// `shreni run`) refuses it before building a runtime, naming shreni migrate.

const K = {
  id: 'old', name: 'old',
  repo: { path: '/p/old', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { provider: 'anthropic', model: 'm', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
} as unknown as KshetraConfig;

vi.mock('../kshetra/registry', () => ({ loadRegistry: () => [K] }));
vi.mock('./provider-preflight', () => ({ findRoleCredentialGaps: () => [] }));

const { runDrain } = await import('./drain');

describe('drain on a Kshetra with no project', () => {
  it('throws "run shreni migrate <id>" and never builds a driver', async () => {
    const makeDriver = vi.fn();
    await expect(runDrain('old', { intervalMs: 1 }, makeDriver)).rejects.toThrow('old: old has no task graph project: run shreni migrate old');
    expect(makeDriver).not.toHaveBeenCalled();
  });
});
