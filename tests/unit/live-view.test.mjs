import { emitTestResult } from '../helpers/test-result.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

const openedWindows = [];

// Just enough of a DOM for the renderers: element and text nodes, children, text, scrolling.
class PopupNode {
    constructor(doc, tag, text = '') {
        this.ownerDocument = doc;
        this.tagName = String(tag).toUpperCase();
        this.nodeType = tag === '#text' ? 3 : 1;
        this._text = text;
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.id = '';
        this.style = {};
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.clientHeight = 0;
    }
    get length() { return this._text.length; }
    appendData(text) { this._text += text; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get textContent() { return this.nodeType === 3 ? this._text : this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.children = [];
        if (this.nodeType === 3) { this._text = String(value); return; }
        if (String(value)) this.appendChild(new PopupNode(this.ownerDocument, '#text', String(value)));
    }
    appendChild(child) {
        if (child.parentNode) child.remove();
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, ref) {
        if (child.parentNode) child.remove();
        child.parentNode = this;
        const at = this.children.indexOf(ref);
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        return child;
    }
    remove() {
        if (!this.parentNode) return;
        const at = this.parentNode.children.indexOf(this);
        if (at >= 0) this.parentNode.children.splice(at, 1);
        this.parentNode = null;
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

// The page a pop-up shows once its HTML has been parsed: the elements live-tabs.js writes into it.
function parsedPopupDocument(html) {
    const doc = {
        html,
        createElement: tag => new PopupNode(doc, tag),
        createTextNode: text => new PopupNode(doc, '#text', String(text)),
        getElementById(id) { return [doc.body, ...doc.body.descendants()].find(node => node.id === id) || null; }
    };
    doc.body = new PopupNode(doc, 'body');
    for (const id of ['status', 'transcript', 'reply', 'text', 'cursor', 'footer']) {
        if (!new RegExp(`id="${id}"`).test(html)) continue;
        const node = new PopupNode(doc, id === 'text' || id === 'cursor' ? 'span' : 'div');
        node.id = id;
        const initial = html.match(new RegExp(`<div id="${id}">([^<]*)</div>`));
        if (initial) node.textContent = initial[1];
        doc.body.appendChild(node);
    }
    return doc;
}

function blankDocument() {
    const doc = { getElementById: () => null };
    doc.body = new PopupNode(doc, 'body');
    return doc;
}

// A window as window.open returns it: it shows a blank page until its own page has loaded, which
// the test does with load(). Anything posted to it is recorded, so a test can show nothing is.
function makeFakeWindow(name) {
    return {
        name,
        closed: false,
        posted: [],
        html: '',
        document: blankDocument(),
        frames: [],
        addEventListener() {},
        requestAnimationFrame(fn) { this.frames.push(fn); },
        postMessage(data) { this.posted.push(data); },
        load() { this.document = parsedPopupDocument(this.html); }
    };
}

const htmlByUrl = new Map();
globalThis.self = globalThis;
globalThis.URL.createObjectURL = blob => {
    const url = `blob:http://localhost/${Math.random().toString(16).slice(2)}`;
    htmlByUrl.set(url, blob.__html || '');
    return url;
};
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = {
    open(url, name) {
        const existing = openedWindows.find(w => w.name === name && !w.closed);
        const win = existing || makeFakeWindow(name);
        if (!existing) openedWindows.push(win);
        win.document = blankDocument();
        win.html = htmlByUrl.get(url) || '';
        return win;
    }
};

const live = await import('../../src/js/live-tabs.js');

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function frames(win) {
    const pending = win.frames.splice(0);
    for (const fn of pending) fn();
    await tick(0);
}
async function ready(win) {
    win.load();
    await tick(120);
    await frames(win);
}
const shown = (win, id) => { const node = win.document.getElementById(id); return node ? node.textContent : null; };

const RealBlob = globalThis.Blob;
const capturedHtml = [];
globalThis.Blob = class extends RealBlob {
    constructor(parts, options) {
        super(parts, options);
        if (options?.type === 'text/html') {
            this.__html = String(parts[0]);
            capturedHtml.push(this.__html);
        }
    }
};

live.liveLogInit(201);
live.openLiveLogTab(201, 'note-2.wav');
live.replyStreamInit(202);
live.openReplyStreamTab(202, 'note-3.wav');
ok(capturedHtml.length === 2, 'both popup documents were generated');

for (const html of capturedHtml) {
    ok(!/<script\b/i.test(html), 'popup document has no script element: the opening tab renders into it');
    ok(!/\son[a-z]+\s*=/i.test(html), 'popup document has no inline event attributes');
    ok(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/.test(html),
       'popup document carries a policy that lets it run no script and load nothing');
    ok(!/data-live-config/.test(html), 'popup document carries no configuration for a script to read');
}

capturedHtml.length = 0;
live.openReplyStreamTab(203, `</title><script>window.__pwned=1</script>"'<img src=x onerror=alert(1)>`);
const hostile = capturedHtml[0];
ok(!/<script\b/i.test(hostile), 'a script payload in the title cannot introduce a script element');
ok(!/<img\b/i.test(hostile), 'an element payload in the title is not emitted as markup');
ok(hostile.includes('&lt;img src=x onerror=alert(1)&gt;'),
   'an event-handler payload survives only as inert escaped text');
ok(hostile.includes('&lt;script&gt;'), 'angle brackets in the title are escaped');
ok(!/<\/title>[^]*<\/title>/.test(hostile), 'the title element cannot be terminated early');

{
    live.replyStreamInit(301);
    const win = live.openReplyStreamTab(301, 'reply.wav');
    await ready(win);

    live.replyStreamInit(301);
    live.replyStreamAppend(301, 'Hello ');
    live.replyStreamAppend(301, 'world!');
    live.replyStreamDone(301);

    ok(shown(win, 'text') === 'Hello world!', 'tokens still reach a popup opened before the stream was re-initialised');
    ok(/Complete/.test(shown(win, 'status')), 'completion still reaches that popup');
    ok(win.posted.length === 0, 'nothing is posted to the popup: its content never leaves this origin as a message');
}

{
    live.replyStreamInit(311);
    live.replyStreamAppend(311, 'old answer');
    const win = live.openReplyStreamTab(311, 'again.wav');
    await ready(win);
    ok(shown(win, 'text') === 'old answer', 'the answer so far is shown when the popup opens');
    live.replyStreamInit(311);
    ok(shown(win, 'text') === '', 're-initialisation clears the previous answer in the popup');
    live.replyStreamAppend(311, 'new ');
    ok(shown(win, 'text') === '', 'a token is drawn on the next frame, not straight away');
    await frames(win);
    ok(shown(win, 'text') === 'new ', 'the popup is drawn on its own animation frames');
}

{
    live.liveLogInit(302);
    const win = live.openLiveLogTab(302, 'scribe.wav');
    await ready(win);

    live.liveLogClear(302);
    live.liveLogText(302, 0, 'first chunk', 0, 60, true);
    live.liveLogAppend(302, '✅ Done - 11 chars total');

    ok(shown(win, 'transcript').includes('first chunk'),
       'transcript chunks still reach a popup opened before the log was cleared');
    ok(shown(win, 'footer') === '✅ Done - 11 chars total', 'meta lines still reach that popup');
}

{
    live.replyStreamInit(401);
    live.replyStreamAppend(401, 'already ');
    live.replyStreamAppend(401, 'streamed');
    const win = live.openReplyStreamTab(401, 'late.wav');
    ok(shown(win, 'text') === null, 'nothing is drawn while the popup still shows its blank first page');
    await ready(win);
    ok(shown(win, 'text') === 'already streamed', 'buffered tokens are replayed once its page has loaded');
    ok(!/Complete/.test(shown(win, 'status')), 'an unfinished stream is not reported as complete');

    live.replyStreamDone(401);
    ok(/Complete/.test(shown(win, 'status')), 'completion after open is shown live');
}

{
    live.liveLogInit(402);
    live.liveLogAppend(402, '▶️ Starting server transcription');
    live.liveLogText(402, 1, 'second', 60, 120, false);
    live.liveLogText(402, 0, 'first', 0, 60, false);
    const win = live.openLiveLogTab(402, 'late-log.wav');
    await ready(win);
    const text = shown(win, 'transcript');
    ok(text.indexOf('first') >= 0 && text.indexOf('first') < text.indexOf('second'),
       'every buffered chunk is replayed once, in index order regardless of arrival order');
    ok(/\[00:00 – 01:00\] first/.test(text), 'a chunk without segment timestamps is stamped with its own time span');
}

{
    live.replyStreamInit(501);
    const win = live.openReplyStreamTab(501, 'idem.wav');
    await ready(win);
    live.replyStreamAppend(501, 'x');
    live.replyStreamDone(501);
    const statusAfterOne = shown(win, 'status');
    live.replyStreamDone(501);
    live.replyStreamDone(501);
    ok(shown(win, 'status') === statusAfterOne && shown(win, 'text') === 'x',
       'repeated completion signals change nothing more');
}

{
    live.replyStreamInit(601);
    const first = live.openReplyStreamTab(601, 'dup.wav');
    await ready(first);
    const second = live.openReplyStreamTab(601, 'dup.wav');
    ok(second === first, 'reopening a live view returns the same named window');
    await ready(second);

    live.replyStreamAppend(601, 'once');
    await frames(second);
    ok(shown(second, 'text') === 'once', 'reopening replaces the renderer instead of stacking duplicates');

    second.closed = true;
    live.replyStreamAppend(601, 'ignored');
    second.closed = false;
    live.replyStreamAppend(601, 'after-close');
    await frames(second);
    await tick(120);
    ok(shown(second, 'text') === 'once', 'a closed window is let go and never drawn into again');
}

{
    live.replyStreamInit(611);
    const win = live.openReplyStreamTab(611, 'away.wav');
    await ready(win);
    live.replyStreamAppend(611, 'kept here');
    Object.defineProperty(win, 'document', { configurable: true, get() { throw new DOMException('Blocked a frame', 'SecurityError'); } });
    live.replyStreamAppend(611, ' and not sent on');
    ok(win.posted.length === 0,
       'a popup the person navigated to another site is let go: nothing of the stream is sent to that site');
    delete win.document;
}

{
    live.replyStreamInit(701);
    const win = live.openReplyStreamTab(701, 'stuck.wav');
    const realNow = Date.now;
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    Date.now = () => realNow() + 60000;
    await tick(200);
    Date.now = realNow;
    console.error = realError;

    ok(/could not be shown/.test(win.document.body.textContent),
       'a popup whose page never loads is told so');
    ok(/did not load/.test(win.document.body.textContent) && /open the view again/.test(win.document.body.textContent),
       'the failure explains what went wrong and what to do');
    ok(errors.length > 0, 'the failure is also reported to the opener console');

    win.load();
    live.replyStreamAppend(701, 'late');
    await tick(140);
    await frames(win);
    ok(shown(win, 'text') === '', 'a timed-out popup is not silently taken up again later');
}

{
    live.replyStreamInit(711);
    const win = live.openReplyStreamTab(711, 'closed-early.wav');
    win.closed = true;
    const realNow = Date.now;
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    await tick(120);
    Date.now = () => realNow() + 60000;
    await tick(200);
    Date.now = realNow;
    console.error = realError;
    ok(errors.length === 0 && win.document.body.textContent === '',
       'a popup closed before its page loaded is let go, and not reported as a failure');
}

{
    const CAP = 30;
    const OLDEST = 9000;
    const NEWEST = 9000 + CAP + 4;

    live.replyStreamInit(OLDEST);
    live.replyStreamAppend(OLDEST, 'oldest-data');
    for (let i = 1; i <= CAP + 4; i++) live.replyStreamInit(9000 + i);
    live.replyStreamAppend(NEWEST, 'newest');

    const newest = live.openReplyStreamTab(NEWEST, 'newest.wav');
    await ready(newest);
    ok(shown(newest, 'text') === 'newest', 'a recently touched entry survives eviction with its buffer intact');

    const oldest = live.openReplyStreamTab(OLDEST, 'oldest.wav');
    await ready(oldest);
    ok(shown(oldest, 'text') === '', 'the oldest entry was evicted and reopens empty rather than stale');

    live.replyStreamInit(9001);
    live.replyStreamAppend(9001, 'kept-alive');
    for (let i = 0; i < CAP; i++) live.replyStreamInit(9500 + i);
    live.replyStreamAppend(9001, '-still-here');
    const revived = live.openReplyStreamTab(9001, 'touched.wav');
    await ready(revived);
    ok(shown(revived, 'text').endsWith('-still-here'), 'an entry written to after eviction accepts new tokens');
}

{
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => null;
    live.replyStreamInit(801);
    ok(live.openReplyStreamTab(801, 'blocked.wav') === null, 'a blocked reply popup returns null');
    ok(live.openLiveLogTab(801, 'blocked.wav') === null, 'a blocked log popup returns null');
    live.replyStreamAppend(801, 'still fine');
    globalThis.window.open = realOpen;
    ok(true, 'the stream keeps working after a blocked popup');
}

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

{
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

    live.replyStreamInit(902);
    const hostileHandle = live.openReplyStreamTab(902, '<img src=x onerror=alert(1)>');
    const titleEl = overlay.querySelector('.live-inline-title');
    ok(titleEl.textContent.includes('<img src=x onerror=alert(1)>') && titleEl.children.length === 0,
       'a hostile recording title stays inert text in the panel');
    ok(live.openReplyStreamTab(902, 'again.wav') === hostileHandle,
       'reopening the same view returns the panel already on screen');

    globalThis.document.dispatch('keydown', { key: 'Escape' });
    ok(overlay.getAttribute('aria-hidden') === 'true', 'Escape closes the panel');
    const textAtClose = textEl.textContent;
    live.replyStreamInit(902);
    live.replyStreamAppend(902, 'after-close');
    ok(textEl.textContent === textAtClose, 'a closed panel is unsubscribed rather than left listening');

    live.liveLogInit(903);
    live.liveLogText(903, 0, 'hello from the log', 0, 60, false);
    const logHandle = live.openLiveLogTab(903, 'phone-log.wav');
    const transcript = globalThis.document.getElementById('liveInlineOverlay').querySelector('.live-inline-transcript');
    ok(/hello from the log/.test(transcript.textContent), 'the transcript log renders in page too');
    live.liveLogAppend(903, '✅ Done - 18 chars total');
    ok(/Complete/.test(overlay.querySelector('.live-inline-status').textContent),
       'the log reports completion in the panel');
    logHandle.close();

    asDesktop();
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => null;
    live.replyStreamInit(904);
    const fallback = live.openReplyStreamTab(904, 'blocked.wav');
    ok(fallback && fallback.key === 'replystream-904',
       'a blocked popup falls back to the in-page panel');
    fallback.close();
    globalThis.window.open = realOpen;

    ok(inline.inlineLiveViewKey() === null && inline.closeInlineLiveView() === false,
       'closing when no panel is open is a safe no-op');

    live.replyStreamInit(905);
    const desktopWindow = live.openReplyStreamTab(905, 'desktop.wav');
    ok(openedWindows.includes(desktopWindow), 'desktop still opens a real popup window');
    desktopWindow.closed = true;
}

{
    const render = await import('../../src/js/live-render.js');
    const make = () => globalThis.document.createElement('div');
    const replyEl = make(), textEl = make(), cursorEl = make(), statusEl = make(), footerEl = make();
    const renderer = render.createReplyRenderer({ replyEl, textEl, cursorEl, statusEl, footerEl });

    renderer.handle({ type: 'token', token: 'one ', count: 1, elapsedMs: 0 });
    ok(footerEl.textContent === '4 chars · 1 tok',
       'a single token has no interval to divide by');

    renderer.handle({ type: 'token', token: 'two', count: 2, elapsedMs: 500 });
    ok(textEl.textContent === 'one two', 'tokens append in order');
    ok(footerEl.textContent === '7 chars · 2 tok · 4.0 tok/s',
       'characters, tokens and throughput all follow the stream');

    const lateFooter = make(), lateStatus = make();
    const late = render.createReplyRenderer({
        replyEl: make(), textEl: make(), cursorEl: make(),
        statusEl: lateStatus, footerEl: lateFooter
    });
    late.handle({ type: 'model', model: 'gemma4:e4b' });
    ok(lateStatus.textContent === '⏳ Generating - gemma4:e4b',
       'a view opened before any token knows which model is answering');
    late.handle({ type: 'token', token: 'x'.repeat(240), count: 60, elapsedMs: 1000 });
    ok(lateFooter.textContent === '240 chars · 60 tok · 60.0 tok/s',
       'a view opened mid-stream reports the real totals, not one replayed message');
    ok(lateStatus.textContent === '⚡ Streaming - gemma4:e4b',
       'text on screen means the view reports Streaming, not Generating');
    ok(/gemma4:e4b/.test(lateStatus.textContent),
       'promoting the status keeps the answering model named');

    renderer.handle({ type: 'model', model: 'gemma4:e4b' });
    ok(/gemma4:e4b/.test(statusEl.textContent) && !/\.\.\. - /.test(statusEl.textContent),
       'the model name replaces the trailing ellipsis in the status line');

    renderer.handle({ type: 'done' });
    ok(cursorEl.style.display === 'none' && /7 chars/.test(statusEl.textContent),
       'completion hides the cursor and reports the final size');
    ok(/gemma4:e4b/.test(statusEl.textContent), 'the finished view still names the model that answered');
    ok(footerEl.textContent === '7 chars · 2 tok · 4.0 tok/s',
       'the final throughput stays on screen');

    renderer.handle({ type: 'reset' });
    ok(textEl.textContent === '' && cursorEl.style.display === '',
       'a re-initialised stream clears the previous answer instead of appending to it');
    ok(footerEl.textContent === 'Waiting for tokens...',
       'the counters reset with the answer');
}

{
    const inline    = await import('../../src/js/live-inline.js');
    const asTouch   = () => { globalThis.window.matchMedia = q => ({ matches: /coarse/.test(q), media: q }); };
    const asDesktop = () => { globalThis.window.matchMedia = q => ({ matches: false, media: q }); };
    const overlayNow = () => globalThis.document.getElementById('liveInlineOverlay');

    asDesktop();
    capturedHtml.length = 0;

    live.replyStreamInit(1001);
    live.replyStreamModel(1001, 'gemma4:e4b');
    live.replyStreamAppend(1001, 'live answer');
    const liveWin  = live.openReplyStreamTab(1001, 'busy.wav');
    const savedWin = live.openSavedReplyView({
        key: 'saved-reply-1001-7', label: 'busy.wav',
        text: 'stored answer', model: 'gemma3:12b', tokenCount: 40, elapsedMs: 2000
    });
    ok(capturedHtml.length === 2, 'a saved reply builds a view document of its own');
    ok(capturedHtml[0] === capturedHtml[1], 'the saved reply document IS the live reply document');
    ok(savedWin !== liveWin,
       'a stored reply opens its own window');

    await ready(savedWin);
    ok(shown(savedWin, 'text') === 'stored answer',
       'the stored text is drawn the way the stream that produced it was');
    ok(/gemma3:12b/.test(shown(savedWin, 'status')), 'the saved view says which model answered');
    ok(/40 tok/.test(shown(savedWin, 'footer')) && /20\.0 tok\/s/.test(shown(savedWin, 'footer')),
       `the totals measured while it streamed survive into the saved view (${shown(savedWin, 'footer')})`);
    ok(/Complete/.test(shown(savedWin, 'status')) && savedWin.document.getElementById('cursor').style.display === 'none',
       'a stored reply is shown already complete');

    await ready(liveWin);
    live.replyStreamAppend(1001, ' continues');
    await frames(liveWin);
    await frames(savedWin);
    ok(shown(liveWin, 'text') === 'live answer continues', 'the running stream still reaches its own window');
    ok(shown(savedWin, 'text') === 'stored answer', 'a stored reply is not registered as a live stream');

    capturedHtml.length = 0;
    live.liveLogInit(1002);
    live.openLiveLogTab(1002, 'note.wav');
    live.openSavedTranscriptView({
        key: 'saved-transcript-1002-3', label: 'note.wav',
        text: '[00:00-00:05] hello', charCount: 5
    });
    ok(capturedHtml[0] === capturedHtml[1], 'the saved transcript document IS the live transcript document');

    asTouch();
    const windowsBefore = openedWindows.length;
    const replyHandle = live.openSavedReplyView({
        key: 'saved-reply-1003-1', label: 'phone.wav',
        text: 'stored', model: 'gemma4:e4b', tokenCount: 12, elapsedMs: 3000
    });
    ok(openedWindows.length === windowsBefore,
       'a saved reply opens no second window on a touch device');
    ok(replyHandle && replyHandle.key === 'saved-reply-1003-1',
       'the in-page panel is returned instead of a window');

    const replyOverlay = overlayNow();
    ok(replyOverlay.querySelector('.live-inline-text').textContent === 'stored',
       'the stored answer is rendered in the panel');
    ok(replyOverlay.querySelector('.live-inline-status').textContent === '✅ Complete - 6 chars - gemma4:e4b',
       'the panel shows the status a live view ends on, naming the model');
    ok(replyOverlay.querySelector('.live-inline-foot').textContent === '6 chars · 12 tok · 4.0 tok/s',
       'the measured throughput is reported again');
    ok(replyOverlay.querySelector('.live-inline-cursor').style.display === 'none',
       'a finished answer shows no streaming cursor');
    replyHandle.close();

    const logHandle = live.openSavedTranscriptView({
        key: 'saved-transcript-1004-1', label: 'phone.wav',
        text: '[00:00-00:05] hello there\n[00:05-00:10] second line',
        charCount: 22
    });
    const logOverlay = overlayNow();
    const transcript = logOverlay.querySelector('.live-inline-transcript');
    ok(/hello there/.test(transcript.textContent) && /second line/.test(transcript.textContent),
       'every stored line is rendered');
    ok(transcript.querySelector('.ts').textContent === '[00:00-00:05]',
       'stored timestamps keep the styling the live log gives them');
    ok(logOverlay.querySelector('.live-inline-status').textContent === '✅ Complete',
       'a stored transcript opens complete rather than mid-assembly');
    ok(logOverlay.querySelector('.live-inline-foot').textContent === '✅ Done - 22 chars total',
       'the footer carries the closing line the live log ends on');
    logHandle.close();

    const echoHandle = live.openSavedTranscriptView({
        key: 'saved-transcript-1004-2', label: 'phone.wav',
        text: "[00:12-00:16] Honestly, I don't know.\n[00:16-00:20] Know what? You were there.",
        charCount: 60
    });
    const echoText = overlayNow().querySelector('.live-inline-transcript').textContent;
    ok(/Know what\? You were there\./.test(echoText),
       'a stored transcript is shown word for word, even where one line opens on the word the last line closed on');
    ok(!/^what\?/m.test(echoText),
       'the overlap trimming that belongs to live windows is not applied to a transcript that is already finished');
    echoHandle.close();

    const bracketHandle = live.openSavedTranscriptView({
        key: 'saved-transcript-1004-3', label: 'phone.wav',
        text: 'The [redacted] part was fine.', charCount: 29
    });
    const bracketOverlay = overlayNow();
    ok(bracketOverlay.querySelector('.live-inline-transcript').textContent.includes('The [redacted] part was fine.'),
       'a bracket inside a sentence is not mistaken for a timestamp and split off');
    ok(!bracketOverlay.querySelector('.ts'),
       'so no part of the sentence is greyed out as a stamp');
    bracketHandle.close();

    live.liveLogInit(1005);
    live.liveLogText(1005, 0, 'chunk text', 0, 60, false);
    live.liveLogAppend(1005, '✅ Done - 10 chars total');
    const reopened = live.openLiveLogTab(1005, 'finished.wav');
    ok(overlayNow().querySelector('.live-inline-status').textContent === '✅ Complete',
       'a live log reopened after completion reports completion');
    reopened.close();

    const plainHandle = live.openSavedReplyView({
        key: 'saved-reply-1006-1', label: 'old.wav', text: 'abc'
    });
    const plainOverlay = overlayNow();
    ok(plainOverlay.querySelector('.live-inline-status').textContent === '✅ Complete - 3 chars',
       'a reply stored before throughput was recorded still opens complete');
    ok(plainOverlay.querySelector('.live-inline-foot').textContent === '3 chars',
       'no token count or rate is invented for a reply whose stream was never measured');
    plainHandle.close();

    live.replyStreamInit(1007);
    ok(live.replyStreamStats(1007).count === 0, 'a stream with no tokens reports none');
    live.replyStreamModel(1007, 'gemma4:e4b');
    live.replyStreamAppend(1007, 'a');
    live.replyStreamAppend(1007, 'b');
    const stats = live.replyStreamStats(1007);
    ok(stats.model === 'gemma4:e4b' && stats.count === 2 && stats.elapsedMs >= 0,
       'the registry reports what it measured');
    ok(live.replyStreamStats(123456789) === null,
       'totals for an unknown stream are absent rather than invented');

    asDesktop();
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => null;
    const blocked = live.openSavedReplyView({
        key: 'saved-reply-1008-1', label: 'blocked.wav', text: 'x'
    });
    ok(blocked && blocked.key === 'saved-reply-1008-1',
       'a blocked saved-result popup falls back to the in-page panel');
    blocked.close();
    globalThis.window.open = realOpen;

    ok(inline.inlineLiveViewKey() === null, 'no panel is left on screen');
}

{
    const inline = await import('../../src/js/live-inline.js');
    const walledOff = makeFakeWindow('replystream-950');
    Object.defineProperty(walledOff, 'document', {
        get() { throw new DOMException('Blocked a frame with a different origin', 'SecurityError'); },
        configurable: true
    });
    walledOff.close = () => { walledOff.closed = true; };
    globalThis.window.matchMedia = query => ({ matches: false, media: query });
    const realOpen = globalThis.window.open;
    globalThis.window.open = () => walledOff;
    live.replyStreamInit(950);
    live.replyStreamAppend(950, 'before the view ');
    live.openReplyStreamTab(950, 'walled-off.wav');
    globalThis.window.open = realOpen;
    await tick(120);
    ok(walledOff.posted.length === 0, 'a popup this tab may not read is sent nothing');
    ok(walledOff.closed && inline.inlineLiveViewKey() === 'replystream-950',
       'it is closed, and the view opens in the page instead, where it can be shown');
    const panel = globalThis.document.getElementById('liveInlineOverlay');
    ok(panel && /before the view/.test(panel.textContent), 'with the stream so far');
    inline.closeInlineLiveView?.();
}

{
    const seen = [];
    const first = live.replyStreamInit(4242);
    live.subscribeReplyStream(4242, msg => seen.push(msg.type));
    live.replyStreamAppend(4242, 'old ', first);

    const second = live.replyStreamInit(4242);
    ok(second !== first, 'each re-initialisation of a reply stream takes a new generation');

    live.replyStreamDone(4242, first);
    ok(!seen.includes('done'),
       'a superseded generation cannot mark the replacing stream complete');

    live.replyStreamAppend(4242, 'new ', second);
    live.replyStreamAppend(4242, 'answer', second);
    live.replyStreamDone(4242, second);
    ok(seen[seen.length - 1] === 'done',
       'the owning generation still completes the stream, and does so last');

    live.replyStreamAppend(4242, 'ghost', first);
    const stats = live.replyStreamStats(4242);
    ok(stats.count === 2, 'a superseded generation cannot append to the replacing stream');
}

{
    const counts = { created: 0, layoutReads: 0 };
    class CountingNode {
        constructor(tag, ownerDocument) { this.tagName = tag; this.children = []; this.parentNode = null; this.className = '';
            this.ownerDocument = ownerDocument; this._text = ''; this.style = {}; this._scrollTop = 0; this.clientHeight = 100; }
        get nodeType() { return this.tagName === '#text' ? 3 : 1; }
        get length() { return this._text.length; }
        appendData(text) { this._text += text; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value); }
        get lastChild() { return this.children[this.children.length - 1] || null; }
        get scrollHeight() { counts.layoutReads++; return 1000; }
        get scrollTop() { return this._scrollTop; }
        set scrollTop(value) { this._scrollTop = value; }
        appendChild(child) { return this.insertBefore(child, null); }
        insertBefore(child, ref) {
            if (child.parentNode) child.remove();
            const at = ref ? this.children.indexOf(ref) : -1;
            if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
            child.parentNode = this;
            return child;
        }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
    }
    const countingDocument = {
        createElement: tag => { counts.created++; return new CountingNode(tag, countingDocument); },
        createTextNode: text => { const node = new CountingNode('#text', countingDocument); node._text = String(text); return node; }
    };
    const element = tag => new CountingNode(tag, countingDocument);
    const pageDocument = globalThis.document;
    globalThis.document = countingDocument;
    const render = await import('../../src/js/live-render.js');
    const pad = n => String(n).padStart(2, '0');
    const fmt = sec => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
    const word = n => `w${n.toString(36)}`;
    const chunkText = c => Array.from({ length: 6 }, (_, k) => {
        const at = c * 60 + k * 10;
        const base = (c * 6 + k) * 5;
        return `[${fmt(at)}-${fmt(at + 9)}] ${[0, 1, 2, 3, 4].map(i => word(base + i)).join(' ')}`;
    }).join('\n');
    const make = order => {
        const transcriptEl = element('div');
        const renderer = render.createLiveLogRenderer({ transcriptEl, statusEl: element('div'), footerEl: element('div') });
        for (const c of order) renderer.handle({ type: 'text', chunkIndex: c, text: chunkText(c), startSec: c * 60, endSec: c * 60 + 60, hasSeg: true });
        return transcriptEl;
    };
    const describe = el => el.children.map(node => node.className === 'chunk-sep' ? '|' : node.textContent).join('\n');

    counts.created = 0;
    const inOrder = make(Array.from({ length: 60 }, (_, i) => i));
    const inOrderCreated = counts.created;
    const blocks = inOrder.children.filter(node => node.className === 'chunk-block').length;
    ok(blocks === 360 && counts.created <= 2 * (360 + 60) + 60,
       `log viewer: sixty chunks arriving in order are each rendered once, not the whole transcript again for every chunk (${counts.created} elements for ${blocks} lines)`);
    const shuffled = Array.from({ length: 60 }, (_, i) => i).sort((a, b) => ((a * 37) % 61) - ((b * 37) % 61));
    counts.created = 0;
    const outOfOrder = make(shuffled);
    ok(describe(outOfOrder) === describe(inOrder),
       'log viewer: chunks arriving in any order give exactly the transcript they give in order');
    ok(counts.created <= 4 * inOrderCreated,
       `log viewer: out of order, a chunk renders again only the chunk after it, not everything that follows (${counts.created} elements)`);

    const seam = element('div');
    const seamRenderer = render.createLiveLogRenderer({ transcriptEl: seam, statusEl: element('div'), footerEl: element('div') });
    seamRenderer.handle({ type: 'text', chunkIndex: 1, text: '[01:00-01:05] and then we went home early', startSec: 60, endSec: 120, hasSeg: true });
    seamRenderer.handle({ type: 'text', chunkIndex: 0, text: '[00:55-01:00] after dinner and then we went', startSec: 0, endSec: 60, hasSeg: true });
    ok(describe(seam) === '[00:55-01:00] after dinner and then we went\n|\n[01:00-01:05] home early',
       `log viewer: a chunk that arrives before the one it follows trims the words that one already has (${JSON.stringify(describe(seam))})`);

    const longWords = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
    const longChunk = (renderer, index, startSec, prefix) => renderer.handle({
        type: 'text', chunkIndex: index, text: longWords(prefix, 50), startSec, endSec: startSec + 60, hasSeg: false });
    const moved = element('div');
    const movedRenderer = render.createLiveLogRenderer({ transcriptEl: moved, statusEl: element('div'), footerEl: element('div') });
    for (let c = 0; c < 6; c++) longChunk(movedRenderer, c, c * 60, `c${c}w`);
    longChunk(movedRenderer, 1, 250, 'later');
    const direct = element('div');
    const directRenderer = render.createLiveLogRenderer({ transcriptEl: direct, statusEl: element('div'), footerEl: element('div') });
    for (const [c, start, prefix] of [[0, 0, 'c0w'], [2, 120, 'c2w'], [3, 180, 'c3w'], [4, 240, 'c4w'], [1, 250, 'later'], [5, 300, 'c5w']]) {
        longChunk(directRenderer, c, start, prefix);
    }
    ok(describe(moved) === describe(direct) && (moved.textContent.match(/later0 /g) || []).length === 1
       && !moved.textContent.includes('c1w0'),
       'log viewer: a chunk sent again with a later start is shown once, at its new place');

    const frames = [];
    const frame = fn => frames.push(fn);
    const replyEl = element('div'), textEl = element('span'), footerEl = element('div');
    const reply = render.createReplyRenderer({ replyEl, textEl, cursorEl: element('span'), statusEl: element('div'), footerEl, frame });
    counts.layoutReads = 0;
    for (let i = 0; i < 1000; i++) reply.handle({ type: 'token', token: 'word ', count: i + 1, elapsedMs: 10 * i });
    ok(textEl.textContent === '' && frames.length === 1,
       'reply viewer: a thousand tokens arriving within one frame wait for that frame, which is asked for once');
    frames.shift()();
    ok(textEl.textContent === 'word '.repeat(1000) && textEl.children.length <= 2 && counts.layoutReads <= 2,
       `reply viewer: they are written in one go, into a text node that grows, with one layout read (${textEl.children.length} nodes, ${counts.layoutReads} reads)`);
    ok(/5000 chars · 1000 tok/.test(footerEl.textContent), 'reply viewer: and the counters follow');
    reply.handle({ type: 'token', token: 'late', count: 1001, elapsedMs: 10010 });
    reply.handle({ type: 'reset' });
    frames.splice(0).forEach(fn => fn());
    ok(textEl.textContent === '', 'reply viewer: a frame asked for before a reset writes nothing after it');
    globalThis.document = pageDocument;
}

globalThis.Blob = RealBlob;
console.log(`✓ all ${assertions} live-view assertions passed`);
emitTestResult('live-view-unit', 'pass', { assertions });
process.exit(0);
