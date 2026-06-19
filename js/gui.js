/* ==========================================================================
 * gui.js — Recording list rendering, button bindings, continue-conversation
 * ========================================================================== */
import { CONFIG, fmtDur, fmtSize, uid, escapeHtml, escapeAttr, escapeJs } from './config.js';
import { dbExec, getRecordingsPage } from './db.js';
import { transcribeChunked }         from './transcribe.js';
import { runLocalSummary, runRemoteSummary } from './reply.js';
import {
    liveLogClear, openLiveLogTab, openReplyStreamTab, replyStreamInit,
    showLiveStatus, updateLiveStatus, removeLiveStatus
} from './live-tabs.js';
import { AppState, startRecording, buildLivePreviewBlob }  from './recorder.js';
import { isCompact }                 from './settings.js';

const UI = {
    list:    document.getElementById('recordingsList'),
    btn:     document.getElementById('recordBtn'),
    curPage: 0
};

// Track audio object URLs so they can be revoked before each re-render.
// Previously these were recreated on every paint and never freed (memory leak).
const _objectUrls = new Map();   // recId -> objectURL
function revokeAllObjectUrls() {
    for (const url of _objectUrls.values()) { try { URL.revokeObjectURL(url); } catch (_) {} }
    _objectUrls.clear();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Live playback preview for the in-progress recording
 *
 * The active recording's row carries a real <audio> player that replays what's
 * been captured SO FAR, while you're still recording. Its source is rebuilt
 * from the 4-second WAV chunks already flushed to IndexedDB (buildLivePreviewBlob)
 * on a timer, so the seek bar / duration GROWS over time — but the rebuild only
 * happens while the player is PAUSED, so a refresh never cuts off audio you're
 * actively listening to. When paused mid-scrub, the playhead is preserved across
 * the swap (the new, longer blob shares the same prefix audio, so the old
 * currentTime is still valid). Exactly one recording is ever live, so a single
 * module-level timer suffices.
 *
 * Teardown is driven two ways, for safety in depth:
 *   1. _liveTick bails the instant AppState.recId stops matching (recording
 *      ended) — so we never read chunks finalize is about to delete; and
 *   2. _renderListNow calls stopLivePreview() before each rebuild (it only runs
 *      when nothing is playing, since renderList defers during playback).
 * ────────────────────────────────────────────────────────────────────────── */
const LIVE_REFRESH_MS = CONFIG.IO_FLUSH_SEC * 1000;   // align rebuilds with the 4 s chunk flush
let _liveTimer     = null;
let _liveUrl       = null;     // current object URL for the live player (revoked on swap/teardown)
let _liveLastBuild = 0;        // ms timestamp of the last blob rebuild (throttle gate)

function stopLivePreview() {
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
    // Safe to revoke even if the <audio> is mid-playback: once a media element
    // has loaded a blob URL the data is retained, and revoke only blocks NEW
    // loads (per the URL.createObjectURL contract).
    if (_liveUrl) { try { URL.revokeObjectURL(_liveUrl); } catch (_) {} _liveUrl = null; }
    _liveLastBuild = 0;
}

async function _liveTick(recId) {
    // Recording ended (or moved on) → stop touching the DB chunks finalize is
    // about to delete, and let the post-finalize renderList paint the master.
    if (AppState.recId !== recId) { stopLivePreview(); return; }

    const audio = document.getElementById(`live-audio-${recId}`);
    if (!audio) { stopLivePreview(); return; }       // row no longer in the DOM

    // Cheap, every tick: advance the elapsed-time label so time reads as live
    // even between the (throttled) blob rebuilds.
    const elapsedEl = document.getElementById(`live-elapsed-${recId}`);
    if (elapsedEl && AppState.startTime) elapsedEl.textContent = fmtDur(Date.now() - AppState.startTime);

    // Expensive, throttled to the flush cadence AND skipped while playing so we
    // never interrupt the audio the user is actively listening to.
    if (!audio.paused && !audio.ended) return;
    if (Date.now() - _liveLastBuild < LIVE_REFRESH_MS - 50) return;

    const blob = await buildLivePreviewBlob(recId);
    if (!blob) return;                                // nothing flushed yet → keep buffering state
    if (AppState.recId !== recId) return;             // recording ended during the await

    _liveLastBuild = Date.now();
    const resumeAt = audio.paused ? (audio.currentTime || 0) : null;
    const prevUrl  = _liveUrl;
    const url      = URL.createObjectURL(blob);
    _liveUrl = url;
    audio.src = url;
    audio.load();
    audio.addEventListener('loadedmetadata', () => {
        if (resumeAt && isFinite(audio.duration) && resumeAt < audio.duration) {
            try { audio.currentTime = resumeAt; } catch (_) {}
        }
    }, { once: true });
    if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch (_) {} }

    const hint = document.getElementById(`live-hint-${recId}`);
    if (hint) hint.textContent = ' · ▶ replay what you\u2019ve captured so far';
}

