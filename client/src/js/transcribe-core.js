import { fmtDur }                from './config.js';
import { seamTrim }              from './dedup.js';
import { buildFinalPrompt, parseBatchResponse, languageName, languageLabel,
         TRANSLATE_BATCH_LINES } from './translate-core.js';

export function planAudioChunks(totalSamples, sampleRate, stepSec = 60, overlapSec = 3) {
    const step    = Math.max(1, Math.floor(sampleRate * stepSec));
    const overlap = Math.max(0, Math.floor(sampleRate * overlapSec));
    const chunks  = [];
    const total   = Math.max(0, Math.floor(Number(totalSamples) || 0));
    let coreStart = 0;
    let idx       = 0;

    while (coreStart < total) {
        const winStart = Math.max(0, coreStart - overlap);
        const winEnd   = Math.min(total, coreStart + step + overlap);
        const coreEnd  = Math.min(total, coreStart + step);
        chunks.push({
            idx,
            startSample:    winStart,
            endSample:      winEnd,
            coreSec:        coreStart / sampleRate,
            coreEndSec:     coreEnd / sampleRate,
            startSec:       winStart / sampleRate,
            endSec:         winEnd / sampleRate,
            hasPreOverlap:  coreStart > 0,
            hasPostOverlap: coreStart + step < total
        });
        coreStart += step;
        idx++;
    }
    return chunks;
}

export const DECODED_BYTES_PER_SECOND = 16000 * 4;
export const WHOLE_FILE_DECODE_BUDGET_BYTES = 256 * 1024 * 1024;

export function planWholeFileDecode({
    durationMs = 0,
    budgetBytes = WHOLE_FILE_DECODE_BUDGET_BYTES
} = {}) {
    const budget = Math.max(0, Number(budgetBytes) || 0);
    const limitSec = Math.floor(budget / DECODED_BYTES_PER_SECOND);
    const ms = Number(durationMs);
    const limitLabel = `${Math.floor(limitSec / 60)} minutes`;

    if (!Number.isFinite(ms) || ms <= 0) {
        return {
            allowed: false,
            estimatedBytes: null,
            limitSec,
            reason: 'This recording has no reliable duration, so the memory this decode would need cannot be checked first. Download the audio and transcribe it with a desktop tool.'
        };
    }

    const estimatedBytes = Math.round((ms / 1000) * DECODED_BYTES_PER_SECOND);
    if (estimatedBytes > budget) {
        return {
            allowed: false,
            estimatedBytes,
            limitSec,
            reason: `This container cannot be read in bounded windows, so transcribing it would decode the whole recording at once - about ${Math.round(estimatedBytes / (1024 * 1024))} MB of audio, past the ${Math.round(budget / (1024 * 1024))} MB limit that keeps the browser tab alive. Recordings up to about ${limitLabel} can be transcribed this way. Download the audio and transcribe it with a desktop tool.`
        };
    }

    return { allowed: true, estimatedBytes, limitSec, reason: '' };
}

export function runPool(items, limit, worker, shouldStop) {
    return runAdaptivePool(items, { limit: Math.max(1, Math.floor(Number(limit) || 1)) }, worker, shouldStop);
}

export function mergeIntervals(intervals) {
    const sorted = (intervals || [])
        .map(item => ({ fromSec: Math.max(0, Number(item.fromSec) || 0), toSec: Math.max(0, Number(item.toSec) || 0) }))
        .filter(item => item.toSec > item.fromSec)
        .sort((a, b) => a.fromSec - b.fromSec);
    const out = [];
    for (const item of sorted) {
        const last = out[out.length - 1];
        if (last && item.fromSec <= last.toSec) last.toSec = Math.max(last.toSec, item.toSec);
        else out.push({ ...item });
    }
    return out;
}

export const HEAD_MIN_GAP_SEC = 0.2;
// The last words before Stop are as easily cut off as the first ones after Start, so the end of a
// recording is held to the same small floor as its beginning; only a seam between two heard
// stretches has to be a second long to be worth a request.
export const TAIL_MIN_GAP_SEC = 0.2;

