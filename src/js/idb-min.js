/* ==========================================================================
   idb-min.js - Tiny hand-written promise wrapper around the native IndexedDB
   API. NOT a third-party library: written for this app to remove the vendored
   `idb` dependency (and its supply-chain surface) entirely.

   It implements only the surface this codebase uses:
     openDB(name, version, { upgrade })          -> Promise<DB>
     db.get / put / add / delete / clear (store, …)
     db.getAllFromIndex(store, index, query)
     db.transaction(store, mode) -> { store, done }
       store.get / put / add (…)
       store.index(name).openCursor(query) / getAll(query)
       store.openCursor(query)
       cursor.value / .key / .delete() / .continue()

   Writes resolve only after the transaction COMMITS (await tx.done), so a
   resolved write is durable - matching the guarantees the rest of the app
   assumes from the previous idb wrapper.
   ========================================================================== */

// Promisify a single IDBRequest.
function pReq(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

// Promisify transaction completion. Handlers are attached eagerly (at wrap
// time) so the promise can never miss an already-fired 'complete' event.
function pTx(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
}

// Wrap a cursor request so .continue()/.advance() yield a promise for the next
// cursor, and .delete() returns a promise. Re-arming onsuccess on the same
// request is how native IDB cursor iteration works.
function wrapCursorRequest(req) {
    return pReq(req).then(function step(cursor) {
        if (!cursor) return null;
        return {
            get value() { return cursor.value; },
            get key()   { return cursor.key; },
            get primaryKey() { return cursor.primaryKey; },
            delete()    { return pReq(cursor.delete()); },
            continue()  { cursor.continue(); return pReq(req).then(step); },
            // Skip n records in one hop (n must be >= 1 per the IDB spec) - lets
            // the paginator jump to a page offset without visiting every row.
            advance(n)  { cursor.advance(n); return pReq(req).then(step); }
        };
    });
}

function wrapStore(store) {
    return {
        get:        (key)   => pReq(store.get(key)),
        getAll:     (query) => pReq(store.getAll(query)),
        count:      (query) => pReq(store.count(query)),
        put:        (value) => pReq(store.put(value)),
        add:        (value) => pReq(store.add(value)),
        delete:     (key)   => pReq(store.delete(key)),
        clear:      ()      => pReq(store.clear()),
        openCursor: (query, direction) => wrapCursorRequest(store.openCursor(query, direction)),
        index(name) {
            const ix = store.index(name);
            return {
                get:        (query) => pReq(ix.get(query)),
                getAll:     (query) => pReq(ix.getAll(query)),
                count:      (query) => pReq(ix.count(query)),
                openCursor: (query, direction) => wrapCursorRequest(ix.openCursor(query, direction)),
                // Key-only cursor: yields .key/.primaryKey without deserializing the
                // record VALUE (used to enumerate distinct index keys cheaply). The
                // returned wrapper's .value is undefined here and .delete() is not
                // valid on a key cursor, so callers use only .key/.primaryKey.
                openKeyCursor: (query, direction) => wrapCursorRequest(ix.openKeyCursor(query, direction))
            };
        }
    };
}

function wrapDb(idb) {
    const wrapper = {
        _idb: idb,
        objectStoreNames: idb.objectStoreNames,

        transaction(storeName, mode = 'readonly') {
            const tx   = idb.transaction(storeName, mode);
            const done = pTx(tx);                 // attach handlers now (eager)
            return { store: wrapStore(tx.objectStore(storeName)), done, tx };
        },

        // ── Convenience single-op helpers (each in its own transaction) ──
        get(storeName, key) {
            return pReq(idb.transaction(storeName, 'readonly').objectStore(storeName).get(key));
        },
        getAll(storeName, query) {
            return pReq(idb.transaction(storeName, 'readonly').objectStore(storeName).getAll(query));
        },
        getAllFromIndex(storeName, indexName, query) {
            return pReq(idb.transaction(storeName, 'readonly')
                .objectStore(storeName).index(indexName).getAll(query));
        },
        async put(storeName, value) {
            const tx  = idb.transaction(storeName, 'readwrite');
            const res = await pReq(tx.objectStore(storeName).put(value));
            await pTx(tx);
            return res;
        },
        async add(storeName, value) {
            const tx  = idb.transaction(storeName, 'readwrite');
            const key = await pReq(tx.objectStore(storeName).add(value));
            await pTx(tx);
            return key;
        },
        async delete(storeName, key) {
            const tx = idb.transaction(storeName, 'readwrite');
            await pReq(tx.objectStore(storeName).delete(key));
            await pTx(tx);
        },
        async clear(storeName) {
            const tx = idb.transaction(storeName, 'readwrite');
            await pReq(tx.objectStore(storeName).clear());
            await pTx(tx);
        }
    };
    return wrapper;
}

/**
 * Open (and upgrade) a database. `upgrade(db, oldVersion, newVersion)` runs
 * against the NATIVE IDBDatabase inside the versionchange transaction, so it
 * can call db.createObjectStore(...).createIndex(...) directly.
 */
export function openDB(name, version, { upgrade } = {}) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = (event) => {
            try { if (upgrade) upgrade(req.result, event.oldVersion, event.newVersion, req.transaction); }
            catch (err) { reject(err); }
        };
        req.onsuccess = () => {
            const idb = req.result;
            // If ANOTHER tab later opens this DB at a higher version, it can't
            // upgrade while we hold the connection open - which would hang that
            // tab's open (and thus its whole UI) indefinitely. Close ours so the
            // upgrade can proceed. (Our own further DB calls will then fail loudly
            // rather than deadlocking a second tab silently.)
            idb.onversionchange = () => { try { idb.close(); } catch (_) {} };
            resolve(wrapDb(idb));
        };
        req.onerror   = () => reject(req.error);
        // Another tab still holds an OLDER version open, blocking our upgrade.
        // The open proceeds once it closes (that tab's onversionchange closes it);
        // surface a warning so a genuinely stuck state is diagnosable.
        req.onblocked = () => {
            console.warn(`IndexedDB "${name}" upgrade is blocked by another open tab. ` +
                         `Close other tabs of this app if it does not continue.`);
        };
    });
}
