/**
 * Hermetic contract for Shreni's bd READ paths (Shreni-beads-8ym).
 *
 * Both 8ym bugs shipped green because their unit tests mocked bd with shapes the
 * real binary never produces: `bd show --json` as a bare object (bd returns an
 * array) and `bd list` with no row cap (bd returns 50 rows unless given
 * `--limit 0`). This suite seeds a throwaway workspace past that cap and drives
 * the bd wrapper, the Phalaka reader, `shreni status` assembly and
 * `shreni logs --bead` against the REAL bd binary, so drift in either contract
 * surfaces as a red test. Skips itself when bd is not on PATH.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KshetraConfig } from '../kshetra/config.js';

// `shreni logs --bead` searches the registered kshetras; register only the fixture.
const { mockLoadRegistry } = vi.hoisted(() => ({ mockLoadRegistry: vi.fn() }));
vi.mock('../kshetra/registry', () => ({ loadRegistry: mockLoadRegistry }));

import { bd } from './beads.js';
import { beadsRead } from '../phalaka/beads-read.js';
import { assembleKshetraStatus } from '../kshetra/status.js';
import { runLogs } from '../cli/logs.js';

function bdInstalled(): boolean {
  try {
    execFileSync('bd', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const BD = bdInstalled();

// vitest's process.env proxy can drop PATH on spread — re-add it (see e2e-hermetic).
// stderr is piped (not inherited) so bd's progress chatter stays out of the run.
function bdCli(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bd', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, BD_NON_INTERACTIVE: '1', ...extra },
  });
}

// More closed beads than bd list's default cap of 50. Priorities cycle 0-4, so
// bd's priority-first order puts the newest close (cap-c00, a P0) near the TOP
// and an older P4 close in the last row.
const CLOSED = 55;
const NEWEST = 'cap-c00';
const seed = Array.from({ length: CLOSED }, (_, i) => {
  const n = String(i).padStart(2, '0');
  return {
    id: `cap-c${n}`,
    title: `closed bead ${n}`,
    issue_type: 'task',
    priority: i % 5,
    status: 'closed',
    created_at: `2026-01-01T00:${n}:00Z`,
    closed_at: i === 0 ? '2026-03-01T00:00:00Z' : `2026-02-01T00:${n}:00Z`,
    ...(i === 0 ? { notes: 'Round 1: dispatching Silpi\nRound 1: APPROVE' } : {}),
  };
});

describe.skipIf(!BD)('hermetic bd read contract: real bd show/list shapes (8ym)', () => {
  let root: string;
  let beadsDir: string;
  let kshetra: KshetraConfig;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shreni-bd-read-'));
    // `bd init` must NOT carry a BEADS_DIR — it lays the workspace into cwd/.beads.
    bdCli(root, ['init', '--prefix', 'cap'], { BEADS_DIR: undefined });
    beadsDir = join(root, '.beads');
    const seedFile = join(root, 'seed.jsonl');
    writeFileSync(seedFile, seed.map(row => JSON.stringify(row)).join('\n') + '\n');
    bdCli(root, ['import', seedFile], { BEADS_DIR: beadsDir });

    kshetra = {
      id: 'bd-read-hermetic',
      name: 'bd read hermetic',
      repo: { path: root, remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
      beads: { path: beadsDir, remote: '', mode: 'embedded' },
      stack: { language: 'unknown' },
      conventions: {},
      agents: { model: 'claude-sonnet-4-6', maxRoundsPerBead: 3 },
      priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
    } as KshetraConfig;
    mockLoadRegistry.mockReturnValue([kshetra]);
  }, 120_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('precondition: bd itself still caps an unqualified `bd list`', () => {
    const capped = JSON.parse(bdCli(root, ['list', '--json', '--status', 'closed'], { BEADS_DIR: beadsDir })) as unknown[];
    expect(capped.length, 'bd no longer caps bd list by default — this suite no longer exercises the cap').toBeLessThan(CLOSED);
  }, 60_000);

  it('the bd wrapper lists every row past the cap', async () => {
    const rows = JSON.parse(await bd(kshetra).list({ status: 'closed' })) as { id: string }[];
    expect(rows).toHaveLength(CLOSED);
  }, 60_000);

  it('the Phalaka reader lists every row past the cap', async () => {
    expect(await beadsRead(kshetra).list({ status: 'closed' })).toHaveLength(CLOSED);
  }, 60_000);

  it('status reports the most recently closed bead, not the last row', async () => {
    const info = await assembleKshetraStatus(kshetra);
    expect(info.lastCompleted).toEqual({ id: NEWEST, title: 'closed bead 00' });
  }, 60_000);

  it.each([NEWEST, 'c00'])('`shreni logs --bead %s` finds the bead from the real bd show payload', async beadId => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runLogs({ beadId, all: false });
      const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('Kshetra: bd read hermetic (bd-read-hermetic)');
      expect(output).toContain(`[closed] ${NEWEST} · closed bead 00`);
      expect(output).toContain('APPROVE');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 60_000);
});

// Keep a named placeholder in the reporter so a skipped suite is never silent.
describe.skipIf(BD)('hermetic bd read contract (skipped — bd not on PATH)', () => {
  it.skip('requires the bd binary; install @beads/bd to run it', () => {
    /* skipped: bd not installed */
  });
});
