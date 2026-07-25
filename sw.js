/* ==========================================================================
   sw.js - Atomic offline application shell for the server-only client.

   API routes and unknown same-origin GETs remain network-owned. Activation also
   removes legacy model caches left by earlier on-device-AI releases.

   THE VERSION BELOW IS THE ONLY PLACE THE APPLICATION VERSION IS WRITTEN.
   It lives here for two reasons that no other file can satisfy:

     1. This script's bytes are what the browser compares on every update check.
        A version declared elsewhere can change without this file changing, and
        then nothing updates at all - the shell below is served cache-first, so
        the browser would keep handing out the previous build forever.
     2. It names the cache that actually serves the GUI, so it is the only value
        that can honestly answer "which build am I looking at?". The label in the
        corner of the app asks this worker for it (see src/js/version.js) rather
        than carrying a copy that a stale cache would happily keep showing.

   Bump it here, then run `npm run version:sync` to carry the number into
   package.json. Nothing else needs editing, and the release gate fails if
   anything else declares a version of its own.
   ========================================================================== */

const VERSION     = 'v36';
const SHELL_CACHE = `myai-shell-${VERSION}`;

const SHELL = [
    './index.html',
    './manifest.webmanifest',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './src/js/main.js',
    './src/js/config.js',
    './src/js/version.js',
    './src/js/db.js',
    './src/js/audio.js',
    './src/js/audio-format.js',
    './src/js/webm-duration.js',
    './src/js/player-core.js',
    './src/js/dedup.js',
    './src/js/jobs.js',
    './src/js/recording-lock.js',
    './src/js/recorder.js',
    './src/js/transcribe.js',
    './src/js/transcribe-core.js',
    './src/js/reply.js',
    './src/js/reply-core.js',
    './src/js/auto-pipeline.js',
    './src/js/live-tabs.js',
    './src/js/live-view.js',
    './src/js/live-render.js',
    './src/js/live-inline.js',
    './src/js/settings.js',
    './src/js/gui.js',
    './src/js/naming.js',
    './src/js/help.js',
    './src/js/idb-min.js',
    './src/js/wake-lock.js'
];

const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

/* Same-origin routes that are proxied to the self-hosted services and must never
   be intercepted or cached. These mirror CONFIG.OLLAMA_URL and
   CONFIG.TRANSCRIBE_URL; tests/unit/static.test.mjs asserts they stay in sync,
   because a service worker cannot import the application config.

   Matching is exact-or-prefixed. The previous check only tested for a trailing
   slash, so the transcription route as actually configured ('/transcribe') did
   not match its own guard. */
const API_ROUTES = ['/ollama', '/transcribe'];
const isApiRoute = pathname =>
    API_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));
const isLegacyModelCache = key => {
    const normalized = String(key || '').toLowerCase();
    return normalized.startsWith('myai-runtime-') || normalized.includes('transformers');
};

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        const staleKeys = keys.filter(key =>
            (key.startsWith('myai-shell-') && key !== SHELL_CACHE) || isLegacyModelCache(key)
        );
        await Promise.all(staleKeys.map(key => caches.delete(key)));
        await self.clients.claim();

        if (staleKeys.some(isLegacyModelCache) && self.clients.matchAll) {
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of clients) client.postMessage({ type: 'legacy-model-cache-cleared' });
        }
    })());
});

async function cacheFirstShell(request) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone()).catch(() => {});
    return response;
}

async function navigationResponse(request) {
    try {
        const response = await fetch(request);
        if (response && response.ok) return response;
    } catch (_) {}
    const cache = await caches.open(SHELL_CACHE);
    return cache.match(new URL('./index.html', self.registration.scope).href);
}

/* The GUI's version label. Answering from here means the number on screen is
   the version of the shell that served the page, not of the source tree someone
   believes is deployed: if this worker is stale, the label says so. */
self.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'version') return;
    const reply = { type: 'version', version: VERSION };
    const port = event.ports && event.ports[0];
    if (port) port.postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (isApiRoute(url.pathname)) return;
    if (request.mode === 'navigate') {
        event.respondWith(navigationResponse(request));
        return;
    }
    if (SHELL_URLS.has(url.href)) event.respondWith(cacheFirstShell(request));
});
