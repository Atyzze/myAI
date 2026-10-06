// An in-memory stand-in for src/js/idb-min.js, so the real db.js (and everything above it) can run
// under node. It keeps the parts of IndexedDB the app relies on: stores with key paths and
// auto-increment, indexes (also compound and unique), key ranges, cursors in both directions,
// and transactions that either commit every write or none of them.

const databases = new Map();

const connections = new Set();

export const memoryIdb = {
    databases,
    failures: [],
    delays: [],
    writes: [],
    ops: [],
    reset() {
        databases.clear();
        connections.clear();
        this.failures = [];
        this.delays = [];
        this.writes = [];
        this.ops = [];
    },
    // Another tab opens a newer version: the database is at that version from now on, so opening
    // it at the old one fails with VersionError, and every open connection is asked, as by
    // versionchange, whether it may close. One that may is closed; one that may not reports itself
    // blocked and keeps a release for later.
    versionChange(dbName = null) {
        const db = dbName ? databases.get(dbName) : [...databases.values()][0];
        if (db) db.version += 1;
        for (const connection of [...connections]) connection.versionChange();
    },
    openConnections() { return [...connections].filter(connection => !connection.closed).length; },
    delayWhile(match, ms) {
        const rule = { match, ms };
        this.delays.push(rule);
        return () => { this.delays = this.delays.filter(item => item !== rule); };
    },
    failNext(match, error = () => new DOMException('Injected failure', 'QuotaExceededError')) {
        this.failures.push({ match, error, once: true });
    },
    failWhile(match, error = () => new DOMException('Injected failure', 'QuotaExceededError')) {
        const rule = { match, error, once: false };
        this.failures.push(rule);
        return () => { this.failures = this.failures.filter(item => item !== rule); };
    },
    poke(storeName, key, change, dbName = null) {
        const db = dbName ? databases.get(dbName) : [...databases.values()][0];
        const store = db && db.stores.get(storeName);
        if (!store) throw new Error(`no store ${storeName}`);
        const serial = JSON.stringify(key);
        const current = store.records.has(serial) ? structuredClone(store.records.get(serial)) : undefined;
        const next = typeof change === 'function' ? change(current) : change;
        if (next === undefined) store.records.delete(serial); else store.records.set(serial, structuredClone(next));
        return next;
    },
    // Resolves once no transaction is open, so writes still in flight (a delayed commit, a beat
    // written by an interval) land before a test moves the clock or lifts a failure rule.
    async idle({ timeoutMs = 3000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if ([...databases.values()].every(db => !db.active || db.active.length === 0)) return true;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        return false;
    },
    rows(storeName, dbName = null) {
        const db = dbName ? databases.get(dbName) : [...databases.values()][0];
        const store = db && db.stores.get(storeName);
        return store ? [...store.records.values()].map(value => structuredClone(value)) : [];
    }
};

function injectedFailure(op) {
    const rule = memoryIdb.failures.find(item => item.match(op));
    if (!rule) return null;
    if (rule.once) memoryIdb.failures = memoryIdb.failures.filter(item => item !== rule);
    return rule.error(op);
}

function keyType(key) {
    if (typeof key === 'number') return Number.isNaN(key) ? null : 1;
    if (key instanceof Date) return 2;
    if (typeof key === 'string') return 3;
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 4;
    if (Array.isArray(key)) return key.every(part => keyType(part) !== null) ? 5 : null;
    return null;
}

export function compareKeys(a, b) {
    const ta = keyType(a);
    const tb = keyType(b);
    if (ta !== tb) return ta - tb;
    if (ta === 5) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = compareKeys(a[i], b[i]);
            if (c !== 0) return c;
        }
        return a.length - b.length;
    }
    const va = ta === 2 ? a.getTime() : a;
    const vb = tb === 2 ? b.getTime() : b;
    return va < vb ? -1 : va > vb ? 1 : 0;
}

