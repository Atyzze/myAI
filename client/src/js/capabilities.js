// Fetches the box's /capabilities once per page and keeps it for the modules that size their
// work to the box. Nothing else fetches it, and nothing waits for it: until it answers, and on
// servers that have no such route, every limit is the app's own (capabilities-core.js).

import { CONFIG } from './config.js';
import { NO_LIMITS, normalizeCapabilities } from './capabilities-core.js';

const LOOKUP_TIMEOUT_MS = 5000;

let current = NO_LIMITS;
let pending = null;

export function boxCapabilities() {
    return current;
}

export function loadBoxCapabilities() {
    if (pending) return pending;
    pending = (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
        try {
            const res = await fetch(CONFIG.CAPABILITIES_URL, { cache: 'no-store', signal: ctrl.signal });
            if (!res.ok) return current;
            current = normalizeCapabilities(await res.json());
            for (const warning of current.warnings) console.warn(`myAI box: ${warning}`);
        } catch (_) {
            // No box, or it did not answer in time: keep the app's own limits.
        } finally {
            clearTimeout(timer);
        }
        return current;
    })();
    return pending;
}
