// Keeping this device's copy and the server in step.
//
// The server is the calendar. A change made here is applied to the local copy at once and queued
// in the outbox; a sync first sends the outbox (each change only on top of the version it was made
// to, by ETag), then asks each calendar what changed since the last sync and fetches just that.
// When a change meets a newer version on the server, the later of the two edits wins and the other
// is noted, so nothing changes silently; an event edited here but deleted elsewhere is put back
// rather than lost.

import { DavError } from './caldav.js';
import { parseCalendar, childComponents, getProp, readDateProp } from './icalendar.js';
import { wallNumber } from './wall.js';
import { newUid } from './event-model.js';

const MULTIGET_BATCH = 40;
const PROBLEMS_KEPT = 20;
const COPIES_KEPT = 5;

// Whether this many events going from a calendar of this size in one sync is more than the usual
// deletes made on another device: then this device keeps a copy before letting them go.
export function worthKeeping(removed, before) {
    if (!removed) return false;
    return removed >= Math.max(3, Math.min(10, Math.ceil(before * 0.25)));
}

export function resourceName(uid) {
    return /^[A-Za-z0-9_-]{1,120}$/.test(String(uid || '')) ? `${uid}.ics` : `${newUid()}.ics`;
}

// The latest LAST-MODIFIED (or DTSTAMP) in an object, as UTC milliseconds; 0 when it has none.
export function lastModifiedOf(data) {
    const vcalendar = parseCalendar(data || '');
    let latest = 0;
    for (const vevent of vcalendar ? childComponents(vcalendar, 'VEVENT') : []) {
        for (const name of ['LAST-MODIFIED', 'DTSTAMP']) {
            const parsed = readDateProp(getProp(vevent, name));
            if (parsed && parsed.values[0].utc) {
                latest = Math.max(latest, wallNumber(parsed.values[0]));
                break;
            }
        }
    }
    return latest;
}

function summaryOf(data) {
    const vcalendar = parseCalendar(data || '');
    const vevent = vcalendar && childComponents(vcalendar, 'VEVENT')[0];
    const prop = vevent && getProp(vevent, 'SUMMARY');
    return prop ? prop.value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ') : '';
}

export function eventCapable(cal) {
    return !cal.components || cal.components.includes('VEVENT');
}

export class SyncEngine {
    constructor({ dav, store, now = () => Date.now(), onChange = () => {}, onStatus = () => {}, defaultCalendar = { name: 'Personal', color: '#4caf50' } }) {
        this.dav = dav;
        this.store = store;
        this.now = now;
        this.onChange = onChange;
        this.onStatus = onStatus;
        this.defaultCalendar = defaultCalendar;
        this.running = null;
        this.status = { state: 'idle', message: '', lastSyncAt: null, pending: 0 };
    }

    async setStatus(state, message = '') {
        const pending = (await this.store.listOutbox()).length;
        const lastSyncAt = await this.store.getMeta('lastSyncAt');
        this.status = { state, message, pending, lastSyncAt };
        this.onStatus(this.status);
    }

    // One sync at a time in this tab; a second call joins the one that is running.
    sync(options = {}) {
        if (!this.running) {
            this.running = this.runSync(options).finally(() => { this.running = null; });
        }
        return this.running;
    }

    async runSync({ full = false } = {}) {
        const changes = { calendars: false, objects: new Set() };
        const result = { pushed: 0, fetched: 0, removed: 0, error: null };
        try {
            await this.setStatus('syncing');
            result.pushed = await this.pushOutbox(changes);
            const calendars = await this.refreshCalendars(changes);
            for (const cal of calendars) {
                if (!eventCapable(cal)) continue;
                const pulled = await this.pullCalendar(cal, changes, full);
                result.fetched += pulled.fetched;
                result.removed += pulled.removed;
            }
            await this.store.setMeta('lastSyncAt', this.now());
            const pending = (await this.store.listOutbox()).length;
            await this.setStatus(pending ? 'pending' : 'ok', pending ? `${pending} change(s) not yet saved on the server` : '');
        } catch (err) {
            if (!(err instanceof DavError)) throw err;
            result.error = err;
            const state = err.kind === 'offline' ? 'offline' : err.kind === 'auth' ? 'auth' : 'error';
            await this.setStatus(state, err.message);
        } finally {
            if (changes.calendars || changes.objects.size) this.onChange(changes);
        }
        return result;
    }

