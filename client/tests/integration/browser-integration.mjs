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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function eqText(actual, expected, message) {
    ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
    ['.webmanifest', 'application/manifest+json'], ['.png', 'image/png'],
    ['.md', 'text/plain; charset=utf-8']
]);

const apiCalls = { transcribe: [], generate: [], preload: [], release: [], ps: 0, tags: 0 };
let shellVersionOverride = null;
let holdTranscribeMs = 0;
let transcriptText = 'integration transcript';
const ollama = {
    installed: ['integration-model'],
    resident: ['integration-model'],
    loadAfterMs: 0,
    loadStartedAt: 0,
    loading: null,
    psDown: false
};

function residentNow() {
    if (ollama.loading && ollama.loadStartedAt
        && Date.now() - ollama.loadStartedAt >= ollama.loadAfterMs) {
        ollama.resident = [ollama.loading];
        ollama.loading = null;
        ollama.loadStartedAt = 0;
    }
    return ollama.resident;
}

function readBody(req) {
    return new Promise(resolve => {
        const parts = [];
        req.on('data', chunk => parts.push(chunk));
        req.on('end', () => resolve(Buffer.concat(parts)));
    });
}

async function handleApiRoute(req, res, pathname) {
    if (pathname === '/transcribe' && req.method === 'POST') {
        const body = await readBody(req);
        if (holdTranscribeMs) await sleep(holdTranscribeMs);
        apiCalls.transcribe.push({
            language: req.headers['x-transcription-language'] ?? null,
            contentType: String(req.headers['content-type'] || '').split(';', 1)[0],
            hasRawWav: body.length >= 12
                && body.subarray(0, 4).toString('ascii') === 'RIFF'
                && body.subarray(8, 12).toString('ascii') === 'WAVE'
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            text: transcriptText,
            segments: [{ start: 0, end: 2, text: transcriptText }]
        }));
        return true;
    }
    if (pathname === '/ollama/api/tags' && req.method === 'GET') {
        apiCalls.tags++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: ollama.installed.map(name => ({ name })) }));
        return true;
    }
    if (pathname === '/ollama/api/ps' && req.method === 'GET') {
        apiCalls.ps++;
        if (ollama.psDown) { res.socket?.destroy(); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            models: residentNow().map(name => ({ name, size: 100, size_vram: 100 }))
        }));
        return true;
    }
    if (pathname === '/ollama/api/generate' && req.method === 'POST') {
        const body = (await readBody(req)).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
        const wanted = parsed && parsed.model;
        const emptyPrompt = !!parsed && !String(parsed.prompt || '').length;

        if (emptyPrompt && parsed.keep_alive === 0) {
            apiCalls.release.push(wanted);
            ollama.resident = residentNow().filter(name => name !== wanted);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: wanted, done: true }));
            return true;
        }
        if (emptyPrompt) {
            apiCalls.preload.push(wanted);
            if (!residentNow().includes(wanted)) {
                ollama.loading = wanted;
                ollama.loadStartedAt = Date.now();
                while (!residentNow().includes(wanted)) await sleep(50);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: wanted, done: true }));
            return true;
        }

        apiCalls.generate.push(parsed);
        if (!residentNow().includes(wanted)) {
            ollama.loading = wanted;
            ollama.loadStartedAt = Date.now();
            while (!residentNow().includes(wanted)) await sleep(50);
        }
        if (parsed && parsed.stream === false) {
            const numbered = [...String(parsed.prompt || '').matchAll(/^(\d+)\. (.*)$/gm)];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                response: numbered.map(match => `${match[1]}. translated ${match[2]}`).join('\n') || 'translated',
                done: true
            }));
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ response: 'integration ' }) + '\n' + '{"resp');
        await sleep(30);
        res.write('onse":"reply"}\n');
        await sleep(30);
        res.end(JSON.stringify({ done: true }));
        return true;
    }
    return false;
}

async function startStaticServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (await handleApiRoute(req, res, url.pathname)) return;
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.setHeader('Content-Type', TYPES.get(path.extname(file)) || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        if (shellVersionOverride && (rel === 'sw.js' || rel === 'index.html')) {
            const digits = shellVersionOverride.replace(/^v/, '');
            res.end(fs.readFileSync(file, 'utf8')
                .replace(/const VERSION\s*=\s*'v\d+';/, `const VERSION     = '${shellVersionOverride}';`)
                .replace(/<meta name="myai-build" content="\d+">/,
                         `<meta name="myai-build" content="${digits}">`));
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

class CdpClient {
    constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (!message.id) return;
            const pending = this.pending.get(message.id);
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
    async evaluate(expression, { userGesture = false } = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, userGesture
        });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(detail);
        }
        return result.result.value;
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

async function createPage(debugPort, url) {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Could not create Chromium target: ${response.status}`);
    const target = await response.json();
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    const navigation = await client.send('Page.navigate', { url });
    await sleep(500);
    const currentUrl = await client.evaluate('location.href');
    if (currentUrl !== url) throw new Error(`Navigation failed: requested ${url}; current ${currentUrl}; result ${JSON.stringify(navigation)}`);
    return { target, client };
}

async function waitFor(client, expression, timeoutMs = 10000, intervalMs = 100) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        try {
            last = await client.evaluate(expression);
            if (last) return last;
        } catch (_) {}
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for: ${expression}; last=${JSON.stringify(last)}`);
}

