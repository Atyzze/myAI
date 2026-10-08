import { CONFIG, fmtDur, fmtSize, fmtBytes, uid, escapeHtml, escapeAttr, getSetting } from './config.js';
import { dbExec, dbUpdate, getRecordingsPage, getStorageTotal, calcTotalStorage,
         readAudio, commitAudio, recordingPosition, readCaptureBeats } from './db.js';
import { displayTitle, buildDownloadName, storagePct, contextStats } from './naming.js';
import { recordingExt, storedFormat, needsConversion, pickOpusMime, conversionStillApplies } from './audio-format.js';
import { inspectPcmWav } from './audio.js';
import { makeWebmSeekable, needsSeekableUpgrade, WEBM_SEEKABLE_VERSION } from './webm-duration.js';
import { isLivePlayerId, shouldRewindOnEnded, resolvePlayerTotalSec, playerFraction,
         planLivePreview } from './player-core.js';
import { planRender } from './render-defer.js';
import { hasJob, cancelJob } from './jobs.js';
import { describeFillProgress } from './transcribe-core.js';
import { PAGINATION_BARS, paginationBarVisible } from './pagination-core.js';
import { pickSelection, rememberSelection } from './selection-core.js';
import { transcribeChunked }         from './transcribe.js';
import { runSummary } from './reply.js';
import {
    liveLogClear, openLiveLogTab, openReplyStreamTab, replyStreamInit,
    showLiveStatus, updateLiveStatus, removeLiveStatus, liveStatusText
} from './live-tabs.js';
import { AppState, startRecording, buildLivePreviewBlob, describeLiveContext } from './recorder.js';
import { isCompact, noticeInterruptedDeletion } from './settings.js';
import { retentionMs, planRecordRetention, fmtRetentionRemaining, setPinned } from './retention-core.js';
import { isRecordOwnedByLiveTab, isFreshHeartbeat } from './recording-lock.js';
import { unfinishedRowState, ROW_ACTION_LABELS, liveHolesToFill, keyActivates } from './row-state-core.js';

const UI = {
    list:    document.getElementById('recordingsList'),
    btn:     document.getElementById('recordBtn'),
    curPage: 0
};

export function resetListToFirstPage() { UI.curPage = 0; }

const _objectUrls = new Map();
let _attachedAudio = null;
function revokeAllObjectUrls({ except = null } = {}) {
    for (const [recId, url] of [..._objectUrls]) {
        if (except != null && Number(recId) === Number(except)) continue;
        try { URL.revokeObjectURL(url); } catch (_) {}
        _objectUrls.delete(recId);
    }
    if (except == null) detachAudioSource();
}

function audioToKeepAcrossRepaint() {
    const audio = _attachedAudio;
    if (!audio || !audio.isConnected || !audio.src) return null;
    const recId = Number(audio.dataset.recAudio);
    return Number.isFinite(recId) ? { recId, audio } : null;
}

function moveKeptAudioIntoRebuiltRow(fragment, kept) {
    const fresh = kept && fragment.querySelector(`audio[data-rec-audio="${kept.recId}"]`);
    if (!fresh) return false;
    fresh.replaceWith(kept.audio);
    const playerEl = kept.audio.closest('.player');
    if (playerEl) {
        const loop = playerEl.querySelector('.player-loop');
        if (loop) {
            loop.classList.toggle('active', !!kept.audio.loop);
            loop.setAttribute('aria-pressed', String(!!kept.audio.loop));
        }
        paintPlayer(playerEl);
    }
    return true;
}

function titleEditToKeepAcrossRepaint() {
    const input = UI.list && UI.list.querySelector('.rec-title-input');
    if (!input || !input._recId || input._done) return null;
    const focused = document.activeElement === input;
    return { recId: input._recId, input, focused, start: input.selectionStart, end: input.selectionEnd };
}

function moveTitleEditIntoRebuiltRow(fragment, kept) {
    const span = kept && fragment.querySelector(`.rec-filename[data-edit-title][data-rec="${kept.recId}"]`);
    if (!span) return false;
    kept.input._moving = true;
    span.replaceWith(kept.input);
    return true;
}

function refocusMovedTitleEdit(kept) {
    if (!kept || !kept.input.isConnected) return;
    kept.input._moving = false;
    if (kept.focused) {
        kept.input.focus();
        try { kept.input.setSelectionRange(kept.start, kept.end); } catch (_) {}
    }
}

const linkSet = new Map();

function updateLinkButton(recId) {
    const btn = document.getElementById(`btn-link-${recId}`);
    if (!btn) return;
    const on = linkSet.has(recId);
    btn.classList.toggle('linked', on);
    btn.textContent = on ? '✅ Linked' : '➕ Link';
}

function renderLinkTray() {
    const tray = document.getElementById('link-tray');
    if (!tray) return;
    if (linkSet.size === 0 || AppState.recId != null) { tray.className = ''; tray.innerHTML = ''; return; }

    const n = linkSet.size;
    const chips = [...linkSet.entries()].map(([id, ts]) =>
        `<button class="link-chip" data-action="removeLinkedRec" data-rec-id="${id}" title="Remove from the link set">${escapeHtml(ts || ('#' + id))} <span class="link-chip-x">✕</span></button>`
    ).join('');

    tray.innerHTML = `
    <div class="link-tray-head">
    <span class="link-tray-title">🔗 ${n} recording${n > 1 ? 's' : ''} linked</span>
    <button class="link-tray-clear" data-action="clearLinkedRecs">Clear</button>
    </div>
    <div class="link-chips">${chips}</div>
    <button class="link-tray-go" data-action="recordFromLinked" title="Start a new recording pre-loaded with these as context">🎙️ Record reply from ${n} linked</button>`;
    tray.className = 'show';
}

const LIVE_TAIL_SEC   = 1.6;
let _liveTimer     = null;
let _liveUrl       = null;
let _liveSnapSeq   = -1;
let _liveBuilding  = false;

let _liveEpoch = 0;

function stopLivePreview() {
    _liveEpoch++;
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
    if (_liveUrl) { try { URL.revokeObjectURL(_liveUrl); } catch (_) {} _liveUrl = null; }
    _liveSnapSeq   = -1;
    _liveBuilding  = false;
}

function liveChunkCount() {
    return AppState.recFormat === 'opus' ? (AppState.opusSeq || 0) : (AppState.wavSeq || 0);
}

async function _rebuildLiveSnapshot(recId, audio, resume) {
    if (_liveBuilding) return;
    _liveBuilding = true;
    const epochAtBuild = _liveEpoch;
    try {
        const seqAtBuild = liveChunkCount();
        const blob = await buildLivePreviewBlob(recId);
        if (!blob || AppState.recId !== recId) return;
        if (_liveEpoch !== epochAtBuild) return;
        _liveSnapSeq   = seqAtBuild;

        const resumeAt = audio.currentTime || 0;
        const prevUrl  = _liveUrl;
        const url      = URL.createObjectURL(blob);
        _liveUrl = url;

        audio.addEventListener('loadedmetadata', () => {
            if (resumeAt > 0 && (!isFinite(audio.duration) || resumeAt <= audio.duration)) {
                try { audio.currentTime = resumeAt; } catch (_) {}
            }
            if (resume) audio.play().catch(() => {});
            const pl = audio.closest('.player'); if (pl) paintPlayer(pl);
        }, { once: true });

        audio.src = url;
        audio.load();
        if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch (_) {} }
    } finally {
        _liveBuilding = false;
    }
}

async function _liveTick(recId) {
    if (AppState.recId !== recId) { stopLivePreview(); return; }

    const audio = document.getElementById(`live-audio-${recId}`);
    if (!audio) { stopLivePreview(); return; }
    const playerEl = audio.closest('.player');

    const dur = (isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : Math.max(0, _liveSnapSeq) * CONFIG.IO_FLUSH_SEC;
    const hasNewChunk = liveChunkCount() > _liveSnapSeq;
    const playing     = !audio.paused && !audio.ended;

    const midPause = audio.paused && !audio.ended && audio.currentTime > 0;
    if (playerEl && AppState.startTime) {
        playerEl.dataset.dur = midPause
            ? String(Math.round(dur * 1000))
            : String(Date.now() - AppState.startTime);
    }
    if (playerEl) paintPlayer(playerEl);

    const hint = document.getElementById(`live-hint-${recId}`);
    if (hint && !_liveBuilding) {
        hint.textContent = liveChunkCount() > 0
            ? '▶ replay captured so far'
            : `⏱️ capturing first ${CONFIG.IO_FLUSH_SEC}s…`;
    }

    const plan = planLivePreview({
        playing,
        ended:       audio.ended,
        hasNewChunk,
        nearEdge:    dur > 0 && (dur - audio.currentTime) <= LIVE_TAIL_SEC,
        loaded:      _liveSnapSeq >= 0
    });
    if (plan.rebuild) await _rebuildLiveSnapshot(recId, audio, plan.resume);
}

function playLivePreview(audio) {
    const recId = AppState.recId;
    if (recId == null || audio.id !== `live-audio-${recId}`) return;

    const plan = planLivePreview({
        requested:   true,
        loaded:      _liveSnapSeq >= 0,
        hasNewChunk: liveChunkCount() > _liveSnapSeq
    });
    if (!plan.rebuild) { audio.play().catch(() => {}); return; }

    const hint = document.getElementById(`live-hint-${recId}`);
    if (hint) hint.textContent = '⏳ preparing replay…';
    Promise.resolve(_rebuildLiveSnapshot(recId, audio, plan.resume))
        .catch(err => console.warn('Live preview build failed:', err));
}

const _tick = (recId) => Promise.resolve(_liveTick(recId))
    .catch(err => console.warn('Live preview tick failed:', err));

function startLivePreview(recId) {
    stopLivePreview();
    _tick(recId);
    _liveTimer = setInterval(() => _tick(recId), 1000);
}

if (UI.list && !UI.list._keyActivateWired) {
    UI.list._keyActivateWired = true;
    UI.list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        if (e.defaultPrevented) return;
        const t = e.target;
        if (t && t.matches && t.matches('.sel-preview, .context-item-title')) {
            e.preventDefault();
            t.click();
        }
    });
}

