/* ==========================================================================
   jobs.js — Cancellation registry. Each recording can have an in-flight
   'transcribe' (t) and/or 'reply' (r) job, each backed by an AbortController.
   ========================================================================== */

const controllers = {};                       // "t-12" / "r-12" -> AbortController
const key = (kind, recId) => `${kind}-${recId}`;

export function beginJob(kind, recId) {
    // Replace any stale controller for this slot
    cancelJob(kind, recId);
    const c = new AbortController();
    controllers[key(kind, recId)] = c;
    return c;
}

export function endJob(kind, recId) {
    delete controllers[key(kind, recId)];
}

export function cancelJob(kind, recId) {
    const c = controllers[key(kind, recId)];
    if (c) { try { c.abort(); } catch (_) {} }
    delete controllers[key(kind, recId)];
}

/** Cancel both transcription and reply for a recording (used by the ✕ button). */
export function cancelAllForRec(recId) {
    cancelJob('t', recId);
    cancelJob('r', recId);
}

export function hasJob(kind, recId) {
    return !!controllers[key(kind, recId)];
}

/** Build an Error that downstream code recognises as a user cancellation. */
export function abortError(message = 'Cancelled') {
    const e = new Error(message);
    e.name = 'AbortError';
    return e;
}
