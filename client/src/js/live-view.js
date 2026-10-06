// Kept only for tabs of Build 128 and earlier that are still open when a newer build is put on the
// server: their pop-ups load this script from the network (a pop-up page is not served by the
// service worker), and without it every live view they open fails to start. Build 129 and later
// load no script into a pop-up (live-tabs.js), so nothing of theirs imports this file and the
// offline shell does not carry it. It can be removed once no tab of Build 128 can still be open.
import { createLiveLogRenderer, createReplyRenderer } from './live-render.js';

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

function listen(channel, sig, onMsg) {
    window.addEventListener('message', event => {
        const data = event.data;
        if (!data || data.sig !== sig || data.channel !== channel) return;
        if (!data.msg || typeof data.msg.type !== 'string') return;
        onMsg(data.msg);
    });
}

function announceReady(sig) {
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

    announceReady(config.sig);
}
