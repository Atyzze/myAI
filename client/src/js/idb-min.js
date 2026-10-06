function pReq(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

function pTx(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
}

function wrapCursorRequest(req) {
    return pReq(req).then(function step(cursor) {
        if (!cursor) return null;
        return {
            get value() { return cursor.value; },
            get key()   { return cursor.key; },
            get primaryKey() { return cursor.primaryKey; },
            delete()    { return pReq(cursor.delete()); },
            continue()  { cursor.continue(); return pReq(req).then(step); },
            advance(n)  { cursor.advance(n); return pReq(req).then(step); }
        };
    });
}

function wrapStore(store) {
    return {
        get:        (key)   => pReq(store.get(key)),
        getAll:     (query) => pReq(store.getAll(query)),
        getAllKeys: (query) => pReq(store.getAllKeys(query)),
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
            const done = pTx(tx);
            return { store: wrapStore(tx.objectStore(storeName)), done, tx };
        },

        transactionOver(storeNames, mode = 'readonly') {
            const tx     = idb.transaction(storeNames, mode);
            const done   = pTx(tx);
            const stores = {};
            for (const name of storeNames) stores[name] = wrapStore(tx.objectStore(name));
            return { stores, done, tx };
        },

        get(storeName, key) {
            return pReq(idb.transaction(storeName, 'readonly').objectStore(storeName).get(key));
        },
        getAll(storeName, query) {
            return pReq(idb.transaction(storeName, 'readonly').objectStore(storeName).getAll(query));
        },
        getAllKeys(storeName, query) {
            return pReq(idb.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys(query));
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

export function openDB(name, version, {
    upgrade, canClose = () => true, onClosed = () => {}, onBlocked = () => {}
} = {}) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = (event) => {
            try { if (upgrade) upgrade(req.result, event.oldVersion, event.newVersion, req.transaction); }
            catch (err) {
                try { req.transaction.abort(); } catch (_) {}
                reject(err);
            }
        };
        req.onsuccess = () => {
            const idb = req.result;
            idb.onversionchange = () => {
                let mayClose = true;
                try { mayClose = canClose() !== false; } catch (_) { mayClose = true; }
                const release = () => {
                    try { idb.close(); } catch (_) {}
                    try { onClosed(); } catch (_) {}
                };
                if (!mayClose) {
                    try { onBlocked({ holding: true, release }); } catch (_) {}
                    return;
                }
                release();
            };
            resolve(wrapDb(idb));
        };
        req.onerror   = () => reject(req.error);
        req.onblocked = () => {
            console.warn(`IndexedDB "${name}" upgrade is blocked by another open tab.`);
            try { onBlocked({ holding: false }); } catch (_) {}
        };
    });
}