function startLivePreview(recId) {
    stopLivePreview();
    _liveTick(recId);                                         // build immediately if a chunk already exists
    _liveTimer = setInterval(() => _liveTick(recId), 1000);   // 1 s elapsed cadence; blob rebuild throttled inside
}

// Keyboard activation for the role="button" <div>s we render (transcript/reply
// previews and context titles). They carry click handlers but, as divs, were
// unreachable by keyboard. Delegated once on the stable list container so it
// survives the innerHTML rebuild on every paint.
if (UI.list && !UI.list._keyActivateWired) {
    UI.list._keyActivateWired = true;
    UI.list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        const t = e.target;
        if (t && t.matches && t.matches('.sel-preview, .context-item-title')) {
            e.preventDefault();   // keep Space from scrolling the page
            t.click();
        }
    });
}

/* ──────────────────────────────────────────────────────────────────────────
 * renderList — main paint function (called after every data mutation)
 *
 * Rebuilding the list replaces every <audio> element, which stops any in-
 * progress playback. Background events (e.g. an auto-pipeline finishing on a
 * different recording) call this, so we DEFER the rebuild while audio is
 * playing and run it once playback stops. Live progress (the status bar and
 * button labels) updates via direct DOM mutation, not this rebuild, so nothing
 * freezes in the meantime.
 * ────────────────────────────────────────────────────────────────────────── */
let _pendingRender = false;

function _playingAudios() {
    return [...UI.list.querySelectorAll('audio')].filter(a => !a.paused && !a.ended);
}

export async function renderList() {
    const playing = _playingAudios();
    if (playing.length > 0) {
        if (_pendingRender) return;             // already deferred — coalesce
        _pendingRender = true;
        const onStop = () => {
            playing.forEach(a => {
                a.removeEventListener('pause', onStop);
                a.removeEventListener('ended', onStop);
            });
            _pendingRender = false;
            renderList();                        // re-attempt (re-defers if still playing)
        };
        playing.forEach(a => {
            a.addEventListener('pause', onStop);
            a.addEventListener('ended', onStop);
        });
        return;
    }
    await _renderListNow();
}

