import { describe, it, expect, onTestFinished } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, PGLITE_TIMEOUT } from '../../taskgraph/test/pglite';
import { openShreni } from '../db/client';
import { importShreniProject } from '../db/bundle';
import { taskLifecycle } from '../lifecycle/lifecycle';
import { engineReads } from '../sthapathi/reads';
import {
  bdReady, beadsHandOut, beadsIdPrefix, beadsToBundle, dryRun, findCycles, parseBeadsExport, renderDryRun, stateOf,
  type BeadIssue, type BeadsExport,
} from './beads-import';

// The beads importer and its dry run (migration plan, "The importer" and
// "Migration test"). The fixture is a beads export of a real project just
// before three tasks under a parked epic were deferred themselves, with every
// free-text field replaced by a placeholder; bd-ready.json is what `bd ready`
// listed for it, loaded into a scratch beads database.

const FIXTURES = join(__dirname, 'fixtures');
const fixture = () => parseBeadsExport(readFileSync(join(FIXTURES, 'shreni-beads.jsonl'), 'utf8'));
const recordedBdReady = (): string[] => JSON.parse(readFileSync(join(FIXTURES, 'bd-ready.json'), 'utf8'));
/** The morning the snapshot was taken. */
const NOW = new Date('2026-10-09T06:00:00Z');
const OPTS = { name: 'shreni', mode: 'tracker' as const, lifecycle: taskLifecycle, now: NOW };
const HELD = ['Shreni-beads-2sg.1', 'Shreni-beads-2sg.4', 'Shreni-beads-2sg.5'];

describe('the dry run on the fixture', () => {
  it('given the fixture, when the dry run runs, then counts match by state, kind and edge type, and the ready set equals the recorded bd ready ids apart from 2sg.1, 2sg.4 and 2sg.5, which it lists as held by the parked epic 2sg', () => {
    const src = fixture();
    const r = dryRun(src, OPTS);
    expect(r.mismatches).toEqual([]);
    expect(r.cycles).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts.engine).toMatchObject({ tasks: 457, byState: { done: 370, open: 64, parked: 23 }, parents: 310, deps: 275, links: 10, memories: 33 });
    expect(r.counts.engine.containers).toBeGreaterThanOrEqual(58);

    // beads' own list is what bd printed; a worker took from it everything but epics and parents.
    expect(bdReady(src.issues, NOW)).toEqual(recordedBdReady());
    const handOut = beadsHandOut(src.issues, NOW);
    const epics = new Set(src.issues.filter(i => i.issue_type === 'epic').map(i => i.id));
    expect(handOut).toEqual(recordedBdReady().filter(id => !epics.has(id)));

    expect(r.ready.heldByParkedEpic).toEqual(HELD.map(id => ({ id, epic: 'Shreni-beads-2sg' })));
    expect(r.ready.onlyBeads).toEqual([]);
    expect(r.ready.onlyEngine).toEqual([]);
    expect(r.ready.engine).toEqual([...handOut.filter(id => !HELD.includes(id)), ...r.ready.reopened].sort());
    expect(renderDryRun(r)).toEqual(expect.arrayContaining([
      '  held by parked epic Shreni-beads-2sg: Shreni-beads-2sg.1', '✓ the dry run checks pass',
    ]));
  });

  it('given the fixture\'s files, then no title, description, note or memory text from the beads repo appears in them', () => {
    const lines = readFileSync(join(FIXTURES, 'shreni-beads.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    const placeholders: Record<string, string> = {
      title: 'Title', description: 'Description', design: 'Design notes', acceptance_criteria: 'Acceptance criteria', notes: 'Notes', close_reason: 'Close reason',
    };
    let memories = 0;
    for (const l of lines) {
      if (l._type === 'memory') {
        memories++;
        expect(l).toEqual({ _type: 'memory', key: `memory-${String(memories).padStart(2, '0')}`, value: `Memory ${String(memories).padStart(2, '0')}.` });
        continue;
      }
      for (const [field, label] of Object.entries(placeholders)) {
        if (l[field]) expect(l[field]).toBe(`${label} of ${String(l.id)}.`);
      }
      // People stand in by role too.
      for (const field of ['owner', 'created_by', 'assignee']) if (l[field]) expect(['Developer', 'dev@example.com']).toContain(l[field]);
      for (const d of (l.dependencies ?? []) as { created_by?: string }[]) expect(d.created_by ?? 'Developer').toBe('Developer');
      expect(l.comment_count ?? 0).toBe(0);
    }
    expect(memories).toBe(33);
    // The recorded ready ids are ids only.
    expect(recordedBdReady().every(id => /^Shreni-beads-[a-z0-9]+(\.\d+)*$/.test(id))).toBe(true);
  });
});

