/* ==========================================================================
 * gui.js - Recording list rendering, button bindings, continue-conversation
 * ========================================================================== */
import { CONFIG, fmtDur, fmtSize, fmtBytes, uid, escapeHtml, escapeAttr, getSetting } from './config.js';
import { dbExec, dbUpdate, getRecordingsPage, getStorageTotal, calcTotalStorage } from './db.js';
import { displayTitle, buildDownloadName, storagePct, contextStats, byteLength } from './naming.js';
import { recordingExt, storedFormat, needsConversion, pickOpusMime } from './audio-format.js';
import { inspectPcmWav } from './audio.js';
import { makeWebmSeekable, WEBM_SEEKABLE_VERSION } from './webm-duration.js';
import { isLivePlayerId, shouldRewindOnEnded, resolvePlayerTotalSec, playerFraction } from './player-core.js';
import { transcribeChunked }         from './transcribe.js';
import { runSummary } from './reply.js';
import {
    liveLogClear, openLiveLogTab, openReplyStreamTab, replyStreamInit,
    showLiveStatus, updateLiveStatus, removeLiveStatus
} from './live-tabs.js';
import { AppState, startRecording, buildLivePreviewBlob }  from './recorder.js';
import { isCompact }                 from './settings.js';
import { isRecordOwnedByLiveTab }     from './recording-lock.js';

const UI = {
    list:    document.getElementById('recordingsList'),
    btn:     document.getElementById('recordBtn'),
    curPage: 0
};

// Jump the list back to the newest page. Called whenever a recording STARTS so the
// new "LIVE" row (always the newest timestamp, hence page 0) is actually on screen -
// otherwise starting a recording while paged back left the live play bar invisible
// until you manually navigated to page 0. renderList() paints the current page.
export function resetListToFirstPage() { UI.curPage = 0; }

// Track audio object URLs so they can be revoked before each re-render.
// Previously these were recreated on every paint and never freed (memory leak).
const _objectUrls = new Map();   // recId -> objectURL
function revokeAllObjectUrls() {
    for (const url of _objectUrls.values()) { try { URL.revokeObjectURL(url); } catch (_) {} }
    _objectUrls.clear();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Link set - a transient basket of recordings to chain into ONE new recording
 *
 * To reply to several past notes at once: tap "➕ Link" on each recording you
 * want, then "Record reply from N linked" in the floating tray. That seeds the
 * next recording's contextChain with each linked note's newest transcript + reply
 * (the exact same item shape continueConv produces), so the reply step already
 * knows how to feed them all to the AI. Record a short instruction, or nothing,
 * and stop: the reply answers the whole set.
 *
 * Kept in memory only (a cart, not saved state): it lives outside the DOM, so it
 * survives the innerHTML rebuild on every paint and page changes, and is cleared
 * once consumed. Maps recId → short timestamp label (for the tray chips); Map
 * preserves insertion order, so the context is chained in the order you linked.
 * ────────────────────────────────────────────────────────────────────────── */
const linkSet = new Map();   // recId -> timestamp label

// Flip a single row's Link button between states without a full re-render (keeps
// scroll position and live <audio> intact). No-op if that row isn't on this page.
function updateLinkButton(recId) {
    const btn = document.getElementById(`btn-link-${recId}`);
    if (!btn) return;
    const on = linkSet.has(recId);
    btn.classList.toggle('linked', on);
    btn.textContent = on ? '✅ Linked' : '➕ Link';
}

// Paint the floating tray from linkSet. Hidden when empty, and while recording
// (the visualizer footer owns the bottom of the screen then, the basket waits).
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

/* ──────────────────────────────────────────────────────────────────────────
 * Live playback preview for the in-progress recording
 *
 * The active recording's row carries a real <audio> player that replays what's
 * been captured SO FAR, while you're still recording. Its source is rebuilt
 * from the 4-second WAV chunks already flushed to IndexedDB (buildLivePreviewBlob)
 * on a timer, so the seek bar / duration GROWS over time - but the rebuild only
 * happens while the player is PAUSED, so a refresh never cuts off audio you're
 * actively listening to. When paused mid-scrub, the playhead is preserved across
 * the swap (the new, longer blob shares the same prefix audio, so the old
 * currentTime is still valid). Exactly one recording is ever live, so a single
 * module-level timer suffices.
 *
 * Teardown is driven two ways, for safety in depth:
 *   1. _liveTick bails the instant AppState.recId stops matching (recording
 *      ended) - so we never read chunks finalize is about to delete; and
 *   2. _renderListNow calls stopLivePreview() before each rebuild (it only runs
 *      when nothing is playing, since renderList defers during playback).
 * ────────────────────────────────────────────────────────────────────────── */
const LIVE_REFRESH_MS = CONFIG.IO_FLUSH_SEC * 1000;   // align rebuilds with the 4 s chunk flush
const LIVE_TAIL_SEC   = 1.6;    // while playing, extend once the playhead is this close to the end
let _liveTimer     = null;
let _liveUrl       = null;      // current object URL for the live player (revoked on swap/teardown)
let _liveLastBuild = 0;         // ms timestamp of the last blob rebuild (throttle gate)
let _liveSnapSeq   = -1;        // chunk count captured in the current snapshot (detects growth)
let _liveBuilding  = false;     // guard against overlapping async rebuilds

function stopLivePreview() {
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
    // Safe to revoke even if the <audio> is mid-playback: once a media element
    // has loaded a blob URL the data is retained, and revoke only blocks NEW
    // loads (per the URL.createObjectURL contract).
    if (_liveUrl) { try { URL.revokeObjectURL(_liveUrl); } catch (_) {} _liveUrl = null; }
    _liveLastBuild = 0;
    _liveSnapSeq   = -1;
    _liveBuilding  = false;
}

// Number of 4 s chunks flushed so far for the active recording (WAV or Opus).
function liveChunkCount() {
    return AppState.recFormat === 'opus' ? (AppState.opusSeq || 0) : (AppState.wavSeq || 0);
}

// Rebuild the live snapshot so it includes the newest chunks, preserving the
// play position and (optionally) resuming so playback keeps going past the old
// end. This is what makes the live player follow the still-growing recording
// instead of stopping at whatever length existed when playback began.
async function _rebuildLiveSnapshot(recId, audio, resume) {
    if (_liveBuilding) return;
    _liveBuilding = true;
    try {
        const seqAtBuild = liveChunkCount();
        const blob = await buildLivePreviewBlob(recId);
        if (!blob || AppState.recId !== recId) return;    // nothing flushed yet, or recording ended
        _liveLastBuild = Date.now();
        _liveSnapSeq   = seqAtBuild;

        const resumeAt = audio.currentTime || 0;
        const prevUrl  = _liveUrl;
        const url      = URL.createObjectURL(blob);
        _liveUrl = url;

        audio.addEventListener('loadedmetadata', () => {
            // Seek back to where playback was (the new, longer blob shares the
            // same prefix, so the old position is still valid) and resume if we
            // were playing, so playback flows into the freshly captured audio.
            if (resumeAt > 0 && (!isFinite(audio.duration) || resumeAt <= audio.duration)) {
                try { audio.currentTime = resumeAt; } catch (_) {}
            }
            if (resume) audio.play().catch(() => {});
            const pl = audio.closest('.player'); if (pl) paintPlayer(pl);
            const hint = document.getElementById(`live-hint-${recId}`);
            if (hint) hint.textContent = '▶ replay captured so far';
        }, { once: true });

        audio.src = url;
        audio.load();
        if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch (_) {} }
    } finally {
        _liveBuilding = false;
    }
}

