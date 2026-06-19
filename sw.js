/* ==========================================================================
   sw.js — Service worker for offline support.

   • App shell (same-origin, all first-party JS): cache-first, so the UI loads
     with no network.
   • Cross-origin (transformers.js from jsDelivr + the Whisper/distilbart model
     weights from the HF CDN): stale-while-revalidate, so they work offline after
     first use. This is the only third-party code the app loads, and only when
     on-device transcription/reply is used.
   • Non-GET requests are NOT intercepted — POSTs to /transcribe and /ollama
     pass straight through to the network.

   Cache versioning: bump VERSION whenever the shell assets change so clients
   pick them up instead of mixing old and new modules. The model lives in
   RUNTIME_CACHE, which is intentionally NOT versioned here — re-downloading a
   multi-hundred-MB model on every app update would be hostile. Old shell caches
   are pruned on activate.
   ========================================================================== */

const VERSION       = 'v4';                      // ← bump on any shell asset change
const SHELL_CACHE   = `myai-shell-${VERSION}`;
const RUNTIME_CACHE = 'myai-runtime-v1';         // keep stable: holds large model weights

const SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './snek.jpg',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './js/main.js',
    './js/config.js',
    './js/db.js',
    './js/audio.js',
    './js/ai-worker.js',
    './js/dedup.js',
    './js/jobs.js',
    './js/recorder.js',
    './js/transcribe.js',
    './js/transcribe-core.js',     // pure transcript-assembly core (unit-tested)
    './js/reply.js',
    './js/auto-pipeline.js',
    './js/live-tabs.js',
    './js/settings.js',
    './js/gui.js',
    './js/idb-min.js',             // hand-written IndexedDB wrapper (replaces idb)
    './js/wake-lock.js'            // native screen wake lock (replaces NoSleep)
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            // Tolerate individual 404s so install never hard-fails the whole shell.
            .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                // Drops stale shells (e.g. myai-shell-v1) but keeps the current
                // shell and the runtime/model cache.
                keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Never touch POST/PUT/etc. — lets /transcribe and /ollama reach the network.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        // App shell: cache-first, fall back to network (and backfill the cache).
        event.respondWith(
            caches.match(req).then(cached => cached || fetch(req).then(res => {
                const copy = res.clone();
                caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => cached))
        );
    } else {
        // Cross-origin lib + model: stale-while-revalidate.
        event.respondWith(
            caches.open(RUNTIME_CACHE).then(async (cache) => {
                const cached  = await cache.match(req);
                const network = fetch(req).then(res => {
                    if (res && (res.ok || res.type === 'opaque')) {
                        cache.put(req, res.clone()).catch(() => {});
                    }
                    return res;
                }).catch(() => cached);
                return cached || network;
            })
        );
    }
});
