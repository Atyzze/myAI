/* ==========================================================================
 * main.js — Application entry point: wires all modules together
 * ========================================================================== */
import { calcTotalStorage, migrateLegacyIds, cleanupOrphanWavChunks } from './db.js';
import { AppState, startRecording, stopRecording,
         recoverIncompleteRecordings, setRenderList } from './recorder.js';
import { setAutoRenderList }                   from './auto-pipeline.js';
import { openSettings, closeSettings, exposeSettingsGlobals,
         setSettingsRenderList, applyCompactMode,
         wireSettingsPersistence } from './settings.js';
import { renderList }                          from './gui.js';
import { cancelAllForRec }                     from './jobs.js';

// ── Inject renderList into modules that need it (breaks circular deps) ──
setRenderList(renderList);
setAutoRenderList(renderList);
setSettingsRenderList(renderList);

// ── Expose globals for inline onclick / live-status cancel buttons ──
exposeSettingsGlobals();
window.cancelRecJob = cancelAllForRec;

// ── Persist settings live (on change + tab hide), not only on panel close ──
wireSettingsPersistence();

// ── Apply compact mode from saved settings immediately ──
applyCompactMode();

// ── Register service worker for offline support (cache app shell + deps) ──
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err =>
            console.warn('Service worker registration failed:', err));
    });
}

// ── Record button ──
// State is driven by AppState.recId (set while recording, null otherwise), not
// by sniffing button text. start/stop are themselves debounced in recorder.js.
const recordBtn = document.getElementById('recordBtn');
recordBtn.onclick = () => {
    if (AppState.recId) stopRecording();
    else                startRecording();
};

// ── Settings button ──
document.getElementById('settingsBtn').onclick = openSettings;
document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeSettings();
};

// ── Fullscreen visualizer ──
function setupFullscreen() {
    const canvas = document.getElementById('visualizer');
    const fps    = document.getElementById('fpsDisplay');
    const gear   = document.getElementById('settingsBtn');

    const enterFsUI = () => {
        canvas.classList.add('fullscreen');
        gear.style.display = 'none';
        fps.style.cssText = 'display:block;position:fixed;top:12px;left:12px;z-index:502;padding:4px 10px;background:rgba(0,0,0,.7);border-radius:8px;font:13px/1.4 monospace;color:#0f9;pointer-events:none';
    };
    const exitFsUI = () => {
        canvas.classList.remove('fullscreen');
        gear.style.display = '';
        fps.style.cssText = 'display:block;position:absolute;top:6px;right:8px;padding:3px 7px;background:rgba(0,0,0,.6);border-radius:6px;font:12px/1.4 monospace;pointer-events:none;color:#0f9';
    };

    canvas.addEventListener('click', () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isFs) {
            const el = document.documentElement;
            if (el.requestFullscreen) el.requestFullscreen();
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
            enterFsUI();
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            exitFsUI();
        }
    });

    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitFsUI(); });
    document.addEventListener('webkitfullscreenchange', () => { if (!document.webkitFullscreenElement) exitFsUI(); });
}

// ── Boot ──
window.onload = async () => {
    calcTotalStorage();
    setupFullscreen();
    renderList();                 // paint the list immediately — never block on recovery

    // Background maintenance (does not gate first paint):
    //  • migrateLegacyIds      — give legacy items permanent ids (persisted once)
    //  • recoverIncompleteRecordings — finalize crash-interrupted recordings, but
    //    with the auto-pipeline DISABLED so a reload can't silently re-run (and
    //    re-POST to) cloud transcription/reply
    //  • cleanupOrphanWavChunks — drop WAV chunks stranded by a crash mid-finalize
    (async () => {
        try { await migrateLegacyIds(); }            catch (e) { console.warn('id migration failed:', e); }
        try { await recoverIncompleteRecordings(); } catch (e) { console.warn('recovery failed:', e); }
        try { await cleanupOrphanWavChunks(); }      catch (e) { console.warn('orphan sweep failed:', e); }
        renderList();             // reflect any finalized/cleaned rows
    })();
};
