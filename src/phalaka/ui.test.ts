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

  it('polls on a 10s interval', () => {
    expect(INDEX_HTML).toContain('POLL_MS = 10000');
    expect(INDEX_HTML).toContain('setInterval(loadBoard, POLL_MS)');
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

  it('degrades to a 10s /api/processes poll when the stream is down', () => {
    expect(INDEX_HTML).toContain("es.addEventListener('error'");
    expect(INDEX_HTML).toContain('startProcPoll');
    expect(INDEX_HTML).toContain("api('/api/processes')");
    expect(INDEX_HTML).toContain('setInterval(loadProcesses, POLL_MS)');
  });

  it('stops the fallback poll once the stream opens', () => {
    expect(INDEX_HTML).toContain("es.addEventListener('open'");
    expect(INDEX_HTML).toContain('stopProcPoll');
  });

  it('guards against a browser without EventSource', () => {
    expect(INDEX_HTML).toContain('if (!window.EventSource)');
  });
});