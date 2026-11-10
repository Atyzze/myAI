// The system log (Build 143). The app runs as an installed web app with no address bar and no
// console to look at, so what it does is written to a database of its own on this device and can
// be read from ❓ → 🧾 Open system logs. It is on from the first line main.js runs, keeps the last
// LOG_MAX_ENTRIES entries across reloads and crashes, and sends nothing anywhere.
//
// Entries are buffered and written about once a second; a warning or an error is written at
// once, and flush() lets a caller wait until what it logged is on disk, as Stop does before each
// of its steps. The log lives in its own database so it never takes part in, waits for or slows
// down a write of a recording.
import { openDB } from './idb-min.js';
import { clampMessage, stringifyArgs, normalLevel, entriesToDrop, describeUnclosedSession,
         formatLogEntries, LOG_MAX_ENTRIES } from './debug-log-core.js';

export const LOG_DB_NAME = 'myai-system-log';
const LOG_DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';
const FLUSH_MS = 1000;
const TRIM_EVERY_WRITES = 100;
const UNINSTALLED_KEEP = 500;

function randomId() {
    try { return crypto.randomUUID(); } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function openLogDatabase() {
    return openDB(LOG_DB_NAME, LOG_DB_VERSION, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'seq', autoIncrement: true });
            if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        }
    });
}

const SESSION_LOCK_PREFIX = 'myai-log-session-';
// Without Web Locks, a session is taken to be gone when it has not written for this long; a page
// that is open writes its session record at least every LOG_TOUCH_MS.
const SESSION_GONE_AFTER_MS = 10 * 60 * 1000;
export const LOG_TOUCH_MS = 2 * 60 * 1000;

// A page holds a Web Lock named after its session for as long as it lives, and the browser lets
// it go when the page closes, crashes or is killed. So which earlier sessions are still open is a
// question of which of those locks are held; null when the browser cannot say.
async function liveSessionsByLock() {
    try {
        if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.query !== 'function') return null;
        const { held = [] } = await navigator.locks.query();
        return new Set(held.map(lock => String(lock.name || ''))
            .filter(name => name.startsWith(SESSION_LOCK_PREFIX))
            .map(name => name.slice(SESSION_LOCK_PREFIX.length)));
    } catch (_) {
        return null;
    }
}

function holdSessionLock(id) {
    try {
        if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') return;
        navigator.locks.request(SESSION_LOCK_PREFIX + id, () => new Promise(() => {})).catch(() => {});
    } catch (_) {}
}

