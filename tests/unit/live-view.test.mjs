/* Live transcript-log / reply-stream popup contracts.
 *
 * This module had ZERO coverage, which is how a CSP change silently broke every
 * live view: the popup documents carried an inline <script>, blob: documents
 * inherit the opener's CSP, and `script-src 'self' blob:` refuses inline script.
 * The window opened and then displayed nothing, forever.
 *
 * Run from the repository root:
 *   node tests/unit/live-view.test.mjs
 */
import { emitTestResult } from '../helpers/test-result.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

/* ── Minimal browser shim (no jsdom, no dependencies) ────────────────────── */
const openedWindows = [];

function makeFakeWindow(name) {
    return {
        name,
        closed: false,
        _ready: false,
        posted: [],
        listeners: {},
        document: { elements: {}, getElementById(id) { return this.elements[id] || null; } },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        postMessage(data) { this.posted.push(data); }
    };
}

globalThis.self = globalThis;
globalThis.URL.createObjectURL = () => `blob:http://localhost/${Math.random().toString(16).slice(2)}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = {
    open(_url, name) {
        // Real window.open re-navigates an EXISTING window with the same name and
        // returns it, rather than creating a second one. The listener bookkeeping
        // depends on that, so the shim reproduces it.
        const existing = openedWindows.find(w => w.name === name && !w.closed);
        if (existing) { existing._ready = false; existing.posted.length = 0; return existing; }
        const win = makeFakeWindow(name);
        openedWindows.push(win);
        return win;
    }
};

const live = await import('../../src/js/live-tabs.js');

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function ready(win) {
    win._ready = true;
    await tick(140);            // let the 80 ms handshake poll fire
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-CSP-001 - the generated documents must not rely on inline script.
 * This is the exact invariant the reported bug violated.
 * ────────────────────────────────────────────────────────────────────────── */
// Capture the documents by intercepting Blob construction instead of guessing.
const RealBlob = globalThis.Blob;
const capturedHtml = [];
globalThis.Blob = class extends RealBlob {
    constructor(parts, options) {
        super(parts, options);
        if (options?.type === 'text/html') capturedHtml.push(String(parts[0]));
    }
};

live.liveLogInit(201);
live.openLiveLogTab(201, 'note-2.wav');
live.replyStreamInit(202);
live.openReplyStreamTab(202, 'note-3.wav');
ok(capturedHtml.length === 2, 'both popup documents were generated');

for (const html of capturedHtml) {
    const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
    ok(scriptTags.length > 0, 'popup document loads a script');
    for (const tag of scriptTags) {
        ok(/\ssrc\s*=/.test(tag),
           'every popup <script> is external, so it is allowed by script-src \'self\'');
    }
    ok(!/<script[^>]*>\s*[^<\s]/.test(html.replace(/<script[^>]*src=[^>]*>/gi, '')),
       'popup document contains no inline script body');
    ok(!/\son[a-z]+\s*=/i.test(html), 'popup document has no inline event attributes');
    ok(html.includes('src/js/live-view.js'), 'popup document loads the shared live-view module');
    ok(/data-live-config="/.test(html), 'popup configuration travels on a data attribute, not a script');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-ESCAPE-002 - a hostile recording title cannot break out of the document.
 * ────────────────────────────────────────────────────────────────────────── */
capturedHtml.length = 0;
live.openReplyStreamTab(203, `</title><script>window.__pwned=1</script>"'<img src=x onerror=alert(1)>`);
const hostile = capturedHtml[0];
// The payload may appear as inert TEXT; what must not happen is it appearing as
// markup. Exactly one script element may exist, and it must be the module tag.
const hostileScripts = hostile.match(/<script\b[^>]*>/gi) || [];
ok(hostileScripts.length === 1 && /\ssrc\s*=/.test(hostileScripts[0]),
   'a script payload in the title cannot introduce a second script element');
ok(!/<img\b/i.test(hostile), 'an element payload in the title is not emitted as markup');
ok(hostile.includes('&lt;img src=x onerror=alert(1)&gt;'),
   'an event-handler payload survives only as inert escaped text');
