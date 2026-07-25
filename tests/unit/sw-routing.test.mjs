import { emitTestResult } from '../helpers/test-result.mjs';
/* Service-worker routing/lifecycle tests with a minimal zero-dependency VM mock. */
import fs from 'node:fs';
import vm from 'node:vm';

const listeners = new Map();
const opened = [];
const deleted = [];
const added = [];
const puts = [];
const messages = [];
let claimed = false;
let skipped = false;
let failAddAll = false;

const cache = {
    async addAll(paths) {
        if (failAddAll) throw new Error('simulated missing shell file');
        added.push(...paths);
    },
    async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        return url.includes('cached') ? { ok: true, clone() { return this; } } : undefined;
    },
    async put(request, response) { puts.push([request.url || request, response]); }
};

const context = vm.createContext({
    URL,
    Set,
    Promise,
    console,
    fetch: async request => ({
        ok: true,
        type: 'basic',
        url: request.url || request,
        clone() { return this; }
    }),
    caches: {
        async open(name) { opened.push(name); return cache; },
        async keys() { return ['myai-shell-v14', 'myai-shell-v15', 'myai-runtime-v1', 'transformers-cache']; },
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

{
    failAddAll = true;
    const { event, done } = lifecycleEvent();
    listeners.get('install')(event);
    let rejected = false;
    try { await done(); } catch (_) { rejected = true; }
    ok(rejected && !skipped, 'incomplete shell install rejects and does not activate');
    failAddAll = false;
}

{
    const { event, done } = lifecycleEvent();
    listeners.get('install')(event);
    await done();
    ok(skipped, 'successful complete shell install calls skipWaiting');
    ok(added.includes('./index.html') && added.includes('./src/js/recording-lock.js'), 'critical shell is cached as a complete list');
}

{
    const { event, done } = lifecycleEvent();
    listeners.get('activate')(event);
    await done();
    ok(claimed, 'activation claims clients');
    ok(deleted.includes('myai-shell-v14'), 'old shell cache is removed');
    ok(deleted.includes('myai-runtime-v1'), 'legacy myAI runtime/model cache is removed');
    ok(deleted.includes('transformers-cache'), 'legacy Transformers cache is removed');
    ok(messages.some(message => message.type === 'legacy-model-cache-cleared'), 'controlled pages are told to refresh storage totals');
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

// The routes as ACTUALLY configured carry no trailing slash. The old guard only
// tested for '/transcribe/', so '/transcribe' itself did not match its own
// exclusion; only the shell allowlist kept it from being cached.
ok(dispatchFetch({ url: 'https://app.test/transcribe' }).responsePromise === null,
   'the exact transcription route is not intercepted or cached');
ok(dispatchFetch({ url: 'https://app.test/ollama' }).responsePromise === null,
   'the exact Ollama route is not intercepted or cached');
// A path that merely starts with the same characters is NOT an API route.
ok(dispatchFetch({ url: 'https://app.test/transcribe-notes.html', mode: 'navigate' }).responsePromise !== null,
   'a lookalike path is still served by the navigation handler');
ok(dispatchFetch({ url: 'https://app.test/private/report' }).responsePromise === null,
   'unknown same-origin GET route remains network-owned');
ok(dispatchFetch({ url: 'https://app.test/src/js/main.js' }).responsePromise !== null,
   'known shell module is cache-routed');
ok(dispatchFetch({ url: 'https://app.test/', mode: 'navigate' }).responsePromise !== null,
   'navigation receives network-first/offline-shell handling');
const externalModel = dispatchFetch({ url: 'https://huggingface.co/model/file.bin' });
ok(externalModel.responsePromise === null && externalModel.background.length === 0,
   'external model hosts are not intercepted or cached');
ok(dispatchFetch({ url: 'https://evil.example/script.js' }).responsePromise === null,
   'other cross-origin requests are not intercepted');
ok(dispatchFetch({ url: 'https://app.test/src/js/main.js', method: 'POST' }).responsePromise === null,
   'non-GET requests are not intercepted');

console.log(`✓ all ${assertions} service-worker assertions passed`);
emitTestResult('service-worker', 'pass', { assertions });
