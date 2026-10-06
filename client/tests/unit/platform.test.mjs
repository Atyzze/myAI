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

function setGlobal(name, value) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

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
    const upgradeRequests = [];

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
        _upgradeRequests: upgradeRequests,
        open(_name, _version) {
            const upgradeTx = { aborted: false, abort() { this.aborted = true; } };
            const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: db, transaction: upgradeTx };
            upgradeRequests.push(req);
            queueMicrotask(() => {
                if (blocked) req.onblocked?.();
                req.onupgradeneeded?.({ oldVersion: 0, newVersion: 8 });
                if (upgradeTx.aborted) { req.error = new Error('AbortError'); req.onerror?.(); return; }
                if (failUpgrade) return;
                connections.push(db);
                req.onsuccess?.();
            });
            return req;
        }
    };
}

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
    ok(fake._upgradeRequests.length === 1 && fake._upgradeRequests[0].transaction.aborted === true,
       'a throwing upgrade aborts the versionchange transaction, so a half-built schema is '
       + 'never committed under the new version number');
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
    const fake = makeFakeIndexedDb();
    setGlobal('indexedDB', fake);
    const { openDB } = await import('../../src/js/idb-min.js?veto');
    let busy = true;
    let blockedInfo = null;
    let closedCalls = 0;
    await openDB('veto-db', 1, {
        canClose: () => !busy,
        onBlocked: info => { blockedInfo = info; },
        onClosed: () => { closedCalls++; }
    });
    fake._db.onversionchange();
    ok(fake._db.closed === false && blockedInfo && blockedInfo.holding === true,
       'a tab that is recording keeps its connection when a newer version asks for it');
    ok(typeof blockedInfo.release === 'function',
       'and is handed a way to give the connection up later, because the browser only asks once');
    busy = false;
    blockedInfo.release();
    ok(fake._db.closed === true && closedCalls === 1,
       'so once the recording is over the waiting version gets the database without anyone closing a tab');
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
    setGlobal('navigator', {});
    setGlobal('document', { visibilityState: 'visible', addEventListener() {} });
    const wake = await import('../../src/js/wake-lock.js?unsupported');
    ok(await wake.enableWakeLock() === false, 'an unsupported browser reports failure instead of throwing');
    await wake.disableWakeLock();
    ok(true, 'disabling without a lock is a safe no-op');
}
{
    setGlobal('navigator', { wakeLock: { request: async () => { throw new Error('denied'); } } });
    setGlobal('document', { visibilityState: 'visible', addEventListener() {} });
    const wake = await import('../../src/js/wake-lock.js?denied');
    ok(await wake.enableWakeLock() === false, 'a denied wake lock is reported, not thrown');
}
{
    let released = 0;
    let letRequestFinish = null;
    const pending = new Promise(resolve => { letRequestFinish = resolve; });

    setGlobal('navigator', {
        wakeLock: {
            request: async () => {
                await pending;
                return { addEventListener() {}, release: async () => { released++; } };
            }
        }
    });
    setGlobal('document', { visibilityState: 'visible', addEventListener() {} });

    const wake = await import('../../src/js/wake-lock.js?race');
    const enabling = wake.enableWakeLock();
    await wake.disableWakeLock();
    letRequestFinish();
    const held = await enabling;

    ok(held === false,
       'a lock that arrives after the user switched the screen lock off is not reported as held');
    eq(released, 1,
       'a lock granted after it was switched off is released at once, instead of keeping the '
       + 'screen awake with nothing left that can ever release it');
}

{
    let requests = 0;
    let releases = 0;
    let letRequestFinish = null;
    const gate = new Promise(resolve => { letRequestFinish = resolve; });
    const visibilityHandlers = [];

    setGlobal('navigator', {
        wakeLock: {
            request: async () => {
                requests++;
                await gate;
                return { addEventListener() {}, release: async () => { releases++; } };
            }
        }
    });
    setGlobal('document', {
        visibilityState: 'visible',
        addEventListener(type, fn) { if (type === 'visibilitychange') visibilityHandlers.push(fn); }
    });

    const wake = await import('../../src/js/wake-lock.js?double');
    const first = wake.enableWakeLock();
    for (const fn of visibilityHandlers) fn();
    const second = wake.enableWakeLock();
    letRequestFinish();
    await Promise.all([first, second]);

    eq(requests, 1,
       'a foreground flip during a pending request shares that request instead of orphaning a '
       + 'second screen lock nothing can release');
    await wake.disableWakeLock();
    eq(releases, 1, 'the one lock actually held is released exactly once');
}