class MemoryKeyRange {
    constructor(lower, upper, lowerOpen, upperOpen) {
        Object.assign(this, { lower, upper, lowerOpen: !!lowerOpen, upperOpen: !!upperOpen });
    }
    static only(value) { return new MemoryKeyRange(value, value, false, false); }
    static lowerBound(value, open = false) { return new MemoryKeyRange(value, undefined, open, false); }
    static upperBound(value, open = false) { return new MemoryKeyRange(undefined, value, false, open); }
    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
        return new MemoryKeyRange(lower, upper, lowerOpen, upperOpen);
    }
    includes(key) {
        if (this.lower !== undefined) {
            const c = compareKeys(key, this.lower);
            if (c < 0 || (c === 0 && this.lowerOpen)) return false;
        }
        if (this.upper !== undefined) {
            const c = compareKeys(key, this.upper);
            if (c > 0 || (c === 0 && this.upperOpen)) return false;
        }
        return true;
    }
}
if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = MemoryKeyRange;

function matchesQuery(key, query) {
    if (query === undefined || query === null) return true;
    if (query instanceof MemoryKeyRange || (typeof query === 'object' && typeof query.includes === 'function' && 'lowerOpen' in query)) {
        return query.includes(key);
    }
    return compareKeys(key, query) === 0;
}

function valueAt(value, keyPath) {
    if (Array.isArray(keyPath)) {
        const parts = keyPath.map(path => valueAt(value, path));
        return parts.every(part => keyType(part) !== null) ? parts : undefined;
    }
    let current = value;
    for (const step of String(keyPath).split('.')) {
        if (current == null) return undefined;
        current = current[step];
    }
    return keyType(current) === null ? undefined : current;
}

function nameList(names) {
    return { contains: name => names.includes(name), get length() { return names.length; },
             item: i => names[i], [Symbol.iterator]: () => names[Symbol.iterator]() };
}

function makeStore(name, options = {}) {
    return {
        name,
        keyPath: options.keyPath ?? null,
        autoIncrement: !!options.autoIncrement,
        nextKey: 1,
        records: new Map(),
        indexes: new Map()
    };
}

function sortedEntries(store) {
    return [...store.records.entries()]
        .map(([serial, value]) => ({ key: JSON.parse(serial), value }))
        .sort((a, b) => compareKeys(a.key, b.key));
}

function indexEntries(store, index) {
    const out = [];
    for (const [serial, value] of store.records) {
        const key = valueAt(value, index.keyPath);
        if (key === undefined) continue;
        out.push({ key, primaryKey: JSON.parse(serial), value });
    }
    return out.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.primaryKey, b.primaryKey));
}

