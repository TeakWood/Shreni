import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KshetraConfig } from '../kshetra/config';
import type { Decomposition } from './decomposition';

// Mock execFile before importing the module so SessionBeadStore's calls go
// through our spy (mirrors beads.test.ts). promisify wraps the callback form.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: execFileMock }));

const {
  SUTHRADHARA_SESSION_TYPE,
  SUTHRADHARA_ACTOR,
  SESSION_BEAD_RECORD_VERSION,
  emptyJournal,
  newSessionBeadRecord,
  depKey,
  expectedChildId,
  recordEpicFiled,
  recordChildFiled,
  recordDepAdded,
  recordDocWritten,
  reconcile,
  serializeRecord,
  parseRecord,
  SessionBeadParseError,
  sessionBeadTitle,
  buildCreateSessionBeadArgv,
  SessionBeadStore,
  SessionBeadError,
} = await import('./sessionbead.js');

import type { SessionPlan, SessionBeadRecord } from './sessionbead.js';

const { compileFilingPlan } = await import('./filing.js');
const { filingAllowlist } = await import('./allowlist.js');

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: 'git@github.com:TeakWood/myapp.git', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: 'git@github.com:TeakWood/myapp-beads.git', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

// A valid three-child decomposition with a linear dep chain (c2 waits for c1).
function makeDecomposition(): Decomposition {
  return {
    epic: { ref: 'epic', title: 'Add auth', type: 'epic', priority: 1, description: 'top' },
    children: [
      { ref: 'c1', title: 'API', type: 'task', priority: 2, acceptanceCriteria: 'endpoints exist' },
      { ref: 'c2', title: 'UI', type: 'task', priority: 2, acceptanceCriteria: 'form renders' },
      { ref: 'c3', title: 'Docs', type: 'task', priority: 3, acceptanceCriteria: 'documented' },
    ],
    deps: [{ blocked: 'c2', blocker: 'c1' }],
  };
}

function makePlan(): SessionPlan {
  return { decomposition: makeDecomposition(), docPath: 'docs/design/auth.md' };
}

function mockSuccess(stdout: string) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockFailure(stderr: string) {
  const err = Object.assign(new Error('Command failed'), { stderr });
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(err, { stdout: '', stderr });
  });
}

function callArgs(i: number): string[] {
  return execFileMock.mock.calls[i][1] as string[];
}

beforeEach(() => {
  execFileMock.mockReset();
});

// ── constants & record scaffolding ───────────────────────────────────────────

describe('constants', () => {
  it('exposes the load-bearing type literal and the session actor', () => {
    expect(SUTHRADHARA_SESSION_TYPE).toBe('suthradhara-session');
    expect(SUTHRADHARA_ACTOR).toBe('suthradhara');
  });
});

