import { initialUpdateState, noteLoadedVersion, noteInstallingVersion, noteWaitingVersion, noteNothingWaiting,
         noteInstallFailed, noteServerBuild, noteCheckStarted, noteCheckFinished, describeVersion,
         describeVersionTitle, describeUpdateState, describeUpdateButton, updateAction, updateBusy, updateBlocked,
         describeBlockedUpdate, needsRepaintAt, readyBuild, NO_WORKER_LABEL } from './update-core.js';

const ASK_TIMEOUT_MS = 3000;
const UPDATE_TIMEOUT_MS = 20000;
const ACTIVATION_TIMEOUT_MS = 30000;
const SETTLED_WORKER_STATES = new Set(['installed', 'activating', 'activated', 'redundant']);

function askWorkerVersion(worker, timeoutMs = ASK_TIMEOUT_MS) {
    return new Promise(resolve => {
        if (!worker || typeof worker.postMessage !== 'function') { resolve(null); return; }

        let channel;
        let settled = false;
        let timer = null;
        const settle = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { channel?.port1.close(); } catch (_) {}
            resolve(value);
        };

        try {
            channel = new MessageChannel();
            channel.port1.onmessage = event => {
                const data = event && event.data;
                settle(data && typeof data.version === 'string' ? data.version : null);
            };
            worker.postMessage({ type: 'version' }, [channel.port2]);
        } catch (_) {
            settle(null);
            return;
        }

        if (!settled) timer = setTimeout(() => settle(null), timeoutMs);
    });
}

function withinTime(promise, timeoutMs, fallback = null) {
    let timer = null;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function container() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
    return navigator.serviceWorker;
}

async function registrationOf(timeoutMs) {
    const sw = container();
    if (!sw || typeof sw.getRegistration !== 'function') return null;
    try {
        return await withinTime(Promise.resolve(sw.getRegistration()).catch(() => null), timeoutMs);
    } catch (_) {
        return null;
    }
}

async function servingWorker(timeoutMs) {
    const sw = container();
    if (!sw) return null;
    if (sw.controller) return sw.controller;
    const registration = await registrationOf(timeoutMs);
    return (registration && registration.active) || null;
}

async function incomingWorker(timeoutMs) {
    const registration = await registrationOf(timeoutMs);
    if (!registration) return null;
    return registration.installing || registration.waiting || null;
}

// Resolves with the state a worker settles in once it has stopped installing: installed (and waiting,
// when another worker serves), activating or activated, or redundant when its install failed.
function settledWorkerState(worker) {
    return new Promise(resolve => {
        if (!worker) { resolve(null); return; }
        if (SETTLED_WORKER_STATES.has(worker.state)) { resolve(worker.state); return; }
        if (typeof worker.addEventListener !== 'function') { resolve(null); return; }
        const onChange = () => {
            if (!SETTLED_WORKER_STATES.has(worker.state)) return;
            try { worker.removeEventListener('statechange', onChange); } catch (_) {}
            resolve(worker.state);
        };
        worker.addEventListener('statechange', onChange);
    });
}

export async function readShellVersion({ timeoutMs = ASK_TIMEOUT_MS } = {}) {
    const worker = await servingWorker(timeoutMs);
    return askWorkerVersion(worker, timeoutMs);
}

export async function readIncomingVersion({ timeoutMs = ASK_TIMEOUT_MS } = {}) {
    const worker = await incomingWorker(timeoutMs);
    return askWorkerVersion(worker, timeoutMs);
}

let _announced = null;
let _state = initialUpdateState();
let _paint = () => {};
let _check = () => Promise.resolve(_state);
let _isBusy = () => false;
let _reload = () => { try { location.reload(); } catch (_) {} };

export function updateState() { return _state; }

export function setUpdateBusyCheck(fn) { _isBusy = typeof fn === 'function' ? fn : (() => false); }

export function setUpdateReloader(fn) { _reload = typeof fn === 'function' ? fn : _reload; }

export function documentBuild() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    let content = null;
    try { content = document.querySelector('meta[name="myai-build"]')?.getAttribute('content'); }
    catch (_) { return null; }
    const digits = String(content || '').trim();
    return /^\d+$/.test(digits) ? `v${digits}` : null;
}

function workerScriptUrl() {
    const base = (typeof document !== 'undefined' && document.baseURI)
        || (typeof location !== 'undefined' && location.href) || '';
    if (!base) return 'sw.js';
    try { return new URL('sw.js', base).href; } catch (_) { return 'sw.js'; }
}

