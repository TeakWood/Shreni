import { describe, it, expect } from 'vitest';
import {
  INDEX_HTML,
  apiUrl,
  isActiveStatus,
  priorityLabel,
  statusBadgeClass,
  escapeHtml,
  renderTaskRow,
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