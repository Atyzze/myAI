/* ==========================================================================
 *  settings.js — Settings overlay, bulk delete, per-item delete, model picker
 *  ========================================================================== */
import { CONFIG, getSetting, escapeHtml, escapeAttr } from './config.js';
import { dbExec, dbUpdate, dbPromise, calcTotalStorage } from './db.js';
import { AppState }                                    from './recorder.js';

// renderList is injected to avoid circular dependency
let _renderList = async () => {};
export function setSettingsRenderList(fn) { _renderList = fn; }

// Every persisted control. All are <select>/<input>/<textarea> and expose .value.
const ELEMENT_KEYS = [
    'set-auto-transcribe', 'set-auto-reply', 'set-compact-mode',
    'set-ai-instructions', 'set-transcribe-lang', 'set-ollama-model'
];

/* ── Open / close ── */
export function openSettings() {
    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (el) el.value = getSetting(k);
    });
    document.getElementById('settingsOverlay').classList.add('open');
    // Populate the model dropdown live from the Ollama server.
    refreshOllamaModels();
}

export function closeSettings() {
    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (el) localStorage.setItem(k, el.value);
    });
    document.getElementById('settingsOverlay').classList.remove('open');
    applyCompactMode();
    _renderList();   // reflect compact/full changes immediately
}

/* ── Live persistence ──
   Persist each control on `change`, and flush on tab hide/close as a safety net
   (a <textarea> only fires `change` on blur). closeSettings() still does a final
   flush. Wired once at boot.

   IMPORTANT: the flush ONLY runs while the settings panel is open. The controls
   are blank in the markup and are filled from storage when the panel opens, so
   flushing while it's closed would overwrite saved values with those blank
   defaults — which is exactly what previously wiped the endpoint paths. */
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

/* ── Ollama model discovery ── */
/**
 * Query the Ollama server for its currently-downloaded models (/api/tags) and
 * populate the picker. Falls back to the saved model if the server is offline,
 * so the app keeps working without a connection.
 */
export async function refreshOllamaModels() {
    const sel      = document.getElementById('set-ollama-model');
    const statusEl = document.getElementById('ollama-model-status');
    if (!sel) return;

    // Endpoint is a fixed reverse-proxy path now (CONFIG.OLLAMA_URL), so the
    // model list always loads without the user having to type anything.
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
        sel.value = models.includes(stored) ? stored : models[0];
        if (statusEl) statusEl.textContent = `${models.length} model(s) available`;
    } catch (e) {
        // Keep the saved model usable as a single fallback option.
        sel.innerHTML = `<option value="${escapeAttr(stored)}">${escapeHtml(stored)} (saved)</option>`;
        sel.value = stored;
        if (statusEl) statusEl.textContent = `Couldn't reach Ollama (${e.message}). Using saved model.`;
    }
}

/* ── Compact mode ── */
export function applyCompactMode() {
    document.body.classList.toggle('compact', getSetting('set-compact-mode') === 'on');
}
export function isCompact() {
    return getSetting('set-compact-mode') === 'on';
}

/* ── Bulk delete ── */
export async function deleteAllAudio() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting audio.');
        return;
    }
    if (!confirm('Delete ALL saved audio blobs? Text (transcripts/summaries) will be kept.')) return;
    const db = await dbPromise;
    await db.clear(CONFIG.STORE_WAV);
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    for (const r of all) {
        delete r.blob;
        const hasText = (r.transcripts || []).length > 0 || (r.summaries || []).length > 0;
        if (!hasText) await dbExec(CONFIG.STORE_REC, 'delete', r.id);
        else          await dbExec(CONFIG.STORE_REC, 'put', r);
    }
    calcTotalStorage();
    _renderList();
}

export async function deleteAllText() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting text.');
        return;
    }
    if (!confirm('Delete ALL transcripts, summaries and context chains? Audio blobs will be kept.')) return;
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    for (const r of all) {
        r.transcripts = [];
        r.summaries   = [];
        delete r.context;
        delete r.contextChain;
        const hasAudio = !!r.blob;
        if (!hasAudio) await dbExec(CONFIG.STORE_REC, 'delete', r.id);
        else           await dbExec(CONFIG.STORE_REC, 'put', r);
    }
    _renderList();
}

/* ── Per-item delete ──
   These use dbUpdate (atomic get→modify→put in one transaction) so a write
   that lands concurrently — e.g. a streaming reply finishing, or a second tab
   — can't be clobbered by a stale read-modify-write. */
export async function deleteTranscript(recId, tId) {
    await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec) return null;
        rec.transcripts = (rec.transcripts || []).filter(t => t.id != tId);
        rec.summaries   = (rec.summaries   || []).filter(s => s.transcriptId != tId);
        return rec;
    });
    _renderList();
}

export async function deleteSummary(recId, sId) {
    await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec) return null;
        rec.summaries = (rec.summaries || []).filter(s => s.id != sId);
        return rec;
    });
    _renderList();
}

export async function deleteRec(id) {
    if (!confirm('Are you sure you want to delete this recording?')) return;
    await dbExec(CONFIG.STORE_REC, 'delete', id);
    await dbExec(CONFIG.STORE_WAV, 'deleteRange', id);
    calcTotalStorage();
    _renderList();
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

export async function scrollToRecording(timestampPrefix) {
    const all   = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    const match = all.find(r => r.filename && r.filename.startsWith(timestampPrefix));
    if (match) {
        const el = document.getElementById(`rec-${match.id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/* ── Expose to window for inline onclick handlers ── */
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