const SEEK_PROBE_MAX_MS = 90 * 60 * 1000;

if (UI.list && !UI.list._seekFixWired) {
    UI.list._seekFixWired = true;
    UI.list.addEventListener('loadedmetadata', (e) => {
        const a = e.target;
        if (!a || a.tagName !== 'AUDIO') return;
        if (isLivePlayerId(a.id)) return;
        if (isFinite(a.duration) && a.duration > 0) return;
        if (a._durationFixed) return;
        const knownMs = Number(a.closest('.player')?.dataset.dur) || 0;
        if (knownMs > SEEK_PROBE_MAX_MS) return;
        a._durationFixed = true;
        const onSeeked = () => {
            a.removeEventListener('seeked', onSeeked);
            try { a.currentTime = 0; } catch (_) {}
        };
        a.addEventListener('seeked', onSeeked);
        try { a.currentTime = 1e101; } catch (_) {}
    }, true);
}

function playerTotalSec(playerEl) {
    const audio = playerEl.querySelector('audio');
    return resolvePlayerTotalSec(playerEl.dataset.dur, audio ? audio.duration : NaN);
}

function paintPlayer(playerEl) {
    const audio = playerEl.querySelector('audio');
    if (!audio) return;
    const total = playerTotalSec(playerEl);
    const cur   = total > 0 ? Math.min(audio.currentTime || 0, total) : (audio.currentTime || 0);
    const pct   = (playerFraction(audio.currentTime, total) * 100).toFixed(2) + '%';
    const fill  = playerEl.querySelector('.player-fill');
    const thumb = playerEl.querySelector('.player-thumb');
    const time  = playerEl.querySelector('.player-time');
    const btn   = playerEl.querySelector('.player-play');
    const scrub = playerEl.querySelector('.player-scrub');
    if (fill)  fill.style.width = pct;
    if (thumb) thumb.style.left = pct;
    if (time)  time.textContent = `${fmtDur(cur * 1000)} / ${fmtDur(total * 1000)}`;
    if (btn)   btn.textContent  = audio.paused ? '▶' : '⏸';
    if (scrub) {
        scrub.setAttribute('aria-valuemin', '0');
        scrub.setAttribute('aria-valuemax', String(Math.round(total)));
        scrub.setAttribute('aria-valuenow', String(Math.round(cur)));
        scrub.setAttribute('aria-valuetext', `${fmtDur(cur * 1000)} of ${fmtDur(total * 1000)}`);
    }
}

function detachAudioSource() {
    const previous = _attachedAudio;
    _attachedAudio = null;
    if (!previous) return;
    try { previous.pause(); } catch (_) {}
    try { previous.removeAttribute('src'); previous.load(); } catch (_) {}
}

async function attachAudioSource(audio) {
    if (audio.src) return true;
    const recId = Number(audio.dataset.recAudio);
    if (!Number.isFinite(recId)) return false;
    const blob = await readAudio(recId);
    if (!blob) {
        alert('Audio for this recording is no longer available.');
        return false;
    }
    detachAudioSource();
    revokeAllObjectUrls();
    const url = URL.createObjectURL(blob);
    _objectUrls.set(recId, url);
    audio.src = url;
    _attachedAudio = audio;
    return true;
}

function wirePlayerAudio(playerEl) {
    const audio = playerEl.querySelector('audio');
    if (!audio || audio._playerBound) return;
    audio._playerBound = true;
    const paintPlayerHoldingThisAudio = () => { const current = audio.closest('.player'); if (current) paintPlayer(current); };
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange']
        .forEach(ev => audio.addEventListener(ev, paintPlayerHoldingThisAudio));
    audio.addEventListener('ended', () => {
        if (shouldRewindOnEnded(audio.id, audio.loop)) { try { audio.currentTime = 0; } catch (_) {} }
        paintPlayerHoldingThisAudio();
    });
}

function seekPlayerTo(playerEl, clientX) {
    const audio = playerEl.querySelector('audio');
    const track = playerEl.querySelector('.player-track');
    if (!audio || !track) return;
    const rect = track.getBoundingClientRect();
    const frac = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    const total = playerTotalSec(playerEl);
    if (total > 0) { try { audio.currentTime = frac * total; } catch (_) {} }
    paintPlayer(playerEl);
}

if (UI.list && !UI.list._playerWired) {
    UI.list._playerWired = true;

    UI.list.addEventListener('click', (e) => {
        const loopBtn = e.target.closest && e.target.closest('.player-loop');
        if (loopBtn) {
            const pl = loopBtn.closest('.player');
            const a  = pl && pl.querySelector('audio');
            if (!a) return;
            a.loop = !a.loop;
            loopBtn.classList.toggle('active', a.loop);
            loopBtn.setAttribute('aria-pressed', String(a.loop));
            return;
        }

        const btn = e.target.closest && e.target.closest('.player-play');
        if (!btn) return;
        const playerEl = btn.closest('.player');
        const audio = playerEl && playerEl.querySelector('audio');
        if (!audio) return;
        wirePlayerAudio(playerEl);
        if (audio.paused) {
            UI.list.querySelectorAll('.player audio').forEach(a => { if (a !== audio && !a.paused) a.pause(); });
            if (isLivePlayerId(audio.id)) { playLivePreview(audio); return; }
            attachAudioSource(audio)
                .then(ready => { if (ready) audio.play().catch(() => {}); })
                .catch(() => {});
        } else {
            audio.pause();
        }
    });

    let dragging = null;
    UI.list.addEventListener('pointerdown', (e) => {
        const scrub = e.target.closest && e.target.closest('.player-scrub');
        if (!scrub) return;
        dragging = scrub.closest('.player');
        wirePlayerAudio(dragging);
        seekPlayerTo(dragging, e.clientX);
        try { scrub.setPointerCapture(e.pointerId); } catch (_) {}
    });
    UI.list.addEventListener('pointermove', (e) => { if (dragging) seekPlayerTo(dragging, e.clientX); });
    const endDrag = () => { dragging = null; };
    UI.list.addEventListener('pointerup', endDrag);
    UI.list.addEventListener('pointercancel', endDrag);

    UI.list.addEventListener('keydown', (e) => {
        const scrub = e.target.closest && e.target.closest('.player-scrub');
        if (!scrub) return;
        const playerEl = scrub.closest('.player');
        const audio = playerEl && playerEl.querySelector('audio');
        if (!audio) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            wirePlayerAudio(playerEl);
            const total = playerTotalSec(playerEl);
            const delta = e.key === 'ArrowRight' ? 5 : -5;
            try { audio.currentTime = Math.max(0, Math.min(total || audio.currentTime, (audio.currentTime || 0) + delta)); } catch (_) {}
            paintPlayer(playerEl);
        }
    });
}

function startTitleEdit(span) {
    if (!span || span.dataset.editing) return;
    const id      = span.dataset.rec;
    const current = span.textContent;
    span.dataset.editing = '1';

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'rec-title-input';
    input.value       = current;
    input._recId      = id;
    input.setAttribute('aria-label', 'Recording title');
    span.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        input._done = true;
        if (save) window.saveRecTitle(id, input.value);
        else      renderList({ force: true });
    };
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => { if (!input._moving) finish(true); });
}

if (UI.list && !UI.list._titleEditWired) {
    UI.list._titleEditWired = true;
    UI.list.addEventListener('click', (e) => {
        const span = e.target.closest && e.target.closest('.rec-filename[data-edit-title]');
        if (span) startTitleEdit(span);
    });
    UI.list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        const span = e.target.closest && e.target.closest('.rec-filename[data-edit-title]');
        if (span) { e.preventDefault(); startTitleEdit(span); }
    });
}

let _pendingRender = false;
let _pendingRenderTimer = null;

function _playingAudios() {
    return [...UI.list.querySelectorAll('audio')].filter(a => !a.paused && !a.ended);
}

const DEFERRED_RENDER_RECHECK_MS = 1000;

