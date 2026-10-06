import { CONFIG, getSetting } from './config.js';
import { dbExec, dbUpdate }  from './db.js';
import { transcribeChunked } from './transcribe.js';
import { runSummary } from './reply.js';
import { CANCELLED } from './jobs.js';
import {
    liveLogClear, replyStreamInit, openLiveLogTab, openReplyStreamTab,
    showLiveStatus, updateLiveStatus, removeLiveStatus
} from './live-tabs.js';

let _renderList = async () => {};
export function setAutoRenderList(fn) { _renderList = fn; }

function getRecFilename(recId) {
    const el = document.querySelector(`#rec-${recId} .rec-filename`);
    return el ? el.textContent.trim() : `Recording #${recId}`;
}

const isAbort = error => error && error.name === 'AbortError';

export async function runAutoPipeline(recId) {
    if (getSetting('set-auto-transcribe') !== 'on') {
        await _renderList();
        return 'skipped';
    }

    let outcome = 'done';
    try {
        await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec) return null;
            delete rec.pipelineError;
            delete rec.pipelineErrorAt;
            return rec;
        });
        await _renderList();
        await runAutoTranscribe(recId);

        if (getSetting('set-auto-reply') === 'on') await runAutoReply(recId);
    } catch (error) {
        if (isAbort(error)) outcome = CANCELLED;
        else {
            outcome = 'failed';
            console.error('Auto pipeline error:', error);
            await dbUpdate(CONFIG.STORE_REC, recId, rec => {
                if (!rec) return null;
                rec.pipelineError = error && error.message ? error.message : String(error);
                rec.pipelineErrorAt = Date.now();
                return rec;
            });
        }
    } finally {
        await _renderList();
    }
    return outcome;
}

async function runAutoTranscribe(recId) {
    const button = document.getElementById(`btn-t-${recId}`);
    if (button) {
        button.disabled = true;
        button.dataset.busy = '1';
        button.classList.add('processing');
    }
    liveLogClear(recId);

    const buttonRow = document.getElementById(`scribe-btns-${recId}`);
    if (buttonRow) buttonRow.classList.add('is-hidden');

    const filename = getRecFilename(recId);
    showLiveStatus(recId, 'scribe', '📝 Transcribing…',
        () => openLiveLogTab(recId, filename),
        () => window.cancelRecJob(recId));

    try {
        await transcribeChunked(recId, text => {
            if (button) button.textContent = text;
            updateLiveStatus(recId, 'scribe', `📝 ${text}`);
        });
    } finally {
        if (button) {
            button.disabled = false;
            delete button.dataset.busy;
            button.classList.remove('processing');
            button.textContent = '📝 Scribe';
        }
        removeLiveStatus(recId, 'scribe');
        if (buttonRow) buttonRow.classList.remove('is-hidden');
    }
}

async function runAutoReply(recId) {
    const latestRec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const latestTId = ((latestRec && latestRec.transcripts) || [])[0]?.id ?? null;
    if (!latestTId) {
        console.warn('Auto-reply: no transcript for', recId);
        return;
    }

    await _renderList();
    const button = document.getElementById(`btn-s-${recId}`);
    replyStreamInit(recId);

    if (!button) {
        await runSummary(recId, () => {}, latestTId);
        await _renderList();
        return;
    }

    button.disabled = true;
    button.dataset.busy = '1';
    button.classList.add('processing');

    const buttonRow = document.getElementById(`reply-btns-${recId}`);
    if (buttonRow) buttonRow.classList.add('is-hidden');
    const replyPanel = document.getElementById(`reply-panel-${recId}`);
    const replyWrap  = document.getElementById(`sreply-wrap-${recId}`);
    if (replyPanel && (!replyWrap || replyWrap.style.display === 'none')) replyPanel.style.display = 'none';

    const filename = getRecFilename(recId);
    showLiveStatus(recId, 'reply', '🧠 Waiting for first token… (tap to watch)',
        () => openReplyStreamTab(recId, filename),
        () => window.cancelRecJob(recId));

    button.textContent = '⏳ Waiting...';

    try {
        await runSummary(recId, text => {
            if (text === '__first_token__') {
                button.textContent = '⚡ Streaming...';
                updateLiveStatus(recId, 'reply', '⚡ Streaming… (tap to watch)');
            } else {
                button.textContent = text;
            }
        }, latestTId);
    } finally {
        button.textContent = '🧠 Reply';
        button.disabled = false;
        delete button.dataset.busy;
        button.classList.remove('processing');
        removeLiveStatus(recId, 'reply');
        if (buttonRow) buttonRow.classList.remove('is-hidden');
        if (replyPanel) replyPanel.style.display = '';
    }
    await _renderList();
}
