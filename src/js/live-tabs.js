/* ==========================================================================
 *  live-tabs.js - Live transcript log + reply stream registries, popup tabs,
 *                 and the shared (cancellable) live-status bar.
 *  ========================================================================== */
import { escapeHtml, escapeAttr } from './config.js';
import { openInlineLiveView, inlineLiveViewKey } from './live-inline.js';

/* The popup documents contain NO inline script. A blob: document inherits the
   opener's CSP, and index.html ships `script-src 'self' blob:` with no
   'unsafe-inline', so an inline <script> is refused and the popup never boots.
   Behaviour therefore lives in src/js/live-view.js, loaded as an external
   same-origin module, and per-popup configuration is passed on a data attribute
   rather than in a second inline script. */
const LIVE_VIEW_URL = new URL('./live-view.js', import.meta.url).href;

/* How long the opener waits for a popup to report readiness before telling the
   user something is wrong. Previously this loop was unbounded, so a popup that
   could never boot showed a plausible "waiting" state forever. */
const READY_POLL_MS   = 80;
const READY_TIMEOUT_MS = 15000;

/* ──────────────────────────────────────────────────────────────────────────
 *  1. LIVE TRANSCRIPT LOG
 *  recId → { meta: string[], parts: {text,startSec,endSec}[], listeners: fn[] }
 *
 *  Both this registry and the reply-stream registry below are bounded: a
 *  long-lived PWA could otherwise accumulate every recording's full transcript
 *  parts / reply token string in memory forever. We retain the most-recently
 *  touched LIVE_CAP entries (plenty to reopen a recent live view) and evict the
 *  oldest. An evicted entry just stops live-updating any (almost certainly
 *  already-closed) popup for a long-finished recording.
 *  ────────────────────────────────────────────────────────────────────────── */
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

/* Reset a registry entry IN PLACE.
   Replacing the object instead (`store[id] = {...}`) silently orphaned any popup
   already attached to it: openLiveLogTab/openReplyStreamTab resolve the entry at
   open time but attach their listener asynchronously, after the popup reports
   ready, so a re-init landing in that gap wired the window to a dead object and
   no further event ever reached it. Listeners are preserved and told to clear. */
