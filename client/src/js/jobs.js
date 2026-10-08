const controllers = new Map();
const key = (kind, recId) => `${kind}-${recId}`;

export function beginJob(kind, recId) {
    cancelJob(kind, recId);
    const controller = new AbortController();
    controllers.set(key(kind, recId), controller);
    return controller;
}

export function endJob(kind, recId, controller = null) {
    const k = key(kind, recId);
    if (controller && controllers.get(k) !== controller) return false;
    return controllers.delete(k);
}

export function cancelJob(kind, recId) {
    const k = key(kind, recId);
    const controller = controllers.get(k);
    if (!controller) return false;
    controllers.delete(k);
    try { controller.abort(); } catch (_) {}
    return true;
}

export function cancelAllForRec(recId) {
    cancelJob('t', recId);
    cancelJob('r', recId);
    cancelJob('f', recId);
}

export function cancelAllJobs() {
    const active = [...controllers.values()];
    controllers.clear();
    for (const controller of active) {
        try { controller.abort(); } catch (_) {}
    }
}

export function hasAnyJob() {
    return controllers.size > 0;
}

export function hasJob(kind, recId) {
    return controllers.has(key(kind, recId));
}

export function hasJobOfKind(kind) {
    const prefix = `${kind}-`;
    for (const k of controllers.keys()) if (k.startsWith(prefix)) return true;
    return false;
}

export function abortError(message = 'Cancelled') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function singleFlight(task) {
    let running = null;
    return () => {
        if (!running) running = Promise.resolve().then(task).finally(() => { running = null; });
        return running;
    };
}

export const CANCELLED = 'cancelled';

export async function runInOrderUntilCancelled(tasks, reportFailedStep = () => {}) {
    for (const [index, task] of (tasks || []).entries()) {
        try {
            if (await task() === CANCELLED) return CANCELLED;
        } catch (err) {
            if (err && err.name === 'AbortError') return CANCELLED;
            reportFailedStep(err, index);
        }
    }
    return 'done';
}
