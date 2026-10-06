import { escapeHtml } from './config.js';
import { openInlineLiveView, inlineLiveViewKey } from './live-inline.js';
import { createLiveLogRenderer, createReplyRenderer } from './live-render.js';

const READY_POLL_MS   = 80;
const READY_TIMEOUT_MS = 15000;
const FRAME_FALLBACK_MS = 100;

const VIEW_TITLE = {
  livelog:     label => `📝 ${label || 'Recording'}`,
  replystream: label => `🧠 AI Reply - ${label || 'Recording'}`
};
const VIEW_ACCENT = {
  livelog:     '#ffa726',
  replystream: '#4caf50'
};

const LIVE_VIEW_COLORS = {
  chrome:  '#111',
  page:    '#0d0d0d',
  body:    '#e8e8e8',
  status:  '#8a8a8a',
  footer:  '#8a8a8a',
  stamp:   '#8a8a8a'
};

const LIVE_CAP = 30;

function _touchEvict(store, order, key) {
  const i = order.indexOf(key);
  if (i !== -1) order.splice(i, 1);
  order.push(key);
  while (order.length > LIVE_CAP) {
    const oldest = order.shift();
    if (oldest !== key) delete store[oldest];
  }
}

const _liveLogs      = {};
const _liveLogOrder  = [];

let _generationCounter = 0;

function resetEntry(store, order, recId, blank) {
  const generation = ++_generationCounter;
  const existing = store[recId];
  if (existing) {
    Object.assign(existing, blank, { generation });
    _touchEvict(store, order, recId);
    for (const fn of [...existing.listeners]) {
      try { fn({ type: 'reset' }); } catch (_) {}
    }
    return existing;
  }
  store[recId] = { ...blank, generation, listeners: [] };
  _touchEvict(store, order, recId);
  return store[recId];
}

function ownsEntry(entry, generation) {
  return !!entry && (generation == null || entry.generation === generation);
}

export function liveLogInit(recId)  {
  return resetEntry(_liveLogs, _liveLogOrder, recId, { meta: [], parts: [] });
}
export function liveLogClear(recId) { return liveLogInit(recId); }

export function liveLogAppend(recId, line) {
  if (!_liveLogs[recId]) liveLogInit(recId);
  _liveLogs[recId].meta.push(line);
  _liveLogs[recId].listeners.forEach(fn => fn({ type: 'meta', line }));
}

export function liveLogText(recId, chunkIndex, text, startSec, endSec, hasSeg) {
  if (!_liveLogs[recId]) liveLogInit(recId);
  _liveLogs[recId].parts[chunkIndex] = { text, startSec, endSec, hasSeg: !!hasSeg };
  _liveLogs[recId].listeners.forEach(fn =>
    fn({ type: 'text', chunkIndex, text, startSec, endSec, hasSeg: !!hasSeg })
  );
}

function liveLogSnapshot(entry) {
  const messages = [];
  entry.parts.forEach((part, idx) => {
    if (part === undefined) return;
    messages.push({
      type: 'text', chunkIndex: idx,
      text: part.text, startSec: part.startSec, endSec: part.endSec,
      hasSeg: part.hasSeg, final: !!part.final
    });
  });
  for (const line of entry.meta) messages.push({ type: 'meta', line });
  return messages;
}

function subscribeLiveLog(recId, onMessage) {
  const entry = _liveLogs[recId] || liveLogInit(recId);
  for (const msg of liveLogSnapshot(entry)) onMessage(msg);
  return attachCallbackListener(entry, `inline-livelog-${recId}`, onMessage);
}

export function openLiveLogTab(recId, recLabel) {
  const log = _liveLogs[recId] || liveLogInit(recId);
  if (prefersInlineView()) return openInlineLiveLog(recId, recLabel);
  const win = openLiveWindow(`livelog-${recId}`, buildLiveLogHtml(recLabel));
  if (!win) return canRenderInline() ? openInlineLiveLog(recId, recLabel) : null;
  driveWindow(win, log, 'livelog', liveLogSnapshot, canRenderInline() ? () => openInlineLiveLog(recId, recLabel) : null);
  return win;
}

function openInlineLiveLog(recId, recLabel) {
  return openInlineLiveView({
    key:       `livelog-${recId}`,
    kind:      'livelog',
    title:     VIEW_TITLE.livelog(recLabel),
    accent:    VIEW_ACCENT.livelog,
    subscribe: onMessage => subscribeLiveLog(recId, onMessage)
  });
}

