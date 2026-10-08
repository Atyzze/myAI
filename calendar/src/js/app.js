// The calendar app: signing in, keeping this device's copy in step with the box, the views, and
// what the panels ask for. The calendar itself is on the box (CalDAV); this device keeps a copy in
// IndexedDB so the app opens at once and works offline, and sends its changes when it can.

import { IdbStore } from './store.js';
import { DavClient, DavError, basicAuth } from './caldav.js';
import { SyncEngine, eventCapable } from './sync.js';
import { EventIndex } from './event-index.js';
import { deviceZoneId, ianaZone, utcToWall } from './tz.js';
import { dateKey, parseDateKey, addDays } from './wall.js';
import { blankForm, createEvent, updateEvent, removeOccurrence, formFromOccurrence, formForCopy,
         endSeriesBefore, startSeriesFrom } from './event-model.js';
import { splitCalendarFile, exportCalendar } from './transfer.js';
import { normalizePrefs, effectiveWeekStart, effectiveClock, pickDefaultCalendar, VIEWS } from './prefs-core.js';
import { viewRange, stepFocus, rangeBounds, occurrencesByDay, matchesSearch } from './views-core.js';
import { timeAt, dayMedium, deviceLocale } from './format.js';
import { h, byId, clear, toast, askChoice, openOverlay, isOpen, anyOpen, installOverlayHandlers, downloadText } from './dom.js';
import { renderView } from './ui-views.js';
import { openDetails } from './ui-details.js';
import { openEditor } from './ui-editor.js';
import { openSettings } from './ui-settings.js';
import { startReminders } from './reminders.js';
import { startUpdates } from './update.js';

const SYNC_EVERY_MS = 60000;
const SYNC_EVERY_HIDDEN_MS = 5 * 60000;
const MAX_RETRY_MS = 5 * 60000;
const SEARCH_BACK_DAYS = 365;
const SEARCH_AHEAD_DAYS = 730;
const SEARCH_MAX = 300;
const DAY_MS = 86400000;

const store = new IdbStore();
const index = new EventIndex();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('myai-calendar') : null;
const narrowQuery = window.matchMedia('(max-width: 640px)');

const state = {
    session: null,
    prefs: normalizePrefs(null),
    calendars: [],
    engine: null,
    zone: ianaZone(deviceZoneId()),
    view: 'month',
    focus: null,
    listDays: 30,
    search: '',
    syncStatus: { state: 'idle', message: '', pending: 0, lastSyncAt: null },
    problems: [],
    pendingHrefs: new Set(),
    rendered: {},
    syncTimer: null,
    retryMs: 0,
    lastSyncStarted: 0,
    reminders: null,
    settings: null,
    batching: null,
    today: null
};

// ---- small helpers ---------------------------------------------------------------------------------------------

function todayKey() {
    return dateKey(utcToWall(Date.now(), state.zone));
}

function weekStart() {
    return effectiveWeekStart(state.prefs, deviceLocale());
}

function clock() {
    return effectiveClock(state.prefs, deviceLocale());
}

function calendarsByHref() {
    return new Map(state.calendars.map(c => [c.href, c]));
}

function visibleCalendars() {
    return new Set(state.calendars.filter(c => !state.prefs.hidden.includes(c.href)).map(c => c.href));
}

function writableCalendars() {
    return state.calendars.filter(c => !c.readOnly);
}

function defaultCalendar() {
    return pickDefaultCalendar(state.calendars, state.prefs);
}

function broadcast(message) {
    try { if (channel) channel.postMessage(message); } catch (_) {}
}

async function withLock(name, work, { wait = false } = {}) {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request(name, wait ? {} : { ifAvailable: true }, lock => (lock ? work() : undefined));
    }
    return work();
}

function sortCalendars(list) {
    return [...list].sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
}

async function savePrefs(patch) {
    state.prefs = normalizePrefs({ ...state.prefs, ...patch });
    await store.setMeta('prefs', state.prefs);
    broadcast({ type: 'prefs' });
    render();
    if (state.settings && isOpen('settingsOverlay')) state.settings.render();
}

// ---- this device's copy ---------------------------------------------------------------------------------------

async function loadAll() {
    const [calendars, objects, outbox, problems] = await Promise.all([
        store.listCalendars(), store.listObjects(), store.listOutbox(), store.getMeta('problems')
    ]);
    state.calendars = sortCalendars(calendars.filter(eventCapable));
    index.replaceAll(objects);
    state.pendingHrefs = new Set(outbox.filter(op => op.type === 'put').map(op => op.href));
    state.problems = problems || [];
}