function _clearDeferredRender() {
    if (_pendingRenderTimer) { clearTimeout(_pendingRenderTimer); _pendingRenderTimer = null; }
    _pendingRender = false;
}

export async function renderList({ force = false } = {}) {
    const playing = force ? [] : _playingAudios();
    const plan = planRender({
        playingAudioCount: playing.length,
        force,
        deferralPending: _pendingRender
    });

    if (plan.defer) {
        if (!plan.armRecheck) return;
        _pendingRender = true;
        const onStop = () => {
            playing.forEach(a => {
                a.removeEventListener('pause', onStop);
                a.removeEventListener('ended', onStop);
            });
            _clearDeferredRender();
            renderList();
        };
        playing.forEach(a => {
            a.addEventListener('pause', onStop);
            a.addEventListener('ended', onStop);
        });
        _pendingRenderTimer = setTimeout(onStop, DEFERRED_RENDER_RECHECK_MS);
        return;
    }
    _clearDeferredRender();
    await _renderListNow();
}

let _captureBeats = new Map();

async function _renderListNow() {
    const { page, total, totalPages, pageIndex } = await getRecordingsPage(UI.curPage, CONFIG.PAGE_SIZE);
    UI.curPage = pageIndex;
    _captureBeats = page.some(rec => rec && rec.processing && rec.id !== AppState.recId)
        ? await readCaptureBeats() : new Map();

    const keptAudio = audioToKeepAcrossRepaint();
    const keptTitle = titleEditToKeepAcrossRepaint();
    revokeAllObjectUrls({ except: keptAudio ? keptAudio.recId : null });
    stopLivePreview();

    const fragment = document.createDocumentFragment();
    for (const rec of page) {
        noticeInterruptedDeletion(rec);
        try {
            fragment.append(buildRecordingItem(rec));
        } catch (err) {
            console.error(`Could not render recording ${rec && rec.id}:`, err);
            const li = document.createElement('li');
            li.className = 'rec-item';
            li.id = `rec-${rec && rec.id}`;
            li.innerHTML = `<div class="rec-error" role="alert">This recording could not be displayed (${escapeHtml(err && err.message ? err.message : String(err))}). Its audio and text are still stored; reload to try again.</div>
            <div class="bottom-actions"><button class="action-btn btn-delete" data-action="deleteRec" data-rec-id="${rec && rec.id}" title="Delete" aria-label="Delete recording">🗑️</button></div>`;
            fragment.append(li);
        }
    }
    if (keptAudio && !moveKeptAudioIntoRebuiltRow(fragment, keptAudio)) revokeAllObjectUrls();
    if (keptTitle) moveTitleEditIntoRebuiltRow(fragment, keptTitle);
    UI.list.replaceChildren(fragment);
    refocusMovedTitleEdit(keptTitle);
    for (const rec of page) restoreRunningJobStatus(rec);

    renderPagination(total, totalPages);

    if (AppState.recId != null && document.getElementById(`live-audio-${AppState.recId}`)) {
        startLivePreview(AppState.recId);
    }

    renderLinkTray();
}

function restoreRunningJobStatus(rec) {
    if (!rec || rec.id == null) return;
    if (hasJob('t', rec.id)) {
        showLiveStatus(rec.id, 'scribe', '\u{1F4DD} Working\u2026 (tap to watch)',
            () => openLiveLogTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));
    }
    if (hasJob('r', rec.id)) {
        showLiveStatus(rec.id, 'reply', '\u{1F9E0} Working\u2026 (tap to watch)',
            () => openReplyStreamTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));
    }
    // The translations finished after a recording: the bar comes back as it was, and its ✕ stops
    // only them, not a transcription or reply of the same recording.
    if (hasJob('f', rec.id)) {
        showLiveStatus(rec.id, 'translate', liveStatusText(rec.id, 'translate') || describeFillProgress(null),
            null, () => cancelJob('f', rec.id));
    }
}

function markButtonBusy(button, row, label) {
    button.disabled = true;
    button.dataset.busy = '1';
    button.classList.add('processing');
    button.textContent = label;
    if (row) row.classList.add('is-hidden');
}

