// static/js/docTerminal.js
//
// Integrated interactive terminal for the document editor. Runs the current
// doc (python/bash) in a backend tmux session (a real PTY, so input() works),
// polls its output, and sends typed lines back via the run-session endpoints
// in routes/shell_routes.py. Line-based, not a full ANSI terminal.

const API = {
  start: '/api/shell/run-session',
  output: (sid, offset) => `/api/shell/run-session/${sid}/output?offset=${offset}`,
  input: (sid) => `/api/shell/run-session/${sid}/input`,
  stop: (sid) => `/api/shell/run-session/${sid}/stop`,
};

const POLL_MS = 500;
// Strip the common terminal escape sequences (CSI + OSC) so the line-based
// output pane stays readable; full ANSI rendering is out of scope for v1.
const ANSI_RE = /\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

let _sid = null;
let _offset = 0;
let _poll = null;
let _alive = false;
let _lastCode = '';
let _lastLang = 'python';
let _wired = false;

function _jpost(url, body) {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

function _clean(text) {
  return (text || '').replace(ANSI_RE, '').replace(/\r(?!\n)/g, '');
}

function _outputEl() { return document.getElementById('doc-terminal-output'); }
function _inputEl() { return document.getElementById('doc-terminal-input'); }

function _append(text, cls) {
  const out = _outputEl();
  if (!out || !text) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = _clean(text);
  out.appendChild(span);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function _setStatus(text, cls) {
  const el = document.querySelector('#doc-terminal-pane .doc-terminal-status');
  if (el) { el.textContent = text || ''; el.className = 'doc-terminal-status' + (cls ? ' ' + cls : ''); }
}

function _setAlive(alive) {
  _alive = alive;
  const inp = _inputEl();
  if (inp) inp.disabled = !alive;
  const pane = document.getElementById('doc-terminal-pane');
  if (pane) pane.classList.toggle('running', alive);
}

function _stopPoll() {
  if (_poll) { clearInterval(_poll); _poll = null; }
}

async function _tick() {
  if (!_sid) return;
  let res;
  try {
    res = await fetch(API.output(_sid, _offset), { credentials: 'same-origin' });
  } catch (_) { return; }
  if (!res.ok) { _stopPoll(); _setAlive(false); _setStatus('disconnected', 'err'); return; }
  let data;
  try { data = await res.json(); } catch (_) { return; }
  if (typeof data.offset === 'number') _offset = data.offset;
  if (data.data) _append(data.data);
  if (data.exited) {
    _stopPoll();
    _setAlive(false);
    const code = (data.exit_code === null || data.exit_code === undefined) ? '?' : data.exit_code;
    _append(`\n[process exited — code ${code}]\n`, 'doc-terminal-exit');
    _setStatus(code === 0 ? 'finished' : `exited ${code}`, code === 0 ? 'ok' : 'err');
    _sid = null;
  } else if (data.alive === false) {
    _stopPoll();
    _setAlive(false);
    _setStatus('stopped', 'err');
    _sid = null;
  }
}

async function _sendInput() {
  const inp = _inputEl();
  if (!inp || !_sid || !_alive) return;
  const line = inp.value;
  inp.value = '';
  // Local echo — the PTY echoes to its own pane, not to the stdout we poll.
  _append(line + '\n', 'doc-terminal-input-echo');
  try { await _jpost(API.input(_sid), { data: line }); } catch (_) {}
}

async function _stop() {
  _stopPoll();
  const sid = _sid;
  _sid = null;
  _setAlive(false);
  _setStatus('stopped', 'err');
  if (sid) { try { await _jpost(API.stop(sid), {}); } catch (_) {} }
}

function _clear() {
  const out = _outputEl();
  if (out) out.innerHTML = '';
}

function _initResize(pane) {
  const handle = pane.querySelector('.doc-terminal-resize');
  if (!handle) return;
  let startY = 0, startH = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - (e.touches ? e.touches[0].clientY : e.clientY);
    const h = Math.max(120, Math.min(window.innerHeight * 0.7, startH + dy));
    pane.style.height = h + 'px';
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  const onDown = (e) => {
    dragging = true;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startH = pane.getBoundingClientRect().height;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    e.preventDefault();
  };
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

function _ensurePane() {
  let pane = document.getElementById('doc-terminal-pane');
  if (pane) return pane;
  pane = document.createElement('div');
  pane.id = 'doc-terminal-pane';
  pane.className = 'doc-terminal-pane';
  pane.style.display = 'none';
  pane.innerHTML = `
    <div class="doc-terminal-resize" title="Drag to resize"></div>
    <div class="doc-terminal-header">
      <span class="doc-terminal-title">› Terminal</span>
      <span class="doc-terminal-status"></span>
      <span style="flex:1"></span>
      <button class="doc-terminal-btn" data-act="rerun" title="Re-run">⟳</button>
      <button class="doc-terminal-btn" data-act="stop" title="Stop">■</button>
      <button class="doc-terminal-btn" data-act="clear" title="Clear">⌫</button>
      <button class="doc-terminal-btn" data-act="close" title="Close">✕</button>
    </div>
    <div id="doc-terminal-output" class="doc-terminal-output" tabindex="0"></div>
    <div class="doc-terminal-inputrow">
      <span class="doc-terminal-prompt">›</span>
      <input id="doc-terminal-input" class="doc-terminal-input" type="text"
             placeholder="type a response and press Enter…" autocomplete="off"
             autocapitalize="off" spellcheck="false" disabled />
    </div>`;

  // Mount above the action footer (VS Code style), inside the editor pane.
  const footer = document.getElementById('doc-actions-footer');
  if (footer && footer.parentNode) footer.parentNode.insertBefore(pane, footer);
  else {
    const editorPane = document.getElementById('doc-editor-pane');
    if (editorPane) editorPane.appendChild(pane);
    else document.body.appendChild(pane);
  }

  if (!_wired) {
    pane.addEventListener('click', (e) => {
      const btn = e.target.closest('.doc-terminal-btn');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'stop') _stop();
      else if (act === 'clear') _clear();
      else if (act === 'rerun') run(_lastCode, _lastLang);
      else if (act === 'close') close();
    });
    const inp = pane.querySelector('#doc-terminal-input');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _sendInput(); }
      });
    }
    // Focus the input when the user clicks anywhere in the output.
    const out = pane.querySelector('#doc-terminal-output');
    if (out) out.addEventListener('click', () => { const i = _inputEl(); if (i && !i.disabled) i.focus(); });
    _initResize(pane);
    _wired = true;
  }
  return pane;
}