export function invertCoverage(coverage, totalSec, minGapSec = 1) {
    const total = Math.max(0, Number(totalSec) || 0);
    const merged = mergeIntervals(coverage);
    const gaps = [];
    let cursor = 0;
    for (const span of merged) {
        const floor = cursor === 0 ? Math.min(minGapSec, HEAD_MIN_GAP_SEC) : minGapSec;
        if (span.fromSec - cursor >= floor) gaps.push({ fromSec: cursor, toSec: Math.min(span.fromSec, total) });
        cursor = Math.max(cursor, span.toSec);
        if (cursor >= total) break;
    }
    if (total - cursor >= Math.min(minGapSec, TAIL_MIN_GAP_SEC)) gaps.push({ fromSec: cursor, toSec: total });
    return gaps.filter(gap => gap.toSec > gap.fromSec);
}

// The stretches of a recording its live transcript never heard: windows dropped while the server
// fell behind, skipped after it kept failing on them, or still unsent at Stop. A live transcript
// that records no coverage at all says nothing about what it missed.
export function liveHoles(coverage, totalSec, minGapSec = 1) {
    if (!Array.isArray(coverage) || coverage.length === 0) return [];
    return invertCoverage(coverage, totalSec, minGapSec);
}

export const AS_SPOKEN_HEADER = '── As spoken (each line in the language it was said in) ──';

// A reading made from the live transcript, with a section per language the translation boxes
// worked in after the lines as spoken. `plain`, which replies are written from, stays words only.
export function withTranslations(assembled, live) {
    const lines = (live && live.lines) || [];
    const languages = (live && live.languages) || [];
    const useful = languages.filter(code =>
        lines.some(line => line.translations && line.translations[code]));
    if (!useful.length) return assembled;
    const base = (lines.find(line => line.language) || {}).language || languages[0] || '';

    const section = code => {
        let carried = 0;
        const body = lines.map(line => {
            const done = line.translations && line.translations[code];
            const spoken = (line.language || '').toLowerCase();
            const foreign = !done && spoken && spoken !== code.toLowerCase();
            if (foreign) carried++;
            return `[${fmtDur((line.startSec || 0) * 1000)}] `
                + (foreign ? `[${spoken}] ` : '') + (done || line.text || '');
        }).join('\n');
        const note = carried
            ? ` (${carried} line${carried === 1 ? '' : 's'} not translated)` : '';
        return `\n\n── ${languageLabel(code, base)}${note} ──\n${body}`;
    };
    const spoken = assembled.timestamped || assembled.plain || '';
    return {
        timestamped: `${AS_SPOKEN_HEADER}\n${spoken}` + useful.map(section).join(''),
        plain: assembled.plain || ''
    };
}

// The lines as spoken of a reading that may carry language sections, so they can be put together
// again with newer translations.
export function spokenPart(text) {
    const value = String(text || '');
    const head = `${AS_SPOKEN_HEADER}\n`;
    if (!value.startsWith(head)) return value;
    const rest = value.slice(head.length);
    const end = rest.indexOf('\n\n── ');
    return end < 0 ? rest : rest.slice(0, end);
}

export function holeResults(holes) {
    return (holes || []).map(hole => ({
        coreSec: hole.fromSec, coreEndSec: hole.toSec, chunkStartSec: hole.fromSec,
        text: '', segments: [], untranscribed: true
    }));
}

export function planChunksForRanges(ranges, sampleRate, stepSec = 60, overlapSec = 3) {
    const chunks = [];
    for (const range of (ranges || [])) {
        const lengthSec = Math.max(0, range.toSec - range.fromSec);
        const offsetSamples = Math.round(range.fromSec * sampleRate);
        for (const chunk of planAudioChunks(Math.round(lengthSec * sampleRate), sampleRate, stepSec, overlapSec)) {
            chunks.push({
                ...chunk,
                idx: chunks.length,
                startSample: chunk.startSample + offsetSamples,
                endSample: chunk.endSample + offsetSamples,
                coreSec: chunk.coreSec + range.fromSec,
                coreEndSec: chunk.coreEndSec + range.fromSec,
                startSec: chunk.startSec + range.fromSec,
                endSec: chunk.endSec + range.fromSec
            });
        }
    }
    return chunks;
}

// A saved live line carries its speaker in front of its words ("Speaker 1: we start"), and from
// Build 134 also on its own, as speakerLabel. Only the words can have been heard by another window
// too, so the seam is trimmed on the words and the speaker is put back in front of what is kept.
export function splitSpeakerLabel(line) {
    const text = String((line && line.text) || '').trim();
    const label = typeof (line && line.speakerLabel) === 'string' ? line.speakerLabel.trim() : '';
    if (!label || !text.startsWith(`${label}:`)) return { label: '', text };
    return { label, text: text.slice(label.length + 1).trim() };
}

