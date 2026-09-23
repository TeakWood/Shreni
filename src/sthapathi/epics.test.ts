import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config.js';

// Shreni-beads-q08: epic auto-close. A fake in-memory bead graph stands in for bd
// so every rule (>= 1 child, all closed, epic type, live status, awaiting-merge
// left to reconcile, cascade up an epic-of-epics, idempotent sweep) is asserted
// against real parsing of bd's JSON shapes.

interface FakeBead { id: string; status: string; issue_type: string; parent?: string; labels?: string[] }
const graph = new Map<string, FakeBead>();
const calls: string[] = [];

const mockShow = vi.fn(async (id: string) => {
  calls.push(`show:${id}`);
  const b = graph.get(id);
  if (!b) throw new Error(`bd show failed: no issue ${id}`);
  // bd 1.0.3 shape: [bead] with a top-level `parent` field.
  return JSON.stringify([{ ...b, title: b.id, priority: 2 }]);
});
const mockChildren = vi.fn(async (id: string) => {
  calls.push(`children:${id}`);
  return JSON.stringify([...graph.values()].filter(b => b.parent === id).map(b => ({ ...b, title: b.id, priority: 2 })));
});
const mockClose = vi.fn(async (id: string, _reason: string) => {
  calls.push(`close:${id}`);
  const b = graph.get(id)!;
  b.status = 'closed';
  return '';
});
const mockList = vi.fn(async (f: { status?: string; type?: string; all?: boolean }) => {
  calls.push('list');
  const statuses = (f.status ?? '').split(',');
  return JSON.stringify(
    [...graph.values()]
      .filter(b => (!f.type || b.issue_type === f.type) && statuses.includes(b.status))
      .map(b => ({ ...b, title: b.id, priority: 2 })),
  );
});

vi.mock('./beads.js', () => ({
  bd: vi.fn(() => ({ show: mockShow, children: mockChildren, close: mockClose, list: mockList })),
}));

const mockEmit = vi.fn();
vi.mock('./activity-log.js', () => ({ emit: mockEmit }));

const { closeParentEpicIfComplete, sweepCompleteEpics, hasOpenChildren, parentsWithOpenChildren } = await import('./epics.js');

const KSHETRA = { id: 'myapp', beads: { path: '/pb' } } as unknown as KshetraConfig;

function add(b: FakeBead): void { graph.set(b.id, { labels: [], ...b }); }

