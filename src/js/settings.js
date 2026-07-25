/* ==========================================================================
 *  settings.js - Settings overlay, server model picker and destructive actions
 *  ========================================================================== */
import { CONFIG, SETTINGS_DEFAULTS, getSetting, escapeHtml, escapeAttr } from './config.js';
import { chooseReplyModel }                           from './reply-core.js';
import { dbExec, dbUpdate, calcTotalStorage, clearAllAudioFragments, deleteAudioFragments } from './db.js';
import { AppState }                                    from './recorder.js';
import { cancelAllForRec, cancelAllJobs }               from './jobs.js';
import { acquireRecordingLock, releaseRecordingLock, isFreshHeartbeat } from './recording-lock.js';

// renderList is injected to avoid circular dependency
let _renderList = async () => {};
export function setSettingsRenderList(fn) { _renderList = fn; }

let _settingsReturnFocus = null;

// Every persisted control. All are <select>/<input>/<textarea> and expose .value.
const ELEMENT_KEYS = [
    'set-auto-transcribe', 'set-auto-reply', 'set-compact-mode',
    'set-ai-instructions', 'set-transcribe-lang', 'set-ollama-model',
    'set-recording-format', 'set-remote-backups'
];

/* ── Open / close ── */
export function openSettings() {
    _settingsReturnFocus = document.activeElement;
    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (el) el.value = getSetting(k);
    });
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => document.getElementById('settingsPanel')?.focus());
    // Populate the model dropdown live from the Ollama server.
    refreshOllamaModels();
}

export function closeSettings() {
    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (el) localStorage.setItem(k, el.value);
    });
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    applyCompactMode();
    _renderList();   // reflect compact/full changes immediately
    try { _settingsReturnFocus?.focus(); } catch (_) {}
    _settingsReturnFocus = null;
}

/* ── Live persistence ──
   Persist each control on `change`, and flush on tab hide/close as a safety net
   (a <textarea> only fires `change` on blur). closeSettings() still does a final
   flush. Wired once at boot.

   IMPORTANT: the flush ONLY runs while the settings panel is open. The controls
   are blank in the markup and are filled from storage when the panel opens, so
   flushing while it's closed would overwrite saved values with those blank
   defaults - which is exactly what previously wiped the endpoint paths. */
let _persistWired = false;
export function wireSettingsPersistence() {
    if (_persistWired) return;
    _persistWired = true;

    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (!el) return;
        el.addEventListener('change', () => {
            localStorage.setItem(k, el.value);
            if (k === 'set-compact-mode') { applyCompactMode(); _renderList(); }
        });
    });

    const settingsOpen = () => {
        const ov = document.getElementById('settingsOverlay');
        return !!ov && ov.classList.contains('open');
    };
    const flush = () => {
        if (!settingsOpen()) return;   // closed → controls aren't populated, don't persist
        ELEMENT_KEYS.forEach(k => {
            const el = document.getElementById(k);
            if (el) localStorage.setItem(k, el.value);
        });
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}

/* ── Server reply-model discovery ── */
/**
 * Query the configured Ollama service for its currently-downloaded models (/api/tags) and
 * populate the picker. Falls back to the saved model if the server is offline,
 * so the app keeps working without a connection.
 */
