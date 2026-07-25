/* ==========================================================================
   wake-lock.js - Keep the screen awake during recording using the native
   Screen Wake Lock API. Replaces the vendored NoSleep.js (which kept the
   screen on by silently looping an invisible <video> - a hack from before
   Wake Lock existed). No external code, no media element.

   Behaviour notes:
   • The OS automatically RELEASES a screen wake lock when the tab/document
     becomes hidden (backgrounded, screen locked, tab switched). We listen for
     visibilitychange and re-acquire when we come back to the foreground, as
     long as a lock is still wanted - this is the documented, required pattern.
   • request('screen') needs a secure context (https/localhost) and is best
     called from a user gesture; startRecording() (a click handler) satisfies
     both. On unsupported browsers acquire() resolves false and recording
     simply proceeds without keeping the screen awake (same graceful
     degradation NoSleep had when it failed).
   ========================================================================== */

let _sentinel = null;     // active WakeLockSentinel, or null
let _wantLock = false;    // whether a lock is currently desired
let _wired    = false;    // visibilitychange listener attached once

async function acquire() {
    if (!('wakeLock' in navigator)) return false;
    if (_sentinel) return true;
    try {
        _sentinel = await navigator.wakeLock.request('screen');
        // Sentinel auto-releases on tab hide; clear our handle so the
        // visibility handler knows to re-acquire.
        _sentinel.addEventListener('release', () => { _sentinel = null; });
        return true;
    } catch (_) {
        _sentinel = null;
        return false;
    }
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

/** Request and hold a screen wake lock until disableWakeLock() is called. */
export async function enableWakeLock() {
    _wantLock = true;
    ensureWired();
    return acquire();
}

/** Release the wake lock and stop wanting one. */
export async function disableWakeLock() {
    _wantLock = false;
    if (_sentinel) {
        try { await _sentinel.release(); } catch (_) {}
        _sentinel = null;
    }
}
