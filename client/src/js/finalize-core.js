// How a recording's row changes when it is saved, or when saving it fails. recorder.js applies
// these inside the transaction that stores the audio or notes the failure.
import { getLocalIso, fmtDur } from './config.js';

// What the capture met before Stop: a storage error, and audio that could not be kept.
export function applyStopFlags(rec, flags) {
    if (!rec || !flags || !flags.captureError) return rec;
    rec.captureError = { ...flags.captureError };
    if (flags.incompleteAudio) rec.incompleteAudio = true;
    rec.unsavedFragmentCount = flags.unsavedFragmentCount || 0;
    rec.unsavedBytes = flags.unsavedBytes || 0;
    return rec;
}

// When the recording stopped, by the wall clock: its last heartbeat, not its start plus the length
// of the audio that was saved, which is shorter when capture stalled or a disk filled up.
export function noteRecordingEnded(rec, lastAliveAt = 0) {
    const startedAt = Number(rec.timestamp) || 0;
    rec.endedAt = Math.max(Number(rec.endedAt) || 0, Number(rec.heartbeatAt) || 0, Number(lastAliveAt) || 0,
                           startedAt > 0 ? startedAt + Math.max(0, Number(rec.durationMs) || 0) : 0);
    return rec;
}

// A saved recording: finished, named after when it started and how long it is, and no longer
// owned or being finalized by any tab.
export function markFinalized(rec, durationMs, noAudio = false) {
    noteRecordingEnded(rec);
    rec.durationMs  = Math.max(0, durationMs || 0);
    rec.processing  = false;
    rec.captureState = rec.incompleteAudio ? 'ready-incomplete' : 'ready';
    const suffix = noAudio ? ' (no audio)' : (rec.incompleteAudio ? ' (incomplete)' : '');
    rec.filename = `${getLocalIso(rec.timestamp)} - ${fmtDur(rec.durationMs)}${suffix}`;
    delete rec.ownerId;
    delete rec.heartbeatAt;
    delete rec.finalizationError;
    delete rec.finalizationErrorAt;
    delete rec.finalizerId;
    delete rec.finalizerHeartbeatAt;
    return rec;
}

// A recording whose save failed: still unfinished, so its pieces are kept and it can be retried
// or recovered, with the error it met and when.
export function markSaveFailed(rec, { durationMs = 0, error = null, stopFlags = null, now = Date.now() } = {}) {
    applyStopFlags(rec, stopFlags);
    noteRecordingEnded(rec);
    rec.durationMs = Math.max(rec.durationMs || 0, durationMs || 0);
    rec.processing = true;
    rec.captureState = 'finalize-error';
    rec.finalizationError = error && error.message ? error.message : String(error);
    rec.finalizationErrorAt = now;
    delete rec.ownerId;
    delete rec.heartbeatAt;
    delete rec.finalizerId;
    delete rec.finalizerHeartbeatAt;
    return rec;
}