function resetEntry(store, order, recId, blank) {
  const existing = store[recId];
  if (existing) {
    Object.assign(existing, blank);
    _touchEvict(store, order, recId);
    for (const fn of [...existing.listeners]) {
      try { fn({ type: 'reset' }); } catch (_) {}
    }
    return existing;
  }
  store[recId] = { ...blank, listeners: [] };
  _touchEvict(store, order, recId);
  return store[recId];
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

/* Everything already buffered, in the order a fresh view must apply it. Shared
   by the popup handshake and the in-page panel so the two cannot drift. */
function liveLogSnapshot(entry) {
  const messages = entry.meta.map(line => ({ type: 'meta', line }));
  entry.parts.forEach((part, idx) => {
    if (part === undefined) return;
    messages.push({
      type: 'text', chunkIndex: idx,
      text: part.text, startSec: part.startSec, endSec: part.endSec, hasSeg: part.hasSeg
    });
  });
  return messages;
}

/** Replay the buffer into onMessage, then forward future events. Returns an
    unsubscribe function. This is the in-page equivalent of the popup handshake,
    minus the window, the origin and the postMessage hop. */
export function subscribeLiveLog(recId, onMessage) {
  const entry = _liveLogs[recId] || liveLogInit(recId);
  for (const msg of liveLogSnapshot(entry)) onMessage(msg);
  return attachCallbackListener(entry, `inline-livelog-${recId}`, onMessage);
}

export function openLiveLogTab(recId, recLabel) {
  const log = _liveLogs[recId] || liveLogInit(recId);
  if (prefersInlineView()) return openInlineLiveLog(recId, recLabel);
  const sig = randomToken();
  const win = openLiveWindow(`livelog-${recId}`, buildLiveLogHtml(recLabel, sig));
  if (!win) return canRenderInline() ? openInlineLiveLog(recId, recLabel) : null;
  pumpToWindow(win, log, 'livelog', sig, liveLogSnapshot);
  return win;
}

function openInlineLiveLog(recId, recLabel) {
  return openInlineLiveView({
    key:       `livelog-${recId}`,
    kind:      'livelog',
    title:     `📝 ${recLabel || 'Recording'}`,
    accent:    '#ffa726',
    subscribe: onMessage => subscribeLiveLog(recId, onMessage)
  });
}

function buildLiveLogHtml(recLabel, sig) {
  // Escape the label: it's the recording filename, which can contain
  // user-influenced characters and would otherwise break out of <title>/<div>.
  const title = escapeHtml(recLabel || 'Recording');
  return liveDocument({
    channel: 'livelog',
    sig,
    title: `📝 ${title}`,
    accent: '#ffa726',
    status: '⏳ Processing...',
    footer: 'Starting...',
    styles: `
  #transcript{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  .chunk-sep{display:block;height:0.5em}
  .chunk-block{display:block}
  .ts{font-size:11px;font-family:monospace;color:#555;user-select:none;margin-right:4px}`,
    body: `<div id="transcript"></div>`
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 *  2. REPLY STREAM
 *  recId → { tokens: string, listeners: fn[], done: bool }
 *  Bounded with the same LRU policy as the live-log registry above.
 *  ────────────────────────────────────────────────────────────────────────── */
const _replyStreams     = {};
const _replyStreamOrder = [];

/* Throughput is measured HERE rather than in the views, because a view can be
   opened at any point and must still show the real numbers. The registry sees
   every append; a late-opening view receives one replayed blob carrying the
   whole buffer, so counting events there would report one token for a finished
   answer. Every token message therefore carries the running totals, and the
   views only format them.

   Tokens are counted as server response objects. Ollama emits one per decoded
   token, so the count matches its own eval count, and the rate is measured from
   the FIRST token so that prompt evaluation (which can dominate on a long
   transcript) is not averaged into the generation speed. */
export function replyStreamInit(recId)   {
  return resetEntry(_replyStreams, _replyStreamOrder, recId,
                    { tokens: '', count: 0, firstAt: 0, lastAt: 0, model: '', done: false });
}

/** Name the model answering this stream, so the view can show what produced it. */
export function replyStreamModel(recId, model) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const name = String(model || '');
  _replyStreams[recId].model = name;
  _replyStreams[recId].listeners.forEach(fn => fn({ type: 'model', model: name }));
}

export function replyStreamAppend(recId, token) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const entry = _replyStreams[recId];
  const now = Date.now();
  entry.tokens += token;
  entry.count += 1;
  if (!entry.firstAt) entry.firstAt = now;
  entry.lastAt = now;
  const stats = { count: entry.count, elapsedMs: entry.lastAt - entry.firstAt };
  entry.listeners.forEach(fn => fn({ type: 'token', token, ...stats }));
}

export function replyStreamDone(recId) {
  const s = _replyStreams[recId];
  if (!s || s.done) return;          // idempotent
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
  const entry = _replyStreams[recId] || replyStreamInit(recId);
  for (const msg of replyStreamSnapshot(entry)) onMessage(msg);
  return attachCallbackListener(entry, `inline-replystream-${recId}`, onMessage);
}

export function openReplyStreamTab(recId, recLabel) {
  const stream = _replyStreams[recId] || replyStreamInit(recId);
  if (prefersInlineView()) return openInlineReplyStream(recId, recLabel);
  const sig = randomToken();
  const win = openLiveWindow(`replystream-${recId}`, buildReplyStreamHtml(recLabel, sig));
  if (!win) return canRenderInline() ? openInlineReplyStream(recId, recLabel) : null;
  pumpToWindow(win, stream, 'replystream', sig, replyStreamSnapshot);
  return win;
}

function openInlineReplyStream(recId, recLabel) {
  return openInlineLiveView({
    key:       `replystream-${recId}`,
    kind:      'replystream',
    title:     `🧠 AI Reply - ${recLabel || 'Recording'}`,
    accent:    '#4caf50',
    subscribe: onMessage => subscribeReplyStream(recId, onMessage)
  });
}

function buildReplyStreamHtml(recLabel, sig) {
  const title = escapeHtml(recLabel || 'Recording');
  return liveDocument({
    channel: 'replystream',
    sig,
    title: `🧠 AI Reply - ${title}`,
    accent: '#4caf50',
    status: '⏳ Generating...',
    footer: 'Waiting for tokens...',
    styles: `
  #reply{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  #cursor{display:inline-block;width:2px;height:1em;background:#4caf50;vertical-align:text-bottom;animation:blink .7s step-end infinite}
  @keyframes blink{50%{opacity:0}}`,
    body: `<div id="reply"><span id="text"></span><span id="cursor"></span></div>`
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 *  3. Which view to open
 *
 *  A popup is a second window fed by THIS one: the fetch stream, the registry
 *  and the postMessage pump all live in the opener. On a phone that is a
 *  contradiction, because window.open() hands the foreground to the new tab and
 *  backgrounds the opener, where timers are throttled and the tab may be
 *  suspended entirely. The view on screen then waits forever on a window that is
 *  no longer running - the reported "opens a tab, sits on Generating" symptom.
 *
 *  Touch/small-screen contexts therefore render in-page, in this tab, where
 *  nothing is backgrounded and no cross-window access is involved. Desktop keeps
 *  the popup, which is genuinely better there: it survives navigation and can be
 *  parked on a second monitor.
 *  ────────────────────────────────────────────────────────────────────────── */
const INLINE_VIEW_QUERY = '(pointer: coarse), (max-width: 820px)';

function canRenderInline() {
  return typeof document !== 'undefined'
      && !!document.body
      && typeof document.createElement === 'function';
}

function prefersInlineView() {
  if (!canRenderInline()) return false;
  // A panel already on screen keeps the choice consistent for the next view.
  if (inlineLiveViewKey()) return true;
  try {
    if (typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia(INLINE_VIEW_QUERY).matches;
  } catch (_) {
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  4. Shared pump + blob-URL lifecycle helpers
 *  ────────────────────────────────────────────────────────────────────────── */

// Unguessable per-popup token. The popups post/receive over a wildcard target
// origin (a blob: popup's origin is implementation-defined - sometimes opaque -
// so a fixed targetOrigin can't be relied on), so instead each popup is handed a
// fresh secret and accepts ONLY messages carrying it. Cheap defence against a
// stray window injecting messages into the live views.
function randomToken() {
  const a = new Uint8Array(16);
  (self.crypto || window.crypto).getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// Forward a registry entry's future events to a popup window. Replaces any
// listener already bound to the SAME window (reopening a live tab returns the
// same named window, so this prevents listeners stacking up and posting
// duplicates), and removes itself once the window is closed - so a registry
// entry for an active recording can't accumulate dead listeners from repeated
// opens before the LRU eviction would catch it.
// Forward a registry entry's future events to a plain callback (the in-page
// panel). Keyed rather than window-bound, so reopening the same view replaces
// its subscription instead of stacking a second one, and the returned function
// detaches it. Callback listeners carry no _win, so attachWindowListener's
// window filtering never touches them.
function attachCallbackListener(entry, key, onMessage) {
  entry.listeners = entry.listeners.filter(fn => fn._key !== key);
  const listener = (msg) => onMessage(msg);
  listener._key = key;
  entry.listeners.push(listener);
  return () => { entry.listeners = entry.listeners.filter(fn => fn !== listener); };
}

function attachWindowListener(entry, win, channel, sig) {
  entry.listeners = entry.listeners.filter(fn => fn._win !== win);
  const listener = (msg) => {
    if (!win || win.closed) {
      entry.listeners = entry.listeners.filter(fn => fn !== listener);
      return;
    }
    try { win.postMessage({ channel, sig, msg }, '*'); } catch (_) {}
  };
  listener._win = win;
  entry.listeners.push(listener);
}

/* One shared popup document. Structure and styling only: every line of script
   lives in the external same-origin module referenced below, because a blob:
   document inherits the opener's CSP and that policy forbids inline script.
   Per-popup configuration travels on a data attribute for the same reason. */
function liveDocument({ channel, sig, title, accent, status, footer, styles, body }) {
  const config = JSON.stringify({ channel, sig });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${title}</title>
  <style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#e8e8e8;font:15px/1.8 system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #header{padding:10px 16px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
  #title{font-size:13px;color:${accent};font-family:monospace;font-weight:bold}
  #status{font-size:11px;color:#555;font-family:monospace;margin-top:2px}
  #footer{padding:6px 16px;background:#111;border-top:1px solid #1a1a1a;font:11px/1.4 monospace;color:#444;flex-shrink:0}${styles}
  </style></head>
  <body data-live-config="${escapeAttr(config)}">
  <div id="header">
  <div id="title">${title}</div>
  <div id="status">${status}</div>
  </div>
  ${body}
  <div id="footer">${footer}</div>
  <script type="module" src="${escapeAttr(LIVE_VIEW_URL)}"><\/script>
  </body></html>`;
}

/* Open (or re-navigate) the named popup and free its blob URL once parsed. */
function openLiveWindow(name, html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = window.open(url, name);
  if (!win) { URL.revokeObjectURL(url); return null; }   // popup blocked
  try { win.addEventListener('load', () => { try { URL.revokeObjectURL(url); } catch (_) {} }); } catch (_) {}
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
  return win;
}

/* Popups awaiting their handshake: sig -> { win, attach }.
   The popup announces itself by postMessage, which is the only channel that
   works in both directions regardless of what origin the browser decided to
   give a blob: document. */
const _pendingReady = new Map();
let _readyListenerBound = false;

function ensureReadyListener() {
  if (_readyListenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _readyListenerBound = true;
  window.addEventListener('message', event => {
    const data = event && event.data;
    if (!data || data.liveReady !== true || typeof data.sig !== 'string') return;
    const pending = _pendingReady.get(data.sig);
    // The popup announces more than once; attach() is idempotent.
    if (pending) pending.attach();
  });
}

/* Wait for the popup's module to report readiness, replay everything already in
   the registry, then forward future events.

   Readiness arrives EITHER as a message from the popup or as the _ready flag
   seen by the bounded poll below. The message is what actually works on WebKit,
   where reading a property off a blob: popup can throw SecurityError; the poll
   remains for a popup whose opener reference was stripped, and it is what makes
   the wait bounded.

   The wait is BOUNDED. When a popup cannot boot at all - the exact failure the
   inherited-CSP bug produced - the opener writes a visible explanation into the
   window instead of polling silently forever behind a convincing
   "Generating..." placeholder. */
function pumpToWindow(win, entry, channel, sig, snapshot) {
  ensureReadyListener();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let settled = false;

  const attach = () => {
    if (settled) return;
    settled = true;
    _pendingReady.delete(sig);
    try {
      if (win.closed) return;
      for (const msg of snapshot(entry)) win.postMessage({ channel, sig, msg }, '*');
      attachWindowListener(entry, win, channel, sig);
    } catch (_) {}
  };
  _pendingReady.set(sig, { win, attach });

  const pump = () => {
    if (settled) return;
    try {
      if (win.closed) return;
      if (win._ready) {
        attach();
        return;
      }
      if (Date.now() >= deadline) { reportPopupFailure(win); return; }
    } catch (_) {
      // Cross-origin property read: this window may not touch a blob: popup that
      // WebKit gave a different origin. The popup is probably alive and will
      // announce itself by message, so only the POLL gives up here - its pending
      // handshake stays registered.
      if (Date.now() >= deadline) return;
    }
    setTimeout(pump, READY_POLL_MS);
  };
  pump();
}

function reportPopupFailure(win) {
  // Nothing may attach to a window already declared dead.
  for (const [key, pending] of _pendingReady) {
    if (pending.win === win) _pendingReady.delete(key);
  }
  const message = 'This view could not start. Its script was blocked or failed to load, '
                + 'so no live output can be shown here. Close this window and check the '
                + 'browser console in the main tab.';
  try {
    const status = win.document.getElementById('status');
    const footer = win.document.getElementById('footer');
    if (status) status.textContent = '⚠️ View failed to start';
    if (footer) footer.textContent = message;
  } catch (_) {}
  console.error('Live view popup never became ready:', message);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  5. Live-status bar - a clickable progress indicator injected into the
 *  recording's panel, visible even in compact mode. Optional ✕ cancels the job.
 *  Shared by gui.js (manual) and auto-pipeline.js (automatic).
 *  ────────────────────────────────────────────────────────────────────────── */
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
    // "Tap to watch" was pointer-only: a plain div with a click listener is not
    // reachable by keyboard or exposed to assistive technology, so the live view
    // was unopenable without a pointer.
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
