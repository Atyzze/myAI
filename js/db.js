/* ==========================================================================
   db.js — IndexedDB wrapper: open, exec, transactional update, storage calc,
           recovery helpers (orphan sweep + legacy-id migration)
   ========================================================================== */
import { openDB } from './idb-min.js';   // hand-written wrapper (no external lib)
import { CONFIG, fmtBytes, uid } from './config.js';

// ── Open / upgrade ──
export const dbPromise = openDB(CONFIG.DB_NAME, 6, {
    upgrade(db) {
        if (!db.objectStoreNames.contains(CONFIG.STORE_REC)) {
            db.createObjectStore(CONFIG.STORE_REC, { keyPath: 'id', autoIncrement: true })
              .createIndex('by-date', 'timestamp');
        }
        if (!db.objectStoreNames.contains(CONFIG.STORE_WAV)) {
            db.createObjectStore(CONFIG.STORE_WAV, { keyPath: ['recId', 'seq'] })
              .createIndex('by-rec', 'recId');
        }
    }
});

// ── Generic store executor ──
export async function dbExec(store, action, data) {
    const db = await dbPromise;
    if (action === 'getAllFromIndex') {
        return db.getAllFromIndex(store, data.index, data.val);
    }
    if (action === 'deleteRange') {
        const tx = db.transaction(store, 'readwrite');
        let cursor = await tx.store.index('by-rec').openCursor(data);
        while (cursor) { cursor.delete(); cursor = await cursor.continue(); }
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
 * IMPORTANT — `mutate` MUST be synchronous. An IndexedDB transaction auto-commits
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
// This total reflects AUDIO bytes only — the finalized master blob plus any
// in-flight WAV chunks. Transcript/summary/context TEXT lives inside the
// recording object and is intentionally not counted here (it's tiny next to
// audio, and counting it would mean a full DB rescan after every transcribe/
// reply). The UI labels this "Audio stored" so the number isn't misread as
// total app storage. _storageTotal is kept in sync so the per-flush hot path
// can do an O(1) bump instead of cursoring both object stores every 4 seconds.
let _storageTotal = 0;

function paintStorage() {
    const el = document.getElementById('storage-info');
    if (el) el.textContent = `Audio stored: ${fmtBytes(_storageTotal)}`;
}

/** Apply a known byte delta and repaint (cheap; used after each WAV chunk add). */
export function bumpStorage(deltaBytes) {
    _storageTotal = Math.max(0, _storageTotal + (deltaBytes || 0));
    paintStorage();
}

/** Authoritative full recount (used on load and after deletes/finalize). */
export async function calcTotalStorage() {
    const db = await dbPromise;
    let total = 0;
    let c1 = await db.transaction(CONFIG.STORE_REC).store.openCursor();
    while (c1) { total += c1.value.blob?.size || 0; c1 = await c1.continue(); }
    let c2 = await db.transaction(CONFIG.STORE_WAV).store.openCursor();
    while (c2) { total += c2.value.blob?.size || 0; c2 = await c2.continue(); }
    _storageTotal = total;
    paintStorage();
}
// Expose globally for inline onclick handlers
window.calcTotalStorage = calcTotalStorage;

/**
 * Sweep WAV chunks left behind if the tab died between finalize's master-blob
 * put and its chunk delete (the two are separate steps to keep audio safe: a
 * crash there wastes storage but never loses data). Any recording that already
 * has a finalized blob should own zero chunks, so we drop strays on startup.
 */
export async function cleanupOrphanWavChunks() {
    const recs = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    const finalized = recs.filter(r => r.blob && !r.processing).map(r => r.id);
    if (finalized.length === 0) return;
    for (const id of finalized) {
        await dbExec(CONFIG.STORE_WAV, 'deleteRange', id);   // no-op if none
    }
    await calcTotalStorage();
}

/**
 * One-time migration: give stable ids to legacy transcripts/summaries that have
 * none, and PERSIST them. The render path also backfills, but did so without
 * writing back, so id-less legacy items got a fresh (different) id on every
 * paint — their dropdown values churned and they couldn't be deleted. Running
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