async function _liveTick(recId) {
    // Recording ended (or moved on) → stop touching the DB chunks finalize is
    // about to delete, and let the post-finalize renderList paint the master.
    if (AppState.recId !== recId) { stopLivePreview(); return; }

    const audio = document.getElementById(`live-audio-${recId}`);
    if (!audio) { stopLivePreview(); return; }          // row no longer in the DOM
    const playerEl = audio.closest('.player');

    // Loaded playable seconds. WAV reports a real duration; Opus/WebM reports
    // Infinity, so estimate from the chunk count (each chunk is IO_FLUSH_SEC).
    const dur = (isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : Math.max(0, _liveSnapSeq) * CONFIG.IO_FLUSH_SEC;
    const hasNewChunk = liveChunkCount() > _liveSnapSeq;                  // a fresh 4 s chunk exists
    const playing     = !audio.paused && !audio.ended;

    // The live bar's total is the ELAPSED recording time, not the loaded
    // snapshot length. Elapsed grows smoothly and monotonically, so as long as
    // playback keeps advancing (we extend below) the fill never jumps backward -
    // it just chases the live edge, staying however-many-seconds behind. Freeze
    // it only while paused mid-playback so the thumb doesn't drift; it keeps
    // growing before first play and during playback.
    const midPause = audio.paused && !audio.ended && audio.currentTime > 0;
    if (playerEl && AppState.startTime) {
        // While playing (or before first play) the bar total is ELAPSED recording
        // time, so it chases the live edge. When PAUSED mid-playback, pin it to the
        // LOADED (seekable) length instead: elapsed can exceed what's buffered, and
        // using it let the scrubber sit past audio playback couldn't actually reach
        // (click at 90%, playback stuck at the loaded end). `dur` is the loaded/known
        // length, and currentTime never exceeds it, so the fill stays <= 100%.
        playerEl.dataset.dur = midPause
            ? String(Math.round(dur * 1000))
            : String(Date.now() - AppState.startTime);
    }
    if (playerEl) paintPlayer(playerEl);

    if (playing) {
        // Extend just before running out so playback continues seamlessly-ish;
        // if nothing new has flushed yet, let it play to the edge and pick up
        // below once the next chunk lands.
        if (hasNewChunk && dur > 0 && (dur - audio.currentTime) <= LIVE_TAIL_SEC) {
            await _rebuildLiveSnapshot(recId, audio, true);
        }
        return;
    }

    // Reached the snapshot edge but more audio has since been captured → continue.
    if (audio.ended && hasNewChunk) {
        await _rebuildLiveSnapshot(recId, audio, true);
        return;
    }

    // Paused (or nothing loaded yet): refresh on the flush cadence so hitting play
    // uses the latest audio. Nothing to do if the user paused and nothing arrived.
    if (_liveSnapSeq < 0 || (hasNewChunk && Date.now() - _liveLastBuild >= LIVE_REFRESH_MS - 50)) {
        await _rebuildLiveSnapshot(recId, audio, false);
    }
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

/* Seek-fix for Opus/WebM players. MediaRecorder omits the duration element, so a
 * finalized WebM/Opus <audio> reports duration = Infinity and its seek bar is
 * dead. The documented workaround is to nudge currentTime past the end once,
 * which forces the browser to scan and set a real duration, then snap back to 0.
 * Guarded to fire ONLY on non-finite duration (so WAV, which is already correct,
 * is never touched) and never on the live-preview element (its stream is still
 * growing, so its duration is legitimately unknown). loadedmetadata does not
 * bubble, so this is wired in the capture phase. */
if (UI.list && !UI.list._seekFixWired) {
    UI.list._seekFixWired = true;
    UI.list.addEventListener('loadedmetadata', (e) => {
        const a = e.target;
        if (!a || a.tagName !== 'AUDIO') return;
        if (isLivePlayerId(a.id)) return;   // live stream: leave alone
        if (isFinite(a.duration) && a.duration > 0) return;       // WAV / already known
        if (a._durationFixed) return;
        a._durationFixed = true;
        const onSeeked = () => {
            a.removeEventListener('seeked', onSeeked);
            try { a.currentTime = 0; } catch (_) {}
        };
        a.addEventListener('seeked', onSeeked);
        try { a.currentTime = 1e101; } catch (_) {}
    }, true);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Custom audio player. Replaces the native <audio controls> so the seek bar is
 * driven by rec.durationMs (the length we already know) instead of the browser's
 * audio.duration, which reads as Infinity for Opus/WebM. That keeps play + seek
 * working for BOTH formats. Wired once (delegated) on the stable list so it
 * survives every innerHTML rebuild; per-<audio> progress listeners attach lazily
 * on first play. Pointer events cover mouse and touch for drag-to-seek.
 * ────────────────────────────────────────────────────────────────────────── */
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
    // role="slider" needs live value semantics or a screen reader announces nothing.
    if (scrub) {
        scrub.setAttribute('aria-valuemin', '0');
        scrub.setAttribute('aria-valuemax', String(Math.round(total)));
        scrub.setAttribute('aria-valuenow', String(Math.round(cur)));
        scrub.setAttribute('aria-valuetext', `${fmtDur(cur * 1000)} of ${fmtDur(total * 1000)}`);
    }
}

function wirePlayerAudio(playerEl) {
    const audio = playerEl.querySelector('audio');
    if (!audio || audio._playerBound) return;
    audio._playerBound = true;
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange']
        .forEach(ev => audio.addEventListener(ev, () => paintPlayer(playerEl)));
    // When a finalized track finishes with repeat OFF, rewind to the start (bar
    // back to 0) but stay paused - the user presses play to hear it again. With
    // repeat ON the browser loops seamlessly and 'ended' never fires, so there's
    // no conflict. The live-preview audio is left alone: its extension logic owns
    // what happens at the end while a recording is still growing.
    audio.addEventListener('ended', () => {
        if (shouldRewindOnEnded(audio.id, audio.loop)) { try { audio.currentTime = 0; } catch (_) {} }
        paintPlayer(playerEl);
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
        // Repeat/loop toggle.
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
            audio.play().catch(() => {});
        } else {
            audio.pause();
        }
    });

    // Drag-to-seek (pointer events = mouse + touch). Seek on press, follow on move.
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

    // Keyboard seeking on the focused scrubber (arrow keys, 5 s steps).
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

/* ──────────────────────────────────────────────────────────────────────────
 * Editable recording title. The .rec-filename span carries data-edit-title;
 * clicking it (or pressing Enter/Space on it) swaps it for an <input>. Enter or
 * blur saves, Escape cancels. Delegated once on the stable list container so it
 * survives every innerHTML rebuild. Only the human name (rec.title) is written;
 * rec.filename - the timestamp key other features match on - is never touched.
 * ────────────────────────────────────────────────────────────────────────── */
function startTitleEdit(span) {
    if (!span || span.dataset.editing) return;
    const id      = span.dataset.rec;
    const current = span.textContent;
    span.dataset.editing = '1';

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'rec-title-input';
    input.value       = current;
    input.setAttribute('aria-label', 'Recording title');
    span.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        if (save) window.saveRecTitle(id, input.value);   // saves + repaints
        else      renderList();                            // cancel → restore span
    };
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
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

/* ──────────────────────────────────────────────────────────────────────────
 * renderList - main paint function (called after every data mutation)
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
        if (_pendingRender) return;             // already deferred - coalesce
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

    // Keep the link tray in sync with this paint: recording just started → hide
    // it; recording ended → show it again if the basket still has items. It reads
    // linkSet + AppState.recId, so a single call here covers every state change.
    renderLinkTray();
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
    const safeName       = escapeHtml(displayTitle(rec));

    if (rec.processing) {
        // The genuinely-live recording (this row IS the active capture) gets a
        // working play bar that replays audio-so-far and grows every ~4 s. Other
        // "processing" rows (crash-recovery finalize, etc.) have no live capture
        // and their chunks may be mid-delete, so they keep the simple spinner.
        const isLive = AppState.recId != null && rec.id === AppState.recId;
        const isOtherTabLive = !isLive && isRecordOwnedByLiveTab(rec);
        if ((isLive && !AppState.captureError) || isOtherTabLive) li.classList.add('rec-item-live');
        if (isOtherTabLive) {
            li.innerHTML = `
            <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span class="live-rec-clock other-tab-live-clock" data-rec-id="${rec.id}">${fmtDur(rec.durationMs || 0)}</span> <span class="live-rec-badge"><span class="dot"></span>LIVE · OTHER TAB</span></div>
            <div class="live-rec-meta"><span style="opacity:.7">This recording is protected by the global lock. Stop it in the tab that owns the microphone.</span></div>`;
            return li;
        }
        if (!isLive) {
            if (rec.captureState === 'finalize-error') {
                li.innerHTML = `
                <div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span></div>
                <div class="rec-error" role="alert">Finalization failed: ${escapeHtml(rec.finalizationError || 'Unknown error')}</div>
                <div class="btn-row">
                  <button class="action-btn" data-action="retryFinalizeRec" data-rec-id="${rec.id}">Retry finalization</button>
                  <button class="action-btn btn-delete" data-action="deleteRec" data-rec-id="${rec.id}">Delete</button>
                </div>`;
            } else {
                li.innerHTML = `<div class="rec-top">🎙️ <span class="rec-filename">${safeName}</span> <span style="color:#ffc107">⏳ Recovering recording...</span></div>`;
            }
            return li;
        }
        if (isLive && AppState.captureError) {
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
          <button class="player-play" aria-label="Play / pause">▶</button>
          <div class="player-scrub" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="player-track"><div class="player-fill"></div><div class="player-thumb"></div></div></div>
          <span class="player-time">${fmtDur(0)} / ${fmtDur(0)}</span>
        </div></div>
        <div class="live-rec-meta"><span id="live-hint-${rec.id}" style="opacity:.55">⏱️ capturing first ${CONFIG.IO_FLUSH_SEC}s…</span></div>`;
        return li;
    }

    // ── Storage bar ── size of THIS recording, plus a bar sized as a fraction of
    // all audio stored, so it's easy to spot at a glance which notes eat the most
    // space (the reason a bar beats a bare "12.3 MB" label).
    const size       = rec.blob ? rec.blob.size : 0;
    const pct        = storagePct(size, getStorageTotal());
    const pctLabel   = pct < 10 ? pct.toFixed(1) : Math.round(pct);
    const storageBar = rec.blob ? `
    <div class="rec-storage" title="${fmtBytes(size)} - ${pctLabel}% of all audio stored">
      <div class="rec-storage-track"><div class="rec-storage-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <span class="rec-storage-label">${fmtBytes(size)} · ${pctLabel}%</span>
    </div>` : '';

    // ── Format badge ── always reflects how THIS recording is stored.
    // The recording preference only changes whether a WAV badge becomes the
    // optional WAV → OPUS conversion action; it must never hide codec metadata.
    const pref     = getSetting('set-recording-format');
    const recFmt   = storedFormat(rec);
    const fmtBadge = rec.blob
        ? (needsConversion(pref, rec)
            ? `<button class="fmt-badge fmt-convert" data-fmt-rec="${rec.id}" data-action="convertRecFormat" data-rec-id="${rec.id}" title="Stored as WAV. Tap to convert just this recording to ${pref.toUpperCase()} and reclaim space.">${recFmt.toUpperCase()} → ${pref.toUpperCase()}</button>`
            : `<span class="fmt-badge fmt-current" title="Stored as ${recFmt.toUpperCase()}">${recFmt.toUpperCase()}</span>`)
        : '';

    const showScribeButtons  = !compact || !hasTranscripts;
    const showScribeSelector = !compact && hasTranscripts;
    const showReplyButtons   = !compact || (hasTranscripts && !hasReplies);

    // ── Scribe panel ──
    const scribeButtonsHtml = showScribeButtons ? `
    <div class="btn-row" id="scribe-btns-${rec.id}">
    <button class="action-btn btn-scribe" id="btn-t-${rec.id}" title="Transcribe with the configured server">📝 Scribe</button>
    </div>` : `
    <div class="btn-row" id="scribe-btns-${rec.id}" style="display:none">
    <button class="action-btn btn-scribe" id="btn-t-${rec.id}">📝 Scribe</button>
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
    const pipelineErrorHtml = rec.pipelineError
        ? `<div class="rec-error" role="alert">Automatic AI step failed: ${escapeHtml(rec.pipelineError)}</div>`
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

    // ── Continue / Link buttons ──
    // Continue = extend THIS one note into a linear follow-up. Link = add this
    // note to the multi-select basket (tray) to chain several into one reply.
    const continueBtn = hasTranscripts
        ? `<button class="action-btn btn-continue" id="btn-continue-${rec.id}" data-action="continueConv" data-rec-id="${rec.id}" title="Continue conversation" aria-label="Continue conversation">💬</button>`
        : '';
    const linked  = linkSet.has(rec.id);
    const linkBtn = hasTranscripts
        ? `<button class="action-btn btn-link${linked ? ' linked' : ''}" id="btn-link-${rec.id}" data-action="toggleLinkRec" data-rec-id="${rec.id}" data-link-label="${escapeAttr((rec.filename || '').split(' - ')[0])}" title="${linked ? 'Linked (in the link set)' : 'Link (add to the link set)'}" aria-label="${linked ? 'Linked' : 'Link recording'}">${linked ? '✅' : '🔗'}</button>`
        : '';

    li.innerHTML = `
    <div class="rec-top"><span class="rec-filename" role="button" tabindex="0" data-edit-title data-rec="${rec.id}" title="Click to rename this recording">${safeName}</span>${fmtBadge}</div>
    ${storageBar}
    ${objectUrl ? `<div class="rec-player"><div class="player" data-dur="${rec.durationMs || 0}">
      <audio src="${objectUrl}" preload="metadata"></audio>
      <button class="player-play" aria-label="Play / pause">▶</button>
      <div class="player-scrub" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="${Math.round((rec.durationMs || 0) / 1000)}" aria-valuenow="0"><div class="player-track"><div class="player-fill"></div><div class="player-thumb"></div></div></div>
      <span class="player-time">${fmtDur(0)} / ${fmtDur(rec.durationMs || 0)}</span>
      <button class="player-loop" aria-label="Repeat" aria-pressed="false" title="Repeat">🔁</button>
    </div></div>` : '<div style="color:red">Audio unavailable</div>'}
    ${scribePanelHtml}
    ${replyPanelHtml}
    <div class="bottom-actions" id="bottom-actions-${rec.id}">
    ${rec.blob ? `<button class="action-btn btn-download" data-action="downloadRec" data-rec-id="${rec.id}" title="Download (the only way to keep it permanently)" aria-label="Download recording">⬇️</button>` : ''}
    <button class="action-btn btn-delete" data-action="deleteRec" data-rec-id="${rec.id}" title="Delete" aria-label="Delete recording">🗑️</button>
    ${continueBtn}
    ${linkBtn}
    </div>
    ${contextChainHtml}
    ${captureWarningHtml}
    ${pipelineErrorHtml}
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
    <div class="btn-row" id="reply-btns-${rec.id}" style="display:none">
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

// Recordings whose context chain is expanded. Kept across re-renders so a paint
// (which rebuilds innerHTML) preserves what the user opened.
const _expandedChains = new Set();

// Which transcript / reply the user has selected in each recording's dropdowns.
// renderList() rebuilds innerHTML, so without this an unrelated background paint
// (an auto-pipeline finishing on another row, a reply landing) silently snapped a
// deliberately-chosen transcript/reply back to the newest. We restore the chosen id
// when it still exists, and otherwise fall back to newest (identical to the old
// behaviour on first paint). Keyed by rec id; entries are tiny.
const _selectedTId = new Map();   // recId -> transcript id
const _selectedSId = new Map();   // recId -> reply/summary id

function buildContextChainHtml(rec) {
    const chain = rec.contextChain ? rec.contextChain : rec.context ? [rec.context] : [];
    if (chain.length === 0) return '';

    // Two numbers for the collapsed row: parts fed to the AI (each non-empty
    // input/output = 1) and the exact total bytes of that context.
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

// Expand/collapse a recording's context chain in place (no full re-render, so
// playback and scroll are untouched); remember the choice for future paints.
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
    <div class="context-preview">${inPrev}</div>
    <button class="action-btn" style="padding:4px 8px;flex-shrink:0;border-color:#2a6b3a;color:#4caf50" data-action="viewContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input" title="View full">👁️</button>
    </div>
    </div>` : '';

    const outputBox = hasOutput ? `
    <div class="ctx-part-box ctx-output-box">
    <div class="context-item-row">
    <span class="ctx-size-label">🧠 ${fmtSize(outputText.length)}</span>
    <button class="btn-unlink" data-action="unlinkContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="output" title="Remove output">✂️</button>
    <div class="context-preview">${outPrev}</div>
    <button class="action-btn" style="padding:4px 8px;flex-shrink:0;border-color:#2a6b3a;color:#4caf50" data-action="viewContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="output" title="View full">👁️</button>
    </div>
    </div>` : '';

    return `
    <div class="context-item">
    <div class="context-item-title" role="button" tabindex="0" aria-label="Jump to source recording" data-action="scrollToRecording" data-source-ref="${escapeAttr(item.sourceRecId ?? srcTs)}">🔗 ${escapeHtml(item.label || 'Context ' + (idx + 1))}</div>
    ${inputBox}${outputBox}
    </div>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Dropdown wiring
 * ────────────────────────────────────────────────────────────────────────── */
function wireTranscriptDropdown(li, rec, allT, allS) {
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);
    if (!tDrop || allT.length === 0) return;

    // Restore the previously-selected transcript if it still exists; else newest
    // (allT[0]). The <select> markup defaults to option 0, so we override here.
    const rememberedT = _selectedTId.get(rec.id);
    const initialTId  = (rememberedT != null && allT.some(t => t.id == rememberedT))
        ? rememberedT : allT[0].id;
    tDrop.value = initialTId;
    _selectedTId.set(rec.id, initialTId);

    const refreshPreview = () => {
        const t = allT.find(x => x.id == tDrop.value);
        if (!t) return;
        const prev = li.querySelector(`#tprev-${rec.id}`);
        if (prev) prev.innerHTML = `<div class="sel-preview-text">${escapeHtml((t.text || '').substring(0, 200))}</div>`
            + `<div class="sel-preview-foot"><button class="btn-copy" data-copy="t" data-rec="${rec.id}" title="Copy to clipboard">📋</button></div>`;
        wireCopyButtons(li, rec, allT, allS);
    };

    tDrop.addEventListener('change', () => {
        _selectedTId.set(rec.id, tDrop.value);
        refreshPreview();
        renderReplies(li, rec, allT, allS, tDrop.value);
    });

    if (initialTId != allT[0].id) refreshPreview();   // sync preview to the restored pick

    const tPrev = li.querySelector(`#tprev-${rec.id}`);
    if (tPrev) {
        tPrev.addEventListener('click', (e) => {
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

    const opts     = filteredS.map((s, idx) => {
        const num     = filteredS.length - idx;
        const size    = fmtSize((s.text || '').length);
        const snippet = escapeHtml((s.text || '').substring(0, 45));
        return `<option value="${escapeAttr(s.id)}">(${num}) [${escapeHtml(s.source)}] ${size} - ${snippet}…</option>`;
    }).join('');

    // selectNewest (a reply just generated) forces the newest. Otherwise restore the
    // remembered reply if it's in this transcript's filtered set, then any live
    // dropdown value (in-place refresh), else newest. Remember whatever we land on.
    const rememberedS = _selectedSId.get(rec.id);
    const prevSVal    = (!selectNewest && sDrop) ? sDrop.value : null;
    const activeS =
        selectNewest ? filteredS[0]
        : (rememberedS != null && filteredS.find(s => s.id == rememberedS)) ? filteredS.find(s => s.id == rememberedS)
        : (prevSVal && filteredS.find(s => s.id == prevSVal)) ? filteredS.find(s => s.id == prevSVal)
        : filteredS[0];
    _selectedSId.set(rec.id, activeS.id);
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
            _selectedSId.set(rec.id, s.id);
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
            const busyBtn = li.querySelector(`#btn-s-${rec.id}[data-busy]`);
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
    const button = li.querySelector(`#btn-t-${rec.id}`);
    if (!button) return;

    button.onclick = async () => {
        if (button.dataset.busy) {
            openLiveLogTab(rec.id, rec.filename);
            return;
        }

        button.disabled = true;
        button.dataset.busy = '1';
        button.classList.add('processing');
        liveLogClear(rec.id);
        showLiveStatus(rec.id, 'scribe', '📝 Starting…',
            () => openLiveLogTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));
        try {
            await transcribeChunked(rec.id, text => {
                button.textContent = text;
                updateLiveStatus(rec.id, 'scribe', `📝 ${text}`);
            });
            removeLiveStatus(rec.id, 'scribe');
            await renderList();
        } catch (error) {
            removeLiveStatus(rec.id, 'scribe');
            if (error && error.name === 'AbortError') {
                button.textContent = '📝 Scribe';
                await renderList();
            } else {
                button.textContent = 'Error';
                alert(error.message);
            }
        } finally {
            button.disabled = false;
            delete button.dataset.busy;
            button.classList.remove('processing');
        }
    };
}

function wireReplyButtons(li, rec, allT, allS) {
    const button = li.querySelector(`#btn-s-${rec.id}`);
    if (!button) return;
    const tDrop = li.querySelector(`#drop-t-${rec.id}`);

    button.onclick = async () => {
        if (button.dataset.busy) {
            openReplyStreamTab(rec.id, rec.filename);
            return;
        }

        button.disabled = true;
        button.dataset.busy = '1';
        button.classList.add('processing');
        button.textContent = '⏳ Waiting...';
        replyStreamInit(rec.id);
        showLiveStatus(rec.id, 'reply', '🧠 Waiting for first token… (tap to watch)',
            () => openReplyStreamTab(rec.id, rec.filename),
            () => window.cancelRecJob(rec.id));

        const activeTId = tDrop ? tDrop.value : null;
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
            if (isCompact()) await renderList();
            else renderReplies(li, rec, allT, allS, activeTId, true);
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

window.showRecordingById = async function showRecordingById(recId) {
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const index = all.findIndex(rec => rec.id == recId);
    if (index < 0) return false;
    UI.curPage = Math.floor(index / CONFIG.PAGE_SIZE);
    await renderList();
    const element = document.getElementById(`rec-${recId}`);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        element.classList.add('rec-highlight');
        setTimeout(() => element.classList.remove('rec-highlight'), 1600);
    }
    return !!element;
};

/* ──────────────────────────────────────────────────────────────────────────
 * Continue conversation - exposed globally for delegated actions
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
        srcTimestamp,
        sourceRecId: rec.id
    };

    const parentChain = rec.contextChain ? [...rec.contextChain]
                      : rec.context ? [rec.context]
                      : [];
    AppState.pendingContext = [...parentChain, newItem];
    UI.curPage = 0;                     // ensure the new LIVE row is on the visible page
    window.scrollTo(0, 0);
    startRecording();
};

/* ──────────────────────────────────────────────────────────────────────────
 * Link set actions - exposed globally for delegated actions
 * ────────────────────────────────────────────────────────────────────────── */
function toggleLinkRec(recId, tsLabel) {
    if (linkSet.has(recId)) linkSet.delete(recId);
    else                    linkSet.set(recId, tsLabel || '');
    updateLinkButton(recId);
    renderLinkTray();
}

function removeLinkedRec(recId) {
    linkSet.delete(recId);
    updateLinkButton(recId);   // un-highlight its row button if it's on this page
    renderLinkTray();
}

function clearLinkedRecs() {
    const ids = [...linkSet.keys()];
    linkSet.clear();
    ids.forEach(updateLinkButton);
    renderLinkTray();
}

/**
 * Start a new recording seeded with every linked recording as prior context.
 * Each linked note contributes its NEWEST transcript (input) and NEWEST reply
 * (output), packaged as a contextChain item, the same shape continueConv builds,
 * so buildContextAwarePrompt/buildSummaryInput already feed them to the AI, and
 * buildContextChainHtml already renders them (with the existing ✂️/👁️ controls)
 * under the new recording. Record a short instruction, or nothing, then stop: the
 * reply answers the whole linked set. We chain each note's own content only (not
 * its ancestors) so the context stays predictable - "the items you linked".
 */
async function recordFromLinked() {
    if (AppState.recId || AppState.busy) return;        // already recording/starting
    const ids = [...linkSet.keys()];
    if (ids.length === 0) return;

    const items = [];
    for (const id of ids) {
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        if (!rec) continue;                             // deleted since it was linked
        const t = (rec.transcripts && rec.transcripts[0]) || null;   // [0] = newest
        const s = (rec.summaries   && rec.summaries[0])   || null;
        const inputText  = t ? (t.plain || t.text || '') : '';   // prefer plain (no timestamps) for the LLM
        const outputText = s ? (s.text || '') : '';
        if (!inputText && !outputText) continue;        // nothing usable to feed
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
    linkSet.clear();                    // basket consumed
    renderLinkTray();
    UI.curPage = 0;                     // ensure the new LIVE row is on the visible page
    window.scrollTo(0, 0);
    startRecording();                   // consumes pendingContext → new recording's contextChain
}

window.toggleLinkRec    = toggleLinkRec;
window.removeLinkedRec  = removeLinkedRec;
window.clearLinkedRecs  = clearLinkedRecs;
window.recordFromLinked = recordFromLinked;

/* Rename a recording. Stores the human name in rec.title only; leaves
   rec.filename (the timestamp key) intact so links / jump-to-source keep
   working. Blank, or a value equal to the default, clears the override.
   Non-unique names are allowed - identity is the integer rec.id, not the name.
   NOTE: the mutate() passed to dbUpdate MUST stay synchronous (see db.js). */
window.saveRecTitle = async function saveRecTitle(id, value) {
    const key = Number(id);
    const v   = String(value == null ? '' : value).trim();
    await dbUpdate(CONFIG.STORE_REC, key, (rec) => {
        if (!rec) return null;
        if (v && v !== rec.filename) rec.title = v;
        else                         delete rec.title;   // empty or == default
        return rec;
    });
    renderList();
};

/* Download a recording's audio with a clean, cross-OS filename (title + size),
   instead of the random blob-URL id the native player's menu would use. */
window.downloadRec = async function downloadRec(id) {
    const key = Number(id);
    const rec = await dbExec(CONFIG.STORE_REC, 'get', key);
    if (!rec || !rec.blob) { alert('Audio for this recording is no longer available.'); return; }

    let downloadBlob = rec.blob;
    // Lazily upgrade valid WebM recordings created by older app versions. This
    // cannot reconstruct damaged audio, but it can add the missing Duration
    // metadata that caused otherwise-valid Opus downloads to show no total time.
    if (storedFormat(rec) === 'opus' && String(rec.mime || rec.blob.type || '').toLowerCase().includes('webm')
        && Number(rec.durationMs) > 0 && Number(rec.webmSeekableVersion || 0) < WEBM_SEEKABLE_VERSION) {
        try {
            downloadBlob = await makeWebmSeekable(rec.blob, rec.durationMs);
            await dbUpdate(CONFIG.STORE_REC, key, current => {
                if (!current || !current.blob) return null;
                current.blob = downloadBlob;
                current.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
                delete current.webmDurationFixed;
                return current;
            });
            await calcTotalStorage();
        } catch (err) {
            console.warn('Could not remux WebM for desktop seeking; downloading the original file:', err);
            downloadBlob = rec.blob;
        }
    }

    const url = URL.createObjectURL(downloadBlob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = buildDownloadName(rec, recordingExt(rec));
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a beat so the download has a chance to start first.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000);
};


/* One strict delegated action router replaces all inline onclick attributes.
   Keeping the allowed actions explicit lets the CSP omit script-src unsafe-inline. */
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
            case 'deleteRec': return window.deleteRec(recId);
            case 'convertRecFormat': return window.convertRecFormat(recId);
            case 'continueConv': return window.continueConv(recId);
            case 'toggleLinkRec': return window.toggleLinkRec(recId, el.dataset.linkLabel || '');
            case 'downloadRec': return window.downloadRec(recId);
            case 'deleteTranscript': {
                const selected = document.getElementById(`drop-t-${recId}`)?.value;
                if (selected != null) return window.deleteTranscript(recId, selected);
                return;
            }
            case 'toggleContextChain': return window.toggleContextChain(recId);
            case 'unlinkContextPart': return window.unlinkContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part);
            case 'viewContextPart': return window.viewContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part);
            case 'scrollToRecording': return window.scrollToRecording(el.dataset.sourceRef || '');
            case 'deleteSummary': {
                const selected = document.getElementById(`drop-s-${recId}`)?.value;
                if (selected != null) return window.deleteSummary(recId, selected);
                return;
            }
            case 'closeHelp': return window.closeHelp();
            case 'closeSettings': return window.closeSettings();
            case 'refreshOllamaModels': return window.refreshOllamaModels();
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
        const el = event.target.closest('[data-action][role="button"]');
        if (!el) return;
        event.preventDefault();
        el.click();
    });
}