ok(hostile.includes('&lt;script&gt;'), 'angle brackets in the title are escaped');
ok(!/<\/title>[^]*<\/title>/.test(hostile), 'the title element cannot be terminated early');
const configAttr = hostile.match(/data-live-config="([^"]*)"/)?.[1] || '';
ok(configAttr.length > 0 && !configAttr.includes('"'), 'the config attribute cannot be terminated early');

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-STREAM-IDENTITY-003 - re-initialising a stream must NOT orphan a popup
 * that is already attached to it.
 *
 * This is the second half of the reported bug: gui.js/auto-pipeline.js call
 * replyStreamInit() on the button press and reply.js calls it again inside
 * runSummary(), so a popup opened in between was wired to a discarded object and
 * silently received nothing.
 * ────────────────────────────────────────────────────────────────────────── */
{
    live.replyStreamInit(301);
    const win = live.openReplyStreamTab(301, 'reply.wav');
    await ready(win);
    win.posted.length = 0;

    live.replyStreamInit(301);                       // the second init, mid-open
    live.replyStreamAppend(301, 'Hello ');
    live.replyStreamAppend(301, 'world!');
    live.replyStreamDone(301);

    const tokens = win.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(tokens === 'Hello world!', 'tokens still reach a popup opened before the stream was re-initialised');
    ok(win.posted.some(m => m.msg.type === 'done'), 'completion still reaches that popup');
    ok(win.posted.some(m => m.msg.type === 'reset'), 're-initialisation tells the popup to clear the previous answer');
    ok(win.posted.every(m => m.channel === 'replystream'), 'every message is tagged with its channel');
    ok(new Set(win.posted.map(m => m.sig)).size === 1, 'every message carries the same per-popup token');
}

