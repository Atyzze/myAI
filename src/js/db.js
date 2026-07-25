/* ==========================================================================
   db.js - IndexedDB wrapper: open, exec, transactional update, storage calc,
           maintenance helpers (orphan sweep + legacy-id migration)
   ========================================================================== */
import { openDB } from './idb-min.js';   // hand-written wrapper (no external lib)
import { CONFIG, uid, fmtAudioMegabytes, fmtStorageGigabytes, fmtStorageFullPercent } from './config.js';

// ── Open / upgrade ──
// v8 moves NEW fragment writes to an auto-increment store. The legacy
// [recId, seq] store is retained read-only so interrupted recordings created by
// older releases can still finish normally. Runtime readers aggregate both
// stores where needed.
export const dbPromise = openDB(CONFIG.DB_NAME, 8, {
    upgrade(db, _oldVersion, _newVersion) {
        if (!db.objectStoreNames.contains(CONFIG.STORE_REC)) {
            db.createObjectStore(CONFIG.STORE_REC, { keyPath: 'id', autoIncrement: true })
              .createIndex('by-date', 'timestamp');
        }
        if (!db.objectStoreNames.contains(CONFIG.STORE_WAV)) {
            const fragments = db.createObjectStore(CONFIG.STORE_WAV, {
                keyPath: 'fragmentId', autoIncrement: true
            });
            fragments.createIndex('by-rec', 'recId', { unique: false });
            fragments.createIndex('by-session', 'sessionId', { unique: false });
            fragments.createIndex('by-stream', ['recId', 'sessionId'], { unique: false });
            // A retry may fail loudly, but it can no longer overwrite bytes from
            // another capture stream sharing a legacy recording id.
            fragments.createIndex('by-stream-seq', ['recId', 'sessionId', 'seq'], { unique: true });
        }
    }
});

function audioStoreNames(db) {
    return [CONFIG.STORE_WAV, CONFIG.LEGACY_STORE_WAV]
        .filter((name, index, names) => name && names.indexOf(name) === index && db.objectStoreNames.contains(name));
}

export async function getAudioFragmentsForRecording(recId) {
    const db = await dbPromise;
    const rows = [];
    for (const store of audioStoreNames(db)) {
        const values = await db.getAllFromIndex(store, 'by-rec', recId);
        rows.push(...values.map(value => ({ ...value, _fragmentStore: store })));
    }
    return rows;
}

export async function deleteAudioFragments(recId, sessionId = null, { allSessions = false } = {}) {
    const db = await dbPromise;
    for (const store of audioStoreNames(db)) {
        const tx = db.transaction(store, 'readwrite');
        let cursor = await tx.store.index('by-rec').openCursor(recId);
        while (cursor) {
            const row = cursor.value;
            const matches = allSessions || (sessionId ? row.sessionId === sessionId : !row.sessionId);
            if (matches) await cursor.delete();
            cursor = await cursor.continue();
        }
        await tx.done;
    }
}

export async function clearAllAudioFragments() {
    const db = await dbPromise;
    for (const store of audioStoreNames(db)) await db.clear(store);
}

// ── Generic store executor ──
export async function dbExec(store, action, data) {
    const db = await dbPromise;
    if (action === 'getAllFromIndex') {
        return db.getAllFromIndex(store, data.index, data.val);
    }
    if (action === 'deleteRange') {
        const tx = db.transaction(store, 'readwrite');
        let cursor = await tx.store.index('by-rec').openCursor(data);
        while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
        return tx.done;
    }
    if (action === 'deleteRangeForSession') {
        const tx = db.transaction(store, 'readwrite');
        let cursor = await tx.store.index('by-rec').openCursor(data.recId);
        while (cursor) {
            const row = cursor.value;
            const matches = data.sessionId
                ? row.sessionId === data.sessionId
                : !row.sessionId;
            if (matches) await cursor.delete();
            cursor = await cursor.continue();
        }
        return tx.done;
    }
    return db[action](store, data);
}