describe('newSessionBeadRecord', () => {
  it('starts with the plan and an empty journal at the current version', () => {
    const plan = makePlan();
    const r = newSessionBeadRecord(plan);
    expect(r.version).toBe(SESSION_BEAD_RECORD_VERSION);
    expect(r.plan).toBe(plan);
    expect(r.journal).toEqual({ childIds: {}, depsAdded: [] });
    expect(emptyJournal()).toEqual({ childIds: {}, depsAdded: [] });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe('depKey / expectedChildId', () => {
  it('depKey reads blocked<-blocker', () => {
    expect(depKey('c2', 'c1')).toBe('c2<-c1');
  });
  it('expectedChildId is 1-based under the epic id', () => {
    expect(expectedChildId('proj-42', 0)).toBe('proj-42.1');
    expect(expectedChildId('proj-42', 2)).toBe('proj-42.3');
  });
});

// ── journal updates (immutable) ──────────────────────────────────────────────

describe('journal updates', () => {
  it('record* return new records and never mutate the input', () => {
    const r0 = newSessionBeadRecord(makePlan());
    const r1 = recordEpicFiled(r0, 'proj-1');
    expect(r0.journal.epicId).toBeUndefined();
    expect(r1.journal.epicId).toBe('proj-1');

    const r2 = recordChildFiled(r1, 'c1', 'proj-1.1');
    expect(r1.journal.childIds).toEqual({});
    expect(r2.journal.childIds).toEqual({ 'c1': 'proj-1.1' });

    const r3 = recordDocWritten(r2, 'deadbeef');
    expect(r2.journal.docSha).toBeUndefined();
    expect(r3.journal.docSha).toBe('deadbeef');
  });

  it('recordDepAdded is idempotent on the same edge', () => {
    const step = { kind: 'dep' as const, blockedRef: 'c2', blockerRef: 'c1' };
    const r0 = newSessionBeadRecord(makePlan());
    const r1 = recordDepAdded(r0, step);
    const r2 = recordDepAdded(r1, step);
    expect(r1.journal.depsAdded).toEqual(['c2<-c1']);
    expect(r2.journal.depsAdded).toEqual(['c2<-c1']);
    expect(r2).toBe(r1); // no-op returns the same reference
  });
});

// ── reconcile ────────────────────────────────────────────────────────────────

describe('reconcile', () => {
  it('an empty journal reconciles to the full filing plan + doc write', () => {
    const record = newSessionBeadRecord(makePlan());
    const plan = reconcile(record);
    expect(plan.complete).toBe(false);
    expect(plan.writeDoc).toBe(true);
    // Full plan = epic + 3 children + 1 dep = 5 steps, same order as compile.
    expect(plan.steps).toEqual(compileFilingPlan(makeDecomposition()).steps);
  });

  it('after epic + some children land, reconcile returns EXACTLY the missing tail', () => {
    let record: SessionBeadRecord = newSessionBeadRecord(makePlan());
    record = recordEpicFiled(record, 'proj-1');
    record = recordChildFiled(record, 'c1', 'proj-1.1');
    record = recordDocWritten(record, 'sha');

    const plan = reconcile(record);
    expect(plan.writeDoc).toBe(false); // doc already written
    // c1 landed; c2 and c3 remain, then the c2<-c1 dep.
    const kinds = plan.steps.map(s =>
      s.kind === 'create' ? `create:${s.ref}` : `dep:${s.blockedRef}<-${s.blockerRef}`,
    );
    expect(kinds).toEqual(['create:c2', 'create:c3', 'dep:c2<-c1']);
    expect(plan.complete).toBe(false);
  });

  it('a fully journaled record files nothing new (complete)', () => {
    let record: SessionBeadRecord = newSessionBeadRecord(makePlan());
    record = recordEpicFiled(record, 'proj-1');
    record = recordChildFiled(record, 'c1', 'proj-1.1');
    record = recordChildFiled(record, 'c2', 'proj-1.2');
    record = recordChildFiled(record, 'c3', 'proj-1.3');
    record = recordDepAdded(record, { kind: 'dep', blockedRef: 'c2', blockerRef: 'c1' });
    record = recordDocWritten(record, 'sha');

    const plan = reconcile(record);
    expect(plan).toEqual({ writeDoc: false, steps: [], complete: true });
  });

  it('a dep whose children exist but edge not added is still reconciled', () => {
    let record: SessionBeadRecord = newSessionBeadRecord(makePlan());
    record = recordEpicFiled(record, 'proj-1');
    record = recordChildFiled(record, 'c1', 'proj-1.1');
    record = recordChildFiled(record, 'c2', 'proj-1.2');
    record = recordChildFiled(record, 'c3', 'proj-1.3');
    record = recordDocWritten(record, 'sha');

    const plan = reconcile(record);
    expect(plan.steps.map(s => s.kind)).toEqual(['dep']);
    expect(plan.complete).toBe(false);
  });
});

// ── serialization ────────────────────────────────────────────────────────────

describe('serializeRecord / parseRecord', () => {
  it('round-trips a record through JSON', () => {
    const record = recordEpicFiled(newSessionBeadRecord(makePlan()), 'proj-1');
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('accepts metadata that arrives already parsed (object)', () => {
    const record = newSessionBeadRecord(makePlan());
    const obj = JSON.parse(serializeRecord(record));
    expect(parseRecord(obj)).toEqual(record);
  });

  it('rejects an unknown record version', () => {
    const bad = { version: 999, plan: makePlan(), journal: emptyJournal() };
    expect(() => parseRecord(bad)).toThrow(SessionBeadParseError);
  });

  it('rejects a non-object / malformed payload', () => {
    expect(() => parseRecord('not json')).toThrow(SessionBeadParseError);
    expect(() => parseRecord(null)).toThrow(SessionBeadParseError);
    expect(() => parseRecord({ version: SESSION_BEAD_RECORD_VERSION })).toThrow(SessionBeadParseError);
  });
});

// ── create argv (type + owner set at creation) ───────────────────────────────

describe('buildCreateSessionBeadArgv', () => {
  it('sets type AND owner at creation, carries the plan in metadata, is silent', () => {
    const record = newSessionBeadRecord(makePlan());
    const argv = buildCreateSessionBeadArgv(record);

    expect(argv[0]).toBe('create');
    expect(argv[1]).toBe(sessionBeadTitle(record.plan));
    // Type at creation — the race-proof isolation guarantee (§9.1).
    expect(argv).toContain('-t');
    expect(argv[argv.indexOf('-t') + 1]).toBe(SUTHRADHARA_SESSION_TYPE);
    // Owned by the session actor from the first write.
    expect(argv[argv.indexOf('--assignee') + 1]).toBe(SUTHRADHARA_ACTOR);
    // Plan spine rides in metadata as valid JSON.
    const meta = argv[argv.indexOf('--metadata') + 1];
    expect(parseRecord(meta)).toEqual(record);
    expect(argv).toContain('--silent');
  });

  it('keeps an operator-supplied title as one inert argv element (no shell)', () => {
    const plan = makePlan();
    plan.decomposition.epic.title = '"; rm -rf ~"';
    const argv = buildCreateSessionBeadArgv(newSessionBeadRecord(plan));
    expect(argv[1]).toBe(sessionBeadTitle(plan));
    expect(argv[1]).toContain('rm -rf');
  });
});

// ── server-managed lifecycle (SessionBeadStore) ──────────────────────────────

describe('SessionBeadStore', () => {
  it('create files then immediately claims (in_progress + owned); sets BEADS_DIR', async () => {
    // First exec (create) returns the id; the claim update returns ''.
    execFileMock
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, { stdout: 'proj-9\n', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, { stdout: '', stderr: '' }));

    const store = new SessionBeadStore(KSHETRA);
    const { id, record } = await store.create(makePlan());

    expect(id).toBe('proj-9');
    expect(record.journal).toEqual({ childIds: {}, depsAdded: [] });

    // Create call carried the type.
    expect(callArgs(0)[0]).toBe('create');
    expect(callArgs(0)).toContain(SUTHRADHARA_SESSION_TYPE);
    // Claim call moved it to in_progress + owned — server-driven, not the model.
    expect(callArgs(1)).toEqual(['update', 'proj-9', '--status', 'in_progress', '--assignee', SUTHRADHARA_ACTOR]);

    const opts = execFileMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.BEADS_DIR).toBe(KSHETRA.beads.path);
  });

  it('create throws if bd returns no id', async () => {
    mockSuccess('   ');
    const store = new SessionBeadStore(KSHETRA);
    await expect(store.create(makePlan())).rejects.toThrow(SessionBeadError);
  });

  it('journal overwrites the metadata payload for the owned id', async () => {
    mockSuccess('');
    const store = new SessionBeadStore(KSHETRA);
    const record = recordEpicFiled(newSessionBeadRecord(makePlan()), 'proj-9');
    await store.journal('proj-9', record);
    expect(callArgs(0)).toEqual(['update', 'proj-9', '--metadata', serializeRecord(record)]);
  });

  it('load reconstructs the record from bead metadata (object form)', async () => {
    const record = recordChildFiled(recordEpicFiled(newSessionBeadRecord(makePlan()), 'p9'), 'c1', 'p9.1');
    mockSuccess(JSON.stringify({ id: 'p9', metadata: JSON.parse(serializeRecord(record)) }));
    const store = new SessionBeadStore(KSHETRA);
    expect(await store.load('p9')).toEqual(record);
  });

  it('load reconstructs the record when metadata is a JSON string', async () => {
    const record = newSessionBeadRecord(makePlan());
    mockSuccess(JSON.stringify({ id: 'p9', metadata: serializeRecord(record) }));
    const store = new SessionBeadStore(KSHETRA);
    expect(await store.load('p9')).toEqual(record);
  });

  it('load returns null when the bead carries no payload', async () => {
    mockSuccess(JSON.stringify({ id: 'p9' }));
    const store = new SessionBeadStore(KSHETRA);
    expect(await store.load('p9')).toBeNull();
  });

  it('close routes the note through --reason', async () => {
    mockSuccess('');
    const store = new SessionBeadStore(KSHETRA);
    await store.close('p9', 'session complete');
    expect(callArgs(0)).toEqual(['close', 'p9', '--reason', 'session complete']);
  });

  it('surfaces bd failure as SessionBeadError with stderr', async () => {
    mockFailure('boom');
    const store = new SessionBeadStore(KSHETRA);
    await expect(store.close('p9', 'x')).rejects.toThrow(/boom/);
  });
});

// ── negative: the lifecycle verbs are NEVER in the model allowlist ───────────

describe('server-managed lifecycle keeps the model allowlist clean (§9.1)', () => {
  it('the filing allowlist grants no close/claim/status/update verb', () => {
    const allow = filingAllowlist().join(' ');
    expect(allow).not.toMatch(/bd close/);
    expect(allow).not.toMatch(/bd update/);
    expect(allow).not.toMatch(/--claim/);
    expect(allow).not.toMatch(/--status/);
  });
});
