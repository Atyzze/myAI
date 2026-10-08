// A new build of the app, as the person meets it: it downloads in the background and is offered
// under the help button (this build › the new one); the page keeps running the build it started
// with, also across a reload, until the version is tapped; then it switches, and the calendar's copy
// on the device is untouched.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from '../helpers/check.mjs';
import { strictTests } from '../helpers/strict.mjs';
import { startDevServer } from '../helpers/dev-server.mjs';
import { launchBrowser, findChromium, sleep } from '../helpers/cdp.mjs';
import { findRadicale } from '../helpers/radicale.mjs';

const { ok, eq, finish } = suite('shell-update');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const [missing, what] of [[!findChromium(), 'Chromium'], [!findRadicale(), 'Radicale (set MYAI_RADICALE_PYTHON)']]) {
    if (!missing) continue;
    const message = `${what} not found; the shell update suite cannot run.`;
    if (strictTests()) { console.error(message); process.exit(1); }
    console.log(`↷ ${message}`);
    console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: 'shell-update', status: 'skip', reason: message })}`);
    process.exit(0);
}

const current = Number((await import('node:fs')).readFileSync(path.join(root, 'BUILD_NUMBER'), 'utf8').trim());
const next = current + 1;
const newerBuild = (rel, body) => {
    if (rel === 'sw.js') return Buffer.from(String(body).replace(/const VERSION\s*=\s*'v\d+';/, `const VERSION     = 'v${next}';`));
    if (rel === 'index.html') return Buffer.from(String(body).replace(/<meta name="myai-calendar-build" content="\d+">/, `<meta name="myai-calendar-build" content="${next}">`));
    return null;
};

const dev = await startDevServer();
const browser = await launchBrowser({ headlessArgs: ['--lang=en-GB'] });
let page = null;
try {
    const device = await browser.device();
    page = await device.page();
    await page.goto(dev.appUrl);
    await page.fill('#si-user', 'alice');
    await page.fill('#si-pass', 'alice-secret-1');
    await page.click('#si-go');
    await page.waitFor("document.getElementById('sync-line').className === 'ok'", { timeoutMs: 20000, what: 'the first sync' });
    await page.waitFor('navigator.serviceWorker.controller !== null', { timeoutMs: 20000, what: 'the offline shell to take over' });
    eq(await page.text('#app-version'), `v${current}`, `the page runs build ${current}`);
    await page.click('#newEventBtn');
    await page.fill('#ed-summary', 'Before the update');
    await page.click('#ed-save');
    await page.waitFor("document.querySelector('#view').textContent.includes('Before the update')", { what: 'an event' });

    // The box gets a newer build.
    dev.setTransform(newerBuild);
    await page.click('#app-version');
    const offered = await page.waitFor(`document.getElementById('app-version').textContent === 'v${current} › v${next}' && document.getElementById('app-version').className`,
        { timeoutMs: 30000, what: 'the newer build to be offered' });
    ok(/offered/.test(offered), `a tap on the version finds build ${next}, which downloads and is offered: v${current} › v${next}`);
    eq(await page.evaluate("document.querySelector('meta[name=\"myai-calendar-build\"]').content"), String(current), 'the page itself still runs the build it started with');

    await page.reload();
    await page.waitFor("!document.getElementById('app').hidden", { what: 'the app after a reload' });
    eq(await page.evaluate("document.querySelector('meta[name=\"myai-calendar-build\"]').content"), String(current),
       'a reload alone does not switch: the new build waits to be asked');
    await page.waitFor(`document.getElementById('app-version').textContent === 'v${current} › v${next}'`, { timeoutMs: 15000, what: 'the offer after the reload' });
    ok(true, 'and is offered again after the reload');

    await page.click('#app-version');
    await page.waitFor(`document.querySelector('meta[name="myai-calendar-build"]') && document.querySelector('meta[name="myai-calendar-build"]').content === '${next}'`,
        { timeoutMs: 30000, what: 'the switch to the new build' });
    await page.waitFor("!document.getElementById('app').hidden", { what: 'the app on the new build' });
    eq(await page.text('#app-version'), `v${next}`, `tapping it switches to build ${next}`);
    await page.waitFor("document.querySelector('#view').textContent.includes('Before the update')", { what: 'the event after the update' });
    ok(true, 'the calendar on the device and the sign-in are kept across the update');
    eq(page.errors, [], 'no errors in the page');
} catch (err) {
    console.error(err);
    if (page) { try { await page.screenshot(path.join(root, 'artifacts', 'screens', 'shell-update-failure.png')); } catch (_) {} console.error(page.errors, page.console.slice(-10)); }
    ok(false, `the update journey stopped: ${err.message}`);
} finally {
    if (page) page.close();
    await browser.close();
    await dev.stop();
}

finish();