class Transaction {
    constructor(db, names, mode) {
        this.db = db;
        this.names = names;
        this.mode = mode;
        this.pending = 0;
        this.finished = false;
        this.error = null;
        this.undo = [];
        this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        this.done.catch(() => {});
        // Like IndexedDB, a transaction waits for every earlier one over the same stores to finish
        // when either of them writes, so two read-then-write updates never interleave.
        const blockers = db.active.filter(other => !other.finished
            && other.names.some(name => names.includes(name))
            && (other.mode === 'readwrite' || mode === 'readwrite'));
        db.active.push(this);
        const leave = () => { db.active = db.active.filter(other => other !== this); };
        this.done.then(leave, leave);
        this.ready = Promise.all(blockers.map(other => other.done.catch(() => {})));
        this.ready.then(() => this.scheduleCommit());
    }
    scheduleCommit() {
        setTimeout(() => {
            if (this.finished || this.pending > 0) return;
            this.finished = true;
            this.resolve();
        }, 0);
    }
    abort(error) {
        if (this.finished) return;
        this.finished = true;
        this.error = error || new DOMException('Transaction aborted', 'AbortError');
        for (const restore of this.undo.reverse()) restore();
        this.undo = [];
        this.reject(this.error);
    }
    run(op, work) {
        if (this.finished) {
            return Promise.reject(this.error || new DOMException('The transaction has finished.', 'TransactionInactiveError'));
        }
        this.pending++;
        memoryIdb.ops.push({ db: this.db.name, store: op.store, action: op.action, mode: this.mode, index: op.index || null });
        const delayRule = memoryIdb.delays.find(item => item.match({ ...op, db: this.db.name, mode: this.mode }));
        const later = delayRule ? fn => setTimeout(fn, delayRule.ms) : fn => queueMicrotask(fn);
        return new Promise((resolve, reject) => {
            this.ready.then(() => later(() => {
                this.pending--;
                if (this.finished) {
                    reject(this.error || new DOMException('The transaction has finished.', 'TransactionInactiveError'));
                    return;
                }
                const failure = injectedFailure({ ...op, db: this.db.name, mode: this.mode });
                if (failure) {
                    reject(failure);
                    this.abort(failure);
                    return;
                }
                try {
                    resolve(work());
                } catch (err) {
                    reject(err);
                    this.abort(err);
                    return;
                }
                if (this.pending === 0) this.scheduleCommit();
            }));
        });
    }
    store(name) {
        if (!this.names.includes(name)) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError');
        const store = this.db.stores.get(name);
        if (!store) throw new DOMException(`No object store ${name}`, 'NotFoundError');
        return store;
    }
    write(store, serial, value) {
        const had = store.records.has(serial);
        const before = store.records.get(serial);
        this.undo.push(() => { if (had) store.records.set(serial, before); else store.records.delete(serial); });
        if (value === undefined) store.records.delete(serial);
        else store.records.set(serial, value);
        memoryIdb.writes.push({ db: this.db.name, store: store.name, key: JSON.parse(serial), deleted: value === undefined });
    }
}

function assignKey(store, value) {
    if (store.keyPath != null) {
        let key = valueAt(value, store.keyPath);
        if (key === undefined && store.autoIncrement) {
            key = store.nextKey++;
            value[store.keyPath] = key;
        } else if (typeof key === 'number' && store.autoIncrement && key >= store.nextKey) {
            store.nextKey = Math.floor(key) + 1;
        }
        if (key === undefined) throw new DOMException('The object has no valid key', 'DataError');
        return key;
    }
    throw new DOMException('Out-of-line keys are not modelled', 'DataError');
}

function checkUnique(store, value, serial) {
    for (const index of store.indexes.values()) {
        if (!index.unique) continue;
        const key = valueAt(value, index.keyPath);
        if (key === undefined) continue;
        for (const [otherSerial, other] of store.records) {
            if (otherSerial === serial) continue;
            const otherKey = valueAt(other, index.keyPath);
            if (otherKey !== undefined && compareKeys(otherKey, key) === 0) {
                throw new DOMException(`Unique index ${index.name} already holds this key`, 'ConstraintError');
            }
        }
    }
}

function wrapCursor(tx, store, entries, position, { keysOnly = false, primary = false, index = null } = {}) {
    if (position >= entries.length) return null;
    const entry = entries[position];
    const primaryKey = primary ? entry.key : entry.primaryKey;
    return {
        get value() { return keysOnly ? undefined : structuredClone(entry.value); },
        get key() { return entry.key; },
        get primaryKey() { return primaryKey; },
        delete() {
            return tx.run({ store: store.name, action: 'delete', key: primaryKey }, () => {
                tx.write(store, JSON.stringify(primaryKey), undefined);
            });
        },
        continue() {
            return tx.run({ store: store.name, action: 'cursor', ...(index ? { index } : {}) },
                () => wrapCursor(tx, store, entries, position + 1, { keysOnly, primary, index }));
        },
        advance(n) {
            return tx.run({ store: store.name, action: 'cursor', ...(index ? { index } : {}) },
                () => wrapCursor(tx, store, entries, position + Math.max(1, n), { keysOnly, primary, index }));
        }
    };
}

