// This device's copy of the calendars: what the server had at the last sync, plus the changes made
// here that the server has not taken yet (the outbox). It is a cache: everything in it but the
// outbox can be fetched again, and the outbox is emptied as soon as the server has each change.
//
// Two implementations with the same methods: IndexedDB in the browser, and memory for tests.

const DB_NAME = 'myai-calendar';
const DB_VERSION = 1;

function mergeOp(existing, op) {
    // A second change to the same event before the first reached the server replaces its content;
    // the version it was based on stays the one the server knows.
    if (existing.type === 'put' && op.type === 'put') {
        return { ...existing, data: op.data, calendar: op.calendar, editedAt: op.editedAt, rev: (existing.rev || 0) + 1 };
    }
    if (existing.type === 'put' && op.type === 'delete') {
        // Never sent: nothing to delete on the server. Being sent right now: the delete follows it.
        if (!existing.baseEtag && !existing.sent && !existing.sending) return null;
        return { ...existing, type: 'delete', data: null, editedAt: op.editedAt, rev: (existing.rev || 0) + 1 };
    }
    if (existing.type === 'delete' && op.type === 'put') {
        return { ...existing, type: 'put', data: op.data, calendar: op.calendar, editedAt: op.editedAt, rev: (existing.rev || 0) + 1 };
    }
    return { ...existing, editedAt: op.editedAt, rev: (existing.rev || 0) + 1 };
}

export class MemoryStore {
    constructor() {
        this.meta = new Map();
        this.calendars = new Map();
        this.objects = new Map();
        this.outbox = new Map();
        this.nextId = 1;
    }

    async getMeta(key) { return this.meta.has(key) ? structuredClone(this.meta.get(key)) : null; }
    async setMeta(key, value) { if (value == null) this.meta.delete(key); else this.meta.set(key, structuredClone(value)); }
    async listCalendars() { return [...this.calendars.values()].map(c => ({ ...c })); }
    async putCalendar(cal) { this.calendars.set(cal.href, { ...cal }); }
    async deleteCalendar(href) {
        this.calendars.delete(href);
        for (const [key, obj] of this.objects) if (obj.calendar === href) this.objects.delete(key);
    }
    async listObjects(calendar = null) {
        return [...this.objects.values()].filter(o => !calendar || o.calendar === calendar).map(o => ({ ...o }));
    }
    async getObject(href) { return this.objects.has(href) ? { ...this.objects.get(href) } : null; }
    async putObject(obj) { this.objects.set(obj.href, { ...obj }); }
    async deleteObject(href) { this.objects.delete(href); }
    async listOutbox() { return [...this.outbox.values()].sort((a, b) => a.id - b.id).map(o => ({ ...o })); }
    async queueOp(op) {
        const existing = [...this.outbox.values()].find(o => o.href === op.href);
        if (existing) {
            const merged = mergeOp(existing, op);
            if (merged) this.outbox.set(existing.id, merged);
            else this.outbox.delete(existing.id);
            return merged;
        }
        const added = { ...op, id: this.nextId++, rev: 0 };
        this.outbox.set(added.id, added);
        return added;
    }
    async updateOp(op) { if (this.outbox.has(op.id)) this.outbox.set(op.id, { ...op }); }
    async markSending(id) { const op = this.outbox.get(id); if (op) this.outbox.set(id, { ...op, sending: true }); }
    // The server took op at revision `rev`. Unless it was changed again meanwhile, it is done;
    // if it was, it stays, now based on the version the server just stored.
    async completeOp(id, rev, etag) {
        const current = this.outbox.get(id);
        if (!current) return true;
        if ((current.rev || 0) === (rev || 0)) { this.outbox.delete(id); return true; }
        this.outbox.set(id, { ...current, baseEtag: etag || current.baseEtag, sent: true, sending: false });
        return false;
    }
    async dropOp(id) { this.outbox.delete(id); }
    async clearAll() { this.meta.clear(); this.calendars.clear(); this.objects.clear(); this.outbox.clear(); }
}

// ---- IndexedDB ----------------------------------------------------------------------------------------

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('The browser storage transaction was cancelled.'));
        tx.onerror = () => reject(tx.error);
    });
}

export class IdbStore {
    constructor(name = DB_NAME) {
        this.name = name;
        this.db = null;
    }