async function _renderListNow() {
    // Fetch ONLY the current page via a reverse cursor on the by-date index,
    // instead of loading every record (all text + blob handles) and slicing.
    // getRecordingsPage clamps the page for us (deletions may have shrunk it).
    const { page, total, totalPages, pageIndex } = await getRecordingsPage(UI.curPage, CONFIG.PAGE_SIZE);
    UI.curPage = pageIndex;

    revokeAllObjectUrls();        // free URLs from the previous paint
    stopLivePreview();            // and tear down any live-preview timer (safe: we only get here when nothing is playing)
    UI.list.innerHTML = '';

    for (const rec of page) {
        const li = buildRecordingItem(rec);
        UI.list.append(li);
    }

    renderPagination(total, totalPages);

    // If the active recording's row is on this page, start its live play bar.
    // Done here (after append) so the <audio> element exists in the DOM.
    if (AppState.recId != null && document.getElementById(`live-audio-${AppState.recId}`)) {
        startLivePreview(AppState.recId);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Build a single <li> for one recording
 * ────────────────────────────────────────────────────────────────────────── */
function buildRecordingItem(rec) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    li.id = `rec-${rec.id}`;

    let objectUrl = '';
    if (rec.blob) {
        objectUrl = URL.createObjectURL(rec.blob);
        _objectUrls.set(rec.id, objectUrl);
    }

    // Safety net for legacy data missing IDs. These ids are now made permanent
    // once on load by migrateLegacyIds() in db.js; this in-render patch just
    // guards any record that migration hasn't touched yet (it no longer churns,
    // because migration persisted them).
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
    const safeName       = escapeHtml(rec.filename);

    if (rec.processing) {
        // The genuinely-live recording (this row IS the active capture) gets a
        // working play bar that replays audio-so-far and grows every ~4 s. Other
        // "processing" rows (crash-recovery finalize, etc.) have no live capture
        // and their chunks may be mid-delete, so they keep the simple spinner.
        const isLive = AppState.recId != null && rec.id === AppState.recId;
        if (!isLive) {
            li.innerHTML = `<div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span style="color:#ffc107">⏳ Processing...</span></div>`;
            return li;
        }
        li.innerHTML = `
        <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span class="live-rec-badge"><span class="dot"></span>LIVE</span></div>
        <div class="rec-player rec-player-live"><audio controls preload="metadata" id="live-audio-${rec.id}"></audio></div>
        <div class="live-rec-meta">⏱️ <span id="live-elapsed-${rec.id}">00:00</span><span id="live-hint-${rec.id}" style="opacity:.55"> · capturing first ${CONFIG.IO_FLUSH_SEC}s…</span></div>`;
        return li;
    }

    const blobKb = rec.blob ? (rec.blob.size / 1024).toFixed(1) : '0';

    const showScribeButtons  = !compact || !hasTranscripts;
    const showScribeSelector = !compact && hasTranscripts;
    const showReplyButtons   = !compact || (hasTranscripts && !hasReplies);

    // ── Scribe panel ──
    const scribeButtonsHtml = showScribeButtons ? `
    <div class="btn-row" id="scribe-btns-${rec.id}">
    <button class="action-btn btn-ls" id="btn-t-l-${rec.id}" title="On-device transcription">💻 Scribe</button>
    <button class="action-btn btn-rs" id="btn-t-r-${rec.id}" title="Cloud transcription">☁️ Scribe</button>
    </div>` : `
    <div class="btn-row" id="scribe-btns-${rec.id}" style="display:none">
    <button class="action-btn btn-ls" id="btn-t-l-${rec.id}">💻 Scribe</button>
    <button class="action-btn btn-rs" id="btn-t-r-${rec.id}">☁️ Scribe</button>
    </div>`;

    const tScribeHtml = hasTranscripts ? buildTranscriptSelector(rec, allT, showScribeSelector) : '';

    const scribePanelHtml = (showScribeButtons || hasTranscripts) ? `
    <div class="action-panel">
    ${scribeButtonsHtml}
    ${tScribeHtml}
    </div>` : '';

    // ── Reply panel ──
    const replyPanelHtml = hasTranscripts ? buildReplyPanel(rec, showReplyButtons) : '';

    // ── Context chain ──
    const contextChainHtml = buildContextChainHtml(rec);

    // ── Continue button ──
    const continueBtn = hasTranscripts
        ? `<button class="action-btn btn-continue" id="btn-continue-${rec.id}" onclick="continueConv(${rec.id})">🔗 Continue</button>`
        : '';

    li.innerHTML = `
    <div class="rec-top"><span class="rec-filename">${safeName}${rec.blob ? ` <span style="color:#555;font-size:0.85em;font-weight:normal">${blobKb} KB</span>` : ''}</span></div>
    ${objectUrl ? `<div class="rec-player"><audio controls src="${objectUrl}"></audio></div>` : '<div style="color:red">Audio unavailable</div>'}
    ${scribePanelHtml}
    ${replyPanelHtml}
    <div class="bottom-actions" id="bottom-actions-${rec.id}">
    <button class="action-btn btn-delete" onclick="deleteRec(${rec.id})">🗑️ Delete</button>
    ${continueBtn}
    </div>
    ${contextChainHtml}
    `;

    // ── Wiring ──
    wireTranscriptDropdown(li, rec, allT, allS);
    wireScribeButtons(li, rec);
    wireReplyButtons(li, rec, allT, allS);

    return li;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Sub-builders for recording item HTML
 * ────────────────────────────────────────────────────────────────────────── */
function buildTranscriptSelector(rec, allT, showSelector = true) {
    const opts = allT.map((t, idx) => {
        const num     = allT.length - idx;
        const size    = fmtSize((t.text || '').length);
        const snippet = escapeHtml((t.text || '').substring(0, 45));
        return `<option value="${escapeAttr(t.id)}">(${num}) [${escapeHtml(t.source)}] ${size} — ${snippet}…</option>`;
    }).join('');

    const firstT       = allT[0];
    const firstPreview = escapeHtml((firstT.text || '').substring(0, 200));

    const selectorHtml = showSelector ? `
    <div class="sel-row" id="tsel-${rec.id}">
    <button class="btn-item-del" onclick="deleteTranscript(${rec.id}, document.getElementById('drop-t-${rec.id}').value)" title="Delete selected">🗑️</button>
    <select class="action-drop" id="drop-t-${rec.id}">${opts}</select>
    </div>` : `<select class="action-drop" id="drop-t-${rec.id}" style="display:none">${opts}</select>`;

    return `
    ${selectorHtml}
    <div class="sel-preview" id="tprev-${rec.id}" role="button" tabindex="0" aria-label="View full transcript" data-view="transcript" data-rec="${rec.id}"><div class="sel-preview-text">${firstPreview}</div><div class="sel-preview-foot"><button class="btn-copy" data-copy="t" data-rec="${rec.id}" title="Copy to clipboard" aria-label="Copy transcript to clipboard">📋</button></div></div>`;
}

function buildReplyPanel(rec, showButtons = true) {
    const buttonsHtml = showButtons ? `
    <div class="btn-row" id="reply-btns-${rec.id}">
    <button class="action-btn btn-la" id="btn-s-l-${rec.id}" title="On-device reply">💻 Reply</button>
    <button class="action-btn btn-ra" id="btn-s-r-${rec.id}" title="Cloud reply">☁️ Reply</button>
    </div>` : `
    <div class="btn-row" id="reply-btns-${rec.id}" style="display:none">
    <button class="action-btn btn-la" id="btn-s-l-${rec.id}">💻 Reply</button>
    <button class="action-btn btn-ra" id="btn-s-r-${rec.id}">☁️ Reply</button>
    </div>`;

    const panelStyle = showButtons ? '' : ' style="display:none"';
    return `
    <div class="action-panel" id="reply-panel-${rec.id}"${panelStyle}>
    ${buttonsHtml}
    <div id="sreply-wrap-${rec.id}" style="display:none"></div>
    <select id="drop-s-${rec.id}" style="display:none"></select>
    </div>`;
}

function buildContextChainHtml(rec) {
    const chain = rec.contextChain ? rec.contextChain : rec.context ? [rec.context] : [];
    if (chain.length === 0) return '';

    const totalKb   = (chain.reduce((sum, c) => sum + (c.text || '').length, 0) / 1024).toFixed(1);
    const itemsHtml = chain.map((item, idx) => buildContextItemHtml(rec, item, idx)).join('');

    return `
    <div class="context-chain">
    <div class="context-chain-header">🧠 Context items: <strong>${chain.length}</strong><span>~${totalKb} KB fed to AI</span></div>
    ${itemsHtml}
    </div>`;
}

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
    <button class="btn-unlink" onclick="unlinkContextPart(${rec.id},${idx},'input')" title="Remove input">✂️</button>
    <div class="context-preview">${inPrev}</div>
    <button class="action-btn" style="padding:4px 8px;flex-shrink:0;border-color:#2a6b3a;color:#4caf50" onclick="viewContextPart(${rec.id},${idx},'input')" title="View full">👁️</button>
    </div>
    </div>` : '';

    const outputBox = hasOutput ? `
    <div class="ctx-part-box ctx-output-box">
    <div class="context-item-row">
    <span class="ctx-size-label">🧠 ${fmtSize(outputText.length)}</span>
    <button class="btn-unlink" onclick="unlinkContextPart(${rec.id},${idx},'output')" title="Remove output">✂️</button>
    <div class="context-preview">${outPrev}</div>
    <button class="action-btn" style="padding:4px 8px;flex-shrink:0;border-color:#2a6b3a;color:#4caf50" onclick="viewContextPart(${rec.id},${idx},'output')" title="View full">👁️</button>
    </div>
    </div>` : '';

    return `
    <div class="context-item">
    <div class="context-item-title" role="button" tabindex="0" aria-label="Jump to source recording" onclick="scrollToRecording('${escapeJs(srcTs)}')">🔗 ${escapeHtml(item.label || 'Context ' + (idx + 1))}</div>
    ${inputBox}${outputBox}
    </div>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Dropdown wiring
 * ────────────────────────────────────────────────────────────────────────── */
function wireTranscriptDropdown(li, rec, allT, allS) {
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);
    if (!tDrop || allT.length === 0) return;

    const refreshPreview = () => {
        const t = allT.find(x => x.id == tDrop.value);
        if (!t) return;
        const prev = li.querySelector(`#tprev-${rec.id}`);
        if (prev) prev.innerHTML = `<div class="sel-preview-text">${escapeHtml((t.text || '').substring(0, 200))}</div>`
            + `<div class="sel-preview-foot"><button class="btn-copy" data-copy="t" data-rec="${rec.id}" title="Copy to clipboard">📋</button></div>`;
        wireCopyButtons(li, rec, allT, allS);
    };

    tDrop.addEventListener('change', () => {
        refreshPreview();
        renderReplies(li, rec, allT, allS, tDrop.value);
    });

    const tPrev = li.querySelector(`#tprev-${rec.id}`);
    if (tPrev) {
        tPrev.addEventListener('click', (e) => {
            if (e.target.closest('.btn-copy')) return;
            const busyBtn = li.querySelector(`#btn-t-l-${rec.id}[data-busy], #btn-t-r-${rec.id}[data-busy]`);
            if (busyBtn) { openLiveLogTab(rec.id, rec.filename); return; }
            const tId = tDrop.value;
            if (tId) window.viewTranscriptById(rec.id, tId);
        });
    }

    wireCopyButtons(li, rec, allT, allS);
    renderReplies(li, rec, allT, allS, allT[0].id);
}

function renderReplies(li, rec, allT, allS, activeTId, selectNewest = false) {
    const wrap  = li.querySelector(`#sreply-wrap-${rec.id}`);
    const sDrop = li.querySelector(`#drop-s-${rec.id}`);
    if (!wrap) return;

    const panel       = li.querySelector(`#reply-panel-${rec.id}`);
    const btnRow      = li.querySelector(`#reply-btns-${rec.id}`);
    const btnsVisible = btnRow && btnRow.style.display !== 'none';
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

    const prevSVal = (!selectNewest && sDrop) ? sDrop.value : null;
    const opts     = filteredS.map((s, idx) => {
        const num     = filteredS.length - idx;
        const size    = fmtSize((s.text || '').length);
        const snippet = escapeHtml((s.text || '').substring(0, 45));
        return `<option value="${escapeAttr(s.id)}">(${num}) [${escapeHtml(s.source)}] ${size} — ${snippet}…</option>`;
    }).join('');

    const activeS  = (prevSVal && filteredS.find(s => s.id == prevSVal))
        ? filteredS.find(s => s.id == prevSVal)
        : filteredS[0];
    const sPreview = escapeHtml((activeS.text || '').substring(0, 200));

    const selectorHtml = compact
        ? `<select class="action-drop" id="drop-s-inner-${rec.id}" style="display:none">${opts}</select>`
        : `<div class="sel-row">
        <button class="btn-item-del" onclick="deleteSummary(${rec.id}, document.getElementById('drop-s-${rec.id}').value)" title="Delete selected">🗑️</button>
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
        sPrev.addEventListener('click', (e) => {
            if (e.target.closest('.btn-copy')) return;
            const busyBtn = li.querySelector(`#btn-s-l-${rec.id}[data-busy], #btn-s-r-${rec.id}[data-busy]`);
            if (busyBtn) { openReplyStreamTab(rec.id, rec.filename); return; }
            const sId = sDrop ? sDrop.value : null;
            if (sId) window.viewSummaryById(rec.id, sId);
        });
    }

    wireCopyButtons(li, rec, allT, allS);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Copy-to-clipboard wiring
 * ────────────────────────────────────────────────────────────────────────── */
