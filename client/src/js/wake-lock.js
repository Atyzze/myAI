let _sentinel = null;
let _wantLock = false;
let _wired    = false;
let _pending  = null;

async function requestSentinel() {
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!_wantLock) {
            try { await sentinel.release(); } catch (_) {}
            return false;
        }
        if (_sentinel) {
            try { await sentinel.release(); } catch (_) {}
            return true;
        }
        _sentinel = sentinel;
        sentinel.addEventListener('release', () => {
            if (_sentinel === sentinel) _sentinel = null;
        });
        return true;
    } catch (_) {
        return false;
    }
}

async function acquire() {
    if (!('wakeLock' in navigator)) return false;
    if (_sentinel) return true;
    if (_pending) return _pending;
    _pending = requestSentinel().finally(() => { _pending = null; });
    return _pending;
}

function ensureWired() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && _wantLock && !_sentinel) {
            acquire();
        }
    });
}

export async function enableWakeLock() {
    _wantLock = true;
    ensureWired();
    return acquire();
}

export async function disableWakeLock() {
    _wantLock = false;
    if (_sentinel) {
        const sentinel = _sentinel;
        _sentinel = null;
        try { await sentinel.release(); } catch (_) {}
    }
}
