import { describe, it, expect, vi } from 'vitest';
import { commitBundle, type CommitDeps } from './commit';
import { newSessionBeadRecord, type SessionPlan, type SessionBeadRecord } from './sessionbead';
import type { Decomposition } from './decomposition';
import type { KshetraConfig } from '../kshetra/config';

const KSHETRA = {
  id: 'myapp',
  repo: { path: '/repos/myapp' },
  beads: { path: '/repos/myapp-beads' },
  agents: { model: 'claude-opus-4-8' },
} as unknown as KshetraConfig;

function decomp(): Decomposition {
  return {
    epic: { ref: 'e', title: 'CSV import', type: 'epic', priority: 2 },
    children: [
      { ref: 'c1', title: 'parser', type: 'task', priority: 2, acceptanceCriteria: 'parses CSV' },
      { ref: 'c2', title: 'ui', type: 'task', priority: 2, acceptanceCriteria: 'upload button' },
    ],
    deps: [{ blocked: 'c2', blocker: 'c1' }],
  };
}

// A fake session-bead store that records journal writes, plus a fake `bd` runner
// that mints predictable ids for creates and swallows dep adds.
function fakeDeps() {
  let record: SessionBeadRecord | null = null;
  const journals: SessionBeadRecord[] = [];
  const sessionBead: NonNullable<CommitDeps['sessionBead']> = {
    create(plan: SessionPlan) {
      record = newSessionBeadRecord(plan);
      return Promise.resolve({ id: 'myapp-sess', record });
    },
    journal(_id: string, r: SessionBeadRecord) {
      journals.push(r);
      return Promise.resolve();
    },
  };
  let n = 0;
  const calls: string[][] = [];
  const bd = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === 'create') return Promise.resolve(`myapp-${++n}`);
    return Promise.resolve('');
  });
  return { deps: { bd, sessionBead } as CommitDeps, journals, calls, bd };
}

describe('commitBundle', () => {
  it('files epic → children → deps in order and reports every landed id', async () => {
    const { deps, calls } = fakeDeps();
    const report = await commitBundle({ kshetra: KSHETRA, decomposition: decomp() }, deps);

    expect(report.ok).toBe(true);
    expect(report.sessionBeadId).toBe('myapp-sess');
    expect(report.epicId).toBe('myapp-1');
    expect(report.childIds).toEqual({ c1: 'myapp-2', c2: 'myapp-3' });
    expect(report.depsAdded).toEqual(['c2<-c1']);

    // Order: three creates then the dep add; children carry --parent <epic id>.
    expect(calls[0][0]).toBe('create');
    const depCall = calls.find(c => c[0] === 'dep');
    expect(depCall).toEqual(['dep', 'add', 'myapp-3', 'myapp-2']); // blocked c2, blocker c1
    const childCall = calls[1];
    expect(childCall).toContain('--parent');
    expect(childCall[childCall.indexOf('--parent') + 1]).toBe('myapp-1');
  });

  it('reports a partial failure with what already landed and stops', async () => {
    const { deps } = fakeDeps();
    // Make the SECOND create (first child) fail.
    let creates = 0;
    (deps.bd as ReturnType<typeof vi.fn>).mockImplementation((args: string[]) => {
      if (args[0] === 'create') {
        creates++;
        if (creates === 2) return Promise.reject(new Error('bd down'));
        return Promise.resolve(`myapp-${creates}`);
      }
      return Promise.resolve('');
    });

    const report = await commitBundle({ kshetra: KSHETRA, decomposition: decomp() }, deps);
    expect(report.ok).toBe(false);
    expect(report.epicId).toBe('myapp-1');       // epic landed
    expect(report.childIds).toEqual({});          // stopped before any child
    expect(report.errors.join(' ')).toMatch(/bd down/);
  });
});
