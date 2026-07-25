/* Dependency-free Chromium integration suite.
 * Exercises two real top-level browsing contexts on one origin, the Web Locks
 * path, shared localStorage lease, real IndexedDB auto-increment/session rows,
 * fake-microphone capture, stop/finalize/playback, and deletion.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitTestResult, strictTestsRequired } from '../helpers/test-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function findChromium() {
    const candidates = [
        process.env.CHROME_BIN,
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
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

/* The app talks to two same-origin reverse-proxy routes. Implementing them here
   lets the REAL transcription and reply code run end to end - chunk upload,
   NDJSON streaming, live-view plumbing and IndexedDB persistence - without any
   stubbing inside the application itself. */
const apiCalls = { transcribe: [], generate: [], tags: 0 };

function readBody(req) {
    return new Promise(resolve => {
        const parts = [];
        req.on('data', chunk => parts.push(chunk));
        req.on('end', () => resolve(Buffer.concat(parts)));
    });
}

async function handleApiRoute(req, res, pathname) {
    if (pathname === '/transcribe' && req.method === 'POST') {
        const body = (await readBody(req)).toString('latin1');
        apiCalls.transcribe.push({
            storeBackup: /name="store_backup"\r?\n\r?\n(true|false)/.exec(body)?.[1] ?? null,
            language: /name="language"\r?\n\r?\n([^\r\n]*)/.exec(body)?.[1] ?? null,
            hasFile: /name="file"/.test(body)
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            text: 'integration transcript',
            segments: [{ start: 0, end: 2, text: 'integration transcript' }]
        }));
        return true;
    }
    if (pathname === '/ollama/api/tags' && req.method === 'GET') {
        apiCalls.tags++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'integration-model' }] }));
        return true;
    }
    if (pathname === '/ollama/api/generate' && req.method === 'POST') {
        const body = (await readBody(req)).toString('utf8');
        try { apiCalls.generate.push(JSON.parse(body)); } catch (_) { apiCalls.generate.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        // Deliberately awkward framing: a token split across two writes, and a
        // final object with no trailing newline.
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

    // ── Two real tabs: Web Lock + shared lease ──
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

    // ── Shared IndexedDB: unique record and session streams ──
    await tabA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        await dbExec(CONFIG.STORE_WAV, 'clear');
        await dbExec(CONFIG.STORE_REC, 'clear');
        return true;
    })()`);
    const [recA, recB] = await Promise.all([
        tabA.client.evaluate(`(async () => {
            const { dbExec } = await import(${dbImport});
            const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_REC, 'add', { timestamp: Date.now(), sessionId: 'session-a', processing: true });
        })()`),
        tabB.client.evaluate(`(async () => {
            const { dbExec } = await import(${dbImport});
            const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_REC, 'add', { timestamp: Date.now() + 1, sessionId: 'session-b', processing: true });
        })()`)
    ]);
    ok(recA !== recB, 'concurrent tabs receive distinct IndexedDB recording ids');
    await Promise.all([
        tabA.client.evaluate(`(async () => {
            const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_WAV, 'add', { recId:${Number(recA)}, sessionId:'session-a', seq:0, blob:new Blob(['a'], {type:'audio/webm'}) });
        })()`),
        tabB.client.evaluate(`(async () => {
            const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return dbExec(CONFIG.STORE_WAV, 'add', { recId:${Number(recA)}, sessionId:'session-b', seq:0, blob:new Blob(['b'], {type:'audio/webm'}) });
        })()`)
    ]);
    const rawRows = await tabA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_WAV, 'getAll');
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
        const tx = db.transaction(CONFIG.STORE_WAV, 'readonly');
        const store = tx.objectStore(CONFIG.STORE_WAV);
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
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        try {
            await dbExec(CONFIG.STORE_WAV, 'add', {
                recId:${Number(recA)}, sessionId:'session-a', seq:0,
                blob:new Blob(['duplicate'], {type:'audio/webm'})
            });
            return 'accepted';
        } catch (error) { return error?.name || String(error); }
    })()`);
    ok(duplicateResult !== 'accepted', 'duplicate sequence inside one session is rejected rather than overwriting bytes');

    await tabA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
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
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return (await dbExec(CONFIG.STORE_REC, 'get', ${Number(recB)})).atomicCounter;
    })()`);
    ok(atomicCounter === 2, 'concurrent tab updates serialize atomically without losing a write');

    // ── Full app lifecycle with a fake microphone ──
    const appA = await createPage(debugPort, `${new URL('index.html', rootUrl).href}?lifecycle=A`);
    const appB = await createPage(debugPort, `${new URL('index.html', rootUrl).href}?lifecycle=B`);
    clients.push(appA.client, appB.client);
    for (const app of [appA, appB]) {
        await waitFor(app.client, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 15000);
        await app.client.evaluate("window.__alerts=[]; window.alert=m=>window.__alerts.push(String(m)); window.confirm=()=>true; true");
    }
    // Clear test rows left by the storage-isolation section before using the UI.
    await appA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        await dbExec(CONFIG.STORE_WAV, 'clear'); await dbExec(CONFIG.STORE_REC, 'clear'); return true;
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

    await sleep(5200); // cross at least one 4-second durable flush boundary
    const ticking = await appA.client.evaluate(`(() => {
        const text = document.querySelector('.live-rec-clock')?.textContent || '00:00';
        return { text, seconds: text.split(':').reduce((n, part) => n * 60 + Number(part), 0) };
    })()`);
    ok(ticking.seconds >= 4, 'in-card live timer advances in real time');

    await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
    await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 20000);
    const finalized = await appA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
        const chunks = await dbExec(CONFIG.STORE_WAV, 'getAll');
        const rec = rows[0];
        const head = new DataView(await rec.blob.slice(0, 44).arrayBuffer());
        return {
            id: rec.id, processing: rec.processing, blobSize: rec.blob.size,
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
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(finalized.id)}));
    })()`, 10000);
    ok(true, 'delete removes the finalized recording after playback');

    // ── Fatal fragment-write failure: UI stops immediately and retained bytes retry ──
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
            if (!injected && this.name === 'audio_fragments_v2') {
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
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
        const rec = rows[0];
        return {
            id: rec.id,
            processing: rec.processing,
            hasBlob: rec.blob instanceof Blob && rec.blob.size > 44,
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
        const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
        return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(recoveredWriteFailure.id)}));
    })()`, 10000);

    // ── Opus finalization: downloaded WebM has finite duration metadata ──
    const opusSupported = await appA.client.evaluate(`(() => {
        if (typeof MediaRecorder === 'undefined') return false;
        return ['audio/webm;codecs=opus','audio/webm'].some(type => {
            try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
        });
    })()`);
    let opusLifecycleRan = false;
    if (opusSupported) {
        opusLifecycleRan = true;
        await appA.client.evaluate("localStorage.setItem('set-recording-format','opus'); document.getElementById('recordBtn').click(); true", { userGesture: true });
        await waitFor(appA.client, "document.getElementById('recordBtn').textContent.startsWith('Stop Recording')", 15000);
        await sleep(2600);
        await appA.client.evaluate("document.getElementById('recordBtn').click(); true", { userGesture: true });
        await waitFor(appA.client, "document.getElementById('recordBtn').textContent === 'Start Recording' && !document.querySelector('.rec-item-live')", 20000);

        const opus = await appA.client.evaluate(`(async () => {
            const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            const { inspectWebmDurationBytes } = await import(${webmDurationImport});
            const rows = await dbExec(CONFIG.STORE_REC, 'getAll');
            const rec = rows[0];
            const fileBytes = new Uint8Array(await rec.blob.arrayBuffer());
            const meta = inspectWebmDurationBytes(fileBytes);
            const url = URL.createObjectURL(rec.blob);
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
                seekableVersion: Number(rec.webmSeekableVersion || 0),
                metadataPresent: meta.present, metadataMs: meta.durationMs,
                finiteSegment: meta.finiteSegment, cueCount: meta.cueCount,
                audioDuration
            };
        })()`);
        ok(opus.format === 'opus' && String(opus.mime).includes('webm'), 'Opus lifecycle stores a WebM recording');
        ok(opus.seekableVersion >= 2 && opus.metadataPresent, 'finalization marks and writes the indexed WebM remux');
        ok(opus.finiteSegment && opus.cueCount > 0, 'finalized WebM has a finite Segment and seek index');
        ok(Math.abs(opus.metadataMs - opus.durationMs) < 100, 'WebM metadata matches the persisted recording duration');
        ok(Number.isFinite(opus.audioDuration) && opus.audioDuration > 0, 'browser reads a finite total duration from the finalized WebM');
        await appA.client.evaluate(`window.deleteRec(${Number(opus.id)})`);
        await waitFor(appA.client, `(async () => {
            const { dbExec } = await import(${dbImport}); const { CONFIG } = await import(${configImport});
            return !(await dbExec(CONFIG.STORE_REC, 'get', ${Number(opus.id)}));
        })()`, 10000);
        ok(true, 'desktop-seekable Opus recording deletes cleanly');
    } else {
        const message = 'Browser does not expose WebM/Opus MediaRecorder; Opus lifecycle cannot run.';
        if (strictTestsRequired()) throw new Error(message);
        console.log(`↷ ${message}`);
    }

    // ── Live views actually render under the SHIPPED CSP ──
    // A blob: document inherits the opener's Content-Security-Policy. When the
    // popup carried an inline <script>, `script-src 'self' blob:` refused it, the
    // readiness flag was never set and the window rendered nothing at all. Only a
    // real browser, loading the real index.html with the real policy, catches
    // that; every static or Node-level check passes on the broken version.
    const liveTabsImport = JSON.stringify(new URL('src/js/live-tabs.js', rootUrl).href);
    // One popup per user gesture: open them in separate gestures so the browser's
    // popup blocker does not swallow the second window.
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
        'window.__replyWin && window.__replyWin._ready === true && window.__logWin && window.__logWin._ready === true',
        15000);
    ok(true, 'popup documents boot under the shipped Content-Security-Policy');

    const liveViewRendered = await appA.client.evaluate(`(async () => {
        const live = window.__live;
        live.replyStreamInit(4242);              // the second init reply.js performs
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
    await appA.client.evaluate('window.__replyWin.close(); window.__logWin.close(); true');

    // ── Automatic post-recording pipeline, end to end against the API routes ──
    // auto-pipeline.js orchestrates transcribe.js and reply.js and had no
    // coverage of any kind. Seeding a finished recording and invoking the
    // pipeline exercises chunk upload, the concurrency pool, timeline assembly,
    // NDJSON reply streaming, the live views and IndexedDB persistence together.
    const audioImport = JSON.stringify(new URL('src/js/audio.js', rootUrl).href);
    const pipelineImport = JSON.stringify(new URL('src/js/auto-pipeline.js', rootUrl).href);

    const pipelineResult = await appA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { encodeMonoWav } = await import(${audioImport});
        const { runAutoPipeline } = await import(${pipelineImport});

        localStorage.setItem('server-processing-consent-v1', '1');
        localStorage.setItem('set-auto-transcribe', 'on');
        localStorage.setItem('set-auto-reply', 'on');
        localStorage.setItem('set-ollama-model', 'integration-model');
        localStorage.setItem('set-remote-backups', 'off');
        localStorage.setItem('set-transcribe-lang', 'auto');

        const sampleRate = 48000;
        const samples = new Float32Array(sampleRate * 5);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 48) * 0.2;

        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'pipeline-fixture', timestamp: Date.now(), durationMs: 5000,
            processing: false, captureState: 'ready', sampleRate, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [],
            blob: encodeMonoWav(samples, sampleRate)
        });

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
    ok(apiCalls.transcribe.every(call => call.hasFile),
       'every transcription request carries its audio file part');
    ok(apiCalls.transcribe.every(call => call.storeBackup === 'false'),
       'server backup is sent explicitly and stays off by default');
    ok(apiCalls.generate.length === 1, 'exactly one reply generation was requested');
    ok(apiCalls.generate[0]?.stream === true, 'the reply is requested as a stream');
    ok(apiCalls.generate[0]?.model === 'integration-model', 'the configured model is used');
    ok(Number.isFinite(apiCalls.generate[0]?.options?.num_ctx) && apiCalls.generate[0].options.num_ctx >= 8192,
       'the prompt is sent with an explicitly budgeted context window');
    ok(/integration transcript/.test(apiCalls.generate[0]?.prompt || ''),
       'the reply prompt contains the transcript that was just produced');

    // Backups are opt-in, and the switch must reach the wire.
    apiCalls.transcribe.length = 0;
    const backupOn = await appA.client.evaluate(`(async () => {
        const { dbExec } = await import(${dbImport});
        const { CONFIG } = await import(${configImport});
        const { transcribeChunked } = await import(${JSON.stringify(new URL('src/js/transcribe.js', rootUrl).href)});
        localStorage.setItem('set-remote-backups', 'on');
        localStorage.setItem('set-transcribe-lang', 'nl');
        await transcribeChunked(${Number(pipelineResult.id)}, () => {});
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${Number(pipelineResult.id)});
        return (rec.transcripts || []).length;
    })()`);
    ok(backupOn === 2, 'a manual transcription adds a second transcript');
    ok(apiCalls.transcribe.every(call => call.storeBackup === 'true'),
       'enabling server backups is transmitted explicitly on every chunk');
    ok(apiCalls.transcribe.every(call => call.language === 'nl'),
       'an explicit transcription language is forwarded; auto is omitted');

    await appA.client.evaluate(`window.deleteRec(${Number(pipelineResult.id)})`);

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
