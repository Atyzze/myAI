import { openDB } from './idb-min.js';
import { shouldCloseForUpgrade, isStaleVersionError, schemaLayout, applySchema } from './db-lifecycle-core.js';
import { CONFIG, uid, fmtAudioMegabytes, fmtStorageGigabytes, fmtStorageFullPercent,
         readStored, writeStored } from './config.js';

let _busy = () => false;
let _recording = () => false;
let _notify = () => {};
let _notifiedContext = '';
let _dbPromise = null;
let _guard = 'open';

export function setDatabaseBusyCheck(fn, recordingFn = null) {
    _busy = typeof fn === 'function' ? fn : (() => false);
    _recording = typeof recordingFn === 'function' ? recordingFn : _busy;
}

function guardContext() {
    return { recording: _recording() === true, busy: _busy() === true };
}

export function setDatabaseGuardListener(fn) {
    _notify = typeof fn === 'function' ? fn : (() => {});
}

export function databaseGuardState() { return _guard; }

function setGuard(next) {
    if (_guard === next) return;
    _guard = next;
    const context = guardContext();
    _notifiedContext = `${context.recording}:${context.busy}`;
    try { _notify(next, context); } catch (_) {}
}

function refreshGuard() {
    const context = guardContext();
    const key = `${context.recording}:${context.busy}`;
    if (key === _notifiedContext) return;
    _notifiedContext = key;
    try { _notify(_guard, context); } catch (_) {}
}

let _releaseWhenIdle = null;

function openDatabase() {
    return openDB(CONFIG.DB_NAME, CONFIG.DB_VERSION, {
        canClose: () => shouldCloseForUpgrade({ recording: _busy() === true }),
        onClosed: () => { _dbPromise = null; setGuard('closed'); },
        onBlocked: (info) => {
            if (info && info.holding && typeof info.release === 'function') _releaseWhenIdle = info.release;
            setGuard('blocked');
        },
        upgrade(db, _oldVersion, _newVersion, upgradeTx) {
            applySchema(db, upgradeTx, schemaLayout(CONFIG));
        }
    });
}

export function noteDatabaseIdle() {
    if (!_releaseWhenIdle) return false;
    if (_busy() === true) { refreshGuard(); return false; }
    const release = _releaseWhenIdle;
    _releaseWhenIdle = null;
    release();
    return true;
}

function database() {
    if (!_dbPromise) {
        _dbPromise = openDatabase().then(db => { setGuard('open'); return db; }, err => {
            _dbPromise = null;
            if (isStaleVersionError(err)) setGuard('stale');
            throw err;
        });
    }
    return _dbPromise;
}


export async function getAudioFragmentsForRecording(recId) {
    const db = await database();
    const values = await db.getAllFromIndex(CONFIG.STORE_FRAGMENTS, 'by-rec', recId);
    return values.map(value => ({ ...value, _fragmentStore: CONFIG.STORE_FRAGMENTS }));
}

export async function audioFragmentSummary(recId) {
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_FRAGMENTS);
    let pieces = 0;
    let bytes = 0;
    let cursor = await tx.store.index('by-rec').openCursor(recId);
    while (cursor) {
        const row = cursor.value;
        pieces++;
        bytes += Number(row && (row.bytes ?? (row.blob && row.blob.size))) || 0;
        cursor = await cursor.continue();
    }
    await tx.done;
    return { pieces, bytes };
}

export async function deleteAudioFragments(recId, sessionId = null, { allSessions = false } = {}) {
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_FRAGMENTS, 'readwrite');
    let cursor = await tx.store.index('by-rec').openCursor(recId);
    while (cursor) {
        const row = cursor.value;
        const matches = allSessions || (sessionId ? row.sessionId === sessionId : !row.sessionId);
        if (matches) await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
}

export async function clearAllAudioFragments() {
    const db = await database();
    await db.clear(CONFIG.STORE_FRAGMENTS);
}

export async function dbExec(store, action, data) {
    const db = await database();
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

export async function readLiveTranscript(recId) {
    if (recId == null) return null;
    const db = await database();
    const row = await db.get(CONFIG.STORE_LIVE, recId);
    return (row && row.live) || null;
}

export async function readAudio(recId) {
    if (recId == null) return null;
    const db = await database();
    const row = await db.get(CONFIG.STORE_AUDIO, recId);
    return (row && row.blob) || null;
}

export async function writeAudio(recId, blob) {
    if (recId == null) return false;
    if (!blob) return deleteAudio(recId);
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_AUDIO, 'readwrite');
    await tx.store.put({ recId, blob, bytes: blob.size, at: Date.now() });
    await tx.done;
    return true;
}