/**
 * Atomic read-modify-write on a single record: get → mutate → put inside ONE
 * readwrite transaction, so two callers (e.g. a transcribe and a reply running
 * close together, or two tabs) can't clobber each other's writes via a stale
 * read. `mutate(rec)` may mutate-in-place and return it, return a new object, or
 * return undefined/null to skip the put. Returns the stored object (or null).
 *
 * IMPORTANT - `mutate` MUST be synchronous. An IndexedDB transaction auto-commits
 * as soon as control returns to the event loop with no pending request, so if
 * `mutate` were to `await` anything that doesn't settle in the same microtask
 * (a fetch, a timer, a cross-task promise), the transaction would commit before
 * the put below and the put would throw `TransactionInactiveError`. We therefore
 * call it synchronously (no `await`) and require callers to keep it sync.
 */
export async function dbUpdate(store, key, mutate) {
    const db = await dbPromise;
    const tx = db.transaction(store, 'readwrite');
    const cur = await tx.store.get(key);
    const next = mutate(cur);                 // synchronous by contract (see above)
    // Enforce the contract instead of only documenting it. An async mutate would
    // otherwise let the transaction auto-commit first and surface as a confusing
    // TransactionInactiveError from the put below, far from the actual mistake.
    if (next && typeof next.then === 'function') {
        throw new TypeError(
            'dbUpdate(mutate) must be synchronous: an IndexedDB transaction auto-commits ' +
            'as soon as control returns to the event loop, so an awaited mutate would ' +
            'commit before its own write.'
        );
    }
    if (next != null) await tx.store.put(next);
    await tx.done;
    return next ?? null;
}

/**
 * Fetch ONE page of recordings, newest-first, without loading the whole store.
 * Walks the `by-date` index backwards (newest timestamp first), skips the rows
 * before the page in a single cursor.advance(), then collects up to pageSize
 * rows. `total` comes from a cheap index count(). The page index is clamped to
 * the valid range here (deletions may have shrunk the list since it was set), so
 * the returned page always matches the returned pageIndex.
 *
 * This replaces getAllFromIndex()+reverse()+slice, which deserialized EVERY
 * record (all transcript/summary text + blob handles) on every paint just to
 * show PAGE_SIZE of them.
 */
export async function getRecordingsPage(pageIndex, pageSize) {
    const db = await dbPromise;
    const tx = db.transaction(CONFIG.STORE_REC);
    const ix = tx.store.index('by-date');

    const total      = await ix.count();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clamped    = Math.min(Math.max(0, pageIndex | 0), totalPages - 1);

    const page = [];
    const skip = clamped * pageSize;
    let cursor = await ix.openCursor(null, 'prev');   // newest first
    if (cursor && skip > 0) cursor = await cursor.advance(skip);
    while (cursor && page.length < pageSize) {
        page.push(cursor.value);
        cursor = await cursor.continue();
    }
    await tx.done;
    return { page, total, totalPages, pageIndex: clamped };
}

// ── Storage size display ──
// _storageTotal reflects AUDIO bytes only - the finalized master blob plus any
// in-flight WAV chunks. Transcript/summary/context text is intentionally not
// counted. The browser-provided origin quota is cached separately so each
// four-second fragment commit can update MB, remaining GB and fullness in O(1)
// without calling navigator.storage.estimate() on the hot path.
let _storageTotal = 0;
let _storageQuota = null;
let _storageQuotaChecked = false;

function paintStorage() {
    const el = document.getElementById('storage-info');
    if (!el) return;

    const audio = fmtAudioMegabytes(_storageTotal);
    const full = fmtStorageFullPercent(_storageTotal, _storageQuota);
    if (full === null) {
        const status = _storageQuotaChecked ? 'unavailable' : 'calculating…';
        el.textContent = `Audio: ${audio} • Available: ${status} • ${status}`;
    } else {
        const availableBytes = Math.max(0, _storageQuota - _storageTotal);
        el.textContent = `Audio: ${audio} • Available: ${fmtStorageGigabytes(availableBytes)} • ${full}`;
    }
    el.title = 'Audio is saved recording data. Available is the browser-estimated quota minus saved audio. The percentage is saved audio divided by that quota.';
}

async function refreshStorageQuota() {
    if (!navigator.storage?.estimate) {
        _storageQuota = null;
        _storageQuotaChecked = true;
        paintStorage();
        return;
    }
    try {
        const estimate = await navigator.storage.estimate();
        const quota = Number(estimate?.quota);
        _storageQuota = Number.isFinite(quota) && quota > 0 ? quota : null;
    } catch (_) {
        _storageQuota = null;
    }
    _storageQuotaChecked = true;
    paintStorage();
}

