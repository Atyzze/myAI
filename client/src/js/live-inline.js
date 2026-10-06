import { createLiveLogRenderer, createReplyRenderer } from './live-render.js';

const OVERLAY_ID = 'liveInlineOverlay';

let _open = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
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

export function openInlineLiveView({ key, kind, title, accent, subscribe, decorate = null }) {
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

    const onMessage = msg => {
        try { renderer.handle(msg); } catch (error) { console.error('Live view render failed:', error); }
    };

    const focusableIn = root => [...root.querySelectorAll(
        'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    )].filter(node => !node.hidden && node.offsetParent !== null);

    const onKeyDown = event => {
        if (event.key === 'Escape' || event.key === 'Esc') { closeInlineLiveView(); return; }
        if (event.key !== 'Tab') return;
        const focusable = focusableIn(panel);
        if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        else if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);

    overlay.className = 'live-inline open';
    overlay.setAttribute('aria-hidden', 'false');
    try { panel.focus(); } catch (_) {}

    const unsubscribe = subscribe(onMessage);

    // Extra controls a caller lays over this view (auto-scroll on an opened text); removed on close.
    let undecorate = null;
    if (typeof decorate === 'function') {
        try {
            undecorate = decorate({
                doc: document, panel, scroller: body, footer,
                textEl: body.firstChild || body
            });
        } catch (error) {
            console.warn('Live view controls could not be added:', error);
        }
    }

    const handle = { key, close: () => closeInlineLiveView() };
    _open = { key, unsubscribe, overlay, returnFocus, onKeyDown, handle, undecorate };
    return handle;
}

export function closeInlineLiveView() {
    const current = _open;
    if (!current) return false;
    _open = null;

    try { current.unsubscribe?.(); } catch (_) {}
    try { current.undecorate?.(); } catch (_) {}
    try { document.removeEventListener('keydown', current.onKeyDown); } catch (_) {}
    current.overlay.className = 'live-inline';
    current.overlay.setAttribute('aria-hidden', 'true');
    try { current.returnFocus?.focus?.(); } catch (_) {}
    return true;
}

export function inlineLiveViewKey() {
    return _open ? _open.key : null;
}