export function liveLinesAsResults(lines) {
    return (lines || [])
        .filter(line => line && String(line.text || '').trim())
        .map(line => {
            const { label, text } = splitSpeakerLabel(line);
            return {
                coreSec: Math.max(0, Number(line.startSec) || 0),
                coreEndSec: Math.max(0, Number(line.endSec) || 0),
                chunkStartSec: Math.max(0, Number(line.startSec) || 0),
                text,
                ...(label ? { label } : {}),
                segments: [],
                fromLive: true
            };
        });
}

export function trimOverlapSegments(segments, chunk) {
    if (!segments || segments.length === 0) return [];
    const coreRelStart = chunk.coreSec - chunk.startSec;
    const coreRelEnd   = chunk.coreEndSec - chunk.startSec;
    return segments.filter(seg => {
        const mid = (seg.start + seg.end) / 2;
        return mid >= coreRelStart - 0.5 && mid <= coreRelEnd + 0.5;
    });
}

export function usableSegments(segments) {
    const out = [];
    for (const seg of Array.isArray(segments) ? segments : []) {
        const start = Number(seg && seg.start);
        const end = Number(seg && seg.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        out.push({ ...seg, start, end });
    }
    return out;
}

export function chunkCoreSamples(samples, chunk, sampleRate = 16000) {
    if (!samples || typeof samples.length !== 'number' || !chunk) return samples;
    const from = Math.max(0, Math.round((Number(chunk.coreSec) - Number(chunk.startSec)) * sampleRate) || 0);
    const to = Math.min(samples.length, Math.round((Number(chunk.coreEndSec) - Number(chunk.startSec)) * sampleRate) || 0);
    if (!(to > from)) return samples;
    return typeof samples.subarray === 'function' ? samples.subarray(from, to) : samples.slice(from, to);
}

export const LEVEL_FRAME_SEC = 0.1;

export function levelEnvelope(samples, sampleRate = 16000, frameSec = LEVEL_FRAME_SEC) {
    const frame = Math.max(1, Math.round(sampleRate * frameSec));
    const count = samples && samples.length ? Math.ceil(samples.length / frame) : 0;
    const envelope = new Float32Array(count);
    for (let f = 0; f < count; f++) {
        let sum = 0;
        const from = f * frame;
        const to = Math.min(samples.length, from + frame);
        for (let i = from; i < to; i++) sum += samples[i] * samples[i];
        envelope[f] = to > from ? sum / (to - from) : 0;
    }
    return envelope;
}

export function envelopeRms(envelope, fromSec, toSec, frameSec = LEVEL_FRAME_SEC) {
    if (!envelope || !envelope.length) return 0;
    const from = Math.max(0, Math.floor(fromSec / frameSec));
    const to = Math.min(envelope.length, Math.ceil(toSec / frameSec));
    if (!(to > from)) return 0;
    let sum = 0;
    for (let f = from; f < to; f++) sum += envelope[f];
    return Math.sqrt(sum / (to - from));
}

export function rmsUnderSegments(envelope, segments, frameSec = LEVEL_FRAME_SEC) {
    let sum = 0;
    let frames = 0;
    for (const seg of segments || []) {
        const from = Math.max(0, Math.floor(seg.start / frameSec));
        const to = Math.min(envelope.length, Math.ceil(seg.end / frameSec));
        for (let f = from; f < to; f++) { sum += envelope[f]; frames++; }
    }
    return frames ? Math.sqrt(sum / frames) : 0;
}

export const LIVE_CORE_REACH_SEC = 0.3;
export const CORE_SOUND_SHARE = 0.5;

// Whether the part of a segment past the start of the core had sound: more than silence, and at
// least half the level of the whole segment. Words the server places there were said in this
// window's own audio, however short that part is.
function soundPastCoreStart(envelope, seg, coreRelStart, coreRelEnd) {
    const until = Math.min(seg.end, coreRelEnd);
    if (!envelope || !(until > coreRelStart)) return false;
    const past = envelopeRms(envelope, coreRelStart, until);
    return past >= SILENCE_RMS_THRESHOLD && past >= rmsUnderSegments(envelope, [seg]) * CORE_SOUND_SHARE;
}

// Which of a window's segments it owns. A chunk transcribed after the recording overlaps its
// neighbours on both sides, so a segment belongs to the chunk its middle falls in. A live window
// has only the carry before its core and nothing after it, so a sentence that began in the carry
// and runs on into the core is kept too: the live seam trim removes the words the previous
// window already heard, and the rest is only in this one. It runs on when it reaches well into
// the core, or when the audio past the core start, up to where the server says it ends, has
// sound; a segment that only touches a quiet core is the previous window's words heard again.
//
// When the server placed every word outside the core, that is right if the core was quiet: the
// words belong to the neighbour, which saves them at their real time. If the core had about as
// much sound as the place the server named, the timestamps do not match the audio, and the
// server's text is used for the core rather than losing that stretch.
export function pickCoreSegments(result, chunk, { reachIntoCoreSec = null, coreLevel = null, envelope = null } = {}) {
    const timed = usableSegments(result && result.segments);
    const coreRelStart = chunk.coreSec - chunk.startSec;
    const coreRelEnd = chunk.coreEndSec - chunk.startSec;
    const kept = timed.filter(seg => {
        const mid = (seg.start + seg.end) / 2;
        if (mid >= coreRelStart - 0.5 && mid <= coreRelEnd + 0.5) return true;
        if (reachIntoCoreSec == null || !(seg.start < coreRelEnd) || !(seg.end > coreRelStart)) return false;
        return seg.end > coreRelStart + reachIntoCoreSec || soundPastCoreStart(envelope, seg, coreRelStart, coreRelEnd);
    });
    if (kept.length) return { segments: kept, useText: false };
    if (!timed.length) return { segments: [], useText: true };
    if (!coreLevel || isNearSilent(coreLevel)) return { segments: [], useText: false };
    const named = envelope ? rmsUnderSegments(envelope, timed) : 0;
    return { segments: [], useText: !(coreLevel.rms < named * CORE_SOUND_SHARE) };
}

export function textForChunkCore(result, chunk, { segmentText = segment => String(segment.text || ''),
                                                  samples = null, sampleRate = 16000 } = {}) {
    const coreLevel = samples ? summarizeChunkLevel(chunkCoreSamples(samples, chunk, sampleRate)) : null;
    const envelope = samples ? levelEnvelope(samples, sampleRate) : null;
    const picked = pickCoreSegments(result, chunk, { coreLevel, envelope });
    const text = picked.useText
        ? trimOverlapTextFallback((result && result.text) || '', chunk)
        : picked.segments.map(segmentText).join(' ').trim();
    return { coreSegments: picked.segments, text, coreLevel };
}

export const SEAM_OVERLAP_TOLERANCE_SEC = 0.25;
const SEAM_LOOKBACK_LINES = 64;

export function overlapsForSeam(earlier, later, toleranceSec = SEAM_OVERLAP_TOLERANCE_SEC) {
    return Number(later.startSec) < Number(earlier.endSec) + toleranceSec
        && Number(earlier.startSec) < Number(later.endSec) + toleranceSec;
}

export function createSeamState() {
    return { kept: [], heardUntil: new Map() };
}

// Two windows only repeat each other where they heard the same audio, so a line is trimmed
// against text another window heard at the same time, never against what came before it in its
// own window: "Okay." followed by "Okay, so we start." is two things said, not one heard twice.
// A window has always heard past its own earlier lines, and once it has heard past a line of
// another window too, its later lines are not compared with that one either.
export function passSeam(seam, line, toleranceSec = SEAM_OVERLAP_TOLERANCE_SEC) {
    const text = String((line && line.text) || '').trim();
    if (!text) return '';
    const heardIn = line.heardIn;
    const startSec = Number(line.startSec) || 0;
    const endSec = Math.max(startSec, Number(line.endSec) || 0);
    const coveredUntil = seam.heardUntil.has(heardIn) ? seam.heardUntil.get(heardIn) : -Infinity;
    const heardElsewhere = [];
    for (let i = seam.kept.length - 1, looked = 0; i >= 0 && looked < SEAM_LOOKBACK_LINES; i--, looked++) {
        const earlier = seam.kept[i];
        if (coveredUntil >= earlier.endSec - toleranceSec) continue;
        if (overlapsForSeam(earlier, { startSec, endSec }, toleranceSec)) heardElsewhere.unshift(earlier.text);
    }
    const kept = heardElsewhere.length ? seamTrim(heardElsewhere.join(' '), text).trim() : text;
    seam.heardUntil.set(heardIn, Math.max(coveredUntil, endSec));
    if (kept) seam.kept.push({ heardIn, startSec, endSec, text: kept });
    return kept;
}

export function trimOverlapTextFallback(rawText, chunk) {
    if (!rawText) return '';
    const text = rawText.trim();
    const words = text.split(/\s+/);

    if (words.length <= 2 && Array.from(text).length > 24) {
        const chars = Array.from(text);
        const trim = Math.min(24, Math.floor(chars.length * 0.08));
        const start = chunk.hasPreOverlap ? trim : 0;
        const end = chunk.hasPostOverlap ? Math.max(start + 1, chars.length - trim) : chars.length;
        return chars.slice(start, end).join('').trim();
    }

    const trimCount = 8;
    let start = 0, end = words.length;
    if (chunk.hasPreOverlap)  start = Math.min(trimCount, Math.floor(words.length * 0.1));
    if (chunk.hasPostOverlap) end   = Math.max(start + 1, words.length - Math.min(trimCount, Math.floor(words.length * 0.1)));
    return words.slice(start, end).join(' ');
}

function spansOverlap(fromA, toA, fromB, toB) {
    return fromA < toB && toA > fromB;
}

function replayHeardText(result, review) {
    if (Array.isArray(result.segments) && result.segments.length) {
        return result.segments.some(segment => String(segment.text || '').trim()
            && spansOverlap(result.chunkStartSec + segment.start, result.chunkStartSec + segment.end,
                            review.fromSec, review.toSec));
    }
    return !!String(result.text || '').trim();
}

export function settleLiveReplays(reviews, results, missingRanges = []) {
    const settled = (results || []).map(result => (result ? { ...result } : result));
    const restore = [];
    const restored = new Set();
    let keptLive = 0;
    for (const review of reviews || []) {
        const touching = settled.filter(result => result
            && spansOverlap(result.coreSec, result.coreEndSec, review.fromSec, review.toSec));
        const heard = touching.length > 0
            && touching.every(result => !result.failed)
            && touching.some(result => replayHeardText(result, review));
        if (heard) continue;
        keptLive++;
        for (const item of review.items || []) {
            if (item && !restored.has(item)) { restored.add(item); restore.push(item); }
        }
        for (const result of touching) {
            if (result.failed || result.silent) {
                const holdsRealGap = (missingRanges || []).some(gap =>
                    spansOverlap(result.coreSec, result.coreEndSec, gap.fromSec, gap.toSec));
                if (!holdsRealGap) result._reviewSuppressed = true;
            } else if (Array.isArray(result.segments) && result.segments.length) {
                result.segments = result.segments.map(segment =>
                    spansOverlap(result.chunkStartSec + segment.start, result.chunkStartSec + segment.end,
                                 review.fromSec, review.toSec)
                        ? { ...segment, _reviewSuppressed: true }
                        : segment);
            }
        }
    }
    return { results: settled, restore, keptLive };
}

export function transcriptsAfterCleanup(transcripts, summaries) {
    const answered = new Set((summaries || []).map(item => String(item && item.transcriptId)));
    return (transcripts || []).filter(item => item
        && (!(item.source === 'L' || item.fromLive) || answered.has(String(item.id))));
}

export const GAP_MARKER = '[transcription unavailable for this section]';
export const SILENT_MARKER = '[no speech detected]';
export const NOT_TRANSCRIBED_MARKER = '[not transcribed live]';

export const CHUNK_RETRY_DELAYS_MS = [1500, 5000];
export const CHUNK_RETRY_DELAYS_AFTER_TIMEOUT_MS = [20000, 45000];

export function chunkRetryDelayMs(attempt, err) {
    const delays = err && err.timedOut ? CHUNK_RETRY_DELAYS_AFTER_TIMEOUT_MS : CHUNK_RETRY_DELAYS_MS;
    return attempt < delays.length ? delays[attempt] : null;
}

// A chunk the server turns away as busy while other chunks of the same transcription are at the
// server waits for one of them to come back and asks again, without using up a try: the server is
// alive, and busy with this transcription's own work. Turned away as busy with none of them there,
// the server is busy with something else, and the chunk is retried after a pause like any failure.
// A bound keeps a chunk that keeps losing the race for the server from waiting forever.
export const CHUNK_BUSY_WAITS_MAX = 20;

export function shouldWaitForOwnChunk(err, ownInFlight, busyWaits, maxWaits = CHUNK_BUSY_WAITS_MAX) {
    return !!(err && err.busy) && Number(ownInFlight) > 0 && Number(busyWaits) < maxWaits;
}

// The chunks of one transcription that are at the server right now, and the ones waiting for one of
// them to come back. An answer wakes the waiting; a chunk turned away as busy freed no room, unless
// it was the last of them at the server: then nothing of this transcription will come back to wake
// them, and they go back to asking after pauses.
export function createServerQueue() {
    return { inFlight: 0, waiting: [] };
}

export function requestCameBack(queue, { freedRoom }) {
    queue.inFlight = Math.max(0, queue.inFlight - 1);
    if (!freedRoom && queue.inFlight > 0) return;
    for (const wake of queue.waiting.splice(0)) wake();
}

export function anotherRequestBack(queue, signal) {
    const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(cancelled()); return; }
        const onAbort = () => {
            const at = queue.waiting.indexOf(wake);
            if (at >= 0) queue.waiting.splice(at, 1);
            reject(cancelled());
        };
        const wake = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        };
        queue.waiting.push(wake);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

