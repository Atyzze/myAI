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
let currentJourney = 'opening the app';
function journey(title) {
    currentJourney = title;
}
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const chromium = findChromium();
if (!chromium) {
    const message = 'Chromium not found; user-journey suite cannot run.';
    if (strictTestsRequired()) throw new Error(message);
    console.log(`↷ ${message}`);
    emitTestResult('user-journeys', 'skip', { reason: message });
    process.exit(0);
}

const TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json'],
    ['.png', 'image/png']
]);

const NEXT_SCHEMA_BUILD_PREFIX = '/next';
function withDatabaseVersionRaised(configSource) {
    return configSource.replace(/DB_VERSION:(\s+)(\d+),/,
        (_, space, version) => `DB_VERSION:${space}${Number(version) + 1},`);
}

let holdTranscribeMs = 0;
let failTranscribe = false;

const OLLAMA_DEFAULT_CTX = 4096;
const OLLAMA_RELOAD_MS = 3000;
const CTX_A_LONG_REPLY_LEFT_LOADED = 32768;
const ollama = {
    on: false, model: 'journey-model', loadedCtx: CTX_A_LONG_REPLY_LEFT_LOADED, reloadInProgress: null, requests: [],
    liveCounter: 0
};
async function readJson(req) {
    const parts = [];
    for await (const part of req) parts.push(part);
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) { return {}; }
}
function translateLikeAModel(prompt) {
    const fenced = String(prompt).match(/---\n([\s\S]*?)\n---/);
    if (fenced) return `NL ${fenced[1]}`;
    return String(prompt).split('\n').filter(line => /^\d+\. /.test(line))
        .map(line => line.replace(/^(\d+)\. /, '$1. NL ')).join('\n');
}
async function fakeOllama(req, res, pathname) {
    const send = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (pathname.endsWith('/api/tags')) return send({ models: [{ name: ollama.model }] });
    if (pathname.endsWith('/api/ps')) return send({ models: [{ name: ollama.model, size: 100, size_vram: 100 }] });
    if (!pathname.endsWith('/api/generate')) return send({});
    const body = await readJson(req);
    const wantedCtx = Number(body.options && body.options.num_ctx) || OLLAMA_DEFAULT_CTX;
    const empty = !String(body.prompt || '').length;
    const started = Date.now();
    while (ollama.reloadInProgress) await ollama.reloadInProgress;
    const reloaded = wantedCtx !== ollama.loadedCtx;
    if (reloaded) {
        ollama.reloadInProgress = sleep(OLLAMA_RELOAD_MS)
            .then(() => { ollama.loadedCtx = wantedCtx; ollama.reloadInProgress = null; });
        await ollama.reloadInProgress;
    }
    ollama.requests.push({ empty, numCtx: wantedCtx, reloaded, waitedMs: Date.now() - started });
    if (empty) return send({ model: body.model, done: true });
    return send({
        model: body.model, done: true, response: translateLikeAModel(body.prompt),
        load_duration: reloaded ? OLLAMA_RELOAD_MS * 1e6 : 1e6,
        prompt_eval_duration: 2e7, eval_duration: 8e7, eval_count: 20
    });
}
const LIVE_SENTENCES = {
    en: n => `We walked along the river to the old market number ${n}.`,
    nl: n => `Wij liepen langs de rivier naar de oude markt nummer ${n}.`
};

