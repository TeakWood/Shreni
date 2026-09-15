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

  it('renders a clear line when the bead has no ledger entries', () => {
    const out = renderShow(
      { id: 'b1', title: 'X', status: 'open', type: 'task', priority: null, criteria: '' },
      [],
    );
    expect(out).toContain('Timeline: no ledger entries for this bead.');
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