export const POOL_START = 2;
export const POOL_ANSWER_SHOWS_QUEUING_MS = 45000;

// busy: the server refused the chunk because it has more than it can take (503 or 429), which says
// as plainly as a timeout that fewer chunks should be sent at once.
export function nextPoolLimit(limit, { ok = false, ms = 0, timedOut = false, busy = false } = {},
                              { max = 10, queuingMs = POOL_ANSWER_SHOWS_QUEUING_MS } = {}) {
    const current = Math.max(1, Math.floor(Number(limit) || 1));
    const cap = Math.max(1, Math.floor(Number(max) || 1));
    if (timedOut) return Math.max(1, Math.floor(current / 2));
    if (busy) return Math.max(1, Math.floor(current / 2));
    if (!ok) return current;
    const requestsAreQueuing = Number(ms) > queuingMs;
    if (requestsAreQueuing) return Math.max(1, current - 1);
    return Math.min(cap, current + 1);
}

export function runAdaptivePool(items, control, worker, shouldStop) {
    const list = Array.isArray(items) ? items : Array.from(items || []);
    let next = 0;
    let running = 0;
    let failed = false;
    const limitNow = () => Math.max(1, Math.floor(Number(control.limit) || 1));
    return new Promise((resolve, reject) => {
        const stopped = () => !!(shouldStop && shouldStop());
        const pump = () => {
            if (failed) return;
            while (!stopped() && next < list.length && running < limitNow()) {
                const index = next++;
                running++;
                Promise.resolve()
                    .then(() => worker(list[index], index))
                    .then(() => { running--; pump(); },
                          err => { running--; failed = true; reject(err); });
            }
            if (running === 0 && (stopped() || next >= list.length)) resolve();
        };
        pump();
    });
}