// A server that takes the request and never answers would otherwise hold the update check, and the
// button that started it, on "Checking..." for good: the read is given up on, and cancelled.
export async function refreshWorkerScript({ timeoutMs = UPDATE_TIMEOUT_MS } = {}) {
    if (typeof fetch !== 'function') return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const read = (async () => {
        const res = await fetch(workerScriptUrl(), { cache: 'reload', ...(ctrl ? { signal: ctrl.signal } : {}) });
        if (!res || !res.ok) return null;
        const text = await res.text();
        return (text.match(/const VERSION\s*=\s*'(v\d+)'/) || [])[1] || null;
    })().catch(() => null);
    const version = await withinTime(read, timeoutMs, null);
    if (ctrl) ctrl.abort();
    return version;
}

function byId(id) {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
    try { return document.getElementById(id); } catch (_) { return null; }
}

export function paintAppVersion(el, { timeoutMs = ASK_TIMEOUT_MS, now = () => Date.now(),
                                      activationTimeoutMs = ACTIVATION_TIMEOUT_MS } = {}) {
    let repaintTimer = null;
    _state = initialUpdateState();
    _state = noteLoadedVersion(_state, documentBuild());

    const paint = () => {
        const at = now();
        if (el) {
            const title = describeVersionTitle(_state, at);
            el.textContent = describeVersion(_state, at);
            el.title = title;
            if (typeof el.setAttribute === 'function') el.setAttribute('aria-label', title);
            if (el.classList && typeof el.classList.toggle === 'function') {
                el.classList.toggle('update-ready', !!readyBuild(_state));
                el.classList.toggle('update-checking', !!_state.checking);
            }
        }
        const panel = byId('help-version-state');
        if (panel) panel.textContent = describeUpdateState(_state, at);
        const button = byId('help-update-btn');
        if (button) {
            button.textContent = describeUpdateButton(_state);
            button.disabled = updateBusy(_state);
        }
        if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
        const due = needsRepaintAt(_state, at);
        if (due > at) {
            repaintTimer = setTimeout(paint, (due - at) + 50);
            if (repaintTimer && typeof repaintTimer.unref === 'function') repaintTimer.unref();
        }
    };
    _paint = paint;

    const noteServing = async () => {
        const serving = await readShellVersion({ timeoutMs });
        if (serving) {
            _state = noteLoadedVersion(_state, serving);
            paint();
        }
        return serving;
    };

    const followedWaits = new WeakSet();
    // A worker that is installed and waits is a build to reload into. It stops waiting when it takes
    // over (the controller changes, which repaints) or when a newer one replaces it.
    const noteWaitingWorker = async worker => {
        if (!worker) return;
        const version = await askWorkerVersion(worker, timeoutMs);
        if (version) {
            _state = noteWaitingVersion(_state, version);
            paint();
            // A page loaded past the worker (a hard reload) already runs the build that waits. It
            // takes over, so the next ordinary reload of any tab does not land on the older one.
            const sw = container();
            if (version === _state.loaded && sw && !sw.controller) {
                try { worker.postMessage({ type: 'activate-now' }); } catch (_) {}
            }
        }
        if (followedWaits.has(worker) || typeof worker.addEventListener !== 'function') return;
        followedWaits.add(worker);
        const onChange = () => {
            if (worker.state !== 'redundant') return;
            try { worker.removeEventListener('statechange', onChange); } catch (_) {}
            if (!version || _state.waiting === version) {
                _state = noteNothingWaiting(_state);
                paint();
            }
        };
        worker.addEventListener('statechange', onChange);
    };

    const followedInstalls = new WeakMap();
    // Follows a worker from installing to its outcome, which is painted whenever it comes, also
    // after the check that found it has ended: installed and waiting, taken over, or failed.
    const followInstall = (registration, worker) => {
        if (!worker) return Promise.resolve(null);
        if (followedInstalls.has(worker)) return followedInstalls.get(worker);
        const outcome = (async () => {
            const version = (await askWorkerVersion(worker, timeoutMs)) || _state.server;
            if (version) {
                _state = noteInstallingVersion(_state, version);
                paint();
            }
            const settled = await settledWorkerState(worker);
            if (settled === 'redundant') {
                _state = noteInstallFailed(_state, version);
                paint();
            } else if (settled === 'installed' && registration.waiting === worker && registration.active
                       && registration.active !== worker) {
                await noteWaitingWorker(worker);
            } else if (settled === 'activating' || settled === 'activated') {
                await noteServing();
            }
            return settled;
        })();
        followedInstalls.set(worker, outcome);
        return outcome;
    };

    const watchedRegistrations = new WeakSet();
    const watchRegistration = registration => {
        if (!registration || watchedRegistrations.has(registration)) return;
        watchedRegistrations.add(registration);
        if (typeof registration.addEventListener !== 'function') return;
        registration.addEventListener('updatefound', () => {
            followInstall(registration, registration.installing).catch(() => {});
        });
    };

    const inspectRegistration = async () => {
        const registration = await registrationOf(timeoutMs);
        if (!registration) return;
        watchRegistration(registration);
        if (registration.waiting) await noteWaitingWorker(registration.waiting);
        if (registration.installing) followInstall(registration, registration.installing).catch(() => {});
    };

    const refresh = async () => {
        const reported = await readShellVersion({ timeoutMs });
        _state = noteLoadedVersion(_state, reported);
        paint();
        if (reported && reported !== _announced) {
            _announced = reported;
            console.info(`myAI shell ${reported}`);
        }
        await inspectRegistration().catch(() => {});
        return reported;
    };

    _check = async () => {
        _state = noteCheckStarted(_state);
        paint();
        let ok = true;
        try {
            const served = await refreshWorkerScript();
            if (served) _state = noteServerBuild(_state, served);
            const registration = await registrationOf(timeoutMs);
            if (registration && typeof registration.update === 'function') {
                await withinTime(Promise.resolve(registration.update()).catch(() => { ok = false; }), UPDATE_TIMEOUT_MS);
            } else {
                ok = false;
            }
            if (registration) {
                watchRegistration(registration);
                if (registration.installing) {
                    await withinTime(followInstall(registration, registration.installing), activationTimeoutMs);
                } else if (registration.waiting) {
                    await noteWaitingWorker(registration.waiting);
                }
            }
            if (!readyBuild(_state) && !_state.incoming && !_state.installFailed) {
                const serving = await readShellVersion({ timeoutMs });
                if (serving) _state = noteLoadedVersion(_state, serving);
                else ok = false;
            }
        } catch (_) {
            ok = false;
        }
        _state = noteCheckFinished(_state, now(), ok);
        paint();
        return _state;
    };

    const sw = container();
    if (sw && typeof sw.addEventListener === 'function') {
        sw.addEventListener('controllerchange', () => {
            readShellVersion({ timeoutMs }).then(reported => {
                if (!reported) return;
                _state = noteLoadedVersion(_state, reported);
                _paint();
            }).catch(() => {});
        });
    }

    paint();
    refresh();
    return refresh;
}

