import { describe, it, expect } from 'vitest';
import {
  INDEX_HTML,
  apiUrl,
  isActiveStatus,
  priorityLabel,
  statusBadgeClass,
  escapeHtml,
  renderTaskRow,
  processKey,
  processStatusPillClass,
  formatAge,
  processLabel,
  renderProcessRow,
  triageSeverityRank,
  triageSeverityClass,
  triageEntryForProcess,
  triageEntryForKshetra,
  collectTriageEntries,
  renderTriageEntry,
  renderTriageFeed,
} from './ui.js';

describe('apiUrl', () => {
  it('appends the token as a query param', () => {
    expect(apiUrl('/api/kshetras', 'abc')).toBe('/api/kshetras?token=abc');
  });

  it('uses & when the path already has a query string', () => {
    expect(apiUrl('/api/kshetras/k/tasks?status=closed', 'abc')).toBe(
      '/api/kshetras/k/tasks?status=closed&token=abc',
    );
  });

  it('url-encodes the token', () => {
    expect(apiUrl('/x', 'a b/c')).toBe('/x?token=a%20b%2Fc');
  });
});

describe('isActiveStatus', () => {
  it('treats open/in_progress/blocked as active', () => {
    expect(isActiveStatus('open')).toBe(true);
    expect(isActiveStatus('in_progress')).toBe(true);
    expect(isActiveStatus('blocked')).toBe(true);
  });
  it('treats closed/deferred as inactive', () => {
    expect(isActiveStatus('closed')).toBe(false);
    expect(isActiveStatus('deferred')).toBe(false);
  });
});

describe('priorityLabel', () => {
  it('formats as P<n>', () => {
    expect(priorityLabel(0)).toBe('P0');
    expect(priorityLabel(2)).toBe('P2');
  });
});

describe('statusBadgeClass', () => {
  it('returns distinct classes per known status and a fallback', () => {
    expect(statusBadgeClass('open')).not.toBe(statusBadgeClass('blocked'));
    expect(statusBadgeClass('closed')).toContain('slate');
    expect(statusBadgeClass('weird')).toContain('slate');
  });
});

describe('escapeHtml', () => {
  it('escapes HTML-significant characters (no injection)', () => {
    expect(escapeHtml('<script>"&\'')).toBe('&lt;script&gt;&quot;&amp;&#39;');
  });
});

describe('renderTaskRow', () => {
  const task = { id: 'proj-1', title: 'Build <thing>', status: 'open', priority: 1, type: 'feature', assignee: 'dev' };

  it('renders id, title (escaped), status badge and a collapsible detail panel', () => {
    const html = renderTaskRow(task);
    expect(html).toContain('data-bead-id="proj-1"');
    expect(html).toContain('Build &lt;thing&gt;'); // title escaped
    expect(html).toContain('task-detail hidden'); // collapsed by default
    expect(html).toContain('P1');
    expect(html).toContain('dev');
  });

  it('omits the assignee span when absent', () => {
    const html = renderTaskRow({ ...task, assignee: undefined });
    expect(html).toContain('data-bead-id="proj-1"');
  });
});