export async function refreshOllamaModels() {
    const sel      = document.getElementById('set-ollama-model');
    const statusEl = document.getElementById('ollama-model-status');
    if (!sel) return;

    // The endpoint is a fixed same-origin reverse-proxy path.
    const base   = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const stored = getSetting('set-ollama-model');
    if (statusEl) statusEl.textContent = 'Loading models…';

    try {
        const res = await fetch(`${base}/api/tags`, { method: 'GET' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data   = await res.json();
        const models = (data.models || []).map(m => m.name).filter(Boolean);
        if (models.length === 0) throw new Error('no models installed');

        sel.innerHTML = models
            .map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`)
            .join('');
        // Persist the resolved choice. Showing a model the app would not actually
        // use is what made a fresh profile fail: the picker displayed the first
        // installed model while every reply was still sent to the stored default.
        const chosen = chooseReplyModel(models, stored, SETTINGS_DEFAULTS['set-ollama-model']);
        sel.value = chosen;
        if (chosen !== stored) localStorage.setItem('set-ollama-model', chosen);
        if (statusEl) {
            statusEl.textContent = chosen === stored
                ? `${models.length} model(s) available`
                : `${models.length} model(s) available - ${stored} is not installed, using ${chosen}`;
        }
    } catch (e) {
        // Keep the saved model usable as a single fallback option.
        sel.innerHTML = `<option value="${escapeAttr(stored)}">${escapeHtml(stored)} (saved)</option>`;
        sel.value = stored;
        if (statusEl) statusEl.textContent = `Couldn't reach the reply server (${e.message}). Using saved model.`;
    }
}

/* ── Compact mode ── */
export function applyCompactMode() {
    document.body.classList.toggle('compact', getSetting('set-compact-mode') === 'on');
}
export function isCompact() {
    return getSetting('set-compact-mode') === 'on';
}

/* ── Destructive operations ── */
function invalidatePendingResults(rec) {
    rec.resultGeneration = (rec.resultGeneration || 0) + 1;
    return rec;
}

function rowHasLiveAudioOwner(rec) {
    return !!rec?.processing && (
        isFreshHeartbeat(rec.heartbeatAt) ||
        isFreshHeartbeat(rec.finalizerHeartbeatAt)
    );
}

async function withAudioLifecycleLock(work) {
    const locked = await acquireRecordingLock();
    if (!locked) {
        alert('Another tab is recording or finalizing audio. Try again after it finishes.');
        return false;
    }
    try {
        return await work();
    } finally {
        await releaseRecordingLock();
    }
}

export async function deleteAllAudio() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting audio.');
        return;
    }
    if (!confirm('Delete ALL saved audio blobs? Text (transcripts/summaries) will be kept.')) return;

    try {
        await withAudioLifecycleLock(async () => {
            // Re-read after locking: another tab may have started between the
            // confirmation dialog and lock acquisition. The heartbeat check is
            // a second line of defence for browsers using the storage fallback.
            const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
            if (all.some(rowHasLiveAudioOwner)) {
                alert('A recording is still active or being finalized. Audio was not deleted.');
                return false;
            }

            cancelAllJobs();
            await clearAllAudioFragments();
            for (const row of all) {
                const hasText = (row.transcripts || []).length > 0 || (row.summaries || []).length > 0;
                if (!hasText) {
                    await dbExec(CONFIG.STORE_REC, 'delete', row.id);
                    continue;
                }
                await dbUpdate(CONFIG.STORE_REC, row.id, rec => {
                    if (!rec) return null;
                    delete rec.blob;
                    invalidatePendingResults(rec);
                    rec.processing = false;
                    rec.captureState = 'ready';
                    delete rec.deleting;
                    delete rec.finalizationError;
                    delete rec.finalizationErrorAt;
                    delete rec.ownerId;
                    delete rec.heartbeatAt;
                    delete rec.finalizerId;
                    delete rec.finalizerHeartbeatAt;
                    return rec;
                });
            }
            await calcTotalStorage();
            await _renderList();
            return true;
        });
    } catch (err) {
        alert('Could not delete all audio: ' + (err && err.message ? err.message : err));
    }
}

export async function deleteAllText() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting text.');
        return;
    }
    if (!confirm('Delete ALL transcripts, summaries and context chains? Audio blobs will be kept.')) return;

    try {
        await withAudioLifecycleLock(async () => {
            const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
            if (all.some(rowHasLiveAudioOwner)) {
                alert('A recording is still active or being finalized. Text was not deleted.');
                return false;
            }

            cancelAllJobs();
            for (const row of all) {
                if (!row.blob) {
                    await dbExec(CONFIG.STORE_REC, 'delete', row.id);
                    continue;
                }
                await dbUpdate(CONFIG.STORE_REC, row.id, rec => {
                    if (!rec) return null;
                    invalidatePendingResults(rec);
                    rec.transcripts = [];
                    rec.summaries = [];
                    delete rec.context;
                    delete rec.contextChain;
                    delete rec.pipelineError;
                    delete rec.pipelineErrorAt;
                    return rec;
                });
            }
            await _renderList();
            return true;
        });
    } catch (err) {
        alert('Could not delete all text: ' + (err && err.message ? err.message : err));
    }
}

export async function deleteTranscript(recId, tId) {
    cancelAllForRec(recId);
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec) return null;
        invalidatePendingResults(rec);
        rec.transcripts = (rec.transcripts || []).filter(item => item.id != tId);
        rec.summaries = (rec.summaries || []).filter(item => item.transcriptId != tId);
        return rec;
    });
    await _renderList();
}

export async function deleteSummary(recId, sId) {
    cancelAllForRec(recId);
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec) return null;
        invalidatePendingResults(rec);
        rec.summaries = (rec.summaries || []).filter(item => item.id != sId);
        return rec;
    });
    await _renderList();
}

