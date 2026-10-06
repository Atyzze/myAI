import { calcTotalStorage, cleanupOrphanWavChunks, cleanupOrphanAudio,
         cleanupOrphanLiveTranscripts, cleanupOrphanCaptureBeats, requestPersistentStorage,
         setDatabaseBusyCheck, setDatabaseGuardListener, noteDatabaseIdle } from './db.js';
import { describeConnectionGuard } from './db-lifecycle-core.js';
import { CONFIG, fmtDur, getLocalIso } from './config.js';
import { buildClipboardContextItem, CLIPBOARD_CONTEXT_MAX_CHARS } from './clipboard-core.js';
import { AppState, startRecording, stopRecording,
         recoverIncompleteRecordings, retryFinalizeRecording, downloadRecoverableAudio, setRenderList,
         setLiveTranscription, isLiveTranscriptionOn, followUpsRunning,
         onRecordingStateChange, addContextToRecording, describeLiveContext } from './recorder.js';
import { setVisualizerFullscreen } from './live-scribe.js';
import { WAVEFORM_HIDDEN_EVENT } from './waveform-core.js';
import { setAutoRenderList }                   from './auto-pipeline.js';
import { openSettings, closeSettings, exposeSettingsGlobals,
         setSettingsRenderList, applyCompactMode,
         wireSettingsPersistence, runRetentionSweep, backupRunning,
         finishInterruptedDeletions } from './settings.js';
import { renderList, resetListToFirstPage, wireActionDelegation, isConverting } from './gui.js';
import { cancelAllForRec, hasAnyJob }          from './jobs.js';
import { openHelp, closeHelp, exposeHelpGlobals } from './help.js';
import { paintAppVersion, exposeUpdateGlobals, setUpdateBusyCheck } from './version.js';
import { loadBoxCapabilities } from './capabilities.js';
import { getActiveRecordingLease, isLeaseOwnedByThisTab, subscribeRecordingLease,
         holdsRecordingLock } from './recording-lock.js';

setRenderList(renderList);
setAutoRenderList(renderList);
setSettingsRenderList(renderList);

exposeSettingsGlobals();
exposeHelpGlobals();
window.cancelRecJob = cancelAllForRec;
window.retryFinalizeRec = async (recId) => {
    try { await retryFinalizeRecording(Number(recId)); }
    catch (err) { alert('Finalization failed again: ' + (err && err.message ? err.message : err)); }
};
let _recovering = null;
function recoverInBackground({ retryFailed = false } = {}) {
    if (_recovering || AppState.recId != null || AppState.busy) return _recovering;
    _recovering = (async () => {
        try {
            const result = await recoverIncompleteRecordings({ retryFailed });
            if (result.recovered > 0) await renderList();
            await finishInterruptedDeletions().catch(err => console.warn('Finishing interrupted deletions failed:', err));
            return result;
        } finally {
            _recovering = null;
        }
    })();
    return _recovering;
}
window.recoverNowRec = async () => {
    try {
        const result = await recoverInBackground();
        await renderList();
        if (!result || result.recovered === 0) {
            alert('This recording cannot be recovered right now: a recording or another save is still running. '
                + 'It is tried again by itself once that has finished.');
        }
    } catch (err) {
        alert('Recovery failed: ' + (err && err.message ? err.message : err));
    }
};
let _recoveryTimer = null;
function scheduleRecoveryOfClosedTabRecordings(delayMs = CONFIG.RECORDING_STALE_MS + 1000) {
    if (_recoveryTimer) return;
    _recoveryTimer = setTimeout(() => {
        _recoveryTimer = null;
        recoverInBackground()?.catch?.(err => console.warn('Background recovery failed:', err));
    }, delayMs);
}
setInterval(() => scheduleRecoveryOfClosedTabRecordings(0), CONFIG.RECOVERY_SWEEP_MS);
window.downloadRecoverableRec = async (recId) => {
    try {
        if (!await downloadRecoverableAudio(Number(recId))) alert('No saved audio was found for this recording.');
    } catch (err) {
        alert('Could not put the saved audio together: ' + (err && err.message ? err.message : err));
    }
};
wireActionDelegation();

wireSettingsPersistence();

applyCompactMode();

const recordingHere = () => AppState.recId != null;
const workingHere = () => recordingHere() || AppState.busy || holdsRecordingLock()
    || followUpsRunning() || hasAnyJob() || isConverting();
