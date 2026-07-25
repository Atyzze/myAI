/* ==========================================================================
   version.js - The build label under the "?" button.

   WHY THE NUMBER IS NOT WRITTEN IN THIS FILE
   The label exists to answer one question: "is the GUI I am looking at the
   build I just shipped?" A constant compiled into the application cannot answer
   it honestly. Every module here is served cache-first by the service worker,
   so a stale shell hands you a stale constant, and the corner of the screen
   confidently shows a number for a build you are not running.

   The service worker is the only component that knows which shell is actually
   being served, and its own bytes are what the browser compares on every update
   check, so that is where the number is declared - once, in sw.js. This module
   asks the worker at runtime and paints the answer.

   That inverts the trust: when the label and the release notes disagree, the
   label is right and the cache has not rolled over yet.

   With no worker (a plain file:// open, a private window that refuses
   registration, or the first moments of a first-ever load) there is no shell to
   describe, and the label says so rather than guessing.
   ========================================================================== */

const ASK_TIMEOUT_MS = 3000;
const NO_WORKER_LABEL = 'dev';

/** Ask ONE worker for its version over a private channel. Never rejects. */
export function askWorkerVersion(worker, timeoutMs = ASK_TIMEOUT_MS) {
    return new Promise(resolve => {
        if (!worker || typeof worker.postMessage !== 'function') { resolve(null); return; }

        let channel;
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            // Close the port, or an unanswered request keeps it alive for the
            // lifetime of the document.
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

        setTimeout(() => settle(null), timeoutMs);
    });
}

/** The worker serving this page, or the one about to. */
async function servingWorker(timeoutMs) {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
    const container = navigator.serviceWorker;
    if (container.controller) return container.controller;
    try {
        // getRegistration() settles even when nothing is registered; .ready would
        // wait forever in that case, which is exactly the case we must survive.
        const registration = await Promise.race([
            Promise.resolve(container.getRegistration()).catch(() => null),
            new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
        ]);
        if (!registration) return null;
        return registration.active || registration.waiting || registration.installing || null;
    } catch (_) {
        return null;
    }
}

/** The version of the shell serving this page, or null if nothing serves it. */
export async function readShellVersion({ timeoutMs = ASK_TIMEOUT_MS } = {}) {
    const worker = await servingWorker(timeoutMs);
    return askWorkerVersion(worker, timeoutMs);
}

/**
 * Paint the label and keep it honest. A worker taking over (an update
 * activating, or the first registration claiming this page) repaints it, so the
 * number follows the shell rather than the page load that happened to precede
 * it.
 *
 * @returns {Function} refresh - re-reads and repaints on demand.
 */
export function paintAppVersion(el, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
    let lastKnown = null;
    const refresh = async () => {
        const reported = await readShellVersion({ timeoutMs });
        // A later refresh that fails must not downgrade a version we already
        // confirmed; only an unknown-from-the-start shell reads as unversioned.
        if (reported) lastKnown = reported;
        if (el) el.textContent = lastKnown || NO_WORKER_LABEL;
        return reported;
    };

    if (typeof navigator !== 'undefined' && navigator.serviceWorker
        && typeof navigator.serviceWorker.addEventListener === 'function') {
        navigator.serviceWorker.addEventListener('controllerchange', () => { refresh(); });
    }

    refresh();
    return refresh;
}