export async function deleteRec(id) {
    if (!confirm('Are you sure you want to delete this recording?')) return;

    let markedForDelete = false;
    try {
        await withAudioLifecycleLock(async () => {
            const marked = await dbUpdate(CONFIG.STORE_REC, id, rec => {
                if (!rec || rowHasLiveAudioOwner(rec)) return null;
                invalidatePendingResults(rec);
                rec.deleting = true;
                return rec;
            });
            if (!marked) {
                const current = await dbExec(CONFIG.STORE_REC, 'get', id);
                if (current) alert('This recording is active or being finalized in another tab. It was not deleted.');
                return false;
            }

            markedForDelete = true;
            cancelAllForRec(id);
            // Delete chunks first. The row-level tombstone prevents recovery or
            // a finalizer from claiming the recording during this interval.
            await deleteAudioFragments(id, marked.sessionId || null, { allSessions: !marked.sessionId });
            await dbExec(CONFIG.STORE_REC, 'delete', id);
            markedForDelete = false;
            await calcTotalStorage();
            await _renderList();
            return true;
        });
    } catch (err) {
        // Keep a failed delete recoverable rather than leaving a permanent
        // tombstone that hides the row from recovery.
        if (markedForDelete) {
            await dbUpdate(CONFIG.STORE_REC, id, rec => {
                if (!rec) return null;
                delete rec.deleting;
                return rec;
            }).catch(() => {});
        }
        alert('Could not delete this recording: ' + (err && err.message ? err.message : err));
        await _renderList();
    }
}

/* ── Context management ──
   Only the per-part operations are wired in the UI (each context item shows
   separate ✂️/👁️ controls for its input and output halves); the old
   whole-item unlinkContext/viewContext were unused and have been removed. */
export async function unlinkContextPart(recId, itemIdx, part) {
    await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec) return null;
        const chain = rec.contextChain ? [...rec.contextChain] : (rec.context ? [rec.context] : []);
        const item = chain[itemIdx];
        if (!item) return null;   // nothing to change → skip the put
        if (part === 'input')  item.inputText  = '';
        if (part === 'output') item.outputText = '';
        item.text = (item.inputText ? `[User Scribe Input]: ${item.inputText}\n` : '')
                  + (item.outputText ? `[AI Summary/Reply Output]: ${item.outputText}\n` : '');
        if (!item.inputText && !item.outputText) chain.splice(itemIdx, 1);
        rec.contextChain = chain;
        if (rec.context) delete rec.context;
        return rec;
    });
    _renderList();
}

/* ── Viewer helpers ── */
function openTextBlob(text) {
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const win = window.open(url);
    // Revoke once the viewer has loaded (with a safety fallback) to avoid leaks.
    if (win) {
        try { win.addEventListener('load', () => { try { URL.revokeObjectURL(url); } catch (_) {} }); } catch (_) {}
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
    } else {
        URL.revokeObjectURL(url);
    }
}

export async function viewTranscriptById(recId, tId) {
    const rec  = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const item = (rec.transcripts || []).find(t => t.id == tId);
    if (item) openTextBlob(item.text);
}

export async function viewSummaryById(recId, sId) {
    const rec  = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const item = (rec.summaries || []).find(s => s.id == sId);
    if (item) openTextBlob(item.text);
}

export async function viewContextPart(recId, itemIdx, part) {
    const rec   = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const chain = rec.contextChain || (rec.context ? [rec.context] : []);
    const item  = chain[itemIdx];
    if (!item) return;
    const text = part === 'input'  ? (item.inputText || item.text || '')
               : part === 'output' ? (item.outputText || '')
               : (item.text || '');
    openTextBlob(text);
}

export async function scrollToRecording(identifier) {
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    const match = all.find(rec => rec.id == identifier)
        || all.find(rec => rec.filename && rec.filename.startsWith(String(identifier)));
    if (!match) return;
    if (typeof window.showRecordingById === 'function') {
        await window.showRecordingById(match.id);
        return;
    }
    const el = document.getElementById(`rec-${match.id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Expose to window for delegated action handlers ── */
export function exposeSettingsGlobals() {
    window.closeSettings       = closeSettings;
    window.refreshOllamaModels = refreshOllamaModels;
    window.deleteAllAudio      = deleteAllAudio;
    window.deleteAllText       = deleteAllText;
    window.deleteTranscript    = deleteTranscript;
    window.deleteSummary       = deleteSummary;
    window.deleteRec           = deleteRec;
    window.unlinkContextPart   = unlinkContextPart;
    window.viewTranscriptById  = viewTranscriptById;
    window.viewSummaryById     = viewSummaryById;
    window.viewContextPart     = viewContextPart;
    window.scrollToRecording   = scrollToRecording;
}
