export const NO_WORKER_LABEL = 'dev';
export const CONFIRMED_MS = 4000;

// loaded: the build this page runs. incoming: a build that is downloading. waiting: a build that is
// installed and waits to be asked to take over. pending: a build that already serves this origin,
// while this page still runs the one before. installFailed: a build whose install failed.
export function initialUpdateState() {
    return { loaded: null, incoming: null, waiting: null, pending: null, server: null, installFailed: null,
             checking: false, tried: false, confirmedAt: 0, failedAt: 0 };
}

// The build a reload lands on: one that already serves, or one that is installed and is asked to
// take over just before the reload; the newer of the two when there are both.
export function readyBuild(state) {
    if (!state) return null;
    const { pending, waiting } = state;
    if (pending && waiting) return olderBuild(pending, waiting) ? waiting : pending;
    return pending || waiting || null;
}

export function noteServerBuild(state, reported) {
    const value = String(reported || '');
    if (!value) return state;
    return { ...state, server: value };
}

export function updateStuck(state) {
    if (!state || !state.tried || state.checking) return false;
    if (readyBuild(state) || state.incoming || state.installFailed) return false;
    if (!state.server || !state.loaded) return false;
    return state.server !== state.loaded;
}

// Whether build `a` is older than build `b`, when both are numbered builds.
function olderBuild(a, b) {
    const na = /^v(\d+)$/.exec(String(a || ''));
    const nb = /^v(\d+)$/.exec(String(b || ''));
    return !!(na && nb) && Number(na[1]) < Number(nb[1]);
}

// A build reported as serving is no longer downloading or waiting.
function settledAs(state, value) {
    return {
        incoming: state.incoming === value ? null : state.incoming,
        waiting: state.waiting === value ? null : state.waiting
    };
}

export function noteLoadedVersion(state, reported) {
    const value = String(reported || '');
    if (!value) return state;
    if (!state.loaded) return { ...state, ...settledAs(state, value), loaded: value, pending: null };
    if (value === state.loaded) return { ...state, ...settledAs(state, value), pending: null };
    // A page loaded past the worker (a hard reload) can be newer than the build still serving;
    // reloading into that one would be a step back, so it is not offered.
    if (olderBuild(value, state.loaded)) return { ...state, ...settledAs(state, value), pending: null };
    return { ...state, ...settledAs(state, value), pending: value, installFailed: null };
}

export function noteInstallingVersion(state, reported) {
    const value = String(reported || '');
    if (!value || !state.loaded) return state;
    if (value === state.loaded || readyBuild(state) === value) return state;
    return { ...state, incoming: value, installFailed: null };
}

export function noteWaitingVersion(state, reported) {
    const value = String(reported || '');
    if (!value || !state.loaded) return state;
    const incoming = state.incoming === value ? null : state.incoming;
    if (value === state.loaded) return { ...state, incoming, waiting: null };
    return { ...state, incoming, waiting: value, installFailed: null };
}

export function noteNothingWaiting(state) {
    return state && state.waiting ? { ...state, waiting: null } : state;
}

// The install stopped short: a file of the new build could not be downloaded or stored. Without
// this the page kept saying the build was installing, and its button stayed disabled.
export function noteInstallFailed(state, reported) {
    const value = String(reported || state.incoming || '');
    return { ...state, incoming: null, installFailed: value || 'the new build' };
}

export function noteCheckStarted(state) {
    return { ...state, checking: true, tried: false, confirmedAt: 0, failedAt: 0, installFailed: null };
}

export function noteCheckFinished(state, nowMs = 0, ok = true) {
    if (!ok) return { ...state, checking: false, tried: true, confirmedAt: 0, failedAt: nowMs };
    const settled = readyBuild(state) || state.incoming || state.installFailed
        || (state.server && state.loaded && state.server !== state.loaded);
    return { ...state, checking: false, tried: true, failedAt: 0, confirmedAt: settled ? 0 : nowMs };
}

function transient(at, nowMs) {
    return at > 0 && (nowMs - at) < CONFIRMED_MS;
}