describe('the import on the engine', { timeout: PGLITE_TIMEOUT }, () => {
  it('loads the fixture in one transaction, and the engine\'s ready set is the dry run\'s', async () => {
    const t = await createTestDb();
    const shreni = await openShreni({ db: t.db, lifecycle: taskLifecycle });
    onTestFinished(async () => { await shreni.close(); await t.close(); });
    await shreni.migrate();
    const now = new Date();
    const r = dryRun(fixture(), { ...OPTS, now });
    const report = await importShreniProject(shreni, r.mapped.bundle, { actor: { id: 'beads-importer', role: 'system' } });
    const id = report.project.id;
    expect(report.project).toMatchObject({ name: 'shreni', idPrefix: 'Shreni-beads' });
    const tg = shreni.tg.project(id);
    expect((await tg.ready({ limit: 1000 })).map(x => x.id).sort()).toEqual(r.ready.engine);

    // Bead ids, Shreni's rows, notes and close reasons as the worker reads them.
    const reads = engineReads(shreni, tg);
    const [closedTask] = JSON.parse(await reads.show('Shreni-beads-l3z')) as Record<string, unknown>[];
    expect(closedTask).toMatchObject({
      status: 'closed', close_reason: 'Close reason of Shreni-beads-l3z.',
      acceptance_criteria: 'Acceptance criteria of Shreni-beads-l3z.', design: 'Design notes of Shreni-beads-l3z.',
    });
    expect(await shreni.db.selectFrom('shreni.memories').select('key').where('project_id', '=', id).execute()).toHaveLength(33);
    expect(await shreni.db.selectFrom('shreni.projects').select('mode').where('project_id', '=', id).execute()).toEqual([{ mode: 'tracker' }]);
    // A new task continues the beads' ids.
    const fresh = await tg.as({ id: 'ann', role: 'developer' }).tasks.create({ title: 'after the move' });
    expect(fresh.id).toMatch(/^Shreni-beads-[a-z0-9]{3,4}$/);
  });
});