function buildLiveLogHtml(recLabel) {
  const title = escapeHtml(VIEW_TITLE.livelog(recLabel));
  return liveDocument({
    title,
    accent: VIEW_ACCENT.livelog,
    status: '⏳ Processing...',
    footer: 'Starting...',
    styles: `
  #transcript{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  .chunk-sep{display:block;height:0.5em}
  .chunk-block{display:block}
  .ts{font-size:11px;font-family:monospace;color:${LIVE_VIEW_COLORS.stamp};user-select:none;margin-right:4px}`,
    body: `<div id="transcript"></div>`
  });
}

const _replyStreams     = {};
const _replyStreamOrder = [];

export function replyStreamInit(recId)   {
  return resetEntry(_replyStreams, _replyStreamOrder, recId,
                    { tokens: '', count: 0, firstAt: 0, lastAt: 0, model: '', done: false })
         .generation;
}

export function replyStreamModel(recId, model, generation = null) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const entry = _replyStreams[recId];
  if (!ownsEntry(entry, generation)) return;
  const name = String(model || '');
  entry.model = name;
  entry.listeners.forEach(fn => fn({ type: 'model', model: name }));
}

export function replyStreamAppend(recId, token, generation = null) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const entry = _replyStreams[recId];
  if (!ownsEntry(entry, generation)) return;
  const now = Date.now();
  entry.tokens += token;
  entry.count += 1;
  if (!entry.firstAt) entry.firstAt = now;
  entry.lastAt = now;
  const stats = { count: entry.count, elapsedMs: entry.lastAt - entry.firstAt };
  entry.listeners.forEach(fn => fn({ type: 'token', token, ...stats }));
}

export function replyStreamDone(recId, generation = null) {
  const s = _replyStreams[recId];
  if (!s || s.done) return;
  if (!ownsEntry(s, generation)) return;
  s.done = true;
  s.listeners.forEach(fn => fn({ type: 'done' }));
}

function replyStreamSnapshot(entry) {
  const messages = [];
  if (entry.model) messages.push({ type: 'model', model: entry.model });
  if (entry.tokens) {
    messages.push({
      type: 'token',
      token: entry.tokens,
      count: entry.count,
      elapsedMs: Math.max(0, entry.lastAt - entry.firstAt)
    });
  }
  if (entry.done)   messages.push({ type: 'done' });
  return messages;
}

export function subscribeReplyStream(recId, onMessage) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const entry = _replyStreams[recId];
  for (const msg of replyStreamSnapshot(entry)) onMessage(msg);
  return attachCallbackListener(entry, `inline-replystream-${recId}`, onMessage);
}

export function openReplyStreamTab(recId, recLabel) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const stream = _replyStreams[recId];
  if (prefersInlineView()) return openInlineReplyStream(recId, recLabel);
  const win = openLiveWindow(`replystream-${recId}`, buildReplyStreamHtml(recLabel));
  if (!win) return canRenderInline() ? openInlineReplyStream(recId, recLabel) : null;
  driveWindow(win, stream, 'replystream', replyStreamSnapshot,
              canRenderInline() ? () => openInlineReplyStream(recId, recLabel) : null);
  return win;
}

function openInlineReplyStream(recId, recLabel) {
  return openInlineLiveView({
    key:       `replystream-${recId}`,
    kind:      'replystream',
    title:     VIEW_TITLE.replystream(recLabel),
    accent:    VIEW_ACCENT.replystream,
    subscribe: onMessage => subscribeReplyStream(recId, onMessage)
  });
}

function buildReplyStreamHtml(recLabel) {
  const title = escapeHtml(VIEW_TITLE.replystream(recLabel));
  return liveDocument({
    title,
    accent: VIEW_ACCENT.replystream,
    status: '⏳ Generating...',
    footer: 'Waiting for tokens...',
    styles: `
  #reply{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  #cursor{display:inline-block;width:2px;height:1em;background:${VIEW_ACCENT.replystream};vertical-align:text-bottom;animation:blink .7s step-end infinite}
  @keyframes blink{50%{opacity:0}}`,
    body: `<div id="reply"><span id="text"></span><span id="cursor"></span></div>`
  });
}

export function replyStreamStats(recId) {
  const entry = _replyStreams[recId];
  if (!entry) return null;
  return {
    model:     entry.model || '',
    count:     entry.count || 0,
    elapsedMs: Math.max(0, (entry.lastAt || 0) - (entry.firstAt || 0))
  };
}

function finishedReplyEntry({ text, model, tokenCount, elapsedMs }) {
  const span = Math.max(0, Number(elapsedMs) || 0);
  return {
    tokens:  String(text || ''),
    count:   Math.max(0, Number(tokenCount) || 0),
    firstAt: span ? 1 : 0,
    lastAt:  span ? span + 1 : 0,
    model:   String(model || ''),
    done:    true,
    listeners: []
  };
}

