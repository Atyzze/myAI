// The sync engine against a calendar server double that answers the way other CalDAV servers do
// where Radicale does not: a PUT to a deleted event answered with 404 rather than 412, no
// sync-collection (only a full listing), a create whose answer gets lost. The engine must keep the
// person's changes in each case.
import { suite } from '../helpers/check.mjs';

const { DavError } = await import('../../src/js/caldav.js');
const { SyncEngine } = await import('../../src/js/sync.js');
const { MemoryStore } = await import('../../src/js/store.js');
const model = await import('../../src/js/event-model.js');
const tz = await import('../../src/js/tz.js');

const { ok, eq, finish } = suite('sync-fake');
const AMS = tz.ianaZone('Europe/Amsterdam');

// One calendar, its items, and a log of changes for sync tokens.
class FakeServer {
    constructor({ missingPut = 404, syncCollection = true } = {}) {
        this.missingPut = missingPut;
        this.syncCollectionSupported = syncCollection;
        this.items = new Map();
        this.version = 1;
        this.log = [];
        this.etagCounter = 1;
        this.calendar = { href: '/u/cal/', name: 'Personal', color: '#4caf50', components: ['VEVENT'], readOnly: false, order: 0 };
        this.loseNextPutAnswer = false;
        this.requests = [];
    }
    touch(href) { this.version++; this.log.push({ version: this.version, href }); }
    client() {
        const server = this;
        const fail = (status, message) => {
            const kind = status === 412 ? 'conflict' : status === 404 ? 'gone' : status === 501 ? 'unsupported' : 'refused';
            return new DavError(message, { status, kind });
        };
        return {
            async discover() { return { principal: '/u/', home: '/u/' }; },
            async listCalendars() {
                if (server.calendarGone) return [];
                return [{ ...server.calendar, ctag: `"c${server.version}"`, syncToken: server.syncCollectionSupported ? `t${server.version}` : null }];
            },
            async syncCollection(href, token) {
                server.requests.push('REPORT sync-collection');
                if (!server.syncCollectionSupported) throw fail(501, 'not supported');
                const since = token ? Number(String(token).slice(1)) : 0;
                if (since > server.version) throw new DavError('The sync token expired.', { status: 403, kind: 'invalid-token' });
                const touched = new Set(server.log.filter(e => e.version > since).map(e => e.href));
                const changed = [];
                const removed = [];
                for (const h of (token ? touched : server.items.keys())) {
                    if (server.items.has(h)) changed.push({ href: h, etag: server.items.get(h).etag });
                    else removed.push(h);
                }
                return { token: `t${server.version}`, changed, removed };
            },
            async listEtags() {
                server.requests.push('PROPFIND etags');
                return [...server.items].map(([href, item]) => ({ href, etag: item.etag }));
            },
            async multiget(href, hrefs) {
                return hrefs.map(h => (server.items.has(h) ? { href: h, status: 200, ...server.items.get(h) } : { href: h, status: 404, etag: '', data: null }));
            },
            async get(href) { return server.items.has(href) ? { ...server.items.get(href) } : null; },
            async put(href, data, { etag = null, create = false } = {}) {
                server.requests.push(`PUT ${etag ? 'if-match' : create ? 'if-none-match' : ''}`);
                const existing = server.items.get(href);
                if (etag && !existing) throw fail(server.missingPut, 'Saving the event failed');
                if (etag && existing.etag !== etag) throw fail(412, 'changed elsewhere');
                if (create && existing) throw fail(412, 'exists');
                const item = { etag: `"e${server.etagCounter++}"`, data };
                server.items.set(href, item);
                server.touch(href);
                if (server.loseNextPutAnswer) {
                    server.loseNextPutAnswer = false;
                    throw new DavError('The calendar server cannot be reached.', { kind: 'offline' });
                }
                return { etag: item.etag };
            },
            async remove(href, { etag = null } = {}) {
                const existing = server.items.get(href);
                if (!existing) throw fail(404, 'gone');
                if (etag && existing.etag !== etag) throw fail(412, 'changed elsewhere');
                server.items.delete(href);
                server.touch(href);
                return true;
            },
            async mkcalendar() { return true; },
            async proppatch() { return true; },
            async removeCollection() { return true; }
        };
    }
}