export const SILENCE_PEAK_THRESHOLD = 0.012;
export const SILENCE_RMS_THRESHOLD  = 0.0025;

export function summarizeChunkLevel(samples) {
    if (!samples || typeof samples.length !== 'number' || samples.length === 0) return null;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (!Number.isFinite(v)) continue;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / samples.length) };
}

export function isNearSilent(level) {
    if (!level) return false;
    return level.peak < SILENCE_PEAK_THRESHOLD && level.rms < SILENCE_RMS_THRESHOLD;
}

export function mergePlaceholderRuns(segments) {
    const out = [];
    for (const seg of (segments || [])) {
        const prev = out[out.length - 1];
        if (seg.placeholder && prev && prev.placeholder && prev.text === seg.text
            && seg.absStart <= prev.absEnd + 0.001) {
            prev.absEnd = Math.max(prev.absEnd, seg.absEnd);
            continue;
        }
        out.push({ ...seg });
    }
    return out;
}

export function reassembleTimeline(results, totalChunks) {
    const allSegs = [];
    for (let index = 0; index < totalChunks; index++) {
        const r = results[index];
        if (!r || r._reviewSuppressed) continue;
        // The live transcript was already reconciled window by window while it was recorded,
        // so its lines are one source and are never trimmed against each other again.
        const heardIn = r.fromLive ? 'live' : `chunk:${index}`;
        if (r.silent) {
            allSegs.push({
                absStart: r.coreSec,
                absEnd:   r.coreEndSec,
                text:     SILENT_MARKER,
                placeholder: true
            });
        } else if (r.failed) {
            allSegs.push({
                absStart: r.coreSec,
                absEnd:   r.coreEndSec,
                text:     GAP_MARKER,
                placeholder: true
            });
        } else if (r.untranscribed) {
            allSegs.push({
                absStart: r.coreSec,
                absEnd:   r.coreEndSec,
                text:     NOT_TRANSCRIBED_MARKER,
                placeholder: true
            });
        } else if (r.segments && r.segments.length > 0) {
            for (const seg of r.segments) {
                if (!seg || seg._reviewSuppressed) continue;
                allSegs.push({
                    absStart: r.chunkStartSec + seg.start,
                    absEnd:   r.chunkStartSec + seg.end,
                    text:     String(seg.text || '').trim(),
                    heardIn
                });
            }
        } else if (r.text) {
            allSegs.push({ absStart: r.coreSec, absEnd: r.coreEndSec, text: String(r.text).trim(), heardIn,
                           label: r.label || '' });
        }
    }
    if (allSegs.length === 0) return { timestamped: '', plain: '' };

    allSegs.sort((a, b) => a.absStart - b.absStart || a.absEnd - b.absEnd);
    const merged = mergePlaceholderRuns(allSegs);

    const tsLines    = [];
    const plainParts = [];
    const seam       = createSeamState();

    for (const seg of merged) {
        if (!seg.text) continue;
        const kept = seg.placeholder
            ? seg.text
            : passSeam(seam, { heardIn: seg.heardIn, startSec: seg.absStart, endSec: seg.absEnd, text: seg.text });
        let keptTrim = kept.trim();
        if (!keptTrim) continue;
        if (seg.label) keptTrim = `${seg.label}: ${keptTrim}`;

        tsLines.push(`[${fmtDur(seg.absStart * 1000)}-${fmtDur(seg.absEnd * 1000)}] ${keptTrim}`);
        if (keptTrim !== SILENT_MARKER) plainParts.push(keptTrim);
    }

    return {
        timestamped: tsLines.join('\n'),
        plain:       plainParts.join(' ').trim()
    };
}

