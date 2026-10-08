// Driving a headless Chromium over the DevTools protocol, with no packages: a browser, separate
// "devices" (browser contexts with their own storage), pages on them, and the few things a test
// does on a page (run script, wait, tap, type, take a picture).
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './radicale.mjs';

const COMMANDS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

function listDir(dir) {
    try { return fs.readdirSync(dir); } catch (_) { return []; }
}

export function findChromium(env = process.env) {
    const candidates = [];
    if (env.CHROME_BIN) candidates.push(env.CHROME_BIN);
    for (const dir of [env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), '/opt/pw-browsers']) {
        if (!dir) continue;
        for (const rev of listDir(dir).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
            for (const build of listDir(path.join(dir, rev))) {
                if (/^chrome-linux/.test(build)) candidates.push(path.join(dir, rev, build, 'chrome'));
            }
        }
    }
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const name of COMMANDS) candidates.push(path.join(dir, name));
    }
    return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch (_) { return false; } }) || null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Connection {
    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
    }
    async open() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const waiter = this.pending.get(message.id);
                if (!waiter) return;
                this.pending.delete(message.id);
                if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
                else waiter.resolve(message.result);
                return;
            }
            for (const fn of this.listeners.get(message.method) || []) fn(message.params);
        });
        return this;
    }
    send(method, params = {}) {
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
        this.ws.send(JSON.stringify({ id, method, params }));
        return promise;
    }
    on(method, fn) {
        if (!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(fn);
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

export class Page {
    constructor(conn, targetId, port) {
        this.conn = conn;
        this.targetId = targetId;
        this.port = port;
        this.errors = [];
        this.console = [];
        conn.on('Runtime.exceptionThrown', p => this.errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
        conn.on('Runtime.consoleAPICalled', p => {
            const text = p.args.map(a => a.value ?? a.description ?? '').join(' ');
            this.console.push(`${p.type}: ${text}`);
            if (p.type === 'error') this.errors.push(text);
        });
    }

    async evaluate(expression) {
        const result = await this.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text;
            throw new Error(`In the page: ${detail}`);
        }
        return result.result.value;
    }

    async waitFor(expression, { timeoutMs = 10000, what = expression } = {}) {
        const end = Date.now() + timeoutMs;
        let last;
        while (Date.now() < end) {
            try {
                last = await this.evaluate(expression);
                if (last) return last;
            } catch (err) { last = err.message; }
            await sleep(100);
        }
        throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    }

    async goto(url) {
        await this.conn.send('Page.navigate', { url });
        await this.waitFor("document.readyState === 'complete'", { what: `${url} to load` });
    }

    async reload() {
        await this.conn.send('Page.reload', { ignoreCache: false });
        await sleep(300);
        await this.waitFor("document.readyState === 'complete'", { what: 'the page to reload' });
    }

    // Taps the first element matching the selector (and holding `text`, when given).
    async click(selector, text = null) {
        const found = await this.evaluate(`(() => {
            const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const el = all.find(e => ${text == null ? 'true' : `e.textContent.includes(${JSON.stringify(text)})`});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
        })()`);
        if (!found) throw new Error(`Nothing to tap: ${selector}${text ? ` with "${text}"` : ''}`);
    }

    // Sets a form control's value the way typing would (input and change events).
    async fill(selector, value) {
        const done = await this.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.focus();
            if (el.type === 'checkbox') { el.checked = ${JSON.stringify(!!value)}; }
            else el.value = ${JSON.stringify(String(value))};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        if (!done) throw new Error(`No field: ${selector}`);
    }

    // Chooses files in a file input, as picking them in the dialog would.
    async setFiles(selector, files) {
        const { root } = await this.conn.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await this.conn.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`No file input: ${selector}`);
        await this.conn.send('DOM.setFileInputFiles', { nodeId, files });
        await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
    }

    async text(selector) {
        return this.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
    }

    async screenshot(file) {
        const { data } = await this.conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return file;
    }

    async emulate({ width, height, mobile = false, scale = 1 }) {
        await this.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
        await this.conn.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    }

    // Makes this the tab in front (a tab in the background does not draw).
    async front() {
        await this.conn.send('Page.bringToFront');
    }

    // The page's own clock and time zone.
    async setTimezone(zone) {
        await this.conn.send('Emulation.setTimezoneOverride', { timezoneId: zone });
    }

    close() { this.conn.close(); }
}

export async function launchBrowser({ headlessArgs = [] } = {}) {
    const chromium = findChromium();
    if (!chromium) return null;
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-calendar-browser-'));
    const proc = childProcess.spawn(chromium, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--no-proxy-server', '--proxy-bypass-list=*', '--window-size=1280,900',
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...headlessArgs, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    const end = Date.now() + 20000;
    let version = null;
    while (Date.now() < end) {
        if (proc.exitCode != null) throw new Error(`Chromium exited: ${stderr.slice(-500)}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) { version = await res.json(); break; }
        } catch (_) {}
        await sleep(100);
    }
    if (!version) throw new Error('Chromium did not start its DevTools endpoint.');
    const browser = await new Connection(version.webSocketDebuggerUrl).open();
    return {
        port, browser, version,
        // A device: its own cookies, storage, service workers.
        async device() {
            const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
            return {
                id: browserContextId,
                async page(url = 'about:blank') {
                    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
                    const conn = await new Connection(`ws://127.0.0.1:${port}/devtools/page/${targetId}`).open();
                    const page = new Page(conn, targetId, port);
                    await conn.send('Page.enable');
                    await conn.send('Runtime.enable');
                    if (url !== 'about:blank') await page.goto(url);
                    return page;
                },
                // Downloads of this device land in `dir`.
                async downloadsTo(dir) {
                    fs.mkdirSync(dir, { recursive: true });
                    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: dir });
                },
                async close() { await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
            };
        },
        async close() {
            browser.close();
            proc.kill('SIGKILL');
            await sleep(200);
            fs.rmSync(profile, { recursive: true, force: true });
        }
    };
}

export { sleep };
