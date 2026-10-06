import { translationKey } from './translate-core.js';
import { seamTrim, appendTail } from './dedup.js';

export const WINDOW_SEC = 4;

export const PREVIEW_MAX_SEC = 10;
const PREVIEW_MIN_SEC = 1.2;
const PREVIEW_MIN_INTERVAL_MS = 700;

export const OVERLAP_SEC = 2;

export const MAX_PENDING_SEC = 60;

export const MAX_IN_FLIGHT = 2;

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30000;

export const RETRY_QUEUE_MAX_BYTES = 96 * 1024 * 1024;

export function retryDelayMs(attempt) {
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, n - 1));
}

export function planUpload({
    queued = 0, inFlight = 0, maxInFlight = MAX_IN_FLIGHT,
    now = 0, nextAttemptAt = 0, online = true
} = {}) {
    if (queued <= 0) return { send: false, waitMs: 0, reason: 'idle' };
    if (inFlight >= maxInFlight) return { send: false, waitMs: 0, reason: 'busy' };
    if (!online) return { send: false, waitMs: RETRY_BASE_MS, reason: 'offline' };
    if (now < nextAttemptAt) return { send: false, waitMs: nextAttemptAt - now, reason: 'backoff' };
    return { send: true, waitMs: 0, reason: 'ready' };
}

export const WINDOW_MAX_STRIKES = 2;

export function judgeWindowFailure({ strikes = 0, seenAnswered = null } = {}, answered = 0) {
    const answeredNow = Math.max(0, Number(answered) || 0);
    const answeredAtLastFailure = Number.isFinite(seenAnswered) ? seenAnswered : answeredNow;
    const othersAnsweredSinceLastFailure = answeredNow > answeredAtLastFailure;
    const strikesNow = Math.max(0, Number(strikes) || 0) + (othersAnsweredSinceLastFailure ? 1 : 0);
    return { strikes: strikesNow, seenAnswered: answeredNow, giveUp: strikesNow >= WINDOW_MAX_STRIKES };
}

export const REVIEW_AUDIO_KEPT_WINDOWS = MAX_IN_FLIGHT;

export function releaseReviewAudioOfWaitingWindows(queue, keepNewest = REVIEW_AUDIO_KEPT_WINDOWS) {
    const list = queue || [];
    for (let i = 0; i < list.length - Math.max(0, keepNewest); i++) {
        const item = list[i];
        if (!item || !item.pcm16k) continue;
        item.pcm16k = null;
        item.bytes = Number(item.blob && item.blob.size) || 0;
    }
    return list;
}

export function queuedWindowBytes(blob, pcm16k) {
    return (Number(blob && blob.size) || 0) + (Number(pcm16k && pcm16k.byteLength) || 0);
}

export function capRetryQueue(queue, maxBytes = RETRY_QUEUE_MAX_BYTES) {
    const kept = [...(queue || [])];
    const dropped = [];
    let total = kept.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    while (kept.length > 1 && total > maxBytes) {
        const gone = kept.shift();
        total -= Number(gone.bytes) || 0;
        dropped.push(gone);
    }
    return { queue: kept, dropped, bytes: total };
}

export function releaseInOrder(pending, nextIndex) {
    const ready = [];
    let index = Math.max(0, Math.floor(Number(nextIndex) || 0));
    while (pending.has(index)) {
        ready.push(pending.get(index));
        pending.delete(index);
        index++;
    }
    return { ready, nextIndex: index };
}

export function settleLiveWindows(pending, nextIndex) {
    const released = releaseInOrder(pending, nextIndex);
    return { ...released, covered: released.ready.filter(entry => entry.coverage).map(entry => entry.coverage) };
}

// What becomes of audio the live view did not transcribe, in the words its notices use. With
// Auto-transcribe on, the pass after the recording sends it; otherwise nothing does until someone
// asks, so the saved transcript marks it and the recording's row offers 📝 Fill gaps.
export function afterRecordingFate(autoTranscribe) {
    return autoTranscribe
        ? { part: 'that part is transcribed after the recording',
            unsent: 'they will be transcribed after the recording',
            dropped: 'still transcribed after recording' }
        : { part: 'that part is marked in the saved transcript for 📝 Fill gaps',
            unsent: 'they are marked in the saved transcript for 📝 Fill gaps',
            dropped: 'marked for 📝 Fill gaps' };
}

