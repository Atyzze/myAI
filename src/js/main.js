/* ==========================================================================
 * main.js - Application entry point: wires all modules together
 * ========================================================================== */
import { calcTotalStorage, migrateLegacyIds, cleanupOrphanWavChunks,
         requestPersistentStorage } from './db.js';
import { CONFIG, fmtDur }                      from './config.js';
import { AppState, startRecording, stopRecording,
         recoverIncompleteRecordings, retryFinalizeRecording, setRenderList } from './recorder.js';
import { setAutoRenderList }                   from './auto-pipeline.js';
import { openSettings, closeSettings, exposeSettingsGlobals,
         setSettingsRenderList, applyCompactMode,
         wireSettingsPersistence } from './settings.js';
import { renderList, resetListToFirstPage, wireActionDelegation } from './gui.js';
import { cancelAllForRec }                     from './jobs.js';
import { openHelp, closeHelp, exposeHelpGlobals } from './help.js';
import { paintAppVersion }                    from './version.js';
import { getActiveRecordingLease, isLeaseOwnedByThisTab, subscribeRecordingLease } from './recording-lock.js';

// ── Inject renderList into modules that need it (breaks circular deps) ──
setRenderList(renderList);
setAutoRenderList(renderList);
setSettingsRenderList(renderList);

// ── Expose action targets used by the strict delegated UI router ──
exposeSettingsGlobals();
exposeHelpGlobals();
window.cancelRecJob = cancelAllForRec;
window.retryFinalizeRec = async (recId) => {
    try { await retryFinalizeRecording(Number(recId)); }
    catch (err) { alert('Finalization failed again: ' + (err && err.message ? err.message : err)); }
};
wireActionDelegation();

// ── Persist settings live (on change + tab hide), not only on panel close ──
wireSettingsPersistence();

// ── Apply compact mode from saved settings immediately ──
applyCompactMode();

// ── Version label (under the ? button) ──
// Read from the service worker, which is the one place the version is declared
// and the only component that knows which shell is really being served.
const _refreshVersionLabel = paintAppVersion(document.getElementById('app-version'));

// ── Register service worker for the offline application shell ──
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'legacy-model-cache-cleared') {
            calcTotalStorage().catch(() => {});
        }
    });
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(
            () => _refreshVersionLabel(),
            err => console.warn('Service worker registration failed:', err));
    });
}

// ── Record button ──
// State is driven by AppState.recId (set while recording, null otherwise), not
// by sniffing button text. start/stop are themselves debounced in recorder.js.
const recordBtn = document.getElementById('recordBtn');
let _visibleRecordingLease = getActiveRecordingLease();
let _refreshedForRecId = null;   // remote recording we have already repainted for
function paintCrossTabRecordingState(lease) {
    const previousLease = _visibleRecordingLease;
    const wasOtherTabLive = !!previousLease && !isLeaseOwnedByThisTab(previousLease);
    _visibleRecordingLease = lease;
    const otherTabLive = !!lease && !isLeaseOwnedByThisTab(lease);
    recordBtn.classList.toggle('locked-other', otherTabLive);
    recordBtn.title = otherTabLive
        ? 'A recording is active in another tab. Stop that session before starting here.'
        : '';
    // Live state is shown only on the integrated recording row. Avoid a
    // second global badge beside the version; the row already carries the timer
    // and distinguishes local ownership from `LIVE · OTHER TAB`.
    if (otherTabLive) {
        const clock = document.querySelector(`.other-tab-live-clock[data-rec-id="${lease.recId}"]`);
        if (clock) {
            const elapsed = Math.max(0, Number(lease.durationMs || 0) + (Date.now() - Number(lease.heartbeatAt || Date.now())));
            clock.textContent = fmtDur(elapsed);
        } else if (_refreshedForRecId !== lease.recId) {
            // The recording row was created in another tab after our current page
            // was painted. Pull it into this tab without waiting for a reload.
            // Only ONCE per remote recording: the freshness poll below runs every
            // few seconds, so an unconditional repaint here became a permanent
            // render loop whenever the row could not be shown (for example while
            // the list is filtered to a page that cannot contain it).
            _refreshedForRecId = lease.recId;
            resetListToFirstPage();
            renderList().catch(err => console.warn('Cross-tab list refresh failed:', err));
        }
    } else if (wasOtherTabLive) {
        _refreshedForRecId = null;
        // Ownership ended after finalization; replace the green remote-live row
        // with the normal static recording entry.
        renderList().catch(err => console.warn('Cross-tab final render failed:', err));
    }
}
subscribeRecordingLease(paintCrossTabRecordingState);
// storage/BroadcastChannel events report changes promptly, while this periodic
// freshness check removes a crashed tab's expired badge even if no new event is
// emitted after its final heartbeat.
setInterval(() => paintCrossTabRecordingState(getActiveRecordingLease()), CONFIG.RECORDING_HEARTBEAT_MS);