/** Run code in the integrated terminal. Stops any previous session first. */
export async function run(code, lang) {
  if (!code || !code.trim()) return;
  _lastCode = code;
  _lastLang = (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') ? 'bash' : 'python';

  const pane = _ensurePane();
  pane.style.display = 'flex';
  if (!pane.style.height) pane.style.height = '260px';

  // Tear down any previous session before starting a new one.
  await _stop();
  _clear();
  _offset = 0;
  _setStatus('starting…', '');

  let res;
  try {
    res = await _jpost(API.start, { code: _lastCode, lang: _lastLang });
  } catch (e) {
    _append('Failed to reach server: ' + (e && e.message || e) + '\n', 'doc-terminal-exit');
    _setStatus('error', 'err');
    return;
  }
  if (!res.ok) {
    let msg = `Could not start (HTTP ${res.status})`;
    try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
    _append(msg + '\n', 'doc-terminal-exit');
    _setStatus('error', 'err');
    return;
  }
  let data;
  try { data = await res.json(); } catch (_) { _setStatus('error', 'err'); return; }
  _sid = data.session_id;
  _setAlive(true);
  _setStatus('running', '');
  const inp = _inputEl();
  if (inp) inp.focus();
  _stopPoll();
  _poll = setInterval(_tick, POLL_MS);
  _tick();
}

/** Hide the terminal and stop the session (Close button). */
export function close() {
  _stop();
  const pane = document.getElementById('doc-terminal-pane');
  if (pane) pane.style.display = 'none';
}

/** Called when the document panel closes / switches docs — kill any session. */
export function onDocClosed() {
  _stopPoll();
  const pane = document.getElementById('doc-terminal-pane');
  if (pane) pane.style.display = 'none';
  if (_sid) { const sid = _sid; _sid = null; _setAlive(false); try { _jpost(API.stop(sid), {}); } catch (_) {} }
}

export function isOpen() {
  const pane = document.getElementById('doc-terminal-pane');
  return !!(pane && pane.style.display !== 'none');
}

const docTerminal = { run, close, onDocClosed, isOpen };
export default docTerminal;
