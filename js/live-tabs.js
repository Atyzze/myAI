/* ==========================================================================
 *  live-tabs.js — Live transcript log + reply stream registries, popup tabs,
 *                 and the shared (cancellable) live-status bar.
 *  ========================================================================== */
import { SEAM_TRIM_SRC } from './dedup.js';
import { escapeHtml }    from './config.js';

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

export function liveLogInit(recId)  {
  _liveLogs[recId] = { meta: [], parts: [], listeners: [] };
  _touchEvict(_liveLogs, _liveLogOrder, recId);
}
export function liveLogClear(recId) { liveLogInit(recId); }

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

export function openLiveLogTab(recId, recLabel) {
  if (!_liveLogs[recId]) liveLogInit(recId);
  const log = _liveLogs[recId];

  const sig  = randomToken();
  const html = buildLiveLogHtml(recId, recLabel, sig);
  const url  = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win  = window.open(url, `livelog-${recId}`);

  if (!win) { URL.revokeObjectURL(url); return; }   // popup blocked
  revokeOnLoad(win, url);
  pumpToWindow(win, log, 'livelog', sig);
}

function buildLiveLogHtml(recId, recLabel, sig) {
  // Escape the label: it's the recording filename, which can contain
  // user-influenced characters and would otherwise break out of <title>/<div>.
  const title = escapeHtml(recLabel || 'Recording #' + recId);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>📝 ${title}</title>
  <style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#e8e8e8;font:15px/1.7 system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #header{padding:10px 16px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
  #title{font-size:13px;color:#ffa726;font-family:monospace;font-weight:bold}
  #status{font-size:11px;color:#555;font-family:monospace;margin-top:2px}
  #transcript{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  .chunk-sep{display:block;height:0.5em}
  .chunk-block{display:block}
  .ts{font-size:11px;font-family:monospace;color:#555;user-select:none;margin-right:4px}
  #footer{padding:6px 16px;background:#111;border-top:1px solid #1a1a1a;font:11px/1.4 monospace;color:#444;flex-shrink:0}
  </style></head><body>
  <div id="header">
  <div id="title">📝 ${title}</div>
  <div id="status">⏳ Processing...</div>
  </div>
  <div id="transcript"></div>
  <div id="footer">Starting...</div>
  <script>
  const SIG = ${JSON.stringify(sig)};
  ${SEAM_TRIM_SRC}
  const transcriptEl = document.getElementById('transcript');
  const statusEl     = document.getElementById('status');
  const footerEl     = document.getElementById('footer');
  const chunks = {};

  function fmtTime(sec) {
    const s = Math.floor(sec), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    const pad = n => String(n).padStart(2,'0');
    return h ? pad(h)+':'+pad(m)+':'+pad(ss) : pad(m)+':'+pad(ss);
  }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

  function rebuildTranscript() {
    const ordered = Object.values(chunks).sort((a, b) => a.startSec - b.startSec);
    transcriptEl.innerHTML = '';
    let tail = '';
    const NL = String.fromCharCode(10);

    function updTail(t){ const w=(tail+' '+t).trim().split(/\\s+/).filter(Boolean); tail=w.slice(-40).join(' '); }
    function pushBlock(tsPart, textPart){
      const b = document.createElement('div');
      b.className = 'chunk-block';
      b.innerHTML = (tsPart ? '<span class="ts">' + esc(tsPart) + '</span> ' : '') + esc(textPart);
      transcriptEl.appendChild(b);
    }

    ordered.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'chunk-sep';
        transcriptEl.appendChild(sep);
      }
      const text = (c.text || '');
      // Use the explicit flag from the pipeline. The old heuristic sniffed for a
      // leading "[0…" / "[1…" and silently broke past 20 minutes, where real
      // timestamps look like [21:34] and start with neither.
      const hasSegTS = !!c.hasSeg;

      if (hasSegTS) {
        const lines = text.split(NL);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const bracketEnd = trimmed.indexOf('] ');
          const textPart = bracketEnd >= 0 ? trimmed.substring(bracketEnd + 2) : trimmed;
          const tsPart   = bracketEnd >= 0 ? trimmed.substring(0, bracketEnd + 1) : '';
          if (!textPart) continue;
          const kept = tail ? seamTrim(tail, textPart) : textPart;
          if (!kept.trim()) continue;
          updTail(kept);
          pushBlock(tsPart, kept);
        }
      } else {
        const kept = tail ? seamTrim(tail, text) : text;
        if (!kept.trim()) return;
        updTail(kept);
        const ts = fmtTime(c.startSec) + ' \\u2013 ' + fmtTime(c.endSec);
        pushBlock('[' + ts + ']', kept);
      }
    });
  }

  function onMsg(msg) {
    if (msg.type === 'meta') {
      const done = msg.line.includes('✅') && msg.line.includes('Done');
      footerEl.textContent = msg.line;
      if (done) statusEl.textContent = '✅ Complete';
    } else if (msg.type === 'text') {
      chunks[msg.chunkIndex] = {
        startSec: msg.startSec ?? (msg.chunkIndex * 60),
        endSec:   msg.endSec   ?? (msg.chunkIndex * 60 + 60),
        text:     msg.text,
        hasSeg:   !!msg.hasSeg
      };
      const prevScrollBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop;
      rebuildTranscript();
      const nearBottom = prevScrollBottom - transcriptEl.clientHeight < 80;
      if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
      statusEl.textContent = Object.keys(chunks).length + ' chunk(s) received — assembling timeline...';
    }
  }

  window.onmessage = (e) => { if (e.data && e.data.sig === SIG && e.data.channel === 'livelog') onMsg(e.data.msg); };
  window._ready = true;
  <\/script></body></html>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  2. REPLY STREAM
 *  recId → { tokens: string, listeners: fn[], done: bool }
 *  Bounded with the same LRU policy as the live-log registry above.
 *  ────────────────────────────────────────────────────────────────────────── */
