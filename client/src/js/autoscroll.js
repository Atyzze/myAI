// Auto-scroll controls for an opened text: ▶ starts and pauses, the speed button opens a small popup
// to set how fast the text moves. They float above the text, at the bottom right where a thumb
// reaches them, and work the same in the in-page view and in a pop-up window, whose page has no
// script of its own: the opening tab builds the controls in it and runs them, as it renders the text.
//
// The reader stays in charge: dragging or touching the text holds it still for as long as the finger
// is down, scrolling by hand moves the reading position and scrolling carries on from there, and at
// the end of the text it stops by itself. ▶ at the end starts again from the top.

import { AUTOSCROLL_SPEED_KEY, SPEED_MIN, SPEED_MAX, clampSpeed, stepSpeed, lineHeightPx,
         pxPerSecond, describeSpeed, startPosition, nextScroll } from './autoscroll-core.js';
import { readStored, writeStored } from './config.js';

const STYLE_ID = 'myai-autoscroll-style';
const FRAME_FALLBACK_MS = 100;

const STYLES = `
.as-bar{position:absolute;right:14px;bottom:var(--as-bottom,14px);z-index:20;display:flex;gap:6px;align-items:center;
  padding:4px;border-radius:999px;background:rgba(17,17,17,.96);border:1px solid #333;box-shadow:0 2px 12px rgba(0,0,0,.55)}
.as-bar.as-fixed{position:fixed}
.as-btn{background:transparent;border:1px solid #444;color:#ddd;border-radius:999px;min-width:38px;height:34px;padding:0 11px;
  font:13px/1 system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px}
.as-btn:hover{background:#222;border-color:#777;color:#fff}
.as-btn:focus-visible,.as-pop-row input:focus-visible{outline:2px solid #4caf50;outline-offset:2px;border-radius:6px}
.as-btn svg{width:14px;height:14px;fill:currentColor;display:block}
.as-play[aria-pressed="true"]{border-color:#4caf50;color:#4caf50}
.as-pop{position:absolute;right:0;bottom:calc(100% + 8px);width:min(270px,80vw);padding:12px 12px 10px;border-radius:12px;
  background:#151515;border:1px solid #333;box-shadow:0 4px 18px rgba(0,0,0,.6);color:#ddd;font:13px/1.4 system-ui,sans-serif}
.as-pop[hidden]{display:none}
.as-pop-title{font-weight:600;color:#eee}
.as-pop-row{display:flex;align-items:center;gap:8px;margin-top:10px}
.as-pop-row input{flex:1;min-width:0;accent-color:#4caf50}
.as-pop-step{min-width:34px;padding:0}
.as-pop-value{margin-top:8px;font:12px/1.4 monospace;color:#9a9a9a}`;

function frameScheduler(win) {
    return fn => {
        let done = false;
        const runOnce = () => { if (done) return; done = true; fn(); };
        try { win.requestAnimationFrame(runOnce); } catch (_) {}
        setTimeout(runOnce, FRAME_FALLBACK_MS);
    };
}

function usable(doc, host, scroller) {
    if (!doc || typeof doc.createElement !== 'function' || typeof doc.addEventListener !== 'function') return false;
    if (!host || typeof host.appendChild !== 'function') return false;
    if (!scroller || typeof scroller.addEventListener !== 'function' || !('scrollTop' in scroller)) return false;
    try {
        const probe = doc.createElement('div');
        return typeof probe.appendChild === 'function' && typeof probe.setAttribute === 'function'
            && typeof probe.addEventListener === 'function' && typeof probe.contains === 'function';
    } catch (_) {
        return false;
    }
}

function appendAll(parent, ...children) {
    for (const child of children) parent.appendChild(child);
}

function ensureStyles(doc) {
    if (doc.getElementById?.(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    (doc.head || doc.body || doc.documentElement).appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    play: [['path', { d: 'M3 1.5v13l11-6.5z' }]],
    pause: [['rect', { x: '2.5', y: '1.5', width: '4', height: '13', rx: '1' }],
            ['rect', { x: '9.5', y: '1.5', width: '4', height: '13', rx: '1' }]]
};

// Drawn rather than typed: the play and pause characters come out at very different sizes
// depending on the fonts a device has.
function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name]) {
        const shape = doc.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
        svg.appendChild(shape);
    }
    return svg;
}

function button(doc, className, text, label) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `as-btn ${className}`;
    node.textContent = text;
    node.setAttribute('aria-label', label);
    node.title = label;
    return node;
}