describe('the mapping', () => {
  const bead = (over: Partial<BeadIssue> & { id: string }): BeadIssue => ({
    title: over.id, status: 'open', priority: 2, issue_type: 'task',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...over,
  });
  const src = (issues: BeadIssue[], extra: Partial<BeadsExport> = {}): BeadsExport => ({ issues, memories: [], interactions: [], ...extra });

  it('puts each bead in its lifecycle state, and labels that are states become states', () => {
    expect(stateOf(bead({ id: 'p-a', status: 'in_progress', labels: ['awaiting-merge'] }))).toBe('waiting');
    expect(stateOf(bead({ id: 'p-b', status: 'in_progress' }))).toBe('open');
    expect(stateOf(bead({ id: 'p-c', status: 'deferred' }))).toBe('parked');
    expect(stateOf(bead({ id: 'p-d', status: 'blocked' }))).toBe('blocked');
    expect(stateOf(bead({ id: 'p-e', issue_type: 'suthradhara-session' }))).toBe('cancelled');
    expect(() => stateOf(bead({ id: 'p-f', status: 'pinned' }))).toThrow(/status "pinned", which the importer doesn't know/);

    const { bundle } = beadsToBundle(src([
      bead({ id: 'p-a', status: 'in_progress', labels: ['awaiting-merge', 'study'] }),
      bead({ id: 'p-b', labels: ['pr-needs-followup'], acceptance_criteria: 'it works', design: 'like so', defer_until: '2026-02-01T00:00:00Z' }),
    ]), OPTS);
    const [a, b] = bundle.engine.tasks;
    expect(a).toMatchObject({ state: 'waiting', tags: ['study'], boosted: false, origin: 'imported', category: 'task' });
    expect(b).toMatchObject({ state: 'open', tags: [], boosted: true, spec: { acceptanceCriteria: 'it works', design: 'like so' }, holdUntil: new Date('2026-02-01T00:00:00Z') });
  });

  it('makes a container of every epic and every parent, and keeps edges, notes, closes and interactions', () => {
    const { bundle, notes } = beadsToBundle(src([
      bead({ id: 'p-e', issue_type: 'feature' }),
      bead({ id: 'p-e.1', status: 'closed', closed_at: '2026-01-03T00:00:00Z', close_reason: 'merged', notes: 'first try failed',
        dependencies: [
          { issue_id: 'p-e.1', depends_on_id: 'p-e', type: 'parent-child' },
          { issue_id: 'p-e.1', depends_on_id: 'p-x', type: 'blocks' },
          { issue_id: 'p-e.1', depends_on_id: 'p-e', type: 'relates_to' },
          { issue_id: 'p-e.1', depends_on_id: 'p-e', type: 'tracks' },
        ] }),
    ], { interactions: [{ id: 'int-1', kind: 'field_change', created_at: '2026-01-03T00:00:00Z', actor: 'Ann', issue_id: 'p-e.1', extra: { field: 'status' } }],
    memories: [{ _type: 'memory', key: 'k', value: 'v' }] }), OPTS);
    expect(bundle.engine.tasks.map(t => [t.id, t.kind, t.parentId])).toEqual([['p-e', 'container', null], ['p-e.1', 'work', 'p-e']]);
    expect(bundle.engine.links).toEqual([{ a: 'p-e.1', b: 'p-e', kind: 'related' }]);
    expect(bundle.engine.deps).toEqual([]);
    expect(notes).toEqual([
      'dropped a blocks edge p-e.1 -> p-x: p-x isn\'t in the export',
      'dropped a tracks edge p-e.1 -> p-e: an edge type the engine has no place for',
    ]);
    expect(bundle.engine.events.map(e => [e.kind, e.payload])).toEqual([
      ['note', { text: 'first try failed' }],
      ['move:finish', { reason: 'merged' }],
      ['beads.interaction', { id: 'int-1', kind: 'field_change', field: 'status' }],
    ]);
    expect(bundle.shreni.memories).toEqual([expect.objectContaining({ key: 'k', content: 'v', project_id: bundle.engine.project.id })]);
  });

  it('lists every dependency cycle, and fails the dry run on one', () => {
    expect(findCycles([{ taskId: 'a', dependsOnId: 'b' }, { taskId: 'b', dependsOnId: 'a' }, { taskId: 'c', dependsOnId: 'c' }]))
      .toEqual([['a', 'b'], ['c']]);
    const r = dryRun(src([
      bead({ id: 'p-a', dependencies: [{ issue_id: 'p-a', depends_on_id: 'p-b', type: 'blocks' }] }),
      bead({ id: 'p-b', dependencies: [{ issue_id: 'p-b', depends_on_id: 'p-a', type: 'blocks' }] }),
    ]), OPTS);
    expect(r.ok).toBe(false);
    expect(renderDryRun(r)).toContain('✗ dependency cycle: p-a -> p-b -> p-a');
  });

  it('holds back a blocked parent\'s children, on beads and on the engine alike', () => {
    const issues = [
      bead({ id: 'p-first' }),
      bead({ id: 'p-epic', issue_type: 'epic', dependencies: [{ issue_id: 'p-epic', depends_on_id: 'p-first', type: 'blocks' }] }),
      bead({ id: 'p-epic.1', dependencies: [{ issue_id: 'p-epic.1', depends_on_id: 'p-epic', type: 'parent-child' }] }),
    ];
    expect(bdReady(issues, NOW)).toEqual(['p-first']);
    const r = dryRun(src(issues), OPTS);
    expect(r.ready).toMatchObject({ beads: ['p-first'], engine: ['p-first'] });
  });

  it('works a pending follow-up: open and boosted, even while awaiting merge', () => {
    const { bundle } = beadsToBundle(src([bead({ id: 'p-a', status: 'in_progress', labels: ['awaiting-merge', 'pr-needs-followup'] })]), OPTS);
    expect(bundle.engine.tasks[0]).toMatchObject({ state: 'open', boosted: true, tags: [] });
  });

  it('says what the engine would refuse, and what to fix in beads first', () => {
    const r = dryRun(src([
      bead({ id: 'p-e', issue_type: 'epic', status: 'closed', closed_at: '2026-01-03T00:00:00Z' }),
      bead({ id: 'p-e.1', status: 'deferred', dependencies: [{ issue_id: 'p-e.1', depends_on_id: 'p-e', type: 'parent-child' }] }),
      bead({ id: 'p-f', issue_type: 'epic', dependencies: [{ issue_id: 'p-f', depends_on_id: 'p-f.1', type: 'blocks' }] }),
      bead({ id: 'p-f.1', dependencies: [{ issue_id: 'p-f.1', depends_on_id: 'p-f', type: 'parent-child' }] }),
    ]), OPTS);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([
      'p-e is closed with a live child, p-e.1 (parked); close or move p-e.1 in beads first',
      'p-f waits on p-f.1, and one contains the other, so neither ever settles; remove the dependency in beads first',
    ]);
  });

  it('drops waits on planning sessions, never hands one out, and lists what is expected to differ', () => {
    const r = dryRun(src([
      bead({ id: 'p-s', issue_type: 'suthradhara-session' }),
      bead({ id: 'p-t', status: 'deferred', dependencies: [{ issue_id: 'p-t', depends_on_id: 'p-s', type: 'blocks' }] }),
      // A parent whose children are all done: beads would work it, the engine completes it.
      bead({ id: 'p-p' }),
      bead({ id: 'p-p.1', status: 'closed', closed_at: '2026-01-03T00:00:00Z', dependencies: [
        { issue_id: 'p-p.1', depends_on_id: 'p-p', type: 'parent-child' },
        { issue_id: 'p-p.1', depends_on_id: 'p-x', type: 'blocks' },
      ] }),
      bead({ id: 'p-h', status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    ]), OPTS);
    expect(r.mismatches).toEqual([]);
    expect(r.ready).toMatchObject({ beads: ['p-p'], engine: [], nowContainers: ['p-p'], onlyBeads: [] });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([
      'dropped p-t\'s wait on p-s, a planning session',
      'dropped a blocks edge p-p.1 -> p-x: p-x isn\'t in the export',
      '1 parked task keeps its beads defer date as a hold, which outlasts an unpark: p-h (2027-01-01)',
    ]);
  });

  it('needs one id prefix', () => {
    expect(beadsIdPrefix([bead({ id: 'web-abc' }), bead({ id: 'web-abc.1' })])).toBe('web');
    expect(() => beadsIdPrefix([bead({ id: 'web-abc' }), bead({ id: 'api-xyz' })])).toThrow(/the beads use web, api id prefixes; the importer needs exactly one/);
  });

  it('reads issues and interactions, naming a bad line', () => {
    const e = parseBeadsExport('{"_type":"issue","id":"p-a"}\n{"_type":"memory","key":"k","value":"v"}\n', '{"id":"int-1","kind":"comment"}\n');
    expect([e.issues.length, e.memories.length, e.interactions.length]).toEqual([1, 1, 1]);
    expect(() => parseBeadsExport('{"_type":"issue"}\nnot json\n')).toThrow(/issues\.jsonl line 2 isn't JSON/);
  });
});
