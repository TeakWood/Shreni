import { describe, it, expect, vi, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KshetraConfig } from '../kshetra/config';
import type { Task } from '../sthapathi/types';

// End-to-end (Shreni-beads-nhw): `shreni run` used to build its own scheduler and
// so merged work with NO ledger trail, no persisted phase and no heartbeat. It is
// now `drain --max-cycles 1` over the real worker runtime. This test drives BOTH
// paths through the real runtime (createWorkerRuntime → ledger sink, onPhase →
// state.json, heartbeat) and the real activity log, writing a REAL ledger.jsonl.
// Only the leaves that would touch git, bd, agents or the network are stubbed.

function kshetra(id: string): KshetraConfig {
  return {
    id, name: id,
    repo: { path: `/p/${id}`, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
    beads: { path: mkdtempSync(join(tmpdir(), `shreni-e2e-${id}-`)), remote: '', mode: 'embedded' },
    stack: { language: 'typescript' }, conventions: {},
    agents: { model: 'm', maxRoundsPerBead: 3 },
    priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
  };
}
const K_RUN = kshetra('e2e-run');
const K_DRAIN = kshetra('e2e-drain');

vi.mock('../kshetra/registry', () => ({ loadRegistry: () => [K_RUN, K_DRAIN] }));
vi.mock('./provider-preflight', () => ({ findRoleCredentialGaps: () => [] }));
vi.mock('../ext/loader', () => ({ loadExtension: async () => false, DEFAULT_EXT_MODULE: 'shreni-ext' }));
vi.mock('../sthapathi/lot-manifest', () => ({
  collectLotManifest: async () => ({ subject: {}, process: {} }),
}));
vi.mock('../sthapathi/recover', () => ({ recoverKshetra: async () => [], scheduleResume: async () => {} }));
vi.mock('../sthapathi/repo-map-migration', () => ({ untrackCommittedRepoMap: async () => false }));
vi.mock('../sthapathi/watchdog', () => ({ runWatchdogOnce: async () => {} }));
vi.mock('../sthapathi/merge', () => ({ reconcilePullRequests: async () => {} }));
vi.mock('../sthapathi/pr-followup', () => ({ selectFollowup: async () => null }));
vi.mock('../sthapathi/beads', () => ({
  syncBeads: async () => {},
  // Every bead is closed by the time the exit sequence asks → 'complete'.
  bd: () => ({ list: async () => '[]', ready: async () => '[]', children: async () => '[]' }),
}));

// One ready bead per kshetra. prepareTask claims it (as the real one does, by
// emitting task_claimed); the "agent loop" merges it and records what
// `shreni status` would read from state.json at that moment.
const served = new Set<string>();
vi.mock('../sthapathi/pickup', async importOriginal => ({
  ...(await importOriginal<typeof import('../sthapathi/pickup')>()),
  selectNext: async (k: KshetraConfig): Promise<Task | null> =>
    served.has(k.id) ? null : { id: `${k.id}-b1`, title: 'the bead', priority: 2 } as Task,
  prepareTask: async (t: Task, k: KshetraConfig): Promise<Task> => {
    served.add(k.id);
    const { emit } = await import('../sthapathi/activity-log');
    emit({ type: 'task_claimed', kshetra: k.id, beadId: t.id, title: t.title });
    return t;
  },
}));

const persistedDuringWork = new Map<string, { statePhase: unknown; lastActivityTo: unknown }>();
vi.mock('../sthapathi/dispatch', () => ({
  runSilpiViharapalaLoop: async (k: KshetraConfig, t: Task) => {
    const { loadState } = await import('../kshetra/state');
    const { logPath, emit } = await import('../sthapathi/activity-log');
    persistedDuringWork.set(k.id, {
      statePhase: loadState().kshetras[k.id]?.phase,
      lastActivityTo: phaseEvents(readFileSync(logPath(k.id), 'utf8')).at(-1)?.to,
    });
    emit({ type: 'task_done', kshetra: k.id, beadId: t.id, title: t.title, approved: true, rounds: 1 });
    return { approved: true, note: 'merged' };
  },
}));

function lines(raw: string): Record<string, unknown>[] {
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
}
function phaseEvents(raw: string): Record<string, unknown>[] {
  return lines(raw).filter(e => e.type === 'phase_changed');
}

const { runDrain } = await import('./drain');
const { parseLedgerLines } = await import('../ext/ledger');
const { logPath, heartbeatPath } = await import('../sthapathi/activity-log');
const { loadState } = await import('../kshetra/state');
const { computeMetrics } = await import('../sthapathi/metrics');

const noDelay = async (): Promise<void> => {};
let runResult: Awaited<ReturnType<typeof runDrain>>;
let drainResult: Awaited<ReturnType<typeof runDrain>>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Exactly what `shreni run --kshetra e2e-run` now does, vs. a plain drain.
  runResult = await runDrain(K_RUN.id, { maxCycles: 1, entrypoint: 'run', intervalMs: 1 }, undefined, noDelay);
  drainResult = await runDrain(K_DRAIN.id, { intervalMs: 1 }, undefined, noDelay);
});