const _replyStreams     = {};
const _replyStreamOrder = [];

export function replyStreamInit(recId)   {
  _replyStreams[recId] = { tokens: '', listeners: [], done: false };
  _touchEvict(_replyStreams, _replyStreamOrder, recId);
}

export function replyStreamAppend(recId, token) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  _replyStreams[recId].tokens += token;
  _replyStreams[recId].listeners.forEach(fn => fn({ type: 'token', token }));
}

export function replyStreamDone(recId) {
  const s = _replyStreams[recId];
  if (!s || s.done) return;          // idempotent
  s.done = true;
  s.listeners.forEach(fn => fn({ type: 'done' }));
}

export function openReplyStreamTab(recId, recLabel) {
  if (!_replyStreams[recId]) replyStreamInit(recId);
  const stream = _replyStreams[recId];

  const sig  = randomToken();
  const html = buildReplyStreamHtml(recId, recLabel, sig);
  const url  = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win  = window.open(url, `replystream-${recId}`);

  if (!win) { URL.revokeObjectURL(url); return; }   // popup blocked
  revokeOnLoad(win, url);

  const pump = () => {
    try {
      if (win.closed) return;
      if (win._ready) {
        if (stream.tokens) win.postMessage({ channel: 'replystream', sig, msg: { type: 'token', token: stream.tokens } }, '*');
        if (stream.done)   win.postMessage({ channel: 'replystream', sig, msg: { type: 'done' } }, '*');
        attachWindowListener(stream, win, 'replystream', sig);
        return;
      }
    } catch (_) {}
    setTimeout(pump, 80);
  };
  pump();
}

