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
    delete rec.saveAttempts;
    delete rec.saveHalted;
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
    // The save ended, if badly: it did not take the browser down with it.
    delete rec.saveAttempts;
    delete rec.saveHalted;
    return rec;
}

// A save is counted on its recording before it begins and the count is removed when it ends,
// saved or failed (Build 145). A count left on the row is a save the browser died during. When
// saving one recording has taken the browser down limit times, the app stops saving it by itself:
// otherwise every launch would begin the same save and die again. It stays unfinished with all
// its pieces, and its row offers Retry, the audio saved so far, and Delete.
export function beginSave(rec, { limit = 2, automatic = true, now = Date.now() } = {}) {
    const crashes = Math.max(0, Number(rec.saveAttempts) || 0);
    if (automatic && (rec.saveHalted || crashes >= limit)) return markSaveHalted(rec, { crashes, now });
    rec.saveAttempts = crashes + 1;
    delete rec.saveHalted;
    return rec;
}

export function markSaveHalted(rec, { crashes = 0, now = Date.now() } = {}) {
    rec.processing = true;
    rec.captureState = 'finalize-error';
    rec.saveHalted = true;
    rec.saveAttempts = Math.max(Number(rec.saveAttempts) || 0, crashes);
    rec.finalizationError = `Saving this recording closed the browser ${crashes === 1 ? 'once' : `${crashes} times`}, `
        + 'so the app no longer tries it by itself. Its pieces are all kept: ⬇️ Audio saved so far takes the audio out '
        + 'as it is, and Retry finalization tries again, the plainest way.';
    rec.finalizationErrorAt = now;
    delete rec.ownerId;
    delete rec.heartbeatAt;
    delete rec.finalizerId;
    delete rec.finalizerHeartbeatAt;
    return rec;
}

// How many saves of this recording the browser has died during.
export function saveCrashes(rec) {
    return Math.max(0, Number(rec && rec.saveAttempts) || 0);
}
