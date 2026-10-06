import { emitTestResult } from '../helpers/test-result.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

const listeners = new Map();
const opened = [];
const deleted = [];
const added = [];
const addedModes = [];
const puts = [];
const messages = [];
let claimed = false;
let skipped = false;
let missingShellFile = null;
let redirectedShellFile = null;
let shellKeys = ['myai-shell-v14', 'myai-shell-v15', 'myai-shell-v99999', 'myai-runtime-v1', 'transformers-cache'];

const installedShell = new Map();
const fetched = [];

const cache = {
    async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        if (installedShell.has(url)) return installedShell.get(url);
        return url.includes('cached') ? { ok: true, clone() { return this; } } : undefined;
    },
    async put(request, response) {
        const url = new URL(request.url || request, 'https://app.test/').href;
        puts.push([url, response]);
        if (response && response.fromInstall) installedShell.set(url, { ...response, fromCache: true, url });
    }
};

class FakeRequest {
    constructor(url, init = {}) {
        this.url = String(url);
        this.cache = init.cache || 'default';
        this.mode = init.mode || 'no-cors';
        this.method = init.method || 'GET';
    }
}

class FakeResponse {
    constructor(body, init = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.statusText = init.statusText ?? '';
        this.headers = init.headers;
        this.ok = this.status >= 200 && this.status < 300;
        this.redirected = false;
        this.fromInstall = true;
        this.rebuilt = true;
    }
    clone() { return this; }
}