let clock = Date.UTC(2026, 9, 8, 10, 0, 0);
const device = server => {
    const store = new MemoryStore();
    return { store, engine: new SyncEngine({ dav: server.client(), store, now: () => clock }) };
};
const event = (uid, summary) => model.createEvent({ ...model.blankForm({ date: '2026-10-20', hour: 9, zoneId: 'Europe/Amsterdam' }), summary },
    { uid, nowMs: clock, viewerZone: AMS });
const edit = (text, summary) => {
    const form = model.formFromOccurrence(text, null, AMS);
    return model.updateEvent(text, { ...form, summary }, { nowMs: clock, viewerZone: AMS });
};
const summaries = async store => (await store.listObjects()).map(o => (/SUMMARY:(.*)\r\n/.exec(o.data) || [])[1]).sort();

// ---- an event edited here and deleted elsewhere, on a server that answers 404 ---------------------------------
for (const missingPut of [404, 412]) {
    const server = new FakeServer({ missingPut });
    const phone = device(server);
    const laptop = device(server);
    await phone.engine.sync();
    const e = event('gym', 'Gym');
    const href = await phone.engine.saveEvent({ calendar: '/u/cal/', data: e.text, uid: e.uid });
    await phone.engine.sync();
    await laptop.engine.sync();
    clock += 60000;
    await laptop.engine.saveEvent({ href, calendar: '/u/cal/', data: edit(e.text, 'Gym (legs)') });
    clock += 60000;
    await phone.engine.deleteEvent(href);
    await phone.engine.sync();
    eq(server.items.has(href), false, `(${missingPut}) deleted on the phone`);
    const result = await laptop.engine.sync();
    eq(result.error, null, `(${missingPut}) the laptop's sync goes through`);
    ok(server.items.has(href) && /SUMMARY:Gym \(legs\)/.test(server.items.get(href).data),
       `an event edited on one device and deleted on another is put back with the edit, also when the server answers ${missingPut}`);
}

// ---- a server without sync-collection -------------------------------------------------------------------------------------
{
    const server = new FakeServer({ syncCollection: false });
    const a = device(server);
    const b = device(server);
    await a.engine.sync();
    for (const [uid, summary] of [['one', 'One'], ['two', 'Two'], ['three', 'Three']]) {
        const e = event(uid, summary);
        await a.engine.saveEvent({ calendar: '/u/cal/', data: e.text, uid: e.uid });
    }
    eq((await a.engine.sync()).error, null, 'without sync-collection the sync still goes through');
    eq((await b.engine.sync()).fetched, 3, 'the other device fetches the events from a full listing');
    await a.engine.deleteEvent('/u/cal/two.ics');
    await a.engine.sync();
    const again = await b.engine.sync();
    eq([again.removed, await summaries(b.store)], [1, ['One', 'Three']], 'and notices one deleted elsewhere');
    const quiet = await b.engine.sync();
    eq([quiet.fetched, quiet.removed], [0, 0], 'a sync with nothing new fetches nothing (the calendar tag did not change)');
    ok(server.requests.includes('PROPFIND etags'), 'it lists the calendar instead of asking for changes');
}

// ---- a create whose answer was lost ------------------------------------------------------------------------------------------
{
    const server = new FakeServer();
    const a = device(server);
    await a.engine.sync();
    const e = event('lost', 'Answer lost');
    await a.engine.saveEvent({ calendar: '/u/cal/', data: e.text, uid: e.uid });
    server.loseNextPutAnswer = true;
    const first = await a.engine.sync();
    eq(first.error && first.error.kind, 'offline', 'the connection drops after the server stored the event');
    eq((await a.store.listOutbox()).length, 1, 'so the change stays queued');
    const second = await a.engine.sync();
    eq(second.error, null, 'the next sync goes through');
    eq([(await a.store.listOutbox()).length, server.items.size, (await summaries(a.store))], [0, 1, ['Answer lost']],
       'and the event is there once, nothing left to send');
    eq(server.requests.filter(r => r.startsWith('PUT')), ['PUT if-none-match', 'PUT if-none-match'],
       'it recognises the event already arrived, and does not write it a second time (other devices would fetch it again)');
}

