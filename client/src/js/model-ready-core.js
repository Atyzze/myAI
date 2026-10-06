export const MODEL_LOAD_BUDGET_MS = 600000;
export const MODEL_PROBE_MS = 3000;
export const MODEL_SWAP_GRACE_MS = 90000;
export const MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE = 4;
export const MODEL_KEEP_ALIVE = '30m';
export const MODEL_GENERATE_ATTEMPTS = 2;
export const AI_NUM_CTX = 16384;
export const AI_MAX_NUM_CTX = 32768;

export const FIRST_BYTE_WAIT_WHEN_MODEL_RELOADS_MS = 180000;

export function firstByteTimeoutMs(numCtx, baseMs, { reloadWaitMs = FIRST_BYTE_WAIT_WHEN_MODEL_RELOADS_MS } = {}) {
    const base = Math.max(1, Number(baseMs) || 0);
    const modelReloadsForLargerContext = Number(numCtx) > AI_NUM_CTX;
    return modelReloadsForLargerContext ? Math.max(base, reloadWaitMs) : base;
}

export function normalizeModelName(name) {
    const value = String(name ?? '').trim();
    if (!value) return '';
    return value.includes(':') ? value : `${value}:latest`;
}

export function sameModel(a, b) {
    const left = normalizeModelName(a);
    const right = normalizeModelName(b);
    return left !== '' && left === right;
}

export function loadedModelNames(payload) {
    const rows = (payload && payload.models) || [];
    const names = [];
    for (const row of rows) {
        const name = String((row && (row.name || row.model)) || '').trim();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

export function isModelResident(loaded, wanted) {
    return (loaded || []).some(name => sameModel(name, wanted));
}

export function otherResidentModels(loaded, wanted) {
    return (loaded || [])
        .map(name => String(name || '').trim())
        .filter(name => name && !sameModel(name, wanted));
}

export function nextModelStep({
    wanted,
    loaded = [],
    waitedMs = 0,
    released = false,
    probeFailures = 0
} = {}, {
    budgetMs = MODEL_LOAD_BUDGET_MS,
    graceMs = MODEL_SWAP_GRACE_MS,
    maxProbeFailures = MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE
} = {}) {
    if (!normalizeModelName(wanted)) return { action: 'ready', release: [] };
    if (isModelResident(loaded, wanted)) return { action: 'ready', release: [] };
    if (probeFailures >= maxProbeFailures) return { action: 'unreachable', release: [] };
    if (waitedMs >= budgetMs) return { action: 'too-slow', release: [] };

    const others = otherResidentModels(loaded, wanted);
    if (!released && waitedMs >= graceMs && others.length) {
        return { action: 'release', release: others };
    }
    return { action: 'wait', release: [] };
}

export function shortWait(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - (minutes * 60));
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function describeModelLoad({ model, waitedMs = 0, released = false, loaded = [] } = {}) {
    const name = String(model || 'the model');
    const elapsed = shortWait(waitedMs);
    const others = otherResidentModels(loaded, model);
    if (released) return `Freed ${others.length ? others.join(', ') + '; ' : ''}still loading ${name} (${elapsed})...`;
    if (others.length) return `Loading ${name} on the server, replacing ${others.join(', ')} (${elapsed})...`;
    return `Loading ${name} on the server (${elapsed})...`;
}

export function describeModelFailure(action, { model, waitedMs = 0 } = {}) {
    const name = String(model || 'the model');
    const elapsed = shortWait(waitedMs);
    if (action === 'unreachable') {
        return `The reply server stopped answering while loading ${name} (after ${elapsed}).`;
    }
    return `${name} was still not loaded after ${elapsed}. The server is answering, so it is not offline; `
         + `the model may be too large for it to bring up, or something else is holding the memory.`;
}

export function shouldRetryGenerate({
    attempt = 1,
    maxAttempts = MODEL_GENERATE_ATTEMPTS,
    preflightSucceeded = false,
    aborted = false
} = {}) {
    if (aborted) return false;
    if (!preflightSucceeded) return false;
    return attempt < maxAttempts;
}

export function describeFirstByteTimeout({ model, timeoutMs, preflightSucceeded = false } = {}) {
    const name = String(model || 'the model');
    const seconds = Math.round((Number(timeoutMs) || 0) / 1000);
    if (preflightSucceeded) {
        return `${name} was loaded but produced nothing within ${seconds} seconds; it may have been unloaded again.`;
    }
    return `Reply server did not respond within ${seconds} seconds.`;
}