/** Apply a known byte delta and repaint (cheap; used after each WAV chunk add). */
export function bumpStorage(deltaBytes) {
    _storageTotal = Math.max(0, _storageTotal + (deltaBytes || 0));
    paintStorage();
}

/** Current audio-bytes total (O(1)). Used by the per-recording storage bars so
    each bar can be sized as a fraction of everything stored. */
export function getStorageTotal() { return _storageTotal; }

export async function requestPersistentStorage() {
    if (!navigator.storage) return false;
    let persistent = false;
    try {
        if (navigator.storage.persisted) {
            persistent = (await navigator.storage.persisted()) === true;
        }
        if (!persistent && navigator.storage.persist) {
            persistent = (await navigator.storage.persist()) === true;
        }
    } catch (_) {
        persistent = false;
    }
    refreshStorageQuota().catch(() => {});
    return persistent;
}

/** Authoritative full recount (used on load and after deletes/finalize). */
export async function calcTotalStorage() {
    const db = await dbPromise;
    let total = 0;
    let c1 = await db.transaction(CONFIG.STORE_REC).store.openCursor();
    while (c1) { total += c1.value.blob?.size || 0; c1 = await c1.continue(); }
    for (const store of audioStoreNames(db)) {
        let c2 = await db.transaction(store).store.openCursor();
        while (c2) { total += c2.value.blob?.size || 0; c2 = await c2.continue(); }
    }
    _storageTotal = total;
    paintStorage();
    await refreshStorageQuota();
}
// Expose globally for delegated action handlers
window.calcTotalStorage = calcTotalStorage;

/**
 * Sweep audio fragments left behind if the tab died between finalize's master-blob
 * put and its chunk delete (the two are separate steps to keep audio safe: a
 * crash there wastes storage but never loses data). Any recording that already
 * has a finalized blob should own zero chunks, so we drop strays on startup.
 */
export async function cleanupOrphanWavChunks() {
    const db = await dbPromise;
    let swept = false;

    for (const store of audioStoreNames(db)) {
        const tx = db.transaction(store);
        const recIds = [];
        let cur = await tx.store.index('by-rec').openKeyCursor(null, 'nextunique');
        while (cur) { recIds.push(cur.key); cur = await cur.continue(); }
        await tx.done;

        for (const id of recIds) {
            const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
            // Rows without an owning recording cannot be played or finalized and
            // are safe to delete. A finalized row may discard only the fragments
            // from its own capture session, never another isolated session.
            if (!rec || (rec.blob && !rec.processing)) {
                const txDelete = db.transaction(store, 'readwrite');
                let fragment = await txDelete.store.index('by-rec').openCursor(id);
                while (fragment) {
                    const row = fragment.value;
                    const matches = !rec || (rec.sessionId ? row.sessionId === rec.sessionId : !row.sessionId);
                    if (matches) await fragment.delete();
                    fragment = await fragment.continue();
                }
                await txDelete.done;
                swept = true;
            }
        }
    }
    if (swept) await calcTotalStorage();
}

/**
 * One-time migration: give stable ids to legacy transcripts/summaries that have
 * none, and PERSIST them. The render path also backfills, but did so without
 * writing back, so id-less legacy items got a fresh (different) id on every
 * paint - their dropdown values churned and they couldn't be deleted. Running
 * this once on load makes those ids permanent.
 *
 * Gated behind a localStorage flag: once we've scanned the store, ids are
 * persisted in the records and every newly-created sub-item gets a uid() at
 * creation, so there's nothing left to migrate. Without the gate this walked the
 * ENTIRE store (every blob handle + all text) on every single launch, forever.
 * The flag is set only after a successful full pass, so a mid-scan failure
 * retries next boot.
 */
const MIGRATION_FLAG = 'legacy-ids-migrated-v1';

export async function migrateLegacyIds() {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
    const recs = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    for (const rec of recs) {
        let changed = false;
        const allT = rec.transcripts || [];
        allT.forEach(t => { if (!t.id) { t.id = t.time || uid(); changed = true; } });
        const allS = rec.summaries || [];
        allS.forEach(s => {
            if (!s.id) { s.id = s.time || uid(); changed = true; }
            if (!s.transcriptId && allT.length) { s.transcriptId = allT[0].id; changed = true; }
        });
        if (changed) await dbExec(CONFIG.STORE_REC, 'put', rec);
    }
    localStorage.setItem(MIGRATION_FLAG, '1');
}