{
    let requests = 0;
    let releases = 0;
    const sentinels = [];
    const visibilityHandlers = [];

    setGlobal('navigator', {
        wakeLock: {
            request: async () => {
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

    const wake = await import('../../src/js/wake-lock.js?stale');
    await wake.enableWakeLock();
    sentinels[0].drop();
    for (const fn of visibilityHandlers) fn();
    await macrotask();
    eq(requests, 2, 'a dropped lock is re-acquired');

    sentinels[0].drop();
    await wake.disableWakeLock();
    eq(releases, 1,
       'a stale sentinel reporting its own release never clears the lock that replaced it, which '
       + 'would leave the screen awake after the recording stopped');
}

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
    ok(panel.focused === 1, 'focus moves into the panel');

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

    const stampDocument = build => setGlobal('document', {
        querySelector(selector) {
            if (selector !== 'meta[name="myai-build"]' || build == null) return null;
            return { getAttribute: () => String(build) };
        },
        getElementById: () => null
    });

    stampDocument(null);
    installNavigator({
        controller: workerThatReports('v34'),
        getRegistration: async () => null,
        addEventListener() {}
    });
    await version.paintAppVersion(label, { timeoutMs: 50 })();
    eq(label.textContent, 'v34', 'the label shows the version reported by the serving worker');

    stampDocument(34);
    eq(version.documentBuild(), 'v34', 'version: the document carries the build it was itself served as');
    stampDocument(null);
    eq(version.documentBuild(), null, 'version: and an unstamped document claims nothing');

    {
        stampDocument(96);
        installNavigator({});
        await version.paintAppVersion(label, { timeoutMs: 30 })();
        eq(label.textContent, 'v96',
           'version: a page with no worker at all still knows which build it is, from its own stamp');
    }

    {
        stampDocument(96);
        installNavigator({
            controller: workerThatReports('v97'),
            getRegistration: async () => null,
            addEventListener() {}
        });
        await version.paintAppVersion(label, { timeoutMs: 50 })();
        eq(label.textContent, 'v96 \u203a v97',
           'version: a worker newer than the document this page was served is an update, on the very first paint');
        eq(version.updateState().loaded, 'v96',
           'version: the document stamp wins over the worker for what is running, because it cannot be wrong');
    }
    stampDocument(null);

    installNavigator({
        controller: null,
        getRegistration: async () => ({ active: workerThatReports('v35') }),
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 50 }), 'v35',
       'an installed but not yet controlling worker is still asked');

    installNavigator({
        controller: silentWorker,
        getRegistration: async () => null,
        addEventListener() {}
    });
    await version.paintAppVersion(label, { timeoutMs: 30 })();
    eq(label.textContent, 'dev', 'an unanswered request degrades to a plain label');

    installNavigator({});
    eq(await version.readShellVersion({ timeoutMs: 30 }), null,
       'with no worker there is no version to report');
    await version.paintAppVersion(label, { timeoutMs: 30 })();
    eq(label.textContent, 'dev', 'the label degrades rather than showing a number it cannot verify');

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
    eq(label.textContent, 'v34 \u203a v35',
       'a worker taking over mid-session is an update waiting, not the build this page is running');
    eq(version.updateState().loaded, 'v34',
       'version: the page keeps reporting the build it was actually served');
    eq(version.updateState().pending, 'v35', 'version: and names the one that is ready');

    {
        let reloads = 0;
        const alerts = [];
        setGlobal('alert', message => alerts.push(String(message)));
        version.setUpdateReloader(() => { reloads++; });

        version.setUpdateBusyCheck(() => true);
        eq(await version.appUpdate(), 'blocked',
           'version: tapping the version during a recording does not reload the page out from under it');
        eq(reloads, 0, 'version: nothing is reloaded while a recording is running');
        ok(/Something is still running in this tab/.test(alerts[0] || '') && /Let it finish or stop it/.test(alerts[0] || ''),
           'version: and the reason is said plainly');

        version.setUpdateBusyCheck(() => false);
        eq(await version.appUpdate(), 'reload',
           'version: tapping it when idle loads the build that is waiting');
        eq(reloads, 1, 'version: exactly once');
        version.setUpdateReloader(null);
    }

    // A worker as the browser shows it to a page: it answers the version question, has a state, and
    // tells when that state changes. `outcome` is where its install ends: installed (and waiting,
    // since another worker serves), redundant (the install failed), or nothing yet.
    function fakeWorker(versionLabel, state = 'installing') {
        const listeners = new Set();
        const worker = {
            state,
            messages: [],
            postMessage(data, transfer) {
                worker.messages.push(data && data.type);
                if (data && data.type === 'version' && transfer && transfer[0]) {
                    transfer[0].postMessage({ type: 'version', version: versionLabel });
                }
                if (data && data.type === 'activate-now' && worker.onActivate) worker.onActivate();
            },
            addEventListener(type, fn) { if (type === 'statechange') listeners.add(fn); },
            removeEventListener(type, fn) { if (type === 'statechange') listeners.delete(fn); },
            become(next) {
                worker.state = next;
                for (const fn of [...listeners]) fn();
            },
            listening: () => listeners.size
        };
        return worker;
    }

    function fakeRegistration({ serving, onUpdate }) {
        const registration = {
            active: serving,
            installing: null,
            waiting: null,
            updates: 0,
            async update() { registration.updates++; if (onUpdate) onUpdate(registration); },
            listeners: new Set(),
            addEventListener(type, fn) { if (type === 'updatefound') registration.listeners.add(fn); },
            startInstall(worker) {
                registration.installing = worker;
                for (const fn of registration.listeners) fn();
            },
            finishInstall(worker, outcome) {
                registration.installing = null;
                if (outcome === 'installed') registration.waiting = worker;
                worker.become(outcome);
            }
        };
        return registration;
    }

    {
        const serving = fakeWorker('v40', 'activated');
        const next = fakeWorker('v41');
        const registration = fakeRegistration({ serving, onUpdate: reg => {
            reg.startInstall(next);
            setTimeout(() => reg.finishInstall(next, 'installed'), 30);
        } });
        installNavigator({ controller: serving, getRegistration: async () => registration, addEventListener() {} });
        await version.paintAppVersion(label, { timeoutMs: 50, activationTimeoutMs: 3000 })();
        eq(label.textContent, 'v40', 'version: a page with nothing waiting shows only its own build');
        eq(await version.appUpdate(), 'ready',
           'version: tapping the version asks the registration for a newer build');
        eq(registration.updates, 1, 'version: which is one real update check, not a page reload');
        eq(label.textContent, 'v40 \u203a v41',
           'version: a build that is found is shown beside the one running, never as the one running');
        eq(version.updateState().waiting, 'v41',
           'version: it is installed and waits to be asked, rather than taking over this tab by itself');
        ok(!next.messages.includes('activate-now'), 'version: finding it does not ask it to take over');

        let reloads = 0;
        let reloadedAfterTakeover = false;
        const controllerListeners = [];
        installNavigator({
            controller: serving,
            getRegistration: async () => registration,
            addEventListener(type, fn) { if (type === 'controllerchange') controllerListeners.push(fn); },
            removeEventListener(type, fn) {
                const at = controllerListeners.indexOf(fn);
                if (at >= 0) controllerListeners.splice(at, 1);
            }
        });
        let tookOver = false;
        next.onActivate = () => setTimeout(() => {
            tookOver = true;
            registration.active = next;
            registration.waiting = null;
            next.become('activated');
            for (const fn of [...controllerListeners]) fn();
        }, 20);
        version.setUpdateReloader(() => { reloads++; reloadedAfterTakeover = tookOver; });
        version.setUpdateBusyCheck(() => false);
        eq(await version.appUpdate(), 'reload', 'version: tapping it then reloads into it');
        ok(next.messages.includes('activate-now'), 'version: after asking the waiting build to take over');
        ok(reloads === 1 && reloadedAfterTakeover,
           'version: and only once it has, so the reload is served by the new build and not by the old one again');
        version.setUpdateReloader(null);
    }

    {
        const serving = fakeWorker('v40', 'activated');
        const next = fakeWorker('v41');
        const registration = fakeRegistration({ serving, onUpdate: reg => reg.startInstall(next) });
        installNavigator({ controller: serving, getRegistration: async () => registration, addEventListener() {} });
        await version.paintAppVersion(label, { timeoutMs: 40, activationTimeoutMs: 150 })();
        eq(await version.appUpdate(), 'installing',
           'version: a build still downloading is never called ready, because reloading now would land on the old one');
        eq(label.textContent, 'v40 \u27f3',
           'version: and the badge shows work in progress rather than a build to tap');
        eq(version.updateState().pending, null,
           'version: nothing is offered for reload until the new worker is the one serving');
        eq(await version.appUpdate(), 'installing',
           'version: tapping again while it downloads does not reload into the old build');
        registration.finishInstall(next, 'installed');
        await macrotask();
        await macrotask();
        eq(label.textContent, 'v40 \u203a v41',
           'version: a download that finishes after the check gave up waiting is still shown once it is ready');
    }

    {
        const serving = fakeWorker('v40', 'activated');
        let attempt = 0;
        const registration = fakeRegistration({ serving, onUpdate: reg => {
            attempt++;
            const next = fakeWorker('v41');
            reg.startInstall(next);
            setTimeout(() => reg.finishInstall(next, attempt === 1 ? 'redundant' : 'installed'), 20);
        } });
        const button = { textContent: '', disabled: false };
        const panel = { textContent: '' };
        setGlobal('document', {
            querySelector: () => null,
            getElementById: id => (id === 'help-update-btn' ? button : id === 'help-version-state' ? panel : null)
        });
        installNavigator({ controller: serving, getRegistration: async () => registration, addEventListener() {} });
        await version.paintAppVersion(label, { timeoutMs: 40, activationTimeoutMs: 3000 })();
        eq(await version.appUpdate(), 'failed',
           'version: an install that fails is reported as failed, not left installing');
        eq(label.textContent, 'v40 \u26a0', 'version: the badge says something went wrong');
        eq(version.updateState().incoming, null, 'version: nothing is said to be downloading any more');
        ok(button.textContent === 'Try installing v41 again' && !button.disabled,
           `version: and the button offers to try again instead of staying disabled on "Installing v41..." (${button.textContent})`);
        ok(/could not be installed/.test(panel.textContent), `version: the overlay says what happened (${panel.textContent})`);
        eq(await version.appUpdate(), 'ready', 'version: trying again installs it');
        eq(registration.updates, 2, 'version: with a second real update check');
        eq(label.textContent, 'v40 \u203a v41', 'version: and it is then offered like any other');
        stampDocument(null);
    }

    {
        stampDocument(130);
        const serving = fakeWorker('v129', 'activated');
        const waiting = fakeWorker('v130', 'installed');
        const registration = fakeRegistration({ serving });
        registration.waiting = waiting;
        installNavigator({ controller: null, getRegistration: async () => registration, addEventListener() {} });
        await version.paintAppVersion(label, { timeoutMs: 40 })();
        eq(label.textContent, 'v130',
           'version: a page loaded past the worker (a hard reload) is not offered the older build still serving');
        ok(waiting.messages.includes('activate-now'),
           'version: it asks its own build, waiting, to take over, so the next reload does not go back to the older one');
        stampDocument(null);
    }

    {
        const serving = fakeWorker('v40', 'activated');
        const waiting = fakeWorker('v41', 'installed');
        const registration = fakeRegistration({ serving });
        registration.waiting = waiting;
        installNavigator({ controller: serving, getRegistration: async () => registration, addEventListener() {} });
        await version.paintAppVersion(label, { timeoutMs: 40 })();
        eq(label.textContent, 'v40 \u203a v41',
           'version: a build already waiting when the page opens is offered at once, without a check');
        const newer = fakeWorker('v42');
        registration.waiting = null;
        waiting.become('redundant');
        eq(version.updateState().waiting, null,
           'version: and no longer offered once a newer install has replaced it');
        registration.startInstall(newer);
        await macrotask();
        await macrotask();
        eq(label.textContent, 'v40 \u27f3', 'version: an install the browser starts by itself is followed too');
        registration.finishInstall(newer, 'installed');
        await macrotask();
        await macrotask();
        eq(label.textContent, 'v40 \u203a v42', 'version: up to the build it installs');
    }

    {
        installNavigator({
            controller: workerThatReports('v40'),
            getRegistration: async () => ({
                active: workerThatReports('v40'), installing: null, waiting: null,
                update: async () => {}
            }),
            addEventListener() {}
        });
        await version.paintAppVersion(label, { timeoutMs: 50 })();
        const pendingTimers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
        const timersBefore = pendingTimers();
        eq(await version.appUpdate(), 'current', 'version: a check that finds nothing says so');
        eq(label.textContent, 'v40 \u2713',
           'version: and the label confirms the check happened rather than looking untouched');
        eq(pendingTimers(), timersBefore,
           'version: and a finished check leaves no time limit running that would keep the page or a test run busy');
    }

    {
        stampDocument(96);
        let unregistered = 0;
        let reloads = 0;
        let updates = 0;
        setGlobal('fetch', async () => ({
            ok: true, text: async () => "const VERSION     = 'v98';"
        }));
        setGlobal('caches', { keys: async () => ['myai-shell-v96'], delete: async () => true });
        installNavigator({
            controller: workerThatReports('v96'),
            getRegistration: async () => ({
                active: workerThatReports('v96'), installing: null, waiting: null,
                update: async () => { updates++; },
                unregister: async () => { unregistered++; return true; }
            }),
            addEventListener() {}
        });
        version.setUpdateReloader(() => { reloads++; });
        version.setUpdateBusyCheck(() => false);
        await version.paintAppVersion(label, { timeoutMs: 40 })();
        eq(label.textContent, 'v96', 'version: the page starts on the build it was served');

        eq(await version.appUpdate(), 'ready',
           'version: a server holding a newer build than the worker will admit is still an update to act on');
        eq(updates, 1, 'version: the polite update check is tried first');
        eq(version.updateState().server, 'v98',
           'version: the build the server actually holds is read straight from the worker script');
        eq(label.textContent, 'v96 \u203a v98',
           'version: and the badge names it even though no new worker ever appeared');

        eq(await version.appUpdate(), 'force',
           'version: tapping again clears the installed shell rather than reloading into the same old build');
        eq(unregistered, 1, 'version: which means unregistering the worker that will not move');
        eq(reloads, 1, 'version: and then reloading');

        version.setUpdateBusyCheck(() => true);
        eq(await version.appUpdate(), 'blocked',
           'version: except during a recording, where clearing the shell waits like any other reload');
        eq(unregistered, 1, 'version: nothing is cleared mid-recording');
        version.setUpdateBusyCheck(() => false);
        version.setUpdateReloader(null);
        setGlobal('fetch', undefined);
        setGlobal('caches', undefined);
        stampDocument(null);
    }

    {
        installNavigator({
            controller: workerThatReports('v40'),
            getRegistration: async () => null,
            addEventListener() {}
        });
        await version.paintAppVersion(label, { timeoutMs: 30 })();
        eq(await version.appUpdate(), 'current',
           'version: a check with no registration to ask still settles');
        eq(label.textContent, 'v40 \u26a0',
           'version: and says the check did not get through, rather than claiming to be up to date');
    }

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

    installNavigator({
        controller: { postMessage(_data, transfer) { transfer[0].postMessage({ type: 'version' }); } },
        getRegistration: async () => null,
        addEventListener() {}
    });
    eq(await version.readShellVersion({ timeoutMs: 50 }), null,
       'a malformed reply is treated as no answer');
}

{
    const version = await import('../../src/js/version.js');
    const realFetch = globalThis.fetch;
    let cancelled = false;
    setGlobal('fetch', (_url, init = {}) => new Promise((_resolve, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => {
            cancelled = true;
            reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
    }));
    const outcome = await Promise.race([
        version.refreshWorkerScript({ timeoutMs: 40 }),
        new Promise(resolve => setTimeout(() => resolve('still waiting'), 1500))
    ]);
    eq(outcome, null,
       'update check: a server that takes the request for the new worker and never answers is given up on, so the check cannot stay on Checking... for good');
    ok(cancelled, 'update check: and the request it gave up on is cancelled rather than left open');

    let asked = null;
    setGlobal('fetch', async (_url, init = {}) => {
        asked = init;
        return { ok: true, async text() { return "const VERSION     = 'v135';"; } };
    });
    eq(await version.refreshWorkerScript({ timeoutMs: 1000 }), 'v135', 'update check: a server that answers is read as before');
    eq(asked && asked.cache, 'reload',
       'update check: the worker script is fetched past the HTTP cache, so a stale cached copy cannot hide a new build');
    setGlobal('fetch', realFetch);
}

console.log(`✓ all ${assertions} platform assertions passed`);
emitTestResult('platform-unit', 'pass', { assertions });