export function createDebugLog({ open = openLogDatabase, now = () => Date.now(), sessionId = randomId(),
                                 maxEntries = LOG_MAX_ENTRIES, liveSessions = liveSessionsByLock,
                                 holdSession = holdSessionLock } = {}) {
    let db = null;
    let installed = false;
    let failed = false;
    let buffer = [];
    let timer = null;
    let writing = null;
    let writesSinceTrim = 0;
    let sessionDirty = true;
    const session = { key: `session:${sessionId}`, id: sessionId, startedAt: now(), lastAt: 0, build: null, visibility: null };

    function add(level, category, message) {
        buffer.push({ t: now(), s: sessionId, l: normalLevel(level), c: String(category || 'app'), m: clampMessage(message) });
        // Until the database is open (or when the browser refused it) the entries wait in memory,
        // the newest few hundred of them; install writes them once it can.
        if (!db) {
            if (buffer.length > UNINSTALLED_KEEP) buffer.splice(0, buffer.length - UNINSTALLED_KEEP);
            return;
        }
        if (normalLevel(level) !== 'info') { flush().catch(() => {}); return; }
        if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_MS);
    }

    async function writeBatch() {
        const batch = buffer;
        buffer = [];
        if ((!batch.length && !sessionDirty) || !db) return;
        if (batch.length) session.lastAt = batch[batch.length - 1].t;
        else session.lastAt = now();
        sessionDirty = false;
        const tx = db.transactionOver([ENTRIES, META], 'readwrite');
        for (const entry of batch) tx.stores[ENTRIES].add(entry).catch(() => {});
        tx.stores[META].put({ ...session }).catch(() => {});
        try {
            await tx.done;
        } catch (err) {
            buffer = [...batch, ...buffer].slice(-UNINSTALLED_KEEP);
            sessionDirty = true;
            throw err;
        }
        writesSinceTrim += batch.length;
        if (writesSinceTrim >= TRIM_EVERY_WRITES) {
            writesSinceTrim = 0;
            await trim();
        }
    }

    async function trim() {
        const tx = db.transaction(ENTRIES, 'readwrite');
        const drop = entriesToDrop(await tx.store.count(), maxEntries);
        let cursor = drop > 0 ? await tx.store.openCursor() : null;
        for (let n = 0; cursor && n < drop; n++) {
            await cursor.delete();
            cursor = await cursor.continue();
        }
        await tx.done;
    }

    // Writes everything logged so far; settles once it is on disk, or at once when the log has no
    // database (not installed, or the browser refused it).
    function flush() {
        if (!installed || failed || !db) return Promise.resolve();
        if (timer) { clearTimeout(timer); timer = null; }
        const run = (writing || Promise.resolve()).then(() => writeBatch());
        const tracked = run.catch(() => {}).then(() => { if (writing === tracked) writing = null; });
        writing = tracked;
        return run;
    }

    // The newest entry a session wrote. Tabs write side by side, so the newest entry of the log
    // may belong to another one.
    async function lastEntryOf(id) {
        const tx = db.transaction(ENTRIES);
        let cursor = await tx.store.openCursor(null, 'prev');
        let entry = null;
        while (cursor) {
            if (cursor.value && cursor.value.s === id) { entry = cursor.value; break; }
            cursor = await cursor.continue();
        }
        await tx.done;
        return entry;
    }

    // Every earlier session that is gone, and never said it was ending, is reported once, with the
    // last thing it logged; then its record goes, as does that of every session that ended normally.
    async function reportSessionsThatWereCutOff() {
        const sessions = (await db.getAll(META)).filter(row => row && row.id && row.id !== sessionId
                                                                && String(row.key || '').startsWith('session:'));
        if (!sessions.length) return;
        const alive = await liveSessions();
        for (const previous of sessions.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
            const gone = alive ? !alive.has(previous.id)
                : now() - Math.max(Number(previous.lastAt) || 0, Number(previous.startedAt) || 0) > SESSION_GONE_AFTER_MS;
            if (!gone) continue;
            if (!previous.endedAt) {
                const note = describeUnclosedSession(previous, await lastEntryOf(previous.id).catch(() => null));
                if (note) buffer.unshift({ t: now(), s: sessionId, l: 'warn', c: 'app', m: note });
            }
            await db.delete(META, previous.key);
        }
    }

    async function install({ build = null, visibility = null } = {}) {
        if (installed) return;
        installed = true;
        session.build = build;
        session.visibility = visibility;
        try {
            holdSession(sessionId);
            db = await open();
            await reportSessionsThatWereCutOff();
            sessionDirty = true;
            await flush();
        } catch (err) {
            failed = true;
            db = null;
        }
    }

    function noteVisibility(visibility) {
        session.visibility = visibility;
        sessionDirty = true;
    }

    // Shown again from the back/forward cache: the page did not end after all.
    function markResumed() {
        delete session.endedAt;
        sessionDirty = true;
    }

    // The page is closing or reloading normally: the next session does not report it as cut off.
    function markEnded() {
        session.endedAt = now();
        sessionDirty = true;
        return flush();
    }

    // Without Web Locks the next session judges whether this one is still open by when it last
    // wrote, so an open page writes its record now and then even when it has nothing to log.
    function touch() {
        sessionDirty = true;
        return flush();
    }

    async function read() {
        await flush().catch(() => {});
        if (!db) return [...buffer];
        const stored = await db.getAll(ENTRIES);
        return [...stored, ...buffer];
    }

    async function clear() {
        buffer = [];
        if (!db) return;
        await flush().catch(() => {});
        await db.clear(ENTRIES);
    }

    return {
        add, flush, install, markEnded, markResumed, read, clear, noteVisibility, touch,
        get sessionId() { return sessionId; },
        get installed() { return installed; },
        get stored() { return !!db && !failed; },
        async text() { return formatLogEntries(await read()); }
    };
}

export const systemLog = createDebugLog();

export function logEvent(category, message, level = 'info') {
    try { systemLog.add(level, category, message); } catch (_) {}
}