/* Same invariant for the transcript log, which gui.js clears on every Scribe. */
{
    live.liveLogInit(302);
    const win = live.openLiveLogTab(302, 'scribe.wav');
    await ready(win);
    win.posted.length = 0;

    live.liveLogClear(302);
    live.liveLogText(302, 0, 'first chunk', 0, 60, true);
    live.liveLogAppend(302, '✅ Done - 11 chars total');

    ok(win.posted.some(m => m.msg.type === 'text' && m.msg.text === 'first chunk'),
       'transcript chunks still reach a popup opened before the log was cleared');
    ok(win.posted.some(m => m.msg.type === 'meta'), 'meta lines still reach that popup');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-REPLAY-004 - a popup opened LATE receives everything already buffered.
 * ────────────────────────────────────────────────────────────────────────── */
{
    live.replyStreamInit(401);
    live.replyStreamAppend(401, 'already ');
    live.replyStreamAppend(401, 'streamed');
    const win = live.openReplyStreamTab(401, 'late.wav');
    await ready(win);
    const replayed = win.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(replayed === 'already streamed', 'buffered tokens are replayed on open');
    ok(!win.posted.some(m => m.msg.type === 'done'), 'an unfinished stream is not reported as complete');

    live.replyStreamDone(401);
    ok(win.posted.some(m => m.msg.type === 'done'), 'completion after open is forwarded live');
}

{
    live.liveLogInit(402);
    live.liveLogAppend(402, '▶️ Starting server transcription');
    live.liveLogText(402, 1, 'second', 60, 120, false);
    live.liveLogText(402, 0, 'first', 0, 60, false);
    const win = live.openLiveLogTab(402, 'late-log.wav');
    await ready(win);
    const texts = win.posted.filter(m => m.msg.type === 'text');
    ok(texts.length === 2, 'every buffered chunk is replayed exactly once');
    ok(texts[0].msg.chunkIndex === 0 && texts[1].msg.chunkIndex === 1,
       'chunks are replayed in index order regardless of arrival order');
    ok(texts[0].msg.hasSeg === false, 'the explicit segment-timestamp flag survives replay');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-DONE-005 - completion is idempotent (reply.js signals it on the success,
 * abort and error paths).
 * ────────────────────────────────────────────────────────────────────────── */
{
    live.replyStreamInit(501);
    const win = live.openReplyStreamTab(501, 'idem.wav');
    await ready(win);
    win.posted.length = 0;
    live.replyStreamDone(501);
    live.replyStreamDone(501);
    live.replyStreamDone(501);
    ok(win.posted.filter(m => m.msg.type === 'done').length === 1,
       'repeated completion signals produce exactly one done message');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-LISTENER-006 - reopening a live view must replace its listener, and a
 * closed window's listener must be dropped rather than accumulating.
 * ────────────────────────────────────────────────────────────────────────── */
{
    live.replyStreamInit(601);
    const first = live.openReplyStreamTab(601, 'dup.wav');
    await ready(first);
    const second = live.openReplyStreamTab(601, 'dup.wav');
    ok(second === first, 'reopening a live view returns the same named window');
    await ready(second);
    second.posted.length = 0;

    live.replyStreamAppend(601, 'once');
    ok(second.posted.filter(m => m.msg.type === 'token').length === 1,
       'reopening replaces the listener instead of stacking duplicates');

    second.closed = true;
    live.replyStreamAppend(601, 'ignored');
    second.closed = false;
    second.posted.length = 0;
    live.replyStreamAppend(601, 'after-close');
    ok(second.posted.length === 0, 'a closed window is detached and never posted to again');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-HANDSHAKE-007 - the readiness wait is bounded and fails visibly.
 * The original loop retried every 80 ms forever, so a popup that could never
 * boot showed a convincing "Generating..." placeholder indefinitely.
 * ────────────────────────────────────────────────────────────────────────── */
{
    live.replyStreamInit(701);
    const win = live.openReplyStreamTab(701, 'stuck.wav');
    win.document.elements.status = { textContent: '⏳ Generating...' };
    win.document.elements.footer = { textContent: 'Waiting for tokens...' };

    const realNow = Date.now;
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    Date.now = () => realNow() + 60000;      // jump past the readiness deadline
    await tick(200);
    Date.now = realNow;
    console.error = realError;

    ok(win.document.elements.status.textContent.includes('failed to start'),
       'a popup that never becomes ready is told so, instead of waiting forever');
    ok(/blocked or failed to load/i.test(win.document.elements.footer.textContent),
       'the failure explains what actually went wrong');
    ok(errors.length > 0, 'the failure is also reported to the opener console');

    win._ready = true;
    win.posted.length = 0;
    live.replyStreamAppend(701, 'late');
    ok(win.posted.length === 0, 'a timed-out popup is not silently re-attached later');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-LRU-008 - both registries stay bounded, and an entry is never evicted by
 * its own insertion.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const CAP = 30;
    const OLDEST = 9000;
    const NEWEST = 9000 + CAP + 4;

    live.replyStreamInit(OLDEST);
    live.replyStreamAppend(OLDEST, 'oldest-data');
    for (let i = 1; i <= CAP + 4; i++) live.replyStreamInit(9000 + i);
    live.replyStreamAppend(NEWEST, 'newest');

    // A recently touched entry keeps its buffer.
    const newest = live.openReplyStreamTab(NEWEST, 'newest.wav');
    await ready(newest);
    const newestTokens = newest.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(newestTokens === 'newest', 'a recently touched entry survives eviction with its buffer intact');

    // The oldest was evicted, so reopening it starts clean instead of resurrecting
    // a long-finished recording's reply text.
    const oldest = live.openReplyStreamTab(OLDEST, 'oldest.wav');
    await ready(oldest);
    const oldestTokens = oldest.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(oldestTokens === '', 'the oldest entry was evicted and reopens empty rather than stale');

    // Re-touching an entry must move it to the front of the eviction order.
    live.replyStreamInit(9001);
    live.replyStreamAppend(9001, 'kept-alive');
    for (let i = 0; i < CAP; i++) live.replyStreamInit(9500 + i);
    live.replyStreamAppend(9001, '-still-here');
    const revived = live.openReplyStreamTab(9001, 'touched.wav');
    await ready(revived);
    const revivedTokens = revived.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(revivedTokens.endsWith('-still-here'), 'an entry written to after eviction accepts new tokens');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-BLOCKED-009 - a blocked popup is handled, not thrown.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => null;          // browser blocked the popup
    live.replyStreamInit(801);
    ok(live.openReplyStreamTab(801, 'blocked.wav') === null, 'a blocked reply popup returns null');
    ok(live.openLiveLogTab(801, 'blocked.wav') === null, 'a blocked log popup returns null');
    live.replyStreamAppend(801, 'still fine');
    globalThis.window.open = realOpen;
    ok(true, 'the stream keeps working after a blocked popup');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-STATUS-010 - the in-row progress bar.
 *
 * This is the control users actually tap to open a live view, and it had no
 * coverage. A tiny DOM shim is enough: the module only creates elements, sets
 * attributes and inserts before a known anchor.
 * ────────────────────────────────────────────────────────────────────────── */
{
    class El {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase();
            this.className = '';
            this.id = '';
            this.children = [];
            this.attributes = {};
            this.handlers = {};
            this.textContent = '';
            this.parentNode = null;
        }
        setAttribute(k, v) { this.attributes[k] = String(v); }
        getAttribute(k) { return this.attributes[k] ?? null; }
        addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
        dispatch(type, event = {}) {
            for (const fn of this.handlers[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...event });
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        insertBefore(child, ref) {
            child.parentNode = this;
            const i = this.children.indexOf(ref);
            this.children.splice(i < 0 ? this.children.length : i, 0, child);
            return child;
        }
        remove() {
            if (!this.parentNode) return;
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
            this.parentNode = null;
        }
        set innerHTML(html) {
            // Only the fixed markup this module emits needs to be understood.
            this.children = [];
            for (const cls of (String(html).match(/class="([^"]+)"/g) || [])) {
                const span = new El('span');
                span.className = cls.slice(7, -1);
                this.appendChild(span);
            }
        }
        get innerHTML() { return ''; }
        querySelector(sel) { return this.descendants().find(el => `.${el.className}` === sel) || null; }
        descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
    }

    const registry = new Map();
    const container = new El('li');
    container.id = 'rec-77';
    const bottom = new El('div');
    bottom.id = 'bottom-actions-77';
    container.appendChild(bottom);
    registry.set('rec-77', container);
    registry.set('bottom-actions-77', bottom);

    globalThis.document = {
        createElement: tag => new El(tag),
        getElementById(id) {
            if (registry.has(id)) return registry.get(id);
            for (const root of registry.values()) {
                const found = root.descendants().find(el => el.id === id);
                if (found) return found;
            }
            return null;
        }
    };
    container.querySelector = sel => sel === '#bottom-actions-77' ? bottom : null;

    let clicks = 0, cancels = 0;
    const bar = live.showLiveStatus(77, 'reply', '🧠 Waiting…', () => clicks++, () => cancels++);
    ok(!!bar, 'showLiveStatus returns the created bar');
    ok(bar.id === 'live-status-reply-77', 'the bar is addressable per recording and job type');
    ok(bar.getAttribute('role') === 'status' && bar.getAttribute('aria-live') === 'polite',
       'the bar announces progress to assistive technology');
    ok(container.children.indexOf(bar) < container.children.indexOf(bottom),
       'the bar is inserted above the row action buttons');

    const main = bar.children.find(c => c.className === 'live-status-main');
    ok(main.getAttribute('role') === 'button' && main.getAttribute('tabindex') === '0',
       'the tap-to-watch target is focusable and exposed as a button');
    ok(/live reply view/.test(main.getAttribute('aria-label') || ''), 'the target describes what it opens');

    main.dispatch('click');
    ok(clicks === 1, 'clicking the bar opens the live view');
    main.dispatch('keydown', { key: 'Enter' });
    main.dispatch('keydown', { key: ' ' });
    ok(clicks === 3, 'Enter and Space open the live view without a pointer');
    main.dispatch('keydown', { key: 'a' });
    ok(clicks === 3, 'other keys do not open the live view');

    const cancel = bar.children.find(c => c.className === 'live-status-cancel');
    ok(cancel.tagName === 'BUTTON' && /Cancel reply job/.test(cancel.getAttribute('aria-label') || ''),
       'cancellation is a real labelled button');
    cancel.dispatch('click');
    ok(cancels === 1, 'the cancel control cancels the job');

    live.updateLiveStatus(77, 'reply', '⚡ Streaming…');
    ok(main.querySelector('.live-status-text').textContent === '⚡ Streaming…',
       'progress updates replace only the text');

    live.showLiveStatus(77, 'reply', 'second', () => {}, null);
    ok(container.children.filter(c => c.className?.startsWith('live-status')).length === 1,
       're-showing replaces the bar instead of stacking duplicates');

    live.removeLiveStatus(77, 'reply');
    ok(container.children.filter(c => c.className?.startsWith('live-status')).length === 0,
       'removal detaches the bar');
    live.removeLiveStatus(77, 'reply');
    live.updateLiveStatus(77, 'reply', 'gone');
    ok(true, 'removing or updating a missing bar is a safe no-op');

    ok(live.showLiveStatus(999, 'reply', 'x', () => {}) === null,
       'a status bar for a row that is not on screen is skipped, not thrown');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-INLINE-011 - on a touch device the live view renders IN THIS TAB.
 *
 * A popup cannot work on a phone: window.open() gives the new tab the
 * foreground and backgrounds the opener, which is the window holding the fetch
 * stream and posting every token across. The view on screen then waits on a
 * window the system has throttled, which is the reported "opens a tab and sits
 * on Generating forever" failure. The in-page panel has no second window, no
 * cross-origin access and nothing to background.
 * ────────────────────────────────────────────────────────────────────────── */
{
    /* A DOM shim with just enough behaviour for the panel and the renderers:
       element creation, text nodes, class lookup, events and focus. */
    class N {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase();
            this.className = '';
            this.id = '';
            this.children = [];
            this.attributes = {};
            this.handlers = {};
            this.style = {};
            this._text = '';
            this.parentNode = null;
            this.scrollHeight = 0;
            this.scrollTop = 0;
            this.clientHeight = 0;
        }
        get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
        set textContent(value) { this.children = []; this._text = String(value); }
        setAttribute(k, v) { this.attributes[k] = String(v); }
        getAttribute(k) { return this.attributes[k] ?? null; }
        addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
        removeEventListener(type, fn) {
            this.handlers[type] = (this.handlers[type] || []).filter(f => f !== fn);
        }
        dispatch(type, event = {}) {
            for (const fn of [...(this.handlers[type] || [])]) fn({ target: this, ...event });
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        focus() { globalThis.document.activeElement = this; }
        descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
        querySelector(sel) {
            const want = sel.replace(/^\./, '');
            return this.descendants().find(el => String(el.className).split(/\s+/).includes(want)) || null;
        }
    }

    const body = new N('body');
    const docHandlers = {};
    globalThis.document = {
        body,
        activeElement: null,
        createElement: tag => new N(tag),
        createTextNode(text) { const n = new N('#text'); n._text = String(text); return n; },
        getElementById(id) {
            return [body, ...body.descendants()].find(el => el.id === id) || null;
        },
        addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
        removeEventListener(type, fn) { docHandlers[type] = (docHandlers[type] || []).filter(f => f !== fn); },
        dispatch(type, event = {}) { for (const fn of [...(docHandlers[type] || [])]) fn(event); }
    };

    const asTouchDevice = () => { globalThis.window.matchMedia = query => ({ matches: /coarse/.test(query), media: query }); };
    const asDesktop     = () => { globalThis.window.matchMedia = query => ({ matches: false, media: query }); };
    asTouchDevice();

    live.replyStreamInit(901);
    live.replyStreamAppend(901, 'buffered ');

    const windowsBefore = openedWindows.length;
    const handle = live.openReplyStreamTab(901, 'phone.wav');
    ok(openedWindows.length === windowsBefore, 'a touch device opens no second window');
    ok(handle && handle.key === 'replystream-901', 'the in-page panel is returned instead of a window');

    const inline = await import('../../src/js/live-inline.js');
    ok(inline.inlineLiveViewKey() === 'replystream-901', 'the panel reports which view is on screen');

    const overlay = globalThis.document.getElementById('liveInlineOverlay');
    ok(!!overlay, 'the panel is attached to the document');
    ok(String(overlay.className).split(/\s+/).includes('open'), 'the panel is visible');
    ok(overlay.getAttribute('aria-hidden') === 'false' && overlay.getAttribute('role') === 'dialog',
       'the panel is exposed to assistive technology as an open dialog');
    ok(globalThis.document.activeElement === overlay.querySelector('.live-inline-panel'),
       'focus moves into the panel');

    const textEl = overlay.querySelector('.live-inline-text');
    ok(textEl.textContent === 'buffered ', 'the panel replays what was already streamed');

    live.replyStreamAppend(901, 'live');
    ok(textEl.textContent === 'buffered live', 'later tokens render with no window and no postMessage hop');

    live.replyStreamDone(901);
    ok(/Complete/.test(overlay.querySelector('.live-inline-status').textContent),
       'completion is reported in the panel');

    /* Throughput and model reach a view opened LATE, because the registry
       measures them rather than the view counting the messages it happens to
       receive. */
    live.replyStreamInit(906);
    live.replyStreamModel(906, 'gemma4:e4b');
    for (let i = 0; i < 5; i++) live.replyStreamAppend(906, 'tok ');
    const lateHandle = live.openReplyStreamTab(906, 'late.wav');
    const lateOverlay = globalThis.document.getElementById('liveInlineOverlay');
    ok(/5 tok/.test(lateOverlay.querySelector('.live-inline-foot').textContent),
       'a late view is told how many tokens have already arrived');
    ok(/gemma4:e4b/.test(lateOverlay.querySelector('.live-inline-status').textContent),
       'a late view is told which model is answering');
    lateHandle.close();

    // The recording title is rendered as text, never as markup.
    live.replyStreamInit(902);
    const hostileHandle = live.openReplyStreamTab(902, '<img src=x onerror=alert(1)>');
    const titleEl = overlay.querySelector('.live-inline-title');
    ok(titleEl.textContent.includes('<img src=x onerror=alert(1)>') && titleEl.children.length === 0,
       'a hostile recording title stays inert text in the panel');
    ok(live.openReplyStreamTab(902, 'again.wav') === hostileHandle,
       'reopening the same view returns the panel already on screen');

    // Escape closes, and closing must detach the registry subscription.
    globalThis.document.dispatch('keydown', { key: 'Escape' });
    ok(overlay.getAttribute('aria-hidden') === 'true', 'Escape closes the panel');
    const textAtClose = textEl.textContent;
    live.replyStreamInit(902);
    live.replyStreamAppend(902, 'after-close');
    ok(textEl.textContent === textAtClose, 'a closed panel is unsubscribed rather than left listening');

    // The transcript log uses the same path.
    live.liveLogInit(903);
    live.liveLogText(903, 0, 'hello from the log', 0, 60, false);
    const logHandle = live.openLiveLogTab(903, 'phone-log.wav');
    const transcript = globalThis.document.getElementById('liveInlineOverlay').querySelector('.live-inline-transcript');
    ok(/hello from the log/.test(transcript.textContent), 'the transcript log renders in page too');
    live.liveLogAppend(903, '✅ Done - 18 chars total');
    ok(/Complete/.test(overlay.querySelector('.live-inline-status').textContent),
       'the log reports completion in the panel');
    logHandle.close();

    // Desktop keeps the popup, but a BLOCKED popup still has somewhere to go.
    asDesktop();
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => null;
    live.replyStreamInit(904);
    const fallback = live.openReplyStreamTab(904, 'blocked.wav');
    ok(fallback && fallback.key === 'replystream-904',
       'a blocked popup falls back to the in-page panel instead of showing nothing');
    fallback.close();
    globalThis.window.open = realOpen;

    ok(inline.inlineLiveViewKey() === null && inline.closeInlineLiveView() === false,
       'closing when no panel is open is a safe no-op');

    live.replyStreamInit(905);
    const desktopWindow = live.openReplyStreamTab(905, 'desktop.wav');
    ok(openedWindows.includes(desktopWindow), 'desktop still opens a real popup window');
    desktopWindow.closed = true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-RENDER-012 - the renderers are shared, so both views agree.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const render = await import('../../src/js/live-render.js');
    const make = () => globalThis.document.createElement('div');
    const replyEl = make(), textEl = make(), cursorEl = make(), statusEl = make(), footerEl = make();
    const renderer = render.createReplyRenderer({ replyEl, textEl, cursorEl, statusEl, footerEl });

    renderer.handle({ type: 'token', token: 'one ', count: 1, elapsedMs: 0 });
    ok(footerEl.textContent === '4 chars · 1 tok',
       'a single token has no interval to divide by, so no rate is invented');

    renderer.handle({ type: 'token', token: 'two', count: 2, elapsedMs: 500 });
    ok(textEl.textContent === 'one two', 'tokens append in order');
    ok(footerEl.textContent === '7 chars · 2 tok · 4.0 tok/s',
       'characters, tokens and throughput all follow the stream');

    /* The counts come from the registry, which sees every append. A view opened
       late is handed the whole buffer in ONE message, so counting messages here
       would report a finished answer as a single token at an absurd rate. */
    const lateFooter = make(), lateStatus = make();
    const late = render.createReplyRenderer({
        replyEl: make(), textEl: make(), cursorEl: make(),
        statusEl: lateStatus, footerEl: lateFooter
    });
    late.handle({ type: 'model', model: 'gemma4:e4b' });
    late.handle({ type: 'token', token: 'x'.repeat(240), count: 60, elapsedMs: 1000 });
    ok(lateFooter.textContent === '240 chars · 60 tok · 60.0 tok/s',
       'a view opened mid-stream reports the real totals, not one replayed message');
    ok(lateStatus.textContent === '⏳ Generating - gemma4:e4b',
       'a view opened mid-stream knows which model is answering');

    renderer.handle({ type: 'model', model: 'gemma4:e4b' });
    ok(/gemma4:e4b/.test(statusEl.textContent) && !/\.\.\. - /.test(statusEl.textContent),
       'the model name replaces the trailing ellipsis in the status line');

    renderer.handle({ type: 'done' });
    ok(cursorEl.style.display === 'none' && /7 chars/.test(statusEl.textContent),
       'completion hides the cursor and reports the final size');
    ok(/gemma4:e4b/.test(statusEl.textContent), 'the finished view still names the model that answered');
    ok(footerEl.textContent === '7 chars · 2 tok · 4.0 tok/s',
       'the final throughput stays on screen instead of being replaced by a word');

    renderer.handle({ type: 'reset' });
    ok(textEl.textContent === '' && cursorEl.style.display === '',
       'a re-initialised stream clears the previous answer instead of appending to it');
    ok(footerEl.textContent === 'Waiting for tokens...',
       'the counters reset with the answer');
}

/* ──────────────────────────────────────────────────────────────────────────
 * LIVE-HANDSHAKE-013 - a popup the opener may not INSPECT still gets attached.
 *
 * The handshake used to read win._ready, which is a cross-window property read.
 * WebKit gives some blob: popups an origin this window cannot touch, so that
 * read throws SecurityError, the poll swallowed it, and the handshake expired in
 * silence while the popup still displayed its "Generating..." placeholder. The
 * popup now announces itself by postMessage, which crosses that boundary.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const hostile = makeFakeWindow('replystream-950');
    Object.defineProperty(hostile, '_ready', {
        get() { throw new Error('SecurityError: blocked a frame with a different origin'); },
        configurable: true
    });

    const messageListeners = [];
    globalThis.window.addEventListener = (type, fn) => { if (type === 'message') messageListeners.push(fn); };

    const realOpen = globalThis.window.open;
    globalThis.window.open = () => hostile;
    capturedHtml.length = 0;
    live.replyStreamInit(950);
    live.replyStreamAppend(950, 'before-handshake ');
    live.openReplyStreamTab(950, 'webkit.wav');
    globalThis.window.open = realOpen;

    ok(messageListeners.length === 1, 'the opener listens for readiness messages');
    await tick(200);
    ok(hostile.posted.length === 0, 'polling alone cannot attach a popup it may not inspect');

    const attr = capturedHtml[0].match(/data-live-config="([^"]*)"/)?.[1] || '';
    const config = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    ok(typeof config.sig === 'string' && config.sig.length > 0, 'the popup was handed a readiness token');

    messageListeners[0]({ data: { liveReady: true, sig: config.sig } });
    const replayed = hostile.posted.filter(m => m.msg.type === 'token').map(m => m.msg.token).join('');
    ok(replayed === 'before-handshake ', 'the announcement replays what polling could not deliver');

    live.replyStreamAppend(950, 'and-more');
    ok(hostile.posted.some(m => m.msg.type === 'token' && m.msg.token === 'and-more'),
       'later tokens flow once the handshake completed by message');

    const settledCount = hostile.posted.length;
    messageListeners[0]({ data: { liveReady: true, sig: config.sig } });
    ok(hostile.posted.length === settledCount, 'repeated announcements do not re-replay the buffer');
    messageListeners[0]({ data: { liveReady: true, sig: 'a-token-from-somewhere-else' } });
    ok(hostile.posted.length === settledCount, 'an announcement carrying an unknown token is ignored');
    messageListeners[0]({ data: null });
    ok(hostile.posted.length === settledCount, 'a malformed message is ignored rather than thrown');
}

globalThis.Blob = RealBlob;
console.log(`✓ all ${assertions} live-view assertions passed`);
emitTestResult('live-view-unit', 'pass', { assertions });
// Deliberately opened popups leave their bounded readiness poll pending, which
// would otherwise hold the event loop open for the length of that timeout.
process.exit(0);