function finishedLogEntry({ text, charCount }) {
  const body  = String(text || '');
  const chars = Number.isFinite(charCount) ? charCount : body.length;
  return {
    parts: [{ text: body, startSec: 0, endSec: 0, hasSeg: true, final: true }],
    meta: [`✅ Done - ${chars} chars total`],
    listeners: []
  };
}

function openSavedView({ key, windowName, kind, label, entry }) {
  const snapshot = kind === 'replystream' ? replyStreamSnapshot : liveLogSnapshot;
  const openInline = () => openInlineLiveView({
    key,
    kind,
    title:  VIEW_TITLE[kind](label),
    accent: VIEW_ACCENT[kind],
    subscribe: onMessage => {
      for (const msg of snapshot(entry)) onMessage(msg);
      return () => {};
    }
  });

  if (prefersInlineView()) return openInline();
  const html = kind === 'replystream' ? buildReplyStreamHtml(label) : buildLiveLogHtml(label);
  const win = openLiveWindow(windowName || key, html);
  if (!win) return canRenderInline() ? openInline() : null;
  try { win.focus(); } catch (_) {}
  driveWindow(win, entry, kind, snapshot, canRenderInline() ? openInline : null);
  return win;
}

export function openSavedReplyView({ key, windowName, label, text, model, tokenCount, elapsedMs }) {
  return openSavedView({
    key, windowName, kind: 'replystream', label,
    entry: finishedReplyEntry({ text, model, tokenCount, elapsedMs })
  });
}

export function openSavedTranscriptView({ key, windowName, label, text, charCount }) {
  return openSavedView({
    key, windowName, kind: 'livelog', label,
    entry: finishedLogEntry({ text, charCount })
  });
}

const INLINE_VIEW_QUERY = '(pointer: coarse), (max-width: 820px)';

function canRenderInline() {
  return typeof document !== 'undefined'
      && !!document.body
      && typeof document.createElement === 'function';
}