    async account() {
        let account = await this.store.getMeta('account');
        if (!account || !account.home) {
            const found = await this.dav.discover();
            account = { ...(account || {}), ...found };
            await this.store.setMeta('account', account);
        }
        return account;
    }

    async refreshCalendars(changes) {
        const account = await this.account();
        let list;
        try {
            list = await this.dav.listCalendars(account.home);
        } catch (err) {
            if (!(err instanceof DavError) || err.kind !== 'gone') throw err;
            await this.store.setMeta('account', { ...account, home: null });
            list = await this.dav.listCalendars((await this.account()).home);
        }
        if (!list.some(eventCapable) && this.defaultCalendar) {
            const href = `${account.home.replace(/\/?$/, '/')}${newUid()}/`;
            await this.dav.mkcalendar(href, this.defaultCalendar);
            list = await this.dav.listCalendars(account.home);
        }
        const local = await this.store.listCalendars();
        const onServer = new Set(list.map(c => c.href));
        for (const cal of local) {
            if (!onServer.has(cal.href)) {
                // A calendar gone from the server: removed on another device, or lost there. Its
                // events are kept on this device, to put back if it was not meant.
                const objects = await this.store.listObjects(cal.href);
                if (objects.length) await this.keepCopy({ reason: 'calendar', calendar: cal, objects });
                for (const obj of objects) changes.objects.add(obj.href);
                await this.store.deleteCalendar(cal.href);
                changes.calendars = true;
            }
        }
        const merged = [];
        for (const cal of list) {
            const before = local.find(c => c.href === cal.href);
            const record = { ...cal, syncedToken: before ? before.syncedToken : null, syncedCtag: before ? before.syncedCtag : null };
            if (!before || before.name !== cal.name || before.color !== cal.color || before.readOnly !== cal.readOnly) changes.calendars = true;
            await this.store.putCalendar(record);
            merged.push(record);
        }
        return merged;
    }

    async pullCalendar(cal, changes, full) {
        const counts = { fetched: 0, removed: 0 };
        const unchanged = !full && cal.syncedToken && cal.syncToken && cal.syncedToken === cal.syncToken
            || !full && !cal.syncToken && cal.ctag && cal.syncedCtag === cal.ctag;
        if (unchanged) return counts;
        const localObjects = new Map((await this.store.listObjects(cal.href)).map(o => [o.href, o]));
        const pending = new Set((await this.store.listOutbox()).map(op => op.href));
        let token = null;
        let changed = null;
        let removed = [];
        if (!full && cal.syncedToken) {
            try {
                ({ token, changed, removed } = await this.dav.syncCollection(cal.href, cal.syncedToken));
            } catch (err) {
                if (!(err instanceof DavError) || !['invalid-token', 'unsupported', 'refused'].includes(err.kind)) throw err;
                changed = null;
            }
        }
        if (!changed) {
            let listing;
            try {
                const all = await this.dav.syncCollection(cal.href, '');
                token = all.token;
                listing = all.changed;
            } catch (err) {
                if (!(err instanceof DavError) || !['unsupported', 'refused', 'invalid-token'].includes(err.kind)) throw err;
                listing = await this.dav.listEtags(cal.href);
                token = null;
            }
            const present = new Set(listing.map(x => x.href));
            changed = listing;
            removed = [...localObjects.keys()].filter(href => !present.has(href));
        }
        const going = removed.filter(href => !pending.has(href) && localObjects.has(href));
        if (worthKeeping(going.length, localObjects.size)) {
            await this.keepCopy({ reason: 'events', calendar: cal, objects: going.map(href => localObjects.get(href)) });
        }
        const toFetch = changed
            .filter(x => !pending.has(x.href))
            .filter(x => !localObjects.has(x.href) || localObjects.get(x.href).etag !== x.etag)
            .map(x => x.href);
        for (let i = 0; i < toFetch.length; i += MULTIGET_BATCH) {
            const batch = toFetch.slice(i, i + MULTIGET_BATCH);
            const fetched = await this.dav.multiget(cal.href, batch);
            for (const item of fetched) {
                if (item.data) {
                    await this.store.putObject({ href: item.href, calendar: cal.href, etag: item.etag, data: item.data, pending: false });
                    counts.fetched++;
                } else if (localObjects.has(item.href) && !pending.has(item.href)) {
                    await this.store.deleteObject(item.href);
                    counts.removed++;
                }
                changes.objects.add(item.href);
            }
        }
        for (const href of removed) {
            if (pending.has(href) || !localObjects.has(href)) continue;
            await this.store.deleteObject(href);
            changes.objects.add(href);
            counts.removed++;
        }
        await this.store.putCalendar({ ...cal, syncedToken: token || cal.syncToken || null, syncedCtag: cal.ctag || null });
        return counts;
    }