export function describeConnection({
    online = true, queued = 0, attempt = 0, droppedWindows = 0, nowMs = 0, nextAttemptAt = 0,
    autoTranscribe = true
} = {}) {
    if (queued === 0 && attempt === 0) return null;
    if (attempt > 0) {
        const inSec = Math.max(0, Math.ceil((nextAttemptAt - nowMs) / 1000));
        const what = online ? 'server not answering' : 'no connection';
        const backlog = queued === 1 ? '1 window waiting' : `${queued} windows waiting`;
        const lost = droppedWindows > 0
            ? ` · ${droppedWindows} dropped from the view, ${afterRecordingFate(autoTranscribe).dropped}`
            : '';
        return `⚠️ ${what} - retrying in ${inSec}s · ${backlog}${lost}`;
    }
    return queued > 1 ? `📡 catching up · ${queued} windows queued` : null;
}

const MAX_CHARS = 60000;

export const DROPPED_MARKER = '… ';

export function planLiveWindow({
    bufferedSec = 0,
    inFlight = 0,
    stopping = false,
    windowSec = WINDOW_SEC,
    maxPendingSec = MAX_PENDING_SEC,
    maxInFlight = MAX_IN_FLIGHT
} = {}) {
    const idle = { send: false, sendSec: 0, dropSec: 0 };
    const buffered = Math.max(0, Number(bufferedSec) || 0);

    const dropSec = buffered > maxPendingSec ? buffered - maxPendingSec : 0;
    const remaining = buffered - dropSec;

    if (inFlight >= maxInFlight) return { ...idle, dropSec };

    if (stopping) {
        if (remaining <= 0) return { ...idle, dropSec };
        return { send: true, sendSec: remaining, dropSec };
    }

    if (remaining < windowSec) return { ...idle, dropSec };
    return { send: true, sendSec: windowSec, dropSec };
}

export const PREVIEW_WINDOW_LEAD_SEC = 0.6;

export function planPreviewRequest({
    pendingSec = 0,
    previewInFlight = false,
    sinceLastMs = Infinity,
    stopping = false,
    shown = true,
    hidden = false,
    heardSpeech = true,
    windowSlotFree = false,
    windowSec = WINDOW_SEC,
    leadSec = PREVIEW_WINDOW_LEAD_SEC,
    minSec = PREVIEW_MIN_SEC,
    maxSec = PREVIEW_MAX_SEC,
    minIntervalMs = PREVIEW_MIN_INTERVAL_MS
} = {}) {
    const idle = { send: false, sec: 0 };
    if (stopping || previewInFlight) return idle;
    if (!shown || hidden || !heardSpeech) return idle;
    const pending = Math.max(0, Number(pendingSec) || 0);
    if (pending < minSec) return idle;
    if (windowSlotFree && pending >= windowSec - leadSec) return idle;
    if (Number(sinceLastMs) < minIntervalMs) return idle;
    return { send: true, sec: Math.min(pending, maxSec) };
}

const SPEECH_FLOOR_FALL = 0.2;
const SPEECH_FLOOR_RISE = 0.002;
const SPEECH_RATIO = 2.5;
const SPEECH_MIN_RMS = 0.004;
const SPEECH_HOLD_MS = 450;

export function nextSpeechState(previous, rms, now = 0) {
    const level = Math.max(0, Number(rms) || 0);
    const prev = previous || {};
    const prevFloor = Number.isFinite(prev.floor) ? prev.floor : level;
    const rate = level < prevFloor ? SPEECH_FLOOR_FALL : SPEECH_FLOOR_RISE;
    const floor = prevFloor + (level - prevFloor) * rate;

    const threshold = Math.max(SPEECH_MIN_RMS, floor * SPEECH_RATIO);
    const loud = level > threshold;
    const speakingUntil = loud ? now + SPEECH_HOLD_MS : (Number(prev.speakingUntil) || 0);
    return { floor, level, speaking: loud || now < speakingUntil, speakingUntil };
}

