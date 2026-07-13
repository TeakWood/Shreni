import type { LoggedEvent } from '../sthapathi/activity-log.js';

// Pack certification assertions (ARD §3.4). The harness (scripts/certify-pack.ts)
// scaffolds a Kshetra from a pack's reference/ fixture, runs the worker over the
// fixture backlog, and then feeds the activity log + bd output through these
// checks. Pure functions over parsed data so the certification criteria are
// unit-testable without a live run.

export interface CertFailure {
  check: string;
  beadId?: string;
  detail: string;
}

// activity.jsonl → events. Malformed lines are skipped, not fatal: the log is
// append-only and a torn final line must not fail an otherwise green run.
export function parseActivityLog(content: string): LoggedEvent[] {
  const events: LoggedEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LoggedEvent);
    } catch {
      // torn/partial line
    }
  }
  return events;
}

// Every certified bead must have completed approved AND its final round's
// silpi_done must show the test and lint gates green — "gates actually
// executed" is read from the log, not inferred from the merge.
export function checkBeadOutcomes(events: LoggedEvent[], beadIds: string[]): CertFailure[] {
  const failures: CertFailure[] = [];
  for (const beadId of beadIds) {
    const done = events.find(e => e.type === 'task_done' && e.beadId === beadId);
    if (!done || done.type !== 'task_done') {
      failures.push({ check: 'merged', beadId, detail: 'no task_done event — bead never completed' });
      continue;
    }
    if (!done.approved) {
      failures.push({ check: 'merged', beadId, detail: 'task_done recorded approved: false' });
    }
    const silpiDones = events.filter(e => e.type === 'silpi_done' && e.beadId === beadId);
    const last = silpiDones[silpiDones.length - 1];
    if (!last || last.type !== 'silpi_done') {
      failures.push({ check: 'gates', beadId, detail: 'no silpi_done event — gates never ran' });
      continue;
    }
    if (!last.testsPassed) {
      failures.push({ check: 'gates', beadId, detail: 'final silpi_done has testsPassed: false' });
    }
    if (!last.lintPassed) {
      failures.push({ check: 'gates', beadId, detail: 'final silpi_done has lintPassed: false' });
    }
  }
  return failures;
}

// The build gate runs inside Viharapala (the reviewer executes the resolved
// buildCommand), so it surfaces as an agent_tool_call whose detail carries the
// command. An explicitly skipped build gate ("") asserts nothing — that is the
// pack's declared, visible decision (e.g. python-fastapi, Toolchain OQ3).
export function checkBuildGateObserved(events: LoggedEvent[], buildCommand: string): CertFailure[] {
  const cmd = buildCommand.trim();
  if (!cmd) return [];
  const seen = events.some(
    e => e.type === 'agent_tool_call' && e.detail.includes(cmd),
  );
  return seen
    ? []
    : [{ check: 'build-gate', detail: `no agent_tool_call detail contains the build command "${cmd}"` }];
}

// The certification requires at least one scripted reviewer rejection in the
// backlog (the fixture's reviewer-bait bead), proving Viharapala holds a line.
export function checkReviewerRejectionObserved(events: LoggedEvent[]): CertFailure[] {
  const rejected = events.some(e => e.type === 'viharapala_done' && e.verdict === 'REJECT');
  return rejected
    ? []
    : [{ check: 'reviewer-rejection', detail: 'no viharapala_done REJECT observed — the reviewer-bait bead never tripped' }];
}

// Parikshaka's static walk is logged as a parikshaka agent_text listing the
// discovered files; every expected fixture test file must appear in one.
export function checkParikshakaDiscovery(events: LoggedEvent[], expectedTestFiles: string[]): CertFailure[] {
  if (expectedTestFiles.length === 0) {
    return [{ check: 'parikshaka-discovery', detail: 'fixture has no test files matching the pack globs — nothing to certify discovery against' }];
  }
  const texts = events
    .filter(e => e.type === 'agent_text' && e.agent === 'parikshaka')
    .map(e => (e.type === 'agent_text' ? e.text : ''));
  if (texts.length === 0) {
    return [{ check: 'parikshaka-discovery', detail: 'no parikshaka agent_text event — dispatch never ran' }];
  }
  const failures: CertFailure[] = [];
  for (const file of expectedTestFiles) {
    if (!texts.some(t => t.includes(file))) {
      failures.push({ check: 'parikshaka-discovery', detail: `test file "${file}" not listed in any parikshaka discovery event` });
    }
  }
  return failures;
}

// `bd list` renders one issue per line as "<status-symbol> <id> ● P<n> …".
// Extract the ids so the harness can snapshot the fixture backlog after
// backlog.sh files it.
export function parseBeadIds(bdListOutput: string): string[] {
  const ids: string[] = [];
  for (const line of bdListOutput.split('\n')) {
    const m = /^[○◐●✓❄]\s+([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.trim());
    if (m) ids.push(m[1]);
  }
  return ids;
}

// `bd show <id>` renders "… [● P1 · OPEN]" — extract the status token so the
// harness can poll for backlog completion.
export function parseBeadStatus(bdShowOutput: string): string | null {
  const m = /·\s*(OPEN|IN_PROGRESS|CLOSED|BLOCKED|DEFERRED)\s*\]/i.exec(bdShowOutput);
  return m ? m[1].toUpperCase() : null;
}