function buildRecordingItem(rec) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    li.id = `rec-${rec.id}`;

    const audioBytes = Number(rec.audioBytes) || 0;
    const hasAudio = audioBytes > 0;

    const allT = rec.transcripts || [];
    allT.forEach((t) => { if (!t.id) t.id = t.time || uid(); });
    const allS = rec.summaries || [];
    allS.forEach((s) => {
        if (!s.id) s.id = s.time || uid();
        if (!s.transcriptId && allT.length) s.transcriptId = allT[0].id;
    });

    const hasTranscripts = allT.length > 0;
    const hasReplies     = allS.length > 0;
    const compact        = isCompact();
    const safeName       = escapeHtml(displayTitle(rec));
    const liveContextCount = (rec.contextChain || (rec.context ? [rec.context] : [])).length;

    if (rec.processing) {
        const now = Date.now();
        const beat = _captureBeats.get(Number(rec.id));
        const state = unfinishedRowState(rec, {
            liveHere: AppState.recId != null && rec.id === AppState.recId,
            savingHere: AppState.savingId != null && Number(AppState.savingId) === Number(rec.id),
            captureErrorHere: !!AppState.captureError,
            ownedByLiveTab: isRecordOwnedByLiveTab(rec, now, beat),
            beat,
            finalizerFresh: !!rec.finalizerId && isFreshHeartbeat(rec.finalizerHeartbeatAt, now)
        });
        if (state.live) li.classList.add('rec-item-live');
        const buttons = state.actions.length
            ? `<div class="btn-row">${state.actions.map(action =>
                `<button class="action-btn${action === 'deleteRec' ? ' btn-delete' : ''}" data-action="${action}" data-rec-id="${rec.id}">${ROW_ACTION_LABELS[action]}</button>`).join('')}</div>`
            : '';
        if (state.kind === 'saving') {
            li.innerHTML = `<div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> `
                + `<span style="color:#ffc107">💾 ${state.here ? 'Saving…' : 'Saving in another tab…'}</span></div>`;
            return li;
        }
        if (state.kind === 'other-tab') {
            li.innerHTML = `
            <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span class="live-rec-clock other-tab-live-clock" data-rec-id="${rec.id}">${fmtDur(rec.durationMs || 0)}</span> <span class="live-rec-badge"><span class="dot"></span>LIVE · OTHER TAB</span></div>
            <div class="live-rec-meta"><span style="opacity:.7">This recording is protected by the global lock. Stop it in the tab that owns the microphone.</span></div>`;
            return li;
        }
        if (state.kind === 'save-failed') {
            li.innerHTML = `
            <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span></div>
            <div class="rec-error" role="alert">Finalization failed: ${escapeHtml(rec.finalizationError || 'Unknown error')}</div>
            ${buttons}`;
            return li;
        }
        if (state.kind === 'recovering') {
            li.innerHTML = `<div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span style="color:#ffc107">⏳ Recovering recording...</span></div>`;
            return li;
        }
        if (state.kind === 'interrupted') {
            li.innerHTML = `
            <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span style="color:#ffc107">⏳ Interrupted, waiting to be recovered</span></div>
            <div class="live-rec-meta"><span style="opacity:.7">The tab that recorded this stopped before saving it. It is recovered from the pieces it stored.</span></div>
            ${buttons}`;
            return li;
        }
        if (state.kind === 'capture-error') {
            li.classList.add('rec-item-capture-error');
            li.innerHTML = `
            <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span class="live-rec-clock" id="live-clock-${rec.id}">${fmtDur(Math.max(0, Date.now() - AppState.startTime))}</span> <span class="live-rec-badge"><span class="dot"></span>ERROR · STOPPING</span></div>
            <div class="live-rec-meta" role="alert">Capture has stopped after an audio-storage error. Saving recoverable audio now…</div>`;
            return li;
        }
        li.innerHTML = `
        <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span class="live-rec-clock" id="live-clock-${rec.id}">${fmtDur(Math.max(0, Date.now() - AppState.startTime))}</span> <span class="live-rec-badge"><span class="dot"></span>LIVE</span></div>
        <div class="rec-player rec-player-live"><div class="player" data-dur="0">
          <audio id="live-audio-${rec.id}" preload="metadata"></audio>
          <div class="player-main">
            <button class="player-play" aria-label="Play / pause">▶</button>
            <div class="player-scrub" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="player-track"><div class="player-fill"></div><div class="player-thumb"></div></div></div>
            <span class="player-time">${fmtDur(0)} / ${fmtDur(0)}</span>
          </div>
        </div></div>
        <div class="live-rec-meta live-rec-context" id="live-context-${rec.id}"${liveContextCount ? '' : ' hidden'}>${escapeHtml(describeLiveContext(liveContextCount))}</div>
        <div class="live-rec-meta"><span id="live-hint-${rec.id}" style="opacity:.55">⏱️ capturing first ${CONFIG.IO_FLUSH_SEC}s…</span></div>`;
        return li;
    }

    const size       = audioBytes;
    const pct        = storagePct(size, getStorageTotal());
    const pctLabel   = pct < 10 ? pct.toFixed(1) : Math.round(pct);
    const storageBar = hasAudio ? `
    <div class="rec-storage" title="${fmtBytes(size)} - ${pctLabel}% of all audio stored">
      <div class="rec-storage-track"><div class="rec-storage-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <span class="rec-storage-label">${fmtBytes(size)} · ${pctLabel}%</span>
    </div>` : '';

    const retention = planRecordRetention(rec, {
        now: Date.now(),
        audioMs: retentionMs(getSetting('set-retention-audio')),
        textMs:  retentionMs(getSetting('set-retention-text'))
    });
    // A pinned recording's countdown is frozen where it stood: the same numbers, iced, and never "soon".
    const frozen = retention.pinned;
    const expiryParts = [];
    if (retention.audioExpiresInMs != null) {
        expiryParts.push(frozen
            ? `<span title="Frozen: this recording is pinned, so its audio is not deleted automatically. Unpin it and the countdown runs on from here.">❄️ audio ${escapeHtml(fmtRetentionRemaining(retention.audioExpiresInMs))}</span>`
            : `<span class="${retention.audioExpiresInMs <= 24 * 3600 * 1000 ? 'soon' : ''}" title="Audio is deleted automatically when this reaches zero. Pin the recording (📌) to stop the countdown, or download it.">⏳ audio ${escapeHtml(fmtRetentionRemaining(retention.audioExpiresInMs))}</span>`);
    }
    if (retention.textExpiresInMs != null) {
        expiryParts.push(frozen
            ? `<span title="Frozen: this recording is pinned, so its transcripts and replies are not deleted automatically. Unpin it and the countdown runs on from here.">❄️ text ${escapeHtml(fmtRetentionRemaining(retention.textExpiresInMs))}</span>`
            : `<span class="${retention.textExpiresInMs <= 24 * 3600 * 1000 ? 'soon' : ''}" title="Transcripts and replies are deleted automatically when this reaches zero. Pin the recording (📌) to stop the countdown.">📝 text ${escapeHtml(fmtRetentionRemaining(retention.textExpiresInMs))}</span>`);
    }
    const expiryHtml = expiryParts.length ? `<div class="rec-expiry${frozen ? ' frozen' : ''}">${expiryParts.join('')}</div>` : '';
    // One row: the size bar on the left, the retention countdown in the room to its right. It wraps
    // below the bar only where the row is too narrow for both.
    const metaRowHtml = (storageBar || expiryHtml) ? `<div class="rec-meta">${storageBar}${expiryHtml}</div>` : '';

    const pref     = getSetting('set-recording-format');
    const recFmt   = storedFormat(rec);
    const fmtBadge = hasAudio
        ? (needsConversion(pref, rec)
            ? `<button class="fmt-badge fmt-convert" data-fmt-rec="${rec.id}" data-action="convertRecFormat" data-rec-id="${rec.id}" title="Stored as WAV. Tap to convert just this recording to ${pref.toUpperCase()} and reclaim space.">${recFmt.toUpperCase()} → ${pref.toUpperCase()}</button>`
            : `<span class="fmt-badge fmt-current" title="Stored as ${recFmt.toUpperCase()}">${recFmt.toUpperCase()}</span>`)
        : '';
    // Left of the format: the pin. It names the state a tap asks for, so a tab still showing an
    // older state cannot flip the pin the wrong way.
    const pinBtn = `<button class="pin-btn${frozen ? ' pinned' : ''}" data-action="pinRec" data-rec-id="${rec.id}" data-pin="${frozen ? '0' : '1'}" aria-pressed="${frozen}" aria-label="Pin recording" title="${frozen
        ? 'Pinned: the countdown below is frozen and nothing in this recording is deleted automatically. Tap to unpin; the countdown then runs on from where it stands.'
        : 'Pin: freeze the countdown below, so nothing in this recording is deleted automatically. Browser storage can still be cleared; only a download cannot be.'}">📌</button>`;

    const fillsGaps          = liveHolesToFill(allT);
    const showScribeButtons  = !compact || !hasTranscripts || fillsGaps;
    const showScribeSelector = !compact && hasTranscripts;
    const showReplyButtons   = !compact || (hasTranscripts && !hasReplies);

    const scribeButtonsHtml = showScribeButtons ? `
    <div class="btn-row" id="scribe-btns-${rec.id}">
    ${fillsGaps
        ? `<button class="action-btn btn-scribe" id="btn-t-${rec.id}" title="Transcribe the parts the live transcript missed">📝 Fill gaps</button>`
        : `<button class="action-btn btn-scribe" id="btn-t-${rec.id}" title="Transcribe with the configured server">📝 Scribe</button>`}
    </div>` : `
    <div class="btn-row is-hidden" id="scribe-btns-${rec.id}">
    <button class="action-btn btn-scribe" id="btn-t-${rec.id}">📝 Scribe</button>
    </div>`;

    const tScribeHtml = hasTranscripts ? buildTranscriptSelector(rec, allT, showScribeSelector) : '';

    const scribePanelHtml = (showScribeButtons || hasTranscripts) ? `
    <div class="action-panel">
    ${scribeButtonsHtml}
    ${tScribeHtml}
    </div>` : '';

    const replyPanelHtml = hasTranscripts ? buildReplyPanel(rec, showReplyButtons) : '';

    const contextChainHtml = buildContextChainHtml(rec);
    const pipelineErrorHtml = rec.pipelineError
        ? `<div class="rec-error" role="alert">Automatic AI step failed: ${escapeHtml(rec.pipelineError)}</div>`
        : '';
    const fillWarningHtml = rec.fillError
        ? `<div class="rec-warning" role="status">${escapeHtml(rec.fillError)}</div>`
        : '';
    const remuxWarningHtml = (hasAudio && rec.webmRemuxError)
        ? `<div class="rec-warning">No seek track could be written for this recording (${escapeHtml(rec.webmRemuxError)}). It plays and downloads in full, but desktop players may show no total length or seek bar.</div>`
        : '';
    const captureFailureReason = rec.captureError?.kind === 'quota'
        ? 'browser storage became full'
        : rec.captureError?.kind === 'microphone'
            ? 'the microphone input ended unexpectedly'
            : rec.captureError?.kind === 'encoder'
                ? 'the browser audio encoder failed'
                : 'an audio segment could not be written to browser storage';
    const captureWarningHtml = rec.captureError
        ? `<div class="${rec.incompleteAudio ? 'rec-error' : 'rec-warning'}" role="alert">${rec.incompleteAudio
            ? `Recording stopped because ${escapeHtml(captureFailureReason)}. ${Number(rec.unsavedFragmentCount || 0)} segment(s), ${fmtBytes(Number(rec.unsavedBytes || 0))}, could not be stored. Previously committed audio is available below.`
            : (rec.captureError.kind === 'quota' || rec.captureError.kind === 'storage'
                ? `Recording stopped because ${escapeHtml(captureFailureReason)}, but the failed segment was recovered before finalization.`
                : `Recording stopped because ${escapeHtml(captureFailureReason)}. Audio captured before the failure was saved successfully.`)}</div>`
        : '';

    const recordingNow = AppState.recId != null;
    const continueBtn = hasTranscripts
        ? `<button class="action-btn btn-continue" id="btn-continue-${rec.id}" data-action="continueConv" data-rec-id="${rec.id}"${recordingNow ? ' disabled' : ''} title="${recordingNow ? 'Stop the current recording to continue this conversation' : 'Continue conversation'}" aria-label="Continue conversation">💬</button>`
        : '';
    const linked  = linkSet.has(rec.id);
    const linkBtn = hasTranscripts
        ? `<button class="action-btn btn-link${linked ? ' linked' : ''}" id="btn-link-${rec.id}" data-action="toggleLinkRec" data-rec-id="${rec.id}" data-link-label="${escapeAttr((rec.filename || '').split(' - ')[0])}" title="${linked ? 'Linked (in the link set)' : 'Link (add to the link set)'}" aria-label="${linked ? 'Linked' : 'Link recording'}">${linked ? '✅' : '🔗'}</button>`
        : '';

    li.innerHTML = `
    <div class="rec-top"><span class="rec-filename" role="button" tabindex="0" data-edit-title data-rec="${rec.id}" title="Click to rename this recording">${safeName}</span><span class="rec-top-tools">${pinBtn}${fmtBadge}</span></div>
    ${metaRowHtml}
    ${hasAudio ? `<div class="rec-player"><div class="player" data-dur="${rec.durationMs || 0}">
      <audio data-rec-audio="${rec.id}" preload="none"></audio>
      <div class="player-main">
        <button class="player-play" aria-label="Play / pause">▶</button>
        <div class="player-scrub" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="${Math.round((rec.durationMs || 0) / 1000)}" aria-valuenow="0"><div class="player-track"><div class="player-fill"></div><div class="player-thumb"></div></div></div>
        <span class="player-time">${fmtDur(0)} / ${fmtDur(rec.durationMs || 0)}</span>
      </div>
      <div class="player-tools">
        <button class="player-del" data-action="deleteRecAudio" data-rec-id="${rec.id}" title="Delete this recording's audio and keep its text" aria-label="Delete audio, keep transcripts">🗑️</button>
        <button class="player-dl" data-action="downloadRec" data-rec-id="${rec.id}" title="Download (the only way to keep it permanently)" aria-label="Download recording">⬇️</button>
        <button class="player-loop" aria-label="Repeat" aria-pressed="false" title="Repeat">🔁</button>
      </div>
    </div></div>` : (rec.audioDeletedAt
        ? `<div class="rec-audio-freed">🔇 Audio deleted to free space${hasTranscripts || hasReplies ? ' - the text below was kept' : ''}.</div>`
        : '<div class="rec-error" role="alert">Audio unavailable</div>')}
    ${scribePanelHtml}
    ${replyPanelHtml}
    <div class="bottom-actions" id="bottom-actions-${rec.id}">
    <button class="action-btn btn-delete" data-action="deleteRec" data-rec-id="${rec.id}" title="Delete this recording and everything in it" aria-label="Delete recording">🗑️</button>
    ${continueBtn}
    ${linkBtn}
    </div>
    ${contextChainHtml}
    ${captureWarningHtml}
    ${remuxWarningHtml}
    ${pipelineErrorHtml}
    ${fillWarningHtml}
    `;

    wireTranscriptDropdown(li, rec, allT, allS);
    wireScribeButtons(li, rec);
    wireReplyButtons(li, rec, allT, allS);

    return li;
}

