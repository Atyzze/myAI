export const CAPTURE_STALL_MS = 4000;

export function captureStallMs(deliveryMs = 0) {
    const every = Math.max(0, Number(deliveryMs) || 0);
    if (!every) return CAPTURE_STALL_MS;
    return Math.max(CAPTURE_STALL_MS, every * 2 + CAPTURE_STALL_MS);
}

export function initialCaptureHealth(nowMs = 0) {
    const at = Number(nowMs) || 0;
    return { progress: 0, at, lastProgressAt: at, stalled: false, muted: false,
             suspended: false, gapMs: 0, resumeTried: false, longestGapMs: 0 };
}

export function nextCaptureHealth(previous, {
    progress = 0, nowMs = 0, muted = false, suspended = false, stallMs = CAPTURE_STALL_MS
} = {}) {
    const prev = previous || initialCaptureHealth(nowMs);
    const now = Number(nowMs) || 0;
    const total = Math.max(0, Number(progress) || 0);
    const grew = total > prev.progress;
    const lastProgressAt = grew ? now : prev.lastProgressAt;
    const since = Math.max(0, now - lastProgressAt);
    const silent = since >= Math.max(1, stallMs);
    const stalled = !!muted || silent;
    const gapMs = stalled ? since : 0;
    return {
        progress: total,
        at: now,
        lastProgressAt,
        stalled,
        muted: !!muted,
        suspended: !!suspended,
        gapMs,
        resumeTried: stalled ? (prev.stalled ? prev.resumeTried : false) : false,
        longestGapMs: Math.max(prev.longestGapMs || 0, gapMs)
    };
}

export function captureHealthTransition(previous, next) {
    const was = !!(previous && previous.stalled);
    const is = !!(next && next.stalled);
    if (!was && is) return 'stalled';
    if (was && !is) return 'recovered';
    return 'none';
}

export function shouldTryResume(state) {
    return !!(state && state.stalled && state.suspended && !state.resumeTried);
}

function seconds(ms) {
    return Math.max(1, Math.round((Number(ms) || 0) / 1000));
}

export function describeCaptureStall(state) {
    const why = state && state.muted
        ? 'the microphone was taken by something else'
        : (state && state.suspended
            ? 'audio processing was suspended by the system'
            : 'no audio is reaching the recorder');
    return `⚠️ Not recording sound right now - ${why}. `
         + `The recording is still running and everything captured so far is safe.`;
}

export function describeCaptureRecovery(state) {
    return `✅ Sound is reaching the recorder again after ${seconds(state && state.gapMs)}s. `
         + `That gap is missing from the audio and the file is marked incomplete.`;
}

export function capturedMs(samples, sampleRate) {
    const count = Math.max(0, Number(samples) || 0);
    const rate = Number(sampleRate) || 0;
    if (!count || rate <= 0) return 0;
    return Math.round((count / rate) * 1000);
}

export function samplesBeforeTap(graphNowSec, graphStartSec, sampleRate) {
    if (graphStartSec === null || graphStartSec === undefined) return 0;
    const now = Number(graphNowSec);
    const start = Number(graphStartSec);
    const rate = Number(sampleRate) || 0;
    if (!Number.isFinite(now) || !Number.isFinite(start) || rate <= 0 || now <= start) return 0;
    return Math.round((now - start) * rate);
}

export const HEARTBEAT_ROW_REFRESH_MS = 60000;

export const LIVE_SNAPSHOT_MIN_INTERVAL_MS = 60000;
export const LIVE_SNAPSHOT_MAX_INTERVAL_MS = 5 * 60000;
export const LIVE_SNAPSHOT_MIN_GROWTH_SHARE = 0.25;
export const LIVE_SNAPSHOT_MIN_GROWTH_CHARS = 4000;
// Below this a live transcript costs next to nothing to write, so it is saved every minute it
// changed (Build 143). The growth rule below exists for transcripts of hours; applied to one of a
// few minutes it left nearly all of it unsaved until Stop, and a browser that died at Stop took it.
export const LIVE_SNAPSHOT_SMALL_CHARS = 32000;

export function liveSnapshotDue({ now = 0, last = null, chars = 0, signature = '' } = {}) {
    if (!last) return Number(chars) > 0;
    const transcriptUnchanged = signature === last.signature;
    if (transcriptUnchanged) return false;
    const sinceLastSnapshotMs = Number(now) - (Number(last.at) || 0);
    if (sinceLastSnapshotMs < LIVE_SNAPSHOT_MIN_INTERVAL_MS) return false;
    if (sinceLastSnapshotMs >= LIVE_SNAPSHOT_MAX_INTERVAL_MS) return true;
    if (Number(chars) <= LIVE_SNAPSHOT_SMALL_CHARS) return true;
    const charsAtLastSnapshot = Math.max(0, Number(last.chars) || 0);
    const grownChars = Number(chars) - charsAtLastSnapshot;
    return grownChars >= Math.max(LIVE_SNAPSHOT_MIN_GROWTH_CHARS, charsAtLastSnapshot * LIVE_SNAPSHOT_MIN_GROWTH_SHARE);
}

// The beat is what recovery reads when a stop could not save the row, so it has to keep saying
// that capture failed and audio is missing for as long as the recording is being finalized,
// also after the recording's own state was torn down.
// While Stop runs, the beat also names the step it has reached (`stopStep`, Build 143), so a
// recording recovered after the browser died during Stop can say where.
export function captureBeatRecord({ recId, ownerId = null, sessionId = null, now = 0, durationMs = 0,
                                    capturedMs = 0, state = '', captureFlags = null, stopStep = null } = {}) {
    const beat = {
        recId, ownerId, sessionId: sessionId || null, heartbeatAt: now,
        durationMs: Math.max(0, Number(durationMs) || 0), capturedMs, state
    };
    if (captureFlags && captureFlags.captureError) {
        beat.captureError = { ...captureFlags.captureError };
        beat.incompleteAudio = !!captureFlags.incompleteAudio;
    }
    if (stopStep) beat.stopStep = String(stopStep);
    return beat;
}