/* Re-encode a decoded audio blob to Opus by playing it once through a
   MediaStreamDestination into a MediaRecorder. Conversion is real time, so it
   is deliberately capped to a safe duration and can be cancelled. */
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

let _activeConversion = null; // { recId, controller }

/* Convert a single recording to the preferred (non-default) format in place. */
window.convertRecFormat = async function convertRecFormat(id) {
    const key = Number(id);

    // Clicking the active badge again is an explicit cancellation gesture.
    if (_activeConversion) {
        if (_activeConversion.recId === key) _activeConversion.controller.abort();
        else alert('Another recording is already being converted. Cancel it or let it finish first.');
        return;
    }

    const pref = getSetting('set-recording-format');
    if (pref !== 'opus') return;
    const rec = await dbExec(CONFIG.STORE_REC, 'get', key);
    if (!rec || !rec.blob) { alert('Audio for this recording is no longer available.'); return; }
    if (storedFormat(rec) === 'opus') return;

    const maxMs = CONFIG.OPUS_CONVERT_MAX_MS;
    const wavMeta = await inspectPcmWav(rec.blob);
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
        const opusBlob = await encodeBlobToOpus(rec.blob, mime, (frac) => {
            badge = document.querySelector(`[data-fmt-rec="${key}"]`) || badge;
            if (badge) badge.textContent = `✕ ${Math.round(frac * 100)}%`;
        }, controller.signal);
        if (!opusBlob || opusBlob.size === 0) throw new Error('conversion produced no audio');
        if (controller.signal.aborted) throw makeAbortError();
        const storedBlob = await makeWebmSeekable(opusBlob, effectiveDurationMs);
        const webmSeekable = String(storedBlob.type || mime || '').toLowerCase().includes('webm');

        await dbUpdate(CONFIG.STORE_REC, key, (r) => {
            if (!r) return null;
            r.blob = storedBlob;
            r.format = 'opus';
            r.mime = mime;
            if (webmSeekable) r.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
            else delete r.webmSeekableVersion;
            delete r.webmDurationFixed;
            return r;
        });
        await calcTotalStorage();
        await renderList();
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('Format conversion failed:', e);
            alert('Conversion failed: ' + (e && e.message ? e.message : e));
        }
    } finally {
        if (_activeConversion?.controller === controller) _activeConversion = null;
        await renderList();
    }
};
