/* ==========================================================================
   jobs.js - Cancellation registry.

   Each recording has one active transcription slot (t) and one reply slot (r).
   Replacing a slot aborts its previous controller. Cleanup is identity-safe: an
   older job finishing late cannot unregister the controller of a newer job.
   ========================================================================== */

const controllers = new Map();                 // "t-12" / "r-12" -> AbortController
const key = (kind, recId) => `${kind}-${recId}`;

export function beginJob(kind, recId) {
    cancelJob(kind, recId);
    const controller = new AbortController();
    controllers.set(key(kind, recId), controller);
    return controller;
}

/**
 * End a slot only when it still belongs to `controller`. Passing no controller
 * is retained for backwards compatibility, but new callers should always pass
 * the controller returned by beginJob().
 */
export function endJob(kind, recId, controller = null) {
    const k = key(kind, recId);
    if (controller && controllers.get(k) !== controller) return false;
    return controllers.delete(k);
}

export function cancelJob(kind, recId) {
    const k = key(kind, recId);
    const controller = controllers.get(k);
    if (!controller) return false;
    controllers.delete(k);                     // delete first; abort handlers may re-enter
    try { controller.abort(); } catch (_) {}
    return true;
}

/** Cancel both transcription and reply for one recording. */
export function cancelAllForRec(recId) {
    cancelJob('t', recId);
    cancelJob('r', recId);
}

/** Cancel every active job, used before destructive bulk operations. */
export function cancelAllJobs() {
    const active = [...controllers.values()];
    controllers.clear();
    for (const controller of active) {
        try { controller.abort(); } catch (_) {}
    }
}

export function hasJob(kind, recId) {
    return controllers.has(key(kind, recId));
}

/** Exposed for deterministic tests; not used by the UI. */
export function getJobController(kind, recId) {
    return controllers.get(key(kind, recId)) || null;
}

/** Build an Error that downstream code recognises as a user cancellation. */
export function abortError(message = 'Cancelled') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