describe('INDEX_HTML wiring (structural)', () => {
  it('inlines the pure helpers so the page can call them', () => {
    expect(INDEX_HTML).toContain('function apiUrl');
    expect(INDEX_HTML).toContain('function renderTaskRow');
    expect(INDEX_HTML).toContain('function escapeHtml');
  });

  it('serves a syntactically valid inline bootstrap script', () => {
    // Extract the parameterless inline <script> body (the CDN script uses
    // <script src=...> so it is not matched). new Function parses without
    // executing — a literal newline inside a '...' string (e.g. an unescaped
    // 'Try:\n') throws SyntaxError here, which would kill the whole board.
    const open = INDEX_HTML.indexOf('<script>');
    const body = INDEX_HTML.slice(open + '<script>'.length, INDEX_HTML.indexOf('</script>', open));
    expect(open).toBeGreaterThan(-1);
    expect(() => new Function(body)).not.toThrow();
  });

  it('reads the token from location.search and attaches it via apiUrl on every fetch', () => {
    expect(INDEX_HTML).toContain("new URLSearchParams(location.search).get('token')");
    expect(INDEX_HTML).toContain('fetch(apiUrl(path, TOKEN))');
  });

  it('hits all three data routes', () => {
    expect(INDEX_HTML).toContain("api('/api/kshetras')");
    expect(INDEX_HTML).toContain("'/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks'");
    expect(INDEX_HTML).toContain("/tasks/' + encodeURIComponent(beadId)");
  });

  it('lazy-loads detail on row click (accordion, one at a time)', () => {
    expect(INDEX_HTML).toContain('function toggleRow');
    expect(INDEX_HTML).toContain(".task-detail:not(.hidden)");
    expect(INDEX_HTML).toContain("addEventListener('click'");
  });

  it('has a closed-filter toggle that re-renders the board', () => {
    expect(INDEX_HTML).toContain('id="closed-toggle"');
    expect(INDEX_HTML).toContain("getElementById('closed-toggle').addEventListener('change'");
    expect(INDEX_HTML).toContain('?status=closed');
  });

  it('drives the board off the SSE stream, not an always-on poll', () => {
    expect(INDEX_HTML).toContain('POLL_MS = 10000');
    // The board is refreshed by SSE state/activity events; the only setInterval is
    // the shared fallback poll (pollOnce), gated on the stream being down.
    expect(INDEX_HTML).not.toContain('setInterval(loadBoard');
    expect(INDEX_HTML).toContain('setInterval(pollOnce, POLL_MS)');
  });
});

