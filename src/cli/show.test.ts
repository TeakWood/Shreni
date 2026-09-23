import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config.js';
import type { LedgerEntry } from '../ext/index.js';

// Mock only bd() (unknown-id path + payload); keep parseAcceptanceCriteria real.
const mockShow = vi.fn<(id: string) => Promise<string>>();
vi.mock('../sthapathi/beads', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, bd: () => ({ show: mockShow }) };
});

const { runShow, renderShow } = await import('./show');

let dir: string;
let kshetra: KshetraConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shreni-show-'));
  kshetra = {
    id: 'myapp',
    name: 'Myapp',
    repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: dir, remote: '', mode: 'embedded' },
    stack: { language: 'typescript' },
    conventions: {},
    agents: { model: 'm', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  } as KshetraConfig;
  mockShow.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(kind: LedgerEntry['kind'], ts: string, payload: Record<string, unknown>): LedgerEntry {
  return { ts, schemaVersion: 1, kshetra: 'myapp', beadId: 'b1', kind, payload };
}

function writeLedger(...entries: LedgerEntry[]): void {
  writeFileSync(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const BEAD_JSON = JSON.stringify([
  { id: 'b1', title: 'Fix auth', status: 'closed', issue_type: 'task', priority: 2, acceptance_criteria: 'Token refresh works' },
  { id: 'dep', title: 'unrelated dep' },
]);

describe('renderShow', () => {
  it('renders header + a chronological timeline', () => {
    const out = renderShow(
      { id: 'b1', title: 'Fix auth', status: 'closed', type: 'task', priority: 2, criteria: 'Token refresh works' },
      [
        entry('task_claimed', '2026-09-16T00:00:01.000Z', { title: 'Fix auth' }),
        entry('viharapala_done', '2026-09-16T00:00:03.000Z', { round: 1, verdict: 'APPROVE', score: 9 }),
        entry('merge_done', '2026-09-16T00:00:04.000Z', { mergePolicy: 'push', sha: 'deadbeefcafe1234' }),
      ],
    );
    expect(out).toContain('Bead b1 — Fix auth');
    expect(out).toContain('Status: closed · Type: task · P2');
    expect(out).toContain('Acceptance criteria:');
    expect(out).toContain('CLAIMED');
    expect(out).toContain('REVIEW');
    expect(out).toContain('APPROVE');
    expect(out).toContain('MERGE');
    expect(out).toContain('deadbeefcafe'); // sha truncated to 12
    // Claimed must appear before merge (chronological).
    expect(out.indexOf('CLAIMED')).toBeLessThan(out.indexOf('MERGE'));
  });

  it('prints the full sessionId on each agent-execution entry, nothing on the rest (Shreni-beads-228)', () => {
    const SID1 = '0b7c1a52-7e1d-4c4f-9a57-2f0d3b1e9c11';
    const SID2 = 'f3e2d1c0-b9a8-4765-8432-10fedcba9876';
    const out = renderShow(
      { id: 'b1', title: 'Fix auth', status: 'closed', type: 'task', priority: 2, criteria: '' },
      [
        entry('task_claimed', '2026-09-16T00:00:01.000Z', { title: 'Fix auth' }),
        { ...entry('run_started', '2026-09-16T00:00:02.000Z', { agent: 'silpi', provider: 'anthropic', model: 'm', attempt: 1 }), sessionId: SID1 },
        { ...entry('silpi_done', '2026-09-16T00:00:03.000Z', { round: 1, confidence: 90, lintPassed: true, testsPassed: true }), sessionId: SID1 },
        { ...entry('run_started', '2026-09-16T00:00:04.000Z', { agent: 'viharapala', provider: 'anthropic', model: 'm', attempt: 2 }), sessionId: SID2 },
        // A pre-228 entry: no sessionId — renders exactly as before.
        entry('run_usage', '2026-09-16T00:00:05.000Z', { agent: 'viharapala', inputTokens: 1, outputTokens: 1, costUsd: 0, priced: true, outcome: 'ok' }),
        entry('merge_done', '2026-09-16T00:00:06.000Z', { mergePolicy: 'push', sha: 'abc' }),
      ],
    );
    const line = (needle: string): string => out.split('\n').find(l => l.includes(needle)) ?? '';
    expect(line('RUN       silpi')).toContain(`session=${SID1}`);
    expect(line('SILPI')).toContain(`session=${SID1}`);
    expect(line('RUN       viharapala')).toContain(`session=${SID2}`);
    expect(line('RUN       viharapala')).toContain('(attempt 2)');
    expect(line('RUN       silpi')).not.toContain('attempt');
    expect(line('CLAIMED')).not.toContain('session=');
    expect(line('USAGE')).not.toContain('session=');
    expect(line('MERGE')).not.toContain('session=');
  });

  it('renders a run_unmetered entry with its cause and duration (Shreni-beads-27a)', () => {
    const out = renderShow(
      { id: 'b1', title: 'Fix auth', status: 'open', type: 'task', priority: 2, criteria: '' },
      [entry('run_unmetered', '2026-09-16T00:00:02.000Z', { agent: 'silpi', provider: 'anthropic', model: 'm', cause: 'aborted', durationMs: 42100 })],
    );
    expect(out).toContain('UNMETERED silpi aborted after 42.1s');
    // Long sessions read the same as `shreni report` durations (fmtDuration).
    const long = renderShow(
      { id: 'b1', title: 'Fix auth', status: 'open', type: 'task', priority: 2, criteria: '' },
      [entry('run_unmetered', '2026-09-16T00:00:02.000Z', { agent: 'silpi', provider: 'anthropic', model: 'm', cause: 'error', durationMs: 5_400_000 })],
    );
    expect(long).not.toContain('5400.0s');
  });

  it('renders the measured coverage on a coverage gate_result (Shreni-beads-06z)', () => {
    const out = renderShow(
      { id: 'b1', title: 'Fix auth', status: 'closed', type: 'task', priority: 2, criteria: '' },
      [
        entry('gate_result', '2026-09-16T00:00:02.000Z', { gate: 'coverage', verdict: 'pass', round: 1, coverage: { statements: 99.4, lines: 99.41 } }),
        entry('gate_result', '2026-09-16T00:00:02.000Z', { gate: 'lint', verdict: 'pass', round: 1 }),
      ],
    );
    expect(out).toContain('coverage: pass (R1) — statements 99.4% · lines 99.41%');
    expect(out.split('\n').find(l => l.includes('lint: pass'))).not.toContain('—');
  });

  it('renders a clear line when the bead has no ledger entries', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [],
    );
    expect(out).toContain('Timeline: no ledger entries for this bead.');
  });

  it('renders a context_compacted entry as a distinct COMPACT line (epic 408/A1)', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [entry('context_compacted', '2026-09-16T00:00:05.000Z', { trigger: 'auto', preTokens: 187000, turnIndex: 12 })],
    );
    expect(out).toContain('COMPACT');
    expect(out).toContain('context compacted (auto, 187k tokens before)');
  });

  it('renders context_compacted with an unknown trigger when the provider gave none', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [entry('context_compacted', '2026-09-16T00:00:05.000Z', { trigger: 'unknown', preTokens: 0, turnIndex: 0 })],
    );
    expect(out).toContain('context compacted (unknown, 0 tokens before)');
  });

  it('renders review_ablated unmistakably — merged WITHOUT review, never as an approval (epic 8wi)', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'closed', type: 'task', priority: null, criteria: '' },
      [entry('review_ablated', '2026-09-16T00:00:03.000Z', { round: 2, ablations: ['review'] })],
    );
    expect(out).toContain('merged WITHOUT review (ablation: review)');
    expect(out).not.toContain('APPROVED');
  });

  it('renders a state_restored boundary in the timeline, positioned by ts (epic Shreni-beads-ius)', () => {
    const boundary: LedgerEntry = {
      ts: '2026-09-16T00:00:02.000Z', schemaVersion: 1, kshetra: 'myapp', beadId: '',
      kind: 'state_restored',
      payload: { snapshotId: 'snap:abc', archivePath: '/arch/x', clean: true, beadCount: 2, memoryCount: 1 },
    };
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'closed', type: 'task', priority: null, criteria: '' },
      [
        entry('task_claimed', '2026-09-16T00:00:01.000Z', { title: 'X' }),
        entry('merge_done', '2026-09-16T00:00:03.000Z', { mergePolicy: 'push' }),
      ],
      new Map(),
      [boundary],
    );
    expect(out).toContain('state restored from snapshot snap:abc');
    expect(out).toContain('entries above predate this');
    expect(out).toContain('per-trial feeds cleaned');
    // Boundary sits between the earlier CLAIMED and the later MERGE (ts ordering).
    expect(out.indexOf('CLAIMED')).toBeLessThan(out.indexOf('RESTORE'));
    expect(out.indexOf('RESTORE')).toBeLessThan(out.indexOf('MERGE'));
    // 3 entries: the two bead entries + the boundary.
    expect(out).toContain('Timeline (3 ledger entries):');
  });

  it('surfaces a restore boundary even when the bead itself has no other entries', () => {
    const boundary: LedgerEntry = {
      ts: '2026-09-16T00:00:02.000Z', schemaVersion: 1, kshetra: 'myapp', beadId: '',
      kind: 'state_restored',
      payload: { snapshotId: 'snap:z', archivePath: '/a', clean: false, beadCount: 0, memoryCount: 0 },
    };
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [], new Map(), [boundary],
    );
    expect(out).not.toContain('no ledger entries');
    expect(out).toContain('state restored from snapshot snap:z');
  });

  it('renders a state_frozen entry with counts', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [entry('state_frozen', '2026-09-16T00:00:05.000Z', { snapshotId: 'snap:f', beadCount: 7, memoryCount: 3, labels: {} })],
    );
    expect(out).toContain('FROZEN');
    expect(out).toContain('snapshot snap:f (7 beads, 3 memories)');
  });

  it('renders an unknown (forward-compat) kind without crashing', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [entry('future_kind' as LedgerEntry['kind'], '2026-09-16T00:00:01.000Z', { foo: 1 })],
    );
    expect(out).toContain('future_kind');
    expect(out).toContain('{"foo":1}');
  });
});