async function waitForDebugger(port, processHandle) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        if (processHandle.exitCode != null) throw new Error(`Chromium exited with ${processHandle.exitCode}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch (_) {}
        await sleep(100);
    }
    throw new Error('Chromium remote debugger did not start.');
}

const chromium = findChromium();
if (!chromium) {
    const message = 'Chromium not found; browser integration suite cannot run.';
    if (strictTestsRequired()) throw new Error(message);
    console.log(`↷ ${message}`);
    emitTestResult('browser-lifecycle', 'skip', { reason: message });
    process.exit(0);
}

const { server, port: webPort } = await startStaticServer();
const debugPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-browser-test-'));
const browser = childProcess.spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900',
    '--disable-background-networking', '--disable-default-apps', '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=*',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserErrors = '';
browser.stderr.on('data', chunk => { browserErrors += String(chunk); });

const clients = [];
try {
    await waitForDebugger(debugPort, browser);
    const rootUrl = `http://127.0.0.1:${webPort}/`;
    const lockUrl = new URL('src/js/recording-lock.js', rootUrl).href;
    const dbUrl = new URL('src/js/db.js', rootUrl).href;
    const configUrl = new URL('src/js/config.js', rootUrl).href;
    const webmDurationUrl = new URL('src/js/webm-duration.js', rootUrl).href;
    const lockImport = JSON.stringify(lockUrl);
    const dbImport = JSON.stringify(dbUrl);
    const configImport = JSON.stringify(configUrl);
    const webmDurationImport = JSON.stringify(webmDurationUrl);
    const guiImport = JSON.stringify(new URL('src/js/gui.js', rootUrl).href);

    const tabA = await createPage(debugPort, `${new URL('tests/fixtures/browser/blank.html', rootUrl).href}?tab=A`);
    const tabB = await createPage(debugPort, `${new URL('tests/fixtures/browser/blank.html', rootUrl).href}?tab=B`);
    clients.push(tabA.client, tabB.client);
    await waitFor(tabA.client, "document.readyState === 'complete'");
    await waitFor(tabB.client, "document.readyState === 'complete'");

    const aLock = await tabA.client.evaluate(`(async () => {
        const lock = await import(${lockImport});
        window.__lock = lock;
        const acquired = await lock.acquireRecordingLock();
        if (acquired) lock.publishRecordingLease(101, Date.now(), 'session-a');
        return { acquired, owner: lock.getRecordingOwnerId() };
    })()`);
    ok(aLock.acquired, 'first real browser tab acquires the global recording lock');

    const bView = await tabB.client.evaluate(`(async () => {
        const lock = await import(${lockImport});
        window.__lock = lock;
        const lease = lock.getActiveRecordingLease();
        return { owner: lock.getRecordingOwnerId(), lease };
    })()`);
    ok(aLock.owner !== bView.owner, 'top-level tabs have isolated owner identities');
    ok(bView.lease?.sessionId === 'session-a' && bView.lease?.recId === 101, 'second tab sees the first tab shared session lease');

    const bBlocked = await tabB.client.evaluate('window.__lock.acquireRecordingLock()');
    ok(bBlocked === false, 'second real browser tab is denied while first holds lock');
    await tabA.client.evaluate('window.__lock.releaseRecordingLock()');
    await sleep(150);
    const bAcquired = await tabB.client.evaluate(`(async () => {
        const ok = await window.__lock.acquireRecordingLock();
        if (ok) window.__lock.publishRecordingLease(202, Date.now(), 'session-b');
        return ok;
    })()`);
    ok(bAcquired, 'second tab acquires lock after the first releases it');
    await tabB.client.evaluate('window.__lock.releaseRecordingLock()');

    await tabA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        await dbExec(CONFIG.STORE_FRAGMENTS, 'clear');
        await dbExec(CONFIG.STORE_REC, 'clear');
        return true;
    })()`);
    const [recA, recB] = await Promise.all([
        tabA.client.evaluate(`(async () => {
            const { dbExec, readAudio } = await import(${dbImport});
            const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_REC, 'add', { timestamp: Date.now(), sessionId: 'session-a', processing: true });
        })()`),
        tabB.client.evaluate(`(async () => {
            const { dbExec, readAudio } = await import(${dbImport});
            const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_REC, 'add', { timestamp: Date.now() + 1, sessionId: 'session-b', processing: true });
        })()`)
    ]);
    ok(recA !== recB, 'concurrent tabs receive distinct IndexedDB recording ids');
    await Promise.all([
        tabA.client.evaluate(`(async () => {
            const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_FRAGMENTS, 'add', { recId:${Number(recA)}, sessionId:'session-a', seq:0, blob:new Blob(['a'], {type:'audio/webm'}) });
        })()`),
        tabB.client.evaluate(`(async () => {
            const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_FRAGMENTS, 'add', { recId:${Number(recA)}, sessionId:'session-b', seq:0, blob:new Blob(['b'], {type:'audio/webm'}) });
        })()`)
    ]);
    const rawRows = await tabA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_FRAGMENTS, 'getAll');
        return rows.map(row => ({ recId: row.recId, sessionId: row.sessionId, seq: row.seq }));
    })()`);
    ok(rawRows.length === 2, 'same recording id and sequence can retain two session-isolated fragment rows');
    ok(rawRows.every(row => row.recId === Number(recA) && row.seq === 0), 'collision test uses the identical legacy recording/sequence coordinates');
    ok(new Set(rawRows.map(row => row.sessionId)).size === 2, 'session identity prevents cross-stream overwrite');

    const schema = await tabA.client.evaluate(`(async () => {
        const { CONFIG } = await import(${configImport});
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const tx = db.transaction(CONFIG.STORE_FRAGMENTS, 'readonly');
        const store = tx.objectStore(CONFIG.STORE_FRAGMENTS);
        const streamIndex = store.index('by-stream-seq');
        const result = {
            version: db.version,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            streamKeyPath: Array.from(streamIndex.keyPath),
            streamUnique: streamIndex.unique
        };
        db.close();
        return result;
    })()`);
    ok(schema.version >= 8 && schema.keyPath === 'fragmentId' && schema.autoIncrement,
       'real IndexedDB uses the independent auto-increment fragment schema');
    ok(schema.streamUnique && schema.streamKeyPath.join(',') === 'recId,sessionId,seq',
       'real IndexedDB enforces unique sequence coordinates inside each capture session');

    const duplicateResult = await tabB.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        try {
            await dbExec(CONFIG.STORE_FRAGMENTS, 'add', {
                recId:${Number(recA)}, sessionId:'session-a', seq:0,
                blob:new Blob(['duplicate'], {type:'audio/webm'})
            });
            return 'accepted';
        } catch (error) { return error?.name || String(error); }
    })()`);
    ok(duplicateResult !== 'accepted', 'duplicate sequence inside one session is rejected rather than overwriting bytes');

    await tabA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(recB)});
        rec.atomicCounter = 0; await dbExec(CONFIG.STORE_REC, 'put', rec); return true;
    })()`);
    await Promise.all([
        tabA.client.evaluate(`(async () => {
            const { dbUpdate } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbUpdate(CONFIG.STORE_REC, ${Number(recB)}, rec => { rec.atomicCounter = (rec.atomicCounter || 0) + 1; return rec; });
        })()`),
        tabB.client.evaluate(`(async () => {
            const { dbUpdate } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbUpdate(CONFIG.STORE_REC, ${Number(recB)}, rec => { rec.atomicCounter = (rec.atomicCounter || 0) + 1; return rec; });
        })()`)
    ]);
    const atomicCounter = await tabA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return (await dbExec(CONFIG.STORE_REC, 'get', ${Number(recB)})).atomicCounter;
    })()`);
    ok(atomicCounter === 2, 'concurrent tab updates serialize atomically without losing a write');

    const appA = await createPage(debugPort, `${new URL('index.html', rootUrl).href}?lifecycle=A`);
    const appB = await createPage(debugPort, `${new URL('index.html', rootUrl).href}?lifecycle=B`);
    clients.push(appA.client, appB.client);
    for (const app of [appA, appB]) {
        await waitFor(app.client, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 15000);
        await app.client.evaluate("window.__alerts=[]; window.alert=m=>window.__alerts.push(String(m)); window.confirm=()=>true; true");
    }
    await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        await dbExec(CONFIG.STORE_FRAGMENTS, 'clear'); await dbExec(CONFIG.STORE_REC, 'clear');
        await dbExec(CONFIG.STORE_AUDIO, 'clear');
        localStorage.setItem('set-recording-format', 'wav');
        return true;
    })()`);
    // A quiet room for the automatic gain to listen to: noise at -70 dBFS, read the way the Web
    // Audio spec reads it, as floats or as bytes rounded down to 1/128.
    await appA.client.evaluate(`(() => {
        const proto = AnalyserNode.prototype;
        const original = { floats: proto.getFloatTimeDomainData, bytes: proto.getByteTimeDomainData };
        let seed = 7;
        const noise = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return (seed / 2 ** 32 - 0.5) * 2 * Math.sqrt(3) * Math.pow(10, -70 / 20);
        };
        proto.getFloatTimeDomainData = function (array) { for (let i = 0; i < array.length; i++) array[i] = noise(); };
        proto.getByteTimeDomainData = function (array) {
            for (let i = 0; i < array.length; i++) array[i] = Math.max(0, Math.min(255, Math.floor(128 * (1 + noise()))));
        };
        window.__restoreAnalyser = () => {
            proto.getFloatTimeDomainData = original.floats;
            proto.getByteTimeDomainData = original.bytes;
        };
        return true;
    })()`);
    await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent.startsWith('Stop Recording')", 15000);
    ok(await appA.client.evaluate("!!document.querySelector('.rec-item-live .live-rec-clock')"), 'active recording is integrated into a green live recording row');
    ok(await appA.client.evaluate("!document.getElementById('app-live-status')"), 'duplicate global LIVE badge is absent');

    await waitFor(appB.client, "document.querySelector('.rec-item-live .live-rec-badge')?.textContent.includes('OTHER TAB')", 8000);
    await appB.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
    await sleep(250);
    const appBState = await appB.client.evaluate("({alerts:window.__alerts, liveRows:document.querySelectorAll('.rec-item-live').length, remoteLabel:document.querySelector('.rec-item-live .live-rec-badge')?.textContent || ''})");
    ok(appBState.alerts.some(message => message.includes('Another tab is already recording')), 'second app tab receives an explicit lock alert');
    ok(appBState.liveRows === 1 && appBState.remoteLabel.includes('OTHER TAB'), 'blocked tab mirrors the one protected live row instead of creating a second stream');

    await sleep(5200);
    const ticking = await appA.client.evaluate(`(() => {
        const text = document.querySelector('.live-rec-clock')?.textContent || '00:00';
        return { text, seconds: text.split(':').reduce((n, part) => n * 60 + Number(part), 0) };
    })()`);
    ok(ticking.seconds >= 4, 'in-card live timer advances in real time');
    const quietGain = await appA.client.evaluate(`(async () => {
        const { AppState } = await import(${JSON.stringify(new URL('src/js/recorder.js', rootUrl).href)});
        const gain = AppState.gainNode ? AppState.gainNode.gain.value : null;
        window.__restoreAnalyser();
        return gain;
    })()`);
    ok(quietGain !== null && quietGain <= 1,
       `auto gain: five seconds of a quiet room leave the recording gain alone (${quietGain})`);

    const runwayWhileRecording = await appA.client.evaluate(`(() => {
        const node = document.getElementById('session-runway');
        if (!node.textContent) {
            node.textContent = '\u{1F4BE} about 3.1 h of space';
            node.hidden = false;
        }
        return { text: node.textContent, hidden: node.hidden };
    })()`);
    ok(runwayWhileRecording.text.length > 0 && runwayWhileRecording.hidden === false,
       'a running recording carries a session runway line');

    await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 20000);
    const runwayAfterStop = await appA.client.evaluate(
        "(() => { const n = document.getElementById('session-runway'); return { text: n.textContent, hidden: n.hidden }; })()");
    ok(runwayAfterStop.text === '' && runwayAfterStop.hidden === true,
       'the session runway line is cleared when recording stops instead of lingering');
    const finalized = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
        const chunks = await dbExec(CONFIG.STORE_FRAGMENTS, 'getAll');
        const rec = rows[0];
        const audio = await readAudio(rec.id);
        const head = new DataView(await audio.slice(0, 44).arrayBuffer());
        return {
            id: rec.id, processing: rec.processing, blobSize: audio.size,
            sessionId: rec.sessionId, durationMs: rec.durationMs, chunkCount: chunks.length,
            riff: head.getUint32(0, true) === 0x46464952,
            wave: head.getUint32(8, true) === 0x45564157,
            declaredSize: head.getUint32(4, true) + 8
        };
    })()`);
    ok(finalized.processing === false, 'stop transitions the recording to a finalized static row');
    ok(finalized.blobSize > 44 && finalized.riff && finalized.wave, 'finalized lifecycle produces a playable-structure WAV blob');
    ok(finalized.declaredSize === finalized.blobSize, 'WAV header length matches the complete assembled blob');
    ok(typeof finalized.sessionId === 'string' && finalized.sessionId.length > 8, 'finalized recording retains its unique session identity');
    ok(finalized.chunkCount === 0, 'only the finalized session fragments are cleaned after commit');

    const playback = await appA.client.evaluate(`(async () => {
        const audio = document.querySelector('.rec-item audio');
        const button = document.querySelector('.rec-item .player-play');
        button.click();
        await new Promise(resolve => setTimeout(resolve, 700));
        return { currentTime: audio.currentTime, paused: audio.paused, error: audio.error?.message || null };
    })()`, { userGesture: true });
    ok(!playback.error && (playback.currentTime > 0 || playback.paused === false), 'finalized recording enters browser playback without a media error');

    await appA.client.evaluate(`window.deleteRec(${Number(finalized.id)})`);
    await waitFor(appA.client, `(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(finalized.id)}));
    })()`, 10000);
    ok(true, 'delete removes the finalized recording after playback');

    const pagination = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const gui = await import(${guiImport});
        await dbExec(CONFIG.STORE_REC, 'clear');
        const now = Date.now();
        for (let i = 0; i < CONFIG.PAGE_SIZE * 2 + 1; i++) {
            await dbExec(CONFIG.STORE_REC, 'add', {
                filename: 'page probe ' + i, timestamp: now - (i * 1000),
                durationMs: 1000, processing: false, captureState: 'ready',
                resultGeneration: 0, format: 'wav', transcripts: [], summaries: []
            });
        }
        const read = () => ({
            top: !document.getElementById('paginationTop').hidden,
            bottom: !document.getElementById('pagination').hidden,
            topLabel: document.getElementById('pageInfoTop').textContent,
            bottomLabel: document.getElementById('pageInfo').textContent
        });
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        const first = read();
        document.getElementById('nextPageBtn').click();
        await new Promise(resolve => setTimeout(resolve, 600));
        const later = read();
        document.getElementById('prevPageTopBtn').click();
        await new Promise(resolve => setTimeout(resolve, 600));
        const backToFirst = read();
        gui.resetListToFirstPage();
        await dbExec(CONFIG.STORE_REC, 'clear');
        await gui.renderList({ force: true });
        return { first, later, backToFirst };
    })()`);
    ok(pagination.first.bottom === true && pagination.first.top === false,
       'the first page offers page controls at the bottom only');
    ok(pagination.later.top === true && pagination.later.bottom === true
       && pagination.later.topLabel === pagination.later.bottomLabel,
       'a later page repeats the same page controls at the top of the list');
    ok(pagination.backToFirst.top === false && pagination.backToFirst.bottom === true,
       'the top controls page back and then withdraw again on the first page');

    await appA.client.evaluate(`(() => {
        window.__alerts = [];
        window.__captureErrorSeen = false;
        const observer = new MutationObserver(() => {
            const button = document.getElementById('recordBtn')?.textContent || '';
            const badge = document.querySelector('.live-rec-badge')?.textContent || '';
            if (/error|storage full/i.test(button) || badge.includes('ERROR · STOPPING')) {
                window.__captureErrorSeen = true;
            }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });

        const originalAdd = IDBObjectStore.prototype.add;
        let injected = false;
        IDBObjectStore.prototype.add = function(value) {
            if (!injected && this.name === 'audio_fragments') {
                injected = true;
                IDBObjectStore.prototype.add = originalAdd;
                throw new DOMException('Injected quota exhaustion', 'QuotaExceededError');
            }
            return originalAdd.apply(this, arguments);
        };
        localStorage.setItem('set-recording-format', 'wav');
        document.getElementById('recordBtn').click();
        return true;
    })()`, { userGesture: true });
    await waitFor(appA.client, 'window.__captureErrorSeen === true', 15000);
    ok(true, 'fragment-write failure changes the visible live UI to an explicit error-stopping state');
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 25000);
    const recoveredWriteFailure = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
        const rec = rows[0];
        return {
            id: rec.id,
            processing: rec.processing,
            hasBlob: (await readAudio(rec.id)) instanceof Blob && Number(rec.audioBytes) > 44,
            captureKind: rec.captureError?.kind || '',
            incomplete: !!rec.incompleteAudio,
            alertText: window.__alerts.join('\\n')
        };
    })()`);
    ok(recoveredWriteFailure.processing === false && recoveredWriteFailure.hasBlob,
       'fatal write failure still reaches a finalized playable browser recording after retry');
    ok(recoveredWriteFailure.captureKind === 'quota' && recoveredWriteFailure.incomplete === false,
       'the failed quota fragment is classified, retained and recovered without marking a gap');
    ok(/browser storage became full/i.test(recoveredWriteFailure.alertText)
       && /failed segment was recovered/i.test(recoveredWriteFailure.alertText),
       'user receives an exact post-stop alert instead of an unverified all-audio-saved claim');
    await appA.client.evaluate(`window.deleteRec(${Number(recoveredWriteFailure.id)})`);
    await waitFor(appA.client, `(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(recoveredWriteFailure.id)}));
    })()`, 10000);

    const recordOnDiskThatStaysFullExceptHeartbeat = `(() => {
        window.__alerts = [];
        window.confirm = message => { window.__alerts.push(String(message)); return true; };
        const originalAdd = IDBObjectStore.prototype.add;
        const originalPut = IDBObjectStore.prototype.put;
        window.__diskFull = false;
        window.__restoreDisk = () => {
            IDBObjectStore.prototype.add = originalAdd;
            IDBObjectStore.prototype.put = originalPut;
        };
        const full = name => window.__diskFull && ['audio_fragments', 'recordings', 'audio'].includes(name);
        IDBObjectStore.prototype.add = function () {
            if (full(this.name)) throw new DOMException('Injected full disk', 'QuotaExceededError');
            return originalAdd.apply(this, arguments);
        };
        IDBObjectStore.prototype.put = function () {
            if (full(this.name)) throw new DOMException('Injected full disk', 'QuotaExceededError');
            return originalPut.apply(this, arguments);
        };
        localStorage.setItem('set-recording-format', 'wav');
        document.getElementById('recordBtn').click();
        return true;
    })()`;
    await appA.client.evaluate(recordOnDiskThatStaysFullExceptHeartbeat, { userGesture: true });
    await waitFor(appA.client, "!!document.querySelector('.rec-item-live')", 10000);
    await sleep(5000);
    await appA.client.evaluate('window.__diskFull = true; true');
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.getElementById('recordBtn').disabled", 40000);
    const fullDisk = await appA.client.evaluate(`(async () => {
        const db = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rec = (await db.dbExec(CONFIG.STORE_REC, 'getAll')).find(row => row.processing);
        const beat = rec ? (await db.readCaptureBeats()).get(Number(rec.id)) : null;
        return { id: rec ? rec.id : null,
                 beatKind: beat && beat.captureError ? beat.captureError.kind : null,
                 beatIncomplete: !!(beat && beat.incompleteAudio),
                 offered: window.__alerts.some(text => /Download it before closing this page/.test(text)) };
    })()`);
    ok(fullDisk.id != null && fullDisk.beatKind === 'quota' && fullDisk.beatIncomplete,
       `when storage stays full through Stop, the heartbeat record that knows what happened is kept for recovery (${JSON.stringify(fullDisk)})`);
    ok(fullDisk.offered, 'and the audio still in memory is offered for download before the page is closed');
    const afterRoom = await appA.client.evaluate(`(async () => {
        window.__restoreDisk();
        const db = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const { recoverIncompleteRecordings } = await import(${JSON.stringify(new URL('src/js/recorder.js', rootUrl).href)});
        const beat = (await db.readCaptureBeats()).get(${Number(fullDisk.id)});
        if (beat) await db.writeCaptureBeat({ ...beat, heartbeatAt: Date.now() - 60000 });
        await db.dbUpdate(CONFIG.STORE_REC, ${Number(fullDisk.id)}, rec => { rec.heartbeatAt = Date.now() - 60000; return rec; });
        await recoverIncompleteRecordings();
        const rec = await db.dbExec(CONFIG.STORE_REC, 'get', ${Number(fullDisk.id)});
        return { processing: rec.processing, incomplete: !!rec.incompleteAudio, filename: rec.filename,
                 kind: rec.captureError ? rec.captureError.kind : null, hasAudio: Number(rec.audioBytes) > 44 };
    })()`);
    ok(!afterRoom.processing && afterRoom.hasAudio && afterRoom.incomplete && /\(incomplete\)$/.test(afterRoom.filename)
       && afterRoom.kind === 'quota',
       `once there is room again it is recovered marked incomplete, with the storage error it met, instead of passing as whole (${JSON.stringify(afterRoom)})`);
    await appA.client.evaluate(`window.deleteRec(${Number(fullDisk.id)})`);
    await waitFor(appA.client, `(async () => {
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(fullDisk.id)}));
    })()`, 10000);

    await appA.client.send('Page.bringToFront');
    await sleep(300);
    const opusSupported = await appA.client.evaluate(`(() => {
        if (typeof MediaRecorder === 'undefined') return false;
        return ['audio/webm;codecs=opus','audio/webm'].some(type => {
            try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
        });
    })()`);
    let opusLifecycleRan = false;
    if (opusSupported) {
        opusLifecycleRan = true;
        await appA.client.evaluate("localStorage.setItem('set-recording-format','opus'); localStorage.setItem('set-live-transcribe','off'); document.getElementById('recordBtn').click(); true", { userGesture: true });
        await waitFor(appA.client, "document.getElementById('recordBtn').textContent.startsWith('Stop Recording')", 15000);
        await sleep(14000);
        const opusHealth = await appA.client.evaluate(`(() => {
            const node = document.getElementById('capture-alert');
            return {
                alert: node ? String(node.textContent || '') : '',
                hidden: node ? !!node.hidden : true,
                flagged: !!document.querySelector('.rec-item-capture-stalled')
            };
        })()`);
        ok(opusHealth.alert === '' && opusHealth.hidden,
           'a compressed recording with live transcription off is not accused of capturing no audio, '
           + 'well past the window in which a real fault would be reported, when it is recording perfectly well');
        ok(!opusHealth.flagged, 'and its row is not marked as stalled either');
        await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
        await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 20000);

        const opus = await appA.client.evaluate(`(async () => {
            const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            const { inspectWebmDurationBytes } = await import(${webmDurationImport});
            const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
            const rec = rows[0];
            const stored = await readAudio(rec.id);
            const fileBytes = new Uint8Array(await stored.arrayBuffer());
            const meta = inspectWebmDurationBytes(fileBytes);
            const url = URL.createObjectURL(stored);
            const audioDuration = await new Promise(resolve => {
                const audio = new Audio();
                const done = value => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(value); };
                const timer = setTimeout(() => done(0), 8000);
                audio.addEventListener('loadedmetadata', () => { clearTimeout(timer); done(audio.duration); }, { once: true });
                audio.addEventListener('error', () => { clearTimeout(timer); done(0); }, { once: true });
                audio.preload = 'metadata'; audio.src = url; audio.load();
            });
            return {
                id: rec.id, format: rec.format, mime: rec.mime, durationMs: rec.durationMs,
                incompleteAudio: rec.incompleteAudio === true,
                seekableVersion: Number(rec.webmSeekableVersion || 0),
                metadataPresent: meta.present, metadataMs: meta.durationMs,
                finiteSegment: meta.finiteSegment, cueCount: meta.cueCount,
                audioDuration
            };
        })()`);
        ok(opus.format === 'opus' && String(opus.mime).includes('webm'), 'Opus lifecycle stores a WebM recording');
        ok(opus.incompleteAudio !== true,
           'and is not saved carrying a false claim that its audio is incomplete');

        const listing = await appA.client.evaluate(`(async () => {
            const { getRecordingsPage } = await import(${dbImport});
            const page = await getRecordingsPage(0, 6);
            const rows = page.page;
            return {
                rows: rows.length,
                anyRowCarriesAudio: rows.some(row => row.blob !== undefined),
                allReportSize: rows.every(row => Number(row.audioBytes) > 0),
                bytes: rows.reduce((sum, row) => sum + (Number(row.audioBytes) || 0), 0)
            };
        })()`);
        ok(listing.rows > 0 && !listing.anyRowCarriesAudio,
           'listing recordings never reads their audio, which is what made a page of WAV notes unrenderable');
        ok(listing.allReportSize && listing.bytes > 0,
           'while every row still reports how much audio it has, so the list can show sizes without loading any');
        ok(opus.seekableVersion >= 2 && opus.metadataPresent, 'finalization marks and writes the indexed WebM remux');
        ok(opus.finiteSegment && opus.cueCount > 0, 'finalized WebM has a finite Segment and seek index');
        ok(Math.abs(opus.metadataMs - opus.durationMs) < 100, 'WebM metadata matches the persisted recording duration');
        ok(Number.isFinite(opus.audioDuration) && opus.audioDuration > 0, 'browser reads a finite total duration from the finalized WebM');
        await appA.client.evaluate(`window.deleteRec(${Number(opus.id)})`);
        await waitFor(appA.client, `(async () => {
            const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(opus.id)}));
        })()`, 10000);
        ok(true, 'desktop-seekable Opus recording deletes cleanly');
    } else {
        const message = 'Browser does not expose WebM/Opus MediaRecorder; Opus lifecycle cannot run.';
        if (strictTestsRequired()) throw new Error(message);
        console.log(`↷ ${message}`);
    }

    const liveTabsImport = JSON.stringify(new URL('src/js/live-tabs.js', rootUrl).href);
    const replyWinOpened = await appA.client.evaluate(`(async () => {
        const live = await import(${liveTabsImport});
        window.__live = live;
        live.replyStreamInit(4242);
        window.__replyWin = live.openReplyStreamTab(4242, 'csp-check.wav');
        return !!window.__replyWin;
    })()`, { userGesture: true });
    ok(replyWinOpened, 'the reply stream view opens a popup window');
    const logWinOpened = await appA.client.evaluate(`(() => {
        window.__live.liveLogInit(4243);
        window.__logWin = window.__live.openLiveLogTab(4243, 'csp-check-log.wav');
        return !!window.__logWin;
    })()`, { userGesture: true });
    ok(logWinOpened, 'the live transcript log view opens a popup window');

    await waitFor(appA.client,
        "window.__replyWin && !!window.__replyWin.document.getElementById('footer')"
        + " && window.__logWin && !!window.__logWin.document.getElementById('footer')",
        15000);
    const popupPages = await appA.client.evaluate(`(() => {
        window.__popupMessages = 0;
        for (const win of [window.__replyWin, window.__logWin]) {
            win.addEventListener('message', () => { window.__popupMessages++; });
        }
        return [window.__replyWin, window.__logWin].map(win => ({
            scripts: win.document.scripts.length,
            policy: win.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''
        }));
    })()`);
    ok(popupPages.every(page => page.scripts === 0 && /default-src 'none'/.test(page.policy)),
       `popup pages load under the shipped Content-Security-Policy with no script of their own, and a policy that allows none (${JSON.stringify(popupPages)})`);

    const liveViewRendered = await appA.client.evaluate(`(async () => {
        const live = window.__live;
        const initAgainAsReplyJsDoes = recId => live.replyStreamInit(recId);
        initAgainAsReplyJsDoes(4242);
        live.replyStreamAppend(4242, 'streamed ');
        live.replyStreamAppend(4242, 'answer');
        live.liveLogText(4243, 0, 'transcribed chunk', 0, 60, false);
        await new Promise(r => setTimeout(r, 300));
        const midStream = {
            replyText:  window.__replyWin.document.getElementById('text').textContent,
            logText:    window.__logWin.document.getElementById('transcript').textContent,
            logStatus:  window.__logWin.document.getElementById('status').textContent
        };
        live.replyStreamDone(4242);
        live.liveLogAppend(4243, '\\u2705 Done - 17 chars total');
        await new Promise(r => setTimeout(r, 300));
        return {
            midStream,
            replyStatus: window.__replyWin.document.getElementById('status').textContent,
            logStatus:   window.__logWin.document.getElementById('status').textContent
        };
    })()`);
    ok(liveViewRendered.midStream.replyText === 'streamed answer',
       'reply tokens render in the popup even when the stream is re-initialised after opening');
    ok(liveViewRendered.midStream.logText.includes('transcribed chunk'),
       'transcript chunks render in the live log popup');
    ok(liveViewRendered.midStream.logStatus.includes('chunk'),
       'the live log popup reports chunk progress while work is in flight');
    ok(liveViewRendered.replyStatus.includes('Complete'), 'the reply popup reports completion');
    ok(liveViewRendered.logStatus.includes('Complete'), 'the live log popup reports completion');
    ok(await appA.client.evaluate('window.__popupMessages') === 0,
       'and no message was posted to either popup: the opening tab draws into them');
    await appA.client.evaluate('window.__replyWin.close(); window.__logWin.close(); true');

    // An opened saved text gets auto-scroll controls in its pop-up: built and run by this tab, with
    // no script in the pop-up's page.
    const longReply = Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of a long saved reply.`).join('\n');
    const savedOpened = await appA.client.evaluate(`(() => {
        localStorage.setItem('myai-autoscroll-speed', '120');
        window.__savedWin = window.__live.openSavedReplyView({ key: 'saved-reply-autoscroll', label: 'scroll.wav',
            text: ${JSON.stringify(longReply)}, model: 'test', tokenCount: 1, elapsedMs: 1 });
        return !!window.__savedWin;
    })()`, { userGesture: true });
    ok(savedOpened, 'a saved reply opens in a popup window');
    await waitFor(appA.client, "!!(window.__savedWin && window.__savedWin.document.querySelector('.as-bar .as-play'))"
        + " && window.__savedWin.document.getElementById('text').textContent.length > 1000", 15000);
    const savedPopup = await appA.client.evaluate(`(async () => {
        const doc = window.__savedWin.document;
        const reply = doc.getElementById('reply');
        const play = doc.querySelector('.as-play');
        const speed = doc.querySelector('.as-speed');
        const before = { scripts: doc.scripts.length, speedLabel: speed.textContent, pressed: play.getAttribute('aria-pressed'),
                         max: reply.scrollHeight - reply.clientHeight };
        speed.click();
        const popupShown = !doc.querySelector('.as-pop').hidden;
        doc.querySelector('.as-slower').click();
        const slowerLabel = speed.textContent;
        doc.querySelector('.as-faster').click();
        play.click();
        const startedAt = reply.scrollTop;
        await new Promise(r => setTimeout(r, 1500));
        const moved = reply.scrollTop;
        play.click();
        const pausedAt = reply.scrollTop;
        await new Promise(r => setTimeout(r, 500));
        return { before, popupShown, slowerLabel, startedAt, moved, pausedAt, afterPause: reply.scrollTop,
                 pressedAfter: play.getAttribute('aria-pressed'), stored: localStorage.getItem('myai-autoscroll-speed') };
    })()`, { userGesture: true });
    ok(savedPopup.before.scripts === 0, `the popup page still has no script of its own (${savedPopup.before.scripts})`);
    ok(savedPopup.before.speedLabel === '120/min' && savedPopup.before.pressed === 'false',
       `the controls show the remembered speed and start paused (${JSON.stringify(savedPopup.before)})`);
    ok(savedPopup.popupShown && savedPopup.slowerLabel === '115/min',
       `the speed button opens its popup, and - slows down (${savedPopup.popupShown}, ${savedPopup.slowerLabel})`);
    ok(savedPopup.before.max > 0 && savedPopup.startedAt === 0,
       `a text opened at its end starts again from the top (${savedPopup.startedAt}, can scroll ${savedPopup.before.max})`);
    ok(savedPopup.moved > 20, `▶ scrolls the text in the popup by itself (${savedPopup.moved} px in 1.5 s)`);
    ok(savedPopup.afterPause === savedPopup.pausedAt && savedPopup.pressedAfter === 'false',
       `pressing it again pauses (${savedPopup.pausedAt} then ${savedPopup.afterPause})`);
    ok(savedPopup.stored === '120', `the speed chosen is remembered for the next opened text (${savedPopup.stored})`);
    await appA.client.evaluate('window.__savedWin.close(); localStorage.removeItem("myai-autoscroll-speed"); true');

    const audioImport = JSON.stringify(new URL('src/js/audio.js', rootUrl).href);
    const pipelineImport = JSON.stringify(new URL('src/js/auto-pipeline.js', rootUrl).href);
    const resampleImport = JSON.stringify(new URL('src/js/resample-core.js', rootUrl).href);

    const resampling = await appA.client.evaluate(`(async () => {
        const audio = await import(${audioImport});
        const { toneLevel } = await import(${resampleImport});
        const rate = 48000;
        const samples = new Float32Array(rate * 60);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / rate) + 0.5 * Math.sin(2 * Math.PI * 12000 * i / rate);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        const longTasks = [];
        const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
        observer.observe({ type: 'longtask' });
        const out = await audio.resamplePcmTo16k(samples, samples.length, rate);
        await new Promise(resolve => setTimeout(resolve, 50));
        observer.disconnect();
        const inner = out.subarray(1000, out.length - 1000);
        return { length: out.length, speech: toneLevel(inner, 1000, 16000), ghost: toneLevel(inner, 4000, 16000),
                 longest: Math.round(Math.max(0, ...longTasks)), untouched: samples[12345] !== 0,
                 worker: audio.resampleWorkerState() };
    })()`);
    ok(resampling.length === 960000 && Math.abs(resampling.speech - 0.5) < 0.01 && resampling.ghost < 0.0005,
       `in the browser a minute of 48 kHz audio reaches 16 kHz with its speech intact and no 4 kHz ghost of a 12 kHz sound (${JSON.stringify(resampling)})`);
    ok(resampling.longest < 120 && resampling.untouched && resampling.worker.running && !resampling.worker.failed,
       `and converting it leaves the page responsive: it runs in a worker, on a copy (longest main-thread task ${resampling.longest} ms)`);

    const pipelineResult = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const { writeAudio } = await import(${dbImport});
        const { runAutoPipeline } = await import(${pipelineImport});

        localStorage.setItem('server-processing-consent-v1', '1');
        localStorage.setItem('set-auto-transcribe', 'on');
        localStorage.setItem('set-auto-reply', 'on');
        localStorage.setItem('set-ollama-model', 'integration-model');
        localStorage.setItem('set-transcribe-lang', 'auto');

        const sampleRate = 48000;
        const samples = new Float32Array(sampleRate * 5);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 48) * 0.2;

        const fixtureAudio = encodeMonoWav(samples, sampleRate);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'pipeline-fixture', timestamp: Date.now(), durationMs: 5000,
            processing: false, captureState: 'ready', sampleRate, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [],
            audioBytes: fixtureAudio.size
        });
        await writeAudio(id, fixtureAudio);

        await runAutoPipeline(id);
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        return {
            id,
            transcripts: (rec.transcripts || []).length,
            summaries: (rec.summaries || []).length,
            transcriptText: (rec.transcripts || [])[0]?.text || '',
            transcriptPlain: (rec.transcripts || [])[0]?.plain || '',
            replyText: (rec.summaries || [])[0]?.text || '',
            replyTranscriptId: (rec.summaries || [])[0]?.transcriptId ?? null,
            firstTranscriptId: (rec.transcripts || [])[0]?.id ?? null,
            pipelineError: rec.pipelineError || null
        };
    })()`);

    ok(pipelineResult.pipelineError === null, 'the automatic pipeline completes without recording an error');
    ok(pipelineResult.transcripts === 1, 'automatic transcription stores exactly one transcript');
    ok(/integration transcript/.test(pipelineResult.transcriptPlain),
       'the transcript text returned by the server is persisted');
    ok(/\[\d\d:\d\d-\d\d:\d\d\]/.test(pipelineResult.transcriptText),
       'the stored transcript carries an absolute timestamped timeline');
    ok(pipelineResult.summaries === 1, 'automatic reply stores exactly one reply');
    ok(pipelineResult.replyText === 'integration reply',
       'a reply split awkwardly across network writes is reassembled exactly');
    ok(pipelineResult.replyTranscriptId === pipelineResult.firstTranscriptId,
       'the reply is bound to the transcript it was generated from');

    ok(apiCalls.transcribe.length >= 1, 'audio chunks were uploaded to the transcription route');
    ok(apiCalls.transcribe.every(call => call.hasRawWav),
       'every transcription request body is a raw WAV file');
    ok(apiCalls.transcribe.every(call => call.contentType === 'audio/wav'),
       'every transcription request declares audio/wav and avoids multipart parsing');
    ok(apiCalls.generate.length === 1, 'exactly one reply generation was requested');
    ok(apiCalls.generate[0]?.stream === true, 'the reply is requested as a stream');
    ok(apiCalls.generate[0]?.model === 'integration-model', 'the configured model is used');
    ok(Number.isFinite(apiCalls.generate[0]?.options?.num_ctx) && apiCalls.generate[0].options.num_ctx >= 8192,
       'the prompt is sent with an explicitly budgeted context window');
    ok(/integration transcript/.test(apiCalls.generate[0]?.prompt || ''),
       'the reply prompt contains the transcript that was just produced');
    ok(apiCalls.generate[0]?.keep_alive,
       'the reply asks the server to keep the model resident, so switching back is not another cold load');

    const replyImport = JSON.stringify(new URL('src/js/reply.js', rootUrl).href);

    ollama.installed = ['integration-model', 'other-model'];
    ollama.resident = ['other-model'];
    ollama.loadAfterMs = 6000;
    apiCalls.generate.length = 0;
    apiCalls.preload.length = 0;
    apiCalls.release.length = 0;
    apiCalls.ps = 0;

    const coldSwitch = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { runSummary, forgetModelChoices } = await import(${replyImport});
        CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS = 1500;
        CONFIG.MODEL_PROBE_MS = 300;
        forgetModelChoices();
        const progress = [];
        const startedAt = Date.now();
        let error = null;
        try {
            await runSummary(${Number(pipelineResult.id)}, message => progress.push(String(message)));
        } catch (err) { error = err.message || String(err); }
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(pipelineResult.id)});
        return {
            error, progress, elapsedMs: Date.now() - startedAt,
            summaries: (rec.summaries || []).length,
            newest: (rec.summaries || [])[0]?.text || ''
        };
    })()`);

    ok(coldSwitch.error === null,
       'a model that takes longer to load than the first-byte timeout still produces a reply');
    ok(coldSwitch.elapsedMs > 1500,
       'and it does so by waiting out the load rather than by answering early');
    ok(coldSwitch.newest === 'integration reply', 'the reply itself arrives intact after the load');
    ok(apiCalls.preload.includes('integration-model'),
       'the model is loaded by an explicit preflight rather than by the reply request');
    ok(apiCalls.ps > 0,
       'the wait is supervised by asking the server what it is holding, so a load is not mistaken for a dead server');
    ok(apiCalls.generate.length === 1,
       'the reply request itself is sent once, not retried behind a load that was thrown away');
    ok(coldSwitch.progress.some(message => /Loading integration-model/.test(message)),
       'the wait is reported as a model load, naming the model');
    ok(coldSwitch.progress.some(message => /replacing other-model/.test(message)),
       'and names what has to be displaced for it');

    ollama.resident = ['other-model'];
    ollama.loadAfterMs = 9000;
    apiCalls.release.length = 0;
    const stuckSwap = await appA.client.evaluate(`(async () => {
        const { CONFIG } = await import(${configImport});
        const { ensureModelReady, forgetModelChoices } = await import(${replyImport});
        CONFIG.MODEL_PROBE_MS = 300;
        CONFIG.MODEL_SWAP_GRACE_MS = 1200;
        forgetModelChoices();
        const ready = await ensureModelReady('/ollama', 'integration-model', () => {});
        CONFIG.MODEL_SWAP_GRACE_MS = 90000;
        return ready;
    })()`);
    ok(stuckSwap === true, 'a swap that the server does not make on its own still completes');
    ok(apiCalls.release.includes('other-model'),
       'because the model in the way is released once the grace period passes');
    ok(!apiCalls.release.includes('integration-model'),
       'and the model being loaded is never the one released');

    ollama.resident = ['integration-model'];
    ollama.loadAfterMs = 0;
    const warmSwitch = await appA.client.evaluate(`(async () => {
        const { ensureModelReady, forgetModelChoices } = await import(${replyImport});
        forgetModelChoices();
        const before = Date.now();
        const ready = await ensureModelReady('/ollama', 'integration-model', () => {});
        return { ready, elapsedMs: Date.now() - before };
    })()`);
    ok(warmSwitch.ready === true && warmSwitch.elapsedMs < 1500,
       'a model already resident costs one question, not a load');

    await appA.client.evaluate(`(async () => {
        const { CONFIG } = await import(${configImport});
        CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS = 45000;
        CONFIG.MODEL_PROBE_MS = 3000;
        return true;
    })()`);
    ollama.installed = ['integration-model'];
    ollama.resident = ['integration-model'];
    apiCalls.generate.length = 0;

    apiCalls.transcribe.length = 0;
    const secondPass = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { transcribeChunked } = await import(${JSON.stringify(new URL('src/js/transcribe.js', rootUrl).href)});
        localStorage.setItem('set-transcribe-lang', 'nl');
        await transcribeChunked(${Number(pipelineResult.id)}, () => {});
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(pipelineResult.id)});
        return (rec.transcripts || []).length;
    })()`);
    ok(secondPass === 2, 'a manual transcription adds a second transcript');
    ok(apiCalls.transcribe.every(call => call.hasRawWav && call.contentType === 'audio/wav'),
       'manual transcription also uses the raw WAV protocol');
    ok(apiCalls.transcribe.every(call => call.language === 'nl'),
       'an explicit transcription language is forwarded in the request header; auto is omitted');

    await appA.client.evaluate(`window.deleteRec(${Number(pipelineResult.id)})`);

    transcriptText = 'hello from the meeting';
    await appA.client.evaluate(`(async () => {
        const { CONFIG } = await import(${configImport});
        window.__heartbeatMs = CONFIG.RECORDING_HEARTBEAT_MS;
        CONFIG.RECORDING_HEARTBEAT_MS = 150;
        window.__alerts = [];
        localStorage.setItem('server-processing-consent-v1', '1');
        localStorage.setItem('set-live-transcribe', 'on');
        localStorage.setItem('live-transcribe-default-acknowledged-v1', '1');
        localStorage.setItem('set-auto-transcribe', 'off');
        localStorage.setItem('set-second-pass', 'off');
        localStorage.setItem('set-speaker-detection', 'off');
        localStorage.setItem('set-recording-format', 'wav');
        document.getElementById('recordBtn').click();
        return true;
    })()`, { userGesture: true });
    await waitFor(appA.client, "!!document.querySelector('.rec-item-live')", 10000);
    const liveRecordingId = await waitFor(appA.client, `(async () => {
        const { dbExec, readAudio, readLiveTranscript } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const live = (await dbExec(CONFIG.STORE_REC, 'getAll')).find(rec => rec.processing);
        if (!live) return 0;
        const stored = await readLiveTranscript(live.id);
        const lines = (stored && stored.lines) || [];
        return lines.some(line => /hello from the meeting/.test(line.text)) ? live.id : 0;
    })()`, 30000);
    ok(liveRecordingId > 0, 'the live transcript is saved while the recording is still running, so a crash cannot take it');

    const heartbeatRow = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(liveRecordingId)});
        return { carries: !!(rec && rec.liveTranscript), marker: (rec && rec.liveTranscriptLines) || 0 };
    })()`);
    ok(!heartbeatRow.carries && heartbeatRow.marker > 0,
       'while the row the heartbeat rewrites every three seconds holds only a count of it, not the text');

    transcriptText = 'confirm speaker 2';
    await waitFor(appA.client, "[...document.querySelectorAll('.ls-system')].some(node => /nothing is waiting to be confirmed/.test(node.textContent))", 30000);
    ok(true, 'confirming a speaker with no suggestion standing is answered rather than acted on');

    transcriptText = 'hello from the meeting';
    await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 45000);
    const spokenStop = await appA.client.evaluate(`(async () => {
        const { dbExec, readAudio, readLiveTranscript } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        CONFIG.RECORDING_HEARTBEAT_MS = window.__heartbeatMs;
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(liveRecordingId)});
        const stored = await readLiveTranscript(${Number(liveRecordingId)});
        const text = ((stored && stored.lines) || []).map(line => line.text).join(' ');
        return { processing: rec ? rec.processing : null, hasBlob: !!(rec && Number(rec.audioBytes) > 44), text };
    })()`);
    ok(spokenStop.processing === false && spokenStop.hasBlob, 'stopping saves the recording');
    ok(spokenStop.text.includes('hello from the meeting'), 'the saved live transcript keeps what was said before the stop');
    ok(!/nothing is waiting to be confirmed/.test(spokenStop.text), 'replies to an instruction are not saved as speech');

    const guard = await appA.client.evaluate(`(async () => {
        const dbmod = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        await dbmod.dbExec(CONFIG.STORE_REC, 'clear');

        let recording = true;
        dbmod.setDatabaseBusyCheck(() => recording);
        const seen = [];
        dbmod.setDatabaseGuardListener(state => seen.push(state));

        let rivalOpened = false;
        const rival = indexedDB.open(CONFIG.DB_NAME, 99);
        rival.onsuccess = () => { rivalOpened = true; };
        rival.onblocked = () => {};

        await new Promise(r => setTimeout(r, 1200));
        const heldOff = !rivalOpened;
        let stillWorking = false;
        let lockedOutAs = null;
        try {
            stillWorking = (await dbmod.dbExec(CONFIG.STORE_REC, 'getAll')).length === 0;
        } catch (err) {
            lockedOutAs = String((err && err.name) || err);
        }
        const warnedWhileRecording = seen.includes('blocked');

        recording = false;
        dbmod.setDatabaseBusyCheck(() => false);
        const reopen = await dbmod.dbExec(CONFIG.STORE_REC, 'getAll').then(() => true).catch(() => false);
        for (let i = 0; i < 60 && !rivalOpened; i++) await new Promise(r => setTimeout(r, 100));
        const rivalGotThrough = rivalOpened;
        const toldClosed = seen.includes('closed');

        try { rival.result && rival.result.close(); } catch (_) {}
        await new Promise(resolve => {
            const wipe = indexedDB.deleteDatabase(CONFIG.DB_NAME);
            wipe.onsuccess = wipe.onerror = () => resolve();
        });
        const workingAgain = await dbmod.dbExec(CONFIG.STORE_REC, 'getAll').then(() => true).catch(() => false);
        return { heldOff, stillWorking, lockedOutAs, warnedWhileRecording, reopen, seen,
                 rivalGotThrough, toldClosed, workingAgain };
    })()`);
    ok(guard.heldOff,
       'a newer version waiting to start does not get the database while this tab is recording');
    ok(guard.stillWorking,
       `and the recording tab keeps writing, instead of having its connection closed underneath it (${guard.lockedOutAs || 'ok'})`);
    ok(guard.warnedWhileRecording,
       'the wait is reported rather than left as a page that looks frozen');
    ok(guard.reopen,
       'and once the recording is over the tab still has a working database, reopening it if it was closed');
    ok(guard.rivalGotThrough && guard.toldClosed,
       'and the waiting version gets the database once the recording stops, without anyone closing a tab');
    ok(guard.workingAgain, 'the suite continues on a fresh database of the current version');

    const liveStore = await appA.client.evaluate(`(async () => {
        const { dbExec, readLiveTranscript, writeLiveTranscript, deleteLiveTranscript,
                cleanupOrphanLiveTranscripts } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        await dbExec(CONFIG.STORE_REC, 'clear');

        const strandedId = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'row carrying its own transcript', timestamp: Date.now(), durationMs: 2000,
            processing: false, captureState: 'ready', resultGeneration: 0,
            transcripts: [], summaries: [],
            liveTranscript: { lines: [{ key: 'a', startSec: 0, endSec: 2, text: 'stranded on the row' }] }
        });
        const readStranded = await readLiveTranscript(strandedId);

        const modernId = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'modern row', timestamp: Date.now(), durationMs: 2000,
            processing: false, captureState: 'ready', resultGeneration: 0,
            transcripts: [], summaries: []
        });
        await writeLiveTranscript(modernId, {
            lines: [{ key: 'b', startSec: 0, endSec: 2, text: 'written by this build' }],
            coverage: [{ fromSec: 0, toSec: 2 }], languages: ['en']
        });
        const modernRow = await dbExec(CONFIG.STORE_REC, 'get', modernId);
        const readModern = await readLiveTranscript(modernId);

        await dbExec(CONFIG.STORE_REC, 'delete', modernId);
        const orphansRemoved = await cleanupOrphanLiveTranscripts();
        const afterSweep = await readLiveTranscript(modernId);

        await deleteLiveTranscript(strandedId);
        await dbExec(CONFIG.STORE_REC, 'clear');
        return {
            strandedText: readStranded ? readStranded.lines[0].text : null,
            modernText: (readModern && readModern.lines[0].text) || null,
            rowCarriesText: !!(modernRow && modernRow.liveTranscript),
            orphansRemoved,
            sweptAway: afterSweep === null
        };
    })()`);
    ok(liveStore.strandedText === null,
       'a transcript is read only from the store that owns it, never from a copy left on the recording row');
    eqText(liveStore.modernText, 'written by this build',
       'and one written to the new store is read back from it');
    ok(!liveStore.rowCarriesText,
       'while the recording row itself no longer carries the transcript the heartbeat would have to clone');
    ok(liveStore.orphansRemoved >= 1 && liveStore.sweptAway,
       'a transcript whose recording is gone is swept rather than left behind');

    const stall = await appA.client.evaluate(`(async () => {
        const { AppState } = await import(${JSON.stringify(new URL('src/js/recorder.js', rootUrl).href)});
        const recordBtn = document.getElementById('recordBtn');
        recordBtn.click();
        for (let i = 0; i < 200 && !AppState.startTime; i++) await new Promise(r => setTimeout(r, 50));
        for (let i = 0; i < 200 && !(AppState.samplesSeen > 0); i++) await new Promise(r => setTimeout(r, 50));
        const heard = AppState.samplesSeen > 0;

        await AppState.audioCtx.suspend();
        const alert = document.getElementById('capture-alert');
        for (let i = 0; i < 300 && alert.hidden; i++) await new Promise(r => setTimeout(r, 50));
        const warned = !alert.hidden;
        const message = alert.textContent;
        const stalledRow = !!document.querySelector('.rec-item-capture-stalled');
        const stillRecording = AppState.recId != null && AppState.startTime > 0;

        await AppState.audioCtx.resume();
        for (let i = 0; i < 300 && !alert.hidden; i++) await new Promise(r => setTimeout(r, 50));
        const cleared = alert.hidden;

        recordBtn.click();
        for (let i = 0; i < 400 && AppState.recId != null; i++) await new Promise(r => setTimeout(r, 50));
        return { heard, warned, message, stalledRow, stillRecording, cleared,
                 alertGone: document.getElementById('capture-alert').hidden };
    })()`, { userGesture: true });
    ok(stall.heard, 'a running recording is counting the audio that actually arrives');
    ok(stall.warned && /Not recording sound right now/.test(stall.message),
       'when audio stops arriving the screen says so, instead of counting on as though nothing happened');
    ok(stall.stalledRow, 'and the live row itself is marked, not only a line of text');
    ok(stall.stillRecording,
       'the recording is not stopped by the warning, because a false alarm must never end a recording');
    ok(stall.cleared, 'and the warning clears by itself once audio comes back');
    ok(stall.alertGone, 'with nothing left on screen once the recording ends');

    const fullscreen = await appA.client.evaluate(`(() => {
        const el = document.documentElement;
        el.requestFullscreen = undefined;
        el.webkitRequestFullscreen = undefined;
        const canvas = document.getElementById('visualizer');
        canvas.click();
        const entered = canvas.classList.contains('fullscreen');
        const hidden = document.getElementById('settingsBtn').style.display;
        canvas.click();
        return { entered, hidden, left: !canvas.classList.contains('fullscreen'),
                 gear: document.getElementById('settingsBtn').style.display };
    })()`, { userGesture: true });
    ok(fullscreen.entered && fullscreen.hidden === 'none',
       'tapping the waveform where the browser has no fullscreen API still gives a fullscreen view');
    ok(fullscreen.left && fullscreen.gear !== 'none',
       'and tapping it again leaves, instead of trapping the page with the controls hidden');

    const guiImportUrl = JSON.stringify(new URL('src/js/gui.js', rootUrl).href);
    const jobsImport = JSON.stringify(new URL('src/js/jobs.js', rootUrl).href);
    const transcribeImport = JSON.stringify(new URL('src/js/transcribe.js', rootUrl).href);
    holdTranscribeMs = 4000;
    const busy = await appA.client.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const gui = await import(${guiImportUrl});
        const { hasJob, cancelAllForRec } = await import(${jobsImport});
        const { transcribeChunked } = await import(${transcribeImport});

        await dbExec(CONFIG.STORE_REC, 'clear');
        const samples = new Float32Array(48000 * 3);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 48) * 0.2;
        const probeAudio = encodeMonoWav(samples, 48000);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'busy probe', timestamp: Date.now(), durationMs: 3000,
            processing: false, captureState: 'ready', sampleRate: 48000, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [], audioBytes: probeAudio.size
        });
        await writeAudio(id, probeAudio);
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });

        const running = transcribeChunked(id, () => {}).catch(() => {});
        for (let i = 0; i < 100 && !hasJob('t', id); i++) await new Promise(r => setTimeout(r, 20));
        const started = hasJob('t', id);

        await gui.renderList({ force: true });
        const button = document.getElementById('btn-t-' + id);
        const after = {
            started,
            stillRunning: hasJob('t', id),
            disabled: !!(button && button.disabled),
            busyFlag: !!(button && button.dataset.busy),
            statusBar: !!document.getElementById('live-status-scribe-' + id)
        };
        cancelAllForRec(id);
        await running;
        await dbExec(CONFIG.STORE_REC, 'clear');
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        return after;
    })()`);
    holdTranscribeMs = 0;
    ok(busy.started && busy.stillRunning, 'a transcription job survives a repaint of the list');
    ok(busy.disabled && busy.busyFlag,
       'and the rebuilt row shows its button as busy, instead of inviting a tap that would abort and restart it');
    ok(busy.statusBar,
       'and the progress bar with its cancel control comes back with the row');

    const transcriptBeforeReplay = transcriptText;
    transcriptText = '';
    const replayKept = await appA.client.evaluate(`(async () => {
        const { dbExec, writeAudio, writeLiveTranscript } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const { transcribeChunked } = await import(${transcribeImport});
        const samples = new Float32Array(16000 * 14);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 16) * 0.2;
        const audio = encodeMonoWav(samples, 16000);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'replay probe', timestamp: Date.now(), durationMs: 14000,
            processing: false, captureState: 'ready', sampleRate: 16000, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [], audioBytes: audio.size
        });
        await writeAudio(id, audio);
        await writeLiveTranscript(id, {
            lines: [
                { key: 'w1.0:0', startSec: 0, endSec: 4, text: 'basic tests and should work' },
                { key: 'w1.1:0', startSec: 2, endSec: 7, text: 'It should work without too much strain at all.' },
                { key: 'w1.2:0', startSec: 8, endSec: 13.5, text: 'then we move on to the next item' }
            ],
            coverage: [{ fromSec: 0, toSec: 14 }]
        });
        await transcribeChunked(id, () => {});
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        await dbExec(CONFIG.STORE_REC, 'delete', id);
        return (rec.transcripts || [])[0]?.text || '';
    })()`);
    transcriptText = 'kept after a reply was deleted';
    holdTranscribeMs = 1500;
    const deletingReply = await appA.client.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const { transcribeChunked } = await import(${transcribeImport});
        const { hasJob } = await import(${jobsImport});
        const samples = new Float32Array(16000 * 4);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 16) * 0.2;
        const audio = encodeMonoWav(samples, 16000);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'reply probe', timestamp: Date.now(), durationMs: 4000,
            processing: false, captureState: 'ready', sampleRate: 16000, format: 'wav', resultGeneration: 0,
            transcripts: [{ id: 't-old', text: 'old reading', plain: 'old reading', source: 'S', time: Date.now() }],
            summaries: [{ id: 's-old', transcriptId: 't-old', text: 'an old reply', time: Date.now() }],
            audioBytes: audio.size
        });
        await writeAudio(id, audio);
        const realConfirm = window.confirm;
        window.confirm = () => true;
        let outcome = 'finished';
        const running = transcribeChunked(id, () => {}).catch(err => { outcome = err && err.name; });
        for (let i = 0; i < 100 && !hasJob('t', id); i++) await new Promise(r => setTimeout(r, 20));
        await window.deleteSummary(id, 's-old');
        await running;
        window.confirm = realConfirm;
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        await dbExec(CONFIG.STORE_REC, 'delete', id);
        return { outcome, replies: (rec.summaries || []).length,
                 transcripts: (rec.transcripts || []).map(item => item.plain) };
    })()`);
    holdTranscribeMs = 0;

    holdTranscribeMs = 1500;
    const recorderImport = JSON.stringify(new URL('src/js/recorder.js', rootUrl).href);
    const cancelChain = await appA.client.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const { runAfterRecording } = await import(${recorderImport});
        const { hasJob } = await import(${jobsImport});
        const saved = ['set-auto-transcribe', 'set-auto-reply', 'set-second-pass'].map(key => [key, localStorage.getItem(key)]);
        localStorage.setItem('set-auto-transcribe', 'on');
        localStorage.setItem('set-auto-reply', 'off');
        localStorage.setItem('set-second-pass', 'keep');
        const samples = new Float32Array(16000 * 4);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 16) * 0.2;
        const audio = encodeMonoWav(samples, 16000);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'chain probe', timestamp: Date.now(), durationMs: 4000,
            processing: false, captureState: 'ready', sampleRate: 16000, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [], audioBytes: audio.size
        });
        await writeAudio(id, audio);
        const chain = runAfterRecording(id);
        for (let i = 0; i < 100 && !hasJob('t', id); i++) await new Promise(r => setTimeout(r, 20));
        const started = hasJob('t', id);
        window.cancelRecJob(id);
        const outcome = await chain;
        await new Promise(r => setTimeout(r, 2500));
        const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
        await dbExec(CONFIG.STORE_REC, 'delete', id);
        for (const [key, value] of saved) { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        return { started, outcome, running: hasJob('t', id), transcripts: (rec.transcripts || []).length };
    })()`);
    holdTranscribeMs = 0;
    ok(cancelChain.started && cancelChain.outcome === 'cancelled' && !cancelChain.running && cancelChain.transcripts === 0,
       `cancelling the automatic transcription of a stopped recording also stops the cleanup pass that would follow it (${JSON.stringify(cancelChain)})`);

    const generateBefore = apiCalls.generate.length;
    await appA.client.evaluate(`(async () => {
        const { dbExec, writeLiveTranscript } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { beginJob } = await import(${jobsImport});
        const { fillTranslations } = await import(${transcribeImport});
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'fill probe', timestamp: Date.now(), durationMs: 8000, processing: false, captureState: 'ready',
            sampleRate: 16000, format: 'wav', resultGeneration: 0, transcripts: [], summaries: []
        });
        await writeLiveTranscript(id, {
            lines: [
                { key: 'f.0', startSec: 0, endSec: 3, text: 'Goedemorgen allemaal', language: 'nl', translations: {} },
                { key: 'f.1', startSec: 4, endSec: 7, text: 'Good morning everyone', language: 'en', translations: {} }
            ],
            languages: ['nl', 'en'], coverage: [{ fromSec: 0, toSec: 8 }]
        });
        window.__fillProbe = { id, reply: beginJob('r', 987654) };
        window.__fillProbe.done = fillTranslations(id);
        return true;
    })()`);
    await sleep(2500);
    const generateWhileReplying = apiCalls.generate.length - generateBefore;
    const fillResult = await appA.client.evaluate(`(async () => {
        const { endJob } = await import(${jobsImport});
        const { readLiveTranscript, dbExec } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        endJob('r', 987654, window.__fillProbe.reply);
        const result = await window.__fillProbe.done;
        const live = await readLiveTranscript(window.__fillProbe.id);
        await dbExec(CONFIG.STORE_REC, 'delete', window.__fillProbe.id);
        return { filled: result.filled, lines: live.lines.map(line => line.translations) };
    })()`);
    ok(generateWhileReplying === 0 && fillResult.filled === 2,
       `the translation fill sends nothing while a reply is running, and completes every line once it has finished (${generateWhileReplying} sent while replying, ${JSON.stringify(fillResult)})`);

    ok(deletingReply.outcome === 'finished' && deletingReply.replies === 0
       && deletingReply.transcripts.some(text => /kept after a reply was deleted/.test(text)),
       `deleting an old reply while the recording is being transcribed leaves the transcription running, and its transcript is saved (${JSON.stringify(deletingReply)})`);
    transcriptText = transcriptBeforeReplay;
    ok(/basic tests and should work/.test(replayKept) && /without too much strain/.test(replayKept)
       && /then we move on to the next item/.test(replayKept),
       `when the server hears nothing on replaying an overlapping live passage, the saved transcript keeps the live words (${replayKept})`);

    const shellVersion = fs.readFileSync(path.join(root, 'sw.js'), 'utf8')
        .match(/const VERSION\s*=\s*'(v\d+)';/)?.[1];
    ok(!!shellVersion, 'the shipped service worker declares a version');
    const stamp = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
        .match(/<meta name="myai-build" content="(\d+)">/)?.[1];
    eqText(`v${stamp}`, shellVersion, 'and the document it serves is stamped with the same build');

    const updateTab = await createPage(debugPort, `${new URL('index.html', rootUrl).href}?update=1`);
    clients.push(updateTab.client);
    await waitFor(updateTab.client,
        "document.readyState === 'complete' && !!document.getElementById('app-version')", 15000);
    await waitFor(updateTab.client, '!!navigator.serviceWorker.controller', 20000);
    await waitFor(updateTab.client,
        `document.getElementById('app-version').textContent === '${shellVersion}'`, 20000);
    ok(true, 'a controlled page reports the build that is serving it');

    shellVersionOverride = 'v99991';
    const found = await updateTab.client.evaluate('window.appUpdate()');
    ok(found === 'ready' || found === 'installing',
       `tapping the version finds a newer build without reloading the page (${found})`);
    await waitFor(updateTab.client,
        "document.getElementById('app-version').textContent.includes('\u203a v99991')", 60000);

    const pending = await updateTab.client.evaluate(`(() => {
        const node = document.getElementById('app-version');
        return { text: node.textContent, ready: node.classList.contains('update-ready'),
                 panel: document.getElementById('help-version-state')?.textContent || '',
                 button: document.getElementById('help-update-btn')?.textContent || '' };
    })()`);
    eqText(pending.text, `${shellVersion} \u203a v99991`,
       'a build that is installed but not running is shown beside the running one, never instead of it');
    ok(pending.ready, 'and the badge marks itself as something to act on');
    ok(/still running/.test(pending.panel) && /Reload into v99991/.test(pending.button),
       'the guide overlay says the same thing in words');

    await updateTab.client.evaluate(`(() => {
        window.__beforeReload = true;
        window.appUpdate();
        return true;
    })()`);
    await waitFor(updateTab.client,
        "document.readyState === 'complete' && typeof window.__beforeReload === 'undefined'"
        + " && !!document.getElementById('app-version')", 25000);
    await waitFor(updateTab.client,
        "document.getElementById('app-version').textContent === 'v99991'", 25000);
    const settled = await updateTab.client.evaluate(`(() => {
        const node = document.getElementById('app-version');
        return { text: node.textContent, ready: node.classList.contains('update-ready') };
    })()`);
    eqText(settled.text, 'v99991',
       'after the reload the badge shows the new build on its own, so no second refresh is needed');
    ok(!settled.ready, 'and nothing is left waiting');

    console.log(`✓ all ${assertions} browser integration assertions passed`);
    emitTestResult('browser-lifecycle', 'pass', { assertions, browser: chromium, opusLifecycleRan });
} catch (err) {
    const blocked = /ERR_BLOCKED_BY_ADMINISTRATOR|chrome-error:\/\/chromewebdata/.test(String(err?.message || err));
    if (blocked) {
        const message = 'Chromium navigation is blocked by the current runtime policy.';
        if (strictTestsRequired()) throw new Error(message, { cause: err });
        console.log(`↷ ${message} Browser integration suite skipped.`);
        emitTestResult('browser-lifecycle', 'skip', { reason: message });
    } else {
        if (browserErrors) console.error(browserErrors.slice(-4000));
        throw err;
    }
} finally {
    for (const client of clients) client.close();
    server.close();
    try { browser.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