function buildTranscriptSelector(rec, allT, showSelector = true) {
    const opts = allT.map((t, idx) => {
        const num     = allT.length - idx;
        const size    = fmtSize((t.text || '').length);
        const snippet = escapeHtml((t.text || '').substring(0, 45));
        return `<option value="${escapeAttr(t.id)}">(${num}) [${escapeHtml(t.source)}] ${size} - ${snippet}…</option>`;
    }).join('');

    const firstT       = allT[0];
    const firstPreview = escapeHtml((firstT.text || '').substring(0, 200));

    const selectorHtml = showSelector ? `
    <div class="sel-row" id="tsel-${rec.id}">
    <button class="btn-item-del" data-action="deleteTranscript" data-rec-id="${rec.id}" title="Delete selected">🗑️</button>
    <select class="action-drop" id="drop-t-${rec.id}">${opts}</select>
    </div>` : `<select class="action-drop" id="drop-t-${rec.id}" style="display:none">${opts}</select>`;

    return `
    ${selectorHtml}
    <div class="sel-preview" id="tprev-${rec.id}" role="button" tabindex="0" aria-label="View full transcript" data-view="transcript" data-rec="${rec.id}"><div class="sel-preview-text">${firstPreview}</div><div class="sel-preview-foot"><button class="btn-copy" data-copy="t" data-rec="${rec.id}" title="Copy to clipboard" aria-label="Copy transcript to clipboard">📋</button></div></div>`;
}

function buildReplyPanel(rec, showButtons = true) {
    const buttonsHtml = showButtons ? `
    <div class="btn-row" id="reply-btns-${rec.id}">
    <button class="action-btn btn-reply" id="btn-s-${rec.id}" title="Generate a reply with the configured server">🧠 Reply</button>
    </div>` : `
    <div class="btn-row is-hidden" id="reply-btns-${rec.id}">
    <button class="action-btn btn-reply" id="btn-s-${rec.id}">🧠 Reply</button>
    </div>`;

    const panelStyle = showButtons ? '' : ' style="display:none"';
    return `
    <div class="action-panel" id="reply-panel-${rec.id}"${panelStyle}>
    ${buttonsHtml}
    <div id="sreply-wrap-${rec.id}" style="display:none"></div>
    <select id="drop-s-${rec.id}" style="display:none"></select>
    </div>`;
}

const _expandedChains = new Set();

const _selectedTId = new Map();
const _selectedSId = new Map();

function buildContextChainHtml(rec) {
    const chain = rec.contextChain ? rec.contextChain : rec.context ? [rec.context] : [];
    if (chain.length === 0) return '';

    const { parts, bytes } = contextStats(chain);
    const expanded  = _expandedChains.has(rec.id);
    const itemsHtml = chain.map((item, idx) => buildContextItemHtml(rec, item, idx)).join('');

    return `
    <div class="context-chain${expanded ? ' expanded' : ''}" data-ctx-chain="${rec.id}">
    <button class="context-chain-summary" data-action="toggleContextChain" data-rec-id="${rec.id}" aria-expanded="${expanded}" title="Context from earlier voice notes fed into this recording's AI reply. Tap to ${expanded ? 'hide' : 'show'} and edit.">
    <span class="ctx-caret" aria-hidden="true">▸</span>
    <span class="ctx-count">🧠 <strong>${parts}</strong> context ${parts === 1 ? 'item' : 'items'}</span>
    <span class="ctx-bytes" title="${bytes.toLocaleString()} bytes fed to the AI">${fmtBytes(bytes)}</span>
    </button>
    <div class="context-chain-items">${itemsHtml}</div>
    </div>`;
}

window.toggleContextChain = function toggleContextChain(id) {
    const key = Number(id);
    const open = !_expandedChains.has(key);
    if (open) _expandedChains.add(key); else _expandedChains.delete(key);
    const el = document.querySelector(`[data-ctx-chain="${key}"]`);
    if (!el) return;
    el.classList.toggle('expanded', open);
    const btn = el.querySelector('.context-chain-summary');
    if (btn) btn.setAttribute('aria-expanded', String(open));
};

function buildContextItemHtml(rec, item, idx) {
    const srcTs      = item.srcTimestamp || (item.label || '').replace('Continued from: ', '').replace(/ \(T.*/, '').trim();
    const inputText  = item.inputText || (item.text && !item.inputText && !item.outputText ? item.text : '');
    const outputText = item.outputText || '';
    const hasInput   = inputText.trim().length > 0;
    const hasOutput  = outputText.trim().length > 0;

    const inPrev  = escapeHtml(inputText.substring(0, 200))  + (inputText.length > 200 ? '...' : '');
    const outPrev = escapeHtml(outputText.substring(0, 200)) + (outputText.length > 200 ? '...' : '');

    const inputBox = hasInput ? `
    <div class="ctx-part-box ctx-input-box">
    <div class="context-item-row">
    <span class="ctx-size-label">🎤 ${fmtSize(inputText.length)}</span>
    <button class="btn-unlink" data-action="unlinkContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input" title="Remove input">✂️</button>
    <div class="context-preview" role="button" tabindex="0" data-action="viewContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input" title="Tap to read the whole text" aria-label="Read the whole input text">${inPrev}</div>
    <button class="action-btn ctx-copy" data-action="copyContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input" title="Copy the whole text to the clipboard" aria-label="Copy the whole input text">📋</button>
    </div>
    </div>` : '';

    const outputBox = hasOutput ? `
    <div class="ctx-part-box ctx-output-box">
    <div class="context-item-row">
    <span class="ctx-size-label">🧠 ${fmtSize(outputText.length)}</span>
    <button class="btn-unlink" data-action="unlinkContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="output" title="Remove output">✂️</button>
    <div class="context-preview" role="button" tabindex="0" data-action="viewContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="output" title="Tap to read the whole text" aria-label="Read the whole output text">${outPrev}</div>
    <button class="action-btn ctx-copy" data-action="copyContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="output" title="Copy the whole text to the clipboard" aria-label="Copy the whole output text">📋</button>
    </div>
    </div>` : '';

    return `
    <div class="context-item">
    <div class="context-item-title" role="button" tabindex="0" aria-label="Jump to source recording" data-action="scrollToRecording" data-source-ref="${escapeAttr(item.sourceRecId ?? srcTs)}">🔗 ${escapeHtml(item.label || 'Context ' + (idx + 1))}</div>
    ${inputBox}${outputBox}
    </div>`;
}

function onActivate(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
        if (!keyActivates(e, el)) return;
        e.preventDefault();
        handler(e);
    });
}

function wireTranscriptDropdown(li, rec, allT, allS) {
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);
    if (!tDrop || allT.length === 0) return;

    const initialTId = pickSelection(allT, _selectedTId.get(rec.id));
    tDrop.value = initialTId;

    const refreshPreview = () => {
        const t = allT.find(x => x.id == tDrop.value);
        if (!t) return;
        const prev = li.querySelector(`#tprev-${rec.id}`);
        if (prev) prev.innerHTML = `<div class="sel-preview-text">${escapeHtml((t.text || '').substring(0, 200))}</div>`
            + `<div class="sel-preview-foot"><button class="btn-copy" data-copy="t" data-rec="${rec.id}" title="Copy to clipboard">📋</button></div>`;
        wireCopyButtons(li, rec, allT, allS);
    };

    tDrop.addEventListener('change', () => {
        _selectedTId.set(rec.id, rememberSelection(tDrop.value));
        refreshPreview();
        renderReplies(li, rec, allT, allS, tDrop.value);
    });

    if (initialTId != allT[0].id) refreshPreview();

    const tPrev = li.querySelector(`#tprev-${rec.id}`);
    if (tPrev) {
        onActivate(tPrev, (e) => {
            if (e.target.closest('.btn-copy')) return;
            const busyBtn = li.querySelector(`#btn-t-${rec.id}[data-busy]`);
            if (busyBtn) { openLiveLogTab(rec.id, rec.filename); return; }
            const tId = tDrop.value;
            if (tId) window.viewTranscriptById(rec.id, tId);
        });
    }

    wireCopyButtons(li, rec, allT, allS);
    renderReplies(li, rec, allT, allS, initialTId);
}