function buildReplyStreamHtml(recId, recLabel, sig) {
  const title = escapeHtml(recLabel || 'Recording #' + recId);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>🧠 ${title}</title>
  <style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#e8e8e8;font:15px/1.8 system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #header{padding:10px 16px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
  #title{font-size:13px;color:#4caf50;font-family:monospace;font-weight:bold}
  #status{font-size:11px;color:#555;font-family:monospace;margin-top:2px}
  #reply{flex:1;overflow-y:auto;padding:24px 28px;white-space:pre-wrap;word-break:break-word;line-height:1.8}
  #cursor{display:inline-block;width:2px;height:1em;background:#4caf50;vertical-align:text-bottom;animation:blink .7s step-end infinite}
  @keyframes blink{50%{opacity:0}}
  #footer{padding:6px 16px;background:#111;border-top:1px solid #1a1a1a;font:11px/1.4 monospace;color:#444;flex-shrink:0}
  </style></head><body>
  <div id="header">
  <div id="title">🧠 AI Reply — ${title}</div>
  <div id="status">⏳ Generating...</div>
  </div>
  <div id="reply"><span id="text"></span><span id="cursor"></span></div>
  <div id="footer">Waiting for tokens...</div>
  <script>
  const SIG = ${JSON.stringify(sig)};
  const textEl   = document.getElementById('text');
  const cursorEl = document.getElementById('cursor');
  const statusEl = document.getElementById('status');
  const footerEl = document.getElementById('footer');
  const replyEl  = document.getElementById('reply');
  let charCount  = 0;

  function onMsg(msg) {
    if (msg.type === 'token') {
      textEl.textContent += msg.token;
      charCount += msg.token.length;
      footerEl.textContent = charCount + ' chars received...';
      const nearBottom = replyEl.scrollHeight - replyEl.scrollTop - replyEl.clientHeight < 80;
      if (nearBottom) replyEl.scrollTop = replyEl.scrollHeight;
    } else if (msg.type === 'done') {
      cursorEl.style.display = 'none';
      statusEl.textContent = '✅ Complete — ' + charCount + ' chars';
      footerEl.textContent = 'Done.';
    }
  }

  window.onmessage = (e) => { if (e.data && e.data.sig === SIG && e.data.channel === 'replystream') onMsg(e.data.msg); };
  window._ready = true;
  <\/script></body></html>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  3. Shared pump + blob-URL lifecycle helpers
 *  ────────────────────────────────────────────────────────────────────────── */

// Unguessable per-popup token. The popups post/receive over a wildcard target
// origin (a blob: popup's origin is implementation-defined — sometimes opaque —
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
// duplicates), and removes itself once the window is closed — so a registry
// entry for an active recording can't accumulate dead listeners from repeated
// opens before the LRU eviction would catch it.
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

function revokeOnLoad(win, url) {
  // Free the blob URL once the popup has parsed it (with a safety fallback).
  try { win.addEventListener('load', () => { try { URL.revokeObjectURL(url); } catch (_) {} }); } catch (_) {}
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
}

function pumpToWindow(win, log, channel, sig) {
  const pump = () => {
    try {
      if (win.closed) return;
      if (win._ready) {
        log.meta.forEach(line =>
          win.postMessage({ channel, sig, msg: { type: 'meta', line } }, '*')
        );
        log.parts.forEach((part, idx) => {
          if (part !== undefined) {
            win.postMessage({ channel, sig, msg: {
              type: 'text', chunkIndex: idx,
              text: part.text, startSec: part.startSec, endSec: part.endSec,
              hasSeg: part.hasSeg
            }}, '*');
          }
        });
        attachWindowListener(log, win, channel, sig);
        return;
      }
    } catch (_) {}
    setTimeout(pump, 80);
  };
  pump();
}

/* ──────────────────────────────────────────────────────────────────────────
 *  4. Live-status bar — a clickable progress indicator injected into the
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

  const main = document.createElement('div');
  main.className = 'live-status-main';
  main.innerHTML = `<span class="dot"></span><span class="live-status-text"></span>`;
  main.querySelector('.live-status-text').textContent = initialText;
  if (onClick) main.addEventListener('click', onClick);
  bar.appendChild(main);

  if (onCancel) {
    const x = document.createElement('button');
    x.className = 'live-status-cancel';
    x.textContent = '✕';
    x.title = 'Cancel';
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