beforeEach(() => {
  graph.clear();
  calls.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('closeParentEpicIfComplete', () => {
  it('closes the epic when its last child closes, with the reason and an epic_closed ledger event', async () => {
    add({ id: 'ep', status: 'open', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    add({ id: 'ep.2', status: 'closed', issue_type: 'feature', parent: 'ep' });

    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.2')).toEqual(['ep']);
    expect(mockClose).toHaveBeenCalledWith('ep', 'all 2 children closed: ep.1, ep.2');
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'epic_closed', kshetra: 'myapp', beadId: 'ep', epicId: 'ep', children: ['ep.1', 'ep.2'],
    });
  });

  it('leaves the epic open while any child is still open', async () => {
    add({ id: 'ep', status: 'open', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    add({ id: 'ep.2', status: 'in_progress', issue_type: 'task', parent: 'ep' });

    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.1')).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does nothing for a bead with no parent', async () => {
    add({ id: 'solo', status: 'closed', issue_type: 'task' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'solo')).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('never closes a non-epic parent (a mis-typed parent is left for a human)', async () => {
    add({ id: 'feat', status: 'open', issue_type: 'feature' });
    add({ id: 'feat.1', status: 'closed', issue_type: 'task', parent: 'feat' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'feat.1')).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('leaves an awaiting-merge epic to PR reconcile, and a deferred epic to its human', async () => {
    add({ id: 'ep', status: 'in_progress', issue_type: 'epic', labels: ['awaiting-merge'] });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    add({ id: 'ep2', status: 'deferred', issue_type: 'epic' });
    add({ id: 'ep2.1', status: 'closed', issue_type: 'task', parent: 'ep2' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.1')).toEqual([]);
    expect(await closeParentEpicIfComplete(KSHETRA, 'ep2.1')).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('closes a BLOCKED epic (how the pre-q08 close refusal left one) once its children are done', async () => {
    add({ id: 'ep', status: 'blocked', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.1')).toEqual(['ep']);
  });

  it('closes an in_progress epic (one a pre-q08 worker wrongly claimed)', async () => {
    add({ id: 'ep', status: 'in_progress', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.1')).toEqual(['ep']);
  });

  it('cascades up an epic of epics when the last leaf closes', async () => {
    add({ id: 'top', status: 'open', issue_type: 'epic' });
    add({ id: 'mid', status: 'open', issue_type: 'epic', parent: 'top' });
    add({ id: 'mid.1', status: 'closed', issue_type: 'task', parent: 'mid' });
    add({ id: 'top.2', status: 'closed', issue_type: 'task', parent: 'top' });
    expect(await closeParentEpicIfComplete(KSHETRA, 'mid.1')).toEqual(['mid', 'top']);
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('never throws: a bd failure is logged and swallowed (the child merge already landed)', async () => {
    mockShow.mockRejectedValueOnce(new Error('bd show failed: db locked'));
    await expect(closeParentEpicIfComplete(KSHETRA, 'x')).resolves.toEqual([]);

    add({ id: 'ep', status: 'open', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    mockClose.mockRejectedValueOnce(new Error('bd close failed: cannot close epic ep: 1 open child issue(s)'));
    await expect(closeParentEpicIfComplete(KSHETRA, 'ep.1')).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('reads the parent from a parent-child dependency when bd omits the top-level field', async () => {
    add({ id: 'ep', status: 'open', issue_type: 'epic' });
    add({ id: 'ep.1', status: 'closed', issue_type: 'task', parent: 'ep' });
    mockShow.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'ep.1', status: 'closed', issue_type: 'task', dependencies: [{ id: 'ep', dependency_type: 'parent-child' }] }]),
    );
    expect(await closeParentEpicIfComplete(KSHETRA, 'ep.1')).toEqual(['ep']);
  });
});

describe('sweepCompleteEpics', () => {
  it('closes an already-complete epic exactly once and is idempotent', async () => {
    add({ id: 'done', status: 'open', issue_type: 'epic' });
    add({ id: 'done.1', status: 'closed', issue_type: 'task', parent: 'done' });
    add({ id: 'done.2', status: 'closed', issue_type: 'bug', parent: 'done' });

    expect(await sweepCompleteEpics(KSHETRA)).toEqual(['done']);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith('done', 'all 2 children closed: done.1, done.2');
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Second sweep: nothing left to close, no duplicate close or ledger event.
    expect(await sweepCompleteEpics(KSHETRA)).toEqual([]);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('never auto-closes a zero-child epic (a plan still being filed)', async () => {
    add({ id: 'fresh', status: 'open', issue_type: 'epic' });
    expect(await sweepCompleteEpics(KSHETRA)).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('leaves an epic with an open child open', async () => {
    add({ id: 'wip', status: 'open', issue_type: 'epic' });
    add({ id: 'wip.1', status: 'closed', issue_type: 'task', parent: 'wip' });
    add({ id: 'wip.2', status: 'open', issue_type: 'task', parent: 'wip' });
    expect(await sweepCompleteEpics(KSHETRA)).toEqual([]);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('lists live epics with the row cap lifted', async () => {
    await sweepCompleteEpics(KSHETRA);
    expect(mockList).toHaveBeenCalledWith({ status: 'open,in_progress,blocked', type: 'epic', all: true });
  });

  it('a scoped sweep closes only epics inside the scope (drain --epic trial isolation)', async () => {
    add({ id: 'mine', status: 'open', issue_type: 'epic' });
    add({ id: 'mine.1', status: 'closed', issue_type: 'task', parent: 'mine' });
    add({ id: 'other', status: 'open', issue_type: 'epic' });
    add({ id: 'other.1', status: 'closed', issue_type: 'task', parent: 'other' });
    expect(await sweepCompleteEpics(KSHETRA, id => id.startsWith('mine'))).toEqual(['mine']);
    expect(graph.get('other')!.status).toBe('open');
  });

  it('closes a nested epic and then its now-complete parent in the same sweep', async () => {
    add({ id: 'top', status: 'open', issue_type: 'epic' });
    add({ id: 'mid', status: 'open', issue_type: 'epic', parent: 'top' });
    add({ id: 'mid.1', status: 'closed', issue_type: 'task', parent: 'mid' });
    // `top` is listed before `mid`, so only the second pass can close it.
    const closed = await sweepCompleteEpics(KSHETRA);
    expect(closed.sort()).toEqual(['mid', 'top']);
  });

  it('never throws when bd list fails', async () => {
    mockList.mockRejectedValueOnce(new Error('bd list failed'));
    await expect(sweepCompleteEpics(KSHETRA)).resolves.toEqual([]);
  });
});

describe('hasOpenChildren', () => {
  it('is true only when some child is not closed', async () => {
    add({ id: 'p', status: 'open', issue_type: 'feature' });
    add({ id: 'p.1', status: 'closed', issue_type: 'task', parent: 'p' });
    expect(await hasOpenChildren(KSHETRA, 'p')).toBe(false);
    add({ id: 'p.2', status: 'blocked', issue_type: 'task', parent: 'p' });
    expect(await hasOpenChildren(KSHETRA, 'p')).toBe(true);
    add({ id: 'leaf', status: 'open', issue_type: 'feature' });
    expect(await hasOpenChildren(KSHETRA, 'leaf')).toBe(false);
  });
});

describe('parentsWithOpenChildren', () => {
  it('collects the parent of every non-closed bead from one list call', async () => {
    add({ id: 'p', status: 'open', issue_type: 'feature' });
    add({ id: 'p.1', status: 'open', issue_type: 'task', parent: 'p' });
    add({ id: 'q', status: 'open', issue_type: 'feature' });
    add({ id: 'q.1', status: 'closed', issue_type: 'task', parent: 'q' });
    expect([...(await parentsWithOpenChildren(KSHETRA))]).toEqual(['p']);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith({ status: 'open,in_progress,blocked,deferred', all: true });
  });
});