function renderReplies(li, rec, allT, allS, activeTId, selectNewest = false) {
    const wrap  = li.querySelector(`#sreply-wrap-${rec.id}`);
    const sDrop = li.querySelector(`#drop-s-${rec.id}`);
    if (!wrap) return;

    const panel       = li.querySelector(`#reply-panel-${rec.id}`);
    const btnRow      = li.querySelector(`#reply-btns-${rec.id}`);
    const btnsVisible = btnRow && !btnRow.classList.contains('is-hidden');
    const compact     = isCompact();
    const filteredS   = allS.filter(s => s.transcriptId == activeTId);
    if (filteredS.length === 0) {
        wrap.innerHTML = '';
        wrap.style.display = 'none';
        if (panel && !btnsVisible) panel.style.display = 'none';
        if (sDrop) { sDrop.innerHTML = ''; sDrop.value = ''; }
        return;
    }
    wrap.style.display = '';
    if (panel) panel.style.display = '';

    const opts     = filteredS.map((s, idx) => {
        const num     = filteredS.length - idx;
        const size    = fmtSize((s.text || '').length);
        const snippet = escapeHtml((s.text || '').substring(0, 45));
        return `<option value="${escapeAttr(s.id)}">(${num}) [${escapeHtml(s.source)}] ${size} - ${snippet}…</option>`;
    }).join('');

    const prevSVal = (!selectNewest && sDrop) ? sDrop.value : null;
    const pickedId = selectNewest
        ? filteredS[0].id
        : pickSelection(filteredS, _selectedSId.get(rec.id))
          ?? ((prevSVal && filteredS.find(s => s.id == prevSVal)) ? prevSVal : filteredS[0].id);
    const activeS = filteredS.find(s => s.id == pickedId) || filteredS[0];
    const sPreview = escapeHtml((activeS.text || '').substring(0, 200));

    const selectorHtml = compact
        ? `<select class="action-drop" id="drop-s-inner-${rec.id}" style="display:none">${opts}</select>`
        : `<div class="sel-row">
        <button class="btn-item-del" data-action="deleteSummary" data-rec-id="${rec.id}" title="Delete selected">🗑️</button>
        <select class="action-drop" id="drop-s-inner-${rec.id}">${opts}</select>
        </div>`;

    wrap.innerHTML = `
    ${selectorHtml}
    <div class="sel-preview" id="sprev-${rec.id}" role="button" tabindex="0" aria-label="View full reply" data-view="summary" data-rec="${rec.id}"><div class="sel-preview-text">${sPreview}</div><div class="sel-preview-foot"><button class="btn-copy" data-copy="s" data-rec="${rec.id}" title="Copy to clipboard" aria-label="Copy reply to clipboard">📋</button></div></div>`;

    if (sDrop) {
        sDrop.innerHTML = filteredS.map(s => `<option value="${escapeAttr(s.id)}"></option>`).join('');
        sDrop.value = activeS.id;
    }

    const innerSDrop = li.querySelector(`#drop-s-inner-${rec.id}`);
    if (innerSDrop) {
        innerSDrop.value = activeS.id;
        innerSDrop.addEventListener('change', () => {
            const s = filteredS.find(x => x.id == innerSDrop.value);
            if (!s) return;
            _selectedSId.set(rec.id, rememberSelection(s.id));
            if (sDrop) sDrop.value = s.id;
            const prev = li.querySelector(`#sprev-${rec.id}`);
            if (prev) {
                prev.innerHTML = `<div class="sel-preview-text">${escapeHtml((s.text || '').substring(0, 200))}</div>`
                + `<div class="sel-preview-foot"><button class="btn-copy" data-copy="s" data-rec="${rec.id}" title="Copy to clipboard">📋</button></div>`;
                wireCopyButtons(li, rec, allT, allS);
            }
        });
    }

    const sPrev = li.querySelector(`#sprev-${rec.id}`);
    if (sPrev) {
        onActivate(sPrev, (e) => {
            if (e.target.closest('.btn-copy')) return;
            const busyBtn = li.querySelector(`#btn-s-${rec.id}[data-busy]`);
            if (busyBtn) { openReplyStreamTab(rec.id, rec.filename); return; }
            const sId = sDrop ? sDrop.value : null;
            if (sId) window.viewSummaryById(rec.id, sId);
        });
    }

    wireCopyButtons(li, rec, allT, allS);
}

function wireCopyButtons(li, rec, allT, allS) {
    li.querySelectorAll('.btn-copy').forEach(btn => {
        if (btn._copyWired) return;
        btn._copyWired = true;

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const type  = btn.dataset.copy;
            const recId = Number(btn.dataset.rec);
            const fresh = await dbExec(CONFIG.STORE_REC, 'get', recId);
            if (!fresh) return;
            let text = '';

            if (type === 't') {
                const tDrop = li.querySelector(`#drop-t-${recId}`);
                const tId   = tDrop ? tDrop.value : null;
                const t     = (fresh.transcripts || []).find(x => x.id == tId) || (fresh.transcripts || [])[0];
                text = t ? t.text : '';
            } else {
                const sDrop = li.querySelector(`#drop-s-${recId}`);
                const sId   = sDrop ? sDrop.value : null;
                const s     = (fresh.summaries || []).find(x => x.id == sId) || (fresh.summaries || [])[0];
                text = s ? s.text : '';
            }

            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                const orig = btn.textContent;
                btn.textContent = '✓';
                btn.style.color = '#4caf50';
                setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1200);
            } catch (_) {
                btn.textContent = '✗';
                setTimeout(() => { btn.textContent = '📋'; }, 1200);
            }
        });
    });
}

function wireScribeButtons(li, rec) {
    const button = li.querySelector(`#btn-t-${rec.id}`);
    if (!button) return;
    const fillsGaps = liveHolesToFill(rec.transcripts);
    if (hasJob('t', rec.id)) {
        markButtonBusy(button, li.querySelector(`#scribe-btns-${rec.id}`), '\u{1F4DD} Working\u2026');
    }

    button.onclick = async () => {
        if (button.dataset.busy) {
            openLiveLogTab(rec.id, rec.filename);
            return;
        }

        button.disabled = true;
        button.dataset.busy = '1';
        button.classList.add('processing');
        const scribeRow = li.querySelector(`#scribe-btns-${rec.id}`);
        if (scribeRow) scribeRow.classList.add('is-hidden');
        liveLogClear(rec.id);
        showLiveStatus(rec.id, 'scribe', '📝 Starting…',
            () => openLiveLogTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));
        let repainted = false;
        try {
            await transcribeChunked(rec.id, text => {
                button.textContent = text;
                updateLiveStatus(rec.id, 'scribe', `📝 ${text}`);
            }, { reuseLive: fillsGaps });
            removeLiveStatus(rec.id, 'scribe');
            button.textContent = '\u{1F4DD} Scribe';
            repainted = true;
            await renderList();
        } catch (error) {
            removeLiveStatus(rec.id, 'scribe');
            if (error && error.name === 'AbortError') {
                button.textContent = '📝 Scribe';
                repainted = true;
                await renderList();
            } else {
                button.textContent = 'Error';
                alert(error.message);
            }
        } finally {
            button.disabled = false;
            delete button.dataset.busy;
            button.classList.remove('processing');
            if (scribeRow) scribeRow.classList.remove('is-hidden');
            if (!repainted) repaintIfRowRebuiltDuringJob(li);
        }
    };
}

function repaintIfRowRebuiltDuringJob(li) {
    if (li.isConnected) return;
    renderList({ force: true }).catch(err => console.warn('Repaint after a finished job failed:', err));
}