describe('INDEX_HTML board ↔ SSE wiring (structural)', () => {
  it('refreshes the board on state and activity events (instant updates)', () => {
    expect(INDEX_HTML).toContain("es.addEventListener('state'");
    expect(INDEX_HTML).toContain("es.addEventListener('activity'");
    expect(INDEX_HTML).toContain('function refreshBoardSoon');
    // Both event handlers nudge the debounced board refresh.
    expect(INDEX_HTML.match(/refreshBoardSoon\(\)/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('debounces bursts of events into one board rebuild', () => {
    expect(INDEX_HTML).toContain('boardRefreshTimer');
    expect(INDEX_HTML).toContain('setTimeout(');
  });

  it('re-opens the expanded row so a live refresh does not collapse it mid-read', () => {
    expect(INDEX_HTML).toContain('function openRow');
    expect(INDEX_HTML).toContain("row.getAttribute('data-bead-id') === expanded");
  });

  it('degrades the whole page to one 10s poll when the stream is down', () => {
    expect(INDEX_HTML).toContain('function pollOnce');
    expect(INDEX_HTML).toContain('loadBoard(); loadProcesses();');
    expect(INDEX_HTML).toContain('startPoll');
    expect(INDEX_HTML).toContain('stopPoll');
  });
});

describe('processKey', () => {
  it('matches keyOf() in stream.ts: kind:kshetraId', () => {
    expect(processKey({ kind: 'worker', kshetraId: 'proj' })).toBe('worker:proj');
  });
  it('leaves the kshetra segment empty for the singleton Phalaka', () => {
    expect(processKey({ kind: 'phalaka' })).toBe('phalaka:');
  });
});

describe('processStatusPillClass', () => {
  it('greens the healthy states and reds the escalations', () => {
    expect(processStatusPillClass('working')).toContain('emerald');
    expect(processStatusPillClass('healthy')).toContain('emerald');
    expect(processStatusPillClass('stuck')).toContain('red');
    expect(processStatusPillClass('dead')).toContain('red');
  });
  it('distinguishes idle, paused and stale from one another', () => {
    const idle = processStatusPillClass('idle');
    const paused = processStatusPillClass('paused-manual');
    const stale = processStatusPillClass('stale-heartbeat');
    expect(new Set([idle, paused, stale]).size).toBe(3);
  });
  it('falls back to neutral slate for an unknown status', () => {
    expect(processStatusPillClass('weird')).toContain('slate');
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(3 * 60_000)).toBe('3m');
    expect(formatAge(2 * 3_600_000)).toBe('2h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
  it('renders a dash for a missing/invalid age', () => {
    expect(formatAge(undefined)).toBe('—');
    expect(formatAge(null)).toBe('—');
    expect(formatAge(-5)).toBe('—');
  });
});

describe('processLabel', () => {
  it('names a worker/suthradhara by its Kshetra', () => {
    expect(processLabel({ kind: 'worker', kshetraId: 'proj' })).toBe('proj');
    expect(processLabel({ kind: 'suthradhara', kshetraId: 'proj' })).toBe('proj');
  });
  it('labels the kshetra-less Phalaka singleton', () => {
    expect(processLabel({ kind: 'phalaka' })).toBe('dashboard');
  });
});

describe('renderProcessRow', () => {
  const snap = {
    kind: 'worker',
    kshetraId: 'proj',
    pid: 4321,
    status: 'working',
    phase: 'CODING',
    heartbeatAgeMs: 12_000,
    activeBead: { id: 'proj-9', title: 'Build <thing>' },
  };

  it('renders the status pill, phase, heartbeat age, pid and an upsert key', () => {
    const html = renderProcessRow(snap);
    expect(html).toContain('data-proc-key="worker:proj"');
    expect(html).toContain('working'); // status pill text
    expect(html).toContain('CODING'); // phase chip
    expect(html).toContain('12s'); // heartbeat age
    expect(html).toContain('pid 4321');
    expect(html).toContain('proj-9'); // active bead
    expect(html).toContain('Build &lt;thing&gt;'); // bead title escaped in the title attr
  });

  it('omits the heartbeat chip for a service with no heartbeat', () => {
    const html = renderProcessRow({ kind: 'phalaka', pid: 10, status: 'healthy' });
    expect(html).toContain('data-proc-key="phalaka:"');
    expect(html).toContain('pid 10');
    expect(html).not.toContain('♥');
  });
});

describe('triageSeverityRank', () => {
  it('orders stuck < dead < stale-heartbeat < blocked, unknown last', () => {
    expect(triageSeverityRank('stuck')).toBeLessThan(triageSeverityRank('dead'));
    expect(triageSeverityRank('dead')).toBeLessThan(triageSeverityRank('stale-heartbeat'));
    expect(triageSeverityRank('stale-heartbeat')).toBeLessThan(triageSeverityRank('blocked'));
    expect(triageSeverityRank('weird')).toBeGreaterThan(triageSeverityRank('blocked'));
  });
});

describe('triageSeverityClass', () => {
  it('gives each severity a distinct class and a fallback', () => {
    const classes = ['stuck', 'dead', 'stale-heartbeat', 'blocked'].map(triageSeverityClass);
    expect(new Set(classes).size).toBe(4);
    expect(triageSeverityClass('weird')).toContain('slate');
  });
});

describe('triageEntryForProcess', () => {
  it('surfaces a stuck worker with the watchdog remediation verbatim', () => {
    const e = triageEntryForProcess({
      kind: 'worker',
      kshetraId: 'proj',
      status: 'stuck',
      stuck: { reason: 'repeated 5× without progress', remediation: '  1) do the thing\n  2) shreni resume', beadId: 'proj-7' },
    });
    expect(e).not.toBeNull();
    expect(e!.severity).toBe('stuck');
    expect(e!.key).toBe('stuck:worker:proj');
    expect(e!.reason).toBe('repeated 5× without progress');
    expect(e!.remediation).toBe('  1) do the thing\n  2) shreni resume'); // verbatim
    expect(e!.beadId).toBe('proj-7');
  });

  it('falls back to a resume line when a stuck row lacks the marker payload', () => {
    const e = triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'stuck' });
    expect(e!.remediation).toBe('shreni resume --kshetra proj');
  });

  it('gives a dead process a kind-appropriate restart command', () => {
    const worker = triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'dead' });
    expect(worker!.severity).toBe('dead');
    expect(worker!.remediation).toContain('shreni start --kshetra proj');
    expect(triageEntryForProcess({ kind: 'phalaka', status: 'dead' })!.remediation).toBe('shreni phalaka start');
    expect(triageEntryForProcess({ kind: 'suthradhara', kshetraId: 'proj', status: 'dead' })!.remediation).toBe(
      'shreni suthradhara start --kshetra proj',
    );
  });

  it('surfaces a stale heartbeat with its age and an inspect command', () => {
    const e = triageEntryForProcess({
      kind: 'worker',
      kshetraId: 'proj',
      status: 'stale-heartbeat',
      phase: 'CODING',
      heartbeatAgeMs: 3 * 60_000,
    });
    expect(e!.severity).toBe('stale-heartbeat');
    expect(e!.reason).toContain('3m');
    expect(e!.reason).toContain('phase=CODING');
    expect(e!.remediation).toContain('shreni logs --kshetra proj');
  });

  it('returns null for a healthy/working/idle/paused process', () => {
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'working' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'idle' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'worker', kshetraId: 'proj', status: 'paused-manual' })).toBeNull();
    expect(triageEntryForProcess({ kind: 'phalaka', status: 'healthy' })).toBeNull();
  });
});