async function startServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        let pathname = decodeURIComponent(url.pathname);
        if (ollama.on && pathname.endsWith('/transcribe') && req.method === 'POST') {
            for await (const _ of req) {}
            const n = ollama.liveCounter++;
            const language = n % 2 ? 'nl' : 'en';
            const text = LIVE_SENTENCES[language](n);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text, language, segments: [{ start: 2.1, end: 3.9, text }] }));
            return;
        }
        if (ollama.on && pathname.includes('/ollama/')) return fakeOllama(req, res, pathname);
        if (pathname.endsWith('/transcribe') && req.method === 'POST') {
            const parts = [];
            for await (const part of req) parts.push(part);
            const body = Buffer.concat(parts);
            if (holdTranscribeMs) await sleep(holdTranscribeMs);
            if (failTranscribe) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
            let peak = 0;
            for (let at = 44; at + 1 < body.length; at += 2) peak = Math.max(peak, Math.abs(body.readInt16LE(at)));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(peak < 200
                ? { text: '', segments: [] }
                : { text: 'journey', segments: [{ start: 0, end: 1, text: 'journey' }] }));
            return;
        }
        if (pathname.includes('/ollama/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
            return;
        }
        let servingNextSchemaBuild = false;
        if (pathname.startsWith(`${NEXT_SCHEMA_BUILD_PREFIX}/`)) {
            servingNextSchemaBuild = true;
            pathname = pathname.slice(NEXT_SCHEMA_BUILD_PREFIX.length);
        }
        const rel = pathname.replace(/^\/+/, '') || 'index.html';
        if (rel === 'sw.js') {
            res.writeHead(404);
            res.end('no service worker in this suite, so both builds keep their own module graph on one origin');
            return;
        }
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.setHeader('Content-Type', TYPES.get(path.extname(file)) || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        if (servingNextSchemaBuild && rel === 'src/js/config.js') {
            res.end(withDatabaseVersionRaised(fs.readFileSync(file, 'utf8')));
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
}

class Cdp {
    constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.events = []; }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (!message.id && message.method) { this.events.push(message); return; }
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
    async evaluate(expression, { userGesture = false } = {}) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

const DIALOGS = `
  window.__dialogs = [];
  window.confirm = message => { window.__dialogs.push(['confirm', String(message)]); return true; };
  window.alert = message => { window.__dialogs.push(['alert', String(message)]); };
  window.prompt = message => { window.__dialogs.push(['prompt', String(message)]); return ''; };
`;

async function waitFor(client, expression, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        try { last = await client.evaluate(expression); if (last) return last; } catch (_) {}
        await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${expression.slice(0, 160)}; last=${JSON.stringify(last)}`);
}

const { server, port } = await startServer();
const debugPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-journeys-'));
const browser = childProcess.spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900',
    '--disable-background-networking', '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=*',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserErrors = '';
browser.stderr.on('data', chunk => { browserErrors += String(chunk); });
const clients = [];

async function openPage(url) {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    const client = new Cdp(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: DIALOGS });
    await client.send('Page.navigate', { url });
    client.targetId = target.id;
    clients.push(client);
    await waitFor(client, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 20000);
    await sleep(600);
    return client;
}

async function closePage(client) {
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${client.targetId}`);
    client.close();
}

const helpers = base => ({
    state: `import('${base}/src/js/recorder.js').then(m => ({ recId: m.AppState.recId, busy: m.AppState.busy }))`,
    rows: `(async () => {
        const { dbExec } = await import('${base}/src/js/db.js');
        const { CONFIG } = await import('${base}/src/js/config.js');
        return (await dbExec(CONFIG.STORE_REC, 'getAll')).map(r => ({
            id: r.id, processing: !!r.processing, format: r.format, audioBytes: Number(r.audioBytes) || 0,
            audioDeletedAt: r.audioDeletedAt || null, context: (r.contextChain || []).map(item => item.label),
            transcripts: (r.transcripts || []).length
        }));
    })()`,
    audio: `(async () => {
        const { CONFIG } = await import('${base}/src/js/config.js');
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const rows = await new Promise((resolve, reject) => {
            const request = db.transaction(CONFIG.STORE_AUDIO).objectStore(CONFIG.STORE_AUDIO).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return rows.map(row => ({ recId: row.recId, size: row.blob ? row.blob.size : 0, type: row.blob ? row.blob.type : '' }));
    })()`,
    alert: `(() => { const n = document.getElementById('storage-alert'); return n.hidden ? '' : n.textContent; })()`,
    guard: `import('${base}/src/js/db.js').then(m => m.databaseGuardState())`
});
const here = helpers('');
const nextBuild = helpers(NEXT_SCHEMA_BUILD_PREFIX);

async function record(client, seconds, { format = 'opus', stop = true } = {}) {
    await client.evaluate(`localStorage.setItem('set-recording-format', '${format}'); true`);
    await client.evaluate(`document.getElementById('recordBtn').click(); true`, { userGesture: true });
    await waitFor(client, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const { recId } = await client.evaluate(here.state);
    await sleep(seconds * 1000);
    if (stop) await stopRecording(client, recId);
    return recId;
}

const KEY_CODES = { Tab: 9, Enter: 13, Escape: 27, ' ': 32 };
async function pressKey(client, key, { shift = false } = {}) {
    const code = KEY_CODES[key];
    const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
                   modifiers: shift ? 8 : 0 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    if (key === ' ') await client.send('Input.dispatchKeyEvent', { type: 'char', text: ' ', ...base });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(120);
}

async function stopRecording(client, recId) {
    await client.evaluate(`document.getElementById('recordBtn').click(); true`, { userGesture: true });
    await waitFor(client,
        `${here.rows}.then(rows => rows.some(r => r.id === ${recId} && !r.processing && r.audioBytes > 0))`, 30000);
    await waitFor(client, `${here.state}.then(s => s.recId == null && !s.busy)`, 20000);
}

try {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch (_) {}
        await sleep(100);
    }
    const origin = `http://127.0.0.1:${port}`;
    const app = await openPage(`${origin}/index.html`);

    journey('The storage counter counts each recording once');
    const first = await record(app, 3);
    const counted = await app.evaluate(`(async () => {
        const db = await import('/src/js/db.js');
        await db.calcTotalStorage();
        const audio = await ${here.audio};
        return { total: db.getStorageTotal(), stored: audio.reduce((sum, row) => sum + row.size, 0),
                 label: document.querySelector('#rec-${first} .rec-storage-label')?.textContent || '' };
    })()`);
    ok(counted.stored > 0 && counted.total === counted.stored,
       `the storage counter equals the audio actually stored (${counted.total} vs ${counted.stored})`);
    ok(/100%/.test(counted.label), `and the only recording is shown as all of it (${counted.label})`);

    journey('The retention countdown sits on the size bar\'s row, at its right end, down to a 360 px phone');
    const rowLayout = [];
    for (const [width, mobile] of [[0, false], [390, true], [360, true]]) {
        if (width) await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile });
        rowLayout.push(await app.evaluate(`(async () => {
            const { dbUpdate } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
            await dbUpdate(CONFIG.STORE_REC, ${first}, rec => {
                rec.transcripts = rec.transcripts && rec.transcripts.length ? rec.transcripts
                    : [{ id: 'row1', text: 'row layout', plain: 'row layout', source: 'S', time: Date.now() }];
                return rec;
            });
            const gui = await import('/src/js/gui.js');
            await gui.renderList({ force: true });
            const row = document.getElementById('rec-${first}');
            const bar = row.querySelector('.rec-meta .rec-storage'), expiry = row.querySelector('.rec-meta .rec-expiry');
            if (!bar || !expiry) return { missing: true };
            const b = bar.getBoundingClientRect(), e = expiry.getBoundingClientRect(), m = bar.parentNode.getBoundingClientRect();
            return { width: innerWidth, text: expiry.textContent,
                     sameRow: Math.abs((b.top + b.bottom) / 2 - (e.top + e.bottom) / 2) < 3,
                     atRightEnd: Math.abs(m.right - e.right) < 2, afterLabel: e.left >= b.left + 40 };
        })()`));
    }
    await app.send('Emulation.clearDeviceMetricsOverride');
    for (const layout of rowLayout) {
        ok(!layout.missing && /audio/.test(layout.text) && /text/.test(layout.text),
           `the row holds the size bar and both countdowns (${JSON.stringify(layout)})`);
        ok(layout.sameRow && layout.atRightEnd && layout.afterLabel,
           `at ${layout.width} px the countdown shares the bar's row, at its right end (${JSON.stringify(layout)})`);
    }
    await app.evaluate(`(async () => {
        const { dbUpdate } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        await dbUpdate(CONFIG.STORE_REC, ${first}, rec => { rec.transcripts = (rec.transcripts || []).filter(t => t.id !== 'row1'); return rec; });
        const gui = await import('/src/js/gui.js'); await gui.renderList({ force: true });
        return true;
    })()`);

    journey('📌 left of the format pins a recording and freezes its countdown, and a second tap lets it run on');
    const pinLayout = [];
    for (const [width, mobile] of [[0, false], [360, true]]) {
        if (width) await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile });
        pinLayout.push(await app.evaluate(`(async () => {
            const gui = await import('/src/js/gui.js');
            await gui.renderList({ force: true });
            const row = document.getElementById('rec-${first}');
            const pin = row.querySelector('.rec-top .pin-btn'), badge = row.querySelector('.rec-top .fmt-badge');
            if (!pin || !badge) return { missing: true };
            const p = pin.getBoundingClientRect(), b = badge.getBoundingClientRect(), r = row.getBoundingClientRect();
            return { width: innerWidth, leftOfBadge: p.right <= b.left + 0.5 && b.left - p.right < 12,
                     sameRow: Math.abs((p.top + p.bottom) / 2 - (b.top + b.bottom) / 2) < 3,
                     sameHeight: Math.abs(p.height - b.height) < 3, inside: p.left >= r.left && b.right <= r.right };
        })()`));
    }
    await app.send('Emulation.clearDeviceMetricsOverride');
    for (const layout of pinLayout) {
        ok(!layout.missing && layout.leftOfBadge && layout.sameRow && layout.sameHeight && layout.inside,
           `at ${layout.width} px 📌 sits just left of the format badge, on its row and as tall (${JSON.stringify(layout)})`);
    }
    const pinState = `(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${first});
        const row = document.getElementById('rec-${first}');
        const pin = row && row.querySelector('.pin-btn'), expiry = row && row.querySelector('.rec-expiry');
        return { stored: !!(rec && rec.pinnedAt > 0), pressed: pin ? pin.getAttribute('aria-pressed') : null,
                 frozen: !!(expiry && expiry.classList.contains('frozen')), countdown: expiry ? expiry.textContent : '' };
    })()`;
    await app.evaluate(`document.querySelector('#rec-${first} .pin-btn').click(); true`, { userGesture: true });
    const pinnedNow = await waitFor(app, `${pinState}.then(s => s.stored && s.pressed === 'true' ? s : null)`, 5000).catch(() => null);
    ok(pinnedNow && pinnedNow.frozen && /❄️ audio/.test(pinnedNow.countdown) && !/⏳/.test(pinnedNow.countdown),
       `a tap on 📌 pins the recording and freezes its countdown (${JSON.stringify(pinnedNow)})`);
    await app.evaluate(`document.querySelector('#rec-${first} .pin-btn').click(); true`, { userGesture: true });
    const unpinned = await waitFor(app, `${pinState}.then(s => !s.stored && s.pressed === 'false' ? s : null)`, 5000).catch(() => null);
    ok(unpinned && !unpinned.frozen && /⏳ audio/.test(unpinned.countdown),
       `a second tap unpins it and its countdown runs again (${JSON.stringify(unpinned)})`);

    journey('A conversion that outlives its recording leaves nothing behind');
    const doomed = await record(app, 3, { format: 'wav' });
    await app.evaluate(`localStorage.setItem('set-recording-format', 'opus'); true`);
    await app.evaluate(`window.__conversion = window.convertRecFormat(${doomed}); true`);
    await sleep(900);
    await app.evaluate(`window.deleteRec(${doomed}).then(() => true)`);
    await app.evaluate('window.__conversion.then(() => true)');
    const afterDelete = await app.evaluate(here.audio);
    ok(!afterDelete.some(row => row.recId === doomed),
       'a recording deleted while it was being converted stays deleted, with no audio left behind for it');

    const kept = await record(app, 3, { format: 'wav' });
    await app.evaluate(`localStorage.setItem('set-recording-format', 'opus'); true`);
    await app.evaluate(`window.__conversion = window.convertRecFormat(${kept}); true`);
    await sleep(900);
    await app.evaluate(`window.deleteRecAudio(${kept}).then(() => true)`);
    await app.evaluate('window.__conversion.then(() => true)');
    const keptRow = (await app.evaluate(here.rows)).find(row => row.id === kept);
    ok(keptRow && keptRow.audioDeletedAt && keptRow.audioBytes === 0
       && !(await app.evaluate(here.audio)).some(row => row.recId === kept),
       'audio deleted during its conversion is not quietly written back by the conversion');

    const converted = await record(app, 3, { format: 'wav' });
    await app.evaluate(`localStorage.setItem('set-recording-format', 'opus'); true`);
    await app.evaluate(`window.convertRecFormat(${converted}).then(() => true)`);
    const convertedRow = (await app.evaluate(here.rows)).find(row => row.id === converted);
    const convertedAudio = (await app.evaluate(here.audio)).find(row => row.recId === converted);
    ok(convertedRow && convertedRow.format === 'opus' && convertedAudio && /webm|ogg/.test(convertedAudio.type)
       && convertedRow.audioBytes === convertedAudio.size,
       'a conversion nobody interrupted still replaces the audio and its recorded size together');

    journey('Audio with no recording that owns it is swept on start');
    await app.evaluate(`(async () => {
        const { writeAudio } = await import('/src/js/db.js');
        await writeAudio(987654, new Blob([new Uint8Array(4096)], { type: 'audio/webm' }));
        return true;
    })()`);
    await app.send('Page.reload');
    await waitFor(app, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 20000);
    await waitFor(app, `${here.audio}.then(rows => !rows.some(row => row.recId === 987654))`, 15000);
    ok(true, 'audio left behind with no recording to own it is removed when the app starts');

    journey('Deletions a closed tab left half done are finished when the app starts');
    const halfDeleted = await app.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import('/src/js/db.js');
        const audio = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
        const noted = await dbExec('recordings', 'add', { timestamp: Date.now(), durationMs: 1000, format: 'opus',
            captureState: 'ready', processing: false, deleting: true, audioBytes: audio.size, transcripts: [], summaries: [] });
        await writeAudio(noted, audio);
        const seen = await dbExec('recordings', 'add', { timestamp: Date.now() + 1, durationMs: 1000, format: 'opus',
            captureState: 'ready', processing: false, deleting: true, audioBytes: audio.size, transcripts: [], summaries: [] });
        await writeAudio(seen, audio);
        localStorage.setItem('myai-deletions-in-progress-v1', JSON.stringify([noted]));
        return [noted, seen];
    })()`);
    await app.send('Page.reload');
    await waitFor(app, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 20000);
    await waitFor(app, `import('/src/js/db.js').then(async db => {
        const rows = await Promise.all(${JSON.stringify(halfDeleted)}.map(id => db.dbExec('recordings', 'get', id)));
        const audio = await Promise.all(${JSON.stringify(halfDeleted)}.map(id => db.readAudio(id)));
        return rows.every(row => !row) && audio.every(blob => !blob);
    })`, 15000);
    const noteLeft = await app.evaluate(`localStorage.getItem('myai-deletions-in-progress-v1')`);
    ok(noteLeft === '[]',
       `a recording noted as being deleted, and one only seen in the list marked so, are both finished with their audio when the app starts, and the note is cleared (${noteLeft})`);

    journey('A deletion another tab leaves half done while this one is open is finished by the recovery sweep');
    const leftBehind = await app.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import('/src/js/db.js');
        const audio = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
        const id = await dbExec('recordings', 'add', { timestamp: Date.now(), durationMs: 1000, format: 'opus',
            captureState: 'ready', processing: false, deleting: true, audioBytes: audio.size, transcripts: [], summaries: [] });
        await writeAudio(id, audio);
        localStorage.setItem('myai-deletions-in-progress-v1', JSON.stringify([id]));
        window.__dialogs.length = 0;
        await window.recoverNowRec();
        return id;
    })()`);
    const sweptAway = await app.evaluate(`import('/src/js/db.js').then(async db =>
        !(await db.dbExec('recordings', 'get', ${leftBehind})) && !(await db.readAudio(${leftBehind}))
        && localStorage.getItem('myai-deletions-in-progress-v1') === '[]')`);
    ok(sweptAway, 'the sweep that recovers recordings of closed tabs also finishes a deletion noted after this tab started, audio and note included');

    journey('Continue during a recording is refused instead of leaking into the next recording');
    await app.evaluate(`(async () => {
        const { dbUpdate } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        await dbUpdate(CONFIG.STORE_REC, ${first}, r => {
            r.transcripts = [{ id: 1, text: 'buy milk', plain: 'buy milk', source: 'S', time: Date.now() }];
            return r;
        });
        return true;
    })()`);
    const during = await record(app, 1.5, { stop: false });
    await app.evaluate(`import('/src/js/gui.js').then(gui => gui.renderList({ force: true })).then(() => true)`);
    const button = await app.evaluate(`(() => {
        const b = document.getElementById('btn-continue-${first}');
        return { exists: !!b, disabled: !!(b && b.disabled) };
    })()`);
    ok(button.exists && button.disabled, 'the 💬 Continue button is disabled while a recording is running');
    await app.evaluate(`window.__dialogs.length = 0; window.continueConv(${first}).then(() => true)`);
    const pending = await app.evaluate(`import('/src/js/recorder.js').then(m => m.AppState.pendingContext)`);
    const toldWhy = await app.evaluate(`window.__dialogs.some(([kind, text]) => kind === 'alert' && /Stop the current one first/.test(text))`);
    ok(pending == null && toldWhy, 'and invoking it anyway says why instead of silently storing context');
    await stopRecording(app, during);
    const later = await record(app, 1.5);
    const laterRow = (await app.evaluate(here.rows)).find(row => row.id === later);
    ok(laterRow && laterRow.context.length === 0,
       'so the next, unrelated recording carries no context it was never given');

    journey('A recording that fails to start does not keep the context it was given');
    await app.evaluate(`(async () => {
        window.__realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
        await window.continueConv(${first});
        for (let i = 0; i < 100; i++) {
            const m = await import('/src/js/recorder.js');
            if (m.AppState.recId == null && !m.AppState.busy) break;
            await new Promise(r => setTimeout(r, 50));
        }
        navigator.mediaDevices.getUserMedia = window.__realGetUserMedia;
        return true;
    })()`);
    const leftover = await app.evaluate(`import('/src/js/recorder.js').then(m => m.AppState.pendingContext)`);
    ok(leftover == null, 'a recording that could not start keeps no leftover context');
    const afterFailure = await record(app, 1.5);
    ok(((await app.evaluate(here.rows)).find(row => row.id === afterFailure) || {}).context?.length === 0,
       'so the next plain recording starts clean');

    journey('The buttons beside Start Recording follow the recording without polling');
    const buttonsDuring = await (async () => {
        await app.evaluate(`document.getElementById('recordBtn').click(); true`, { userGesture: true });
        await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
        const seen = await app.evaluate(`({ paste: document.getElementById('pasteRecordBtn').hidden,
                                            pasteTitle: document.getElementById('pasteRecordBtn').title,
                                            live: document.getElementById('liveScribeBtn').hidden })`);
        const { recId } = await app.evaluate(here.state);
        await stopRecording(app, recId);
        const after = await app.evaluate(`({ paste: document.getElementById('pasteRecordBtn').hidden,
                                             pasteTitle: document.getElementById('pasteRecordBtn').title,
                                             live: document.getElementById('liveScribeBtn').hidden })`);
        return { seen, after };
    })();
    ok(buttonsDuring.seen.paste === false && buttonsDuring.seen.live === false
       && buttonsDuring.after.paste === false && buttonsDuring.after.live === false,
       'both side buttons stay beside Start Recording before, during and after a recording');
    ok(/Add what is on the clipboard to this recording/.test(buttonsDuring.seen.pasteTitle)
       && /Start a recording/.test(buttonsDuring.after.pasteTitle),
       'and 📋 says what it will do the moment a recording starts and stops');

    journey('On a phone-width screen the three buttons stay on one line during a recording, '
        + 'with the timer in the live row instead of in the big button');
    await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 1, mobile: true });
    await app.evaluate(`document.getElementById('recordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    await sleep(2500);
    const phone = await app.evaluate(`(() => {
        const box = id => document.getElementById(id).getBoundingClientRect();
        const [left, big, right] = ['pasteRecordBtn', 'recordBtn', 'liveScribeBtn'].map(box);
        const live = document.querySelector('.rec-item-live');
        return {
            oneRow: Math.abs((left.top + left.bottom) / 2 - (right.top + right.bottom) / 2) < 2
                    && left.right <= big.left && big.right <= right.left && right.right <= innerWidth,
            label: document.getElementById('recordBtn').textContent,
            title: live ? live.querySelector('.rec-filename').textContent : '',
            clock: live ? live.querySelector('.live-rec-clock').textContent : ''
        };
    })()`);
    const phoneRec = (await app.evaluate(here.state)).recId;
    await stopRecording(app, phoneRec);
    await app.send('Emulation.clearDeviceMetricsOverride');
    ok(phone.oneRow, 'on a 360px phone 📋, Stop Recording and 📝 stay on one line during a recording');
    ok(phone.label === 'Stop Recording', `the big button carries no timer (${phone.label})`);
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(phone.title) && /^\d{2}:\d{2}$/.test(phone.clock) && phone.clock !== '00:00',
       `the live row shows just the date and time as its title, and the running time beside it (${phone.title} | ${phone.clock})`);

    journey('When the clipboard cannot be read, a box takes 100,000 characters with line breaks intact');
    const hundredK = 'line of pasted text\n'.repeat(5000).slice(0, 100000);
    await app.evaluate(`window.__realReadText = navigator.clipboard.readText;
        navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); true`);
    await app.evaluate(`document.getElementById('pasteRecordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `document.getElementById('pasteOverlay').classList.contains('open')`, 5000);
    await app.evaluate(`document.getElementById('pasteCancel').click(); true`);
    await sleep(500);
    const cancelled = await app.evaluate(`import('/src/js/recorder.js').then(m => ({ recId: m.AppState.recId,
        open: document.getElementById('pasteOverlay').classList.contains('open'), alerts: window.__dialogs.filter(d => d[0] === 'alert').length }))`);
    ok(cancelled.recId == null && !cancelled.open, 'cancelling the paste box starts nothing');
    await app.evaluate(`document.getElementById('pasteRecordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `document.getElementById('pasteOverlay').classList.contains('open')`, 5000);
    const boxCount = await app.evaluate(`(() => {
        const box = document.getElementById('pasteText');
        box.value = ${JSON.stringify(hundredK)};
        box.dispatchEvent(new Event('input'));
        return { value: box.value.length, count: document.getElementById('pasteCount').textContent };
    })()`);
    ok(boxCount.value === 100000 && /100,000 characters/.test(boxCount.count),
       `the paste box holds 100,000 characters and says so (${boxCount.count})`);
    await app.evaluate(`document.getElementById('pasteUse').click(); true`);
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const boxRec = (await app.evaluate(here.state)).recId;
    await sleep(800);
    await app.evaluate(`navigator.clipboard.readText = window.__realReadText; true`);
    await stopRecording(app, boxRec);
    const boxItem = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const item = ((await dbExec(CONFIG.STORE_REC, 'get', ${boxRec})).contextChain || [])[0] || {};
        return { length: (item.inputText || '').length, lines: (item.inputText || '').split(String.fromCharCode(10)).length, label: item.label || '' };
    })()`);
    ok(boxItem.length === 100000 - 1 && boxItem.lines === 5000 && !/first/.test(boxItem.label),
       `the recording keeps the whole pasted text with its line breaks (${boxItem.length} chars, ${boxItem.lines} lines)`);

    journey('During a recording, 📋 adds the clipboard to that recording instead of disappearing');
    await app.evaluate(`window.__realReadText = navigator.clipboard.readText; navigator.clipboard.readText = () => Promise.resolve('first note from the clipboard'); true`);
    await app.evaluate(`document.getElementById('pasteRecordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const pastedRec = (await app.evaluate(here.state)).recId;
    await sleep(800);
    await app.evaluate(`navigator.clipboard.readText = () => Promise.resolve('second note, found halfway through'); true`);
    await app.evaluate(`document.getElementById('pasteRecordBtn').click(); true`, { userGesture: true });
    const midMark = await waitFor(app,
        `(() => { const t = document.getElementById('pasteRecordBtn').textContent; return t !== '📋' ? t : ''; })()`, 5000);
    const midRecording = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const m = await import('/src/js/recorder.js');
        const row = await dbExec(CONFIG.STORE_REC, 'get', ${pastedRec});
        return { recId: m.AppState.recId, texts: (row.contextChain || []).map(i => i.inputText),
                 line: document.getElementById('live-context-${pastedRec}')?.textContent || '' };
    })()`);
    ok(midMark === '✓' && midRecording.recId === pastedRec
       && midRecording.texts.join('|') === 'first note from the clipboard|second note, found halfway through',
       'tapping 📋 during a recording adds the clipboard to that recording, without starting another one');
    ok(/2 context items/.test(midRecording.line), `and the live row says how many items the recording now carries (${midRecording.line})`);
    await app.evaluate(`navigator.clipboard.readText = window.__realReadText; true`);
    await stopRecording(app, pastedRec);
    const keptContext = (await app.evaluate(here.rows)).find(row => row.id === pastedRec);
    ok(keptContext && keptContext.context.length === 2, 'both items are still on the recording once it is saved, ready for the AI reply');

    journey('📝 beside Start Recording starts a recording with live transcription on, whatever the setting says');
    await app.evaluate(`localStorage.setItem('set-live-transcribe', 'off'); true`);
    await app.evaluate(`document.getElementById('liveScribeBtn').click(); true`, { userGesture: true });
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const liveStart = await app.evaluate(`(async () => {
        const scribe = await import('/src/js/live-scribe.js');
        const btn = document.getElementById('liveScribeBtn');
        return { active: scribe.isLiveScribeActive(), pressed: btn.getAttribute('aria-pressed'),
                 paste: document.getElementById('pasteRecordBtn').hidden };
    })()`);
    ok(liveStart.active && liveStart.pressed === 'true' && liveStart.paste === false,
       'tapping 📝 while idle starts a recording with live transcription already running');
    const liveId = (await app.evaluate(here.state)).recId;
    await sleep(1000);
    await stopRecording(app, liveId);
    const idleLive = await app.evaluate(`({ hidden: document.getElementById('liveScribeBtn').hidden,
        pressed: document.getElementById('liveScribeBtn').getAttribute('aria-pressed') })`);
    ok(!idleLive.hidden && idleLive.pressed === null,
       'afterwards 📝 is back beside Start Recording, offering a new live recording rather than showing a stale on/off state');
    await app.evaluate(`document.getElementById('recordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const plainAfterLive = await app.evaluate(`import('/src/js/live-scribe.js').then(m => m.isLiveScribeActive())`);
    const plainId = (await app.evaluate(here.state)).recId;
    await sleep(1000);
    await stopRecording(app, plainId);
    ok(plainAfterLive === false,
       'and the big button still starts a plain recording that follows the setting, instead of inheriting the last one');

    journey('Live translation on a model that is already loaded: no reload is charged to a translated line, '
        + 'and nothing about translation speed is written into the transcript');
    ollama.on = true;
    await app.evaluate(`localStorage.setItem('set-translate-panels', '2');
        localStorage.setItem('set-ollama-model', '${ollama.model}'); true`);
    await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 1, mobile: true });
    const liveBoxes = await app.evaluate(`(async () => {
        const scribe = await import('/src/js/live-scribe.js');
        const { forgetModelChoices } = await import('/src/js/reply.js');
        forgetModelChoices();
        const rate = 16000;
        scribe.startLiveScribe(424242, rate, 0);
        const chunk = new Float32Array(rate * 4);
        for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 9) * 0.3;
        const text = () => document.getElementById('live-scribe-text');
        const translatedCount = () => [...text().querySelectorAll('.ls-panel .ls-translated .ls-body')]
            .filter(node => /^NL /.test(node.textContent)).length;
        window.__lt = {
            scribe, rate, text, translatedCount,
            speak: async count => {
                for (let k = 0; k < count; k++) {
                    scribe.pushLivePcm(chunk, rate);
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            },
            waitForTranslations: async atLeast => {
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline && translatedCount() < atLeast) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        };
        await window.__lt.speak(14);
        await window.__lt.waitForTranslations(3);
        return {
            panels: [...text().querySelectorAll('.ls-panel')].map(panel => ({
                lang: panel.dataset.lang,
                heading: panel.querySelector('.ls-panel-head').textContent,
                translated: [...panel.querySelectorAll('.ls-translated .ls-body')].map(node => node.textContent)
            })),
            system: [...text().querySelectorAll('.ls-system')].map(node => node.textContent),
            all: text().textContent
        };
    })()`);
    const requestsBeforeBoxes = ollama.liveCounter;
    await app.evaluate(`(async () => {
        await window.__lt.speak(9);
        await new Promise(resolve => setTimeout(resolve, 1200));
        return true;
    })()`);
    const requestsWithBoxes = ollama.liveCounter - requestsBeforeBoxes;
    const liveRest = await app.evaluate(`(async () => {
        const { scribe, rate, speak, waitForTranslations, translatedCount } = window.__lt;
        document.getElementById('live-scribe-speakers').textContent =
            '🗣️ 3 groups · 812 samples · closest 0.83 · 41% (need 60%) · 👂 Anna 45% → Speaker 2 · 👤';
        document.getElementById('live-scribe-status').textContent = '📡 reconnecting… server behind - 8s skipped';
        const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top }; };
        const head = {
            viewport: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
            copy: box(document.getElementById('live-scribe-copy')),
            close: box(document.querySelector('.live-scribe-close')),
            status: box(document.getElementById('live-scribe-status'))
        };

        const before = scribe.liveScribeResult().lines.length;
        scribe.pauseLiveScribe();
        scribe.startLiveScribe(424242, rate, 60);
        await speak(10);
        await waitForTranslations(translatedCount() + 3);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const saved = scribe.liveScribeResult();
        const copied = scribe.liveScribeTranscriptText();
        scribe.stopLiveScribe({ keepText: false });
        delete window.__lt;
        return { head, before, saved, copied };
    })()`);
    const liveTranslation = { ...liveBoxes, ...liveRest };
    await app.send('Emulation.clearDeviceMetricsOverride');
    ollama.on = false;
    await app.evaluate(`localStorage.removeItem('set-translate-panels'); localStorage.removeItem('set-ollama-model'); true`);
    const translated = liveTranslation.panels.flatMap(panel => panel.translated).filter(line => /^NL /.test(line));
    ok(liveTranslation.panels.length === 2 && translated.length >= 3,
       `two languages give two boxes and the lines are translated (${JSON.stringify(liveTranslation.panels.map(p => p.heading))}, ${translated.length} translated)`);
    const texts = ollama.requests.filter(request => !request.empty);
    ok(texts.length >= 1 && texts.every(request => !request.reloaded),
       `no translation made the server reload the model (${JSON.stringify(ollama.requests)})`);
    ok(new Set(ollama.requests.map(request => request.numCtx)).size === 1,
       `every request asked for the same context, so the AI model is loaded once for replies and translation alike (${[...new Set(ollama.requests.map(request => request.numCtx))]})`);
    ok(ollama.requests.length > 0 && ollama.requests[0].empty,
       'the model is warmed with that context when live translation starts, before the first line needs it');
    ok(liveTranslation.system.length === 0 && !/per line|GPU|AI model/.test(liveTranslation.all),
       `nothing about translation speed or the AI model is written into the transcript (${JSON.stringify(liveTranslation.system)})`);

    ok(requestsWithBoxes <= 10,
       `with translation boxes on, the transcription server gets a request per window and no previews the boxes would never show (${requestsWithBoxes} requests for 9 windows)`);
    const head = liveTranslation.head;
    ok(head.copy.right <= head.viewport && head.close.right <= head.viewport && head.close.width > 0,
       `on a 360px phone the live panel keeps 📋 and ✕ on screen, however long the speaker line gets (${JSON.stringify(head)})`);
    ok(head.status.width > 100 && head.scroll <= head.viewport,
       'and the connection status gets a line of its own instead of being squeezed to nothing');

    const savedLines = liveTranslation.saved.lines;
    const after = savedLines.length - liveTranslation.before;
    const mismatched = savedLines.flatMap(line => Object.values(line.translations || {})
        .filter(translation => translation !== `NL ${line.text.replace(/\s+/g, ' ').trim()}`)
        .map(translation => `${line.text} => ${translation}`));
    ok(after > 0 && savedLines.some(line => Object.keys(line.translations || {}).length),
       `hiding and showing live transcription keeps transcribing and translating (${after} new lines)`);
    ok(mismatched.length === 0,
       `and every line keeps its own translation: none is shown with the translation of another line (${mismatched.slice(0, 3).join(' | ')})`);
    ok(!/Not recording|per line/.test(liveTranslation.copied)
       && liveTranslation.copied.split('\n').filter(line => /^\[\d\d:\d\d\] /.test(line)).length >= savedLines.length,
       'the copied transcript holds every saved line');

    journey('Turning on 📝 halfway through an Opus recording does not shorten the saved recording');
    await app.evaluate(`localStorage.setItem('set-live-transcribe', 'off'); true`);
    const tappedId = await record(app, 3, { format: 'opus', stop: false });
    await app.evaluate(`document.getElementById('liveScribeBtn').click(); true`, { userGesture: true });
    await waitFor(app, `import('/src/js/live-scribe.js').then(m => m.isLiveScribeActive())`, 10000);
    await sleep(2500);
    await stopRecording(app, tappedId);
    const tapped = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${tappedId});
        return { durationMs: rec.durationMs, format: rec.format, filename: rec.filename };
    })()`);
    ok(tapped.format === 'opus' && tapped.durationMs >= 5000,
       `an Opus recording with 📝 turned on after 3 seconds is saved with its whole length (${JSON.stringify(tapped)})`);

    journey('With the live panel open on a phone, the waveform shrinks to a strip instead of covering the live row');
    await app.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 850, deviceScaleFactor: 1, mobile: true });
    await app.evaluate(`document.getElementById('liveScribeBtn').click(); true`, { userGesture: true });
    await waitFor(app, `${here.state}.then(s => s.recId != null && !s.busy)`, 20000);
    const stripRec = (await app.evaluate(here.state)).recId;
    await sleep(1500);
    const strip = await app.evaluate(`(() => {
        const canvas = document.getElementById('visualizer');
        const clock = document.querySelector('#rec-${stripRec} .live-rec-clock');
        const box = clock ? clock.getBoundingClientRect() : null;
        const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
        return { panel: document.body.classList.contains('live-scribe-on'),
                 canvasHeight: canvas.getBoundingClientRect().height,
                 clockReachable: !!hit && !!hit.closest && !!hit.closest('#rec-${stripRec}') };
    })()`);
    await stopRecording(app, stripRec);
    await app.send('Emulation.clearDeviceMetricsOverride');
    ok(strip.panel && strip.canvasHeight <= 60 && strip.clockReachable,
       `with the live panel open on a phone the waveform is a thin strip and the live row can be seen and tapped (${JSON.stringify(strip)})`);

    journey('The waveform frame rate is a setting: 10 frames a second draws about ten and sleeps in between, '
        + 'off hides the waveform and draws nothing, and a change applies to the recording in progress');
    await app.evaluate(`(() => {
        const proto = CanvasRenderingContext2D.prototype;
        if (!proto.__strokesCounted) {
            const realStroke = proto.stroke;
            proto.stroke = function (...args) { window.__strokes = (window.__strokes || 0) + 1; return realStroke.apply(this, args); };
            proto.__strokesCounted = true;
            const realFrame = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = callback => realFrame(at => { window.__frames = (window.__frames || 0) + 1; callback(at); });
        }
        localStorage.setItem('set-waveform-fps', '10');
        return true;
    })()`);
    const waveRec = await record(app, 0, { stop: false });
    const waveSample = () => app.evaluate(`(async () => {
        window.__strokes = 0;
        window.__frames = 0;
        await new Promise(resolve => setTimeout(resolve, 2000));
        return { strokes: window.__strokes, frames: window.__frames,
                 shown: getComputedStyle(document.getElementById('visualizer')).display !== 'none',
                 bar: document.getElementById('footer').classList.contains('recording') };
    })()`);
    const chooseWaveRate = fps => app.evaluate(`(() => {
        const select = document.getElementById('set-waveform-fps');
        select.value = String(${fps});
        select.dispatchEvent(new Event('change'));
        return true;
    })()`);
    const at10 = await waveSample();
    await chooseWaveRate(0);
    const waveOff = await waveSample();
    await chooseWaveRate(30);
    const at30 = await waveSample();
    await chooseWaveRate("'auto'");
    const atAuto = await waveSample();
    const autoLabel = await app.evaluate(`(async () => {
        document.getElementById('settingsBtn').click();
        await new Promise(resolve => setTimeout(resolve, 1200));
        const label = document.querySelector('#set-waveform-fps option[value="auto"]').textContent;
        document.getElementById('settingsX').click();
        return label;
    })()`, { userGesture: true });
    const enteredFullscreen = await app.evaluate(`(() => {
        const root = document.documentElement;
        root.requestFullscreen = undefined;
        root.webkitRequestFullscreen = undefined;
        const canvas = document.getElementById('visualizer');
        canvas.click();
        return canvas.classList.contains('fullscreen') && document.body.classList.contains('viz-fullscreen');
    })()`, { userGesture: true });
    await stopRecording(app, waveRec);
    const afterFullscreenStop = await app.evaluate(`(() => {
        delete document.documentElement.requestFullscreen;
        delete document.documentElement.webkitRequestFullscreen;
        return { canvas: document.getElementById('visualizer').classList.contains('fullscreen'),
                 body: document.body.classList.contains('viz-fullscreen'),
                 gear: document.getElementById('settingsBtn').style.display,
                 overflow: getComputedStyle(document.documentElement).overflowY };
    })()`);
    await app.evaluate(`localStorage.removeItem('set-waveform-fps'); true`);
    ok(at10.shown && at10.strokes >= 12 && at10.strokes <= 28,
       `at 10 frames a second the waveform is drawn about ten times a second (${at10.strokes} in 2 seconds)`);
    ok(at10.frames <= 40,
       `and the page sleeps between those frames instead of waking on every display frame (${at10.frames} animation frames in 2 seconds)`);
    ok(!waveOff.shown && !waveOff.bar && waveOff.strokes === 0 && waveOff.frames <= 2,
       `turning the waveform off during a recording hides it and its bar and stops drawing (${JSON.stringify(waveOff)})`);
    ok(at30.shown && at30.bar && at30.strokes >= at10.strokes * 1.5,
       `and choosing 30 brings it back at once, drawing faster than at 10 (${at30.strokes} in 2 seconds)`);
    ok(atAuto.shown && atAuto.strokes >= at30.strokes * 1.5 && atAuto.strokes >= atAuto.frames * 0.8,
       `Auto draws on every refresh of the screen (${atAuto.strokes} frames drawn of ${atAuto.frames} refreshes in 2 seconds)`);
    ok(/\(\d+ Hz\)$/.test(autoLabel), `and Settings names the refresh rate it measured (${autoLabel})`);
    ok(enteredFullscreen && !afterFullscreenStop.canvas && !afterFullscreenStop.body
       && afterFullscreenStop.gear !== 'none' && afterFullscreenStop.overflow !== 'hidden',
       `stopping a recording whose waveform is fullscreen leaves fullscreen, with ⚙️ back and the list scrollable (${JSON.stringify(afterFullscreenStop)})`);

    journey('The three-second heartbeat writes a small beat instead of rewriting the whole recording, '
        + 'even when the recording carries a large pasted context item');
    const beatRec = await record(app, 4, { format: 'opus', stop: false });
    const beatCounts = await app.evaluate(`(async () => {
        const recorder = await import('/src/js/recorder.js');
        const db = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const { isRecordOwnedByLiveTab } = await import('/src/js/recording-lock.js');
        await recorder.addContextToRecording(${beatRec}, {
            inputText: 'lorem ipsum dolor sit amet '.repeat(3700), outputText: '',
            text: '[Pasted Note]: ' + 'lorem ipsum dolor sit amet '.repeat(3700), label: 'Pasted: journey', pasted: true
        });
        const puts = {};
        const realPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            puts[this.name] = (puts[this.name] || 0) + 1;
            return realPut.apply(this, args);
        };
        try { await new Promise(resolve => setTimeout(resolve, 9500)); }
        finally { IDBObjectStore.prototype.put = realPut; }
        const row = await db.dbExec(CONFIG.STORE_REC, 'get', ${beatRec});
        const beat = (await db.readCaptureBeats()).get(${beatRec});
        const now = Date.now();
        return {
            puts, rowAge: now - row.heartbeatAt, beatAge: beat ? now - beat.heartbeatAt : null,
            live: isRecordOwnedByLiveTab(row, now, beat),
            fps: getComputedStyle(document.getElementById('fpsDisplay')).display
        };
    })()`);
    journey('An Opus recording whose tab closed mid-recording is finished by recovery from the pieces it had saved');
    const copyPiecesIntoAbandonedRecording = `(async () => {
        const db = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const pieces = (await db.getAudioFragmentsForRecording(${beatRec})).sort((a, b) => a.seq - b.seq);
        const now = Date.now();
        const id = await db.dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'opus ghost', timestamp: now - 60000, durationMs: 3000, processing: true,
            captureState: 'recording', ownerId: 'opus-ghost-tab', sessionId: 'opus-ghost', heartbeatAt: now - 70000,
            sampleRate: 48000, format: 'opus', mime: (pieces[0] && pieces[0].blob.type) || 'audio/webm;codecs=opus',
            resultGeneration: 0, transcripts: [], summaries: [] });
        for (const piece of pieces) {
            const copy = { ...piece, recId: id, sessionId: 'opus-ghost' };
            delete copy.fragmentId;
            delete copy._fragmentStore;
            await db.dbExec(CONFIG.STORE_FRAGMENTS, 'add', copy);
        }
        const tail = new Uint8Array(await pieces[pieces.length - 1].blob.slice(-1).arrayBuffer())[0];
        return { id, pieces: pieces.length, tail };
    })()`;
    const opusGhost = await app.evaluate(copyPiecesIntoAbandonedRecording);
    await stopRecording(app, beatRec);
    const recoveredOpus = await app.evaluate(`(async () => {
        const db = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const { recoverIncompleteRecordings } = await import('/src/js/recorder.js');
        await recoverIncompleteRecordings();
        const rec = await db.dbExec(CONFIG.STORE_REC, 'get', ${opusGhost.id});
        const audio = await db.readAudio(${opusGhost.id});
        const playerSec = audio ? await new Promise(resolve => {
            const player = new Audio(URL.createObjectURL(audio));
            player.onloadedmetadata = () => resolve(player.duration);
            player.onerror = () => resolve(-1);
        }) : -1;
        await db.dbExec(CONFIG.STORE_REC, 'delete', ${opusGhost.id});
        return { processing: rec.processing, remuxError: rec.webmRemuxError || null,
                 seekable: rec.webmSeekableVersion || 0, durationMs: rec.durationMs, playerSec };
    })()`);
    ok(opusGhost.pieces >= 2 && !recoveredOpus.processing && !recoveredOpus.remuxError && recoveredOpus.seekable > 0
       && Number.isFinite(recoveredOpus.playerSec) && recoveredOpus.playerSec > 0,
       `an Opus recording recovered after its tab was closed gets its duration and seek index, although its last saved piece ends inside the next block (${JSON.stringify({ ...opusGhost, ...recoveredOpus })})`);
    ok(Math.abs(recoveredOpus.durationMs - opusGhost.pieces * 4000) <= 1500,
       `and it is as long as the audio its pieces hold, not as its last saved length (${recoveredOpus.durationMs} ms from ${opusGhost.pieces} pieces)`);
    const beatLeft = await app.evaluate(`import('/src/js/db.js').then(m => m.readCaptureBeats()).then(beats => beats.has(${beatRec}))`);
    ok((beatCounts.puts.recordings || 0) === 0 && (beatCounts.puts.capture_beats || 0) >= 3,
       `during a recording the three-second heartbeat writes a small beat, not the whole recording with its context (${JSON.stringify(beatCounts.puts)})`);
    ok(beatCounts.rowAge > 8000 && beatCounts.beatAge !== null && beatCounts.beatAge < 4000 && beatCounts.live,
       `and the recording is still seen as live from its beat (${JSON.stringify({ rowAge: beatCounts.rowAge, beatAge: beatCounts.beatAge, live: beatCounts.live })})`);
    ok(beatCounts.fps === 'none', 'the frame counter over the waveform is hidden unless debugging is switched on');
    ok(!beatLeft, 'once the recording is saved its beat is gone');

    journey('Recovery reads the beat too: a recording whose row is old but whose beat is fresh is left alone, '
        + 'and one whose beat has gone quiet is recovered with the length its beat recorded');
    const ghost = await app.evaluate(`(async () => {
        const db = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const { recoverIncompleteRecordings } = await import('/src/js/recorder.js');
        const now = Date.now();
        const id = await db.dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'ghost', timestamp: now - 90000, durationMs: 10000, processing: true, captureState: 'recording',
            ownerId: 'ghost-tab', sessionId: 'ghost-session', heartbeatAt: now - 70000, sampleRate: 16000,
            format: 'wav', resultGeneration: 0, transcripts: [], summaries: [] });
        const beat = { recId: id, ownerId: 'ghost-tab', sessionId: 'ghost-session', durationMs: 25000,
                       capturedMs: 25000, state: 'recording' };
        await db.writeCaptureBeat({ ...beat, heartbeatAt: now });
        const first = await recoverIncompleteRecordings();
        const stillOpen = (await db.dbExec(CONFIG.STORE_REC, 'get', id)).processing;
        await db.writeCaptureBeat({ ...beat, heartbeatAt: now - 30000 });
        const second = await recoverIncompleteRecordings();
        const after = await db.dbExec(CONFIG.STORE_REC, 'get', id);
        const beatLeft = (await db.readCaptureBeats()).has(id);
        await db.dbExec(CONFIG.STORE_REC, 'delete', id);
        return { first, stillOpen, second, processing: after.processing, durationMs: after.durationMs, beatLeft };
    })()`);
    ok(ghost.first.deferred >= 1 && ghost.stillOpen,
       `a recording whose row is a minute old but whose beat is fresh is not recovered out from under the tab recording it (${JSON.stringify(ghost.first)})`);
    ok(ghost.second.recovered >= 1 && !ghost.processing && ghost.durationMs === 25000 && !ghost.beatLeft,
       `once its beat goes quiet it is recovered with the length the beat recorded (${JSON.stringify(ghost)})`);

    journey('Silence is marked in the timestamped reading but never handed to the model as speech');
    const silentId = await app.evaluate(`(async () => {
        const { dbExec, commitAudio } = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const { encodeMonoWav } = await import('/src/js/audio.js');
        const rate = 16000, seconds = 150;
        const samples = new Float32Array(rate * seconds);
        for (let i = 70 * rate; i < 110 * rate; i++) samples[i] = Math.sin(i / 8) * 0.3;
        const wav = encodeMonoWav(samples, rate);
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'quiet start and end', timestamp: Date.now(), durationMs: seconds * 1000,
            processing: false, captureState: 'ready', sampleRate: rate, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [] });
        await commitAudio(id, wav, rec => { rec.audioBytes = wav.size; return rec; });
        const { transcribeChunked } = await import('/src/js/transcribe.js');
        await transcribeChunked(id, () => {}, { reuseLive: false });
        return id;
    })()`);
    const silentTranscript = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const t = (await dbExec(CONFIG.STORE_REC, 'get', ${silentId})).transcripts[0];
        return { plain: t.plain, text: t.text };
    })()`);
    ok(/no speech detected/.test(silentTranscript.text) && !/no speech detected/.test(silentTranscript.plain)
       && /journey/.test(silentTranscript.plain),
       `the transcript shows where it was quiet, while the text for the AI holds only what was said (${JSON.stringify(silentTranscript.plain)})`);

    journey('Choosing a backup before deleting all audio deletes nothing until the person says the file was saved');
    const backupFirst = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const withAudio = async () => (await dbExec(CONFIG.STORE_REC, 'getAll')).filter(rec => rec.audioBytes > 0).length;
        const before = await withAudio();
        const asked = [];
        const realConfirm = window.confirm, realAlert = window.alert;
        window.alert = message => { asked.push(String(message)); };
        window.confirm = message => {
            asked.push(String(message));
            return !/has finished downloading and was saved/.test(String(message));
        };
        try { await window.deleteAllAudio(); } finally { window.confirm = realConfirm; window.alert = realAlert; }
        return { before, after: await withAudio(), asked: asked.map(text => text.split('\\n')[0]) };
    })()`);
    ok(backupFirst.before > 0 && backupFirst.after === backupFirst.before
       && backupFirst.asked.some(text => /The backup download has started/.test(text)),
       `choosing a backup before deleting all audio deletes nothing until the backup file is said to be saved (${JSON.stringify(backupFirst)})`);

    journey('Settings left open in this tab write back only what was changed here, never a value another tab set meanwhile');
    const settingsWrites = await app.evaluate(`(async () => {
        localStorage.setItem('set-retention-audio', '1M');
        localStorage.removeItem('set-opus-bitrate');
        localStorage.removeItem('set-ai-instructions');
        document.getElementById('settingsBtn').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        localStorage.setItem('set-retention-audio', '1y');
        const box = document.getElementById('set-ai-instructions');
        box.value = 'Answer in Dutch.';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('settingsX').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        const result = {
            retention: localStorage.getItem('set-retention-audio'),
            bitrate: localStorage.getItem('set-opus-bitrate'),
            instructions: localStorage.getItem('set-ai-instructions')
        };
        localStorage.setItem('set-retention-audio', '1M');
        localStorage.removeItem('set-ai-instructions');
        return result;
    })()`, { userGesture: true });
    ok(settingsWrites.retention === '1y',
       `closing Settings does not write back a retention another tab changed while it was open (${JSON.stringify(settingsWrites)})`);
    ok(settingsWrites.bitrate === null && settingsWrites.instructions === 'Answer in Dutch.',
       'it saves what was edited here, and leaves settings that were only looked at alone');

    journey('Startup recovery and jumping to a note use the index instead of reading every recording');
    const lookups = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const base = Date.now() - 3600000;
        const ids = [];
        for (let i = 0; i < 9; i++) {
            ids.push(await dbExec(CONFIG.STORE_REC, 'add', { filename: 'filler ' + i, timestamp: base - i * 60000,
                durationMs: 1000, processing: false, captureState: 'ready', transcripts: [], summaries: [] }));
        }
        const stranded = await dbExec(CONFIG.STORE_REC, 'add', { filename: 'stranded', timestamp: base - 30 * 60000,
            durationMs: 1000, processing: true, captureState: 'finalize-error', finalizationError: 'test',
            transcripts: [], summaries: [] });
        const wholeReads = [];
        const realIndexGetAll = IDBIndex.prototype.getAll;
        const realStoreGetAll = IDBObjectStore.prototype.getAll;
        IDBIndex.prototype.getAll = function (query, count) {
            if (this.objectStore.name === CONFIG.STORE_REC && query === undefined) wholeReads.push('index:' + this.name);
            return realIndexGetAll.call(this, query, count);
        };
        IDBObjectStore.prototype.getAll = function (query, count) {
            if (this.name === CONFIG.STORE_REC && query === undefined) wholeReads.push('store');
            if (this.name === CONFIG.STORE_LIVE) wholeReads.push('live transcripts');
            return realStoreGetAll.call(this, query, count);
        };
        const { writeLiveTranscript, readLiveTranscript, cleanupOrphanLiveTranscripts } = await import('/src/js/db.js');
        await writeLiveTranscript(ids[0], { lines: [{ startSec: 0, endSec: 1, text: 'kept' }], coverage: [] });
        await writeLiveTranscript(987650, { lines: [{ startSec: 0, endSec: 1, text: 'orphan' }], coverage: [] });
        let recovery, jumped, orphansRemoved;
        try {
            const { recoverIncompleteRecordings } = await import('/src/js/recorder.js');
            recovery = await recoverIncompleteRecordings();
            jumped = await window.showRecordingById(ids[8]);
            orphansRemoved = await cleanupOrphanLiveTranscripts();
        } finally {
            IDBIndex.prototype.getAll = realIndexGetAll;
            IDBObjectStore.prototype.getAll = realStoreGetAll;
        }
        const row = await dbExec(CONFIG.STORE_REC, 'get', stranded);
        const liveKept = !!(await readLiveTranscript(ids[0]));
        const orphanGone = !(await readLiveTranscript(987650));
        return { wholeReads, recovered: recovery.recovered, strandedDone: row && !row.processing,
                 jumped, shown: !!document.getElementById('rec-' + ids[8]), orphansRemoved, liveKept, orphanGone };
    })()`);
    ok(lookups.recovered === 1 && lookups.strandedDone,
       'startup recovery still finds and finishes an interrupted recording');
    ok(lookups.jumped && lookups.shown, 'and jumping to an older note still lands on its page');
    ok(lookups.wholeReads.length === 0,
       `neither reads every recording to do it, nor does the startup sweep of live transcripts read them all (${lookups.wholeReads.join(', ') || 'no whole-table reads'})`);
    ok(lookups.orphansRemoved >= 1 && lookups.liveKept && lookups.orphanGone,
       'and that sweep still removes a live transcript no recording owns and keeps the others');

    journey('A context item: tap the text to read it whole, tap 📋 to copy the whole text');
    await app.send('Browser.grantPermissions', {
        origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    const pasted = 'Pasted note line one. '.repeat(30).trim();
    const contextRow = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const id = await dbExec(CONFIG.STORE_REC, 'add', { filename: 'with context', timestamp: Date.now() + 60000,
            durationMs: 1000, processing: false, captureState: 'ready', transcripts: [], summaries: [],
            contextChain: [{ inputText: ${JSON.stringify(pasted)}, outputText: '', text: '[Pasted Note]: x',
                             label: 'Pasted: now', pasted: true }] });
        const gui = await import('/src/js/gui.js');
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        return id;
    })()`);
    const rowUi = await app.evaluate(`(() => {
        const row = document.getElementById('rec-${contextRow}');
        const views = [];
        const realView = window.viewContextPart;
        window.viewContextPart = (...args) => { views.push(args); };
        row.querySelector('.context-preview').click();
        window.viewContextPart = realView;
        return { eyes: row.innerHTML.includes('👁'), views,
                 copy: !!row.querySelector('[data-action="copyContextPart"]') };
    })()`, { userGesture: true });
    ok(!rowUi.eyes && rowUi.copy, 'a context item offers 📋 beside its text, and no separate view button');
    ok(rowUi.views.length === 1 && rowUi.views[0][0] === contextRow && rowUi.views[0][2] === 'input',
       'tapping the text itself opens it in full');
    await app.send('Page.bringToFront').catch(() => {});
    await app.evaluate(`document.querySelector('#rec-${contextRow} [data-action="copyContextPart"]').click(); true`,
                       { userGesture: true });
    const copiedMark = await waitFor(app,
        `(() => { const t = document.querySelector('#rec-${contextRow} [data-action="copyContextPart"]').textContent; return t !== '📋' ? t : ''; })()`, 5000);
    const clipboard = await app.evaluate('navigator.clipboard.readText().catch(err => "read failed: " + err.name)',
                                         { userGesture: true });
    ok(copiedMark === '✓' && clipboard === pasted,
       `tapping 📋 puts the whole text on the clipboard, not the shortened preview (${copiedMark}, ${clipboard.length} of ${pasted.length} chars)`);

    journey('On a phone, an opened context item scrolls by itself: ▶ starts and pauses, the speed button opens '
        + 'a popup to set the speed, Escape closes only that popup, and the controls leave with the view');
    await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: true });
    const longContext = Array.from({ length: 220 }, (_, i) => `Line ${i + 1} of a text to read aloud.`).join('\n');
    const scrollRec = await app.evaluate(`(async () => {
        localStorage.removeItem('myai-autoscroll-speed');
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const id = await dbExec(CONFIG.STORE_REC, 'add', { filename: 'read aloud', timestamp: Date.now() + 120000,
            durationMs: 1000, processing: false, captureState: 'ready', transcripts: [], summaries: [],
            contextChain: [{ inputText: ${JSON.stringify(longContext)}, outputText: '', text: '[Pasted Note]: x',
                             label: 'Pasted: script', pasted: true }] });
        const gui = await import('/src/js/gui.js');
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        document.querySelector('#rec-' + id + ' .context-preview').click();
        return id;
    })()`, { userGesture: true });
    await waitFor(app, `!!document.querySelector('.live-inline.open .as-bar .as-play')
        && document.querySelector('.live-inline.open .live-inline-transcript').textContent.length > 1000`, 10000);
    const scrollUi = await app.evaluate(`(async () => {
        const panel = document.querySelector('.live-inline.open .live-inline-panel');
        const body = panel.querySelector('.live-inline-body');
        const play = panel.querySelector('.as-play'), speed = panel.querySelector('.as-speed');
        const bar = panel.querySelector('.as-bar').getBoundingClientRect(), box = panel.getBoundingClientRect();
        const first = { label: speed.textContent, pressed: play.getAttribute('aria-pressed'),
                        inside: bar.right <= box.right && bar.bottom <= box.bottom && bar.top >= box.top,
                        top: document.elementFromPoint(bar.left + 10, bar.top + bar.height / 2)?.closest('.as-bar') !== null };
        speed.click();
        const pop = panel.querySelector('.as-pop');
        const range = pop.querySelector('input[type=range]');
        const opened = !pop.hidden && speed.getAttribute('aria-expanded') === 'true' && document.activeElement === range;
        range.value = '120';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        return { first, opened, label: speed.textContent, value: pop.querySelector('.as-pop-value').textContent,
                 stored: localStorage.getItem('myai-autoscroll-speed'), scrollTop: body.scrollTop };
    })()`, { userGesture: true });
    ok(scrollUi.first.pressed === 'false' && scrollUi.first.label === '20/min',
       `the opened text shows ▶ and the speed button, paused at 20 lines a minute (${JSON.stringify(scrollUi.first)})`);
    ok(scrollUi.first.inside && scrollUi.first.top,
       `the controls float on top of the text, inside the view (${JSON.stringify(scrollUi.first)})`);
    ok(scrollUi.opened, 'the speed button opens its popup with the slider ready to move');
    ok(scrollUi.label === '120/min' && scrollUi.value === '120 lines a minute' && scrollUi.stored === '120',
       `moving the slider sets the speed at once and remembers it (${scrollUi.label}, ${scrollUi.value}, ${scrollUi.stored})`);
    await pressKey(app, 'Escape');
    const afterEscape = await app.evaluate(`({ view: !!document.querySelector('.live-inline.open'),
        pop: document.querySelector('.live-inline.open .as-pop')?.hidden })`);
    ok(afterEscape.view && afterEscape.pop === true, `Escape closes the speed popup, not the view (${JSON.stringify(afterEscape)})`);
    const scrolled = await app.evaluate(`(async () => {
        const panel = document.querySelector('.live-inline.open .live-inline-panel');
        const body = panel.querySelector('.live-inline-body'), play = panel.querySelector('.as-play');
        const max = body.scrollHeight - body.clientHeight;
        play.click();
        await new Promise(r => setTimeout(r, 1500));
        const moved = body.scrollTop, pressed = play.getAttribute('aria-pressed');
        play.click();
        const pausedAt = body.scrollTop;
        await new Promise(r => setTimeout(r, 600));
        const stillAt = body.scrollTop;
        body.scrollTop = max - 30;
        play.click();
        await new Promise(r => setTimeout(r, 2500));
        return { max, moved, pressed, pausedAt, stillAt, end: body.scrollTop, endPressed: play.getAttribute('aria-pressed') };
    })()`, { userGesture: true });
    ok(scrolled.max > 1000 && scrolled.moved > 30 && scrolled.pressed === 'true',
       `▶ scrolls the text by itself (${scrolled.moved} px in 1.5 s at 120 lines a minute)`);
    ok(scrolled.pausedAt === scrolled.stillAt, `pressing it again pauses (${scrolled.pausedAt} then ${scrolled.stillAt})`);
    ok(scrolled.max - scrolled.end <= 2 && scrolled.endPressed === 'false',
       `at the end of the text it stops by itself (${scrolled.end} of ${scrolled.max}, pressed ${scrolled.endPressed})`);
    await app.evaluate(`document.querySelector('.live-inline.open .live-inline-close').click(); true`);
    const controlsLeft = await app.evaluate(`({ bars: document.querySelectorAll('.as-bar').length,
        position: document.querySelector('.live-inline-panel').style.position })`);
    ok(controlsLeft.bars === 0 && controlsLeft.position === '', `closing the view removes the controls (${JSON.stringify(controlsLeft)})`);
    await app.send('Emulation.clearDeviceMetricsOverride');
    await app.evaluate(`localStorage.removeItem('myai-autoscroll-speed'); true`);

    journey('A background retention sweep in an idle tab never interrupts it');
    await app.evaluate(`(async () => {
        const { dbExec, writeAudio } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        localStorage.setItem('retention-policy-acknowledged-v2', 'audio=1M;text=1M');
        const id = await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'overdue', timestamp: Date.now() - 40 * 86400000, durationMs: 1000, processing: false,
            format: 'wav', audioBytes: 64, transcripts: [], summaries: [] });
        window.__overdue = id;
        return true;
    })()`);
    const idle = await openPage(`${origin}/index.html?idle=1`);
    const recordingForSweep = await record(app, 1, { stop: false });
    await idle.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        await dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'overdue again', timestamp: Date.now() - 40 * 86400000, durationMs: 1000, processing: false,
            format: 'wav', audioBytes: 64, transcripts: [], summaries: [] });
        window.__dialogs.length = 0;
        return true;
    })()`);
    const sweep = await idle.evaluate('window.runRetentionSweep({ announce: false })');
    const sweepDialogs = await idle.evaluate('window.__dialogs.length');
    ok(sweep && sweep.skipped === 'locked' && sweepDialogs === 0,
       'a background sweep that finds another tab recording waits quietly for the next tick');
    await stopRecording(app, recordingForSweep);
    await closePage(idle);
    await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        for (const row of await dbExec(CONFIG.STORE_REC, 'getAll')) {
            if (String(row.filename || '').startsWith('overdue')) await dbExec(CONFIG.STORE_REC, 'delete', row.id);
        }
        return true;
    })()`);

    await app.send('Page.bringToFront');

    journey('While this tab saves a recording its row and button say so, never "LIVE · OTHER TAB" or "Recovering"; '
        + 'its pieces, copied while it records, stand in for a recording whose tab closed without saving it');
    const savingRec = await record(app, 5, { format: 'wav', stop: false });
    const interrupted = await app.evaluate(`(async () => {
        const db = await import('/src/js/db.js');
        const { CONFIG } = await import('/src/js/config.js');
        const pieces = (await db.getAudioFragmentsForRecording(${savingRec})).sort((a, b) => a.seq - b.seq);
        const now = Date.now();
        const id = await db.dbExec(CONFIG.STORE_REC, 'add', {
            filename: 'interrupted', timestamp: now, durationMs: 4000, processing: true,
            captureState: 'recording', ownerId: 'closed-tab', sessionId: 'closed-tab-session', heartbeatAt: now - 30000,
            sampleRate: pieces[0] ? pieces[0].sampleRate || 48000 : 48000, format: 'wav',
            resultGeneration: 0, transcripts: [], summaries: [] });
        for (const piece of pieces) {
            const copy = { ...piece, recId: id, sessionId: 'closed-tab-session' };
            delete copy.fragmentId;
            delete copy._fragmentStore;
            await db.dbExec(CONFIG.STORE_FRAGMENTS, 'add', copy);
        }
        return { id, pieces: pieces.length };
    })()`);
    await app.evaluate(`(() => {
        window.__saveSeen = { otherTab: false, saving: false, recovering: false, startWhileBusy: false };
        const button = document.getElementById('recordBtn');
        const look = () => {
            const row = document.getElementById('rec-${savingRec}');
            const text = row ? row.textContent : '';
            if (/LIVE · OTHER TAB/.test(text)) window.__saveSeen.otherTab = true;
            if (/Saving…/.test(text)) window.__saveSeen.saving = true;
            if (/Recovering recording/.test(text)) window.__saveSeen.recovering = true;
            if (button.disabled && button.textContent === 'Start Recording') window.__saveSeen.startWhileBusy = true;
        };
        window.__saveObserver = new MutationObserver(look);
        window.__saveObserver.observe(document.getElementById('recordingsList'), { childList: true, subtree: true, characterData: true });
        window.__saveObserver.observe(button, { childList: true, subtree: true, characterData: true, attributes: true });
        return true;
    })()`);
    await stopRecording(app, savingRec);
    const saveSeen = await app.evaluate(`(() => { window.__saveObserver.disconnect(); return window.__saveSeen; })()`);
    ok(saveSeen.saving && !saveSeen.otherTab && !saveSeen.recovering,
       `while this tab saves a recording its row says "Saving…", not that another tab owns it (${JSON.stringify(saveSeen)})`);
    ok(!saveSeen.startWhileBusy, 'and the record button does not read "Start Recording" while it cannot start one');

    journey('A recording whose tab closed without saving it is recovered by a tab that stays open, without a reload; '
        + 'until then its row says what happened and offers Recover now and Delete');
    const ghostView = await app.evaluate(`(async () => {
        const gui = await import('/src/js/gui.js');
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        const row = document.getElementById('rec-${interrupted.id}');
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${interrupted.id});
        return { processing: !!rec.processing, text: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '',
                 recover: !!(row && row.querySelector('[data-action="recoverNowRec"]')),
                 remove: !!(row && row.querySelector('[data-action="deleteRec"]')) };
    })()`);
    ok(interrupted.pieces >= 1 && (!ghostView.processing || (/Interrupted/.test(ghostView.text) && ghostView.recover && ghostView.remove)),
       `a recording left by a closed tab says it was interrupted and offers Recover now and Delete (${JSON.stringify(ghostView)})`);
    if (ghostView.recover) {
        await app.evaluate(`document.querySelector('#rec-${interrupted.id} [data-action="recoverNowRec"]').click(); true`,
                           { userGesture: true });
    }
    const recovered = await waitFor(app, `(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const rec = await dbExec(CONFIG.STORE_REC, 'get', ${interrupted.id});
        return rec && !rec.processing && Number(rec.audioBytes) > 0 ? { bytes: rec.audioBytes } : null;
    })()`, 20000).catch(() => null);
    ok(!!recovered, 'and it is recovered in this tab, with its audio, without reloading the page');
    await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        await dbExec(CONFIG.STORE_REC, 'delete', ${interrupted.id});
        window.__dialogs.length = 0;
        return true;
    })()`);

    journey('A repaint of the list neither stops nor rewinds the recording being listened to, '
        + 'and a title being typed survives it');
    const playRec = savingRec;
    await app.evaluate(`import('/src/js/gui.js').then(g => { g.resetListToFirstPage(); return g.renderList({ force: true }); }).then(() => true)`);
    await app.evaluate(`document.querySelector('#rec-${playRec} .player-play').click(); true`, { userGesture: true });
    await waitFor(app, `(() => { const a = document.querySelector('#rec-${playRec} audio'); return !!a && !a.paused && a.currentTime > 0.6; })()`, 8000);
    const acrossRepaint = await app.evaluate(`(async () => {
        const gui = await import('/src/js/gui.js');
        const before = document.querySelector('#rec-${playRec} audio');
        const at = before.currentTime;
        await gui.renderList({ force: true });
        await new Promise(resolve => setTimeout(resolve, 400));
        const after = document.querySelector('#rec-${playRec} audio');
        return { playing: !!after && !after.paused, at, now: after ? after.currentTime : 0,
                 button: document.querySelector('#rec-${playRec} .player-play').textContent };
    })()`);
    ok(acrossRepaint.playing && acrossRepaint.now > acrossRepaint.at && acrossRepaint.button === '⏸',
       `a repaint of the list while a recording plays keeps it playing where it was (${JSON.stringify(acrossRepaint)})`);
    const pausedRepaint = await app.evaluate(`(async () => {
        const gui = await import('/src/js/gui.js');
        const audio = document.querySelector('#rec-${playRec} audio');
        audio.pause();
        await new Promise(resolve => setTimeout(resolve, 200));
        const at = audio.currentTime;
        await gui.renderList();
        const after = document.querySelector('#rec-${playRec} audio');
        return { at, now: after ? after.currentTime : 0, time: document.querySelector('#rec-${playRec} .player-time').textContent };
    })()`);
    ok(pausedRepaint.at > 0.6 && Math.abs(pausedRepaint.now - pausedRepaint.at) < 0.05 && !/^00:00 \//.test(pausedRepaint.time),
       `pausing, which lets a waiting repaint run, keeps the place in the recording (${JSON.stringify(pausedRepaint)})`);
    await app.evaluate(`document.querySelector('#rec-${playRec} .rec-filename[data-edit-title]').click(); true`, { userGesture: true });
    await app.send('Input.insertText', { text: 'Dentist notes' });
    const titleKept = await app.evaluate(`(async () => {
        const gui = await import('/src/js/gui.js');
        await gui.renderList({ force: true });
        const input = document.querySelector('#rec-${playRec} .rec-title-input');
        return { present: !!input, value: input ? input.value : '', focused: !!input && document.activeElement === input };
    })()`);
    ok(titleKept.present && titleKept.value === 'Dentist notes' && titleKept.focused,
       `a title being typed survives a repaint, still focused (${JSON.stringify(titleKept)})`);
    await pressKey(app, 'Enter');
    const savedTitle = await waitFor(app, `(() => { const t = document.querySelector('#rec-${playRec} .rec-filename')?.textContent || ''; return /Dentist notes/.test(t) ? t : ''; })()`, 5000).catch(() => '');
    ok(/Dentist notes/.test(savedTitle), 'and Enter saves it');

    journey('When a transcription fails after the list was repainted, the button on screen is usable again');
    failTranscribe = true;
    await app.evaluate(`window.__dialogs.length = 0; document.getElementById('btn-t-${playRec}').click(); true`, { userGesture: true });
    await waitFor(app, `import('/src/js/jobs.js').then(m => m.hasJob('t', ${playRec}))`, 5000);
    await app.evaluate(`import('/src/js/gui.js').then(g => g.renderList({ force: true })).then(() => true)`);
    await waitFor(app, `import('/src/js/jobs.js').then(m => !m.hasJob('t', ${playRec}))`, 60000);
    failTranscribe = false;
    await sleep(600);
    const buttonAfterFailure = await app.evaluate(`(() => {
        const button = document.getElementById('btn-t-${playRec}');
        return { disabled: !!(button && button.disabled), busy: !!(button && button.dataset.busy), text: button ? button.textContent : '',
                 alerts: window.__dialogs.filter(d => d[0] === 'alert').length };
    })()`);
    ok(buttonAfterFailure.alerts >= 1 && !buttonAfterFailure.disabled && !buttonAfterFailure.busy && !/Working/.test(buttonAfterFailure.text),
       `a transcription that failed after its row was repainted leaves the Scribe button usable, not stuck on Working (${JSON.stringify(buttonAfterFailure)})`);

    journey('Keyboard: Enter on a transcript opens it once; Shift+Tab from an opened dialog stays inside it; '
        + 'the paste box keeps Tab inside it too');
    await app.evaluate(`(async () => {
        const { dbUpdate } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        await dbUpdate(CONFIG.STORE_REC, ${playRec}, rec => {
            rec.transcripts = [{ id: 'kb1', text: 'a transcript to open', plain: 'a transcript to open', source: 'S', time: Date.now() }];
            return rec;
        });
        const gui = await import('/src/js/gui.js');
        await gui.renderList({ force: true });
        window.__views = 0;
        const view = window.viewTranscriptById;
        window.viewTranscriptById = (...args) => { window.__views++; return view(...args); };
        document.getElementById('tprev-${playRec}').focus();
        return true;
    })()`);
    await pressKey(app, 'Enter');
    await sleep(400);
    const views = await app.evaluate(`window.__views`);
    ok(views === 1, `Enter on a transcript preview opens it once, not twice (${views})`);
    await app.evaluate(`document.querySelectorAll('.live-inline.open .live-inline-close, .live-inline.open [data-action="closeInline"]').forEach(b => b.click()); true`);
    await pressKey(app, 'Escape');

    await app.evaluate(`document.getElementById('settingsBtn').click(); true`, { userGesture: true });
    await waitFor(app, `document.activeElement && document.activeElement.id === 'settingsPanel'`, 5000).catch(() => null);
    await pressKey(app, 'Tab', { shift: true });
    const settingsFocus = await app.evaluate(`(() => ({ inside: document.getElementById('settingsPanel').contains(document.activeElement)
        && document.activeElement.id !== 'settingsPanel', id: document.activeElement.id || document.activeElement.tagName }))()`);
    ok(settingsFocus.inside, `Shift+Tab from an opened Settings panel stays inside it (${settingsFocus.id})`);
    await pressKey(app, 'Escape');

    await app.evaluate(`window.__realReadText = navigator.clipboard.readText;
        navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); true`);
    await app.evaluate(`document.getElementById('pasteRecordBtn').click(); true`, { userGesture: true });
    await waitFor(app, `document.getElementById('pasteOverlay').classList.contains('open')`, 5000);
    await pressKey(app, 'Tab');
    await pressKey(app, 'Tab');
    await pressKey(app, 'Tab');
    const pasteFocus = await app.evaluate(`(() => ({ inside: document.getElementById('pastePanel').contains(document.activeElement),
        id: document.activeElement.id || document.activeElement.tagName }))()`);
    ok(pasteFocus.inside, `Tab keeps going round inside the paste box (${pasteFocus.id})`);
    await app.evaluate(`document.getElementById('pasteCancel').click(); navigator.clipboard.readText = window.__realReadText; true`);
    await sleep(300);

    journey('Keyboard: Enter and Space on 📋 in a transcript preview copy the transcript, as a click does');
    await app.evaluate(`(async () => {
        const gui = await import('/src/js/gui.js');
        await gui.renderList({ force: true });
        window.__copied = [];
        window.__realWriteText = navigator.clipboard.writeText;
        navigator.clipboard.writeText = text => { window.__copied.push(String(text)); return Promise.resolve(); };
        document.querySelector('#tprev-${playRec} .btn-copy').focus();
        return true;
    })()`);
    await pressKey(app, 'Enter');
    await sleep(300);
    await app.evaluate(`document.querySelector('#tprev-${playRec} .btn-copy').focus(); true`);
    await pressKey(app, ' ');
    await sleep(300);
    const keyboardCopies = await app.evaluate(`(() => {
        const copied = window.__copied;
        navigator.clipboard.writeText = window.__realWriteText;
        document.querySelectorAll('.live-inline.open .live-inline-close').forEach(b => b.click());
        return copied;
    })()`);
    ok(keyboardCopies.length === 2 && keyboardCopies.every(text => text === 'a transcript to open'),
       `Enter and Space on the focused 📋 copy the transcript instead of being swallowed by the preview around it (${JSON.stringify(keyboardCopies)})`);
    await pressKey(app, 'Escape');

    journey('On a phone-width screen a title with no spaces in it wraps instead of widening the page');
    const longTitle = 'https://example.com/some/very/long/path/without/any/spaces/at/all/that/keeps/going/and/going';
    const longTitleRec = await app.evaluate(`(async () => {
        const { dbExec } = await import('/src/js/db.js'); const { CONFIG } = await import('/src/js/config.js');
        const id = await dbExec(CONFIG.STORE_REC, 'add', { filename: ${JSON.stringify(longTitle)}, timestamp: Date.now() + 120000,
            durationMs: 1000, processing: false, captureState: 'ready', transcripts: [], summaries: [] });
        const gui = await import('/src/js/gui.js');
        gui.resetListToFirstPage();
        await gui.renderList({ force: true });
        return id;
    })()`);
    await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    // A phone zooms out to show a page that got wider than the screen, so innerWidth grows with it;
    // the layout width (clientWidth) stays the screen's.
    const phoneWidths = await app.evaluate(`(() => {
        const title = document.querySelector('#rec-${longTitleRec} .rec-filename');
        return { page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth,
                 titleText: title.scrollWidth, titleBox: title.clientWidth };
    })()`);
    await app.send('Emulation.clearDeviceMetricsOverride');
    ok(phoneWidths.page <= phoneWidths.screen && phoneWidths.titleText <= phoneWidths.titleBox,
       `a pasted address as a title wraps inside its row on a 360px screen (page ${phoneWidths.page}px on a ${phoneWidths.screen}px screen, title text ${phoneWidths.titleText}px in a ${phoneWidths.titleBox}px box)`);

    journey('A recording asks Web Audio for nothing it has to clamp');
    await app.send('Log.enable').catch(() => {});
    const consoleFrom = app.events.length;
    const clampRec = await record(app, 2);
    const clamped = app.events.slice(consoleFrom)
        .map(event => event.method === 'Log.entryAdded' ? event.params.entry.text
            : event.method === 'Runtime.consoleAPICalled' ? (event.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ')
            : '')
        .filter(text => /outside nominal range|will be clamped/.test(text));
    ok(clampRec != null && clamped.length === 0,
       `recording sets every limiter value inside the range the browser accepts, so nothing is clamped behind its back (${clamped.join(' | ') || 'no warnings'})`);

    journey('The next schema version keeps every note, and waits for a recording only as long as it runs');
    const beforeUpgrade = await app.evaluate(here.rows);
    await app.evaluate(`localStorage.setItem('set-auto-transcribe', 'on'); true`);
    holdTranscribeMs = 3000;
    const protectedRec = await record(app, 2, { stop: false });
    const newer = await openPage(`${origin}${NEXT_SCHEMA_BUILD_PREFIX}/index.html`);
    await waitFor(newer, `${nextBuild.guard}.then(state => state === 'blocked')`, 10000);
    const recordingTabSays = await waitFor(app, here.alert, 10000);
    ok(/This recording comes first/.test(recordingTabSays) && !/Another tab is recording/.test(recordingTabSays),
       `the recording tab is told its recording comes first, not that another tab is recording (${recordingTabSays})`);
    await stopRecording(app, protectedRec);
    const followUpSays = await waitFor(app,
        `(() => { const text = ${here.alert}; return /work running here/.test(text) ? text : ''; })()`, 5000)
        .catch(() => '');
    ok(/work running here/.test(followUpSays) && await newer.evaluate(`${nextBuild.guard}.then(state => state === 'blocked')`),
       `while the automatic transcription of the stopped recording runs, the newer version keeps waiting and the tab says why (${followUpSays || 'nothing shown'})`);
    await waitFor(newer, `${nextBuild.guard}.then(state => state === 'open')`, 30000);
    ok(true, 'once that work is done the waiting version starts by itself; no tab has to be closed');
    holdTranscribeMs = 0;
    const handedOver = (await newer.evaluate(nextBuild.rows)).find(row => row.id === protectedRec);
    ok(handedOver && handedOver.transcripts >= 1,
       'and the transcript the old tab was producing was stored before it handed the database over');
    const upgradedRows = await newer.evaluate(nextBuild.rows);
    const upgradedAudio = await newer.evaluate(nextBuild.audio);
    ok(upgradedRows.length === beforeUpgrade.length + 1,
       `the newer schema keeps every recording, including the one it waited for (${upgradedRows.length} of ${beforeUpgrade.length + 1})`);
    ok(upgradedRows.filter(row => row.audioBytes > 0).every(row => upgradedAudio.some(a => a.recId === row.id && a.size === row.audioBytes)),
       'and every recording keeps its audio');
    // The tab says a newer version opened once it hands the database over, and that it is older than
    // the stored data once anything of its own (a minute sweep, say) has tried the database since.
    // Both are true, and which one this check meets depends on where the minute falls.
    const oldTabSays = await waitFor(app, here.alert, 10000);
    ok(/newer version of this app opened|older version than the stored data/.test(oldTabSays)
       && /Nothing has been lost/.test(oldTabSays),
       `the tab that stepped aside says so, and its reassurance is true (${oldTabSays})`);

    journey('A tab still on the older build is told why its list is empty, and the notice stays up');
    await app.send('Page.reload');
    await waitFor(app, "document.readyState === 'complete' && !!document.getElementById('recordBtn')", 20000);
    await sleep(3500);
    const staleSays = await app.evaluate(here.alert);
    ok(/older version than the stored data/.test(staleSays),
       `a tab left on an older build explains itself instead of showing an empty page (${staleSays || 'nothing shown'})`);

    await closePage(newer);
    console.log(`✓ all ${assertions} user-journey assertions passed`);
    emitTestResult('user-journeys', 'pass', { assertions, browser: chromium });
} catch (err) {
    console.error(`✗ failed during the journey: ${currentJourney}`);
    if (browserErrors) console.error(browserErrors.slice(-2000));
    throw err;
} finally {
    for (const client of clients) client.close();
    server.close();
    try { browser.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