function wireReplyButtons(li, rec, allT, allS) {
    const button = li.querySelector(`#btn-s-${rec.id}`);
    if (!button) return;
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);

    if (hasJob('r', rec.id)) {
        markButtonBusy(button, li.querySelector(`#reply-btns-${rec.id}`), '\u{1F9E0} Working\u2026');
    }

    button.onclick = async () => {
        if (button.dataset.busy) {
            openReplyStreamTab(rec.id, rec.filename);
            return;
        }

        button.disabled = true;
        button.dataset.busy = '1';
        button.classList.add('processing');
        button.textContent = '⏳ Waiting...';
        const replyRow = li.querySelector(`#reply-btns-${rec.id}`);
        if (replyRow) replyRow.classList.add('is-hidden');
        replyStreamInit(rec.id);
        showLiveStatus(rec.id, 'reply', '🧠 Waiting for first token… (tap to watch)',
            () => openReplyStreamTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));

        const activeTId = tDrop ? tDrop.value : null;
        let repainted = false;
        try {
            await runSummary(rec.id, text => {
                if (text === '__first_token__') {
                    button.textContent = '⚡ Streaming...';
                    updateLiveStatus(rec.id, 'reply', '⚡ Streaming… (tap to watch)');
                } else {
                    button.textContent = text;
                }
            }, activeTId);

            const freshRec = await dbExec(CONFIG.STORE_REC, 'get', rec.id);
            const freshS = freshRec ? (freshRec.summaries || []) : [];
            freshS.forEach(item => { if (!item.id) item.id = item.time || uid(); });
            allS.length = 0;
            freshS.forEach(item => allS.push(item));
            button.textContent = '🧠 Reply';
            removeLiveStatus(rec.id, 'reply');
            if (isCompact()) { repainted = true; await renderList(); }
            else if (li.isConnected) renderReplies(li, rec, allT, allS, activeTId, true);
        } catch (error) {
            removeLiveStatus(rec.id, 'reply');
            if (error && error.name === 'AbortError') button.textContent = '🧠 Reply';
            else {
                button.textContent = 'Error';
                alert(error.message);
            }
        } finally {
            button.disabled = false;
            delete button.dataset.busy;
            button.classList.remove('processing');
            if (replyRow) replyRow.classList.remove('is-hidden');
            if (!repainted) repaintIfRowRebuiltDuringJob(li);
        }
    };
}

function renderPagination(totalItems, totalPages) {
    const repaint = () => renderList({ force: true }).catch(err => console.error('Page change failed:', err));

    for (const bar of PAGINATION_BARS) {
        const pgWrap = document.getElementById(bar.wrap);
        if (!pgWrap) continue;
        if (!paginationBarVisible(bar, totalPages, UI.curPage)) { pgWrap.hidden = true; continue; }

        const info = document.getElementById(bar.info);
        const prev = document.getElementById(bar.prev);
        const next = document.getElementById(bar.next);
        pgWrap.hidden = false;
        if (info) info.textContent = `${UI.curPage + 1} / ${totalPages}`;
        if (prev) {
            prev.disabled = UI.curPage === 0;
            prev.onclick = () => { UI.curPage = Math.max(0, UI.curPage - 1); repaint(); };
        }
        if (next) {
            next.disabled = UI.curPage >= totalPages - 1;
            next.onclick = () => { UI.curPage = Math.min(totalPages - 1, UI.curPage + 1); repaint(); };
        }
    }
}

window.showRecordingById = async function showRecordingById(recId) {
    const index = await recordingPosition(Number(recId));
    if (index < 0) return false;
    UI.curPage = Math.floor(index / CONFIG.PAGE_SIZE);
    await renderList({ force: true });
    const element = document.getElementById(`rec-${recId}`);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        element.classList.add('rec-highlight');
        setTimeout(() => element.classList.remove('rec-highlight'), 1600);
    }
    return !!element;
};

window.continueConv = async (recId) => {
    if (AppState.recId != null || AppState.busy) {
        alert('💬 Continue starts a new recording. Stop the current one first, then tap 💬 again.');
        return;
    }
    const rec   = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    const tDrop = document.getElementById(`drop-t-${recId}`);
    const sDrop = document.getElementById(`drop-s-${recId}`);

    let inputText = '', outputText = '';
    let tNum = '?', sNum = '?';

    if (tDrop && tDrop.value) {
        const tIdx = rec.transcripts.findIndex(t => t.id == tDrop.value);
        if (tIdx > -1) {
            const t = rec.transcripts[tIdx];
            inputText = t.plain || t.text;
            tNum = rec.transcripts.length - tIdx;
        }
    }
    if (sDrop && sDrop.value && !sDrop.disabled) {
        const innerDrop = document.getElementById(`drop-s-inner-${recId}`);
        const activeId  = (innerDrop && innerDrop.value) ? innerDrop.value : sDrop.value;
        const sIdx      = rec.summaries.findIndex(s => s.id == activeId);
        if (sIdx > -1) {
            outputText = rec.summaries[sIdx].text;
            sNum = rec.summaries.length - sIdx;
        }
    }

    if (!inputText && !outputText) return alert('Select a transcript/summary to continue the conversation.');

    const srcTimestamp = rec.filename.split(' - ')[0];
    const newItem = {
        inputText,
        outputText,
        text:  (inputText ? `[User Scribe Input]: ${inputText}\n` : '')
             + (outputText ? `[AI Summary/Reply Output]: ${outputText}\n` : ''),
        label: `Continued from: ${srcTimestamp} (T${tNum} S${sNum})`,
        srcTimestamp,
        sourceRecId: rec.id
    };

    const parentChain = rec.contextChain ? [...rec.contextChain]
                      : rec.context ? [rec.context]
                      : [];
    AppState.pendingContext = [...parentChain, newItem];
    UI.curPage = 0;
    window.scrollTo(0, 0);
    startRecording();
};

function toggleLinkRec(recId, tsLabel) {
    if (linkSet.has(recId)) linkSet.delete(recId);
    else                    linkSet.set(recId, tsLabel || '');
    updateLinkButton(recId);
    renderLinkTray();
}

function removeLinkedRec(recId) {
    linkSet.delete(recId);
    updateLinkButton(recId);
    renderLinkTray();
}

function clearLinkedRecs() {
    const ids = [...linkSet.keys()];
    linkSet.clear();
    ids.forEach(updateLinkButton);
    renderLinkTray();
}

async function recordFromLinked() {
    if (AppState.recId || AppState.busy) return;
    const ids = [...linkSet.keys()];
    if (ids.length === 0) return;

    const items = [];
    for (const id of ids) {
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        if (!rec) continue;
        const t = (rec.transcripts && rec.transcripts[0]) || null;
        const s = (rec.summaries   && rec.summaries[0])   || null;
        const inputText  = t ? (t.plain || t.text || '') : '';
        const outputText = s ? (s.text || '') : '';
        if (!inputText && !outputText) continue;
        const srcTimestamp = (rec.filename || '').split(' - ')[0];
        items.push({
            inputText, outputText,
            text: (inputText  ? `[User Scribe Input]: ${inputText}\n` : '')
                + (outputText ? `[AI Summary/Reply Output]: ${outputText}\n` : ''),
            label: `Linked from: ${srcTimestamp}`,
            srcTimestamp,
            sourceRecId: rec.id
        });
    }

    if (items.length === 0) {
        alert('None of the linked recordings have a transcript or reply yet - transcribe them first, then link.');
        return;
    }

    AppState.pendingContext = items;
    linkSet.clear();
    renderLinkTray();
    UI.curPage = 0;
    window.scrollTo(0, 0);
    startRecording();
}

window.toggleLinkRec    = toggleLinkRec;
window.removeLinkedRec  = removeLinkedRec;
window.clearLinkedRecs  = clearLinkedRecs;
window.recordFromLinked = recordFromLinked;

window.saveRecTitle = async function saveRecTitle(id, value) {
    const key = Number(id);
    const v   = String(value == null ? '' : value).trim();
    await dbUpdate(CONFIG.STORE_REC, key, (rec) => {
        if (!rec) return null;
        if (v && v !== rec.filename) rec.title = v;
        else                         delete rec.title;
        return rec;
    });
    renderList({ force: true });
};

// Pinning writes only the pin: a recording still being saved, or being deleted, is left as it is.
// The automatic sweep plans each row again inside its own write, so a pin that lands first is seen.
window.pinRec = async function pinRec(id, pinned) {
    const key = Number(id);
    const refocus = !!(document.activeElement && document.activeElement.dataset
        && document.activeElement.dataset.action === 'pinRec');
    let changed = false;
    await dbUpdate(CONFIG.STORE_REC, key, (rec) => {
        if (!rec || rec.processing || rec.deleting) return null;
        changed = setPinned(rec, pinned, Date.now());
        return changed ? rec : null;
    });
    await renderList({ force: true });
    if (refocus) {
        const button = document.querySelector(`#rec-${key} .pin-btn`);
        if (button && typeof button.focus === 'function') button.focus();
    }
    return changed;
};

window.downloadRec = async function downloadRec(id) {
    const key = Number(id);
    const rec = await dbExec(CONFIG.STORE_REC, 'get', key);
    const stored = rec ? await readAudio(key) : null;
    if (!rec || !stored) { alert('Audio for this recording is no longer available.'); return; }

    let downloadBlob = stored;
    if (needsSeekableUpgrade(rec)) {
        try {
            downloadBlob = await makeWebmSeekable(stored, rec.durationMs);
            await commitAudio(key, downloadBlob, current => {
                if (!current || Number(current.audioBytes) !== Number(rec.audioBytes)) return null;
                current.audioBytes = downloadBlob.size;
                current.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
                delete current.webmDurationFixed;
                delete current.webmRemuxError;
                return current;
            });
            await calcTotalStorage();
        } catch (err) {
            console.warn('Could not remux WebM for desktop seeking; downloading the original file:', err);
            downloadBlob = stored;
            const reason = err && err.message ? err.message : String(err);
            await dbUpdate(CONFIG.STORE_REC, key, current => {
                if (!current) return null;
                current.webmRemuxError = reason;
                return current;
            }).catch(() => {});
            renderList().catch(() => {});
        }
    }

    const url = URL.createObjectURL(downloadBlob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = buildDownloadName(rec, recordingExt(rec));
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000);
};