export function describeVersion(state, nowMs = 0) {
    if (!state || (!state.loaded && !state.checking)) return NO_WORKER_LABEL;
    if (!state.loaded) return NO_WORKER_LABEL;
    if (readyBuild(state)) return `${state.loaded} › ${readyBuild(state)}`;
    if (state.incoming || state.checking) return `${state.loaded} ⟳`;
    if (state.installFailed) return `${state.loaded} ⚠`;
    if (updateStuck(state)) return `${state.loaded} › ${state.server}`;
    if (transient(state.failedAt, nowMs)) return `${state.loaded} ⚠`;
    if (transient(state.confirmedAt, nowMs)) return `${state.loaded} ✓`;
    return state.loaded;
}

export function describeVersionTitle(state, nowMs = 0) {
    if (!state || !state.loaded) return 'No installed shell is serving this page. Tap to look for one.';
    if (readyBuild(state)) {
        return `Build ${readyBuild(state)} is installed. This page is still ${state.loaded}; `
             + `tap to reload into ${readyBuild(state)}.`;
    }
    if (state.incoming) return `Build ${state.incoming} is downloading. It can be loaded once it finishes.`;
    if (state.checking) return `Running build ${state.loaded}. Asking the server for a newer one...`;
    if (state.installFailed) {
        return `Build ${state.installFailed} could not be installed: not all of its files could be downloaded `
             + `and stored. This page is still ${state.loaded}; tap to try again.`;
    }
    if (updateStuck(state)) {
        return `The server has build ${state.server}, but this browser keeps handing back its cached copy of `
             + `build ${state.loaded}. Tap to clear the installed shell and load ${state.server}. `
             + `Recordings and settings are not touched.`;
    }
    if (transient(state.failedAt, nowMs)) return `Running build ${state.loaded}. The check could not reach the server.`;
    return `Running build ${state.loaded}. Tap to check for a newer build.`;
}

export function describeUpdateState(state, nowMs = 0) {
    if (!state || !state.loaded) return 'No installed shell is serving this page yet.';
    if (readyBuild(state)) return `Build ${readyBuild(state)} is ready. This page is still running ${state.loaded}.`;
    if (state.incoming) return `Running build ${state.loaded}. Build ${state.incoming} is downloading...`;
    if (state.checking) return `Running build ${state.loaded}. Checking for a newer one...`;
    if (state.installFailed) {
        return `Running build ${state.loaded}. Build ${state.installFailed} could not be installed: `
             + `not all of its files could be downloaded and stored.`;
    }
    if (updateStuck(state)) {
        return `The server has build ${state.server}; this browser is holding a cached copy of build `
             + `${state.loaded} and will not replace it. Clearing the installed shell fixes that, and `
             + `leaves recordings and settings alone.`;
    }
    if (transient(state.failedAt, nowMs)) return `Running build ${state.loaded}. The update check could not reach the server.`;
    if (transient(state.confirmedAt, nowMs)) return `Running build ${state.loaded}, which is the newest the server has.`;
    return `Running build ${state.loaded}.`;
}

export function describeUpdateButton(state) {
    if (readyBuild(state)) return `Reload into ${readyBuild(state)}`;
    if (state && state.incoming) return `Installing ${state.incoming}...`;
    if (state && state.checking) return 'Checking...';
    if (state && state.installFailed) return `Try installing ${state.installFailed} again`;
    if (updateStuck(state)) return `Clear the shell and load ${state.server}`;
    return 'Check for update';
}

export function updateAction(state) {
    if (readyBuild(state)) return 'reload';
    if (state && state.incoming) return 'installing';
    if (updateStuck(state)) return 'force';
    return 'check';
}

export function updateBusy(state) {
    return !!(state && (state.checking || state.incoming));
}

export function updateBlocked(state, { recording = false } = {}) {
    const action = updateAction(state);
    return (action === 'reload' || action === 'force') && recording === true;
}

export function describeBlockedUpdate(state) {
    const pending = readyBuild(state) || (state && state.server) || 'the new build';
    return 'Something is still running in this tab (a recording, its save, a transcription, a reply or a backup), '
         + 'so the page will not be reloaded now. '
         + `Let it finish or stop it, then tap the version again to load ${pending}.`;
}

export function needsRepaintAt(state, nowMs = 0) {
    for (const at of [state && state.confirmedAt, state && state.failedAt]) {
        if (transient(at, nowMs)) return at + CONFIRMED_MS;
    }
    return 0;
}