async function applyChanges(changes) {
    if (changes.calendars) state.calendars = sortCalendars((await store.listCalendars()).filter(eventCapable));
    for (const href of changes.objects || []) {
        const record = await store.getObject(href);
        if (record) index.put(record); else index.remove(href);
    }
    const outbox = await store.listOutbox();
    state.pendingHrefs = new Set(outbox.filter(op => op.type === 'put').map(op => op.href));
    state.problems = (await store.getMeta('problems')) || [];
}

let renderQueued = false;
function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
}

// Changes are read into the views one after the other, so a sync that finishes can wait for them.
let applying = Promise.resolve();

function onEngineChange(changes) {
    if (state.batching) {
        if (changes.calendars) state.batching.calendars = true;
        for (const href of changes.objects || []) state.batching.objects.add(href);
        return;
    }
    applying = applying.then(() => applyChanges(changes)).then(renderSoon).catch(() => {});
    broadcast({ type: 'changed', calendars: !!changes.calendars, objects: [...(changes.objects || [])] });
}

let syncsFinished = 0;
function onSyncStatus(status) {
    state.syncStatus = status;
    paintSyncLine();
    // How many syncs have finished, on the page: what the browser tests wait on.
    if (status.state !== 'syncing') document.body.dataset.syncs = String(++syncsFinished);
    if (state.settings && isOpen('settingsOverlay')) state.settings.refreshStatus();
}

// ---- syncing -------------------------------------------------------------------------------------------------------

function scheduleSync(delayMs) {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => { runSync(); }, Math.max(0, delayMs));
}

async function runSync(options = {}) {
    if (!state.engine) return null;
    clearTimeout(state.syncTimer);
    state.lastSyncStarted = Date.now();
    let result;
    try {
        result = await withLock('myai-calendar-sync', () => state.engine.sync(options), { wait: !!options.wait });
    } catch (err) {
        result = { error: err };
        onSyncStatus({ ...state.syncStatus, state: 'error', message: err && err.message ? err.message : String(err) });
    }
    if (result === undefined) {
        // Another tab is syncing right now; its result reaches this one through the shared copy.
        scheduleSync(3000);
        return null;
    }
    if (result && result.error) {
        const kind = result.error.kind;
        if (kind === 'auth') { paintNotice(); return result; }
        state.retryMs = Math.min(MAX_RETRY_MS, Math.max(15000, state.retryMs * 2));
        scheduleSync(state.retryMs);
    } else {
        state.retryMs = 0;
        scheduleSync(document.visibilityState === 'visible' ? SYNC_EVERY_MS : SYNC_EVERY_HIDDEN_MS);
    }
    paintNotice();
    await applying;
    if (state.reminders) state.reminders.check();
    return result;
}

function paintSyncLine() {
    const line = byId('sync-line');
    const text = byId('sync-text');
    const s = state.syncStatus;
    const pending = s.pending || 0;
    const when = s.lastSyncAt ? syncedWhen(s.lastSyncAt) : '';
    let cls = s.state;
    let message;
    switch (s.state) {
        case 'syncing': message = 'Syncing…'; break;
        case 'ok': message = `Synced ${when}`; break;
        case 'pending': message = `${pending} change${pending === 1 ? '' : 's'} waiting to go to the box`; break;
        case 'offline':
            message = pending ? `Offline: ${pending} change${pending === 1 ? '' : 's'} wait on this device` : `Offline: showing this device's copy${when ? ` (synced ${when})` : ''}`;
            break;
        case 'auth': message = 'The box did not accept the password'; break;
        case 'error': message = `Sync problem: ${s.message || 'unknown'}. Trying again soon.`; break;
        default: message = 'Starting…'; cls = '';
    }
    line.className = cls;
    text.textContent = message;
    line.title = s.message || message;
}

function syncedWhen(ms) {
    const w = utcToWall(ms, state.zone);
    const key = dateKey(w);
    return key === todayKey() ? `at ${timeAt(ms, state.zone, clock())}` : `${dayMedium(key)}, ${timeAt(ms, state.zone, clock())}`;
}