// ── lot manifest header (epic yrk / Study B2, yrk.5) ──────────────────────────

const HDR = { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' } as const;

// A worker_started manifest LedgerEntry (lot-level, beadId ''), with knobs for the
// fields the multi-lot divergence check reads.
function manifest(opts: {
  lotId: string; ts?: string; configHash?: string; commit?: string; dirty?: boolean;
  entrypoint?: string; labels?: Record<string, string>; extension?: Record<string, unknown>;
}): LedgerEntry {
  const {
    lotId, ts = '2026-09-19T07:40:31.000Z', configHash = 'sha256:9ce70da6de2623c2',
    commit = '339a18f3', dirty = false, entrypoint = 'worker',
    labels = { arm: 'A', rep: '2' },
    extension = { loaded: false, path: null, contentHash: null, overrode: [] },
  } = opts;
  return {
    ts, schemaVersion: 1, kshetra: 'myapp', beadId: '', lotId, kind: 'worker_started',
    payload: {
      entrypoint, labels,
      subject: {
        repo: { mainBranch: 'main', baseSha: 'abc123def4567890aa', clean: true },
        beads: { headSha: 'beads1234567', lastDoltCommit: 'dolt123' },
        config: {
          resolvedConfigHash: configHash, mergePolicy: null, maxRoundsPerBead: 3,
          gates: { test: 'block', lint: 'block', coverage: 'warn', diffSize: 'warn' },
          roles: { silpi: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
          budget: null,
        },
      },
      process: {
        shreni: { version: '0.1.0', commit, dirty, builtAt: '2026-09-19T00:00:00.000Z' },
        extension,
        providers: { anthropic: { bin: 'claude', version: '2.1.212 (Claude Code)' } },
        tools: { bd: { version: 'bd version 1.0.3' }, node: 'v26.4.0' },
      },
    },
  } as LedgerEntry;
}

// A timeline entry stamped with a lotId (post-B2).
function lentry(kind: LedgerEntry['kind'], ts: string, lotId: string, payload: Record<string, unknown>): LedgerEntry {
  return { ...entry(kind, ts, payload), lotId };
}

describe('renderShow — lot manifest header (yrk.5)', () => {
  it('prints one manifest header for a bead worked in a single lot', () => {
    const out = renderShow(
      HDR,
      [lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-aaaa1111', { title: 'X' })],
      new Map([['lot-aaaa1111', manifest({ lotId: 'lot-aaaa1111' })]]),
    );
    expect(out).toContain('Lot manifest:');
    expect(out).toContain('Lot lot-aaaa · 2026-09-19 07:40:31 · worker · labels: arm=A rep=2');
    expect(out).toContain('base: abc123def456 (clean)');
    expect(out).toContain('config: sha256:9ce70da6');
    expect(out).toContain('gates: test=block lint=block coverage=warn diffSize=warn');
    expect(out).toContain('models: silpi=anthropic/claude-sonnet-4-6');
    expect(out).toContain('shreni: 0.1.0@339a18f');
    expect(out).toContain('providers: anthropic=2.1.212 (Claude Code)');
    expect(out).toContain('extension: none');
    expect(out).not.toContain('changed between lots');
  });

  it('renders every lot and flags a configuration change across lots', () => {
    const out = renderShow(
      HDR,
      [
        lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-1111', { title: 'X' }),
        lentry('task_done', '2026-09-19T09:00:00.000Z', 'lot-2222', { approved: true, rounds: 2 }),
      ],
      new Map([
        ['lot-1111', manifest({ lotId: 'lot-1111', configHash: 'sha256:1111aaaa1111' })],
        ['lot-2222', manifest({ lotId: 'lot-2222', configHash: 'sha256:2222bbbb2222', ts: '2026-09-19T08:30:00.000Z' })],
      ]),
    );
    expect(out).toContain('Lot manifests:');
    expect(out).toContain('Lot lot-1111');
    expect(out).toContain('Lot lot-2222');
    expect(out).toContain('⚠ configuration changed between lots');
  });

  it('flags a Shreni build change across lots', () => {
    const out = renderShow(
      HDR,
      [
        lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-1111', { title: 'X' }),
        lentry('task_done', '2026-09-19T09:00:00.000Z', 'lot-2222', { approved: true, rounds: 1 }),
      ],
      new Map([
        ['lot-1111', manifest({ lotId: 'lot-1111', commit: 'aaaaaaa' })],
        ['lot-2222', manifest({ lotId: 'lot-2222', commit: 'bbbbbbb', ts: '2026-09-19T08:30:00.000Z' })],
      ]),
    );
    expect(out).toContain('⚠ Shreni build changed between lots');
  });

  it('renders an unknown-lot header for pre-B2 entries with no lotId, timeline intact', () => {
    const out = renderShow(HDR, [entry('task_claimed', '2026-09-16T00:00:01.000Z', { title: 'X' })], new Map());
    expect(out).toContain('Lot (unknown) — no manifest (pre-B2 history)');
    expect(out).toContain('CLAIMED'); // timeline unchanged
  });

  it('notes a lotId whose worker_started manifest is missing', () => {
    const out = renderShow(
      HDR,
      [lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-orphan', { title: 'X' })],
      new Map(), // no manifest for lot-orphan
    );
    expect(out).toContain('Lot lot-orph — no manifest recorded for this lot');
  });

  it('renders a loaded extension with its path, hash, and overridden seams', () => {
    const out = renderShow(
      HDR,
      [lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-ext', { title: 'X' })],
      new Map([['lot-ext', manifest({
        lotId: 'lot-ext',
        extension: { loaded: true, path: '/x/node_modules/@shreni/cloud/index.js', contentHash: 'sha256:abcd1234 effff', overrode: ['policySource', 'eventSink'] },
      })]]),
    );
    expect(out).toContain('extension: /x/node_modules/@shreni/cloud/index.js sha256:abcd1234 overrode policySource,eventSink');
  });

  it('produces stable output (snapshot) for a single-lot bead', () => {
    const out = renderShow(
      HDR,
      [lentry('task_claimed', '2026-09-19T07:41:00.000Z', 'lot-aaaa1111', { title: 'X' })],
      new Map([['lot-aaaa1111', manifest({ lotId: 'lot-aaaa1111' })]]),
    );
    expect(out).toMatchInlineSnapshot(`
      "Bead b1 — X
      Status: open · Type: task

      Lot manifest:
        Lot lot-aaaa · 2026-09-19 07:40:31 · worker · labels: arm=A rep=2
          base: abc123def456 (clean)   config: sha256:9ce70da6   gates: test=block lint=block coverage=warn diffSize=warn
          models: silpi=anthropic/claude-sonnet-4-6
          shreni: 0.1.0@339a18f   providers: anthropic=2.1.212 (Claude Code)   bd: bd version 1.0.3   node: v26.4.0
          extension: none

      Timeline (1 ledger entry):
        2026-09-19 07:41:00  CLAIMED   X"
    `);
  });
});

describe('runShow', () => {
  it('joins bd metadata and ledger entries in timestamp order', async () => {
    mockShow.mockResolvedValue(BEAD_JSON);
    // Written out of order — runShow must sort by ts.
    writeLedger(
      entry('merge_done', '2026-09-16T00:00:04.000Z', { mergePolicy: 'push', sha: 'abc123abc123' }),
      entry('task_claimed', '2026-09-16T00:00:01.000Z', { title: 'Fix auth' }),
      entry('run_usage', '2026-09-16T00:00:02.000Z', { agent: 'silpi', inputTokens: 100, outputTokens: 20, costUsd: 0.12, priced: true, outcome: 'ok' }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runShow({ args: ['b1', '@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();

    expect(printed).toContain('Bead b1 — Fix auth');
    expect(printed).toContain('Timeline (3 ledger entries)');
    // Chronological despite the file being out of order.
    expect(printed.indexOf('CLAIMED')).toBeLessThan(printed.indexOf('USAGE'));
    expect(printed.indexOf('USAGE')).toBeLessThan(printed.indexOf('MERGE'));
  });

  it('reads the lot manifest from the real ledger and renders it above the timeline (yrk.5)', async () => {
    mockShow.mockResolvedValue(BEAD_JSON);
    // A real ledger with a lot-level worker_started (beadId '') plus a bead entry
    // stamped with that lotId — the full file → parse → readLedger → render chain.
    writeLedger(
      manifest({ lotId: 'lot-real-1234' }),
      lentry('task_claimed', '2026-09-16T00:00:01.000Z', 'lot-real-1234', { title: 'Fix auth' }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runShow({ args: ['b1', '@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();
    expect(printed).toContain('Lot manifest:');
    expect(printed).toContain('Lot lot-real · 2026-09-19 07:40:31 · worker · labels: arm=A rep=2');
    expect(printed).toContain('config: sha256:9ce70da6');
    // The worker_started (beadId '') is NOT itself listed as a bead timeline entry.
    expect(printed).toContain('Timeline (1 ledger entry)');
  });

  it('renders bd content with a no-entries line when the ledger is missing', async () => {
    mockShow.mockResolvedValue(BEAD_JSON);
    // No ledger.jsonl written.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runShow({ args: ['b1', '@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();
    expect(printed).toContain('Bead b1 — Fix auth');
    expect(printed).toContain('no ledger entries');
  });

  it('resolves a SHORT id: joins on the canonical id from the bd payload (4a2.8)', async () => {
    // User types the short id; bd resolves it and echoes the CANONICAL id.
    mockShow.mockResolvedValue(JSON.stringify([
      { id: 'Shreni-beads-4a2.6', title: 'shreni show', status: 'closed', issue_type: 'task', priority: 2 },
      { id: 'Shreni-beads-4a2.3', title: 'dep' },
    ]));
    // The ledger stores entries under the CANONICAL id.
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      [
        { ts: '2026-09-16T00:00:01.000Z', schemaVersion: 1, kshetra: 'myapp', beadId: 'Shreni-beads-4a2.6', kind: 'task_claimed', payload: { title: 'shreni show' } },
        { ts: '2026-09-16T00:00:02.000Z', schemaVersion: 1, kshetra: 'myapp', beadId: 'Shreni-beads-4a2.6', kind: 'task_done', payload: { approved: true, rounds: 1 } },
      ].map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runShow({ args: ['4a2.6', '@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    log.mockRestore();

    // Header shows the canonical id, not the typed short id, and is NOT reported missing.
    expect(printed).toContain('Bead Shreni-beads-4a2.6 — shreni show');
    // The ledger joined on the canonical id — entries are present, not "no ledger entries".
    expect(printed).toContain('Timeline (2 ledger entries)');
    expect(printed).toContain('CLAIMED');
    expect(printed).toContain('DONE');
  });

  it('fails with a clear message for an unknown bead id', async () => {
    mockShow.mockRejectedValue(new Error('issue not found: nope'));
    await expect(
      runShow({ args: ['nope', '@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] }),
    ).rejects.toThrow(/Bead not found in myapp: nope/);
  });

  it('extracts the bead id even when --kshetra precedes it (flag value is not the id)', async () => {
    mockShow.mockResolvedValue(BEAD_JSON);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // --kshetra myapp b1: the flag value "myapp" must not be taken as the bead id.
    await runShow({ args: ['--kshetra', 'myapp', 'b1'], flagKshetra: 'myapp', cwd: '/nowhere', kshetras: [kshetra] });
    log.mockRestore();
    expect(mockShow).toHaveBeenCalledWith('b1');
  });

  it('requires a bead id', async () => {
    await expect(
      runShow({ args: ['@myapp'], flagKshetra: undefined, cwd: '/nowhere', kshetras: [kshetra] }),
    ).rejects.toThrow(/Usage: shreni show/);
  });
});