// Attach the controls. `scroller` is the element that scrolls, `textEl` the one whose line height
// sets the speed, `host` where the controls go: `fixed` when the host is a whole window (a pop-up),
// otherwise the host becomes their positioning box. `bottomOffset` keeps them above a footer.
// Returns a function that removes everything again; on a page that cannot show controls (a test
// double, a document of another kind) it attaches nothing and returns a function that does nothing.
export function attachAutoScroll({ doc, win = null, scroller, textEl = null, host, fixed = false,
                                   bottomOffset = 14, read = readStored, write = writeStored }) {
    if (!usable(doc, host, scroller)) return () => {};
    const view = win || doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!view) return () => {};

    ensureStyles(doc);
    // In a view (not a whole window) the controls are placed against the host's own box.
    let restorePosition = null;
    if (!fixed) {
        let current = '';
        try { current = view.getComputedStyle(host).position; } catch (_) {}
        if (!current || current === 'static') {
            const before = host.style.position || '';
            host.style.position = 'relative';
            restorePosition = () => { host.style.position = before; };
        }
    }
    let speed = clampSpeed(read(AUTOSCROLL_SPEED_KEY) ?? undefined);
    let running = false;
    let holding = false;
    let position = NaN;
    let last = 0;
    let disposed = false;
    const frame = frameScheduler(view);
    const clock = () => (view.performance && typeof view.performance.now === 'function')
        ? view.performance.now() : Date.now();

    const bar = doc.createElement('div');
    bar.className = `as-bar${fixed ? ' as-fixed' : ''}`;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Auto-scroll');
    bar.style.setProperty?.('--as-bottom', `${Math.max(8, Math.round(bottomOffset))}px`);

    const play = button(doc, 'as-play', '', 'Start auto-scroll');
    play.setAttribute('aria-pressed', 'false');
    const speedBtn = button(doc, 'as-speed', '', 'Scroll speed');
    speedBtn.setAttribute('aria-haspopup', 'dialog');
    speedBtn.setAttribute('aria-expanded', 'false');

    const pop = doc.createElement('div');
    pop.className = 'as-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Scroll speed');
    const title = doc.createElement('div');
    title.className = 'as-pop-title';
    title.textContent = 'Scroll speed';
    const row = doc.createElement('div');
    row.className = 'as-pop-row';
    const slower = button(doc, 'as-pop-step as-slower', '-', 'Slower');
    const faster = button(doc, 'as-pop-step as-faster', '+', 'Faster');
    const range = doc.createElement('input');
    range.type = 'range';
    range.min = String(SPEED_MIN);
    range.max = String(SPEED_MAX);
    range.step = '1';
    range.className = 'as-range';
    range.setAttribute('aria-label', 'Scroll speed in lines a minute');
    const value = doc.createElement('div');
    value.className = 'as-pop-value';
    value.setAttribute('aria-live', 'polite');
    appendAll(row, slower, range, faster);
    appendAll(pop, title, row, value);
    appendAll(bar, play, speedBtn, pop);
    host.appendChild(bar);

    function paintSpeed() {
        range.value = String(speed);
        value.textContent = describeSpeed(speed);
        speedBtn.textContent = `${speed}/min`;
        speedBtn.title = `Scroll speed: ${describeSpeed(speed)}`;
    }

    function setSpeed(next) {
        speed = clampSpeed(next);
        write(AUTOSCROLL_SPEED_KEY, String(speed));
        paintSpeed();
    }

    function linePx() {
        try {
            const style = view.getComputedStyle(textEl || scroller);
            return lineHeightPx(style.lineHeight, style.fontSize);
        } catch (_) {
            return 24;
        }
    }

    function maxScroll() {
        return Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
    }

    function paintPlay() {
        play.textContent = '';
        try { play.appendChild(icon(doc, running ? 'pause' : 'play')); }
        catch (_) { play.textContent = running ? '||' : '>'; }
        play.setAttribute('aria-pressed', String(running));
        const label = running ? 'Pause auto-scroll' : 'Start auto-scroll';
        play.setAttribute('aria-label', label);
        play.title = label;
    }

    function stillShown() {
        if (disposed || !bar.isConnected) return false;
        try { return !view.closed; } catch (_) { return false; }
    }

    function tick() {
        if (!running) return;
        if (!stillShown()) { running = false; return; }
        const now = clock();
        const step = nextScroll({
            position, scrollTop: scroller.scrollTop, maxScroll: maxScroll(),
            pxPerSec: pxPerSecond(speed, linePx()), elapsedMs: now - last, holding
        });
        last = now;
        position = step.position;
        if (Math.round(scroller.scrollTop) !== step.scrollTo) scroller.scrollTop = step.scrollTo;
        if (step.atEnd && !holding) { stop(); return; }
        frame(tick);
    }

    function start() {
        const max = maxScroll();
        const from = startPosition(scroller.scrollTop, max);
        if (from !== scroller.scrollTop) scroller.scrollTop = from;
        position = from;
        last = clock();
        running = true;
        paintPlay();
        frame(tick);
    }

    function stop() {
        running = false;
        paintPlay();
    }

    function openPop(open) {
        pop.hidden = !open;
        speedBtn.setAttribute('aria-expanded', String(open));
        if (open) { try { range.focus(); } catch (_) {} }
    }

    const listeners = [];
    const on = (target, type, fn, options) => {
        target.addEventListener(type, fn, options);
        listeners.push(() => target.removeEventListener(type, fn, options));
    };

    on(play, 'click', () => (running ? stop() : start()));
    on(speedBtn, 'click', () => openPop(pop.hidden));
    on(slower, 'click', () => setSpeed(stepSpeed(speed, -1)));
    on(faster, 'click', () => setSpeed(stepSpeed(speed, +1)));
    on(range, 'input', () => setSpeed(range.value));
    // Escape closes the popup, not the whole view behind it.
    on(pop, 'keydown', event => {
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        event.stopPropagation();
        openPop(false);
        try { speedBtn.focus(); } catch (_) {}
    });
    // A tap anywhere else closes it.
    on(doc, 'pointerdown', event => {
        if (!pop.hidden && !bar.contains(event.target)) openPop(false);
    }, true);
    // A finger or the mouse on the text holds it still until it lets go.
    on(scroller, 'pointerdown', event => {
        if (bar.contains(event.target)) return;
        holding = true;
    });
    const release = () => { holding = false; };
    on(doc, 'pointerup', release, true);
    on(doc, 'pointercancel', release, true);

    paintSpeed();
    paintPlay();

    return () => {
        disposed = true;
        running = false;
        for (const off of listeners.splice(0)) { try { off(); } catch (_) {} }
        try { bar.remove(); } catch (_) {}
        try { restorePosition?.(); } catch (_) {}
    };
}