describe('triageEntryForKshetra', () => {
  it('emits one aggregate entry when beads are blocked', () => {
    const e = triageEntryForKshetra({ id: 'proj', name: 'Project', counts: { blocked: 3 } });
    expect(e!.severity).toBe('blocked');
    expect(e!.key).toBe('blocked:proj');
    expect(e!.label).toBe('Project');
    expect(e!.reason).toContain('3 beads blocked');
    expect(e!.remediation).toContain('bd list --status=blocked');
  });

  it('uses the singular when exactly one bead is blocked', () => {
    expect(triageEntryForKshetra({ id: 'p', counts: { blocked: 1 } })!.reason).toContain('1 bead blocked');
  });

  it('returns null when nothing is blocked or counts are absent', () => {
    expect(triageEntryForKshetra({ id: 'p', counts: { blocked: 0 } })).toBeNull();
    expect(triageEntryForKshetra({ id: 'p' })).toBeNull();
  });
});

describe('collectTriageEntries', () => {
  it('aggregates process + Kshetra items and sorts by urgency then key', () => {
    const processes = [
      { kind: 'worker', kshetraId: 'b', status: 'stale-heartbeat', phase: 'CODING', heartbeatAgeMs: 180000 },
      { kind: 'worker', kshetraId: 'a', status: 'stuck', stuck: { reason: 'hung', remediation: 'fix it', beadId: 'a-1' } },
      { kind: 'worker', kshetraId: 'c', status: 'working' }, // healthy → dropped
      { kind: 'suthradhara', kshetraId: 'd', status: 'dead' },
    ];
    const kshetras = [{ id: 'e', name: 'E', counts: { blocked: 2 } }];
    const entries = collectTriageEntries(processes, kshetras);
    expect(entries.map(e => e.severity)).toEqual(['stuck', 'dead', 'stale-heartbeat', 'blocked']);
  });

  it('returns an empty array when the whole fleet is healthy', () => {
    expect(collectTriageEntries([{ kind: 'worker', kshetraId: 'a', status: 'idle' }], [])).toEqual([]);
  });
});

