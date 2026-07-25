/* ==========================================================================
 *  live-view.js - Behaviour for the live transcript-log and reply-stream POPUP
 *  documents opened by live-tabs.js.
 *
 *  WHY THIS FILE EXISTS
 *  The popup documents used to carry their script INLINE. A blob: document
 *  inherits the CSP of the document that created it, and index.html ships
 *  `script-src 'self' blob:` with no 'unsafe-inline', so the browser refused to
 *  execute that script. The popup then never set its ready flag, the opener's
 *  handshake loop spun forever, and the window sat on "Waiting for tokens..."
 *  with nothing ever rendered.
 *
 *  An EXTERNAL same-origin module satisfies `script-src 'self'` (a blob:
 *  document opened from this origin keeps this origin), so the popup works
 *  without weakening the policy. It also lets the popup import shared code
 *  instead of having source text injected into it.
 *
 *  Configuration is read from a data attribute rather than a second inline
 *  script, so no part of the popup depends on inline execution.
 *
 *  WHAT IS LEFT HERE
 *  Only the popup-specific plumbing: read the config, wire postMessage to a
 *  renderer, and announce readiness. The rendering itself lives in
 *  live-render.js because the in-page panel (live-inline.js) must produce an
 *  identical view without a second window.
 *  ========================================================================== */
import { createLiveLogRenderer, createReplyRenderer } from './live-render.js';

/* Readiness announcements. The opener used to poll a property on this window,
   which is a cross-window read: WebKit gives some blob: popups an origin the
   opener cannot touch, so the read throws SecurityError and the handshake gave
   up in silence behind a convincing "Generating..." placeholder. A message
   crosses that boundary. It also needs no timer on the opener side, which
   matters on mobile, where opening this window backgrounds the opener and its
   polling timer is throttled or suspended.

   Repeated because the opener registers its listener when it opens this window,
   and a document restored from the back/forward cache boots without a fresh
   open. The opener ignores duplicates. */
const READY_ANNOUNCE_MS = [0, 200, 800];

function readConfig() {
    try {
        const raw = document.body && document.body.dataset
            ? document.body.dataset.liveConfig
            : '';
        const parsed = JSON.parse(raw || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.channel !== 'livelog' && parsed.channel !== 'replystream') return null;
        if (typeof parsed.sig !== 'string' || !parsed.sig) return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

/* Accept ONLY messages carrying this popup's unguessable per-open token, on its
   own channel. The popups exchange messages over a wildcard target origin (a
   blob: popup's origin is implementation-defined in places), so the token is
   what actually authenticates the sender. */
function listen(channel, sig, onMsg) {
    window.addEventListener('message', event => {
        const data = event.data;
        if (!data || data.sig !== sig || data.channel !== channel) return;
        if (!data.msg || typeof data.msg.type !== 'string') return;
        onMsg(data.msg);
    });
}

function announceReady(sig) {
    // Kept as the fallback path for a window whose opener reference was
    // stripped, and as the flag the opener's bounded poll still looks for.
    window._ready = true;
    const tell = () => {
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({ liveReady: true, sig }, '*');
            }
        } catch (_) {}
    };
    for (const delay of READY_ANNOUNCE_MS) {
        if (delay === 0) tell();
        else setTimeout(tell, delay);
    }
}

const config = readConfig();
if (config) {
    const statusEl = document.getElementById('status');
    const footerEl = document.getElementById('footer');
    const renderer = config.channel === 'livelog'
        ? createLiveLogRenderer({
            transcriptEl: document.getElementById('transcript'),
            statusEl,
            footerEl
        })
        : createReplyRenderer({
            replyEl:  document.getElementById('reply'),
            textEl:   document.getElementById('text'),
            cursorEl: document.getElementById('cursor'),
            statusEl,
            footerEl
        });

    listen(config.channel, config.sig, msg => renderer.handle(msg));

    // Announced only after the message listener above is actually attached, so
    // the opener's replay of everything already buffered cannot be missed.
    announceReady(config.sig);
}
