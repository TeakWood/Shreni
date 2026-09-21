import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseBeads,
  collectSubtreeIds,
  topoOrder,
  buildExportDocument,
  markdownFormat,
  runExport,
  findExecutedBeads,
  ExportCycleError,
  type ExportBead,
  type ExportDeps,
} from './export.js';
import { makeContext } from './registry.js';
import type { KshetraConfig } from '../kshetra/config.js';

// A minimal bd-list row builder. Only the fields parseBeads reads are set.
function row(
  id: string,
  opts: {
    title?: string;
    priority?: number;
    status?: string;
    type?: string;
    parent?: string;
    blockedBy?: string[]; // ids that block this bead (execution edges)
    labels?: string[];
    description?: string;
    acceptance?: string;
    design?: string;
    closeReason?: string;
    notes?: string;
  } = {},
): object {
  const deps = [
    ...(opts.parent ? [{ issue_id: id, depends_on_id: opts.parent, type: 'parent-child' }] : []),
    ...(opts.blockedBy ?? []).map(b => ({ issue_id: id, depends_on_id: b, type: 'blocks' })),
  ];
  return {
    id,
    title: opts.title ?? `title ${id}`,
    priority: opts.priority ?? 2,
    status: opts.status ?? 'open',
    issue_type: opts.type ?? 'task',
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(deps.length ? { dependencies: deps } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.acceptance ? { acceptance_criteria: opts.acceptance } : {}),
    ...(opts.design ? { design: opts.design } : {}),
    ...(opts.closeReason ? { close_reason: opts.closeReason } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
}

describe('parseBeads', () => {
  it('extracts blocks edges as dependsOn and ignores parent-child edges', () => {
    const json = JSON.stringify([
      row('e', { type: 'epic' }),
      row('e.2', { parent: 'e', blockedBy: ['e.1'] }),
      row('e.1', { parent: 'e' }),
    ]);
    const beads = parseBeads(json);
    const b2 = beads.find(b => b.id === 'e.2')!;
    expect(b2.dependsOn).toEqual(['e.1']); // 'blocks' only
    expect(b2.parent).toBe('e'); // parent-child recorded separately, not as an edge
  });

  it('is total: skips malformed rows, tolerates missing optional fields', () => {
    const json = JSON.stringify([{ nope: true }, row('a'), 'garbage', null]);
    const beads = parseBeads(json);
    expect(beads.map(b => b.id)).toEqual(['a']);
    expect(beads[0].description).toBe('');
    expect(beads[0].labels).toEqual([]);
  });

  it('returns [] on unparseable / non-array input', () => {
    expect(parseBeads('not json')).toEqual([]);
    expect(parseBeads('{"id":"x"}')).toEqual([]);
  });

  it('defaults a missing priority to the backlog tier (4), never P0', () => {
    // A row with no priority field must not jump to the front of the order.
    const beads = parseBeads(JSON.stringify([{ id: 'a', title: 'a' }]));
    expect(beads[0].priority).toBe(4);
  });

  it('captures execution-artefact fields for the C1.2 guard', () => {
    const beads = parseBeads(JSON.stringify([row('a', { closeReason: 'fixed in abc', notes: 'round 1' })]));
    expect(beads[0].closeReason).toBe('fixed in abc');
    expect(beads[0].notes).toBe('round 1');
  });
});

describe('findExecutedBeads', () => {
  it('flags non-open status, close reason, and notes; names each field', () => {
    const beads = parseBeads(
      JSON.stringify([
        row('clean', {}), // open, no notes → not an offender
        row('closed', { status: 'closed', closeReason: 'fixed it' }),
        row('noted', { notes: 'round 1 feedback' }),
        row('inprog', { status: 'in_progress' }),
      ]),
    );
    const offenders = findExecutedBeads(beads);
    const byId = Object.fromEntries(offenders.map(o => [o.id, o.fields]));
    expect(byId.clean).toBeUndefined();
    expect(byId.closed).toEqual(['status=closed', 'close reason']);
    expect(byId.noted).toEqual(['notes']);
    expect(byId.inprog).toEqual(['status=in_progress']);
  });

  it('returns [] for an all-open, note-free plan-time set', () => {
    const beads = parseBeads(JSON.stringify([row('a'), row('b'), row('c')]));
    expect(findExecutedBeads(beads)).toEqual([]);
  });
});

describe('collectSubtreeIds', () => {
  it('walks the parent pointers to the full subtree, excluding out-of-tree beads', () => {
    const beads = parseBeads(
      JSON.stringify([
        row('e', { type: 'epic' }),
        row('e.1', { parent: 'e' }),
        row('e.2', { parent: 'e' }),
        row('e.2.1', { parent: 'e.2' }), // grandchild
        row('other', {}),
      ]),
    );
    const scope = collectSubtreeIds(beads, 'e');
    expect([...scope].sort()).toEqual(['e', 'e.1', 'e.2', 'e.2.1']);
    expect(scope.has('other')).toBe(false);
  });
});

describe('topoOrder', () => {
  const beads = (ids: [string, number][]): ExportBead[] =>
    parseBeads(JSON.stringify(ids.map(([id, priority]) => row(id, { priority }))));

  it('orders blockers before the beads they block', () => {
    const bs = beads([['a', 2], ['b', 2], ['c', 2]]);
    const ordered = topoOrder(bs, [{ from: 'c', to: 'a' }, { from: 'a', to: 'b' }]);
    expect(ordered.map(b => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('breaks ties by priority then id among equally-unblocked beads', () => {
    // No edges: pure tie-break. b0 is P0 (first), then the rest by id ascending.
    const bs = beads([['zeta', 2], ['alpha', 2], ['b0', 0], ['mid', 1]]);
    const ordered = topoOrder(bs, []);
    expect(ordered.map(b => b.id)).toEqual(['b0', 'mid', 'alpha', 'zeta']);
  });

  it('is stable regardless of input array order', () => {
    const forward = topoOrder(beads([['a', 2], ['b', 2], ['c', 2]]), []);
    const reversed = topoOrder(beads([['c', 2], ['b', 2], ['a', 2]]), []);
    expect(forward.map(b => b.id)).toEqual(reversed.map(b => b.id));
  });

  it('throws ExportCycleError naming the cycle', () => {
    const bs = beads([['a', 2], ['b', 2]]);
    let err: unknown;
    try {
      topoOrder(bs, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExportCycleError);
    expect((err as ExportCycleError).message).toMatch(/dependency cycle: /);
    expect((err as ExportCycleError).cycle).toContain('a');
    expect((err as ExportCycleError).cycle).toContain('b');
  });
});

describe('buildExportDocument', () => {
  const graph = [
    row('e', { type: 'epic', title: 'The Epic' }),
    row('e.1', { parent: 'e', priority: 1 }),
    row('e.2', { parent: 'e', priority: 1, blockedBy: ['e.1'] }),
    row('e.3', { parent: 'e', priority: 1, blockedBy: ['e.1'] }),
    row('other', { title: 'Unrelated' }),
  ];

  it('scopes to the epic subtree, drops the epic container, uses its title as goal', () => {
    const doc = buildExportDocument(parseBeads(JSON.stringify(graph)), { epic: 'e' });
    expect(doc.goal).toBe('The Epic');
    expect(doc.epicId).toBe('e');
    expect(doc.beads.map(b => b.id)).toEqual(['e.1', 'e.2', 'e.3']); // e (epic) and other excluded
  });

  it('e.1 precedes its blocked siblings; equal-priority siblings tie-break by id', () => {
    const doc = buildExportDocument(parseBeads(JSON.stringify(graph)), { epic: 'e' });
    expect(doc.beads.map(b => b.id)).toEqual(['e.1', 'e.2', 'e.3']);
  });

  it('without --epic, exports every non-epic bead', () => {
    const doc = buildExportDocument(parseBeads(JSON.stringify(graph)));
    expect(doc.epicId).toBeNull();
    expect(doc.beads.map(b => b.id).sort()).toEqual(['e.1', 'e.2', 'e.3', 'other']);
  });

  it('drops edges that cross the scope boundary', () => {
    const doc = buildExportDocument(parseBeads(JSON.stringify(graph)), { epic: 'e' });
    // Every edge endpoint is an in-scope work bead.
    for (const e of doc.edges) {
      expect(doc.beads.map(b => b.id)).toContain(e.from);
      expect(doc.beads.map(b => b.id)).toContain(e.to);
    }
  });

  it('drops an out-of-scope dependency from a bead\'s dependsOn (self-contained export)', () => {
    const withForeignDep = [
      row('e', { type: 'epic', title: 'The Epic' }),
      row('e.1', { parent: 'e', blockedBy: ['e.0', 'closed-infra'] }), // e.0 in-scope, closed-infra not
      row('e.0', { parent: 'e' }),
      row('closed-infra', { status: 'closed' }), // out of the epic subtree
    ];
    const doc = buildExportDocument(parseBeads(JSON.stringify(withForeignDep)), { epic: 'e' });
    const e1 = doc.beads.find(b => b.id === 'e.1')!;
    expect(e1.dependsOn).toEqual(['e.0']); // closed-infra dropped
    const md = markdownFormat.render(doc);
    expect(md).not.toContain('closed-infra');
  });

  it('throws when the requested epic is absent', () => {
    expect(() => buildExportDocument(parseBeads(JSON.stringify(graph)), { epic: 'nope' })).toThrow(/Epic not found/);
  });
});

describe('markdownFormat.render', () => {
  const doc = () =>
    buildExportDocument(
      parseBeads(
        JSON.stringify([
          row('e', { type: 'epic', title: 'The Epic' }),
          row('e.1', {
            parent: 'e',
            priority: 1,
            title: 'First',
            description: 'do the first thing',
            acceptance: 'first works',
            labels: ['study', 'core'],
          }),
          row('e.2', { parent: 'e', priority: 1, title: 'Second', blockedBy: ['e.1'], design: 'design for second' }),
        ]),
      ),
      { epic: 'e' },
    );

  it('renders the goal, count, order note, sections and dependency graph', () => {
    const md = markdownFormat.render(doc());
    expect(md).toContain('# The Epic');
    expect(md).toContain('2 beads.');
    expect(md).toContain('valid execution order');
    expect(md).toContain('### e.1 — First');
    expect(md).toContain('- Priority: P1');
    expect(md).toContain('- Labels: core, study'); // sorted
    expect(md).toContain('**Acceptance criteria**');
    expect(md).toContain('### e.2 — Second');
    expect(md).toContain('- Depends on: e.1');
    expect(md).toContain('**Design notes**');
    expect(md).toContain('## Dependency graph');
    expect(md).toContain('e.1 -> e.2');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('omits empty fields consistently and never emits a timestamp or absolute path', () => {
    const md = markdownFormat.render(doc());
    // e.1 has no dependsOn → only e.2's "Depends on" line appears (omitted consistently).
    expect(md.match(/- Depends on:/g)).toHaveLength(1);
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
    expect(md).not.toMatch(/\/[Uu]sers\//); // absolute path
    expect(md).not.toMatch(/\/home\//);
  });

  it('is byte-identical across repeated renders of the same snapshot (headline determinism)', () => {
    expect(markdownFormat.render(doc())).toBe(markdownFormat.render(doc()));
  });

  it('renders "No dependencies" when the graph has no edges', () => {
    const d = buildExportDocument(parseBeads(JSON.stringify([row('a'), row('b')])));
    expect(markdownFormat.render(d)).toContain('No dependencies between the listed beads.');
  });
});

describe('runExport (command wiring)', () => {
  const WORK = join(tmpdir(), `shreni-export-${process.pid}`);
  const outFile = join(WORK, 'export.md');
  const kshetra = { id: 'testk' } as KshetraConfig;

  const fixture = JSON.stringify([
    row('e', { type: 'epic', title: 'Study Epic' }),
    row('e.1', { parent: 'e', priority: 1, title: 'One' }),
    row('e.2', { parent: 'e', priority: 1, title: 'Two', blockedBy: ['e.1'] }),
  ]);

  const deps = (json: string, over: Partial<ExportDeps> = {}): Partial<ExportDeps> => ({
    loadBeadsJson: async () => json,
    registry: () => [kshetra],
    loadProvenance: async () => ({ beadsHeadSha: 'abc123', beadIdHash: 'sha256:deadbeef' }),
    readSnapshotManifest: () => ({ snapshotId: 'snap:fixture', beadIdHash: 'sha256:deadbeef' }),
    ...over,
  });

  beforeEach(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
  });
  afterEach(() => rmSync(WORK, { recursive: true, force: true }));

  it('writes a byte-identical file across two runs over an unchanged snapshot', async () => {
    await runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--out', outFile]), deps(fixture));
    const first = readFileSync(outFile, 'utf8');
    await runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--out', outFile]), deps(fixture));
    const second = readFileSync(outFile, 'utf8');
    expect(second).toBe(first);
    expect(first).toContain('# Study Epic');
  });

  it('--epic scopes to the subtree; out-of-scope beads never appear', async () => {
    const json = JSON.stringify([
      row('e', { type: 'epic', title: 'Study Epic' }),
      row('e.1', { parent: 'e' }),
      row('foreign', { title: 'Foreign Bead' }),
    ]);
    await runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--out', outFile]), deps(json));
    const md = readFileSync(outFile, 'utf8');
    expect(md).toContain('e.1');
    expect(md).not.toContain('Foreign Bead');
    expect(md).not.toContain('foreign');
  });

  it('warns (but still succeeds) when --epic resolves to zero work beads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Epic with no parent-linked children → empty subtree.
    const json = JSON.stringify([row('lonely', { type: 'epic', title: 'Lonely Epic' })]);
    await runExport(makeContext(['--kshetra', 'testk', '--epic', 'lonely', '--out', outFile]), deps(json));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no work beads'));
    expect(existsSync(outFile)).toBe(true); // still writes — an empty epic is legal
    warn.mockRestore();
  });

  it('refuses to export a scope containing a closed bead, naming it and writing nothing', async () => {
    const json = JSON.stringify([
      row('e', { type: 'epic', title: 'Study Epic' }),
      row('e.1', { parent: 'e' }),
      row('e.2', { parent: 'e', status: 'closed', closeReason: 'fixed in abc123' }),
    ]);
    await expect(
      runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--out', outFile]), deps(json)),
    ).rejects.toThrow(/e\.2 — status=closed, close reason/);
    expect(existsSync(outFile)).toBe(false); // wrote nothing
  });

  it('--allow-executed exports the same scope and marks the header with a warning', async () => {
    const json = JSON.stringify([
      row('e', { type: 'epic', title: 'Study Epic' }),
      row('e.1', { parent: 'e', status: 'closed', closeReason: 'the answer' }),
    ]);
    await runExport(
      makeContext(['--kshetra', 'testk', '--epic', 'e', '--allow-executed', '--out', outFile]),
      deps(json),
    );
    const md = readFileSync(outFile, 'utf8');
    expect(md).toMatch(/⚠ WARNING: this export CONTAINS EXECUTION HISTORY/);
    expect(md).toContain('the answer'); // the leaked close reason is present, as asked
  });

  it('records provenance (snapshot id, beads HEAD, bead-id hash) in the header', async () => {
    await runExport(
      makeContext(['--kshetra', 'testk', '--epic', 'e', '--snapshot', '/snap', '--out', outFile]),
      deps(fixture),
    );
    const md = readFileSync(outFile, 'utf8');
    expect(md).toContain('- Source snapshot: snap:fixture');
    expect(md).toContain('- Beads repo HEAD: abc123');
    expect(md).toContain('- Bead-id hash: sha256:deadbeef');
  });

  it('without --snapshot, the header notes the export is not linked to a snapshot', async () => {
    await runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--out', outFile]), deps(fixture));
    const md = readFileSync(outFile, 'utf8');
    expect(md).toContain('- Source snapshot: (not linked to a freeze snapshot)');
  });

  it('fails (writes nothing) when --snapshot names a manifest whose state differs', async () => {
    const mismatched = deps(fixture, {
      readSnapshotManifest: () => ({ snapshotId: 'snap:other', beadIdHash: 'sha256:different' }),
    });
    await expect(
      runExport(makeContext(['--kshetra', 'testk', '--epic', 'e', '--snapshot', '/snap', '--out', outFile]), mismatched),
    ).rejects.toThrow(/does not match the exported state/);
    expect(existsSync(outFile)).toBe(false);
  });

  it('rejects an unknown kshetra', async () => {
    await expect(
      runExport(makeContext(['--kshetra', 'missing', '--out', outFile]), deps(fixture)),
    ).rejects.toThrow(/Kshetra not found/);
  });

  it('requires --kshetra and --out', async () => {
    await expect(runExport(makeContext(['--out', outFile]), deps(fixture))).rejects.toThrow(/--kshetra/);
    await expect(runExport(makeContext(['--kshetra', 'testk']), deps(fixture))).rejects.toThrow(/--out/);
  });

  it('rejects an unsupported --format', async () => {
    await expect(
      runExport(makeContext(['--kshetra', 'testk', '--out', outFile, '--format', 'pdf']), deps(fixture)),
    ).rejects.toThrow(/Unsupported --format/);
  });

  it('a dependency cycle fails and writes no file', async () => {
    const cyclic = JSON.stringify([
      row('a', { blockedBy: ['b'] }),
      row('b', { blockedBy: ['a'] }),
    ]);
    await expect(
      runExport(makeContext(['--kshetra', 'testk', '--out', outFile]), deps(cyclic)),
    ).rejects.toThrow(/dependency cycle/);
    expect(existsSync(outFile)).toBe(false);
  });
});
