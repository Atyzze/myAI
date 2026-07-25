/* ==========================================================================
 *  live-inline.js - The SAME live views as the popups, rendered inside this
 *                   tab instead of a second window.
 *
 *  WHY THIS FILE EXISTS
 *  The popup live views cannot work on a phone, and the reason is structural
 *  rather than a bug that can be patched in place:
 *
 *    1. The popup holds no data. Every token reaches it by postMessage from the
 *       opener, which is the tab running the fetch stream.
 *    2. On mobile, window.open() gives the new tab the foreground and pushes the
 *       opener into the background, where timers are throttled and the tab can
 *       be suspended outright. The window on screen is therefore fed by a window
 *       the system just stopped running.
 *    3. The readiness handshake compounded it: the opener polled a property ON
 *       the popup (win._ready), and WebKit hands some blob: popups an origin the
 *       opener may not touch, so that read throws and the handshake gave up
 *       silently while the popup still showed its "Generating..." placeholder.
 *
 *  An in-page panel removes all three: one tab, no cross-window property access,
 *  no postMessage hop, nothing to background. It subscribes to the live registry
 *  through the callback handed in by live-tabs.js and renders with the shared
 *  renderers, so the popup and the panel show exactly the same thing.
 *
 *  Presentation only lives here. The panel never touches the network, the job
 *  registry or IndexedDB: closing it cancels nothing, exactly like closing the
 *  popup, because the work belongs to the recording and not to the view.
 *  ========================================================================== */
import { createLiveLogRenderer, createReplyRenderer } from './live-render.js';

const OVERLAY_ID = 'liveInlineOverlay';

/* One panel at a time. Opening a different live view replaces the current one,
   which matches the popup behaviour (a named window is re-navigated, not
   duplicated) and keeps exactly one registry subscription alive. */
let _open = null;   // { key, unsubscribe, overlay, returnFocus, onKeyDown }

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, never innerHTML: recording titles are user-influenced.
    if (text !== undefined) node.textContent = text;
    return node;
}

function buildOverlay() {
    const overlay = el('div', 'live-inline');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-hidden', 'true');

    const panel = el('div', 'live-inline-panel');
    panel.setAttribute('tabindex', '-1');

    const head = el('div', 'live-inline-head');
    const title = el('div', 'live-inline-title');
    const close = el('button', 'live-inline-close', '✕');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close live view');
    head.appendChild(title);
    head.appendChild(close);

    const status = el('div', 'live-inline-status');
    const body   = el('div', 'live-inline-body');
    const footer = el('div', 'live-inline-foot');

    panel.appendChild(head);
    panel.appendChild(status);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    close.addEventListener('click', () => closeInlineLiveView());
    // Tapping the backdrop closes; tapping inside the panel must not.
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeInlineLiveView();
    });

    return { overlay, panel, title, status, body, footer };
}

function parts() {
    const existing = document.getElementById(OVERLAY_ID);
    if (!existing) return buildOverlay();
    const find = cls => existing.querySelector(`.${cls}`);
    return {
        overlay: existing,
        panel:   find('live-inline-panel'),
        title:   find('live-inline-title'),
        status:  find('live-inline-status'),
        body:    find('live-inline-body'),
        footer:  find('live-inline-foot')
    };
}

function clear(node) {
    if (node) node.textContent = '';
}

/**
 * Show a live view inside this document.
 *
 * @param {object}   view
 * @param {string}   view.key        Identity of the view, e.g. `replystream-12`.
 * @param {string}   view.kind       'replystream' | 'livelog'
 * @param {string}   view.title      Plain text; rendered with textContent.
 * @param {string}   view.accent     CSS colour for the title and cursor.
 * @param {Function} view.subscribe  fn(onMessage) => unsubscribe. Must replay
 *                                   everything already buffered before it
 *                                   returns, exactly like the popup handshake.
 * @returns {{key: string, close: Function}} handle for the caller.
 */
export function openInlineLiveView({ key, kind, title, accent, subscribe }) {
    if (_open && _open.key === key) return _open.handle;
    if (_open) closeInlineLiveView();

    const { overlay, panel, title: titleEl, status, body, footer } = parts();
    const returnFocus = document.activeElement;

    titleEl.textContent = title || 'Live view';
    if (accent) titleEl.style.color = accent;
    clear(body);

    let renderer;
    if (kind === 'replystream') {
        const reply  = el('div', 'live-inline-reply');
        const text   = el('span', 'live-inline-text');
        const cursor = el('span', 'live-inline-cursor');
        if (accent) cursor.style.background = accent;
        reply.appendChild(text);
        reply.appendChild(cursor);
        body.appendChild(reply);
        status.textContent = '⏳ Generating...';
        footer.textContent = 'Waiting for tokens...';
        renderer = createReplyRenderer({
            replyEl: reply, textEl: text, cursorEl: cursor, statusEl: status, footerEl: footer
        });
    } else {
        const transcript = el('div', 'live-inline-transcript');
        body.appendChild(transcript);
        status.textContent = '⏳ Processing...';
        footer.textContent = 'Starting...';
        renderer = createLiveLogRenderer({
            transcriptEl: transcript, statusEl: status, footerEl: footer
        });
    }

    // A throwing renderer must not tear the subscription down mid-stream: the
    // registry would keep a listener that always fails. Contain it per message.
    const onMessage = msg => {
        try { renderer.handle(msg); } catch (error) { console.error('Live view render failed:', error); }
    };

    const onKeyDown = event => {
        if (event.key === 'Escape' || event.key === 'Esc') closeInlineLiveView();
    };
    document.addEventListener('keydown', onKeyDown);

    overlay.className = 'live-inline open';
    overlay.setAttribute('aria-hidden', 'false');
    try { panel.focus(); } catch (_) {}

    // subscribe() replays the buffer synchronously, so the panel is fully
    // populated before this function returns even for a stream already running.
    const unsubscribe = subscribe(onMessage);

    const handle = { key, close: () => closeInlineLiveView() };
    _open = { key, unsubscribe, overlay, returnFocus, onKeyDown, handle };
    return handle;
}

/** Close the panel, if one is open. Safe to call at any time. */
export function closeInlineLiveView() {
    const current = _open;
    if (!current) return false;
    _open = null;

    try { current.unsubscribe?.(); } catch (_) {}
    try { document.removeEventListener('keydown', current.onKeyDown); } catch (_) {}
    current.overlay.className = 'live-inline';
    current.overlay.setAttribute('aria-hidden', 'true');
    try { current.returnFocus?.focus?.(); } catch (_) {}
    return true;
}

/** Which view is on screen, or null. Used by live-tabs.js to avoid reopening. */
export function inlineLiveViewKey() {
    return _open ? _open.key : null;
}
