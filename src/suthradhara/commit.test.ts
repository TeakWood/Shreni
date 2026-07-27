import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitBundle, type CommitDeps } from './commit';
import {
  newSessionBeadRecord,
  recordEpicFiled,
  recordDocWritten,
  type SessionPlan,
  type SessionBeadRecord,
} from './sessionbead';
import { resolveDesignDir } from './designdoc';
import type { Decomposition } from './decomposition';
import type { KshetraConfig } from '../kshetra/config';

// A repo rooted at a real temp dir so the doc-write path exercises the actual
// filesystem (mkdir + write) while staying isolated. Non-doc tests never write.
const REPO_ROOT = mkdtempSync(join(tmpdir(), 'suthradhara-commit-'));

const KSHETRA = {
  id: 'myapp',
  repo: { path: REPO_ROOT },
  beads: { path: `${REPO_ROOT}-beads` },
  agents: { model: 'claude-opus-4-8' },
} as unknown as KshetraConfig;

afterEach(() => {
  rmSync(resolveDesignDir(KSHETRA), { recursive: true, force: true });
});

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

// A fake session-bead store that records journal writes and can be `load`ed back
// (so a resume reconciles against a real journal), plus a fake `bd` runner that
// mints predictable ids for creates and swallows dep adds. `stored` holds the
// latest journaled record per bead id — what a resume's load() returns.
function fakeDeps(seed?: { id: string; record: SessionBeadRecord }) {
  const stored = new Map<string, SessionBeadRecord>();
  if (seed) stored.set(seed.id, seed.record);
  const journals: SessionBeadRecord[] = [];
  const counts = { create: 0 };
  const sessionBead: NonNullable<CommitDeps['sessionBead']> = {
    create(plan: SessionPlan) {
      counts.create++;
      const record = newSessionBeadRecord(plan);
      stored.set('myapp-sess', record);
      return Promise.resolve({ id: 'myapp-sess', record });
    },
    journal(id: string, r: SessionBeadRecord) {
      stored.set(id, r);
      journals.push(r);
      return Promise.resolve();
    },
    load(id: string) {
      return Promise.resolve(stored.get(id) ?? null);
    },
  };
  let n = 0;
  const calls: string[][] = [];
  const bd = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === 'create') return Promise.resolve(`myapp-${++n}`);
    return Promise.resolve('');
  });
  return { deps: { bd, sessionBead } as CommitDeps, journals, calls, bd, stored, counts };
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

  // §8.1: an evolve commit targets the EXISTING doc path (no doc body here — that
  // is xa0.6 — but the spine's docPath is decided up front and must be the
  // existing file, not a fresh slug from the epic title).
  it('resolves the doc target to the existing doc path when evolving', async () => {
    let capturedPlan: SessionPlan | null = null;
    const sessionBead: NonNullable<CommitDeps['sessionBead']> = {
      create(plan) { capturedPlan = plan; return Promise.resolve({ id: 's', record: newSessionBeadRecord(plan) }); },
      journal() { return Promise.resolve(); },
      load() { return Promise.resolve(null); },
    };
    let n = 0;
    const bd = vi.fn((args: string[]) => Promise.resolve(args[0] === 'create' ? `myapp-${++n}` : ''));

    await commitBundle(
      {
        kshetra: KSHETRA,
        decomposition: decomp(),
        evolving: { feature: 'CSV import', targetRelPath: '.shreni/design/legacy-csv.md', locatedAt: '2026-07-27T10:00:00.000Z' },
      },
      { bd, sessionBead },
    );

    // Not the fresh slug (.shreni/design/csv-import.md) — the existing file.
    expect(capturedPlan!.docPath).toBe('.shreni/design/legacy-csv.md');
  });

  // §8 doc emission: when the model supplied a doc body, the commit writes the
  // file (server-authors-the-file), stamps the path into each bead description,
  // records the sha, and reports the relPath.
  it('writes the design doc, links it into every bead, and journals its sha', async () => {
    const { deps, calls, journals } = fakeDeps();
    const report = await commitBundle(
      { kshetra: KSHETRA, decomposition: decomp(), doc: { content: '# CSV import\n\nThe design.' } },
      deps,
    );

    expect(report.ok).toBe(true);
    expect(report.docRelPath).toBe('.shreni/design/csv-import.md');

    // The file landed on disk with the emitted body.
    const abs = join(resolveDesignDir(KSHETRA), 'csv-import.md');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toContain('The design.');

    // Every `bd create` description carries the on-demand-read link line.
    const createCalls = calls.filter(c => c[0] === 'create');
    expect(createCalls).toHaveLength(3); // epic + 2 children
    for (const c of createCalls) {
      const desc = c[c.indexOf('-d') + 1];
      expect(desc).toContain('.shreni/design/csv-import.md');
    }

    // The doc sha is journaled BEFORE the beads are filed (doc-first ordering).
    expect(journals[0].journal.docSha).toBeTruthy();
    expect(journals[0].journal.epicId).toBeUndefined();
  });

  // §7, Q2: a resume against the SAME session bead files only the missing tail
  // and never re-files what the journal already records.
  it('resumes an interrupted commit: files only the remainder, no double-filing', async () => {
    // First attempt: epic lands, then the FIRST child create fails.
    const first = fakeDeps();
    let creates = 0;
    (first.deps.bd as ReturnType<typeof vi.fn>).mockImplementation((args: string[]) => {
      first.calls.push(args);
      if (args[0] === 'create') {
        creates++;
        if (creates === 2) return Promise.reject(new Error('bd down'));
        return Promise.resolve(`myapp-${creates}`);
      }
      return Promise.resolve('');
    });
    const r1 = await commitBundle({ kshetra: KSHETRA, decomposition: decomp() }, first.deps);
    expect(r1.ok).toBe(false);
    expect(r1.epicId).toBe('myapp-1');
    expect(r1.childIds).toEqual({});
    const beadId = r1.sessionBeadId!;

    // Resume: reuse the SAME stored journal (seed a fresh deps with it), pass the
    // bead id as the resume handle. A healthy bd now completes the run.
    const resumed = fakeDeps({ id: beadId, record: first.stored.get(beadId)! });
    const r2 = await commitBundle(
      { kshetra: KSHETRA, decomposition: decomp(), resume: { sessionBeadId: beadId } },
      resumed.deps,
    );

    expect(r2.ok).toBe(true);
    expect(r2.sessionBeadId).toBe(beadId);            // same bead, not a new one
    expect(r2.epicId).toBe('myapp-1');                // carried from the journal
    // The resume never re-created the epic — its creates are children only.
    const resumeCreates = resumed.calls.filter(c => c[0] === 'create');
    expect(resumeCreates).toHaveLength(2);            // exactly the two children
    expect(Object.keys(r2.childIds)).toEqual(['c1', 'c2']);
    expect(r2.depsAdded).toEqual(['c2<-c1']);
    // The resume did NOT create a second session bead — it loaded the existing one.
    expect(resumed.counts.create).toBe(0);
  });

  // A resume whose journal already records the doc sha does NOT re-write the file
  // (written exactly once), but still reports the path.
  it('resume does not re-write an already-written design doc', async () => {
    // Seed a journal with the epic + doc already landed.
    const plan: SessionPlan = { decomposition: decomp(), docPath: '.shreni/design/csv-import.md' };
    let record = newSessionBeadRecord(plan);
    record = recordDocWritten(record, 'deadbeef0000');
    record = recordEpicFiled(record, 'myapp-1');
    const resumed = fakeDeps({ id: 'myapp-sess', record });

    let wroteDoc = false;
    // Spy on the fs by pointing content at a body; if writeDesignDoc ran it would
    // create the file. Assert it did NOT (the sha was already journaled).
    const report = await commitBundle(
      {
        kshetra: KSHETRA,
        decomposition: decomp(),
        doc: { content: '# CSV import\n\nRewritten body that must NOT be written.' },
        resume: { sessionBeadId: 'myapp-sess' },
      },
      resumed.deps,
    );
    wroteDoc = existsSync(join(resolveDesignDir(KSHETRA), 'csv-import.md'));

    expect(report.ok).toBe(true);
    expect(report.docRelPath).toBe('.shreni/design/csv-import.md'); // reported from the plan
    expect(wroteDoc).toBe(false);                                    // not re-written
  });
});
