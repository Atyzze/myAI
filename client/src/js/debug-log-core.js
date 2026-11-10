// What the system log keeps and how it reads, without a database or a page: debug-log.js stores
// the entries, this decides their text. An entry is { seq, t, s, l, c, m }: its number, the time,
// the session (one page load), the level (info, warn or error), what it is about and the message.

export const LOG_MAX_ENTRIES = 5000;
export const LOG_MAX_MESSAGE_CHARS = 2000;
export const LOG_LEVELS = Object.freeze(['info', 'warn', 'error']);

export function clampMessage(text, max = LOG_MAX_MESSAGE_CHARS) {
    const value = String(text == null ? '' : text);
    return value.length <= max ? value : `${value.slice(0, max)}… (${value.length - max} more characters)`;
}

// An error keeps its name, its message and the first lines of its stack: where it was thrown is
// the part that matters, and the whole stack of every error would crowd out everything else.
function describeValue(value) {
    if (value == null) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'object' && (value instanceof Error || ('name' in value && 'message' in value && 'stack' in value))) {
        const head = `${value.name || 'Error'}: ${value.message || ''}`;
        const frames = String(value.stack || '').split('\n').slice(1)
            .map(line => line.trim()).filter(Boolean).slice(0, 3);
        return frames.length ? `${head} (${frames.join(' ← ')})` : head;
    }
    if (typeof value === 'object' && typeof value.name === 'string' && typeof value.message === 'string') {
        return `${value.name}: ${value.message}`;
    }
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
    } catch (_) {}
    try { return String(value); } catch (_) { return '[unprintable]'; }
}

export function stringifyArgs(args) {
    return clampMessage((args || []).map(describeValue).join(' '));
}

export function normalLevel(level) {
    if (level === 'error') return 'error';
    if (level === 'warn' || level === 'warning') return 'warn';
    return 'info';
}

function pad(n, width = 2) { return String(n).padStart(width, '0'); }

export function formatLogTime(t) {
    const d = new Date(Number(t) || 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const LEVEL_TAGS = Object.freeze({ info: 'INFO ', warn: 'WARN ', error: 'ERROR' });

// Oldest first, as it happened, with a line between page loads so each session reads on its own.
export function formatLogEntries(entries) {
    const lines = [];
    let session = null;
    for (const entry of entries || []) {
        if (!entry) continue;
        if (entry.s !== session) {
            session = entry.s;
            lines.push(`──────── session ${String(session || '?').slice(0, 8)} ────────`);
        }
        const level = LEVEL_TAGS[normalLevel(entry.l)];
        lines.push(`${formatLogTime(entry.t)}  ${level}  [${entry.c || 'app'}] ${entry.m || ''}`);
    }
    return lines.join('\n');
}

// How many of the oldest entries go so that at most max are kept.
export function entriesToDrop(count, max = LOG_MAX_ENTRIES) {
    return Math.max(0, (Number(count) || 0) - max);
}

// The session before this one never said it was ending: no pagehide, so the page did not close or
// reload normally. Either the browser crashed, or the phone or the browser ended it, most often in
// the background. Which of those is likeliest is told by whether the app was on screen at its end.
export function describeUnclosedSession(previous, lastEntry = null) {
    if (!previous || !previous.id || previous.endedAt) return '';
    const lastAt = Math.max(Number(previous.lastAt) || 0, Number(lastEntry && lastEntry.t) || 0);
    const started = previous.startedAt ? formatLogTime(previous.startedAt) : 'an unknown time';
    const last = lastEntry
        ? ` Its last entry, at ${formatLogTime(lastEntry.t)}, was: [${lastEntry.c || 'app'}] ${clampMessage(lastEntry.m, 300)}`
        : (lastAt ? ` It last wrote to the log at ${formatLogTime(lastAt)}.` : '');
    const where = previous.visibility === 'hidden'
        ? ' The app was in the background then, where a phone often ends a browser to free memory.'
        : previous.visibility === 'visible'
            ? ' The app was on screen then, so the browser most likely crashed or was closed from outside.'
            : '';
    return `The previous session (build ${previous.build || '?'}, started ${started}) ended without the page closing `
        + `normally.${last}${where}`;
}