setDatabaseBusyCheck(workingHere, recordingHere);
setDatabaseGuardListener((state, { recording, busy }) => {
    const node = document.getElementById('storage-alert');
    if (!node) return;
    const text = describeConnectionGuard(state, { recording, busy });
    if (text) {
        node.dataset.owner = 'guard';
        node.textContent = text;
        node.hidden = false;
    } else if (node.dataset.owner === 'guard') {
        delete node.dataset.owner;
        node.textContent = '';
        node.hidden = true;
    }
});
setInterval(noteDatabaseIdle, 1000);

function paintStartupNote(text) {
    const node = document.getElementById('storage-alert');
    if (!node || (node.dataset.owner && node.dataset.owner !== 'startup')) return;
    if (text) {
        node.dataset.owner = 'startup';
        node.textContent = text;
        node.hidden = false;
    } else if (node.dataset.owner === 'startup') {
        delete node.dataset.owner;
        node.textContent = '';
        node.hidden = true;
    }
}

exposeUpdateGlobals();
loadBoxCapabilities();
setUpdateBusyCheck(() => workingHere() || backupRunning());
const _refreshVersionLabel = paintAppVersion(document.getElementById('app-version'));

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(
            () => _refreshVersionLabel(),
            err => console.warn('Service worker registration failed:', err));
    });
}

const recordBtn = document.getElementById('recordBtn');
let _visibleRecordingLease = getActiveRecordingLease();
let _refreshedForRecId = null;
function paintCrossTabRecordingState(lease) {
    const previousLease = _visibleRecordingLease;
    const wasOtherTabLive = !!previousLease && !isLeaseOwnedByThisTab(previousLease);
    _visibleRecordingLease = lease;
    const otherTabLive = !!lease && !isLeaseOwnedByThisTab(lease);
    recordBtn.classList.toggle('locked-other', otherTabLive);
    recordBtn.title = otherTabLive
        ? 'A recording is active in another tab. Stop that session before starting here.'
        : '';
    if (otherTabLive) {
        const clock = document.querySelector(`.other-tab-live-clock[data-rec-id="${lease.recId}"]`);
        if (clock) {
            const elapsed = Math.max(0, Number(lease.durationMs || 0) + (Date.now() - Number(lease.heartbeatAt || Date.now())));
            clock.textContent = fmtDur(elapsed);
        } else if (_refreshedForRecId !== lease.recId) {
            _refreshedForRecId = lease.recId;
            resetListToFirstPage();
            renderList().catch(err => console.warn('Cross-tab list refresh failed:', err));
        }
    } else if (wasOtherTabLive) {
        _refreshedForRecId = null;
        renderList().catch(err => console.warn('Cross-tab final render failed:', err));
        scheduleRecoveryOfClosedTabRecordings();
    }
}
subscribeRecordingLease(paintCrossTabRecordingState);
setInterval(() => paintCrossTabRecordingState(getActiveRecordingLease()), CONFIG.RECORDING_HEARTBEAT_MS);

const liveScribeBtn = document.getElementById('liveScribeBtn');
function paintLiveScribeButton() {
    const recording = AppState.recId != null;
    liveScribeBtn.hidden = false;
    if (recording) {
        const on = isLiveTranscriptionOn();
        liveScribeBtn.setAttribute('aria-pressed', String(on));
        liveScribeBtn.title = on ? 'Hide live transcription' : 'Show live transcription';
    } else {
        liveScribeBtn.removeAttribute('aria-pressed');
        liveScribeBtn.title = 'Start a recording with live transcription on';
    }
    liveScribeBtn.setAttribute('aria-label', liveScribeBtn.title);
}
liveScribeBtn.onclick = async () => {
    if (AppState.recId == null) {
        if (!AppState.busy) beginRecordingSession({ live: true });
        return;
    }
    liveScribeBtn.disabled = true;
    try {
        await setLiveTranscription(!isLiveTranscriptionOn());
    } catch (err) {
        console.warn('Could not change live transcription:', err);
    } finally {
        liveScribeBtn.disabled = false;
        paintLiveScribeButton();
    }
};
window.closeLiveScribe = () => {
    setLiveTranscription(false).catch(() => {}).then(paintLiveScribeButton);
};
paintLiveScribeButton();