const ledger = (k: KshetraConfig) => parseLedgerLines(readFileSync(join(k.beads.path, 'ledger.jsonl'), 'utf8'));

describe('shreni run through the real worker runtime (end-to-end)', () => {
  it('works the bead and exits through drain\'s exit sequence', () => {
    expect(runResult).toMatchObject({ exitCode: 0, reason: 'complete', maxCycles: 1 });
    expect(drainResult).toMatchObject({ exitCode: 0, reason: 'complete', maxCycles: null });
  });

  it('writes the same decision-grade ledger entries as the same task under drain', () => {
    const runKinds = ledger(K_RUN).map(e => e.kind);
    const drainKinds = ledger(K_DRAIN).map(e => e.kind);
    expect(runKinds).toEqual(['worker_started', 'task_claimed', 'task_done', 'drain_finished']);
    expect(runKinds).toEqual(drainKinds);
    // Every entry joins back to the lot's manifest.
    const lot = ledger(K_RUN)[0].lotId;
    expect(lot).toBeTruthy();
    expect(ledger(K_RUN).every(e => e.lotId === lot)).toBe(true);
    // The two differ only in their stated provenance.
    expect(ledger(K_RUN)[0].payload.entrypoint).toBe('run');
    expect(ledger(K_DRAIN)[0].payload.entrypoint).toBe('drain');
    expect(ledger(K_RUN).at(-1)!.payload).toMatchObject({ reason: 'complete', exitCode: 0, maxCycles: 1 });
    expect(ledger(K_DRAIN).at(-1)!.payload).not.toHaveProperty('maxCycles');
  });

  it('persists phase to state.json in step with the phase_changed events in activity.jsonl', () => {
    // Mid-task: state.json says WORKING and so does the latest activity event.
    expect(persistedDuringWork.get(K_RUN.id)).toEqual({ statePhase: 'WORKING', lastActivityTo: 'WORKING' });
    // After the cycle: both feeds agree the kshetra is back to IDLE.
    const events = phaseEvents(readFileSync(logPath(K_RUN.id), 'utf8')).filter(e => e.polls === undefined);
    expect(events.map(e => e.to)).toEqual(['SELECTING', 'PREPARING', 'WORKING', 'IDLE']);
    expect(loadState().kshetras[K_RUN.id]?.phase).toBe(events.at(-1)!.to);
  });

  it('stamps the worker heartbeat', () => {
    expect(existsSync(heartbeatPath(K_RUN.id))).toBe(true);
  });

  it("readers still parse worker_started with entrypoint 'run'", () => {
    const events = lines(readFileSync(logPath(K_RUN.id), 'utf8')) as never;
    const metrics = computeMetrics({ events });
    expect(metrics.lots.map(l => l.entrypoint)).toEqual(['run']);
    expect(metrics.drains).toEqual([expect.objectContaining({ reason: 'complete', exitCode: 0 })]);
  });
});