function wireCopyButtons(li, rec, allT, allS) {
    li.querySelectorAll('.btn-copy').forEach(btn => {
        if (btn._copyWired) return;
        btn._copyWired = true;

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const type  = btn.dataset.copy;
            const recId = Number(btn.dataset.rec);
            const fresh = await dbExec(CONFIG.STORE_REC, 'get', recId);
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

/* ──────────────────────────────────────────────────────────────────────────
 * Button wiring
 * ────────────────────────────────────────────────────────────────────────── */
function wireScribeButtons(li, rec) {
    bindScribeBtn(li, `#btn-t-l-${rec.id}`, rec, 'local',  '💻 Scribe');
    bindScribeBtn(li, `#btn-t-r-${rec.id}`, rec, 'remote', '☁️ Scribe');
}

function bindScribeBtn(li, selector, rec, source, defaultLabel) {
    const btn = li.querySelector(selector);
    if (!btn) return;

    btn.onclick = async () => {
        if (btn.dataset.busy) { openLiveLogTab(rec.id, rec.filename); return; }
        btn.dataset.busy = '1';
        btn.classList.add('processing');
        liveLogClear(rec.id);
        showLiveStatus(rec.id, 'scribe', '📝 Starting…',
            () => openLiveLogTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));
        try {
            await transcribeChunked(rec.id, source, txt => {
                btn.textContent = txt;
                updateLiveStatus(rec.id, 'scribe', `📝 ${txt}`);
            });
            removeLiveStatus(rec.id, 'scribe');
            renderList();
        } catch (e) {
            removeLiveStatus(rec.id, 'scribe');
            delete btn.dataset.busy;
            btn.classList.remove('processing');
            if (e && e.name === 'AbortError') { btn.textContent = defaultLabel; renderList(); }
            else { btn.textContent = 'Error'; alert(e.message); }
        }
    };
}

function wireReplyButtons(li, rec, allT, allS) {
    bindReplyBtn(li, `#btn-s-l-${rec.id}`, rec, allT, allS, runLocalSummary,  '💻 Reply');
    bindReplyBtn(li, `#btn-s-r-${rec.id}`, rec, allT, allS, runRemoteSummary, '☁️ Reply');
}

function bindReplyBtn(li, selector, rec, allT, allS, func, defaultLabel) {
    const btn = li.querySelector(selector);
    if (!btn) return;
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);

    btn.onclick = async () => {
        if (btn.dataset.busy) { openReplyStreamTab(rec.id, rec.filename); return; }

        btn.dataset.busy = '1';
        btn.classList.add('processing');
        btn.textContent = '⏳ Waiting...';
        replyStreamInit(rec.id);
        // Honest status (no fake countdown) + a ✕ that actually cancels the job.
        showLiveStatus(rec.id, 'reply', '🧠 Waiting for first token… (tap to watch)',
            () => openReplyStreamTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));

        const activeTId = tDrop ? tDrop.value : null;
        try {
            await func(rec.id, txt => {
                if (txt === '__first_token__') {
                    btn.textContent = '⚡ Streaming...';
                    updateLiveStatus(rec.id, 'reply', '⚡ Streaming… (tap to watch)');
                } else {
                    btn.textContent = txt;
                }
            }, activeTId);

            const freshRec = await dbExec(CONFIG.STORE_REC, 'get', rec.id);
            const freshS   = freshRec.summaries || [];
            freshS.forEach((s) => { if (!s.id) s.id = s.time || uid(); });
            allS.length = 0;
            freshS.forEach(s => allS.push(s));
            btn.textContent = defaultLabel;
            delete btn.dataset.busy;
            btn.classList.remove('processing');
            removeLiveStatus(rec.id, 'reply');
            if (isCompact()) renderList();
            else             renderReplies(li, rec, allT, allS, activeTId, true);
        } catch (e) {
            delete btn.dataset.busy;
            btn.classList.remove('processing');
            removeLiveStatus(rec.id, 'reply');
            if (e && e.name === 'AbortError') { btn.textContent = defaultLabel; }
            else { btn.textContent = 'Error'; alert(e.message); }
        }
    };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Pagination
 * ────────────────────────────────────────────────────────────────────────── */
function renderPagination(totalItems, totalPages) {
    const pgWrap = document.getElementById('pagination');
    const info   = document.getElementById('pageInfo');
    const prev   = document.getElementById('prevPageBtn');
    const next   = document.getElementById('nextPageBtn');

    if (totalPages <= 1) { pgWrap.hidden = true; return; }
    pgWrap.hidden = false;
    info.textContent = `${UI.curPage + 1} / ${totalPages}`;
    prev.disabled = UI.curPage === 0;
    next.disabled = UI.curPage >= totalPages - 1;

    prev.onclick = () => { UI.curPage = Math.max(0, UI.curPage - 1); renderList(); };
    next.onclick = () => { UI.curPage = Math.min(totalPages - 1, UI.curPage + 1); renderList(); };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Continue conversation — exposed globally for inline onclick
 * ────────────────────────────────────────────────────────────────────────── */
window.continueConv = async (recId) => {
    const rec   = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const tDrop = document.getElementById(`drop-t-${recId}`);
    const sDrop = document.getElementById(`drop-s-${recId}`);

    let inputText = '', outputText = '';
    let tNum = '?', sNum = '?';

    if (tDrop && tDrop.value) {
        const tIdx = rec.transcripts.findIndex(t => t.id == tDrop.value);
        if (tIdx > -1) {
            const t = rec.transcripts[tIdx];
            inputText = t.plain || t.text;   // prefer plain (no timestamps) for LLM context
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
        srcTimestamp
    };

    const parentChain = rec.contextChain ? [...rec.contextChain]
                      : rec.context ? [rec.context]
                      : [];
    AppState.pendingContext = [...parentChain, newItem];
    window.scrollTo(0, 0);
    startRecording();
};