    async pushOutbox(changes) {
        let pushed = 0;
        for (const op of await this.store.listOutbox()) {
            await this.pushOne(op, changes, 0);
            pushed++;
        }
        return pushed;
    }

    async pushOne(op, changes, attempt) {
        if (attempt > 2) throw new DavError('The server kept refusing a change; it is tried again at the next sync.', { kind: 'server' });
        await this.store.markSending(op.id);
        try {
            if (op.type === 'put') {
                const { etag } = await this.dav.put(op.href, op.data, op.baseEtag ? { etag: op.baseEtag } : { create: true });
                const finalEtag = etag || ((await this.dav.get(op.href)) || {}).etag || null;
                const finished = await this.store.completeOp(op.id, op.rev, finalEtag);
                const local = await this.store.getObject(op.href);
                if (finished) await this.store.putObject({ href: op.href, calendar: op.calendar, etag: finalEtag, data: op.data, pending: false });
                else if (local) await this.store.putObject({ ...local, etag: finalEtag });
                changes.objects.add(op.href);
                return;
            }
            await this.dav.remove(op.href, { etag: op.baseEtag });
            await this.store.completeOp(op.id, op.rev, null);
        } catch (err) {
            if (!(err instanceof DavError)) throw err;
            if (err.kind === 'gone') {
                if (op.type === 'delete') { await this.store.completeOp(op.id, op.rev, null); return; }
                // Edited here, deleted elsewhere: keeping the edit is the safe choice.
                await this.setBase(op, null);
                return this.pushOne({ ...op, baseEtag: null }, changes, attempt + 1);
            }
            if (err.kind === 'conflict') return this.resolveConflict(op, changes, attempt);
            if (['offline', 'auth', 'server', 'cancelled'].includes(err.kind)) throw err;
            // The server will not take this change at all (a read-only calendar, data it refuses):
            // it is dropped, noted, and the server's version is fetched again.
            await this.store.dropOp(op.id);
            await this.noteProblem(op, `Not saved: ${err.message}`);
            await this.store.deleteObject(op.href);
            const cal = (await this.store.listCalendars()).find(c => c.href === op.calendar);
            if (cal) await this.store.putCalendar({ ...cal, syncedToken: null, syncedCtag: null });
            changes.objects.add(op.href);
        }
    }

    async setBase(op, etag) {
        const current = (await this.store.listOutbox()).find(o => o.id === op.id);
        if (current) await this.store.updateOp({ ...current, baseEtag: etag });
    }

    async resolveConflict(op, changes, attempt) {
        const server = await this.dav.get(op.href);
        if (!server) {
            if (op.type === 'delete') { await this.store.completeOp(op.id, op.rev, null); return; }
            await this.setBase(op, null);
            return this.pushOne({ ...op, baseEtag: null }, changes, attempt + 1);
        }
        if (op.type === 'put' && !op.baseEtag && server.data === op.data) {
            // A create whose answer was lost: it did arrive.
            await this.store.completeOp(op.id, op.rev, server.etag);
            await this.store.putObject({ href: op.href, calendar: op.calendar, etag: server.etag, data: server.data, pending: false });
            changes.objects.add(op.href);
            return;
        }
        const theirs = lastModifiedOf(server.data);
        if (theirs > (op.editedAt || 0)) {
            await this.store.dropOp(op.id);
            await this.store.putObject({ href: op.href, calendar: op.calendar, etag: server.etag, data: server.data, pending: false });
            await this.noteProblem(op, op.type === 'delete'
                ? 'Changed on another device after it was deleted here, so it was kept.'
                : 'Changed on another device after it was changed here; the later version was kept.');
            changes.objects.add(op.href);
            return;
        }
        await this.setBase(op, server.etag);
        return this.pushOne({ ...op, baseEtag: server.etag }, changes, attempt + 1);
    }

    // ---- copies kept when much goes at once ----------------------------------------------------------

