// Single-file Phalaka dashboard frontend, inlined as a TS string (no bundler,
// no framework). Tailwind via CDN, vanilla JS.
//
// Pure helpers below are exported real functions so they can be unit-tested in
// node, then serialized into the page via `.toString()` (see HELPERS). The
// DOM/fetch bootstrap stays as a string at the bottom of the document.

// Attach the shared token to every API path (read from location.search by the page).
export function apiUrl(path: string, token: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'token=' + encodeURIComponent(token);
}

// Active states are shown by default; closed sits behind the filter toggle.
export function isActiveStatus(status: string): boolean {
  return status === 'open' || status === 'in_progress' || status === 'blocked';
}

export function priorityLabel(priority: number): string {
  return 'P' + String(priority);
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-sky-700 text-sky-100';
    case 'in_progress':
      return 'bg-amber-700 text-amber-100';
    case 'blocked':
      return 'bg-red-800 text-red-100';
    case 'closed':
      return 'bg-slate-600 text-slate-200';
    case 'deferred':
      return 'bg-slate-700 text-slate-400';
    default:
      return 'bg-slate-700 text-slate-300';
  }
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render one collapsed task row. Carries data-* hooks the bootstrap uses to
// lazy-load detail on click. Returns an HTML string.
export function renderTaskRow(task: {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
}): string {
  const badge =
    '<span class="px-2 py-0.5 rounded text-xs font-medium ' +
    statusBadgeClass(task.status) +
    '">' +
    escapeHtml(task.status) +
    '</span>';
  const prio = '<span class="text-xs text-slate-400">' + escapeHtml(priorityLabel(task.priority)) + '</span>';
  const who = task.assignee ? '<span class="text-xs text-slate-500">' + escapeHtml(task.assignee) + '</span>' : '';
  return (
    '<div class="task-row border-b border-slate-800" data-bead-id="' +
    escapeHtml(task.id) +
    '">' +
    '<div class="task-head flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-800">' +
    badge +
    prio +
    '<span class="flex-1 text-sm text-slate-200">' +
    escapeHtml(task.title) +
    '</span>' +
    '<span class="text-xs text-slate-600 font-mono">' +
    escapeHtml(task.id) +
    '</span>' +
    who +
    '</div>' +
    '<div class="task-detail hidden px-4 py-3 bg-slate-900 text-sm text-slate-300"></div>' +
    '</div>'
  );
}

const HELPERS = [apiUrl, isActiveStatus, priorityLabel, statusBadgeClass, escapeHtml, renderTaskRow]
  .map(f => f.toString())
  .join('\n\n');

