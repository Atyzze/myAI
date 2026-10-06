// How a new build reaches open tabs, in Chromium with the real service worker. Each scenario gets
// an origin of its own (a server on its own port), so each starts with no worker and no caches.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitTestResult, strictTestsRequired } from '../helpers/test-result.mjs';
import { findChromium } from '../helpers/chromium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const chromium = findChromium();
if (!chromium) {
    const message = 'Chromium not found; shell-update suite cannot run.';
    if (strictTestsRequired()) throw new Error(message);
    console.log(`↷ ${message}`);
    emitTestResult('shell-update', 'skip', { reason: message });
    process.exit(0);
}

const TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json'],
    ['.png', 'image/png']
]);

// A server for one scenario. `build` is the build its sw.js and index.html say they are; `missing`
// is a file it answers 404 for; with `redirectIndex` it sends index.html on to ./ as some static
// hosts do.
async function startServer({ build, redirectIndex = false }) {
    const state = { build, missing: null, redirectIndex, markWorker: null };
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname.startsWith('/ollama') || pathname.startsWith('/transcribe')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
            return;
        }
        if (state.redirectIndex && pathname === '/index.html') {
            res.writeHead(301, { Location: '/', 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        const rel = pathname.replace(/^\/+/, '') || 'index.html';
        if (state.missing && rel === state.missing) { res.writeHead(404); res.end('not found'); return; }
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.setHeader('Content-Type', TYPES.get(path.extname(file)) || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        // The newest build's resampling worker marks what it returns, so a test can tell which
        // build's worker a tab is using.
        if (rel === 'src/js/resample-worker.js' && state.markWorker && state.build === state.markWorker) {
            res.end(fs.readFileSync(file, 'utf8').replace('self.postMessage({ id, output }, [output.buffer]);',
                                                          'output.fill(0.25);\n        self.postMessage({ id, output }, [output.buffer]);'));
            return;
        }
        if (rel === 'sw.js' || rel === 'index.html') {
            res.end(fs.readFileSync(file, 'utf8')
                .replace(/const VERSION\s*=\s*'v\d+';/, `const VERSION     = '${state.build}';`)
                .replace(/<meta name="myai-build" content="\d+">/,
                         `<meta name="myai-build" content="${state.build.replace(/^v/, '')}">`));
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, state, base: `http://127.0.0.1:${server.address().port}` };
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
}

class Cdp {
    constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const pending = message.id && this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        });
    }
    send(method, params = {}) {
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        this.ws.send(JSON.stringify({ id, method, params }));
        return promise;
    }
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

async function waitFor(client, expression, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        try { last = await client.evaluate(expression); if (last) return last; } catch (_) {}
        await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${expression.slice(0, 160)}; last=${JSON.stringify(last)}`);
}

const debugPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-shell-update-'));
const browser = childProcess.spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900',
    '--disable-background-networking', '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=*',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserErrors = '';
browser.stderr.on('data', chunk => { browserErrors += String(chunk); });
const clients = [];
const servers = [];

async function openPage(url) {
    let response = null;
    for (let attempt = 0; attempt < 50 && !response; attempt++) {
        try { response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }); }
        catch (_) { await sleep(100); }
    }
    const target = await response.json();
    const client = new Cdp(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.alert = () => {}; window.confirm = () => true;'
    });
    await client.send('Page.navigate', { url });
    clients.push(client);
    return client;
}

const appReady = "document.readyState === 'complete' && !!document.getElementById('recordBtn')";
const badge = "document.getElementById('app-version').textContent";
const askController = `new Promise(resolve => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) { resolve(null); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = event => resolve(event.data && event.data.version);
    worker.postMessage({ type: 'version' }, [channel.port2]);
    setTimeout(() => resolve(null), 2000);
})`;

async function controlledPage(base, pathName = '/index.html') {
    const client = await openPage(`${base}${pathName}`);
    await waitFor(client, appReady, 20000);
    try {
        await waitFor(client, '!!navigator.serviceWorker.controller', 20000);
    } catch (err) {
        const state = await client.evaluate(`navigator.serviceWorker.getRegistration().then(r => r ? ({
            installing: r.installing && r.installing.state, waiting: r.waiting && r.waiting.state,
            active: r.active && r.active.state }) : 'no registration')`).catch(e => String(e));
        throw new Error(`${err.message}; registration: ${JSON.stringify(state)}`);
    }
    return client;
}

let failure = null;
try {
    {
        const site = await startServer({ build: 'v99990' });
        servers.push(site.server);
        const first = await controlledPage(site.base);
        const second = await controlledPage(site.base);
        await waitFor(first, `${badge} === 'v99990'`, 20000);
        await second.evaluate('window.__stillThisPage = true');

        site.state.build = 'v99991';
        site.state.markWorker = 'v99991';
        const found = await first.evaluate('window.appUpdate()');
        ok(found === 'ready', `a newer build is installed and offered (${found})`);
        await waitFor(first, `${badge} === 'v99990 › v99991'`, 20000);
        const waiting = await first.evaluate(`navigator.serviceWorker.getRegistration().then(async registration => ({
            waiting: !!registration.waiting, serving: await ${askController}
        }))`);
        ok(waiting.waiting && waiting.serving === 'v99990',
           `it waits beside the build that serves, instead of taking over by itself (${JSON.stringify(waiting)})`);
        const otherTab = await second.evaluate(`(async () => ({
            serving: await ${askController},
            page: (await (await fetch('index.html')).text()).match(/myai-build" content="(\\d+)"/)[1]
        }))()`);
        ok(otherTab.serving === 'v99990' && otherTab.page === '99990',
           `another open tab is still served the files of its own build (${JSON.stringify(otherTab)})`);
        await waitFor(second, `${badge} === 'v99990 › v99991'`, 20000);
        ok(true, 'and it too offers the new build, found by the other tab');

        await first.evaluate('window.__beforeReload = true; window.appUpdate(); true');
        await waitFor(first, `typeof window.__beforeReload === 'undefined' && ${appReady}`, 25000);
        await waitFor(first, `${badge} === 'v99991'`, 20000);
        ok(true, 'tapping it asks the new build to take over and reloads into it');
        const afterwards = await second.evaluate(`(async () => ({
            same: window.__stillThisPage === true, serving: await ${askController}
        }))()`);
        ok(afterwards.same && afterwards.serving === 'v99991',
           `the other tab is not reloaded under its user; it is served by the new build from then on (${JSON.stringify(afterwards)})`);
        const oldTabResamples = await second.evaluate(`(async () => {
            const audio = await import('/src/js/audio.js');
            const input = new Float32Array(48000).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000));
            const out = await audio.resamplePcmTo16k(input, input.length, 48000);
            return { marked: out.every(value => value === 0.25), worker: audio.resampleWorkerState() };
        })()`);
        ok(!oldTabResamples.marked && oldTabResamples.worker.running,
           `and what it does with code runs the files of its own build: its resampling worker, started with the page, is not the new build's (${JSON.stringify(oldTabResamples)})`);
        const newTabResamples = await first.evaluate(`(async () => {
            const audio = await import('/src/js/audio.js');
            const out = await audio.resamplePcmTo16k(new Float32Array(4800).fill(0.1), 4800, 48000);
            return out.every(value => value === 0.25);
        })()`);
        ok(newTabResamples, 'while the tab that reloaded runs the new build\'s worker, as the test build marks it');
        await waitFor(second, `${badge} === 'v99990 › v99991'`, 20000);
        ok(true, 'and says it runs the old build until it is reloaded');
    }

    {
        const site = await startServer({ build: 'v99990' });
        servers.push(site.server);
        const page = await controlledPage(site.base);
        await waitFor(page, `${badge} === 'v99990'`, 20000);
        site.state.build = 'v99991';
        site.state.missing = 'src/js/naming.js';
        const outcome = await page.evaluate('window.appUpdate()');
        ok(outcome === 'failed', `an install that cannot fetch one of its files is reported as failed (${outcome})`);
        const shown = await page.evaluate(`(() => {
            const button = document.getElementById('help-update-btn');
            return { badge: ${badge}, button: button.textContent, disabled: button.disabled,
                     panel: document.getElementById('help-version-state').textContent };
        })()`);
        ok(shown.badge === 'v99990 ⚠' && shown.button === 'Try installing v99991 again' && !shown.disabled
           && /could not be installed/.test(shown.panel),
           `the badge, the button and the overlay say so, and the button can be used (${JSON.stringify(shown)})`);
        site.state.missing = null;
        const retried = await page.evaluate('window.appUpdate()');
        ok(retried === 'ready', `trying again once the file is there installs it (${retried})`);
        await waitFor(page, `${badge} === 'v99990 › v99991'`, 20000);
    }

    {
        const site = await startServer({ build: 'v99990', redirectIndex: true });
        servers.push(site.server);
        const page = await controlledPage(site.base, '/');
        await page.evaluate(`navigator.serviceWorker.ready.then(() => true)`);
        await page.send('Page.reload');
        await sleep(300);
        await waitFor(page, `${appReady} && !!navigator.serviceWorker.controller`, 20000);
        const served = await page.evaluate(`caches.keys().then(async keys => {
            const shell = await caches.open(keys.find(key => key.startsWith('myai-shell-')));
            const stored = await shell.match(new URL('index.html', location.href).href);
            return { stored: !!stored, redirected: stored ? stored.redirected : null };
        })`);
        ok(served.stored && served.redirected === false,
           `where the server sends index.html on to ./, the shell stores it as a response of its own (${JSON.stringify(served)})`);
        ok(true, 'and the app still loads from the shell after a reload');
    }

    {
        const site = await startServer({ build: 'v128' });
        servers.push(site.server);
        const page = await controlledPage(site.base);
        await waitFor(page, `${badge} === 'v128'`, 20000);
        site.state.build = 'v99992';
        await page.evaluate('navigator.serviceWorker.getRegistration().then(registration => registration.update()).then(() => true)');
        await waitFor(page, `${askController}.then(version => version === 'v99992')`, 20000);
        const registration = await page.evaluate(`navigator.serviceWorker.getRegistration().then(r => ({ waiting: !!r.waiting }))`);
        ok(!registration.waiting,
           'a new build replacing one from before Build 129 takes over by itself, as the pages of those builds expect');
    }

    console.log(`✓ all ${assertions} shell-update assertions passed`);
    emitTestResult('shell-update', 'pass', { assertions, browser: chromium });
} catch (err) {
    const blocked = /ERR_BLOCKED_BY_ADMINISTRATOR|chrome-error:\/\/chromewebdata/.test(String(err?.message || err));
    if (blocked) {
        const message = 'Chromium navigation is blocked by the current runtime policy.';
        if (strictTestsRequired()) throw new Error(message, { cause: err });
        console.log(`↷ ${message} Shell-update suite skipped.`);
        emitTestResult('shell-update', 'skip', { reason: message });
    } else {
        failure = err;
    }
} finally {
    for (const client of clients) client.close();
    for (const server of servers) server.close();
    try { browser.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
if (failure) {
    const relevant = browserErrors.split('\n').filter(line => line && !/ssl_client_socket/.test(line)).slice(-40).join('\n');
    if (relevant) console.error(relevant);
    console.error(failure);
    process.exit(1);
}
process.exit(0);