export async function commitAudio(recId, blob, mutate) {
    if (recId == null || !blob) return null;
    const db = await database();
    const tx = db.transactionOver([CONFIG.STORE_REC, CONFIG.STORE_AUDIO], 'readwrite');
    const current = await tx.stores[CONFIG.STORE_REC].get(recId);
    const next = mutate(current);
    if (next && typeof next.then === 'function') {
        throw new TypeError('commitAudio(mutate) must be synchronous, like dbUpdate.');
    }
    if (next != null) {
        await tx.stores[CONFIG.STORE_REC].put(next);
        await tx.stores[CONFIG.STORE_AUDIO].put({ recId, blob, bytes: blob.size, at: Date.now() });
    }
    await tx.done;
    return next ?? null;
}

export async function cleanupOrphanAudio() {
    const db = await database();
    const keys = await db.transaction(CONFIG.STORE_AUDIO).store.getAllKeys();
    let removed = 0;
    for (const recId of keys) {
        const tx = db.transactionOver([CONFIG.STORE_REC, CONFIG.STORE_AUDIO], 'readwrite');
        const rec = await tx.stores[CONFIG.STORE_REC].get(recId);
        const owned = !!rec && (Number(rec.audioBytes) > 0 || !!rec.processing);
        if (!owned) {
            await tx.stores[CONFIG.STORE_AUDIO].delete(recId);
            removed++;
        }
        await tx.done;
    }
    if (removed) await calcTotalStorage();
    return removed;
}

export async function deleteAudio(recId) {
    if (recId == null) return false;
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_AUDIO, 'readwrite');
    await tx.store.delete(recId);
    await tx.done;
    return true;
}

export async function audioBytesTotal() {
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_AUDIO);
    let total = 0;
    let cursor = await tx.store.openCursor();
    while (cursor) {
        total += Number(cursor.value && cursor.value.bytes) || 0;
        cursor = await cursor.continue();
    }
    await tx.done;
    return total;
}


export async function writeLiveTranscript(recId, live) {
    if (recId == null) return false;
    const db = await database();
    if (!live) return deleteLiveTranscript(recId);
    const tx = db.transaction(CONFIG.STORE_LIVE, 'readwrite');
    await tx.store.put({ recId, live, at: Date.now() });
    await tx.done;
    return true;
}

// One transaction from the read to the write, so a live transcript deleted in between (its last
// transcript deleted by hand, say) stays deleted instead of being written back as a hidden copy.
export async function updateLiveTranscript(recId, mutate) {
    if (recId == null) return false;
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_LIVE, 'readwrite');
    const row = await tx.store.get(recId);
    const next = mutate((row && row.live) || null);
    if (next && typeof next.then === 'function') {
        throw new TypeError('updateLiveTranscript(mutate) must be synchronous, like dbUpdate.');
    }
    if (next) await tx.store.put({ recId, live: next, at: Date.now() });
    await tx.done;
    return !!next;
}

export async function deleteLiveTranscript(recId) {
    if (recId == null) return false;
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_LIVE, 'readwrite');
    await tx.store.delete(recId);
    await tx.done;
    return true;
}

export async function writeCaptureBeat(beat) {
    if (!beat || beat.recId == null) return false;
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_BEATS, 'readwrite');
    await tx.store.put(beat);
    await tx.done;
    return true;
}

export async function readCaptureBeats() {
    try {
        const db = await database();
        const rows = await db.getAll(CONFIG.STORE_BEATS);
        return new Map((rows || []).filter(row => row && row.recId != null).map(row => [Number(row.recId), row]));
    } catch (_) {
        return new Map();
    }
}

export async function deleteCaptureBeat(recId) {
    if (recId == null) return false;
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_BEATS, 'readwrite');
    await tx.store.delete(recId);
    await tx.done;
    return true;
}