function directed(entries, direction) {
    const dir = String(direction || 'next');
    let list = dir.startsWith('prev') ? [...entries].reverse() : entries;
    if (dir.endsWith('unique')) {
        const seen = [];
        list = list.filter(entry => {
            if (seen.some(key => compareKeys(key, entry.key) === 0)) return false;
            seen.push(entry.key);
            return true;
        });
    }
    return list;
}

function wrapStore(tx, name) {
    const store = () => tx.store(name);
    const read = (action, work, index = null) => tx.run({ store: name, action, ...(index ? { index } : {}) }, work);
    const write = (action, key, work) => {
        if (tx.mode !== 'readwrite') {
            return Promise.reject(new DOMException('The transaction is read-only.', 'ReadOnlyError'));
        }
        return tx.run({ store: name, action, key }, work);
    };
    const put = (value, mustBeNew) => {
        const s = store();
        const copy = structuredClone(value);
        const key = assignKey(s, copy);
        const serial = JSON.stringify(key);
        return write(mustBeNew ? 'add' : 'put', key, () => {
            if (mustBeNew && s.records.has(serial)) throw new DOMException('Key already exists', 'ConstraintError');
            checkUnique(s, copy, serial);
            tx.write(s, serial, copy);
            return key;
        });
    };
    const validKey = key => {
        if (key === undefined || key === null || (keyType(key) === null && !(key instanceof MemoryKeyRange))) {
            throw new DOMException('The parameter is not a valid key.', 'DataError');
        }
        return key;
    };
    return {
        get: key => (validKey(key), read('get', () => {
            const found = sortedEntries(store()).find(entry => matchesQuery(entry.key, key));
            return found ? structuredClone(found.value) : undefined;
        })),
        getAll: query => read('getAll', () => sortedEntries(store())
            .filter(entry => matchesQuery(entry.key, query)).map(entry => structuredClone(entry.value))),
        getAllKeys: query => read('getAllKeys', () => sortedEntries(store())
            .filter(entry => matchesQuery(entry.key, query)).map(entry => entry.key)),
        count: query => read('count', () => sortedEntries(store()).filter(entry => matchesQuery(entry.key, query)).length),
        put: value => put(value, false),
        add: value => put(value, true),
        delete: key => (validKey(key), write('delete', key, () => {
            for (const entry of sortedEntries(store())) {
                if (matchesQuery(entry.key, key)) tx.write(store(), JSON.stringify(entry.key), undefined);
            }
        })),
        clear: () => write('clear', null, () => {
            for (const serial of [...store().records.keys()]) tx.write(store(), serial, undefined);
        }),
        openCursor: (query, direction) => read('cursor', () => {
            const entries = directed(sortedEntries(store()).filter(entry => matchesQuery(entry.key, query)), direction);
            return wrapCursor(tx, store(), entries, 0, { primary: true });
        }),
        index(indexName) {
            const index = store().indexes.get(indexName);
            if (!index) throw new DOMException(`No index ${indexName} on ${name}`, 'NotFoundError');
            const entries = query => indexEntries(store(), index).filter(entry => matchesQuery(entry.key, query));
            return {
                get: query => read('get', () => { const e = entries(query)[0]; return e ? structuredClone(e.value) : undefined; }, indexName),
                getAll: query => read('getAll', () => entries(query).map(entry => structuredClone(entry.value)), indexName),
                count: query => read('count', () => entries(query).length, indexName),
                openCursor: (query, direction) => read('cursor',
                    () => wrapCursor(tx, store(), directed(entries(query), direction), 0, { index: indexName }), indexName),
                openKeyCursor: (query, direction) => read('cursor',
                    () => wrapCursor(tx, store(), directed(entries(query), direction), 0, { keysOnly: true, index: indexName }), indexName)
            };
        }
    };
}

