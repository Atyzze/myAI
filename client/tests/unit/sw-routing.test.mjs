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

console.log(`✓ all ${assertions} service-worker assertions passed`);
emitTestResult('service-worker', 'pass', { assertions });