export const TRANSLATE_FILL_FAILURE_LIMIT = 3;

export function initialFillBreaker() {
    return { failures: 0, broken: false };
}

export function nextFillBreaker(previous, reached, limit = TRANSLATE_FILL_FAILURE_LIMIT) {
    const prev = previous || initialFillBreaker();
    if (reached) return { failures: 0, broken: false };
    const failures = (prev.failures || 0) + 1;
    return { failures, broken: failures >= Math.max(1, limit) };
}

export function shouldRetryLineByLine({ reached = false, aligned = false } = {}) {
    return reached === true && aligned === false;
}

export function describeFillStopped(failures) {
    return `Stopped completing the other languages: the reply server did not answer `
         + `${Math.max(1, Number(failures) || 0)} requests in a row.`;
}

export const FINAL_BATCH_LINES = TRANSLATE_BATCH_LINES * 2;

function isCancel(err, signal) {
    return !!(signal && signal.aborted) || !!(err && err.name === 'AbortError');
}

// The status line of the fill that runs after a recording: which language, how far, and whether it
// is waiting for a reply to finish first.
export function describeFillProgress(progress, { waiting = false } = {}) {
    const lead = waiting ? '🌐 The rest follows the reply' : '🌐 Translating the rest';
    if (!progress || !progress.target) return `${lead}…`;
    const language = languageName(progress.target);
    if (progress.retrying) return `${lead}: ${language}, ${progress.retrying} line(s) once more`;
    return `${lead}: ${language} ${progress.done} of ${progress.total} lines`;
}

