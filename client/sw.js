const VERSION     = 'v135';
const SHELL_CACHE = `myai-shell-${VERSION}`;
// From this build on, a new worker waits until a page asks it to take over (version.js). The pages
// of earlier builds cannot ask, and expect it to take over by itself.
const FIRST_BUILD_THAT_WAITS = 129;

const SHELL = [
    './index.html',
    './manifest.webmanifest',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './src/js/main.js',
    './src/js/config.js',
    './src/js/version.js',
    './src/js/update-core.js',
    './src/js/db.js',
    './src/js/db-lifecycle-core.js',
    './src/js/audio.js',
    './src/js/audio-format.js',
    './src/js/resample-core.js',
    './src/js/resample-worker.js',
    './src/js/capture-health-core.js',
    './src/js/finalize-core.js',
    './src/js/webm-duration.js',
    './src/js/waveform-core.js',
    './src/js/player-core.js',
    './src/js/render-defer.js',
    './src/js/selection-core.js',
    './src/js/row-state-core.js',
    './src/js/pagination-core.js',
    './src/js/dedup.js',
    './src/js/clipboard-core.js',
    './src/js/jobs.js',
    './src/js/recording-lock.js',
    './src/js/recorder.js',
    './src/js/transcribe.js',
    './src/js/transcribe-core.js',
    './src/js/retention-core.js',
    './src/js/deletion-core.js',
    './src/js/live-scribe.js',
    './src/js/live-scribe-core.js',
    './src/js/live-refine-core.js',
    './src/js/backup-core.js',
    './src/js/diarize-core.js',
    './src/js/runway-core.js',
    './src/js/speaker-infer-core.js',
    './src/js/translate-core.js',
    './src/js/capabilities.js',
    './src/js/capabilities-core.js',
    './src/js/speaker-confirm-core.js',
    './src/js/reply.js',
    './src/js/reply-core.js',
    './src/js/model-ready-core.js',
    './src/js/auto-pipeline.js',
    './src/js/live-tabs.js',
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

// The app is one page. A navigation anywhere else on the origin (a document, another service under
// the same host) is left to the network: answering it with this page would only show a copy of the
// app that cannot find its modules, since they are looked up next to the address it was opened at.
const APP_PAGES = new Set(['./', './index.html'].map(path => new URL(path, self.registration.scope).pathname));
const isAppPage = url => APP_PAGES.has(url.pathname);

const API_ROUTES = ['/ollama', '/transcribe', '/capabilities'];
const isApiRoute = pathname =>
    API_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));

// Each shell file is kept as a response of its own, with its body read at once. A response left
// unread holds its connection to the server, and with every file fetched before any is stored the
// browser would run out of connections and the install would never finish. And a response that
// followed a redirect cannot answer a navigation: where the server sends index.html on to ./ , the
// browser would refuse it and the app would not load.
async function storable(response) {
    return new Response(await response.blob(), {
        status: response.status, statusText: response.statusText, headers: response.headers
    });
}

// Every file is fetched before any is stored, so a shell is either complete or not installed.
async function installShell() {
    const responses = await Promise.all(SHELL.map(async path => {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (!response || !response.ok) {
            throw new TypeError(`The shell file ${path} could not be fetched (${response ? response.status : 'no response'}).`);
        }
        return storable(response);
    }));
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((path, i) => cache.put(new Request(path), responses[i])));
}

// The build a shell cache belongs to, or null for a cache of another name.
function shellBuild(key) {
    const match = /^myai-shell-v(\d+)$/.exec(String(key));
    return match ? Number(match[1]) : null;
}

async function replacesWorkerThatDoesNotAsk() {
    const keys = await caches.keys();
    return keys.some(key => key !== SHELL_CACHE && shellBuild(key) !== null && shellBuild(key) < FIRST_BUILD_THAT_WAITS);
}

// A new worker no longer takes over by itself: an open tab keeps the files of the build it started
// with until the person reloads it, and a pop-up it opens cannot get a module of another build.
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        await installShell();
        if (await replacesWorkerThatDoesNotAsk()) await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Only the shells of older builds go: a newer build may be installing its own right now,
        // and would otherwise take over later with no shell at all.
        const keys = await caches.keys();
        const current = shellBuild(SHELL_CACHE);
        const staleKeys = keys.filter(key => key.startsWith('myai-shell-') && key !== SHELL_CACHE
            && !(shellBuild(key) !== null && current !== null && shellBuild(key) > current));
        await Promise.all(staleKeys.map(key => caches.delete(key)));
        await self.clients.claim();
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
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(new URL('./index.html', self.registration.scope).href);
    if (shell) return shell;

    try {
        const response = await fetch(request);
        if (response && response.ok) return response;
    } catch (_) {}
    return new Response(
        'myAI is offline and no cached application shell is available yet. Reconnect once to install it.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('message', event => {
    const data = event.data;
    if (data && data.type === 'activate-now') {
        event.waitUntil(self.skipWaiting());
        return;
    }
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
        if (isAppPage(url)) event.respondWith(navigationResponse(request));
        return;
    }
    if (SHELL_URLS.has(url.href)) event.respondWith(cacheFirstShell(request));
});