async function paintNotice() {
    const notice = byId('notice');
    if (state.syncStatus.state === 'auth') {
        clear(notice);
        notice.className = 'error';
        notice.append(
            'The box did not accept the saved password (was it changed?). This device\'s copy and its changes are kept. ',
            h('button', { type: 'button', class: 'btn', style: { marginTop: '6px' }, onclick: () => showSignIn({ user: state.session.user, again: true }) }, 'Sign in again'));
        notice.hidden = false;
        return;
    }
    // A copy kept of events that went from the box in bulk, not looked at yet.
    const copies = state.engine ? await state.engine.keptCopies() : [];
    const newest = copies[0];
    const seen = await store.getMeta('keptSeen');
    clear(notice);
    notice.className = '';
    if (newest && newest.id !== seen) {
        const what = newest.reason === 'calendar'
            ? `The calendar "${newest.calendar.name}" (${newest.items.length} events) is no longer on the box.`
            : `${newest.items.length} events of "${newest.calendar.name}" went from the box at once.`;
        notice.append(what, ' If that was not meant (the box lost them), this device kept a copy to put back. ',
            h('div', { class: 'btn-row', style: { marginTop: '8px' } },
                h('button', { type: 'button', class: 'btn primary', onclick: async () => {
                    await store.setMeta('keptSeen', newest.id);
                    paintNotice();
                    state.settings = openSettings(appContext());
                    requestAnimationFrame(() => { const kept = byId('st-kept'); if (kept) kept.scrollIntoView({ block: 'start' }); });
                } }, 'Look at the copy'),
                h('button', { type: 'button', class: 'btn quiet', onclick: async () => {
                    await state.engine.discardCopy(newest.id);
                    await store.setMeta('keptSeen', newest.id);
                    paintNotice();
                } }, 'It was meant: let them go')));
        notice.hidden = false;
        return;
    }
    notice.hidden = true;
}

async function restoreCopy(copy) {
    let target = state.calendars.find(c => c.href === copy.calendar.href && !c.readOnly);
    if (!target) {
        // Its calendar is gone: it comes back under the same name.
        const href = await state.engine.createCalendar({ name: copy.calendar.name || 'Restored', color: copy.calendar.color || '#4caf50' });
        await refreshCalendars();
        target = state.calendars.find(c => c.href === href) || { href };
    }
    const result = await state.engine.restoreCopy(copy.id, target.href);
    await store.setMeta('keptSeen', copy.id);
    await paintNotice();
    scheduleSync(300);
    return result;
}

function downloadCopy(copy) {
    downloadText(fileName(`${copy.calendar.name || 'calendar'} (kept ${dateKey(utcToWall(copy.at, state.zone))})`),
        exportCalendar(copy.items, { name: copy.calendar.name || 'Kept' }));
}

// ---- drawing -------------------------------------------------------------------------------------------------------

function searchResults() {
    const query = state.search.trim();
    if (state.view !== 'list' || !query) return null;
    const today = parseDateKey(todayKey());
    const fromKey = dateKey(addDays(today, -SEARCH_BACK_DAYS));
    const toKey = dateKey(addDays(today, SEARCH_AHEAD_DAYS));
    const bounds = rangeBounds({ from: fromKey, to: toKey }, state.zone);
    const matches = index.occurrences(bounds.start, bounds.end, state.zone, visibleCalendars()).filter(o => matchesSearch(o, query));
    const shown = matches.slice(0, SEARCH_MAX);
    const groups = new Map();
    for (const occ of shown) {
        const key = occ.allDay ? occ.startDate : dateKey(utcToWall(occ.startUtc, state.zone));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(occ);
    }
    return { days: [...groups.keys()].sort().map(key => ({ key, items: groups.get(key) })), total: matches.length, capped: matches.length > SEARCH_MAX };
}

function viewContext(range, occurrences, byDay) {
    return {
        view: state.view, range, occurrences, byDay,
        todayKey: todayKey(), focusKey: state.focus, zone: state.zone, clock: clock(), weekStart: weekStart(),
        narrow: narrowQuery.matches,
        nowMs: Date.now(), calendarsByHref: calendarsByHref(), pendingHrefs: state.pendingHrefs,
        showCalendarNames: state.calendars.length > 1,
        search: state.search, searchResults: searchResults(), listStep: state.prefs.listDays,
        on: {
            openOccurrence: occ => openDetails(appContext(), occ),
            selectDay: key => { state.focus = key; render(); },
            openDay: key => { state.focus = key; setView('day'); },
            newEventAt: (key, minute) => newEvent(key, minute),
            showMore: () => { state.listDays += state.prefs.listDays; render(); },
            search: text => { state.search = text; clearTimeout(searchTimer); searchTimer = setTimeout(render, 180); }
        }
    };
}
let searchTimer = null;

function render() {
    if (!state.session) return;
    state.today = todayKey();
    if (!state.focus) state.focus = state.today;
    const narrow = narrowQuery.matches;
    const range = viewRange(state.view, state.focus, { weekStart: weekStart(), narrow, listDays: state.listDays });
    byId('period-title').textContent = range.title;
    for (const button of document.querySelectorAll('.view-switch button')) {
        button.setAttribute('aria-pressed', button.dataset.view === state.view ? 'true' : 'false');
    }
    const bounds = rangeBounds(range, state.zone);
    const occurrences = index.occurrences(bounds.start, bounds.end, state.zone, visibleCalendars());
    const byDay = occurrencesByDay(occurrences, range.days, state.zone);
    document.body.dataset.clock = clock();
    state.rendered = renderView(byId('view'), viewContext(range, occurrences, byDay), state.rendered);
    byId('newEventBtn').disabled = !defaultCalendar() && state.calendars.length > 0;
}