async function clearInstalledShell() {
    try {
        const registration = await registrationOf(ASK_TIMEOUT_MS);
        if (registration && typeof registration.unregister === 'function') await registration.unregister();
    } catch (_) {}
    try {
        if (typeof caches !== 'undefined' && caches.keys) {
            const keys = await caches.keys();
            await Promise.all(keys.filter(key => String(key).startsWith('myai-shell-'))
                .map(key => caches.delete(key).catch(() => {})));
        }
    } catch (_) {}
}

// A worker of Build 129 or later is installed next to the one serving and waits until a page asks
// it to take over, so an open tab never loads files of two builds. Asked, it takes over every tab of
// the app at once, which then offer to reload; this one reloads as soon as it has.
async function activateWaitingWorker(timeoutMs = ACTIVATION_TIMEOUT_MS) {
    const registration = await registrationOf(ASK_TIMEOUT_MS);
    const waiting = registration && registration.waiting;
    if (!waiting || typeof waiting.postMessage !== 'function') return false;
    const sw = container();
    let onControllerChange = null;
    let onStateChange = null;
    const tookOver = new Promise(resolve => {
        onControllerChange = () => resolve(true);
        onStateChange = () => { if (waiting.state === 'activated') resolve(true); };
        try { sw.addEventListener('controllerchange', onControllerChange); } catch (_) {}
        try { waiting.addEventListener('statechange', onStateChange); } catch (_) {}
    });
    try {
        waiting.postMessage({ type: 'activate-now' });
        return await withinTime(tookOver, timeoutMs, false);
    } catch (_) {
        return false;
    } finally {
        try { sw.removeEventListener('controllerchange', onControllerChange); } catch (_) {}
        try { waiting.removeEventListener('statechange', onStateChange); } catch (_) {}
    }
}

export async function appUpdate() {
    const action = updateAction(_state);
    if (action === 'installing') return 'installing';
    if (action === 'force' || action === 'reload') {
        if (updateBlocked(_state, { recording: !!_isBusy() })) {
            const message = describeBlockedUpdate(_state);
            try { alert(message); } catch (_) { console.warn(message); }
            return 'blocked';
        }
        if (action === 'force') {
            await clearInstalledShell();
            _reload();
            return 'force';
        }
        if (_state.waiting) await activateWaitingWorker();
        _reload();
        return 'reload';
    }
    await _check();
    const settled = updateAction(_state);
    if (settled === 'reload' || settled === 'force') return 'ready';
    if (settled === 'installing') return 'installing';
    if (_state.installFailed) return 'failed';
    return 'current';
}

export function checkForUpdate() {
    return _check();
}

export function exposeUpdateGlobals() {
    if (typeof window === 'undefined') return;
    window.appUpdate = appUpdate;
}

export { NO_WORKER_LABEL };