export async function cleanupOrphanCaptureBeats() {
    const db = await database();
    const beats = await db.getAll(CONFIG.STORE_BEATS);
    let removed = 0;
    for (const beat of beats || []) {
        if (!beat || beat.recId == null) continue;
        const rec = await db.get(CONFIG.STORE_REC, beat.recId);
        if (rec && rec.processing && rec.ownerId && rec.ownerId === beat.ownerId) continue;
        await deleteCaptureBeat(beat.recId);
        removed++;
    }
    return removed;
}

export async function cleanupOrphanLiveTranscripts() {
    const db = await database();
    const liveTranscriptRecIds = await db.getAllKeys(CONFIG.STORE_LIVE);
    if (!liveTranscriptRecIds.length) return 0;
    const recordingIds = new Set((await db.getAllKeys(CONFIG.STORE_REC)).map(key => String(key)));
    let removed = 0;
    for (const recId of liveTranscriptRecIds) {
        if (recId == null || recordingIds.has(String(recId))) continue;
        await deleteLiveTranscript(recId);
        removed++;
    }
    return removed;
}

export async function dbUpdate(store, key, mutate) {
    const db = await database();
    const tx = db.transaction(store, 'readwrite');
    const cur = await tx.store.get(key);
    const next = mutate(cur);
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

export async function getRecordingsPage(pageIndex, pageSize) {
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_REC);
    const ix = tx.store.index('by-date');

    const total      = await ix.count();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clamped    = Math.min(Math.max(0, pageIndex | 0), totalPages - 1);

    const page = [];
    const skip = clamped * pageSize;
    let cursor = await ix.openCursor(null, 'prev');
    if (cursor && skip > 0) cursor = await cursor.advance(skip);
    while (cursor && page.length < pageSize) {
        page.push(cursor.value);
        cursor = await cursor.continue();
    }
    await tx.done;
    return { page, total, totalPages, pageIndex: clamped };
}

export const UNFINISHED_CAPTURE_STATES = Object.freeze(['starting', 'recording', 'finalizing', 'finalize-error']);

export async function getUnfinishedRecordings() {
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_REC);
    const byState = tx.store.index('by-state');
    const rows = [];
    for (const state of UNFINISHED_CAPTURE_STATES) rows.push(...await byState.getAll(state));
    await tx.done;
    return rows.filter(rec => rec && rec.processing);
}

export async function recordingPosition(recId) {
    const db = await database();
    const rec = await db.get(CONFIG.STORE_REC, recId);
    if (!rec) return -1;
    const tx = db.transaction(CONFIG.STORE_REC);
    const newer = await tx.store.index('by-date').count(IDBKeyRange.lowerBound(Number(rec.timestamp) || 0, true));
    await tx.done;
    return newer;
}

export async function getRecordingsOlderThan(cutoff) {
    const bound = Number(cutoff);
    if (!Number.isFinite(bound)) return [];
    const db = await database();
    const tx = db.transaction(CONFIG.STORE_REC);
    const rows = [];
    let cursor = await tx.store.index('by-date').openCursor(IDBKeyRange.upperBound(bound));
    while (cursor) {
        rows.push(cursor.value);
        cursor = await cursor.continue();
    }
    await tx.done;
    return rows;
}

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
        el.textContent = `Audio: ${audio} • Available: ${status}`;
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

export function bumpStorage(deltaBytes) {
    _storageTotal = Math.max(0, _storageTotal + (deltaBytes || 0));
    paintStorage();
}

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

export async function calcTotalStorage() {
    const db = await database();
    let total = await audioBytesTotal();
    let c2 = await db.transaction(CONFIG.STORE_FRAGMENTS).store.openCursor();
    while (c2) { total += Number(c2.value && c2.value.bytes) || 0; c2 = await c2.continue(); }
    _storageTotal = total;
    paintStorage();
    await refreshStorageQuota();
}
window.calcTotalStorage = calcTotalStorage;

export async function cleanupOrphanWavChunks() {
    const db = await database();
    let swept = false;

    const tx = db.transaction(CONFIG.STORE_FRAGMENTS);
    const recIds = [];
    let cur = await tx.store.index('by-rec').openKeyCursor(null, 'nextunique');
    while (cur) { recIds.push(cur.key); cur = await cur.continue(); }
    await tx.done;

    for (const id of recIds) {
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        if (!rec || (rec.audioBytes > 0 && !rec.processing)) {
            const txDelete = db.transaction(CONFIG.STORE_FRAGMENTS, 'readwrite');
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
    if (swept) await calcTotalStorage();
}