function setView(view) {
    if (!VIEWS.includes(view)) return;
    if (view !== 'list') state.listDays = state.prefs.listDays;
    state.view = view;
    savePrefs({ view });
}

function step(direction) {
    state.focus = stepFocus(state.view, state.focus || todayKey(), direction, { narrow: narrowQuery.matches, listDays: state.listDays });
    render();
}

// ---- the context the panels work with ---------------------------------------------------------------------------

function appContext() {
    return {
        index, store,
        get prefs() { return state.prefs; },
        get session() { return state.session; },
        zone: state.zone, zoneId: state.zone.id, clock: clock(), weekStart: weekStart(),
        calendarsByHref: calendarsByHref(),
        calendars: () => state.calendars,
        writableCalendars, defaultCalendar,
        countIn: href => index.countIn(href),
        setPrefs: savePrefs,
        syncStatus: () => state.syncStatus,
        problems: () => state.problems,
        notificationState,
        storageInfo,
        keptCopies: () => (state.engine ? state.engine.keptCopies() : Promise.resolve([])),
        onSettingsClosed: () => { state.settings = null; },
        actions: {
            edit: editOccurrence,
            duplicate: duplicateOccurrence,
            remove: removeWithChoice,
            save: saveFromEditor,
            createCalendar, changeCalendar, deleteCalendar,
            importFile, exportCalendar: exportOne, exportAll,
            syncNow: async (options = {}) => { await runSync({ ...options, wait: true }); },
            signOut, enableNotifications,
            restoreCopy, downloadCopy,
            discardCopy: async id => { await state.engine.discardCopy(id); await paintNotice(); }
        }
    };
}

// ---- events: new, edit, delete -----------------------------------------------------------------------------------

// The next full hour today (a new event planned today starts then), at most 23:00.
function nextFullHour() {
    return Math.min(23, utcToWall(Date.now(), state.zone).hour + 1);
}

function newEvent(dayKey = null, minute = null) {
    const cal = defaultCalendar();
    if (!cal) {
        toast(state.calendars.length ? 'None of your calendars can be written to.' : 'The calendar is not there yet: it comes with the first sync.', { kind: 'error' });
        return;
    }
    const key = dayKey || state.focus || todayKey();
    const hour = minute != null ? Math.floor(minute / 60) : (key === todayKey() ? nextFullHour() : 9);
    const form = blankForm({
        date: key, hour, zoneId: state.zone.id,
        defaults: { durationMinutes: state.prefs.durationMinutes, alarmSeconds: state.prefs.alarmSeconds == null ? '' : state.prefs.alarmSeconds, calendar: cal.href }
    });
    if (minute != null && minute % 60) {
        const pad = n => String(n).padStart(2, '0');
        const start = minute;
        const end = start + state.prefs.durationMinutes;
        form.startTime = `${pad(Math.floor(start / 60))}:${pad(start % 60)}`;
        const endDay = end >= 1440 ? dateKey(addDays(parseDateKey(key), 1)) : key;
        form.endDate = endDay;
        form.endTime = `${pad(Math.floor((end % 1440) / 60))}:${pad(end % 60)}`;
    }
    openEditor(appContext(), { mode: 'new', form });
}

function editOccurrence(occ) {
    const record = index.get(occ.href);
    if (!record) { toast('This event is no longer here.', { kind: 'error' }); return; }
    let form;
    try { form = formFromOccurrence(record.data, occ, state.zone); } catch (err) {
        toast(`This event cannot be edited here: ${err.message}`, { kind: 'error' });
        return;
    }
    openEditor(appContext(), { mode: 'edit', form: { ...form, calendar: record.calendar }, occurrence: occ, record });
}

function duplicateOccurrence(occ) {
    const record = index.get(occ.href);
    if (!record) return;
    const form = formForCopy(formFromOccurrence(record.data, occ, state.zone));
    const cal = state.calendars.find(c => c.href === record.calendar && !c.readOnly) || defaultCalendar();
    openEditor(appContext(), { mode: 'new', form: { ...form, calendar: cal ? cal.href : null }, heading: 'Copy of an event' });
}

function savedToast(message) {
    const offline = state.syncStatus.state === 'offline' || navigator.onLine === false;
    toast(offline ? `${message} on this device; it goes to the box when it can be reached.` : `${message}.`, { timeoutMs: 3000 });
}

