/* Platform-adapter contracts: the thin modules that stand between the app and
 * three browser APIs. All three were previously untested.
 *
 *   idb-min.js   - the hand-written IndexedDB promise wrapper every durability
 *                  guarantee in the app rests on. A resolved write MUST mean the
 *                  transaction committed, not merely that the request succeeded.
 *   wake-lock.js - screen wake lock, including the re-acquire-on-visible dance
 *                  the OS forces on every backgrounded tab.
 *   help.js      - the guide overlay and its focus handling.
 *   version.js   - the build label, which asks the service worker rather than
 *                  carrying a constant a stale cache could keep showing.
 *
 * Run from the repository root:
 *   node tests/unit/platform.test.mjs
 */
import { emitTestResult } from '../helpers/test-result.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
const eq = (actual, expected, message) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected),
       `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

/* Node exposes some of these globals as getter-only, so install them explicitly. */
function setGlobal(name, value) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/* ──────────────────────────────────────────────────────────────────────────
 * A deliberately small IndexedDB fake.
 *
 * It reproduces only the behaviours idb-min actually depends on, and - crucially
 * - it separates request success from transaction commit, so the wrapper's
 * durability promise can be observed rather than assumed.
 * ────────────────────────────────────────────────────────────────────────── */
const commitLog = [];

function makeRequest(resultFn, tx) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => {
        try {
            req.result = resultFn();
            req.onsuccess?.({ target: req });
        } catch (err) {
            req.error = err;
            tx?.fail(err);
            req.onerror?.({ target: req });
        }
    });
    return req;
}

function makeStore(rows, tx, name) {
    const api = {
        name,
        get: key => makeRequest(() => rows.find(r => r.id === key), tx),
        getAll: () => makeRequest(() => rows.slice(), tx),
        count: () => makeRequest(() => rows.length, tx),
        put: value => makeRequest(() => {
            const i = rows.findIndex(r => r.id === value.id);
            if (i >= 0) rows[i] = value; else rows.push(value);
            tx?.touch();
            return value.id;
        }, tx),
        add: value => makeRequest(() => {
            if (rows.some(r => r.id === value.id)) {
                const err = new Error('ConstraintError');
                err.name = 'ConstraintError';
                throw err;
            }
            rows.push(value);
            tx?.touch();
            return value.id;
        }, tx),
        delete: key => makeRequest(() => {
            const i = rows.findIndex(r => r.id === key);
            if (i >= 0) rows.splice(i, 1);
            tx?.touch();
        }, tx),
        clear: () => makeRequest(() => { rows.length = 0; tx?.touch(); }, tx),
        openCursor: (_q, direction) => makeCursorRequest(rows, tx, direction, false),
        index: () => ({
            get: key => makeRequest(() => rows.find(r => r.id === key), tx),
            getAll: () => makeRequest(() => rows.slice(), tx),
            count: () => makeRequest(() => rows.length, tx),
            openCursor: (_q, direction) => makeCursorRequest(rows, tx, direction, false),
            openKeyCursor: (_q, direction) => makeCursorRequest(rows, tx, direction, true)
        })
    };
    return api;
}

/* A cursor request re-fires onsuccess each time continue()/advance() is called,
   which is exactly the native protocol idb-min re-arms against. */
function makeCursorRequest(rows, tx, direction, keyOnly) {
    const order = direction === 'prev' ? [...rows].reverse() : [...rows];
    let index = 0;
    const req = { onsuccess: null, onerror: null, result: undefined };

    const emit = () => queueMicrotask(() => {
        if (index >= order.length) { req.result = null; req.onsuccess?.(); return; }
        const row = order[index];
        req.result = {
            key: row.id,
            primaryKey: row.id,
            get value() { return keyOnly ? undefined : row; },
            delete() {
                const i = rows.indexOf(row);
                if (i >= 0) rows.splice(i, 1);
                tx?.touch();
                return makeRequest(() => undefined, tx);
            },
            continue() { index++; emit(); },
            advance(n) {
                if (!Number.isInteger(n) || n < 1) throw new TypeError('advance(n) requires n >= 1');
                index += n;
                emit();
            }
        };
        req.onsuccess?.();
    });
    emit();
    return req;
}

function makeFakeIndexedDb({ failUpgrade = false, blocked = false } = {}) {
    const stores = { recordings: [] };
    const connections = [];

    const db = {
        objectStoreNames: {
            _names: Object.keys(stores),
            contains(name) { return this._names.includes(name); }
        },
        closed: false,
        onversionchange: null,
        close() { this.closed = true; },
        createObjectStore(name) {
            stores[name] = stores[name] || [];
            db.objectStoreNames._names.push(name);
            return { createIndex: () => ({}) };
        },
        transaction(name, mode = 'readonly') {
            let writes = 0;
            const tx = {
                mode,
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
                touch() { writes++; },
                fail(err) {
                    tx.error = err;
                    queueMicrotask(() => tx.onerror?.());
                },
                objectStore: () => makeStore(stores[name], tx, name)
            };
            // Commit on a MACROTASK, strictly after any request microtask, so a
            // wrapper that resolved on request-success alone would be observable.
            setTimeout(() => {
                if (tx.error) return;
                if (writes) commitLog.push(`${name}:${writes}`);
                tx.oncomplete?.();
            }, 0);
            return tx;
        }
    };

    return {
        _db: db,
        _stores: stores,
        _connections: connections,
        open(_name, _version) {
            const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: db, transaction: {} };
            queueMicrotask(() => {
                if (blocked) req.onblocked?.();
                req.onupgradeneeded?.({ oldVersion: 0, newVersion: 8 });
                if (failUpgrade) return;                 // upgrade rejected the open
                connections.push(db);
                req.onsuccess?.();
            });
            return req;
        }
    };
}

/* ──────────────────────────────────────────────────────────────────────────
 * IDB-WRAPPER-001 - a resolved write means COMMITTED.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const fake = makeFakeIndexedDb();
    setGlobal('indexedDB', fake);
    if (!globalThis.DOMException) {
        setGlobal('DOMException', class extends Error {
            constructor(message, name) { super(message); this.name = name; }
        });
    }

    const { openDB } = await import('../../src/js/idb-min.js');
    let upgradeArgs = null;
    const db = await openDB('test-db', 8, {
        upgrade(nativeDb, oldVersion, newVersion) {
            upgradeArgs = { oldVersion, newVersion, hasCreate: typeof nativeDb.createObjectStore === 'function' };
        }
    });
    ok(!!db, 'openDB resolves a wrapped database');
    eq(upgradeArgs, { oldVersion: 0, newVersion: 8, hasCreate: true },
       'upgrade runs against the NATIVE database with both version numbers');

    commitLog.length = 0;
    await db.put('recordings', { id: 1, name: 'first' });
    ok(commitLog.length === 1, 'a resolved put has already committed its transaction');

    eq(await db.get('recordings', 1), { id: 1, name: 'first' }, 'get returns the stored row');
    eq(await db.getAll('recordings'), [{ id: 1, name: 'first' }], 'getAll returns every row');
    eq(await db.getAllFromIndex('recordings', 'by-date'), [{ id: 1, name: 'first' }],
       'getAllFromIndex reads through the named index');

    await db.add('recordings', { id: 2, name: 'second' });
    eq((await db.getAll('recordings')).length, 2, 'add appends a new row');

    let constraintError = null;
    try { await db.add('recordings', { id: 2, name: 'duplicate' }); }
    catch (err) { constraintError = err; }
    ok(constraintError && constraintError.name === 'ConstraintError',
       'a unique-key violation rejects rather than silently overwriting');

    await db.delete('recordings', 1);
    eq((await db.getAll('recordings')).map(r => r.id), [2], 'delete removes only the addressed row');
    await db.clear('recordings');
    eq(await db.getAll('recordings'), [], 'clear empties the store');
}

/* ──────────────────────────────────────────────────────────────────────────
 * IDB-CURSOR-002 - cursor iteration, paging hops and key-only cursors.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const fake = makeFakeIndexedDb();
    setGlobal('indexedDB', fake);
    const { openDB } = await import('../../src/js/idb-min.js?cursor');
    const db = await openDB('cursor-db', 1, {});
    for (let i = 1; i <= 5; i++) await db.put('recordings', { id: i, name: `row-${i}` });

    const forward = [];
    let cursor = await db.transaction('recordings').store.openCursor();
    while (cursor) { forward.push(cursor.value.id); cursor = await cursor.continue(); }
    eq(forward, [1, 2, 3, 4, 5], 'openCursor walks every row in order');

    const backward = [];
    cursor = await db.transaction('recordings').store.openCursor(null, 'prev');
    while (cursor) { backward.push(cursor.value.id); cursor = await cursor.continue(); }
    eq(backward, [5, 4, 3, 2, 1], 'a reverse cursor walks newest-first, as the paginator needs');

    // advance(n) is how getRecordingsPage skips to a page offset in one hop.
    cursor = await db.transaction('recordings').store.openCursor(null, 'prev');
    cursor = await cursor.advance(2);
    eq(cursor.value.id, 3, 'advance(n) skips exactly n rows in one hop');

    let advanceError = null;
    const zeroCursor = await db.transaction('recordings').store.openCursor();
    try { await zeroCursor.advance(0); } catch (err) { advanceError = err; }
    ok(advanceError instanceof TypeError, 'advance(0) is rejected, as the IDB spec requires');

    const keys = [];
    let keyCursor = await db.transaction('recordings').store.index('by-rec').openKeyCursor();
    while (keyCursor) { keys.push(keyCursor.key); keyCursor = await keyCursor.continue(); }
    eq(keys, [1, 2, 3, 4, 5], 'a key-only cursor yields keys without deserialising values');

    // Deleting through a cursor is how the fragment sweeps work.
    const tx = db.transaction('recordings', 'readwrite');
    let del = await tx.store.openCursor();
    while (del) {
        if (del.value.id % 2 === 0) await del.delete();
        del = await del.continue();
    }
    await tx.done;
    eq((await db.getAll('recordings')).map(r => r.id), [1, 3, 5],
       'cursor deletion removes exactly the matched rows and the transaction still completes');
    eq(await db.transaction('recordings').store.count(), 3, 'count reflects the deletions');
}

/* ──────────────────────────────────────────────────────────────────────────
 * IDB-FAILURE-003 - errors propagate instead of hanging, and a version change in
 * another tab must not deadlock this one.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const fake = makeFakeIndexedDb({ failUpgrade: true });
    setGlobal('indexedDB', fake);
    const { openDB } = await import('../../src/js/idb-min.js?fail');
    let openError = null;
    try {
        await openDB('broken-db', 9, { upgrade() { throw new Error('migration exploded'); } });
    } catch (err) { openError = err; }
    ok(openError && /migration exploded/.test(openError.message),
       'a throwing upgrade rejects the open rather than hanging forever');
}
{
    const fake = makeFakeIndexedDb();
    setGlobal('indexedDB', fake);
    const { openDB } = await import('../../src/js/idb-min.js?version');
    const db = await openDB('version-db', 1, {});
    ok(typeof fake._db.onversionchange === 'function',
       'the connection installs a versionchange handler');
    ok(fake._db.closed === false, 'the connection stays open until another tab needs an upgrade');
    fake._db.onversionchange();
    ok(fake._db.closed === true,
       'another tab upgrading closes this connection instead of blocking that tab indefinitely');
    ok(!!db, 'the wrapper is still referenced after the close');
}
{
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    setGlobal('indexedDB', makeFakeIndexedDb({ blocked: true }));
    const { openDB } = await import('../../src/js/idb-min.js?blocked');
    await openDB('blocked-db', 2, {});
    console.warn = realWarn;
    ok(warnings.some(w => /blocked by another open tab/i.test(w)),
       'a blocked upgrade is surfaced as a diagnosable warning, not silence');
}

/* ──────────────────────────────────────────────────────────────────────────
 * WAKE-LOCK-001 - hold, release, and the re-acquire-on-visible dance.
 * The OS silently drops a screen wake lock whenever the tab is hidden, so a
 * recorder that does not re-acquire loses the screen mid-session.
 * ────────────────────────────────────────────────────────────────────────── */
{
    let requests = 0;
    let releases = 0;
    const sentinels = [];
    const visibilityHandlers = [];

    setGlobal('navigator', {
        wakeLock: {
            request: async (type) => {
                ok(type === 'screen', 'the wake lock requested is a SCREEN lock');
                requests++;
                const sentinel = {
                    handlers: [],
                    addEventListener(_t, fn) { this.handlers.push(fn); },
                    release: async () => { releases++; },
                    drop() { this.handlers.forEach(fn => fn()); }
                };
                sentinels.push(sentinel);
                return sentinel;
            }
        }
    });
    setGlobal('document', {
        visibilityState: 'visible',
        addEventListener(type, fn) { if (type === 'visibilitychange') visibilityHandlers.push(fn); }
    });

    const wake = await import('../../src/js/wake-lock.js');
    ok(await wake.enableWakeLock() === true, 'enabling acquires a wake lock');
    eq(requests, 1, 'exactly one lock is requested');
    ok(await wake.enableWakeLock() === true, 'enabling twice is idempotent');
    eq(requests, 1, 'a second enable does not request a duplicate lock');

    // The OS drops the lock when the tab is hidden.
    sentinels[0].drop();
    globalThis.document.visibilityState = 'hidden';
    for (const fn of visibilityHandlers) fn();
    eq(requests, 1, 'no lock is requested while the tab is hidden');

    globalThis.document.visibilityState = 'visible';
    for (const fn of visibilityHandlers) fn();
    await macrotask();
    eq(requests, 2, 'returning to the foreground re-acquires the dropped lock');

    await wake.disableWakeLock();
    eq(releases, 1, 'disabling releases the held lock');
    globalThis.document.visibilityState = 'hidden';
    for (const fn of visibilityHandlers) fn();
    globalThis.document.visibilityState = 'visible';
    for (const fn of visibilityHandlers) fn();
    await macrotask();
    eq(requests, 2, 'once disabled, becoming visible does NOT silently re-acquire');
}
{
    // Graceful degradation: recording must proceed on browsers without the API.
    setGlobal('navigator', {});
    setGlobal('document', { visibilityState: 'visible', addEventListener() {} });
    const wake = await import('../../src/js/wake-lock.js?unsupported');
    ok(await wake.enableWakeLock() === false, 'an unsupported browser reports failure instead of throwing');
    await wake.disableWakeLock();
    ok(true, 'disabling without a lock is a safe no-op');
}
{
    // A rejected request (permission, low battery) must not break recording.
    setGlobal('navigator', { wakeLock: { request: async () => { throw new Error('denied'); } } });
    setGlobal('document', { visibilityState: 'visible', addEventListener() {} });
    const wake = await import('../../src/js/wake-lock.js?denied');
    ok(await wake.enableWakeLock() === false, 'a denied wake lock is reported, not thrown');
}

/* ──────────────────────────────────────────────────────────────────────────
 * HELP-001 - the guide overlay opens, closes, and returns focus.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const makeEl = id => ({
        id,
        classes: new Set(),
        attrs: {},
        focused: 0,
        classList: {
            add(c) { this.owner.classes.add(c); },
            remove(c) { this.owner.classes.delete(c); },
            contains(c) { return this.owner.classes.has(c); }
        },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] ?? null; },
        focus() { this.focused++; }
    });
    const overlay = makeEl('helpOverlay');
    overlay.classList.owner = overlay;
    const panel = makeEl('helpPanel');
    panel.classList.owner = panel;
    const opener = makeEl('helpBtn');
    opener.classList.owner = opener;

    const elements = { helpOverlay: overlay, helpPanel: panel, helpBtn: opener };
    setGlobal('document', { activeElement: opener, getElementById: id => elements[id] || null });
    setGlobal('requestAnimationFrame', fn => fn());
    setGlobal('window', globalThis.window || {});

    const help = await import('../../src/js/help.js');
    help.openHelp();
    ok(overlay.classList.contains('open'), 'opening shows the overlay');
    eq(overlay.getAttribute('aria-hidden'), 'false', 'an open overlay is exposed to assistive technology');
    ok(panel.focused === 1, 'focus moves into the panel so the keyboard trap has somewhere to start');

    globalThis.document.activeElement = panel;
    help.closeHelp();
    ok(!overlay.classList.contains('open'), 'closing hides the overlay');
    eq(overlay.getAttribute('aria-hidden'), 'true', 'a closed overlay is hidden from assistive technology');
    ok(opener.focused === 1, 'focus returns to whatever opened the overlay');

    help.closeHelp();
    ok(true, 'closing an already-closed overlay is a safe no-op');

    help.exposeHelpGlobals();
    ok(typeof globalThis.window.openHelp === 'function' && typeof globalThis.window.closeHelp === 'function',
       'the delegated action router can reach both handlers');
}


/* ──────────────────────────────────────────────────────────────────────────
 * VERSION LABEL - the number in the corner must describe the shell that is
 * actually serving the page.
 *
 * It used to be a constant compiled into config.js, duplicated in sw.js and
 * package.json. Three copies is the smaller problem; the real one is that the
 * application copy is itself served cache-first, so a stale shell hands out a
 * stale constant and the label confidently describes a build nobody is running
 * - which is exactly what the label exists to detect. It is now answered by the
 * worker, and the worker is the only place the version is written.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const version = await import('../../src/js/version.js');

    const workerThatReports = label => ({
        postMessage(data, transfer) {
            if (!data || data.type !== 'version') return;
            transfer[0].postMessage({ type: 'version', version: label });
        }
    });
    const silentWorker = { postMessage() {} };

    function installNavigator(serviceWorker) {
        setGlobal('navigator', { serviceWorker });
    }
    const label = { textContent: '' };

    /* A controlling worker answers, and its answer is what gets painted. */
    installNavigator({
        controller: workerThatReports('v34'),
        getRegistration: async () => null,
        addEventListener() {}
    });
    await version.paintAppVersion(label, { timeoutMs: 50 })();
    eq(label.textContent, 'v34', 'the label shows the version reported by the serving worker');

    /* No controller yet (first load, before the worker claims this page): the
       registration's active worker is asked instead. */
    installNavigator({
        controller: null,
        getRegistration: async () => ({ active: workerThatReports('v35') }),
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 50 }), 'v35',
       'an installed but not yet controlling worker is still asked');

    /* A worker that never answers must not leave the label blank forever. */
    installNavigator({
        controller: silentWorker,
        getRegistration: async () => null,
        addEventListener() {}
    });
    await version.paintAppVersion(label, { timeoutMs: 30 })();
    eq(label.textContent, 'dev', 'an unanswered request degrades to a plain label');

    /* No service worker at all: a file:// open, or a browser that refuses to
       register one. There is no shell to describe and the label says so. */
    installNavigator({});
    eq(await version.readShellVersion({ timeoutMs: 30 }), null,
       'with no worker there is no version to report');
    await version.paintAppVersion(label, { timeoutMs: 30 })();
    eq(label.textContent, 'dev', 'the label degrades rather than showing a number it cannot verify');

    /* getRegistration() must never be waited on forever, and a throwing
       container is a degraded label rather than an exception. */
    installNavigator({
        controller: null,
        getRegistration: () => new Promise(() => {}),
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 30 }), null,
       'a registration lookup that never settles times out');
    installNavigator({
        controller: null,
        getRegistration: () => { throw new Error('SecurityError'); },
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 30 }), null,
       'a refused registration lookup is reported as no version');

    /* An update taking over repaints the label, so a rolled-over cache does not
       leave a number from the previous build on screen. */
    let reported = 'v34';
    const controllerListeners = [];
    installNavigator({
        get controller() { return workerThatReports(reported); },
        getRegistration: async () => null,
        addEventListener(type, fn) { if (type === 'controllerchange') controllerListeners.push(fn); }
    });
    await version.paintAppVersion(label, { timeoutMs: 50 })();
    eq(label.textContent, 'v34', 'the label starts on the serving version');
    ok(controllerListeners.length === 1, 'the label listens for a worker taking over');

    reported = 'v35';
    controllerListeners[0]();
    await macrotask();
    await macrotask();
    eq(label.textContent, 'v35', 'a new worker taking over repaints the label');

    /* A refresh that fails after a successful one keeps the confirmed number
       rather than downgrading the label to the no-worker text. */
    {
        let answering = true;
        installNavigator({
            get controller() { return answering ? workerThatReports('v34') : silentWorker; },
            getRegistration: async () => null,
            addEventListener() {}
        });
        const refresh = version.paintAppVersion(label, { timeoutMs: 30 });
        await refresh();
        eq(label.textContent, 'v34', 'the confirmed version is painted');
        answering = false;
        await refresh();
        eq(label.textContent, 'v34', 'a failed refresh keeps the version already confirmed');
    }

    /* A worker replying with junk must not paint junk. */
    installNavigator({
        controller: { postMessage(_data, transfer) { transfer[0].postMessage({ type: 'version' }); } },
        getRegistration: async () => null,
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 50 }), null,
       'a malformed reply is treated as no answer');
}

console.log(`✓ all ${assertions} platform assertions passed`);
emitTestResult('platform-unit', 'pass', { assertions });