// The steps of Stop, in the order it takes them. Each is written to the beat before it begins.
// Everything the recording held only in memory is saved in the first one, before the microphone,
// the encoder or the audio graph are touched.
export const STOP_STEPS = Object.freeze({
    securing: 'saving what was only in memory',
    releasing: 'letting go of the microphone and the encoder',
    liveTail: 'finishing the live transcript',
    noting: 'noting the stop on the recording',
    closing: 'closing the audio',
    saving: 'putting the recording together'
});
// Stop finished without saving the recording, a full disk say: its beat stays for recovery, and
// recovery must not report the app as closed under it.
export const STOP_ENDED = 'ended';

// What a recording keeps about the app having been closed under it (by the person, the browser or
// the phone): while it was recording, or while Stop was at a given step. Recovery writes it from the
// recording's last beat; the list shows it until it is dismissed.
export function interruptionFromBeat(beat) {
    if (!beat || !(Number(beat.heartbeatAt) > 0)) return null;
    if (beat.state === 'recording' || beat.state === 'starting') {
        return { during: 'recording', lastAliveAt: Number(beat.heartbeatAt) };
    }
    if (beat.state !== 'finalizing' || beat.stopStep === STOP_ENDED) return null;
    const step = Object.prototype.hasOwnProperty.call(STOP_STEPS, beat.stopStep) ? beat.stopStep : null;
    return { during: 'stop', ...(step ? { step } : {}), lastAliveAt: Number(beat.heartbeatAt) };
}

export function describeInterruption(interruption) {
    if (!interruption || !interruption.during) return '';
    const step = interruption.step && STOP_STEPS[interruption.step];
    const when = interruption.during === 'recording'
        ? 'while it was recording, before it could save the recording itself'
        : step ? `while it was stopping this recording (${step})` : 'while it was stopping this recording';
    const audioWhole = interruption.during === 'stop' && !!step && interruption.step !== 'securing';
    return `myAI was closed ${when}. `
        + (audioWhole
            ? 'Its audio had been saved by then and was put together from the saved pieces.'
            : 'It was put together from the pieces it had saved, so at most the last few seconds of audio are missing.');
}

export function heartbeatRowDue({ last = null, recId = null, state = '', now = 0,
                                  force = false, snapshotted = false } = {},
                                refreshMs = HEARTBEAT_ROW_REFRESH_MS) {
    if (force || snapshotted) return true;
    if (!last || last.recId !== recId || last.state !== state) return true;
    return Number(now) - (Number(last.at) || 0) >= refreshMs;
}

export function honestDuration(wallClockMs, capturedMsValue) {
    const wall = Math.max(0, Number(wallClockMs) || 0);
    const captured = Math.max(0, Number(capturedMsValue) || 0);
    if (!captured) return wall;
    return Math.min(wall, captured);
}

export const FILE_LENGTH_SLACK_MS = 60000;

export function opusLengthMs({ fileMs = null, wallMs = 0, capturedMs = 0, elapsedMs = Infinity } = {}) {
    const file = Number(fileMs);
    if (fileMs != null && Number.isFinite(file) && file > 0 && file <= Number(elapsedMs) + FILE_LENGTH_SLACK_MS) {
        return Math.round(file);
    }
    return honestDuration(wallMs, capturedMs);
}

export const AUTO_GAIN_HOLD_RMS = 0.0005;
export const AUTO_GAIN_TARGET_RMS = 0.15;
export const AUTO_GAIN_MIN = 0.05;
export const AUTO_GAIN_MAX = 24;

// The level the automatic gain steers by, read as floats. The byte reading rounds every sample
// down to a step of 1/128, so any real noise read about 0.0055 RMS, the hold for near-silence never
// fired, the gain climbed to its cap in every pause and the next word hit the limiter.
export function meterLevel(analyser, samples) {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        sum += value * value;
        const size = value < 0 ? -value : value;
        if (size > peak) peak = size;
    }
    return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak };
}

// The next gain, or null to leave it alone while there is next to nothing to hear.
export function nextAutoGain(gain, { rms = 0, peak = 0 } = {}) {
    if (!(rms >= AUTO_GAIN_HOLD_RMS)) return null;
    const ratio = AUTO_GAIN_TARGET_RMS / rms;
    let next = gain * (1 + (ratio < 1 ? 0.35 : 0.08) * (ratio - 1));
    if (peak > 0.9) next *= 0.6;
    return Math.min(Math.max(next, AUTO_GAIN_MIN), AUTO_GAIN_MAX);
}

// The limiter after the automatic gain. Web Audio clamps a value outside an AudioParam's nominal
// range and says so in the console, so every setting stays inside it: 20 is the steepest ratio a
// DynamicsCompressorNode takes (Build 133 asked for 30 and was given 20).
export const DYNAMICS_COMPRESSOR_RANGES = Object.freeze({
    threshold: [-100, 0], knee: [0, 40], ratio: [1, 20], attack: [0, 1], release: [0, 1]
});
export const LIMITER_SETTINGS = Object.freeze({ threshold: -8, knee: 2, ratio: 20, attack: 0.003, release: 0.080 });