async function askScope({ title, override, allowAll = true, allowOne = true }) {
    const choices = [];
    if (allowOne) choices.push({ value: 'one', label: 'Only this event' });
    choices.push({ value: 'following', label: 'This and the following events' });
    if (allowAll && !override) choices.push({ value: 'all', label: 'All events in the series' });
    choices.push({ value: null, label: 'Cancel', kind: 'quiet' });
    return askChoice({ title, choices });
}

// Whether two forms repeat the same way (however their repeat objects happen to be written).
function sameRepeat(a, b) {
    const shape = form => {
        const r = form.repeat;
        if (!r || !r.freq) return JSON.stringify(['custom', form.repeatCustom || null]);
        return JSON.stringify([r.freq, Number(r.interval) || 1, r.freq === 'WEEKLY' ? [...(r.byday || [])].sort() : [],
            r.freq === 'MONTHLY' ? r.monthlyBy || 'monthday' : '', r.ends || 'never',
            r.ends === 'until' ? r.until : '', r.ends === 'count' ? Number(r.count) : 0]);
    };
    return shape(a) === shape(b);
}

async function saveFromEditor(spec) {
    const { mode, form, occurrence, record, originalForm } = spec;
    const zone = state.zone;
    const calendar = form.calendar || (defaultCalendar() || {}).href;
    if (!calendar) throw new Error('There is no calendar to save it in.');
    if (mode === 'new') {
        const { uid, text } = createEvent(form, { viewerZone: zone });
        await state.engine.saveEvent({ calendar, data: text, uid });
        savedToast('Added');
        scheduleSync(300);
        return true;
    }
    const recurring = !!(occurrence && occurrence.recurring);
    const repeatChanged = !sameRepeat(form, originalForm);
    const moving = calendar !== record.calendar;
    let scope = 'all';
    if (recurring && !moving) {
        scope = await askScope({
            title: 'Change a repeating event',
            override: occurrence.override,
            allowOne: !repeatChanged
        });
        if (!scope) return false;
    }
    if (scope === 'following') {
        const before = endSeriesBefore(record.data, occurrence, { viewerZone: zone });
        if (before.text) {
            const rest = startSeriesFrom(record.data, occurrence, form, { viewerZone: zone });
            await state.engine.saveEvent({ href: record.href, calendar: record.calendar, data: before.text });
            await state.engine.saveEvent({ calendar: record.calendar, data: rest.text, uid: rest.uid });
            savedToast('Saved');
            scheduleSync(300);
            return true;
        }
        scope = 'all';
    }
    if (scope === 'one') {
        const text = updateEvent(record.data, form, { occurrence, scope: 'one', viewerZone: zone });
        await state.engine.saveEvent({ href: record.href, calendar: record.calendar, data: text });
    } else {
        const text = updateEvent(record.data, form, { occurrence: occurrence && !occurrence.override ? occurrence : null, scope: 'all', viewerZone: zone });
        if (moving) {
            const series = index.series(record.href);
            await state.engine.moveEvent(record.href, calendar, text, series ? series.uid : null);
        } else {
            await state.engine.saveEvent({ href: record.href, calendar: record.calendar, data: text });
        }
    }
    savedToast('Saved');
    scheduleSync(300);
    return true;
}

async function removeWithChoice(occ) {
    const record = index.get(occ.href);
    if (!record) return true;
    const zone = state.zone;
    const title = occ.summary || '(No title)';
    let message;
    if (occ.recurring) {
        const scope = await askChoice({
            title: `Delete "${title}"?`,
            text: 'It repeats. Which of its events go?',
            choices: [
                { value: 'one', label: 'Only this event' },
                { value: 'following', label: 'This and the following events' },
                { value: 'all', label: 'All events in the series', kind: 'danger' },
                { value: null, label: 'Cancel', kind: 'quiet' }
            ]
        });
        if (!scope) return false;
        if (scope === 'all') {
            await state.engine.deleteEvent(record.href);
            message = `Deleted "${title}" and all its repeats`;
        } else {
            const text = scope === 'one'
                ? removeOccurrence(record.data, occ, { viewerZone: zone })
                : endSeriesBefore(record.data, occ, { viewerZone: zone }).text;
            if (text) await state.engine.saveEvent({ href: record.href, calendar: record.calendar, data: text });
            else await state.engine.deleteEvent(record.href);
            message = scope === 'one' ? `Deleted "${title}" on ${dayMedium(occ.allDay ? occ.startDate : dateKey(utcToWall(occ.startUtc, zone)))}` : `Deleted "${title}" from this one on`;
        }
    } else {
        await state.engine.deleteEvent(record.href);
        message = `Deleted "${title}"`;
    }
    scheduleSync(1500);
    toast(message, {
        timeoutMs: 8000,
        actions: [{ label: 'Undo', run: async () => {
            await state.engine.saveEvent({ href: record.href, calendar: record.calendar, data: record.data });
            toast('Put back.', { timeoutMs: 2500 });
            scheduleSync(300);
        } }]
    });
    return true;
}