function prefersInlineView() {
  if (!canRenderInline()) return false;
  if (inlineLiveViewKey()) return true;
  try {
    if (typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia(INLINE_VIEW_QUERY).matches;
  } catch (_) {
    return false;
  }
}

function attachCallbackListener(entry, key, onMessage) {
  entry.listeners = entry.listeners.filter(fn => fn._key !== key);
  const listener = (msg) => onMessage(msg);
  listener._key = key;
  entry.listeners.push(listener);
  return () => { entry.listeners = entry.listeners.filter(fn => fn !== listener); };
}

// A pop-up is a page with no script of its own. This tab renders into it with the same renderer as
// the inline view, on the pop-up's own animation frames. Nothing is posted to it: its content cannot
// reach a page the window was navigated to, and it never loads a module, which a service worker of a
// newer build could otherwise have served it.
function attachWindowRenderer(entry, win, doc, renderer) {
  entry.listeners = entry.listeners.filter(fn => fn._win !== win);
  const listener = (msg) => {
    let showing = false;
    try { showing = !win.closed && win.document === doc; } catch (_) {}
    if (!showing) {
      entry.listeners = entry.listeners.filter(fn => fn !== listener);
      return;
    }
    try { renderer.handle(msg); } catch (err) { console.warn('Live view popup could not be updated:', err); }
  };
  listener._win = win;
  entry.listeners.push(listener);
}

function liveDocument({ title, accent, status, footer, styles, body }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${title}</title>
  <style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#e8e8e8;font:15px/1.8 system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #header{padding:10px 16px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
  #title{font-size:13px;color:${accent};font-family:monospace;font-weight:bold}
  #status{font-size:11px;color:${LIVE_VIEW_COLORS.status};font-family:monospace;margin-top:2px}
  #footer{padding:6px 16px;background:${LIVE_VIEW_COLORS.chrome};border-top:1px solid #1a1a1a;font:11px/1.4 monospace;color:${LIVE_VIEW_COLORS.footer};flex-shrink:0}${styles}
  </style></head>
  <body>
  <div id="header">
  <div id="title">${title}</div>
  <div id="status">${status}</div>
  </div>
  ${body}
  <div id="footer">${footer}</div>
  </body></html>`;
}

const _liveWindows = new Map();

function openLiveWindow(name, html) {
  const existing = _liveWindows.get(name);
  if (existing) {
    try { if (!existing.closed) existing.close(); } catch (_) {}
    _liveWindows.delete(name);
  }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = window.open(url, name);
  if (win) _liveWindows.set(name, win);
  if (!win) { URL.revokeObjectURL(url); return null; }
  try { win.addEventListener('load', () => { try { URL.revokeObjectURL(url); } catch (_) {} }); } catch (_) {}
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
  return win;
}

// The elements of the pop-up's page once it has been parsed; null while the window still shows the
// blank page window.open starts it with. Reading the document throws once the window shows a page
// of another origin.
function popupElements(win, kind) {
  const doc = win.document;
  const statusEl = doc.getElementById('status');
  const footerEl = doc.getElementById('footer');
  if (!statusEl || !footerEl) return null;
  if (kind === 'livelog') {
    const transcriptEl = doc.getElementById('transcript');
    return transcriptEl ? { doc, transcriptEl, statusEl, footerEl } : null;
  }
  const replyEl = doc.getElementById('reply');
  const textEl = doc.getElementById('text');
  return replyEl && textEl ? { doc, replyEl, textEl, cursorEl: doc.getElementById('cursor'), statusEl, footerEl } : null;
}

// The pop-up's own frames, so it keeps up while this tab is in the background; a timer covers a
// pop-up that gets no frames, such as one behind the app.
function popupFrame(win) {
  return fn => {
    let done = false;
    const runOnce = () => { if (done) return; done = true; fn(); };
    try { win.requestAnimationFrame(runOnce); } catch (_) {}
    setTimeout(runOnce, FRAME_FALLBACK_MS);
  };
}

function rendererFor(win, kind, elements) {
  const frame = popupFrame(win);
  const { transcriptEl, replyEl, textEl, cursorEl, statusEl, footerEl } = elements;
  return kind === 'livelog'
    ? createLiveLogRenderer({ transcriptEl, statusEl, footerEl, frame })
    : createReplyRenderer({ replyEl, textEl, cursorEl, statusEl, footerEl, frame });
}

const _driving = new WeakMap();

function driveWindow(win, entry, kind, snapshot, openInstead = null) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const drive = {};
  _driving.set(win, drive);
  const start = () => {
    if (_driving.get(win) !== drive) return;
    let elements = null;
    try {
      if (win.closed) { _driving.delete(win); return; }
      elements = popupElements(win, kind);
    } catch (_) {
      // This tab may not read the pop-up's page: a browser that gives it an origin of its own. Nothing
      // is sent to it; the view opens in the page instead, where the page can show one.
      _driving.delete(win);
      if (openInstead) {
        try { win.close(); } catch (_) {}
        openInstead();
      }
      return;
    }
    if (!elements) {
      if (Date.now() >= deadline) { _driving.delete(win); reportPopupFailure(win); return; }
      setTimeout(start, READY_POLL_MS);
      return;
    }
    _driving.delete(win);
    const renderer = rendererFor(win, kind, elements);
    for (const msg of snapshot(entry)) renderer.handle(msg);
    attachWindowRenderer(entry, win, elements.doc, renderer);
  };
  start();
}

function reportPopupFailure(win) {
  const message = 'This view could not be shown: its page did not load. Close this window and open '
                + 'the view again from the main tab.';
  try {
    const body = win.document && win.document.body;
    if (body) body.textContent = message;
  } catch (_) {}
  console.error('Live view popup never loaded:', message);
}

export function showLiveStatus(recId, type, initialText, onClick, onCancel) {
  const container = document.getElementById(`rec-${recId}`);
  if (!container) return null;

  removeLiveStatus(recId, type);

  const bar = document.createElement('div');
  bar.className = `live-status live-status-${type}`;
  bar.id = `live-status-${type}-${recId}`;
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.setAttribute('aria-atomic', 'true');

  const main = document.createElement('div');
  main.className = 'live-status-main';
  main.innerHTML = `<span class="dot"></span><span class="live-status-text"></span>`;
  main.querySelector('.live-status-text').textContent = initialText;
  if (onClick) {
    main.setAttribute('role', 'button');
    main.setAttribute('tabindex', '0');
    main.setAttribute('aria-label', `Open the live ${type} view`);
    main.addEventListener('click', onClick);
    main.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      onClick(e);
    });
  }
  bar.appendChild(main);

  if (onCancel) {
    const x = document.createElement('button');
    x.className = 'live-status-cancel';
    x.textContent = '✕';
    x.title = 'Cancel';
    x.setAttribute('aria-label', `Cancel ${type} job`);
    x.addEventListener('click', (e) => { e.stopPropagation(); onCancel(); });
    bar.appendChild(x);
  }

  const bottomActions = container.querySelector(`#bottom-actions-${recId}`);
  if (bottomActions) container.insertBefore(bar, bottomActions);
  else               container.appendChild(bar);
  return bar;
}

export function updateLiveStatus(recId, type, text) {
  const bar = document.getElementById(`live-status-${type}-${recId}`);
  if (!bar) return;
  const span = bar.querySelector('.live-status-text');
  if (span) span.textContent = text;
}

export function removeLiveStatus(recId, type) {
  const bar = document.getElementById(`live-status-${type}-${recId}`);
  if (bar) bar.remove();
}