// ---- a change the server refuses outright ---------------------------------------------------------------------------------------
{
    const server = new FakeServer();
    const a = device(server);
    await a.engine.sync();
    const client = server.client();
    server.client = () => ({ ...client, put: async () => { throw new DavError('Saving the event failed: the server answered 403.', { status: 403, kind: 'refused' }); } });
    const refusing = device(server);
    await refusing.engine.sync();
    const e = event('nope', 'Refused');
    await refusing.engine.saveEvent({ calendar: '/u/cal/', data: e.text, uid: e.uid });
    const result = await refusing.engine.sync();
    eq(result.error, null, 'a refused change does not stop the sync');
    const problems = await refusing.store.getMeta('problems');
    ok(problems && /Not saved/.test(problems[0].message) && problems[0].summary === 'Refused', 'it is noted by its title');
}

// ---- the server loses events: the device keeps a copy to put back --------------------------------------------------------
{
    const { worthKeeping } = await import('../../src/js/sync.js');
    eq([worthKeeping(2, 12), worthKeeping(3, 12), worthKeeping(3, 4), worthKeeping(9, 400), worthKeeping(10, 400), worthKeeping(0, 0)],
       [false, true, true, false, true, false], 'a copy is kept when 3 or more go from a small calendar, a quarter of a bigger one, or 10 at once');

    const server = new FakeServer();
    const phone = device(server);
    const other = device(server);
    await phone.engine.sync();
    for (let i = 1; i <= 12; i++) {
        const e = event(`life-${i}`, `Appointment ${i}`);
        await phone.engine.saveEvent({ calendar: '/u/cal/', data: e.text, uid: e.uid });
    }
    await phone.engine.sync();
    await other.engine.sync();
    await other.engine.deleteEvent('/u/cal/life-1.ics');
    await other.engine.deleteEvent('/u/cal/life-2.ics');
    await other.engine.sync();
    await phone.engine.sync();
    eq([(await phone.store.listObjects()).length, (await phone.engine.keptCopies()).length], [10, 0],
       'two events deleted on another device just go: no copy for ordinary deletes');

    // The box's disk is replaced and nothing restored: the server starts over, empty.
    server.items.clear();
    server.log = [];
    server.version = 1;
    const wiped = await phone.engine.sync();
    eq(wiped.error, null, 'the sync after the loss goes through');
    const copies = await phone.engine.keptCopies();
    eq([(await phone.store.listObjects()).length, copies.length, copies[0] && copies[0].items.length, copies[0] && copies[0].reason],
       [0, 1, 10, 'events'], 'the device follows the server, but keeps a copy of the ten events that went');
    if (copies[0]) {
        const back = await phone.engine.restoreCopy(copies[0].id, '/u/cal/');
        eq(back, { restored: 10, skipped: 0 }, 'putting the copy back sends all ten again');
        eq((await phone.engine.sync()).error, null, 'with the next sync');
        eq([server.items.size, (await phone.engine.keptCopies()).length], [10, 0], 'the server has them again, and the copy is used up');
    }

    server.calendarGone = true;
    await phone.engine.sync();
    const gone = await phone.engine.keptCopies();
    eq([gone.length, gone[0] && gone[0].reason, gone[0] && gone[0].calendar.name, gone[0] && gone[0].items.length], [1, 'calendar', 'Personal', 10],
       'a whole calendar gone from the server is kept too, with its name');
    if (gone[0]) {
        await phone.engine.discardCopy(gone[0].id);
        eq((await phone.engine.keptCopies()).length, 0, 'and a copy that is not wanted can be thrown away');
    }
}

finish();