// Opens the event an occurrence key names (from a reminder or a notification), if it is still there.
function openByKey(key, startUtc) {
    const from = (startUtc || Date.now()) - 2 * DAY_MS;
    const to = (startUtc || Date.now()) + 2 * DAY_MS;
    const occ = index.occurrences(from, to, state.zone).find(o => o.key === key);
    if (occ) openDetails(appContext(), occ);
}

// ---- calendars, import, export ----------------------------------------------------------------------------------

async function refreshCalendars() {
    await runSync({ wait: true });
    state.calendars = sortCalendars((await store.listCalendars()).filter(eventCapable));
    render();
}

async function createCalendar({ name, color }) {
    const href = await state.engine.createCalendar({ name, color });
    await refreshCalendars();
    return href;
}

async function changeCalendar(href, { name, color }) {
    await state.engine.changeCalendar(href, { name, color });
    await refreshCalendars();
}

async function deleteCalendar(href) {
    await state.engine.deleteCalendar(href);
    if (state.prefs.defaultCalendar === href) await savePrefs({ defaultCalendar: null });
    await refreshCalendars();
}

async function importFile(file, calendarHref) {
    if (!calendarHref) throw new Error('Choose a calendar to import into.');
    const text = await file.text();
    const { objects, skipped } = splitCalendarFile(text);
    if (!objects.length) {
        return skipped ? `No events in this file (${skipped} to-do or other item${skipped === 1 ? '' : 's'}).` : 'No events found in this file.';
    }
    const existing = index.uidsIn(calendarHref);
    let added = 0;
    let updated = 0;
    state.batching = { calendars: false, objects: new Set() };
    const progress = toast(`Importing ${objects.length} events…`, { timeoutMs: 0, key: 'import' });
    try {
        for (const [i, obj] of objects.entries()) {
            const href = existing.get(obj.uid) || null;
            if (href && index.get(href) && index.get(href).data === obj.text) continue;
            await state.engine.saveEvent({ href, calendar: calendarHref, data: obj.text, uid: obj.uid });
            if (href) updated++; else added++;
            if (i % 50 === 49 && progress) progress.el.firstChild.textContent = `Importing… ${i + 1} of ${objects.length}`;
        }
    } finally {
        const batch = state.batching;
        state.batching = null;
        if (progress) progress.dismiss();
        await applyChanges(batch);
        broadcast({ type: 'changed', calendars: batch.calendars, objects: [...batch.objects] });
        render();
    }
    scheduleSync(300);
    const unchanged = objects.length - added - updated;
    return `${added} added, ${updated} updated${unchanged ? `, ${unchanged} already the same` : ''}${skipped ? `, ${skipped} to-do or other item${skipped === 1 ? '' : 's'} left out` : ''}. They go to the box with the next sync.`;
}

function fileName(name) {
    return `${String(name || 'calendar').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'calendar'}.ics`;
}

function exportOne(href) {
    const cal = state.calendars.find(c => c.href === href);
    const texts = index.records().filter(r => r.calendar === href).map(r => r.data);
    downloadText(fileName(cal ? cal.name : 'calendar'), exportCalendar(texts, { name: cal ? cal.name : 'Calendar' }));
}

function exportAll() {
    const texts = index.records().map(r => r.data);
    downloadText(fileName(`myAI calendar ${todayKey()}`), exportCalendar(texts, { name: 'myAI' }));
}

// ---- notifications, storage ---------------------------------------------------------------------------------------

function notificationState() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
}

async function enableNotifications() {
    if (typeof Notification === 'undefined') return false;
    let permission = Notification.permission;
    if (permission === 'default') {
        try { permission = await Notification.requestPermission(); } catch (_) { permission = 'denied'; }
    }
    await savePrefs({ notify: permission === 'granted' });
    return permission === 'granted';
}

async function storageInfo() {
    const pending = state.pendingHrefs.size;
    let text = `${index.size} event${index.size === 1 ? '' : 's'} kept on this device${pending ? `, ${pending} not yet on the box` : ''}.`;
    try {
        if (navigator.storage && navigator.storage.persisted) {
            const persisted = await navigator.storage.persisted();
            text += persisted ? ' The browser has agreed to keep this copy.'
                : ' The browser may clear this copy when it runs short of space; the calendar is safe on the box, only changes not yet sent would be lost.';
        }
    } catch (_) {}
    return text;
}

// ---- signing in and out --------------------------------------------------------------------------------------------

