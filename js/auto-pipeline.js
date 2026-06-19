/* ==========================================================================
 *  auto-pipeline.js — Post-recording automation (auto-transcribe → auto-reply)
 *  ========================================================================== */
import { CONFIG, getSetting } from './config.js';
import { dbExec }            from './db.js';
import { transcribeChunked } from './transcribe.js';
import { runLocalSummary, runRemoteSummary } from './reply.js';
import {
    liveLogClear, replyStreamInit, openLiveLogTab, openReplyStreamTab,
    showLiveStatus, updateLiveStatus, removeLiveStatus
} from './live-tabs.js';

// renderList is injected to avoid circular dependency
let _renderList = async () => {};
export function setAutoRenderList(fn) { _renderList = fn; }

function getRecFilename(recId) {
    const el = document.querySelector(`#rec-${recId} .rec-filename`);
    return el ? el.textContent.trim() : `Recording #${recId}`;
}

const isAbort = e => e && e.name === 'AbortError';

/**
 * Fires after a new recording's WAV is finalized.
 * Checks settings for auto-transcribe / auto-reply and runs them in sequence.
 */
export async function runAutoPipeline(recId) {
    const autoT = getSetting('set-auto-transcribe');
    if (autoT === 'none') { await _renderList(); return; }

    try {
        await _renderList();
        await runAutoTranscribe(recId, autoT);

        const autoR = getSetting('set-auto-reply');
        if (autoR !== 'none') await runAutoReply(recId, autoR);
    } catch (e) {
        if (!isAbort(e)) console.error('Auto pipeline error:', e);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Auto-transcribe step
 *  ────────────────────────────────────────────────────────────────────────── */
async function runAutoTranscribe(recId, mode) {
    const tBtnId = mode === 'local' ? `btn-t-l-${recId}` : `btn-t-r-${recId}`;
    const tBtn   = document.getElementById(tBtnId);

    if (tBtn) { tBtn.dataset.busy = '1'; tBtn.classList.add('processing'); }
    liveLogClear(recId);

    // Hide the scribe button row — live-status bar replaces it
    const scribeBtnRow = document.getElementById(`scribe-btns-${recId}`);
    if (scribeBtnRow) scribeBtnRow.style.display = 'none';

    const filename = getRecFilename(recId);
    showLiveStatus(recId, 'scribe', '📝 Transcribing…',
        () => openLiveLogTab(recId, filename),
        () => window.cancelRecJob(recId));

    try {
        await transcribeChunked(recId, mode === 'local' ? 'local' : 'remote', txt => {
            if (tBtn) tBtn.textContent = txt;
            updateLiveStatus(recId, 'scribe', `📝 ${txt}`);
        });
    } finally {
        if (tBtn) { delete tBtn.dataset.busy; tBtn.classList.remove('processing'); }
        removeLiveStatus(recId, 'scribe');
        if (scribeBtnRow) scribeBtnRow.style.display = '';
    }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Auto-reply step
 *  ────────────────────────────────────────────────────────────────────────── */
async function runAutoReply(recId, mode) {
    const isLocal = mode === 'local';
    const rFunc   = isLocal ? runLocalSummary : runRemoteSummary;
    const rLabel  = isLocal ? '💻 Reply' : '☁️ Reply';
    const rBtnId  = isLocal ? `btn-s-l-${recId}` : `btn-s-r-${recId}`;

    const latestRec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const latestTId = (latestRec.transcripts || [])[0]?.id ?? null;
    if (!latestTId) { console.warn('Auto-reply: no transcript for', recId); return; }

    await _renderList();
    const rBtn = document.getElementById(rBtnId);
    replyStreamInit(recId);

    if (!rBtn) {
        try { await rFunc(recId, () => {}, latestTId); } catch (e) { if (!isAbort(e)) throw e; }
        await _renderList();
        return;
    }

    rBtn.dataset.busy = '1';
    rBtn.classList.add('processing');

    const replyBtnRow = document.getElementById(`reply-btns-${recId}`);
    if (replyBtnRow) replyBtnRow.style.display = 'none';

    const filename = getRecFilename(recId);
    showLiveStatus(recId, 'reply', '🧠 Waiting for first token… (tap to watch)',
        () => openReplyStreamTab(recId, filename),
        () => window.cancelRecJob(recId));

    rBtn.textContent = '⏳ Waiting...';

    try {
        await rFunc(recId, txt => {
            if (txt === '__first_token__') {
                rBtn.textContent = '⚡ Streaming...';
                updateLiveStatus(recId, 'reply', '⚡ Streaming… (tap to watch)');
            } else {
                rBtn.textContent = txt;
            }
        }, latestTId);
    } catch (e) {
        if (!isAbort(e)) throw e;
    } finally {
        rBtn.textContent = rLabel;
        delete rBtn.dataset.busy;
        rBtn.classList.remove('processing');
        removeLiveStatus(recId, 'reply');
        if (replyBtnRow) replyBtnRow.style.display = '';
    }
    await _renderList();
}
