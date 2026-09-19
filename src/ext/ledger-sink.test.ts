import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeLedgerSink } from './ledger-sink.js';
import { SinkRegistry } from './sink-registry.js';
import { parseLedgerLines } from './ledger.js';
import type { EventSink } from './types.js';
import type { LoggedEvent } from '../sthapathi/activity-log.js';

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-sink-'));
  ledgerPath = join(dir, 'beads', 'ledger.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fully-stamped LoggedEvent.
function ev(e: Partial<LoggedEvent> & { type: LoggedEvent['type'] }): LoggedEvent {
  return { ts: '2026-09-16T00:00:00.000Z', schemaVersion: 1, kshetra: 'k1', ...e } as LoggedEvent;
}

describe('makeLedgerSink', () => {
  it('appends decision-grade events as one JSON object per line to the beads repo path', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({ type: 'task_claimed', beadId: 'b1', title: 't', runId: 'r1' } as LoggedEvent));
    sink.handle(ev({ type: 'merge_done', beadId: 'b1', mergePolicy: 'push', sha: 'abc', runId: 'r1' } as LoggedEvent));

    const entries = parseLedgerLines(readFileSync(ledgerPath, 'utf8'));
    expect(entries.map(e => e.kind)).toEqual(['task_claimed', 'merge_done']);
    expect(entries[0]).toMatchObject({ kshetra: 'k1', beadId: 'b1', runId: 'r1', payload: { title: 't' } });
    expect(entries[1].payload).toEqual({ mergePolicy: 'push', sha: 'abc' });
  });

  it('folds a decision-grade context_compacted event into ledger.jsonl (epic 408/A1)', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({
      type: 'context_compacted', beadId: 'b1', agent: 'silpi', provider: 'claude',
      model: 'claude-opus-4-8', trigger: 'auto', preTokens: 187000, turnIndex: 12, runId: 'r1',
    } as LoggedEvent));
    const entries = parseLedgerLines(readFileSync(ledgerPath, 'utf8'));
    expect(entries.map(e => e.kind)).toEqual(['context_compacted']);
    expect(entries[0].payload).toEqual({ agent: 'silpi', provider: 'claude', model: 'claude-opus-4-8', trigger: 'auto', preTokens: 187000, turnIndex: 12 });
  });

  it('folds the lot manifest worker_started into ledger.jsonl, lotId lifted, beadId "" (epic yrk)', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({
      type: 'worker_started', lotId: 'lot-1', entrypoint: 'worker',
      subject: {}, process: {}, labels: { arm: 'A' },
    } as unknown as LoggedEvent));
    const entries = parseLedgerLines(readFileSync(ledgerPath, 'utf8'));
    expect(entries.map(e => e.kind)).toEqual(['worker_started']);
    expect(entries[0]).toMatchObject({ kshetra: 'k1', beadId: '', lotId: 'lot-1' });
    expect(entries[0].payload).toEqual({ entrypoint: 'worker', subject: {}, process: {}, labels: { arm: 'A' } });
  });

  it('drops the run-log tier turn_usage — it stays local, out of git (epic 408/A1)', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({
      type: 'turn_usage', beadId: 'b1', agent: 'silpi', provider: 'claude', model: 'claude-opus-4-8',
      turnIndex: 0, messageId: 'm0', inputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, sidechain: false,
    } as LoggedEvent));
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('drops phase_changed run-log — never reaches the git-tracked ledger (epic hto)', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({ type: 'phase_changed', from: 'IDLE', to: 'SELECTING', heldMs: 30000, polls: 5 } as unknown as LoggedEvent));
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('drops the high-volume run-log tier (agent_text / agent_tool_call)', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({ type: 'agent_text', beadId: 'b1', agent: 'silpi', text: 'hi' } as LoggedEvent));
    sink.handle(ev({ type: 'agent_tool_call', beadId: 'b1', agent: 'silpi', tool: 'Read', detail: 'x' } as LoggedEvent));
    // Not one decision-grade event arrived, so the file is never even created.
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('ignores events for a different Kshetra', () => {
    const sink = makeLedgerSink({ kshetraId: 'k1', ledgerPath });
    sink.handle(ev({ type: 'task_claimed', kshetra: 'other', beadId: 'b9', title: 't' } as LoggedEvent));
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('a throwing ledgerSink never prevents localFileSink from receiving the event', () => {
    // Force the ledger write to throw: put a FILE where the sink expects a parent
    // directory, so mkdirSync(dirname)/appendFileSync fail (ENOTDIR).
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const bad = makeLedgerSink({ kshetraId: 'k1', ledgerPath: join(asFile, 'ledger.jsonl') });

    const seen: LoggedEvent[] = [];
    const localStub: EventSink = { name: 'local-file', handle: e => { seen.push(e); } };

    // ledgerSink first, localFileSink stub second — the throw must not stop the stub.
    const reg = new SinkRegistry([bad, localStub]);
    vi.spyOn(console, 'error').mockImplementation(() => {}); // silence the isolated-sink report
    expect(() => reg.handle(ev({ type: 'task_done', beadId: 'b1', title: 't' } as LoggedEvent))).not.toThrow();
    vi.restoreAllMocks();

    expect(seen.map(e => e.type)).toEqual(['task_done']);
  });
});