function upgradeHandle(db) {
    const storeHandle = store => ({
        name: store.name,
        get indexNames() { return nameList([...store.indexes.keys()]); },
        createIndex(name, keyPath, options = {}) {
            store.indexes.set(name, { name, keyPath, unique: !!options.unique, multiEntry: !!options.multiEntry });
            return { name, keyPath };
        },
        deleteIndex(name) { store.indexes.delete(name); }
    });
    return {
        db: {
            get objectStoreNames() { return nameList([...db.stores.keys()]); },
            createObjectStore(name, options) {
                const store = makeStore(name, options);
                db.stores.set(name, store);
                return storeHandle(store);
            },
            deleteObjectStore(name) { db.stores.delete(name); }
        },
        tx: {
            objectStore(name) {
                const store = db.stores.get(name);
                if (!store) throw new DOMException(`No object store ${name}`, 'NotFoundError');
                return storeHandle(store);
            },
            abort() {}
        }
    };
}

function wrapDb(db, connection) {
    const begin = (names, mode) => {
        if (connection.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
        return new Transaction(db, names, mode);
    };
    const one = (name, mode, work) => {
        const tx = begin([name], mode);
        const result = work(wrapStore(tx, name));
        return Promise.all([result, tx.done]).then(([value]) => value);
    };
    return {
        _idb: db,
        get objectStoreNames() { return nameList([...db.stores.keys()]); },
        transaction(storeName, mode = 'readonly') {
            const names = Array.isArray(storeName) ? storeName : [storeName];
            const tx = begin(names, mode);
            return { store: wrapStore(tx, names[0]), done: tx.done, tx };
        },
        transactionOver(storeNames, mode = 'readonly') {
            const tx = begin(storeNames, mode);
            const stores = {};
            for (const name of storeNames) stores[name] = wrapStore(tx, name);
            return { stores, done: tx.done, tx };
        },
        get: (storeName, key) => one(storeName, 'readonly', store => store.get(key)),
        getAll: (storeName, query) => one(storeName, 'readonly', store => store.getAll(query)),
        getAllKeys: (storeName, query) => one(storeName, 'readonly', store => store.getAllKeys(query)),
        getAllFromIndex: (storeName, indexName, query) =>
            one(storeName, 'readonly', store => store.index(indexName).getAll(query)),
        put: (storeName, value) => one(storeName, 'readwrite', store => store.put(value)),
        add: (storeName, value) => one(storeName, 'readwrite', store => store.add(value)),
        delete: (storeName, key) => one(storeName, 'readwrite', store => store.delete(key)),
        clear: storeName => one(storeName, 'readwrite', store => store.clear())
    };
}

export function openDB(name, version, { upgrade, canClose = () => true, onClosed = () => {}, onBlocked = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            let db = databases.get(name);
            if (!db) {
                db = { name, version: 0, stores: new Map(), active: [] };
                databases.set(name, db);
            }
            if (version < db.version) {
                reject(new DOMException(`The requested version (${version}) is less than the existing version (${db.version}).`, 'VersionError'));
                return;
            }
            if (version > db.version) {
                const old = db.version;
                const handle = upgradeHandle(db);
                try {
                    if (upgrade) upgrade(handle.db, old, version, handle.tx);
                } catch (err) {
                    reject(err);
                    return;
                }
                db.version = version;
            }
            const connection = {
                closed: false,
                close() { this.closed = true; connections.delete(this); },
                versionChange() {
                    if (this.closed) return;
                    let mayClose = true;
                    try { mayClose = canClose() !== false; } catch (_) { mayClose = true; }
                    const release = () => {
                        this.close();
                        try { onClosed(); } catch (_) {}
                    };
                    if (!mayClose) {
                        try { onBlocked({ holding: true, release }); } catch (_) {}
                        return;
                    }
                    release();
                }
            };
            connections.add(connection);
            resolve(wrapDb(db, connection));
        }, 0);
    });
}