// Bootstrap script — runs in the browser. Written with string concatenation
// (no template literals) so its source survives this outer template literal.
const BOOTSTRAP = `
  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var POLL_MS = 10000;
  var showClosed = false;
  var expanded = null; // currently expanded bead id

  function api(path) {
    return fetch(apiUrl(path, TOKEN)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function renderDetail(el, d) {
    var rows = [];
    function row(label, val) {
      if (val === undefined || val === null || val === '') return;
      rows.push('<div class="mb-2"><div class="text-xs uppercase text-slate-500">' + escapeHtml(label) +
        '</div><div class="whitespace-pre-wrap">' + escapeHtml(String(val)) + '</div></div>');
    }
    row('Description', d.description);
    row('Acceptance', d.acceptance);
    row('Design', d.design);
    row('Notes', d.notes);
    row('Assignee', d.assignee);
    row('Parent', d.parent);
    if (d.blockedBy && d.blockedBy.length) row('Blocked by', d.blockedBy.join(', '));
    row('Created', d.createdAt);
    row('Updated', d.updatedAt);
    el.innerHTML = rows.join('') || '<span class="text-slate-500">No details.</span>';
  }

  function toggleRow(kshetraId, row) {
    var beadId = row.getAttribute('data-bead-id');
    var detail = row.querySelector('.task-detail');
    var isOpen = !detail.classList.contains('hidden');
    // collapse any other open row (one at a time)
    var openRows = document.querySelectorAll('.task-detail:not(.hidden)');
    for (var i = 0; i < openRows.length; i++) openRows[i].classList.add('hidden');
    if (isOpen) { expanded = null; return; }
    expanded = beadId;
    detail.classList.remove('hidden');
    if (!detail.getAttribute('data-loaded')) {
      detail.innerHTML = '<span class="text-slate-500">Loading…</span>';
      api('/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks/' + encodeURIComponent(beadId))
        .then(function (d) { renderDetail(detail, d); detail.setAttribute('data-loaded', '1'); })
        .catch(function (e) { detail.innerHTML = '<span class="text-red-400">' + escapeHtml(e.message) + '</span>'; });
    }
  }

  function loadTasks(kshetraId, container) {
    var calls = [api('/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks')];
    if (showClosed) calls.push(api('/api/kshetras/' + encodeURIComponent(kshetraId) + '/tasks?status=closed'));
    Promise.all(calls).then(function (results) {
      var tasks = [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].tasks) tasks = tasks.concat(results[i].tasks);
      }
      if (results[0].error) {
        container.innerHTML = '<div class="px-3 py-2 text-sm text-red-400">' + escapeHtml(results[0].error) + '</div>';
        return;
      }
      container.innerHTML = tasks.map(renderTaskRow).join('') ||
        '<div class="px-3 py-2 text-sm text-slate-500">No tasks.</div>';
      var rows = container.querySelectorAll('.task-row');
      for (var j = 0; j < rows.length; j++) {
        (function (row) {
          row.querySelector('.task-head').addEventListener('click', function () { toggleRow(kshetraId, row); });
        })(rows[j]);
      }
    }).catch(function (e) {
      container.innerHTML = '<div class="px-3 py-2 text-sm text-red-400">' + escapeHtml(e.message) + '</div>';
    });
  }

  function countsLine(c) {
    if (!c) return '';
    return '<span class="text-xs text-slate-400">' +
      c.open + ' open · ' + c.in_progress + ' active · ' + c.blocked + ' blocked · ' + c.closed + ' closed</span>';
  }

  function loadBoard() {
    api('/api/kshetras').then(function (kshetras) {
      var board = document.getElementById('board');
      board.innerHTML = '';
      kshetras.forEach(function (k) {
        var section = document.createElement('section');
        section.className = 'mb-6 rounded border border-slate-800 overflow-hidden';
        var statusChip = k.paused
          ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-900 text-amber-300">paused</span>'
          : (k.phase ? '<span class="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">' + escapeHtml(k.phase) + '</span>' : '');
        var head = '<div class="flex items-center gap-3 px-3 py-2 bg-slate-800">' +
          '<h2 class="text-sm font-semibold text-slate-100">' + escapeHtml(k.name) + '</h2>' +
          '<span class="text-xs text-slate-600 font-mono">' + escapeHtml(k.id) + '</span>' +
          statusChip +
          (k.error ? '<span class="text-xs text-red-400">' + escapeHtml(k.error) + '</span>' : countsLine(k.counts)) +
          '</div>';
        var stuckBanner = k.stuck
          ? '<div class="px-3 py-2 bg-red-950 border-t border-red-800 text-xs text-red-200">' +
            '<div class="font-semibold">⚠️ STUCK — ' + escapeHtml(k.stuck.reason) + '</div>' +
            '<pre class="mt-1 whitespace-pre-wrap text-red-300/80">Try:\\n' + escapeHtml(k.stuck.remediation) + '</pre>' +
            '</div>'
          : '';
        section.innerHTML = head + stuckBanner + '<div class="tasks" data-kshetra="' + escapeHtml(k.id) + '"></div>';
        board.appendChild(section);
        loadTasks(k.id, section.querySelector('.tasks'));
      });
    }).catch(function (e) {
      document.getElementById('board').innerHTML =
        '<div class="text-red-400 text-sm">' + escapeHtml(e.message) + '</div>';
    });
  }

  document.getElementById('closed-toggle').addEventListener('change', function (e) {
    showClosed = e.target.checked;
    loadBoard();
  });

  loadBoard();
  setInterval(loadBoard, POLL_MS);
`;

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Phalaka — Task Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; }
  </style>
</head>
<body class="min-h-screen">
  <header class="flex items-center gap-4 px-4 py-3 bg-slate-900 border-b border-slate-700">
    <h1 class="text-lg font-semibold text-slate-100">Phalaka</h1>
    <span class="text-xs text-slate-500">per-Kshetra task board</span>
    <label class="ml-auto flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
      <input id="closed-toggle" type="checkbox" class="accent-slate-500" />
      Show closed
    </label>
  </header>
  <main id="board" class="px-4 py-4 max-w-4xl mx-auto"></main>
  <script>
${HELPERS}

${BOOTSTRAP}
  </script>
</body>
</html>`;