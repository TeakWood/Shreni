import { describe, it, expect } from 'vitest';
import {
  parseActivityLog,
  checkBeadOutcomes,
  checkBuildGateObserved,
  checkReviewerRejectionObserved,
  checkParikshakaDiscovery,
  parseBeadIds,
  parseBeadStatus,
} from './assertions.js';
import type { LoggedEvent } from '../sthapathi/activity-log.js';

const K = 'cert-x';
const ts = '2026-07-13T00:00:00.000Z';
const env = { ts, schemaVersion: 1 };

function greenRun(beadId: string): LoggedEvent[] {
  return [
    { type: 'task_claimed', kshetra: K, beadId, title: 't', ...env },
    { type: 'silpi_done', kshetra: K, beadId, round: 1, summary: 's', confidence: 90, files: [], lintPassed: true, testsPassed: true, ...env },
    { type: 'viharapala_done', kshetra: K, beadId, round: 1, verdict: 'APPROVE', score: 90, mustFix: [], ...env },
    { type: 'task_done', kshetra: K, beadId, title: 't', approved: true, rounds: 1, ...env },
  ];
}

describe('parseActivityLog', () => {
  it('parses one event per line and skips torn lines', () => {
    const lines = [
      JSON.stringify(greenRun('b1')[0]),
      '{"type": "task_done", "kshe', // torn final line
      '',
    ].join('\n');
    const events = parseActivityLog(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task_claimed');
  });
});

describe('checkBeadOutcomes', () => {
  it('passes a fully green bead', () => {
    expect(checkBeadOutcomes(greenRun('b1'), ['b1'])).toEqual([]);
  });

  it('fails a bead with no task_done', () => {
    const events = greenRun('b1').filter(e => e.type !== 'task_done');
    const failures = checkBeadOutcomes(events, ['b1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ check: 'merged', beadId: 'b1' });
  });

  it('fails an unapproved task_done', () => {
    const events = greenRun('b1').map(e =>
      e.type === 'task_done' ? { ...e, approved: false } : e,
    );
    expect(checkBeadOutcomes(events, ['b1'])[0].detail).toContain('approved: false');
  });

  it('reads gate results from the FINAL round (an early red round is fine)', () => {
    const redRound: LoggedEvent = {
      type: 'silpi_done', kshetra: K, beadId: 'b1', round: 1, summary: 's', confidence: 50,
      files: [], lintPassed: false, testsPassed: false, ...env,
    };
    const events = [redRound, ...greenRun('b1').map(e => ('round' in e ? { ...e, round: 2 } : e))];
    expect(checkBeadOutcomes(events, ['b1'])).toEqual([]);
  });

  it('fails when the final round has red gates', () => {
    const events = greenRun('b1').map(e =>
      e.type === 'silpi_done' ? { ...e, testsPassed: false, lintPassed: false } : e,
    );
    const failures = checkBeadOutcomes(events, ['b1']);
    expect(failures.map(f => f.detail).join(' ')).toContain('testsPassed: false');
    expect(failures.map(f => f.detail).join(' ')).toContain('lintPassed: false');
  });

  it('checks every certified bead independently', () => {
    const events = [...greenRun('b1'), ...greenRun('b2').filter(e => e.type !== 'task_done')];
    const failures = checkBeadOutcomes(events, ['b1', 'b2']);
    expect(failures).toHaveLength(1);
    expect(failures[0].beadId).toBe('b2');
  });
});

describe('checkBuildGateObserved', () => {
  const toolCall = (detail: string): LoggedEvent => ({
    type: 'agent_tool_call', kshetra: K, beadId: 'b1', agent: 'viharapala', tool: 'Bash', detail, ...env,
  });

  it('passes when a tool call carries the build command', () => {
    expect(checkBuildGateObserved([toolCall('cd /repo && pnpm build')], 'pnpm build')).toEqual([]);
  });

  it('fails when the build command was never run', () => {
    const failures = checkBuildGateObserved([toolCall('pnpm test')], 'pnpm build');
    expect(failures[0].check).toBe('build-gate');
  });

  it('asserts nothing for an explicitly skipped ("") build gate', () => {
    expect(checkBuildGateObserved([], '')).toEqual([]);
  });
});

describe('checkReviewerRejectionObserved', () => {
  it('passes when at least one REJECT verdict exists', () => {
    const reject: LoggedEvent = {
      type: 'viharapala_done', kshetra: K, beadId: 'b2', round: 1, verdict: 'REJECT', score: 30, mustFix: ['x'], ...env,
    };
    expect(checkReviewerRejectionObserved([...greenRun('b1'), reject])).toEqual([]);
  });

  it('fails an all-APPROVE run (reviewer-bait bead never tripped)', () => {
    expect(checkReviewerRejectionObserved(greenRun('b1'))[0].check).toBe('reviewer-rejection');
  });
});

describe('checkParikshakaDiscovery', () => {
  const discovery = (text: string): LoggedEvent => ({
    type: 'agent_text', kshetra: K, beadId: 'b1', agent: 'parikshaka', text, ...env,
  });

  it('passes when every expected test file is listed', () => {
    const events = [discovery('discovered 2 test file(s): src/a.test.ts, src/b.test.ts')];
    expect(checkParikshakaDiscovery(events, ['src/a.test.ts', 'src/b.test.ts'])).toEqual([]);
  });

  it('fails per missing file', () => {
    const events = [discovery('discovered 1 test file(s): src/a.test.ts')];
    const failures = checkParikshakaDiscovery(events, ['src/a.test.ts', 'src/b.test.ts']);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain('src/b.test.ts');
  });

  it('fails when parikshaka never dispatched', () => {
    expect(checkParikshakaDiscovery(greenRun('b1'), ['src/a.test.ts'])[0].detail).toContain('dispatch never ran');
  });

  it('fails a fixture with no test files (nothing to certify against)', () => {
    expect(checkParikshakaDiscovery([discovery('discovered 0 test file(s): ')], [])[0].detail).toContain('no test files');
  });

  it('ignores agent_text from other agents', () => {
    const silpiText: LoggedEvent = {
      type: 'agent_text', kshetra: K, beadId: 'b1', agent: 'silpi', text: 'src/a.test.ts', ...env,
    };
    expect(checkParikshakaDiscovery([silpiText], ['src/a.test.ts'])[0].check).toBe('parikshaka-discovery');
  });
});

describe('parseBeadIds', () => {
  it('extracts ids from bd list lines', () => {
    const out = [
      '○ chitti-abc ● P1 [feature] Add the entity',
      '◐ chitti-def.2 ● P2 Wire the route',
      '',
      '--------------------',
      'Ready: 2 issues with no active blockers',
    ].join('\n');
    expect(parseBeadIds(out)).toEqual(['chitti-abc', 'chitti-def.2']);
  });

  it('returns [] for empty output', () => {
    expect(parseBeadIds('')).toEqual([]);
  });
});

describe('parseBeadStatus', () => {
  it('extracts the status token from bd show output', () => {
    expect(parseBeadStatus('○ chitti-abc · Add the entity   [● P1 · OPEN]')).toBe('OPEN');
    expect(parseBeadStatus('✓ chitti-abc · Add the entity   [● P1 · CLOSED]')).toBe('CLOSED');
  });

  it('returns null when no status is present', () => {
    expect(parseBeadStatus('gibberish')).toBeNull();
  });
});
