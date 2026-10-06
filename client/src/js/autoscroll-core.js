// Auto-scroll for an opened text (a saved reply, transcript or context item): the arithmetic only,
// so it can be tested without a page. autoscroll.js draws the controls and runs the frames.
//
// Speed is in lines a minute, the unit a reader thinks in, and becomes pixels a second from the
// line height of the text being read, so the same setting reads the same on a phone and in a window.

export const AUTOSCROLL_SPEED_KEY = 'myai-autoscroll-speed';
export const SPEED_MIN = 2;
export const SPEED_MAX = 120;
export const SPEED_DEFAULT = 20;

// A frame later than this (a background tab, a stalled machine) moves the text as if this much time
// had passed, so the text never jumps a screen ahead when the view gets frames again.
export const MAX_FRAME_MS = 100;

// The page's own scroll position is a whole or device pixel; the position kept here is not. When
// they differ by more than this, the reader moved the text, and scrolling carries on from there.
export const USER_MOVED_PX = 3;

// Within this distance of the end the text counts as read to the end.
export const END_SLACK_PX = 2;

export function clampSpeed(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return SPEED_DEFAULT;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

// One press of - or +: fine steps where a difference is felt, larger ones where it is not.
export function stepSpeed(value, direction) {
    const current = clampSpeed(value);
    const up = direction > 0;
    const base = up ? current : current - 1;
    const step = base < 10 ? 1 : base < 30 ? 2 : 5;
    return clampSpeed(up ? current + step : current - step);
}

// A computed line height is a length in pixels, or "normal", which browsers draw at about 1.2 times
// the font size.
export function lineHeightPx(lineHeight, fontSize) {
    const line = parseFloat(lineHeight);
    if (Number.isFinite(line) && line > 0) return line;
    const font = parseFloat(fontSize);
    return Number.isFinite(font) && font > 0 ? font * 1.2 : 24;
}

export function pxPerSecond(linesPerMinute, linePx) {
    return clampSpeed(linesPerMinute) * Math.max(1, Number(linePx) || 24) / 60;
}

export function describeSpeed(linesPerMinute) {
    const n = clampSpeed(linesPerMinute);
    return `${n} line${n === 1 ? '' : 's'} a minute`;
}

// Where a press of play starts: here, unless the text was already read to the end, in which case
// from the top again.
export function startPosition(scrollTop, maxScroll) {
    const top = Math.max(0, Number(scrollTop) || 0);
    const max = Math.max(0, Number(maxScroll) || 0);
    return max - top <= END_SLACK_PX ? 0 : top;
}

// One frame of scrolling. `position` is the exact position kept between frames; `scrollTop` is
// what the page reports now. Returns the new exact position, the whole pixel to scroll to, and
// whether the end was reached.
export function nextScroll({ position, scrollTop, maxScroll, pxPerSec, elapsedMs, holding = false }) {
    const max = Math.max(0, Number(maxScroll) || 0);
    let exact = Number.isFinite(position) ? position : Number(scrollTop) || 0;
    const actual = Number(scrollTop) || 0;
    if (Math.abs(actual - exact) > USER_MOVED_PX) exact = actual;
    if (!holding) {
        const ms = Math.min(MAX_FRAME_MS, Math.max(0, Number(elapsedMs) || 0));
        exact += Math.max(0, Number(pxPerSec) || 0) * ms / 1000;
    }
    exact = Math.min(max, Math.max(0, exact));
    return { position: exact, scrollTo: Math.round(exact), atEnd: max - exact <= END_SLACK_PX };
}