let _actionsWired = false;
export function wireActionDelegation() {
    if (_actionsWired) return;
    _actionsWired = true;

    const invoke = async (el) => {
        const action = el.dataset.action;
        const recId = Number(el.dataset.recId);
        switch (action) {
            case 'removeLinkedRec': return window.removeLinkedRec(recId);
            case 'clearLinkedRecs': return window.clearLinkedRecs();
            case 'recordFromLinked': return window.recordFromLinked();
            case 'retryFinalizeRec': return window.retryFinalizeRec(recId);
            case 'downloadRecoverableRec': return window.downloadRecoverableRec(recId);
            case 'recoverNowRec': return window.recoverNowRec(recId);
            case 'deleteRec': return window.deleteRec(recId);
            case 'deleteRecAudio': return window.deleteRecAudio(recId);
            case 'closeLiveScribe': return window.closeLiveScribe();
            case 'convertRecFormat': return window.convertRecFormat(recId);
            case 'continueConv': return window.continueConv(recId);
            case 'toggleLinkRec': return window.toggleLinkRec(recId, el.dataset.linkLabel || '');
            case 'pinRec': return window.pinRec(recId, el.dataset.pin === '1');
            case 'downloadRec': return window.downloadRec(recId);
            case 'deleteTranscript': {
                const selected = document.getElementById(`drop-t-${recId}`)?.value;
                if (selected != null) return window.deleteTranscript(recId, selected);
                return;
            }
            case 'toggleContextChain': return window.toggleContextChain(recId);
            case 'unlinkContextPart': return window.unlinkContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part);
            case 'viewContextPart': return window.viewContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part);
            case 'copyContextPart': return window.copyContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part, el);
            case 'scrollToRecording': return window.scrollToRecording(el.dataset.sourceRef || '');
            case 'deleteSummary': {
                const selected = document.getElementById(`drop-s-${recId}`)?.value;
                if (selected != null) return window.deleteSummary(recId, selected);
                return;
            }
            case 'appUpdate': return window.appUpdate();
            case 'closeHelp': return window.closeHelp();
            case 'closeSettings': return window.closeSettings();
            case 'refreshOllamaModels': return window.refreshOllamaModels();
            case 'refreshLoadedModels': return window.refreshLoadedModels();
            case 'downloadBackup': return window.downloadBackup();
            case 'deleteAllAudio': return window.deleteAllAudio();
            case 'deleteAllText': return window.deleteAllText();
            default: return;
        }
    };

    document.addEventListener('click', event => {
        const el = event.target.closest('[data-action]');
        if (!el) return;
        Promise.resolve(invoke(el)).catch(err => {
            if (err?.name !== 'AbortError') console.error(`Action ${el.dataset.action} failed:`, err);
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const handledCloserToElement = event.defaultPrevented;
        if (handledCloserToElement) return;
        const el = event.target.closest('[data-action][role="button"]');
        if (!el) return;
        event.preventDefault();
        el.click();
    });
}

function makeAbortError(message = 'Conversion cancelled') {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

async function encodeBlobToOpus(blob, mime, onProgress, signal) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let src = null;
    let mr = null;
    let prog = null;
    let abortHandler = null;
    let stopped = Promise.resolve();

    try {
        if (signal?.aborted) throw makeAbortError();
        const encoded = await blob.arrayBuffer();
        if (signal?.aborted) throw makeAbortError();
        const buf = await ctx.decodeAudioData(encoded);
        if (signal?.aborted) throw makeAbortError();

        const dest = ctx.createMediaStreamDestination();
        src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);

        mr = new MediaRecorder(dest.stream, { mimeType: mime });
        const chunks = [];
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        stopped = new Promise((res, rej) => {
            mr.onstop = res;
            mr.onerror = (e) => rej((e && e.error) || new Error('MediaRecorder error'));
        });

        const ended = new Promise((resolve, reject) => {
            src.onended = resolve;
            abortHandler = () => {
                try { src.stop(); } catch (_) {}
                try { if (mr && mr.state !== 'inactive') mr.stop(); } catch (_) {}
                reject(makeAbortError());
            };
            signal?.addEventListener('abort', abortHandler, { once: true });
        });

        mr.start(1000);
        const total = buf.duration || 0;
        const t0 = ctx.currentTime;
        if (onProgress) {
            prog = setInterval(() => {
                onProgress(total ? Math.min(1, (ctx.currentTime - t0) / total) : 0);
            }, 250);
        }

        if (ctx.state === 'suspended') await ctx.resume();
        if (ctx.state !== 'running') throw new Error('Audio playback could not start for conversion.');
        src.start();
        await ended;
        if (signal?.aborted) throw makeAbortError();
        if (prog) { clearInterval(prog); prog = null; }
        await new Promise((r) => setTimeout(r, 150));
        try { if (mr.state !== 'inactive') mr.stop(); } catch (_) {}
        await stopped;
        if (signal?.aborted) throw makeAbortError();
        return new Blob(chunks, { type: mime });
    } finally {
        if (prog) clearInterval(prog);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
        try { if (src) src.disconnect(); } catch (_) {}
        try { if (mr && mr.state !== 'inactive') mr.stop(); } catch (_) {}
        try { await stopped.catch(() => {}); } catch (_) {}
        try { await ctx.close(); } catch (_) {}
    }
}

let _activeConversion = null;

export function isConverting() { return _activeConversion !== null; }

window.convertRecFormat = async function convertRecFormat(id) {
    const key = Number(id);

    if (_activeConversion) {
        if (_activeConversion.recId === key) _activeConversion.controller.abort();
        else alert('Another recording is already being converted. Cancel it or let it finish first.');
        return;
    }

    const pref = getSetting('set-recording-format');
    if (pref !== 'opus') return;
    const rec = await dbExec(CONFIG.STORE_REC, 'get', key);
    const source = rec ? await readAudio(key) : null;
    if (!rec || !source) { alert('Audio for this recording is no longer available.'); return; }
    if (storedFormat(rec) === 'opus') return;

    const maxMs = CONFIG.OPUS_CONVERT_MAX_MS;
    const wavMeta = await inspectPcmWav(source);
    const measuredMs = wavMeta ? Math.round(wavMeta.durationSec * 1000) : 0;
    const effectiveDurationMs = Math.max(Number(rec.durationMs) || 0, measuredMs);
    if (!effectiveDurationMs) {
        alert('This recording has no reliable duration metadata, so browser conversion was refused for memory safety. Download it and use a desktop audio tool instead.');
        return;
    }
    if (effectiveDurationMs > maxMs) {
        const maxMin = Math.round(maxMs / 60000);
        alert(`Browser conversion is limited to ${maxMin} minutes to prevent excessive memory use. Choose Opus before recording, or download this WAV and convert it with a desktop audio tool.`);
        return;
    }

    const mime = (typeof MediaRecorder !== 'undefined')
        ? pickOpusMime((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } })
        : null;
    if (!mime) { alert('Opus recording is not supported in this browser.'); return; }

    const controller = new AbortController();
    _activeConversion = { recId: key, controller };
    let badge = document.querySelector(`[data-fmt-rec="${key}"]`);
    if (badge) {
        badge.disabled = false;
        badge.textContent = '✕ 0%';
        badge.title = 'Converting in real time. Tap to cancel.';
    }

    try {
        const opusBlob = await encodeBlobToOpus(source, mime, (frac) => {
            badge = document.querySelector(`[data-fmt-rec="${key}"]`) || badge;
            if (badge) badge.textContent = `✕ ${Math.round(frac * 100)}%`;
        }, controller.signal);
        if (!opusBlob || opusBlob.size === 0) throw new Error('conversion produced no audio');
        if (controller.signal.aborted) throw makeAbortError();
        let storedBlob = opusBlob;
        try {
            storedBlob = await makeWebmSeekable(opusBlob, effectiveDurationMs);
        } catch (remuxErr) {
            console.warn('WebM remux failed; storing the converted audio unremuxed and upgradable:', remuxErr);
            storedBlob = opusBlob;
        }
        const webmSeekable = storedBlob !== opusBlob
            && String(storedBlob.type || mime || '').toLowerCase().includes('webm');

        await commitAudio(key, storedBlob, (r) => {
            if (!conversionStillApplies(r, rec)) return null;
            r.audioBytes = storedBlob.size;
            r.format = 'opus';
            r.mime = mime;
            if (webmSeekable) r.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
            else delete r.webmSeekableVersion;
            delete r.webmDurationFixed;
            return r;
        });
        await calcTotalStorage();
        await renderList({ force: true });
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('Format conversion failed:', e);
            alert('Conversion failed: ' + (e && e.message ? e.message : e));
        }
    } finally {
        if (_activeConversion?.controller === controller) _activeConversion = null;
        await renderList({ force: true });
    }
};
