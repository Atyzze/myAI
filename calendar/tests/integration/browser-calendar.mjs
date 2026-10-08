// The app in a real browser, against a real Radicale behind the box's /dav/ address: one person with
// a laptop and a phone (two browser profiles, each with its own copy), signing in, adding and
// changing events on one and seeing them on the other, working offline (also opening the app with
// no connection at all), a repeating event changed from one time on, deleting with undo, a
// reminder, importing and exporting, two tabs, and signing out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from '../helpers/check.mjs';
import { strictTests } from '../helpers/strict.mjs';
import { startDevServer } from '../helpers/dev-server.mjs';
import { launchBrowser, findChromium, sleep } from '../helpers/cdp.mjs';
import { findRadicale } from '../helpers/radicale.mjs';

const { DavClient, basicAuth } = await import('../../src/js/caldav.js');

const { ok, eq, finish } = suite('browser-calendar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'artifacts', 'screens');

for (const [missing, what] of [[!findChromium(), 'Chromium'], [!findRadicale(), 'Radicale (set MYAI_RADICALE_PYTHON)']]) {
    if (!missing) continue;
    const message = `${what} not found; the browser suite cannot run.`;
    if (strictTests()) { console.error(message); process.exit(1); }
    console.log(`↷ ${message}`);
    console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: 'browser-calendar', status: 'skip', reason: message })}`);
    process.exit(0);
}

const ZONE = 'Europe/Amsterdam';
const ymd = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));

const dev = await startDevServer();
const browser = await launchBrowser({ headlessArgs: ['--lang=en-GB'] });
const pages = [];
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-calendar-downloads-'));

async function openApp(device, { phone = false } = {}) {
    const page = await device.page();
    pages.push(page);
    await page.conn.send('Emulation.setLocaleOverride', { locale: 'en-GB' });
    await page.setTimezone(ZONE);
    if (phone) await page.emulate({ width: 390, height: 844, mobile: true, scale: 2 });
    await page.goto(dev.appUrl);
    return page;
}

async function signIn(page, user, password) {
    await page.waitFor("!document.getElementById('signin').hidden", { what: 'the sign-in screen' });
    await page.fill('#si-user', user);
    await page.fill('#si-pass', password);
    await page.click('#si-go');
}

const syncs = page => page.evaluate('Number(document.body.dataset.syncs || 0)');

async function syncNow(page) {
    const before = await syncs(page);
    await page.click('#sync-now');
    await page.waitFor(`Number(document.body.dataset.syncs || 0) > ${before}`, { timeoutMs: 20000, what: 'a sync to finish' });
    await sleep(150);
    return page.evaluate("document.getElementById('sync-line').className");
}

async function newEvent(page, { title, date, start = null, end = null, allDay = false, location = '', repeat = null, count = null }) {
    await page.click('#newEventBtn');
    await page.waitFor("document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor' });
    await page.fill('#ed-summary', title);
    if (allDay) await page.fill('#ed-allday', true);
    await page.fill('#ed-start-date', date);
    if (start) await page.fill('#ed-start-time', start);
    if (end) await page.fill('#ed-end-time', end);
    if (location) await page.fill('#ed-location', location);
    if (repeat) await page.fill('#ed-repeat', repeat);
    if (count) { await page.fill('#ed-ends', 'count'); await page.fill('#ed-count', count); }
    await page.click('#ed-save');
    await page.waitFor("!document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor to close' });
}

async function serverSummaries(user = 'alice', password = 'alice-secret-1') {
    const dav = new DavClient({ base: `${dev.base}/dav/`, authorization: basicAuth(user, password) });
    const { home } = await dav.discover();
    const out = [];
    for (const cal of await dav.listCalendars(home)) {
        const list = await dav.listEtags(cal.href);
        for (const item of await dav.multiget(cal.href, list.map(x => x.href))) {
            for (const m of String(item.data).matchAll(/^SUMMARY:(.*)$/gm)) out.push(m[1].trim());
        }
    }
    return out;
}

const itemTexts = page => page.evaluate("[...document.querySelectorAll('#view .item')].map(e => e.textContent)");

try {
    const laptopDevice = await browser.device();
    await laptopDevice.downloadsTo(downloads);
    const laptop = await openApp(laptopDevice);

    // ---- signing in ----------------------------------------------------------------------------------------------------
    await signIn(laptop, 'alice', 'wrong-password');
    const refused = await laptop.waitFor("!document.getElementById('si-error').hidden && document.getElementById('si-error').textContent", { what: 'the error' });
    ok(/not accepted/.test(refused), `a wrong password is refused in plain words (${refused})`);
    await signIn(laptop, 'alice', 'alice-secret-1');
    await laptop.waitFor("!document.getElementById('app').hidden", { what: 'the app after signing in' });
    await laptop.waitFor("document.getElementById('sync-line').className === 'ok'", { timeoutMs: 20000, what: 'the first sync' });
    ok(/^Synced/.test(await laptop.text('#sync-text')), 'after signing in the calendar syncs');
    const build = fs.readFileSync(path.join(root, 'BUILD_NUMBER'), 'utf8').trim();
    eq(await laptop.text('#app-version'), `v${build}`, 'the version shows under the help button');

    // ---- an event made on the laptop is on the box --------------------------------------------------------------------------
    const tomorrow = ymd(1);
    await newEvent(laptop, { title: 'Dentist', date: tomorrow, start: '08:30', end: '09:00', location: 'Damrak 1, Amsterdam' });
    await laptop.waitFor(`[...document.querySelectorAll('[data-date="${tomorrow}"] .chip')].some(c => c.textContent.includes('Dentist'))`,
        { what: 'the new event in the month' });
    eq(await syncNow(laptop), 'ok', 'it is sent with the next sync');
    ok((await serverSummaries()).includes('Dentist'), 'and is on the box');

    // ---- the phone sees it ---------------------------------------------------------------------------------------------------
    const phoneDevice = await browser.device();
    const phone = await openApp(phoneDevice, { phone: true });
    await signIn(phone, 'alice', 'alice-secret-1');
    await phone.waitFor("document.getElementById('sync-line').className === 'ok'", { timeoutMs: 20000, what: 'the phone\'s first sync' });
    await phone.waitFor(`document.querySelector('.month [data-date="${tomorrow}"] .dots i')`, { what: 'a dot on tomorrow' });
    await phone.click(`.month [data-date="${tomorrow}"]`);
    await phone.waitFor(`document.querySelector('[data-agenda="${tomorrow}"]') && document.querySelector('[data-agenda="${tomorrow}"]').textContent.includes('Dentist')`,
        { what: 'the chosen day under the month' });
    ok((await phone.text(`[data-agenda="${tomorrow}"]`)).includes('08:30 - 09:00'), 'on the phone, tapping the day lists it with its times (24-hour clock for en-GB)');
    await phone.screenshot(path.join(shots, 'phone-month.png'));

    // ---- changed on the phone, seen on the laptop -------------------------------------------------------------------------------
    await phone.click(`[data-agenda="${tomorrow}"] .item`, 'Dentist');
    await phone.waitFor("document.getElementById('detailsOverlay').classList.contains('open')", { what: 'the details' });
    const details = await phone.text('#detailsPanel');
    ok(details.includes('Damrak 1, Amsterdam') && details.includes('Google Maps') && details.includes('15 minutes before'),
       'the details show the place with map links and the reminder a new event gets');
    await phone.screenshot(path.join(shots, 'phone-details.png'));
    await phone.click('#detailsPanel [data-action="edit"]');
    await phone.waitFor("document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor on the phone' });
    await phone.fill('#ed-summary', 'Dentist (check-up)');
    await phone.fill('#ed-start-time', '10:00');
    eq(await phone.evaluate("document.getElementById('ed-end-time').value"), '10:30', 'moving the start moves the end with it (still half an hour)');
    await phone.screenshot(path.join(shots, 'phone-editor.png'));
    await phone.click('#ed-save');
    await phone.waitFor("!document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor to close' });
    eq(await syncNow(phone), 'ok', 'the phone sends the change');
    eq(await syncNow(laptop), 'ok', 'the laptop syncs');
    await laptop.waitFor(`[...document.querySelectorAll('[data-date="${tomorrow}"] .chip')].some(c => c.textContent.includes('10:00') && c.textContent.includes('Dentist (check-up)'))`,
        { what: 'the change on the laptop' });
    ok(true, 'the laptop shows the change made on the phone');

    // ---- offline -------------------------------------------------------------------------------------------------------------------
    dev.offline.dav = true;
    await newEvent(laptop, { title: 'Written offline', date: ymd(2), start: '12:00', end: '13:00' });
    eq(await syncNow(laptop), 'offline', 'with the box out of reach the sync says it is offline');
    ok(/Offline: 1 change/.test(await laptop.text('#sync-text')), `and that one change waits on this device (${await laptop.text('#sync-text')})`);
    ok(await laptop.evaluate(`[...document.querySelectorAll('[data-date="${ymd(2)}"] .chip')].some(c => c.textContent.includes('Written offline') && c.classList.contains('pending'))`),
       'the event shows at once, marked as not yet on the box');
    dev.offline.all = true;
    await laptop.reload();
    await laptop.waitFor("!document.getElementById('app').hidden && document.querySelectorAll('.month .day').length > 27", { timeoutMs: 15000, what: 'the app to open with no connection' });
    await laptop.waitFor(`[...document.querySelectorAll('[data-date="${ymd(2)}"] .chip')].some(c => c.textContent.includes('Written offline'))`,
        { what: 'the offline event after reopening' });
    ok(true, 'with no connection at all the app still opens (from the offline shell) with its copy and the waiting change');
    dev.offline.all = false;
    dev.offline.dav = false;
    eq(await syncNow(laptop), 'ok', 'back online the waiting change is sent');
    ok((await serverSummaries()).includes('Written offline'), 'and is on the box');
    eq(await syncNow(phone), 'ok', 'the phone syncs');
    await phone.waitFor(`document.querySelector('.month [data-date="${ymd(2)}"] .dots i')`, { what: 'the offline event on the phone' });
    ok(true, 'the phone gets the change made offline on the laptop');

    // ---- a repeating event, changed from its third time on --------------------------------------------------------------------------
    const today = ymd(0);
    await newEvent(laptop, { title: 'Yoga', date: today, start: '18:00', end: '19:00', repeat: 'weekly', count: 6 });
    await laptop.click('.view-switch button[data-view="list"]');
    await laptop.waitFor("[...document.querySelectorAll('#view .item')].filter(e => e.textContent.includes('Yoga')).length >= 5", { what: 'Yoga in the list' });
    await laptop.evaluate("[...document.querySelectorAll('#view .item')].filter(e => e.textContent.includes('Yoga'))[2].click()");
    await laptop.waitFor("document.getElementById('detailsOverlay').classList.contains('open')", { what: 'the third Yoga' });
    ok((await laptop.text('#detailsPanel')).includes('Every week on Thursday'.replace('Thursday', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${today}T12:00:00Z`).getUTCDay()]))
       && (await laptop.text('#detailsPanel')).includes('6 times'), 'its details say how it repeats');
    await laptop.click('#detailsPanel [data-action="edit"]');
    await laptop.waitFor("document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor' });
    await laptop.fill('#ed-start-time', '19:00');
    await laptop.click('#ed-save');
    await laptop.waitFor("document.getElementById('scopeOverlay').classList.contains('open')", { what: 'the question which events change' });
    const scopeText = await laptop.text('#scopePanel');
    ok(scopeText.includes('Only this event') && scopeText.includes('This and the following events') && scopeText.includes('All events in the series'),
       'saving a repeating event asks: only this one, this and the following, or all');
    await laptop.click('#scopePanel [data-choice="following"]');
    await laptop.waitFor("!document.getElementById('editorOverlay').classList.contains('open')", { what: 'the editor to close' });
    await laptop.click('#view .more-btn', 'more days');
    await laptop.waitFor("[...document.querySelectorAll('#view .item')].filter(e => e.textContent.includes('Yoga') && e.textContent.includes('19:00 - 20:00')).length === 4",
        { what: 'four Yoga at 19:00' });
    const yogaTimes = (await itemTexts(laptop)).filter(t => t.includes('Yoga')).map(t => t.slice(0, 13));
    eq(yogaTimes, ['18:00 - 19:00', '18:00 - 19:00', '19:00 - 20:00', '19:00 - 20:00', '19:00 - 20:00', '19:00 - 20:00'],
       'the first two stay at 18:00, the other four move to 19:00, still six in all');
    eq(await syncNow(laptop), 'ok', 'sent');
    eq((await serverSummaries()).filter(s => s === 'Yoga').length, 2, 'on the box as two events: the series until the change, and the rest');

    // ---- deleting, and undoing it ------------------------------------------------------------------------------------------------
    await laptop.click('#view .item', 'Written offline');
    await laptop.waitFor("document.getElementById('detailsOverlay').classList.contains('open')", { what: 'the details' });
    await laptop.click('#detailsPanel [data-action="delete"]');
    await laptop.waitFor("!(document.querySelector('#view') .textContent.includes('Written offline'))", { what: 'the event to go' });
    await laptop.click('.toast button', 'Undo');
    await laptop.waitFor("document.querySelector('#view').textContent.includes('Written offline')", { what: 'the event to come back' });
    ok(true, 'a deleted event comes back with Undo');
    await laptop.evaluate("[...document.querySelectorAll('#view .item')].filter(e => e.textContent.includes('Yoga'))[1].click()");
    await laptop.waitFor("document.getElementById('detailsOverlay').classList.contains('open')", { what: 'the second Yoga' });
    await laptop.click('#detailsPanel [data-action="delete"]');
    await laptop.waitFor("document.getElementById('scopeOverlay').classList.contains('open')", { what: 'the question which to delete' });
    await laptop.click('#scopePanel [data-choice="one"]');
    await laptop.waitFor("[...document.querySelectorAll('#view .item')].filter(e => e.textContent.includes('Yoga')).length === 5", { what: 'one Yoga fewer' });
    ok(true, 'deleting one time of a repeating event leaves the others');
    eq(await syncNow(laptop), 'ok', 'sent');

    // ---- a reminder ----------------------------------------------------------------------------------------------------------------
    const dav = new DavClient({ base: `${dev.base}/dav/`, authorization: basicAuth('alice', 'alice-secret-1') });
    const personal = (await dav.listCalendars((await dav.discover()).home))[0].href;
    const startsAt = new Date(Date.now() + 15 * 60000 + 8000);
    const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    await dav.put(`${personal}reminder-test.ics`, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Phone//EN', 'BEGIN:VEVENT', 'UID:reminder-test',
        `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(startsAt)}`, `DTEND:${stamp(new Date(startsAt.getTime() + 1800000))}`, 'SUMMARY:Call the bank',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'), { create: true });
    eq(await syncNow(laptop), 'ok', 'an event with a reminder made on another device arrives');
    const reminder = await laptop.waitFor("[...document.querySelectorAll('.toast.reminder')].map(t => t.textContent).find(t => t.includes('Call the bank'))",
        { timeoutMs: 30000, what: 'the reminder' });
    ok(/Starts in 15 minutes/.test(reminder), `its reminder shows in the app when it goes off (${reminder})`);

    // ---- import and export ------------------------------------------------------------------------------------------------------------
    const fixture = path.join(downloads, 'from-google.ics');
    fs.writeFileSync(fixture, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Old calendar',
        'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
        'BEGIN:VEVENT', 'UID:7kq3@google.com', 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=Europe/Amsterdam:${ymd(3).replace(/-/g, '')}T070000`,
        `DTEND;TZID=Europe/Amsterdam:${ymd(3).replace(/-/g, '')}T080000`, 'RRULE:FREQ=WEEKLY', 'SUMMARY:Imported run', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:hol@google.com', 'DTSTAMP:20260101T000000Z', `DTSTART;VALUE=DATE:${ymd(4).replace(/-/g, '')}`, 'SUMMARY:Imported holiday', 'END:VEVENT',
        'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:A to-do', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n'));
    await laptop.click('#settingsBtn');
    await laptop.waitFor("document.getElementById('settingsOverlay').classList.contains('open')", { what: 'settings' });
    await laptop.setFiles('#st-import-file', [fixture]);
    await laptop.click('#st-import');
    const imported = await laptop.waitFor("/added/.test(document.getElementById('st-import-result').textContent) && document.getElementById('st-import-result').textContent",
        { what: 'the import result' });
    ok(/^2 added, 0 updated, 1 to-do or other item left out/.test(imported), `an export from Google comes in: two events, the to-do left out (${imported})`);
    await laptop.click('#st-import');
    const again = await laptop.waitFor("/already/.test(document.getElementById('st-import-result').textContent) && document.getElementById('st-import-result').textContent",
        { what: 'the second import' });
    ok(/^0 added, 0 updated, 2 already the same/.test(again), `importing the same file again adds nothing twice (${again})`);
    await laptop.screenshot(path.join(shots, 'laptop-settings.png'));
    await laptop.click('#settingsPanel .cal-row button', '.ics');
    let exported = null;
    for (let i = 0; i < 50 && !exported; i++) {
        const file = fs.readdirSync(downloads).find(f => f.endsWith('.ics') && f !== 'from-google.ics');
        if (file) exported = fs.readFileSync(path.join(downloads, file), 'utf8');
        else await sleep(100);
    }
    ok(exported && /^BEGIN:VCALENDAR/.test(exported) && exported.includes('SUMMARY:Imported run') && exported.includes('SUMMARY:Dentist (check-up)')
       && exported.includes('BEGIN:VTIMEZONE'), 'a calendar downloads as one .ics file with its events and time zones');
    await laptop.click('[data-close="settingsOverlay"]');
    eq(await syncNow(laptop), 'ok', 'the imported events are sent');
    const onServer = await serverSummaries();
    ok(onServer.includes('Imported run') && onServer.includes('Imported holiday'), 'and are on the box');

    // ---- two tabs on one device --------------------------------------------------------------------------------------------------------
    const secondTab = await openApp(laptopDevice);
    await secondTab.waitFor("!document.getElementById('app').hidden", { what: 'the second tab, already signed in' });
    await newEvent(secondTab, { title: 'From the other tab', date: ymd(5), start: '15:00', end: '16:00' });
    await laptop.front();
    await laptop.waitFor("document.querySelector('#view').textContent.includes('From the other tab')", { what: 'the first tab to show it' });
    ok(true, 'an event added in one tab shows in the other without reloading');

    // ---- the views, for the eye --------------------------------------------------------------------------------------------------------
    await laptop.click('.view-switch button[data-view="week"]');
    await sleep(400);
    await laptop.screenshot(path.join(shots, 'laptop-week.png'));
    await laptop.click('.view-switch button[data-view="month"]');
    await sleep(400);
    await laptop.screenshot(path.join(shots, 'laptop-month.png'));
    await phone.click('.view-switch button[data-view="week"]');
    await sleep(400);
    await phone.screenshot(path.join(shots, 'phone-week.png'));
    const columns = await phone.evaluate("document.querySelectorAll('.tl-col').length");
    eq(columns, 3, 'on a phone the week view shows three days');

    // ---- the box loses events: the laptop kept a copy and puts it back --------------------------------------------------------------------
    // (The second tab is closed first, so no sync of it sees the box halfway through losing them.)
    await secondTab.conn.send('Page.close').catch(() => {});
    pages.splice(pages.indexOf(secondTab), 1);
    secondTab.close();
    // Everything is on the box first; then the four go at once as far as the laptop can tell (it
    // cannot reach the box while they go).
    await laptop.front();
    eq(await syncNow(laptop), 'ok', 'all is on the box');
    const lost = ['Imported holiday', 'Imported run', 'From the other tab', 'Written offline'];
    dev.offline.dav = true;
    const direct = new DavClient({ base: dev.radicale.base, authorization: basicAuth('alice', 'alice-secret-1') });
    const personalDirect = personal.replace(/^\/dav/, '');
    const listing = await direct.listEtags(personalDirect);
    for (const item of await direct.multiget(personalDirect, listing.map(x => x.href))) {
        const summary = (/^SUMMARY:(.*)$/m.exec(item.data) || [])[1];
        if (summary && lost.includes(summary.trim())) await direct.remove(item.href);
    }
    dev.offline.dav = false;
    const remaining = await serverSummaries();
    ok(lost.every(s => !remaining.includes(s)), 'four events vanish from the box (a disk replaced without its backup, say)');
    await laptop.front();
    eq(await syncNow(laptop), 'ok', 'the laptop syncs with the box as it now is');
    const notice = await laptop.waitFor("!document.getElementById('notice').hidden && document.getElementById('notice').textContent",
        { what: 'the notice about the kept copy' });
    ok(/4 events of "Personal" went from the box at once/.test(notice) && /kept a copy/.test(notice), `the laptop says so, and that it kept a copy (${notice.slice(0, 120)})`);
    await laptop.click('#notice button', 'Look at the copy');
    await laptop.waitFor("document.getElementById('settingsOverlay').classList.contains('open') && document.querySelector('[data-kept] [data-action=\"restore\"]')",
        { what: 'the kept copy in settings' });
    await laptop.click('[data-kept] [data-action="restore"]');
    await laptop.waitFor("!document.querySelector('[data-kept]')", { what: 'the copy to be used' });
    await laptop.click('[data-close="settingsOverlay"]');
    eq(await syncNow(laptop), 'ok', 'putting them back is a sync away');
    const afterRestore = await serverSummaries();
    ok(lost.every(s => afterRestore.includes(s)), 'and the four are on the box again');

    // ---- signing out ---------------------------------------------------------------------------------------------------------------------
    await laptop.click('#settingsBtn');
    await laptop.click('#st-signout');
    await laptop.waitFor("document.getElementById('scopeOverlay').classList.contains('open')", { what: 'the sign-out question' });
    await laptop.click('#scopePanel [data-choice="out"]');
    await sleep(1500);
    await laptop.waitFor("!document.getElementById('signin').hidden", { what: 'the sign-in screen after signing out' });
    const left = await laptop.evaluate("new Promise(r => { const q = indexedDB.open('myai-calendar'); q.onsuccess = () => { const db = q.result; const t = db.transaction('objects').objectStore('objects').count(); t.onsuccess = () => r(t.result); }; })");
    eq(left, 0, 'signing out removes this device\'s copy');
    ok((await serverSummaries()).includes('From the other tab'), 'and leaves the calendar on the box');

    const errors = pages.flatMap(p => p.errors);
    eq(errors, [], 'no errors in any page');
} catch (err) {
    console.error(err);
    for (const [i, page] of pages.entries()) {
        try { await page.screenshot(path.join(shots, `failure-${i}.png`)); } catch (_) {}
        console.error(`page ${i} errors:`, page.errors, page.console.slice(-10));
    }
    ok(false, `the browser journey stopped: ${err.message}`);
} finally {
    for (const page of pages) page.close();
    await browser.close();
    await dev.stop();
    fs.rmSync(downloads, { recursive: true, force: true });
}

finish();