    async open() {
        if (this.db) return this.db;
        this.db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(this.name, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                // Additive only: a new version adds what it needs and never deletes a store.
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
                if (!db.objectStoreNames.contains('calendars')) db.createObjectStore('calendars', { keyPath: 'href' });
                if (!db.objectStoreNames.contains('objects')) {
                    const objects = db.createObjectStore('objects', { keyPath: 'href' });
                    objects.createIndex('by-calendar', 'calendar');
                }
                if (!db.objectStoreNames.contains('outbox')) {
                    const outbox = db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
                    outbox.createIndex('by-href', 'href');
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); this.db = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Another tab holds an older version of the calendar open.'));
        });
        return this.db;
    }

    async tx(stores, mode, work) {
        const db = await this.open();
        const tx = db.transaction(stores, mode);
        const result = work(tx);
        await done(tx);
        return result instanceof Promise ? result : result;
    }

    async getMeta(key) {
        const db = await this.open();
        return promisify(db.transaction('meta').objectStore('meta').get(key)).then(v => (v === undefined ? null : v));
    }
    async setMeta(key, value) {
        await this.tx(['meta'], 'readwrite', tx => {
            if (value == null) tx.objectStore('meta').delete(key);
            else tx.objectStore('meta').put(value, key);
        });
    }
    async listCalendars() {
        const db = await this.open();
        return promisify(db.transaction('calendars').objectStore('calendars').getAll());
    }
    async putCalendar(cal) { await this.tx(['calendars'], 'readwrite', tx => { tx.objectStore('calendars').put(cal); }); }
    async deleteCalendar(href) {
        const db = await this.open();
        const tx = db.transaction(['calendars', 'objects'], 'readwrite');
        tx.objectStore('calendars').delete(href);
        const keys = await promisify(tx.objectStore('objects').index('by-calendar').getAllKeys(href));
        for (const key of keys) tx.objectStore('objects').delete(key);
        await done(tx);
    }
    async listObjects(calendar = null) {
        const db = await this.open();
        const store = db.transaction('objects').objectStore('objects');
        return promisify(calendar ? store.index('by-calendar').getAll(calendar) : store.getAll());
    }
    async getObject(href) {
        const db = await this.open();
        return promisify(db.transaction('objects').objectStore('objects').get(href)).then(v => v || null);
    }
    async putObject(obj) { await this.tx(['objects'], 'readwrite', tx => { tx.objectStore('objects').put(obj); }); }
    async deleteObject(href) { await this.tx(['objects'], 'readwrite', tx => { tx.objectStore('objects').delete(href); }); }
    async listOutbox() {
        const db = await this.open();
        return promisify(db.transaction('outbox').objectStore('outbox').getAll()).then(list => list.sort((a, b) => a.id - b.id));
    }
    // Merging with a queued change for the same event happens in one transaction, so two tabs
    // saving at once cannot both think they are first.
    async queueOp(op) {
        const db = await this.open();
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const existing = await promisify(store.index('by-href').getAll(op.href));
        let result;
        if (existing.length) {
            const merged = mergeOp(existing[0], op);
            if (merged) { store.put(merged); result = merged; }
            else { store.delete(existing[0].id); result = null; }
        } else {
            const record = { ...op, rev: 0 };
            delete record.id;
            const id = await promisify(store.add(record));
            result = { ...record, id };
        }
        await done(tx);
        return result;
    }
    async updateOp(op) { await this.tx(['outbox'], 'readwrite', tx => { tx.objectStore('outbox').put(op); }); }
    async markSending(id) {
        const db = await this.open();
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const current = await promisify(store.get(id));
        if (current) store.put({ ...current, sending: true });
        await done(tx);
    }
    async completeOp(id, rev, etag) {
        const db = await this.open();
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const current = await promisify(store.get(id));
        let finished = true;
        if (current) {
            if ((current.rev || 0) === (rev || 0)) store.delete(id);
            else { store.put({ ...current, baseEtag: etag || current.baseEtag, sent: true, sending: false }); finished = false; }
        }
        await done(tx);
        return finished;
    }
    async dropOp(id) { await this.tx(['outbox'], 'readwrite', tx => { tx.objectStore('outbox').delete(id); }); }
    async clearAll() {
        await this.tx(['meta', 'calendars', 'objects', 'outbox'], 'readwrite', tx => {
            for (const name of ['meta', 'calendars', 'objects', 'outbox']) tx.objectStore(name).clear();
        });
    }
}