describe('renderTriageEntry', () => {
  it('renders a severity pill, escaped fields and a copyable command', () => {
    const html = renderTriageEntry({
      key: 'stuck:worker:proj',
      severity: 'stuck',
      label: 'proj',
      reason: 'hung on <thing>',
      remediation: 'shreni resume --kshetra proj',
      beadId: 'proj-7',
    });
    expect(html).toContain('data-triage-key="stuck:worker:proj"');
    expect(html).toContain('hung on &lt;thing&gt;'); // reason escaped
    expect(html).toContain('proj-7');
    expect(html).toContain('data-copy="shreni resume --kshetra proj"'); // copyable
    expect(html).toContain('triage-copy');
    expect(html).toContain('<pre'); // command shown verbatim
  });
});

describe('renderTriageFeed', () => {
  it('shows a healthy empty state when nothing needs a human', () => {
    expect(renderTriageFeed([])).toContain('Nothing needs a human');
  });

  it('renders one row per entry', () => {
    const html = renderTriageFeed([
      { key: 'k1', severity: 'dead', label: 'a', reason: 'r', remediation: 'c1' },
      { key: 'k2', severity: 'blocked', label: 'b', reason: 'r', remediation: 'c2' },
    ]);
    expect(html.match(/triage-entry/g)!.length).toBe(2);
    expect(html).toContain('data-triage-key="k1"');
    expect(html).toContain('data-triage-key="k2"');
  });
});

describe('INDEX_HTML triage feed wiring (structural)', () => {
  it('renders a triage section with a count badge', () => {
    expect(INDEX_HTML).toContain('id="triage"');
    expect(INDEX_HTML).toContain('id="triage-count"');
    expect(INDEX_HTML).toContain('Needs a human');
  });

  it('inlines the triage render helpers so the page can call them', () => {
    expect(INDEX_HTML).toContain('function collectTriageEntries');
    expect(INDEX_HTML).toContain('function renderTriageFeed');
    expect(INDEX_HTML).toContain('function triageEntryForProcess');
  });

  it('recomputes triage from both process and board updates', () => {
    expect(INDEX_HTML).toContain('function renderTriage');
    expect(INDEX_HTML).toContain('lastKshetras = kshetras');
    // renderTriage is invoked from both renderProcesses and loadBoard.
    expect(INDEX_HTML.match(/renderTriage\(\)/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('wires clipboard copy via delegation on the stable container', () => {
    expect(INDEX_HTML).toContain('wireTriageCopy');
    expect(INDEX_HTML).toContain('.triage-copy');
    expect(INDEX_HTML).toContain('navigator.clipboard.writeText');
  });
});

describe('INDEX_HTML process panel wiring (structural)', () => {
  it('renders a Processes section with a live/poll status indicator', () => {
    expect(INDEX_HTML).toContain('id="processes"');
    expect(INDEX_HTML).toContain('id="stream-status"');
  });

  it('inlines the process render helpers so the page can call them', () => {
    expect(INDEX_HTML).toContain('function renderProcessRow');
    expect(INDEX_HTML).toContain('function processStatusPillClass');
    expect(INDEX_HTML).toContain('function formatAge');
  });

  it('opens one EventSource on /api/stream and upserts on process events', () => {
    expect(INDEX_HTML).toContain("new EventSource(apiUrl('/api/stream', TOKEN))");
    expect(INDEX_HTML).toContain("es.addEventListener('process'");
    expect(INDEX_HTML).toContain('upsertProcess(JSON.parse(e.data))');
  });

  it('degrades to a 10s poll when the stream is down', () => {
    expect(INDEX_HTML).toContain("es.addEventListener('error'");
    expect(INDEX_HTML).toContain('startPoll');
    expect(INDEX_HTML).toContain("api('/api/processes')");
    expect(INDEX_HTML).toContain('setInterval(pollOnce, POLL_MS)');
  });

  it('stops the fallback poll once the stream opens', () => {
    expect(INDEX_HTML).toContain("es.addEventListener('open'");
    expect(INDEX_HTML).toContain('stopPoll');
  });

  it('guards against a browser without EventSource', () => {
    expect(INDEX_HTML).toContain('if (!window.EventSource)');
  });
});