export const SEAM_START_TOLERANCE_SEC = 0.5;

function latestSpokenStart(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] && !lines[i].system) return Math.max(0, Number(lines[i].startSec) || 0);
    }
    return 0;
}

export function appendLiveLines(state, items, { maxChars = MAX_CHARS, gap = false, seamUntilSec = Infinity } = {}) {
    const lines = [...((state && state.lines) || [])];
    let tail = String((state && state.tail) || '');
    let appended = 0;
    const seamLimit = seamUntilSec === null ? -Infinity : Number(seamUntilSec) + SEAM_START_TOLERANCE_SEC;
    let lastStart = latestSpokenStart(lines);

    for (const item of (items || [])) {
        const raw = String((item && item.text) || '').trim();
        if (!raw) continue;
        const itemStart = Math.max(0, Number(item.startSec) || 0);
        const mayRepeat = tail && !(gap && appended === 0) && itemStart < seamLimit;
        const kept = mayRepeat ? seamTrim(tail, raw).trim() : raw;
        if (!kept) continue;
        const startSec = Math.max(itemStart, lastStart);
        lines.push({
            key: item.key != null ? item.key : `${lines.length}:${item.startSec}`,
            startSec,
            endSec: Math.max(startSec, Number(item.endSec) || 0),
            text: kept,
            language: item.language || null,
            gap: gap && appended === 0
        });
        lastStart = startSec;
        tail = appendTail(tail, kept);
        appended++;
    }

    return { ...capLiveLines(lines, maxChars), tail, appended };
}

function capLiveLines(lines, maxChars = MAX_CHARS) {
    const limit = Math.max(1, Math.floor(Number(maxChars) || 0));
    const kept = [...(lines || [])];
    let chars = kept.reduce((sum, line) => sum + line.text.length + 1, 0);
    const droppedLines = [];
    while (kept.length > 1 && chars > limit) {
        chars -= kept[0].text.length + 1;
        droppedLines.push(kept.shift());
    }
    return { lines: kept, chars, dropped: droppedLines.length > 0, droppedLines };
}

export function archiveDroppedLines(archive, droppedLines, translations, targets = []) {
    const source = translations || {};
    const kept = (droppedLines || []).filter(line => line && !line.system).map(line => {
        const baked = {};
        for (const target of targets || []) {
            const text = source[translationKey(line.key, target)];
            if (text) baked[target] = text;
        }
        return { ...line, translations: baked };
    });
    return (archive || []).concat(kept);
}

export function capLiveText(text, maxChars = MAX_CHARS) {
    const value = String(text || '');
    const limit = Math.max(1, Math.floor(Number(maxChars) || 0));
    if (value.length <= limit) return value;

    const tailStart = value.length - limit;
    const cut = value.indexOf(' ', tailStart);
    const from = cut === -1 ? tailStart : cut + 1;
    return DROPPED_MARKER + value.slice(from);
}


export const RESUME_CARRIES = Object.freeze([
    'lines', 'backfillLines', 'archivedLines', 'coverage', 'tail',
    'translations', 'translateGaveUp', 'languages', 'closedLanguages',
    'diarization', 'speakerHints', 'proposals', 'proposalEchoed', 'inferEchoed',
    'speakerNoticeShown', 'panelsOffNoticed'
]);

export function carryAcrossResume(session) {
    const carried = {};
    for (const field of RESUME_CARRIES) {
        if (session && Object.prototype.hasOwnProperty.call(session, field)) carried[field] = session[field];
    }
    return carried;
}

export function transcriptSnapshot({ archivedLines = [], backfillLines = [], lines = [] } = {}) {
    return [...(archivedLines || []), ...(backfillLines || []), ...(lines || [])]
        .filter(line => line && !line.system)
        .sort((a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0));
}

export function lineTranslation(line, target, translations = {}) {
    if (!line || !target) return '';
    const baked = line.translations && line.translations[target];
    return baked || (translations || {})[translationKey(line.key, target)] || '';
}