function beginRecordingSession(options = {}) {
    const currentLease = getActiveRecordingLease();
    paintCrossTabRecordingState(currentLease);
    if (currentLease && !isLeaseOwnedByThisTab(currentLease)) {
        alert('Another tab is already recording. Stop that recording before starting a new session here.');
        return false;
    }
    requestPersistentStorage()
        .then(granted => { AppState.storagePersistent = granted === true; })
        .catch(() => { AppState.storagePersistent = null; });
    resetListToFirstPage();
    startRecording(options);
    return true;
}

recordBtn.onclick = () => {
    if (AppState.recId) {
        stopRecording();
        return;
    }
    beginRecordingSession();
};

const pasteRecordBtn = document.getElementById('pasteRecordBtn');
function paintPasteRecordButton() {
    pasteRecordBtn.hidden = false;
    pasteRecordBtn.title = AppState.recId != null
        ? 'Add what is on the clipboard to this recording as context for the AI reply'
        : 'Start a recording that remembers what is on the clipboard';
    pasteRecordBtn.setAttribute('aria-label', pasteRecordBtn.title);
}

function flashPasteRecordButton(mark) {
    pasteRecordBtn.textContent = mark;
    setTimeout(() => { pasteRecordBtn.textContent = '📋'; }, 1200);
}

function askForPastedText(reason) {
    const overlay = document.getElementById('pasteOverlay');
    const text = document.getElementById('pasteText');
    const count = document.getElementById('pasteCount');
    const use = document.getElementById('pasteUse');
    const cancel = document.getElementById('pasteCancel');
    const returnFocus = document.activeElement;
    document.getElementById('pasteHint').textContent =
        `${reason} Paste or type it here; up to ${CLIPBOARD_CONTEXT_MAX_CHARS.toLocaleString('en')} characters are kept.`;
    text.value = '';
    const paint = () => {
        const n = text.value.length;
        const over = n > CLIPBOARD_CONTEXT_MAX_CHARS;
        count.textContent = over
            ? `${n.toLocaleString('en')} characters; only the first ${CLIPBOARD_CONTEXT_MAX_CHARS.toLocaleString('en')} are kept`
            : `${n.toLocaleString('en')} characters`;
        count.classList.toggle('over', over);
    };
    return new Promise(resolve => {
        const close = value => {
            overlay.classList.remove('open');
            overlay.setAttribute('aria-hidden', 'true');
            text.removeEventListener('input', paint);
            use.onclick = null;
            cancel.onclick = null;
            overlay.onkeydown = null;
            overlay.onclick = null;
            text.value = '';
            try { returnFocus?.focus(); } catch (_) {}
            resolve(value);
        };
        text.addEventListener('input', paint);
        use.onclick = () => close(text.value);
        cancel.onclick = () => close('');
        overlay.onclick = event => { if (event.target === overlay) close(''); };
        overlay.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(''); } };
        paint();
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        text.focus();
    });
}

async function readClipboardText() {
    let refused = false;
    let text = '';
    try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            text = await navigator.clipboard.readText();
        } else {
            refused = true;
        }
    } catch (err) {
        refused = true;
        console.warn('Reading the clipboard was refused:', err);
    }
    if (String(text || '').trim()) return text;
    return askForPastedText(refused ? 'The clipboard could not be read here.' : 'The clipboard is empty.');
}

pasteRecordBtn.onclick = async () => {
    const recordingId = AppState.recId;
    if (recordingId == null && AppState.busy) return;
    pasteRecordBtn.disabled = true;
    try {
        const item = buildClipboardContextItem(await readClipboardText(), getLocalIso(Date.now()));
        if (!item) return;
        if (recordingId != null) {
            const count = await addContextToRecording(recordingId, item);
            const line = document.getElementById(`live-context-${recordingId}`);
            if (line) { line.textContent = describeLiveContext(count); line.hidden = !count; }
            flashPasteRecordButton(count ? '✓' : '✗');
            return;
        }
        AppState.pendingContext = [item];
        if (!beginRecordingSession()) AppState.pendingContext = null;
    } catch (err) {
        console.warn('Could not start a recording from the clipboard:', err);
        alert('Could not read the clipboard: ' + (err && err.message ? err.message : err));
    } finally {
        pasteRecordBtn.disabled = false;
        paintPasteRecordButton();
    }
};
onRecordingStateChange(() => { paintLiveScribeButton(); paintPasteRecordButton(); });
paintPasteRecordButton();

setInterval(() => {
    runRetentionSweep({ announce: false }).catch(err => console.warn('retention sweep failed:', err));
}, CONFIG.RETENTION_SWEEP_MS);