// `onProgress` hears { target, done, total } before each request ({ target, retrying } for a batch
// tried again at the end); `onBatch(target, { index: text })` is given each answer as it comes, so the
// caller can keep what was done even if the fill is stopped or its tab closed before it ends.
export async function fillMissingTranslations(lines, languages, translate, {
    batchLines = FINAL_BATCH_LINES, onProgress = () => {}, onBatch = null, signal = null,
    limit = TRANSLATE_FILL_FAILURE_LIMIT, waitBeforeEachRequest = null
} = {}) {
    const list = lines || [];
    const filled = {};
    let done = 0;
    let missing = 0;
    let requests = 0;
    let breaker = initialFillBreaker();
    const unansweredBatchesToRetryAtEnd = [];
    const outcome = extra => ({ filled, done, missing, requests, stopped: null, cancelled: false, ...extra });
    const keep = async (target, answers) => {
        if (typeof onBatch === 'function' && Object.keys(answers).length) await onBatch(target, answers);
    };
    const take = async (target, batch, parsed) => {
        const answers = {};
        batch.forEach((item, i) => {
            if (!parsed[i]) { missing++; return; }
            filled[target][item.index] = parsed[i];
            answers[item.index] = parsed[i];
            done++;
        });
        await keep(target, answers);
    };

    const ask = async (items, target) => {
        if (typeof waitBeforeEachRequest === 'function') await waitBeforeEachRequest();
        requests++;
        try {
            const reply = await translate(buildFinalPrompt(items.map(item => item.line), languageName(target)),
                                          items.length);
            return { reached: true, parsed: parseBatchResponse(reply, items.length, { numbered: true }) };
        } catch (err) {
            if (isCancel(err, signal)) throw err;
            return { reached: false, parsed: null };
        }
    };

    const lineByLine = async (batch, target) => {
        if (!shouldRetryLineByLine({ reached: true, aligned: false })) { missing += batch.length; return null; }
        for (const item of batch) {
            if (signal && signal.aborted) return outcome({ cancelled: true });
            const one = await ask([item], target);
            breaker = nextFillBreaker(breaker, one.reached, limit);
            if (breaker.broken) {
                return outcome({ missing: missing + 1, stopped: describeFillStopped(breaker.failures) });
            }
            if (one.parsed && one.parsed[0]) {
                filled[target][item.index] = one.parsed[0];
                done++;
                await keep(target, { [item.index]: one.parsed[0] });
            } else missing++;
        }
        return null;
    };

    try {
        for (const target of languages || []) {
            const gaps = list
                .map((line, index) => ({ line, index }))
                .filter(item => {
                    const spoken = String(item.line.language || '').toLowerCase();
                    if (spoken && spoken === String(target).toLowerCase()) return false;
                    return !(item.line.translations || {})[target];
                });
            if (!gaps.length) continue;
            filled[target] = filled[target] || {};
            const size = Math.max(1, Math.floor(Number(batchLines) || 1));

            for (let at = 0; at < gaps.length; at += size) {
                if (signal && signal.aborted) return outcome({ cancelled: true });
                const batch = gaps.slice(at, at + size);
                onProgress({ target, done: at, total: gaps.length });
                const first = await ask(batch, target);
                breaker = nextFillBreaker(breaker, first.reached, limit);
                if (breaker.broken) {
                    return outcome({ missing: missing + batch.length, stopped: describeFillStopped(breaker.failures) });
                }
                if (first.parsed) {
                    await take(target, batch, first.parsed);
                    continue;
                }
                if (!first.reached) {
                    unansweredBatchesToRetryAtEnd.push({ batch, target });
                    continue;
                }
                const broken = await lineByLine(batch, target);
                if (broken) return broken;
            }
        }
        for (const [n, { batch, target }] of unansweredBatchesToRetryAtEnd.entries()) {
            if (signal && signal.aborted) return outcome({ cancelled: true });
            onProgress({ target, retrying: batch.length });
            const again = await ask(batch, target);
            breaker = nextFillBreaker(breaker, again.reached, limit);
            if (breaker.broken) {
                const untried = unansweredBatchesToRetryAtEnd.slice(n + 1).reduce((sum, entry) => sum + entry.batch.length, 0);
                return outcome({ missing: missing + batch.length + untried, stopped: describeFillStopped(breaker.failures) });
            }
            if (again.parsed) {
                await take(target, batch, again.parsed);
            } else if (again.reached) {
                const broken = await lineByLine(batch, target);
                if (broken) return broken;
            } else {
                missing += batch.length;
            }
        }
    } catch (err) {
        if (isCancel(err, signal)) return outcome({ cancelled: true });
        throw err;
    }
    return outcome();
}