// Settles once what was logged is on disk, or after timeoutMs whatever happens, so logging can
// never hold up the work it describes.
export function flushSystemLog(timeoutMs = 400) {
    return Promise.race([
        systemLog.flush().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
}

function memoryNote() {
    const memory = typeof performance !== 'undefined' && performance.memory;
    if (!memory || !memory.usedJSHeapSize) return '';
    const mb = bytes => Math.round(bytes / (1024 * 1024));
    return `heap ${mb(memory.usedJSHeapSize)} MB of ${mb(memory.jsHeapSizeLimit)} MB`;
}

export function describeMemory() { return memoryNote(); }

function environmentLine(build) {
    const parts = [`build ${build || '?'}`];
    try {
        const standalone = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
            || navigator.standalone === true;
        parts.push(standalone ? 'installed app (standalone)' : 'browser tab');
    } catch (_) {}
    try { parts.push(navigator.userAgent); } catch (_) {}
    try { if (navigator.hardwareConcurrency) parts.push(`${navigator.hardwareConcurrency} cores`); } catch (_) {}
    try { if (navigator.deviceMemory) parts.push(`${navigator.deviceMemory} GB memory`); } catch (_) {}
    try { parts.push(`screen ${screen.width}x${screen.height} @${window.devicePixelRatio || 1}x`); } catch (_) {}
    try { parts.push(navigator.onLine === false ? 'offline' : 'online'); } catch (_) {}
    try { parts.push(`page ${document.visibilityState}`); } catch (_) {}
    const memory = memoryNote();
    if (memory) parts.push(memory);
    return parts.join(' · ');
}

let _wired = false;

// Starts the log for this page: every console message, every uncaught error and rejected promise,
// and every change in the page's life (hidden, shown, frozen, resumed, closing, online, offline).
export function installSystemLog({ build = null } = {}) {
    if (_wired) return systemLog.install({ build });
    _wired = true;
    for (const method of ['log', 'info', 'warn', 'error']) {
        const original = typeof console[method] === 'function' ? console[method].bind(console) : null;
        if (!original) continue;
        console[method] = (...args) => {
            try { systemLog.add(method === 'log' ? 'info' : method, 'console', stringifyArgs(args)); } catch (_) {}
            original(...args);
        };
    }
    window.addEventListener('error', event => {
        const where = event.filename ? ` (${String(event.filename).split('/').pop()}:${event.lineno}:${event.colno})` : '';
        logEvent('page', `Uncaught ${stringifyArgs([event.error || event.message])}${where}`, 'error');
    });
    window.addEventListener('unhandledrejection', event => {
        logEvent('page', `Unhandled rejection: ${stringifyArgs([event.reason])}`, 'error');
    });
    document.addEventListener('visibilitychange', () => {
        systemLog.noteVisibility(document.visibilityState);
        logEvent('page', `page ${document.visibilityState}${document.visibilityState === 'hidden' ? '' : ` · ${memoryNote()}`}`);
        if (document.visibilityState === 'hidden') systemLog.flush().catch(() => {});
    });
    document.addEventListener('freeze', () => { logEvent('page', 'page frozen by the browser'); systemLog.flush().catch(() => {}); });
    document.addEventListener('resume', () => logEvent('page', 'page resumed after being frozen'));
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        systemLog.markResumed();
        logEvent('page', 'page shown again from the back/forward cache');
    });
    window.addEventListener('pagehide', event => {
        logEvent('page', `page closing${event.persisted ? ' into the back/forward cache' : ''}`);
        systemLog.markEnded().catch(() => {});
    });
    window.addEventListener('online', () => logEvent('network', 'online'));
    window.addEventListener('offline', () => logEvent('network', 'offline', 'warn'));
    try {
        navigator.serviceWorker?.addEventListener('controllerchange', () => logEvent('update', 'a new service worker took over this page'));
    } catch (_) {}
    if (!navigator.locks || typeof navigator.locks.query !== 'function') {
        const touching = setInterval(() => { systemLog.touch().catch(() => {}); }, LOG_TOUCH_MS);
        touching?.unref?.();
    }
    logEvent('app', `started · ${environmentLine(build)}`);
    const visibility = typeof document !== 'undefined' ? document.visibilityState : null;
    const installing = systemLog.install({ build, visibility });
    try {
        if (navigator.storage?.estimate) {
            Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : null])
                .then(([estimate, persisted]) => {
                    const gb = bytes => (Number(bytes) / 1024 ** 3).toFixed(2);
                    logEvent('storage', `storage ${gb(estimate.usage)} GB used of ${gb(estimate.quota)} GB`
                        + (persisted == null ? '' : persisted ? ' · persistent' : ' · NOT persistent, the browser may clear it'));
                })
                .catch(() => {});
        }
    } catch (_) {}
    return installing;
}
