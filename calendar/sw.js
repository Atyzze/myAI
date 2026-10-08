const VERSION     = 'v1';
const SHELL_CACHE = `myai-calendar-shell-${VERSION}`;

// The app's own files, kept so it opens without a connection. The calendar itself is never cached
// here: the requests to the box (/dav/) always go to the network, and the app keeps its copy of the
// calendar in IndexedDB.
const SHELL = [
    './index.html',
    './manifest.webmanifest',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './src/js/app.js',
    './src/js/caldav.js',
    './src/js/dom.js',
    './src/js/event-index.js',
    './src/js/event-model.js',
    './src/js/format.js',
    './src/js/icalendar.js',
    './src/js/links-core.js',
    './src/js/occurrences.js',
    './src/js/prefs-core.js',
    './src/js/reminders-core.js',
    './src/js/reminders.js',
    './src/js/rrule.js',
    './src/js/store.js',
    './src/js/sync.js',
    './src/js/transfer.js',
    './src/js/tz.js',
    './src/js/ui-details.js',
    './src/js/ui-editor.js',
    './src/js/ui-settings.js',
    './src/js/ui-views.js',
    './src/js/update.js',
    './src/js/views-core.js',
    './src/js/wall.js',
    './src/js/xml.js'
];

const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

// The app is one page, at the folder it was put in. Every other address on the site (the box's
// other apps, the calendar server under /dav/) is left alone.
const APP_PAGES = new Set(['./', './index.html'].map(path => new URL(path, self.registration.scope).pathname));

// Each file is read whole before it is stored, and every file is fetched before any is stored, so a
// shell is either complete or not installed at all.
async function storable(response) {
    return new Response(await response.blob(), {
        status: response.status, statusText: response.statusText, headers: response.headers
    });
}

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

// A new build installs in the background and waits: an open tab keeps the build it started with.
// It takes over when the person taps the version (the page then asks, 'activate-now'), or by itself
// once every tab of the app has been closed.
self.addEventListener('install', event => {
    event.waitUntil(installShell());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(key => key.startsWith('myai-calendar-shell-') && key !== SHELL_CACHE)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

async function fromShell(request) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(request);
}

async function appPage(request) {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(new URL('./index.html', self.registration.scope).href);
    if (shell) return shell;
    try {
        const response = await fetch(request);
        if (response) return response;
    } catch (_) {}
    return new Response('The calendar is offline and has not been stored on this device yet. Open it once with a connection.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') {
        if (APP_PAGES.has(url.pathname)) event.respondWith(appPage(request));
        return;
    }
    if (SHELL_URLS.has(url.origin + url.pathname)) event.respondWith(fromShell(request));
});

function reply(event, message) {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage(message);
    else if (event.source) event.source.postMessage(message);
}

self.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'activate-now') {
        event.waitUntil(self.skipWaiting());
        return;
    }
    if (data.type === 'version') reply(event, { type: 'version', version: VERSION });
});

// A reminder's notification, tapped: the app comes to the front (or opens) on that event.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const data = event.notification.data || {};
    event.waitUntil((async () => {
        const scope = self.registration.scope;
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find(client => client.url.startsWith(scope));
        if (open) {
            try { await open.focus(); } catch (_) {}
            open.postMessage({ type: 'open-event', key: data.key, startUtc: data.startUtc });
            return;
        }
        const url = new URL('./', scope);
        if (data.key) {
            url.searchParams.set('open', data.key);
            if (data.startUtc) url.searchParams.set('at', String(data.startUtc));
        }
        await self.clients.openWindow(url.href);
    })());
});