function showSignIn({ user = '', again = false, message = '' } = {}) {
    byId('app').hidden = true;
    byId('signin').hidden = false;
    const userInput = byId('si-user');
    if (user) userInput.value = user;
    if (state.session && state.session.server) byId('si-server').value = new URL(state.session.server).pathname;
    const error = byId('si-error');
    error.hidden = !message;
    error.textContent = message;
    const hint = byId('si-again');
    if (hint) hint.hidden = !again;
    requestAnimationFrame(() => (userInput.value ? byId('si-pass') : userInput).focus());
}

async function signIn() {
    const user = byId('si-user').value.trim();
    const password = byId('si-pass').value;
    const serverText = byId('si-server').value.trim() || '/dav/';
    const error = byId('si-error');
    const button = byId('si-go');
    const fail = text => { error.hidden = false; error.textContent = text; };
    if (!user || !password) { fail('Fill in your name and password.'); return; }
    let base;
    try { base = new URL(serverText.endsWith('/') ? serverText : `${serverText}/`, location.href); } catch (_) { fail('That server address cannot be read.'); return; }
    if (base.origin !== location.origin) { fail(`The calendar server has to be on this same site (${location.origin}), for example /dav/.`); return; }
    button.disabled = true;
    button.textContent = 'Signing in…';
    error.hidden = true;
    try {
        const authorization = basicAuth(user, password);
        const dav = new DavClient({ base: base.href, authorization });
        let found;
        try {
            found = await dav.discover();
        } catch (err) {
            if (!(err instanceof DavError)) throw err;
            if (err.kind === 'auth') fail('That name and password were not accepted.');
            else if (err.kind === 'offline') fail('The box cannot be reached from here right now. Check the connection and try again.');
            else fail(`There is no calendar server at ${base.pathname} on this site (${err.message}).`);
            return;
        }
        const previous = await store.getMeta('session');
        if (previous && (previous.user !== user || previous.server !== base.href)) await store.clearAll();
        const session = { user, server: base.href, authorization, principal: found.principal, home: found.home };
        await store.setMeta('session', session);
        await store.setMeta('account', { principal: found.principal, home: found.home });
        byId('si-pass').value = '';
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
        broadcast({ type: 'signed-in' });
        await startApp(session);
    } catch (err) {
        fail(`Signing in failed: ${err && err.message ? err.message : err}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Sign in';
    }
}

async function signOut() {
    const pending = (await store.listOutbox()).length;
    const answer = await askChoice({
        title: 'Sign out on this device?',
        text: 'This removes this device\'s copy of the calendar and its saved password. The calendar itself stays on the box, and other devices are not touched.',
        note: pending ? `${pending} change${pending === 1 ? '' : 's'} made on this device ${pending === 1 ? 'has' : 'have'} not reached the box yet and would be lost. Sync first if you can.` : '',
        choices: [
            { value: 'out', label: 'Sign out', kind: 'danger' },
            { value: 'stay', label: 'Stay signed in', kind: 'primary' }
        ]
    });
    if (answer !== 'out') return;
    clearTimeout(state.syncTimer);
    if (state.reminders) state.reminders.stop();
    await store.clearAll();
    broadcast({ type: 'signed-out' });
    location.reload();
}

// ---- starting -------------------------------------------------------------------------------------------------------

let started = false;

async function startApp(session) {
    state.session = session;
    state.prefs = normalizePrefs(await store.getMeta('prefs'));
    state.view = state.prefs.view;
    state.focus = todayKey();
    const dav = new DavClient({ base: session.server, authorization: session.authorization });
    if (state.engine) state.engine.dav = dav;
    else state.engine = new SyncEngine({ dav, store, onChange: onEngineChange, onStatus: onSyncStatus, defaultCalendar: { name: 'Personal', color: '#4caf50' } });
    await loadAll();
    const lastSyncAt = await store.getMeta('lastSyncAt');
    state.syncStatus = { state: lastSyncAt ? 'ok' : 'idle', message: '', pending: state.pendingHrefs.size, lastSyncAt };
    // The app shows once this device's copy is read and drawn, never as an empty shell to tap on.
    byId('signin').hidden = true;
    byId('app').hidden = false;
    paintSyncLine();
    paintNotice();
    render();
    if (!started) {
        started = true;
        state.reminders = startReminders({
            store,
            occurrences: (from, to) => index.occurrences(from, to, state.zone),
            zone: () => state.zone,
            clock,
            notificationsOn: () => state.prefs.notify && notificationState() === 'granted',
            openByKey,
            broadcast
        });
        setInterval(tick, 30000);
        window.addEventListener('online', () => scheduleSync(0));
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (todayKey() !== state.today) { state.focus = todayKey(); render(); }
            if (Date.now() - state.lastSyncStarted > 20000) scheduleSync(0);
        });
    }
    runSync();
}

function tick() {
    if (!state.session) return;
    const today = todayKey();
    if (today !== state.today) {
        if (state.focus === state.today) state.focus = today;
        render();
        return;
    }
    if ((state.view === 'week' || state.view === 'day') && !anyOpen()) render();
}

function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'signed-out') { location.reload(); return; }
    if (message.type === 'signed-in' && !state.session) { location.reload(); return; }
    if (!state.session) return;
    if (message.type === 'changed') {
        applyChanges({ calendars: message.calendars, objects: new Set(message.objects || []) }).then(renderSoon).catch(() => {});
    } else if (message.type === 'prefs') {
        store.getMeta('prefs').then(prefs => { state.prefs = normalizePrefs(prefs); renderSoon(); }).catch(() => {});
    } else if (message.type === 'reminders' && state.reminders) {
        state.reminders.showFromOtherTab(message.items);
    }
}

function wireControls() {
    installOverlayHandlers();
    byId('settingsBtn').addEventListener('click', () => {
        if (!state.session) { openOverlay('helpOverlay'); return; }
        state.settings = openSettings(appContext());
    });
    byId('helpBtn').addEventListener('click', () => openOverlay('helpOverlay'));
    byId('prevBtn').addEventListener('click', () => step(-1));
    byId('nextBtn').addEventListener('click', () => step(1));
    byId('todayBtn').addEventListener('click', () => { state.focus = todayKey(); state.listDays = state.prefs.listDays; render(); });
    for (const button of document.querySelectorAll('.view-switch button')) {
        button.addEventListener('click', () => setView(button.dataset.view));
    }
    byId('newEventBtn').addEventListener('click', () => newEvent(state.view === 'list' ? todayKey() : state.focus));
    byId('sync-now').addEventListener('click', () => runSync({ wait: true }));
    byId('si-go').addEventListener('click', signIn);
    for (const id of ['si-user', 'si-pass', 'si-server']) {
        byId(id).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); signIn(); } });
    }
    narrowQuery.addEventListener('change', () => render());

    document.addEventListener('keydown', event => {
        if (!state.session || anyOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
        const keys = {
            ArrowLeft: () => step(-1), ArrowRight: () => step(1),
            t: () => { state.focus = todayKey(); render(); },
            m: () => setView('month'), w: () => setView('week'), d: () => setView('day'), l: () => setView('list'),
            n: () => newEvent(state.focus),
            '/': () => { setView('list'); requestAnimationFrame(() => { const s = byId('search'); if (s) s.focus(); }); },
            '?': () => openOverlay('helpOverlay')
        };
        const run = keys[event.key];
        if (run) { event.preventDefault(); run(); }
    });

    // A sideways swipe over the month, week or day goes back or forward.
    let touch = null;
    const view = byId('view');
    view.addEventListener('touchstart', event => {
        if (event.touches.length !== 1 || state.view === 'list') { touch = null; return; }
        touch = { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() };
    }, { passive: true });
    view.addEventListener('touchend', event => {
        if (!touch) return;
        const t = event.changedTouches[0];
        const dx = t.clientX - touch.x;
        const dy = t.clientY - touch.y;
        const quick = Date.now() - touch.at < 700;
        touch = null;
        if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    }, { passive: true });

    if (channel) channel.onmessage = event => onMessage(event.data);
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', event => {
            const data = event.data || {};
            if (data.type === 'open-event' && state.session) openByKey(data.key, data.startUtc);
        });
    }
}

async function main() {
    wireControls();
    startUpdates({
        badge: byId('app-version'),
        canSwitch: () => !isOpen('editorOverlay'),
        onBlocked: () => toast('Save or close the event you are editing first; then tap the version again.', { timeoutMs: 5000 })
    });
    let session = null;
    try {
        session = await store.getMeta('session');
    } catch (err) {
        byId('signin').hidden = false;
        const error = byId('si-error');
        error.hidden = false;
        error.textContent = `This browser does not let the calendar keep its copy here (${err && err.message ? err.message : err}). A private window does not allow it; open the app in a normal one.`;
        byId('si-go').disabled = true;
        return;
    }
    if (!session) { showSignIn(); return; }
    await startApp(session);
    const params = new URLSearchParams(location.search);
    if (params.get('open')) openByKey(params.get('open'), Number(params.get('at')) || Date.now());
}

main().catch(err => {
    const notice = byId('notice');
    if (notice) {
        notice.hidden = false;
        notice.className = 'error';
        notice.textContent = `The calendar could not start: ${err && err.message ? err.message : err}`;
    }
    byId('app').hidden = false;
});