document.getElementById('settingsBtn').onclick = openSettings;
document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeSettings();
};

document.getElementById('helpBtn').onclick = openHelp;
document.getElementById('helpOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeHelp();
};

function activeDialogPanel() {
    if (document.getElementById('pasteOverlay').classList.contains('open')) return document.getElementById('pastePanel');
    if (document.getElementById('settingsOverlay').classList.contains('open')) return document.getElementById('settingsPanel');
    if (document.getElementById('helpOverlay').classList.contains('open')) return document.getElementById('helpPanel');
    return null;
}

document.addEventListener('keydown', event => {
    const panel = activeDialogPanel();
    if (!panel) return;
    if (event.key === 'Escape') {
        if (panel.id === 'pastePanel') return;
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
    const focusOutsideControls = !focusable.includes(document.activeElement);
    if (focusOutsideControls) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function followDeviceOrientation(follow) {
    const orientation = typeof screen !== 'undefined' && screen.orientation;
    if (!orientation) return;
    try {
        if (follow) {
            if (typeof orientation.unlock === 'function') orientation.unlock();
        } else if (typeof orientation.lock === 'function') {
            Promise.resolve(orientation.lock('portrait')).catch(() => {});
        }
    } catch (_) {}
}

function setupFullscreen() {
    const canvas = document.getElementById('visualizer');
    const fps    = document.getElementById('fpsDisplay');
    const gear   = document.getElementById('settingsBtn');

    const enterFsUI = () => {
        canvas.classList.add('fullscreen');
        followDeviceOrientation(true);
        setVisualizerFullscreen(true);
        gear.style.display = 'none';
        fps.classList.add('fullscreen');
    };
    const exitFsUI = () => {
        canvas.classList.remove('fullscreen');
        followDeviceOrientation(false);
        setVisualizerFullscreen(false);
        gear.style.display = '';
        fps.classList.remove('fullscreen');
    };

    let showingFs = false;
    const browserFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

    const leaveFullscreen = () => {
        if (browserFs()) {
            try {
                if (document.exitFullscreen) Promise.resolve(document.exitFullscreen()).catch(() => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch (_) {}
        }
        showingFs = false;
        exitFsUI();
    };

    const toggleFullscreen = () => {
        if (showingFs || browserFs()) {
            leaveFullscreen();
            return;
        }
        const el = document.documentElement;
        try {
            if (el.requestFullscreen) Promise.resolve(el.requestFullscreen()).catch(() => {});
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        } catch (_) {}
        showingFs = true;
        enterFsUI();
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

    document.addEventListener(WAVEFORM_HIDDEN_EVENT, () => {
        if (showingFs || browserFs()) leaveFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) { showingFs = false; exitFsUI(); }
    });
    document.addEventListener('webkitfullscreenchange', () => {
        if (!document.webkitFullscreenElement) { showingFs = false; exitFsUI(); }
    });
}

const FIRST_PAINT_BUDGET_MS = 3000;

window.onload = async () => {
    setupFullscreen();

    const firstPaint = renderList().catch(err => {
        console.warn('The first list paint failed; it will be painted again after startup work:', err);
    });
    await Promise.race([firstPaint, new Promise(resolve => setTimeout(resolve, FIRST_PAINT_BUDGET_MS))]);
    await calcTotalStorage().catch(err => console.warn('Storage total failed:', err));

    (async () => {
        paintStartupNote('Checking for interrupted recordings... your notes are listed below and are safe.');
        let recovery = { deferred: 0 };
        try { recovery = await recoverIncompleteRecordings(); }
        catch (e) { console.warn('recovery failed:', e); }
        try { await finishInterruptedDeletions(); }
        catch (e) { console.warn('finishing interrupted deletions failed:', e); }
        try { await cleanupOrphanWavChunks(); } catch (e) { console.warn('orphan sweep failed:', e); }
        try { await cleanupOrphanLiveTranscripts(); }
        catch (e) { console.warn('live transcript sweep failed:', e); }
        try { await cleanupOrphanAudio(); }
        catch (e) { console.warn('orphan audio sweep failed:', e); }
        try { await cleanupOrphanCaptureBeats(); }
        catch (e) { console.warn('capture beat sweep failed:', e); }
        paintStartupNote('');
        await renderList();

        try { await runRetentionSweep(); } catch (e) { console.warn('retention sweep failed:', e); }

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
