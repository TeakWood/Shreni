import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config';

// End-to-end (Shreni-beads-q08): the epic sweep runs at worker/drain STARTUP and
// again at drain EXIT, through the real worker runtime and the real ledger sink.
// An epic already complete when the drain starts (all children closed before q08,
// or a crash between a child's close and its epic's) is closed EXACTLY ONCE — by
// the startup sweep — and the exit sweep is a no-op (idempotent). A zero-child
// epic and an epic with an open child are never closed. Only bd/git/agent leaves
// are stubbed; bd is an in-memory graph.

const K: KshetraConfig = {
  id: 'e2e-epics', name: 'e2e-epics',
  repo: { path: '/p/e2e-epics', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: mkdtempSync(join(tmpdir(), 'shreni-e2e-epics-')), remote: '', mode: 'embedded' },
  stack: { language: 'typescript' }, conventions: {},
  agents: { model: 'm', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

interface Row { id: string; title: string; priority: number; status: string; issue_type: string; parent?: string }
const graph: Row[] = [
  { id: 'done', title: 'done', priority: 1, status: 'open', issue_type: 'epic' },
  { id: 'done.1', title: 'c1', priority: 1, status: 'closed', issue_type: 'task', parent: 'done' },
  { id: 'done.2', title: 'c2', priority: 1, status: 'closed', issue_type: 'bug', parent: 'done' },
  { id: 'fresh', title: 'fresh', priority: 1, status: 'open', issue_type: 'epic' },
  { id: 'wip', title: 'wip', priority: 1, status: 'open', issue_type: 'epic' },
  { id: 'wip.1', title: 'w1', priority: 1, status: 'blocked', issue_type: 'task', parent: 'wip' },
];
const closes: Array<[string, string]> = [];

vi.mock('../kshetra/registry', () => ({ loadRegistry: () => [K] }));
vi.mock('./provider-preflight', () => ({ findRoleCredentialGaps: () => [] }));
vi.mock('../ext/loader', () => ({ loadExtension: async () => false, DEFAULT_EXT_MODULE: 'shreni-ext' }));
vi.mock('../sthapathi/lot-manifest', () => ({ collectLotManifest: async () => ({ subject: {}, process: {} }) }));
vi.mock('../sthapathi/recover', () => ({ recoverKshetra: async () => [], scheduleResume: async () => {} }));
vi.mock('../sthapathi/repo-map-migration', () => ({ untrackCommittedRepoMap: async () => false }));
vi.mock('../sthapathi/watchdog', () => ({ runWatchdogOnce: async () => {} }));
vi.mock('../sthapathi/merge', () => ({ reconcilePullRequests: async () => {} }));
vi.mock('../sthapathi/pr-followup', () => ({ selectFollowup: async () => null }));
vi.mock('../sthapathi/beads', () => ({
  syncBeads: async () => {},
  bd: () => ({
    // Nothing is ready: the drain goes straight to its exit sequence.
    ready: async () => '[]',
    show: async (id: string) => JSON.stringify(graph.filter(r => r.id === id)),
    children: async (id: string) => JSON.stringify(graph.filter(r => r.parent === id)),
    close: async (id: string, reason: string) => {
      closes.push([id, reason]);
      graph.find(r => r.id === id)!.status = 'closed';
      return '';
    },
    list: async (f: { status?: string; type?: string }) => {
      const statuses = (f.status ?? '').split(',');
      return JSON.stringify(graph.filter(r => (!f.type || r.issue_type === f.type) && statuses.includes(r.status)));
    },
  }),
}));

const { runDrain } = await import('./drain');
const { parseLedgerLines } = await import('../ext/ledger');

let result: Awaited<ReturnType<typeof runDrain>>;
beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  result = await runDrain(K.id, { intervalMs: 1 }, undefined, async () => {});
});

describe('epic sweep at drain startup and exit (q08, end-to-end)', () => {
  it('closes the already-complete epic exactly once, naming its children', () => {
    expect(closes).toEqual([['done', 'all 2 children closed: done.1, done.2']]);
  });

  it('never closes a zero-child epic or one with an open child', () => {
    expect(graph.find(r => r.id === 'fresh')!.status).toBe('open');
    expect(graph.find(r => r.id === 'wip')!.status).toBe('open');
  });

  it('records one epic_closed ledger entry, before drain_finished', () => {
    const entries = parseLedgerLines(readFileSync(join(K.beads.path, 'ledger.jsonl'), 'utf8'));
    const epicClosed = entries.filter(e => e.kind === 'epic_closed');
    expect(epicClosed).toHaveLength(1);
    expect(epicClosed[0]).toMatchObject({ beadId: 'done', payload: { epicId: 'done', children: ['done.1', 'done.2'] } });
    const kinds = entries.map(e => e.kind);
    expect(kinds.indexOf('epic_closed')).toBeLessThan(kinds.indexOf('drain_finished'));
  });

  it('epics never count as open/stalled work in the drain outcome', () => {
    // wip.1 (blocked) is the only open non-epic bead.
    expect(result.openInScope).toEqual(['wip.1']);
    expect(result.reason).toBe('stalled');
  });
});