recordBtn.onclick = () => {
    if (AppState.recId) {
        stopRecording();
        return;
    }
    const currentLease = getActiveRecordingLease();
    paintCrossTabRecordingState(currentLease);
    if (currentLease && !isLeaseOwnedByThisTab(currentLease)) {
        alert('Another tab is already recording. Stop that recording before starting a new session here.');
        return;
    }
    // Called directly from the record-button gesture because browsers may only
    // grant persistent origin storage in response to user interaction.
    requestPersistentStorage().catch(() => {});
    resetListToFirstPage();
    startRecording();   // show the new LIVE row on page 0
};

// ── Settings button ──
document.getElementById('settingsBtn').onclick = openSettings;
document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeSettings();
};

// ── Help ("?") button ──
document.getElementById('helpBtn').onclick = openHelp;
document.getElementById('helpOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeHelp();
};

// ── Modal keyboard behavior ──
function activeDialogPanel() {
    if (document.getElementById('settingsOverlay').classList.contains('open')) return document.getElementById('settingsPanel');
    if (document.getElementById('helpOverlay').classList.contains('open')) return document.getElementById('helpPanel');
    return null;
}

document.addEventListener('keydown', event => {
    const panel = activeDialogPanel();
    if (!panel) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        if (panel.id === 'settingsPanel') closeSettings(); else closeHelp();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll(
        'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

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

    const toggleFullscreen = () => {
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
    };
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', 'Toggle fullscreen audio visualizer');
    canvas.addEventListener('click', toggleFullscreen);
    canvas.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitFsUI(); });
    document.addEventListener('webkitfullscreenchange', () => { if (!document.webkitFullscreenElement) exitFsUI(); });
}

// ── Boot ──
window.onload = async () => {
    calcTotalStorage();
    setupFullscreen();
    renderList();                 // paint the list immediately - never block on recovery

    // Background maintenance (does not gate first paint):
    //  • migrateLegacyIds      - give legacy items permanent ids (persisted once)
    //  • recoverIncompleteRecordings - finalize crash-interrupted recordings, but
    //    with the auto-pipeline DISABLED so a reload can't silently re-run (and
    //    re-POST to) server transcription/reply
    //  • cleanupOrphanWavChunks - drop WAV chunks stranded by a crash mid-finalize
    (async () => {
        try { await migrateLegacyIds(); } catch (e) { console.warn('id migration failed:', e); }
        let recovery = { deferred: 0 };
        try { recovery = await recoverIncompleteRecordings(); }
        catch (e) { console.warn('recovery failed:', e); }
        try { await cleanupOrphanWavChunks(); } catch (e) { console.warn('orphan sweep failed:', e); }
        await renderList();

        // A tab can open seconds after another tab crashes. Its last heartbeat is
        // intentionally respected until stale; retry once that safety window ends.
        if (recovery.deferred > 0) {
            setTimeout(async () => {
                try {
                    await recoverIncompleteRecordings();
                    await cleanupOrphanWavChunks();
                    await renderList();
                } catch (e) { console.warn('delayed recovery failed:', e); }
            }, CONFIG.RECORDING_STALE_MS + 1000);
        }
    })();
};