const context = vm.createContext({
    URL,
    Set,
    Promise,
    console,
    Request: FakeRequest,
    Response: FakeResponse,
    fetch: async request => {
        const url = request.url || request;
        fetched.push(url);
        const installing = url.startsWith('./');
        if (installing) {
            added.push(url);
            addedModes.push(request.cache);
        }
        if (missingShellFile && url === missingShellFile) return { ok: false, status: 404, clone() { return this; } };
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/plain' },
            type: 'basic',
            fromNetwork: true,
            fromInstall: installing,
            redirected: url === redirectedShellFile,
            url,
            async blob() { return `body of ${url}`; },
            clone() { return this; }
        };
    },
    caches: {
        async open(name) { opened.push(name); return cache; },
        async keys() { return shellKeys; },
        async delete(name) { deleted.push(name); return true; }
    },
    self: {
        registration: { scope: 'https://app.test/' },
        location: { origin: 'https://app.test' },
        clients: {
            async claim() { claimed = true; },
            async matchAll() { return [{ postMessage(message) { messages.push(message); } }]; }
        },
        async skipWaiting() { skipped = true; },
        addEventListener(type, handler) { listeners.set(type, handler); }
    }
});
vm.runInContext(fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8'), context, { filename: 'sw.js' });

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

function eq(actual, expected, message) {
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function lifecycleEvent() {
    let promise = null;
    return {
        event: { waitUntil(value) { promise = Promise.resolve(value); } },
        async done() { if (promise) await promise; }
    };
}

async function install() {
    const { event, done } = lifecycleEvent();
    listeners.get('install')(event);
    await done();
}

{
    missingShellFile = './src/js/naming.js';
    let rejected = false;
    try { await install(); } catch (_) { rejected = true; }
    ok(rejected && !skipped, 'incomplete shell install rejects and does not activate');
    ok(puts.length === 0, 'and stores none of the files it did fetch, so no half shell is left behind');
    missingShellFile = null;
}

{
    shellKeys = ['myai-shell-v99990', 'myai-runtime-v1'];
    await install();
    ok(!skipped, 'a new worker replacing one of Build 129 or later waits to be asked, so open tabs keep the files of their own build');
    ok(added.includes('./index.html') && added.includes('./src/js/recording-lock.js'), 'critical shell is cached as a complete list');
    ok(addedModes.length === added.length && addedModes.every(mode => mode === 'reload'),
       'every shell resource is installed with cache: reload');
    ok(!added.includes('./src/js/live-view.js'), 'the pop-ups load no script, so the shell carries none for them');
    ok(installedShell.size === new Set(added).size && [...installedShell.values()].every(response => response.rebuilt),
       'every shell file is stored with its body read at once, so no connection stays held while the rest are fetched');

    let asked = null;
    listeners.get('message')({ data: { type: 'activate-now' }, waitUntil(value) { asked = Promise.resolve(value); } });
    await asked;
    ok(skipped, 'asked by a page, it takes over');
    skipped = false;
}

{
    shellKeys = ['myai-shell-v100', 'myai-runtime-v1'];
    await install();
    ok(skipped, 'a new worker replacing one of Build 128 or earlier takes over by itself, as the pages of those builds expect');
    shellKeys = ['myai-shell-v14', 'myai-shell-v15', 'myai-shell-v99999', 'myai-runtime-v1', 'transformers-cache'];
}

{
    redirectedShellFile = './index.html';
    installedShell.clear();
    await install();
    const shell = installedShell.get('https://app.test/index.html');
    ok(shell && shell.rebuilt && !shell.redirected && shell.body === 'body of ./index.html' && shell.status === 200,
       'a shell file the server redirected is stored as a response of its own, with its body and status');
    const served = await dispatchFetchLater({ url: 'https://app.test/', mode: 'navigate' });
    ok(served && !served.redirected,
       'so a navigation is never answered with a redirected response, which the browser would refuse');
    redirectedShellFile = null;
}

{
    const { event, done } = lifecycleEvent();
    listeners.get('activate')(event);
    await done();
    ok(claimed, 'activation claims clients');
    ok(deleted.includes('myai-shell-v14'), 'old shell cache is removed');
    ok(!deleted.includes('myai-shell-v99999'),
       'the shell of a newer build that is installing meanwhile is left alone, so it does not take over with none');
    ok(!deleted.includes('transformers-cache'),
       'a cache this application does not own is left alone rather than swept on its behalf');
}

function dispatchFetchLater(request) {
    return dispatchFetch(request).responsePromise;
}

function dispatchFetch({ url, method = 'GET', mode = 'cors' }) {
    let responsePromise = null;
    const background = [];
    const event = {
        request: { url, method, mode },
        respondWith(value) { responsePromise = Promise.resolve(value); },
        waitUntil(value) { background.push(Promise.resolve(value)); }
    };
    listeners.get('fetch')(event);
    return { responsePromise, background };
}

ok(dispatchFetch({ url: 'https://app.test/ollama/api/tags' }).responsePromise === null,
   'Ollama GET route is not intercepted or cached');
ok(dispatchFetch({ url: 'https://app.test/transcribe/status' }).responsePromise === null,
   'transcription GET route is not intercepted or cached');

ok(dispatchFetch({ url: 'https://app.test/transcribe' }).responsePromise === null,
   'the exact transcription route is not intercepted or cached');
ok(dispatchFetch({ url: 'https://app.test/transcribe', mode: 'navigate' }).responsePromise === null,
   'a navigation to the exact transcription route is left to the network');
ok(dispatchFetch({ url: 'https://app.test/ollama' }).responsePromise === null,
   'the exact Ollama route is not intercepted or cached');
ok(dispatchFetch({ url: 'https://app.test/docs/PRIVACY.md', mode: 'navigate' }).responsePromise === null,
   'a navigation to another page of the origin, such as a document served beside the app, is left to the network '
   + 'instead of being answered with a copy of the app that cannot find its modules there');
ok(dispatchFetch({ url: 'https://app.test/transcribe-notes.html', mode: 'navigate' }).responsePromise === null,
   'and so is a page whose name only begins like a service route');
ok(dispatchFetch({ url: 'https://app.test/index.html', mode: 'navigate' }).responsePromise !== null
   && dispatchFetch({ url: 'https://app.test/?from=homescreen', mode: 'navigate' }).responsePromise !== null,
   'the app page itself is still answered from the shell, by its own name and with a query');
ok(dispatchFetch({ url: 'https://app.test/private/report' }).responsePromise === null,
   'unknown same-origin GET route remains network-owned');
ok(dispatchFetch({ url: 'https://app.test/src/js/main.js' }).responsePromise !== null,
   'known shell module is cache-routed');
{
    const before = fetched.length;
    const navigation = dispatchFetch({ url: 'https://app.test/', mode: 'navigate' });
    ok(navigation.responsePromise !== null, 'navigation is handled by the worker');
    const response = await navigation.responsePromise;
    ok(response && response.fromCache === true,
       'a navigation is served from the installed shell');
    ok(fetched.length === before,
       'a navigation with an installed shell touches the network not at all');
}

{
    const emptied = [...installedShell];
    installedShell.clear();
    const first = await dispatchFetch({ url: 'https://app.test/', mode: 'navigate' }).responsePromise;
    ok(first && first.fromNetwork === true,
       'with no shell installed a navigation still falls back to the network');
    for (const [url, response] of emptied) installedShell.set(url, response);
}
const externalModel = dispatchFetch({ url: 'https://huggingface.co/model/file.bin' });
ok(externalModel.responsePromise === null && externalModel.background.length === 0,
   'external model hosts are not intercepted or cached');
ok(dispatchFetch({ url: 'https://evil.example/script.js' }).responsePromise === null,
   'other cross-origin requests are not intercepted');
ok(dispatchFetch({ url: 'https://app.test/src/js/main.js', method: 'POST' }).responsePromise === null,
   'non-GET requests are not intercepted');


// Build 138: a new build is used only once the person accepts it by tapping the version. Each case
// runs a fresh worker of a given build over caches that keep what is put in them.
function namedCaches(initial = {}) {
    const stores = new Map();
    class Stored {
        constructor(body) { this.body = String(body); this.ok = true; this.status = 200; this.redirected = false; }
        async text() { return this.body; }
        clone() { return this; }
    }
    const store = name => {
        if (!stores.has(name)) {
            const entries = new Map();
            stores.set(name, {
                entries,
                async match(request) { return entries.get(new URL(request.url || request, 'https://app.test/').href); },
                async put(request, response) {
                    const body = response && typeof response.text === 'function' ? await response.text()
                        : response && response.body !== undefined ? response.body : String(response);
                    entries.set(new URL(request.url || request, 'https://app.test/').href, new Stored(body));
                },
                async keys() { return [...entries.keys()].map(url => ({ url })); }
            });
        }
        return stores.get(name);
    };
    for (const [name, files] of Object.entries(initial)) {
        const cache = store(name);
        for (const [path, body] of Object.entries(files)) cache.entries.set(new URL(path, 'https://app.test/').href, new Stored(body));
    }
    return {
        stores,
        api: {
            async open(name) { return store(name); },
            async keys() { return [...stores.keys()]; },
            async delete(name) { return stores.delete(name); }
        },
        Stored
    };
}

function workerOfBuild(build, initialCaches) {
    const box = namedCaches(initialCaches);
    const handlers = new Map();
    const state = { skipped: false, claimed: false, fetched: [] };
    class ResponseOfText {
        constructor(body) { this.body = String(body); this.ok = true; this.status = 200; }
        async text() { return this.body; }
        clone() { return this; }
    }
    const ctx = vm.createContext({
        URL, Set, Map, Promise, console,
        Request: FakeRequest,
        Response: ResponseOfText,
        fetch: async request => { const url = request.url || request; state.fetched.push(url); return { ok: true, status: 200, fromNetwork: true, url, async text() { return 'network'; }, clone() { return this; } }; },
        caches: box.api,
        self: {
            registration: { scope: 'https://app.test/' },
            location: { origin: 'https://app.test' },
            clients: { async claim() { state.claimed = true; } },
            async skipWaiting() { state.skipped = true; },
            addEventListener(type, handler) { handlers.set(type, handler); }
        }
    });
    const source = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8')
        .replace(/const VERSION\s*=\s*'v\d+';/, `const VERSION = '${build}';`);
    vm.runInContext(source, ctx, { filename: 'sw.js' });
    const lifecycle = async (type, extra = {}) => {
        let promise = null;
        handlers.get(type)({ ...extra, waitUntil(value) { promise = Promise.resolve(value); } });
        if (promise) await promise;
    };
    const ask = async data => {
        let answer = null;
        await lifecycle('message', { data, ports: [{ postMessage(message) { answer = message; } }] });
        return answer;
    };
    const fetchOf = (url, mode = 'cors') => {
        let responsePromise = null;
        handlers.get('fetch')({ request: { url, method: 'GET', mode }, respondWith(value) { responsePromise = Promise.resolve(value); },
                                waitUntil() {} });
        return responsePromise;
    };
    const body = async promise => { const response = await promise; return response && typeof response.text === 'function' ? response.text() : null; };
    return { box, state, lifecycle, ask, fetchOf, body };
}

const shellOf = (build, extra = {}) => ({ 'index.html': `index of ${build}`, 'src/js/main.js': `main of ${build}`, ...extra });
const acceptedRecord = build => ({ '__accepted-build': build });

{
    const first = workerOfBuild('v201', { 'myai-shell-v201': shellOf('v201') });
    await first.lifecycle('activate');
    eq(await first.body(first.box.api.open('myai-accepted').then(c => c.match('https://app.test/__accepted-build'))), 'v201',
       'accept: a first install accepts its own build');
    eq(await first.body(first.fetchOf('https://app.test/', 'navigate')), 'index of v201', 'accept: and serves it');
}

{
    const later = workerOfBuild('v202', {
        'myai-accepted': acceptedRecord('v201'),
        'myai-shell-v201': shellOf('v201', { 'src/js/only-in-201.js': 'gone in 202' }),
        'myai-shell-v202': shellOf('v202')
    });
    await later.lifecycle('activate');
    eq(await later.body(later.fetchOf('https://app.test/', 'navigate')), 'index of v201',
       'accept: a newer build that took over because every tab was closed still serves the build last accepted');
    eq(await later.body(later.fetchOf('https://app.test/src/js/main.js')), 'main of v201',
       'accept: page and modules alike');
    eq(await later.body(later.fetchOf('https://app.test/src/js/only-in-201.js')), 'gone in 202',
       'accept: also a file the newer build no longer has, which the network would not have either');
    ok(later.box.stores.has('myai-shell-v201'), 'accept: the accepted shell is kept when the newer build takes over');
    const asked = await later.ask({ type: 'version' });
    eq([asked.version, asked.accepted], ['v202', 'v201'], 'accept: asked, it names its own build and the accepted one, so the page can offer it');
    ok(!later.state.skipped, 'accept: nothing about taking over asked it to skip waiting');

    const reply = await later.ask({ type: 'accept' });
    eq(reply && [reply.type, reply.version], ['accepted', 'v202'], 'accept: a tap on an older page accepts the serving build');
    eq(await later.body(later.fetchOf('https://app.test/', 'navigate')), 'index of v202', 'accept: and the reload lands on it');
    eq(await later.body(later.fetchOf('https://app.test/src/js/main.js')), 'main of v202', 'accept: modules too');
}

{
    const waiting = workerOfBuild('v203', {
        'myai-accepted': acceptedRecord('v202'),
        'myai-shell-v202': shellOf('v202'),
        'myai-shell-v203': shellOf('v203')
    });
    await waiting.lifecycle('message', { data: { type: 'activate-now' } });
    ok(waiting.state.skipped, 'accept: a waiting build asked by a tap takes over');
    await waiting.lifecycle('activate');
    eq(await waiting.body(waiting.fetchOf('https://app.test/', 'navigate')), 'index of v203',
       'accept: and, being accepted by that tap, serves its own build');
    ok(!waiting.box.stores.has('myai-shell-v202'), 'accept: the shell no longer accepted goes once the accepted build takes over');
}

{
    const legacy = workerOfBuild('v204', { 'myai-shell-v137': shellOf('v137'), 'myai-shell-v204': shellOf('v204') });
    await legacy.lifecycle('activate');
    eq(await legacy.body(legacy.fetchOf('https://app.test/', 'navigate')), 'index of v204',
       'accept: replacing a build from before acceptance, whose pages cannot accept, a build that takes over is used, as before');
    ok(!legacy.box.stores.has('myai-shell-v137'), 'accept: and the old shell goes');
}

{
    const lost = workerOfBuild('v205', { 'myai-accepted': acceptedRecord('v201'), 'myai-shell-v205': shellOf('v205') });
    await lost.lifecycle('activate');
    eq(await lost.body(lost.fetchOf('https://app.test/', 'navigate')), 'index of v205',
       'accept: when the accepted shell is gone, the build that serves becomes the accepted one instead of serving nothing');
}

console.log(`✓ all ${assertions} service-worker assertions passed`);
emitTestResult('service-worker', 'pass', { assertions });