    async keepCopy({ reason, calendar, objects }) {
        const copies = (await this.store.getMeta('keptCopies')) || [];
        copies.unshift({
            id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
            at: this.now(),
            reason,
            calendar: { href: calendar.href, name: calendar.name, color: calendar.color || null },
            items: objects.map(o => o.data).filter(Boolean)
        });
        await this.store.setMeta('keptCopies', copies.slice(0, COPIES_KEPT));
    }

    async keptCopies() {
        return (await this.store.getMeta('keptCopies')) || [];
    }

    async discardCopy(id) {
        await this.store.setMeta('keptCopies', (await this.keptCopies()).filter(c => c.id !== id));
    }

    // Puts a kept copy's events back on the server, into `calendarHref`: those whose UID that
    // calendar does not have (again) by now. They are sent with the next sync, like any change.
    async restoreCopy(id, calendarHref) {
        const copy = (await this.keptCopies()).find(c => c.id === id);
        if (!copy) throw new Error('That copy is no longer kept.');
        const present = new Set();
        for (const obj of await this.store.listObjects(calendarHref)) {
            const vcalendar = parseCalendar(obj.data || '');
            const vevent = vcalendar && childComponents(vcalendar, 'VEVENT')[0];
            const uid = vevent && getProp(vevent, 'UID');
            if (uid) present.add(uid.value);
        }
        let restored = 0;
        let skipped = 0;
        for (const data of copy.items) {
            const vcalendar = parseCalendar(data);
            const vevent = vcalendar && childComponents(vcalendar, 'VEVENT')[0];
            const uid = vevent && getProp(vevent, 'UID') ? getProp(vevent, 'UID').value : null;
            if (!uid || present.has(uid)) { skipped++; continue; }
            await this.saveEvent({ calendar: calendarHref, data, uid });
            present.add(uid);
            restored++;
        }
        await this.discardCopy(id);
        return { restored, skipped };
    }

    async noteProblem(op, message) {
        const problems = (await this.store.getMeta('problems')) || [];
        problems.unshift({ at: this.now(), href: op.href, summary: summaryOf(op.data) || summaryOf((await this.store.getObject(op.href) || {}).data), message });
        await this.store.setMeta('problems', problems.slice(0, PROBLEMS_KEPT));
    }

    // ---- changes made on this device ----------------------------------------------------------------

    async saveEvent({ href = null, calendar, data, uid }) {
        const target = href || `${calendar.replace(/\/?$/, '/')}${resourceName(uid)}`;
        const existing = await this.store.getObject(target);
        const editedAt = this.now();
        await this.store.putObject({ href: target, calendar, etag: existing ? existing.etag : null, data, pending: true });
        await this.store.queueOp({ type: 'put', href: target, calendar, data, baseEtag: existing ? existing.etag : null, editedAt });
        this.onChange({ calendars: false, objects: new Set([target]) });
        return target;
    }

    async deleteEvent(href) {
        const existing = await this.store.getObject(href);
        await this.store.deleteObject(href);
        await this.store.queueOp({ type: 'delete', href, calendar: existing ? existing.calendar : null, data: existing ? existing.data : null,
                                   baseEtag: existing ? existing.etag : null, editedAt: this.now() });
        this.onChange({ calendars: false, objects: new Set([href]) });
    }

    // Moving an event to another calendar is a new copy there and a delete here.
    async moveEvent(href, toCalendar, data, uid) {
        const target = await this.saveEvent({ calendar: toCalendar, data, uid });
        if (target !== href) await this.deleteEvent(href);
        return target;
    }

    async createCalendar({ name, color }) {
        const account = await this.account();
        const href = `${account.home.replace(/\/?$/, '/')}${newUid()}/`;
        await this.dav.mkcalendar(href, { name, color });
        return href;
    }

    async changeCalendar(href, { name = null, color = null }) {
        await this.dav.proppatch(href, { name, color });
    }

    // Removes a calendar with its events, on the server and here. Changes still queued for its
    // events have nowhere to go any more, and are dropped with it.
    async deleteCalendar(href) {
        await this.dav.removeCollection(href);
        const hrefs = (await this.store.listObjects(href)).map(o => o.href);
        for (const op of await this.store.listOutbox()) if (op.calendar === href) await this.store.dropOp(op.id);
        await this.store.deleteCalendar(href);
        this.onChange({ calendars: true, objects: new Set(hrefs) });
    }
}
