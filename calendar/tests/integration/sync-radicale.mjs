// The sync engine against a real Radicale, with two devices (two engines, each with its own local
// copy) signed in to the same account: what one does, the other sees; changes made offline arrive
// later; a change that meets a newer one is settled by which was made later; an event edited on
// one device and deleted on the other is not lost; another app's event is edited without losing what
// that app stored in it.
import { suite } from '../helpers/check.mjs';
import { startRadicale } from '../helpers/radicale.mjs';
import { strictTests } from '../helpers/strict.mjs';

const { DavClient, basicAuth, DavError } = await import('../../src/js/caldav.js');
const { SyncEngine, resourceName } = await import('../../src/js/sync.js');
const { MemoryStore } = await import('../../src/js/store.js');
const model = await import('../../src/js/event-model.js');
const occ = await import('../../src/js/occurrences.js');
const tz = await import('../../src/js/tz.js');
const ical = await import('../../src/js/icalendar.js');

const { ok, eq, finish } = suite('sync-radicale');
const server = await startRadicale();
if (!server) {
    const message = 'Radicale not found (set MYAI_RADICALE_PYTHON); the sync suite cannot run.';
    if (strictTests()) { console.error(message); process.exit(1); }
    console.log(`↷ ${message}`);
    console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: 'sync-radicale', status: 'skip', reason: message })}`);
    process.exit(0);
}

const AMS = tz.ianaZone('Europe/Amsterdam');
let clock = Date.UTC(2026, 9, 8, 10, 0, 0);
const now = () => clock;

function device(user, password, { onlineRef = { on: true } } = {}) {
    const fetchFn = (url, init) => {
        if (!onlineRef.on) return Promise.reject(new TypeError('Failed to fetch'));
        return fetch(url, init);
    };
    const dav = new DavClient({ base: server.base, authorization: basicAuth(user, password), fetchFn, timeoutMs: 15000 });
    const store = new MemoryStore();
    const changes = [];
    const engine = new SyncEngine({ dav, store, now, onChange: c => changes.push(c) });
    return { dav, store, engine, online: onlineRef, changes };
}

const eventsOf = async (dev, from = Date.UTC(2026, 9, 1), to = Date.UTC(2026, 11, 31)) => {
    const out = [];
    for (const obj of await dev.store.listObjects()) {
        const s = occ.readSeries(obj.data, { href: obj.href, calendar: obj.calendar });
        if (s) out.push(...occ.expandSeries(s, from, to, AMS));
    }
    return out.sort((a, b) => a.startUtc - b.startUtc);
};

const form = (summary, date, hour, extra = {}) => ({
    ...model.blankForm({ date, hour, zoneId: 'Europe/Amsterdam', defaults: { durationMinutes: 60 } }), summary, ...extra
});

try {
    const phone = device('alice', 'alice-secret-1', { onlineRef: { on: true } });
    const laptop = device('alice', 'alice-secret-1', { onlineRef: { on: true } });

    // ---- signing in -------------------------------------------------------------------------------
    const wrong = new DavClient({ base: server.base, authorization: basicAuth('alice', 'not-her-password') });
    let refused = null;
    try { await wrong.discover(); } catch (err) { refused = err; }
    ok(refused instanceof DavError && refused.kind === 'auth', 'a wrong password is refused as such, not as a server failure');

    const first = await phone.engine.sync();
    eq(first.error, null, `the first sync succeeds (${first.error && first.error.message})`);
    const calendars = await phone.store.listCalendars();
    ok(calendars.length === 1 && calendars[0].name === 'Personal' && calendars[0].color === '#4caf50',
       `an account without a calendar gets one, "Personal" (${JSON.stringify(calendars.map(c => c.name))})`);
    const home = (await phone.store.getMeta('account')).home;
    eq(home, '/alice/', 'the calendar home is found through the principal');
    const personal = calendars[0].href;

    const bobDav = new DavClient({ base: server.base, authorization: basicAuth('bob', 'bob-secret-22') });
    let peek = null;
    try { await bobDav.listCalendars('/alice/'); } catch (err) { peek = err; }
    ok(peek instanceof DavError && peek.status === 403 || (peek && peek.kind === 'refused'),
       `another account cannot read Alice's calendars (${peek && peek.status})`);

    // ---- one device creates, the other sees ---------------------------------------------------------
    clock += 1000;
    const dentist = model.createEvent(form('Tandarts', '2026-10-12', 9, { location: 'Dam 1', alarms: [-3600] }), { uid: 'dentist-1', nowMs: clock, viewerZone: AMS });
    const dentistHref = await phone.engine.saveEvent({ calendar: personal, data: dentist.text, uid: dentist.uid });
    eq(dentistHref, `${personal}dentist-1.ics`, 'a new event is stored under its UID');
    eq((await phone.store.listOutbox()).length, 1, 'it waits in the outbox until a sync');
    const pushed = await phone.engine.sync();
    ok(pushed.pushed === 1 && (await phone.store.listOutbox()).length === 0, 'a sync sends it and empties the outbox');
    await laptop.engine.sync();
    eq((await eventsOf(laptop)).map(e => e.summary), ['Tandarts'], 'the other device has it after its own sync');

    // ---- the other device edits, the first sees the edit -------------------------------------------------
    clock += 60000;
    const onLaptop = (await eventsOf(laptop))[0];
    const lf = model.formFromOccurrence((await laptop.store.getObject(onLaptop.href)).data, onLaptop, AMS);
    lf.startTime = '10:00'; lf.endTime = '11:00';
    await laptop.engine.saveEvent({ href: onLaptop.href, calendar: personal, data: model.updateEvent((await laptop.store.getObject(onLaptop.href)).data, lf, { occurrence: onLaptop, nowMs: clock, viewerZone: AMS }), uid: 'dentist-1' });
    await laptop.engine.sync();
    const beforeEtag = (await phone.store.getObject(dentistHref)).etag;
    const second = await phone.engine.sync();
    eq((await eventsOf(phone)).map(e => new Date(e.startUtc).toISOString().slice(11, 16)), ['08:00'], 'the move to 10:00 reaches the first device');
    ok(second.fetched === 1 && (await phone.store.getObject(dentistHref)).etag !== beforeEtag, 'it fetched just that one event');
    const quiet = await phone.engine.sync();
    eq([quiet.fetched, quiet.pushed], [0, 0], 'a sync with nothing new fetches and sends nothing');

    // ---- offline ---------------------------------------------------------------------------------------------
    phone.online.on = false;
    clock += 60000;
    const gym = model.createEvent(form('Gym', '2026-10-13', 19, { repeat: { freq: 'WEEKLY', interval: 1, byday: ['TU'], ends: 'count', count: 4 } }), { uid: 'gym-1', nowMs: clock, viewerZone: AMS });
    const gymHref = await phone.engine.saveEvent({ calendar: personal, data: gym.text, uid: gym.uid });
    clock += 1000;
    const gymOcc = (await eventsOf(phone)).find(e => e.summary === 'Gym');
    const gf = model.formFromOccurrence(gym.text, gymOcc, AMS);
    gf.summary = 'Gym (legs)';
    await phone.engine.saveEvent({ href: gymHref, calendar: personal, data: model.updateEvent(gym.text, gf, { occurrence: gymOcc, nowMs: clock, viewerZone: AMS }), uid: 'gym-1' });
    eq((await phone.store.listOutbox()).length, 1, 'two changes to an event made offline wait as one');
    eq((await eventsOf(phone)).filter(e => e.summary === 'Gym (legs)').length, 4, 'and the device shows the latest at once, all four Tuesdays');
    const offline = await phone.engine.sync();
    ok(offline.error && offline.error.kind === 'offline' && phone.engine.status.state === 'offline', 'a sync without a connection says it is offline');
    eq((await phone.store.listOutbox()).length, 1, 'and keeps the change');
    phone.online.on = true;
    await phone.engine.sync();
    await laptop.engine.sync();
    eq((await eventsOf(laptop)).filter(e => e.summary.startsWith('Gym')).map(e => e.summary), ['Gym (legs)', 'Gym (legs)', 'Gym (legs)', 'Gym (legs)'],
       'back online, the latest version reaches the other device, once');

    // ---- create and delete before any sync --------------------------------------------------------------------
    phone.online.on = false;
    const tmp = model.createEvent(form('Oops', '2026-10-20', 8), { uid: 'oops-1', nowMs: clock, viewerZone: AMS });
    const tmpHref = await phone.engine.saveEvent({ calendar: personal, data: tmp.text, uid: tmp.uid });
    await phone.engine.deleteEvent(tmpHref);
    eq((await phone.store.listOutbox()).length, 0, 'an event made and deleted offline leaves nothing to send');
    phone.online.on = true;

    // ---- both devices change the same event ----------------------------------------------------------------------
    await phone.engine.sync(); await laptop.engine.sync();
    const editOn = async (dev, href, change) => {
        const obj = await dev.store.getObject(href);
        const o = (await eventsOf(dev)).find(e => e.href === href);
        const f = { ...model.formFromOccurrence(obj.data, o, AMS), ...change };
        await dev.engine.saveEvent({ href, calendar: obj.calendar, data: model.updateEvent(obj.data, f, { occurrence: o, nowMs: clock, viewerZone: AMS }), uid: o.uid });
    };
    phone.online.on = false; laptop.online.on = false;
    clock += 60000; await editOn(phone, dentistHref, { summary: 'Tandarts (phone)' });
    clock += 60000; await editOn(laptop, dentistHref, { summary: 'Tandarts (laptop, later)' });
    phone.online.on = true; laptop.online.on = true;
    await phone.engine.sync();
    await laptop.engine.sync();
    await phone.engine.sync();
    eq([(await eventsOf(phone)).find(e => e.href === dentistHref).summary, (await eventsOf(laptop)).find(e => e.href === dentistHref).summary],
       ['Tandarts (laptop, later)', 'Tandarts (laptop, later)'], 'two offline edits of one event: the one made later wins on both devices');

    phone.online.on = false; laptop.online.on = false;
    clock += 60000; await editOn(laptop, dentistHref, { summary: 'Tandarts (laptop, earlier)' });
    clock += 60000; await editOn(phone, dentistHref, { summary: 'Tandarts (phone, later)' });
    laptop.online.on = true; await laptop.engine.sync();
    phone.online.on = true; await phone.engine.sync();
    await laptop.engine.sync();
    eq((await eventsOf(laptop)).find(e => e.href === dentistHref).summary, 'Tandarts (phone, later)',
       'also when the later edit reaches the server second: it is put on top of the earlier one');
    phone.online.on = false; laptop.online.on = false;
    clock += 60000; await editOn(phone, dentistHref, { summary: 'Tandarts (phone, earlier)' });
    clock += 60000; await editOn(laptop, dentistHref, { summary: 'Tandarts (laptop, latest)' });
    laptop.online.on = true; await laptop.engine.sync();
    phone.online.on = true; await phone.engine.sync();
    eq((await eventsOf(phone)).find(e => e.href === dentistHref).summary, 'Tandarts (laptop, latest)',
       'and an earlier edit that arrives after a later one gives way to it');
    const problems = await phone.store.getMeta('problems');
    ok(problems && /later version was kept/.test(problems[0].message) && problems[0].summary === 'Tandarts (phone, earlier)',
       'the edit that gave way is noted, by its title, so it does not vanish silently');

    // ---- edited on one device, deleted on the other ------------------------------------------------------------------
    laptop.online.on = false;
    clock += 60000; await editOn(laptop, gymHref, { location: 'Basic-Fit' });
    clock += 60000; await phone.engine.deleteEvent(gymHref); await phone.engine.sync();
    laptop.online.on = true; await laptop.engine.sync();
    await phone.engine.sync();
    ok((await eventsOf(phone)).some(e => e.href === gymHref && e.location === 'Basic-Fit'),
       'an event edited on one device while deleted on another is put back with the edit, not lost');

    // ---- an event written by another app ---------------------------------------------------------------------------------
    const appleText = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18//EN', 'BEGIN:VEVENT', 'UID:apple-77',
        'DTSTAMP:20261001T080000Z', 'LAST-MODIFIED:20261001T080000Z', 'SUMMARY:Lunch',
        'DTSTART;TZID=Europe/Amsterdam:20261015T123000', 'DTEND;TZID=Europe/Amsterdam:20261015T133000',
        'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Cafe:geo:52.37,4.89',
        'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.org', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    await phone.dav.put(`${personal}apple-77.ics`, appleText, { create: true });
    await laptop.engine.sync();
    clock += 60000; await editOn(laptop, `${personal}apple-77.ics`, { summary: 'Lunch with Bob' });
    await laptop.engine.sync();
    const onServer = await phone.dav.get(`${personal}apple-77.ics`);
    const kept = ical.unfoldLines(onServer.data);
    ok(kept.includes('SUMMARY:Lunch with Bob') && kept.includes('X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Cafe:geo:52.37,4.89')
       && kept.some(l => l.startsWith('ATTENDEE;CN=Bob')),
       `an iPhone event edited here keeps its structured location (both coordinates, with the box's vobject patch) and attendee on the server (${kept.filter(l => /STRUCTURED|ATTENDEE/.test(l)).join(' | ')})`);

    // ---- an expired sync token ----------------------------------------------------------------------------------------------
    const cal = (await phone.store.listCalendars())[0];
    await phone.store.putCalendar({ ...cal, syncedToken: 'http://radicale.org/ns/sync/bogus', syncToken: 'x' });
    const resync = await phone.engine.sync();
    eq(resync.error, null, 'a sync token the server no longer knows leads to a full listing, not an error');
    eq((await eventsOf(phone)).length, (await eventsOf(laptop)).length, 'after which both devices hold the same events');

    // ---- many events at once --------------------------------------------------------------------------------------------------
    for (let i = 0; i < 120; i++) {
        const e = model.createEvent(form(`Bulk ${i}`, `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, 8 + (i % 10)), { uid: `bulk-${i}`, nowMs: clock, viewerZone: AMS });
        await phone.engine.saveEvent({ calendar: personal, data: e.text, uid: e.uid });
    }
    const bulkPush = await phone.engine.sync();
    eq(bulkPush.pushed, 120, 'a hundred and twenty new events are sent in one sync');
    const bulkPull = await laptop.engine.sync();
    eq(bulkPull.fetched, 120, 'and fetched by the other device in one sync (in batches)');

    // ---- a change the server refuses ------------------------------------------------------------------------------------------
    await phone.engine.saveEvent({ calendar: personal, data: 'this is not a calendar', uid: 'broken-1' });
    const refusedSync = await phone.engine.sync();
    eq(refusedSync.error, null, 'a change the server will not take does not stop the sync');
    const problems2 = await phone.store.getMeta('problems');
    ok((await phone.store.listOutbox()).length === 0 && /Not saved/.test(problems2[0].message),
       'it is dropped from the outbox and noted');

    eq(resourceName('weird/uid@example.org').endsWith('.ics') && !resourceName('weird/uid@example.org').includes('/'), true,
       'a UID that is not safe as a file name gets a new one');

    // ---- "this and following" seen from the other device -------------------------------------------------------------
    const yoga = model.createEvent({ ...form('Yoga', '2026-10-06', 18), repeat: { freq: 'WEEKLY', interval: 1, byday: ['TU'], ends: 'count', count: 6 } },
        { uid: 'yoga-1', nowMs: clock, viewerZone: AMS });
    const yogaHref = await phone.engine.saveEvent({ calendar: personal, data: yoga.text, uid: yoga.uid });
    await phone.engine.sync();
    const yogaOccs = occ.expandSeries(occ.readSeries(yoga.text, { href: yogaHref, calendar: personal }), Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 31), AMS);
    const third = yogaOccs[2];
    const yogaForm = { ...model.formFromOccurrence(yoga.text, third, AMS), startTime: '19:00', endTime: '20:00' };
    const yogaBefore = model.endSeriesBefore(yoga.text, third, { nowMs: clock, viewerZone: AMS });
    const yogaRest = model.startSeriesFrom(yoga.text, third, yogaForm, { uid: 'yoga-2', nowMs: clock, viewerZone: AMS });
    await phone.engine.saveEvent({ href: yogaHref, calendar: personal, data: yogaBefore.text });
    await phone.engine.saveEvent({ calendar: personal, data: yogaRest.text, uid: yogaRest.uid });
    eq((await phone.engine.sync()).error, null, 'a series cut in two is sent as two events');
    await laptop.engine.sync();
    eq((await eventsOf(laptop)).filter(o => o.summary === 'Yoga').map(o => new Date(o.startUtc).toISOString().slice(0, 16)),
       ['2026-10-06T16:00', '2026-10-13T16:00', '2026-10-20T17:00', '2026-10-27T18:00', '2026-11-03T18:00', '2026-11-10T18:00'],
       'a weekly class moved to 19:00 from its third time on: the other device has the first two at 18:00 and the other four at 19:00 (through the end of summer time)');

    // ---- a second calendar: made, changed, removed --------------------------------------------------------------------
    const work = await phone.engine.createCalendar({ name: 'Work', color: '#2196f3' });
    await phone.engine.changeCalendar(work, { name: 'Work stuff', color: '#ff9800' });
    const planning = model.createEvent(form('Planning', '2026-10-20', 10), { uid: 'work-1', nowMs: clock, viewerZone: AMS });
    await phone.engine.saveEvent({ calendar: work, data: planning.text, uid: planning.uid });
    eq((await phone.engine.sync()).error, null, 'a new calendar and an event in it are sent');
    await laptop.engine.sync();
    const seenWork = (await laptop.store.listCalendars()).find(c => c.href === work);
    ok(seenWork && seenWork.name === 'Work stuff' && seenWork.color === '#ff9800',
       `a calendar made, renamed and recolored on one device shows so on the other (${JSON.stringify(seenWork)})`);
    eq((await laptop.store.listObjects(work)).length, 1, 'with its event');
    await laptop.engine.deleteCalendar(work);
    ok(!(await laptop.store.listCalendars()).some(c => c.href === work) && (await laptop.store.listObjects(work)).length === 0,
       'removing it takes it and its events off the device that removed it');
    ok(laptop.changes.some(c => c.calendars && c.objects.has(`${work}work-1.ics`)), 'naming the events that went, so the views drop them');
    await phone.engine.sync();
    ok(!(await phone.store.listCalendars()).some(c => c.href === work) && (await phone.store.listObjects(work)).length === 0,
       'and off the other device at its next sync');
    ok((await phone.store.listCalendars()).some(c => c.href === personal), 'the other calendar stays');

    await server.stop();
} catch (err) {
    console.error(err);
    console.error(server.log().slice(-2000));
    await server.stop();
    process.exit(1);
}

finish();
