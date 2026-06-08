export const MANIFEST_JSON = JSON.stringify({
  name: 'Vichara',
  short_name: 'Vichara',
  description: 'Shreni observer interface',
  start_url: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#0f172a',
  icons: [],
});

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vichara</title>
  <link rel="manifest" href="/manifest.json" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; }
    .msg-user { background: #1e3a5f; }
    .msg-assistant { background: #1e293b; }
    .tool-badge { background: #334155; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; }
    #chat { scroll-behavior: smooth; }
    pre { background: #0f172a; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    code { font-family: monospace; }
  </style>
</head>
<body class="flex flex-col h-screen overflow-hidden">

  <!-- Status strip -->
  <div id="status-strip" class="flex items-center gap-3 px-4 py-2 bg-slate-900 border-b border-slate-700 text-xs">
    <span id="conn-indicator" class="w-2 h-2 rounded-full bg-red-500"></span>
    <span id="conn-label" class="text-slate-400">disconnected</span>
    <span class="text-slate-600">|</span>
    <div id="kshetra-chips" class="flex gap-2"></div>
  </div>

  <!-- Project selector -->
  <div class="flex items-center gap-2 px-4 py-2 bg-slate-800 border-b border-slate-700 text-sm">
    <label class="text-slate-400">Project:</label>
    <select id="kshetra-select"
      class="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none">
      <option value="">all kshetras</option>
    </select>
  </div>

  <!-- Chat thread -->
  <div id="chat" class="flex-1 overflow-y-auto px-4 py-4 space-y-3"></div>

  <!-- Input bar -->
  <div class="px-4 py-3 border-t border-slate-700 bg-slate-900 flex gap-2">
    <input id="input" type="text" placeholder="Ask about your agents..."
      class="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm text-slate-100
             placeholder-slate-500 focus:outline-none focus:border-blue-500" />
    <button id="send-btn"
      class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium
             disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
      Send
    </button>
  </div>

<script>
(function () {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + TOKEN;

  let ws = null;
  let kshetras = [];
  let reconnectDelay = 1000;

  const connIndicator = document.getElementById('conn-indicator');
  const connLabel = document.getElementById('conn-label');
  const kshetraChips = document.getElementById('kshetra-chips');
  const kshetraSelect = document.getElementById('kshetra-select');
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');

  function setConnected(ok) {
    connIndicator.className = 'w-2 h-2 rounded-full ' + (ok ? 'bg-green-400' : 'bg-red-500');
    connLabel.textContent = ok ? 'connected' : 'disconnected';
    sendBtn.disabled = !ok;
  }

  function renderStatus(data) {
    kshetras = data.kshetras || [];
    kshetraChips.innerHTML = kshetras.map(k =>
      '<span class="tool-badge ' + (k.paused ? 'opacity-50' : '') + '">' + k.id + '</span>'
    ).join('');

    const current = kshetraSelect.value;
    kshetraSelect.innerHTML = '<option value="">all kshetras</option>' +
      kshetras.map(k => '<option value="' + k.id + '"' + (k.id === current ? ' selected' : '') + '>' + k.name + '</option>').join('');
  }

  function addMessage(role, html, extra) {
    const div = document.createElement('div');
    div.className = 'rounded-lg p-3 text-sm ' + (role === 'user' ? 'msg-user ml-8' : 'msg-assistant');
    if (extra) {
      div.innerHTML = '<div class="text-xs text-slate-500 mb-1">' + extra + '</div>' + html;
    } else {
      div.innerHTML = html;
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function addToolBadge(name) {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 text-xs text-slate-500 py-1';
    div.innerHTML = '<span class="tool-badge">' + name + '</span> <span class="animate-pulse">running...</span>';
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
      return marked.parse(text);
    }
    return '<pre>' + text.replace(/</g, '&lt;') + '</pre>';
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay = 1000;
    };

    ws.onclose = () => {
      setConnected(false);
      ws = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => {
      ws.close();
    };

    let currentDiv = null;
    let currentText = '';
    let currentToolDiv = null;

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);

      if (msg.type === 'status') {
        renderStatus(msg);
        return;
      }

      if (msg.type === 'text_delta') {
        currentText += msg.text;
        if (!currentDiv) {
          currentDiv = addMessage('assistant', '');
        }
        currentDiv.innerHTML = renderMarkdown(currentText);
        chat.scrollTop = chat.scrollHeight;
        return;
      }

      if (msg.type === 'tool_use') {
        if (currentToolDiv) currentToolDiv.remove();
        currentToolDiv = addToolBadge(msg.name + '(' + JSON.stringify(msg.input).slice(0, 60) + ')');
        return;
      }

      if (msg.type === 'tool_result') {
        if (currentToolDiv) {
          currentToolDiv.querySelector('span:last-child').textContent = 'done';
          currentToolDiv = null;
        }
        return;
      }

      if (msg.type === 'done') {
        currentDiv = null;
        currentText = '';
        currentToolDiv = null;
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
        return;
      }

      if (msg.type === 'error') {
        addMessage('assistant', '<span class="text-red-400">' + msg.message + '</span>');
        input.disabled = false;
        sendBtn.disabled = false;
        return;
      }
    };
  }

  function send() {
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const kshetraId = kshetraSelect.value;
    const prefix = kshetraId ? '@' + kshetraId + ' ' : '';
    const fullText = prefix + text;

    addMessage('user', '<span>' + text.replace(/</g, '&lt;') + '</span>' + (kshetraId ? '<div class="mt-1 text-xs text-slate-400">→ ' + kshetraId + '</div>' : ''));
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    ws.send(JSON.stringify({ type: 'chat', text: fullText }));
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  setConnected(false);
  connect();
})();
</script>
</body>
</html>`;