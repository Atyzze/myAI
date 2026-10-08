// Settings: the account, the calendars (shown here or not, color, name, new ones), how new events
// start out, reminders, connecting a phone's own calendar app, import and export, and how this
// device's copy stands.

import { h, clear, byId, append, openOverlay, closeOverlay, askChoice, toast, copyText } from './dom.js';
import { TIMED_ALARM_PRESETS, ALL_DAY_ALARM_PRESETS } from './event-model.js';
import { DURATIONS } from './prefs-core.js';
import { durationText, dayMedium, timeAt, localeWeekStart, localeClock, deviceLocale } from './format.js';
import { dateKey } from './wall.js';
import { utcToWall } from './tz.js';

const COLORS = ['#4caf50', '#2196f3', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4', '#f44336', '#795548', '#607d8b', '#cddc39'];

function section(label, ...children) {
    return h('div', { class: 'field', style: { gap: '10px' } }, h('span', { class: 'section-label' }, label), ...children);
}

function copyRow(text, label) {
    return h('div', { class: 'copyable' }, h('code', null, text),
        h('button', { type: 'button', 'aria-label': `Copy ${label}`, onclick: async () => {
            toast(await copyText(text) ? `${label} copied.` : 'Could not copy; select it and copy by hand.', { timeoutMs: 2500 });
        } }, 'Copy'));
}

function whenText(ms, ctx) {
    if (!ms) return 'never';
    const w = utcToWall(ms, ctx.zone);
    return `${dayMedium(dateKey(w))}, ${timeAt(ms, ctx.zone, ctx.clock)}`;
}

function alarmSelect(value, presets, onChange, id) {
    const select = h('select', { class: 'select', id },
        h('option', { value: 'none' }, 'No reminder'),
        presets.map(p => h('option', { value: String(p.seconds) }, p.label)));
    if (value != null && !presets.some(p => p.seconds === value)) select.append(h('option', { value: String(value) }, `${Math.round(-value / 60)} minutes before`));
    select.value = value == null ? 'none' : String(value);
    select.addEventListener('change', () => onChange(select.value === 'none' ? null : Number(select.value)));
    return select;
}

function calendarRows(ctx, rerender) {
    const rows = h('div', { class: 'field', style: { gap: '8px' } });
    const calendars = ctx.calendars();
    if (!calendars.length) rows.append(h('div', { class: 'hint' }, 'No calendars yet: the first sync makes one.'));
    for (const cal of calendars) {
        const shown = !ctx.prefs.hidden.includes(cal.href);
        const visible = h('input', { type: 'checkbox', checked: shown, 'aria-label': `Show ${cal.name}`, title: 'Show on this device',
            onchange: () => ctx.setPrefs({ hidden: visible.checked ? ctx.prefs.hidden.filter(x => x !== cal.href) : [...ctx.prefs.hidden, cal.href] }) });
        const color = h('input', { type: 'color', value: cal.color || '#4caf50', 'aria-label': `Color of ${cal.name}`, disabled: cal.readOnly });
        const name = h('input', { class: 'input', value: cal.name, 'aria-label': 'Calendar name', disabled: cal.readOnly });
        const commit = async () => {
            const newName = name.value.trim() || cal.name;
            const newColor = color.value;
            if (newName === cal.name && newColor === (cal.color || '#4caf50')) return;
            try {
                await ctx.actions.changeCalendar(cal.href, { name: newName, color: newColor });
                toast('Calendar changed.', { timeoutMs: 2500 });
            } catch (err) {
                toast(`Not changed: ${err.message}`, { kind: 'error' });
                name.value = cal.name;
                color.value = cal.color || '#4caf50';
            }
        };
        color.addEventListener('change', commit);
        name.addEventListener('change', commit);
        rows.append(h('div', { class: 'cal-row', 'data-calendar': cal.href }, visible, color, name,
            h('button', { type: 'button', class: 'btn quiet', style: { padding: '6px 9px', fontSize: '12px' }, title: 'Download this calendar as an .ics file',
                onclick: () => ctx.actions.exportCalendar(cal.href) }, '⬇ .ics')));
        rows.append(h('div', { class: 'hint', style: { marginTop: '-4px', paddingLeft: '30px' } },
            `${ctx.countIn(cal.href)} event${ctx.countIn(cal.href) === 1 ? '' : 's'}${cal.readOnly ? ', read only' : ''}`));
    }

    const writable = calendars.filter(c => !c.readOnly);
    if (writable.length > 1) {
        const target = h('select', { class: 'select', id: 'st-default-calendar' }, writable.map(c => h('option', { value: c.href }, c.name)));
        target.value = (ctx.defaultCalendar() || {}).href || '';
        target.addEventListener('change', () => ctx.setPrefs({ defaultCalendar: target.value }));
        rows.append(h('div', { class: 'field' }, h('label', { for: 'st-default-calendar' }, 'New events go to'), target));
    }

    const newName = h('input', { class: 'input', placeholder: 'Name of a new calendar', 'aria-label': 'Name of a new calendar' });
    const newColor = h('input', { type: 'color', value: COLORS[calendars.length % COLORS.length], 'aria-label': 'Its color' });
    const create = h('button', { type: 'button', class: 'btn', onclick: async () => {
        const name = newName.value.trim();
        if (!name) { newName.focus(); return; }
        create.disabled = true;
        try {
            await ctx.actions.createCalendar({ name, color: newColor.value });
            toast(`Calendar "${name}" made.`, { timeoutMs: 3000 });
            rerender();
        } catch (err) {
            toast(`Not made: ${err.message}`, { kind: 'error' });
        } finally {
            create.disabled = false;
        }
    } }, '＋ Add');
    rows.append(h('div', { class: 'cal-row' }, newColor, newName, create));

    if (writable.length > 1) {
        const which = h('select', { class: 'select' }, writable.map(c => h('option', { value: c.href }, c.name)));
        rows.append(h('details', { class: 'hint' }, h('summary', null, 'Remove a calendar…'),
            h('div', { class: 'field', style: { marginTop: '6px' } }, which,
                h('button', { type: 'button', class: 'btn danger', onclick: async () => {
                    const cal = writable.find(c => c.href === which.value);
                    if (!cal) return;
                    const count = ctx.countIn(cal.href);
                    const answer = await askChoice({
                        title: `Remove "${cal.name}"?`,
                        text: `This removes the calendar and its ${count} event${count === 1 ? '' : 's'} from the box, and from every device and phone that shows it. It cannot be undone here.`,
                        note: 'To keep a copy, download it first (⬇ .ics next to its name).',
                        choices: [
                            { value: 'remove', label: `Remove "${cal.name}" and its events`, kind: 'danger' },
                            { value: 'cancel', label: 'Keep it', kind: 'primary' }
                        ]
                    });
                    if (answer !== 'remove') return;
                    try {
                        await ctx.actions.deleteCalendar(cal.href);
                        toast(`"${cal.name}" removed.`, { timeoutMs: 4000 });
                        rerender();
                    } catch (err) {
                        toast(`Not removed: ${err.message}`, { kind: 'error' });
                    }
                } }, 'Remove it'))));
    }
    return rows;
}

function phoneGuides(ctx) {
    const origin = location.origin;
    const dav = new URL(ctx.session.server, location.href).href;
    const host = location.host;
    const user = ctx.session.user;
    const secure = location.protocol === 'https:';
    return h('div', { class: 'field', style: { gap: '8px' } },
        h('p', { class: 'hint' }, 'Add this calendar to your phone\'s own calendar app as well: its reminders then go off on time, also with no connection and with this app closed. Use the same name and password as here.'),
        secure ? null : h('div', { class: 'warn-box' }, 'This page is not opened over https. Phones want https for a calendar account: open the app through the box\'s https address (the tailnet one) and set up the phone from there.'),
        h('details', { class: 'guide' }, h('summary', null, '📱 iPhone and iPad'),
            h('ol', null,
                h('li', null, 'Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add CalDAV Account. (On older iOS: Settings → Calendar → Accounts.)'),
                h('li', null, 'Server: ', h('b', null, host)),
                h('li', null, 'User name: ', h('b', null, user), ', and your password. Description: myAI.'),
                h('li', null, 'If it says it cannot verify the account: Advanced Settings → Account URL: ', h('b', null, `${dav}${encodeURIComponent(user)}/`)),
                h('li', null, 'Then in the Calendar app: Calendars, and make sure the myAI ones are ticked.'))),
        h('details', { class: 'guide' }, h('summary', null, '🤖 Android'),
            h('ol', null,
                h('li', null, 'Install DAVx⁵ (free on F-Droid; also on Google Play).'),
                h('li', null, 'In DAVx⁵: ＋ → Login with URL and user name.'),
                h('li', null, 'Base URL: ', h('b', null, dav), ', user name ', h('b', null, user), ', your password.'),
                h('li', null, 'Create the account, tick the calendars to sync, and let DAVx⁵ run in the background when it asks.'),
                h('li', null, 'They now show in the phone\'s calendar app (Google Calendar, Etar, ...), which rings for the reminders.'))),
        h('details', { class: 'guide' }, h('summary', null, '💻 Mac, Thunderbird and others'),
            h('ol', null,
                h('li', null, 'Mac Calendar: Settings → Accounts → ＋ → Other CalDAV Account → Manual, server ', h('b', null, origin), ', path /dav/.'),
                h('li', null, 'Thunderbird: New Calendar → On the Network → location ', h('b', null, dav), ', it finds the calendars itself.'),
                h('li', null, 'Anything else that speaks CalDAV: the address below and your name and password.'))),
        copyRow(dav, 'The calendar address'),
        copyRow(user, 'The user name'));
}

export function openSettings(ctx) {
    const panel = byId('settingsPanel');
    const render = () => {
        clear(panel);
        const prefs = ctx.prefs;

        const weekStart = h('select', { class: 'select', id: 'st-week-start' },
            h('option', { value: 'auto' }, `As this device says (${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][localeWeekStart(deviceLocale())]})`),
            h('option', { value: '1' }, 'Monday'), h('option', { value: '0' }, 'Sunday'), h('option', { value: '6' }, 'Saturday'));
        weekStart.value = prefs.weekStart == null ? 'auto' : String(prefs.weekStart);
        weekStart.addEventListener('change', () => ctx.setPrefs({ weekStart: weekStart.value === 'auto' ? null : Number(weekStart.value) }));

        const clock = h('select', { class: 'select', id: 'st-clock' },
            h('option', { value: 'auto' }, `As this device says (${localeClock(deviceLocale()) === '12' ? '12-hour' : '24-hour'})`),
            h('option', { value: '24' }, '24-hour (14:30)'), h('option', { value: '12' }, '12-hour (2:30 PM)'));
        clock.value = prefs.clock || 'auto';
        clock.addEventListener('change', () => ctx.setPrefs({ clock: clock.value === 'auto' ? null : clock.value }));

        const duration = h('select', { class: 'select', id: 'st-duration' }, DURATIONS.map(m => h('option', { value: String(m) }, durationText(m))));
        duration.value = String(prefs.durationMinutes);
        duration.addEventListener('change', () => ctx.setPrefs({ durationMinutes: Number(duration.value) }));

        const notifyState = ctx.notificationState();
        const notify = h('input', { type: 'checkbox', id: 'st-notify', checked: prefs.notify && notifyState === 'granted', disabled: notifyState === 'unsupported' || notifyState === 'denied' });
        notify.addEventListener('change', async () => {
            if (notify.checked) {
                const granted = await ctx.actions.enableNotifications();
                if (!granted) notify.checked = false;
            } else {
                ctx.setPrefs({ notify: false });
            }
            render();
        });
        const notifyHint = {
            unsupported: 'This browser cannot show notifications from a web page.',
            denied: 'Notifications are blocked for this site in the browser\'s settings; reminders still show in the app while it is open.',
            default: 'Reminders show in the app while it is open. With this on they also show as notifications, also while the tab is in the background.',
            granted: 'Reminders show in the app and as notifications while the app is open (also in a background tab).'
        }[notifyState];

        const importFile = h('input', { type: 'file', accept: '.ics,text/calendar', id: 'st-import-file', class: 'input' });
        const writable = ctx.calendars().filter(c => !c.readOnly);
        const importTarget = h('select', { class: 'select', id: 'st-import-target' }, writable.map(c => h('option', { value: c.href }, c.name)));
        importTarget.value = (ctx.defaultCalendar() || {}).href || '';
        const importResult = h('div', { class: 'hint', id: 'st-import-result', role: 'status' });
        const importButton = h('button', { type: 'button', class: 'btn', id: 'st-import', onclick: async () => {
            const file = importFile.files && importFile.files[0];
            if (!file) { importResult.textContent = 'Choose an .ics file first.'; return; }
            importButton.disabled = true;
            importResult.textContent = 'Reading…';
            try {
                const result = await ctx.actions.importFile(file, importTarget.value);
                importResult.textContent = result;
            } catch (err) {
                importResult.textContent = `Not imported: ${err.message}`;
            } finally {
                importButton.disabled = false;
            }
        } }, 'Import');

        const storage = h('div', { class: 'hint', id: 'st-storage' }, 'Checking this device\'s storage…');
        ctx.storageInfo().then(info => { storage.textContent = info; }).catch(() => { storage.textContent = ''; });

        append(panel, [
            h('div', { class: 'panel-head' }, h('h2', { id: 'st-title' }, '⚙️ Settings'),
                h('button', { class: 'close-btn', type: 'button', 'data-close': 'settingsOverlay' }, '✕ Close')),

            section('Account',
                h('div', { class: 'hint' }, 'Signed in as ', h('b', { style: { color: '#ddd' } }, ctx.session.user), ` on ${location.host}.`),
                h('button', { type: 'button', class: 'btn quiet', id: 'st-signout', onclick: () => ctx.actions.signOut() }, 'Sign out on this device')),
            h('hr', { class: 'divider' }),

            section('Calendars', calendarRows(ctx, render)),
            h('hr', { class: 'divider' }),

            section('New events',
                h('div', { class: 'field' }, h('label', { for: 'st-alarm' }, 'Reminder for a new event'),
                    alarmSelect(prefs.alarmSeconds, TIMED_ALARM_PRESETS, v => ctx.setPrefs({ alarmSeconds: v }), 'st-alarm')),
                h('div', { class: 'field' }, h('label', { for: 'st-allday-alarm' }, 'Reminder for a new all-day event'),
                    alarmSelect(prefs.allDayAlarmSeconds, ALL_DAY_ALARM_PRESETS, v => ctx.setPrefs({ allDayAlarmSeconds: v }), 'st-allday-alarm')),
                h('div', { class: 'field' }, h('label', { for: 'st-duration' }, 'How long a new event lasts'), duration)),
            h('hr', { class: 'divider' }),

            section('This device',
                h('div', { class: 'field' }, h('label', { for: 'st-week-start' }, 'Weeks start on'), weekStart),
                h('div', { class: 'field' }, h('label', { for: 'st-clock' }, 'Clock'), clock),
                h('label', { class: 'check', for: 'st-notify' }, notify, 'Reminders as notifications'),
                h('div', { class: 'hint' }, notifyHint)),
            h('hr', { class: 'divider' }),

            section('Connect your phone', phoneGuides(ctx)),
            h('hr', { class: 'divider' }),

            section('Import and export',
                h('div', { class: 'hint' }, 'Import an .ics file exported from Google, Apple, Outlook or this app. Importing the same file again updates what it brought in instead of adding it twice.'),
                importFile,
                writable.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'st-import-target' }, 'Into'), importTarget) : null,
                importButton, importResult,
                h('button', { type: 'button', class: 'btn quiet', onclick: () => ctx.actions.exportAll() }, '⬇ Download all calendars (.ics)')),
            h('hr', { class: 'divider' }),

            h('div', { id: 'st-kept' }),

            section('Sync',
                h('div', { class: 'hint', id: 'st-sync-status' }),
                h('div', { class: 'btn-row' },
                    h('button', { type: 'button', class: 'btn', onclick: async () => { await ctx.actions.syncNow(); refreshStatus(); } }, '⟳ Sync now'),
                    h('button', { type: 'button', class: 'btn quiet', title: 'Fetches every event again from the box; changes made here and not yet sent are kept',
                        onclick: async () => { await ctx.actions.syncNow({ full: true }); refreshStatus(); } }, 'Fetch everything again')),
                h('div', { id: 'st-problems' }),
                storage)
        ]);
        refreshStatus();
        refreshKept();
    };

    // Copies this device kept of events that went from the box in bulk (sync.js keepCopy).
    const refreshKept = async () => {
        const host = byId('st-kept');
        if (!host) return;
        const copies = await ctx.keptCopies();
        clear(host);
        if (!copies.length) return;
        host.append(section('Kept on this device',
            h('div', { class: 'hint' }, 'When many events go from the box at once (removed on another device, or lost on the box), this device keeps a copy. Put them back, download them, or let them go.'),
            copies.map(copy => h('div', { class: 'warn-box', 'data-kept': copy.id },
                h('div', null, `${whenText(copy.at, ctx)}: ${copy.items.length} event${copy.items.length === 1 ? '' : 's'} `,
                    copy.reason === 'calendar' ? `of the calendar "${copy.calendar.name}", which is no longer on the box.` : `of "${copy.calendar.name}" went from the box.`),
                h('div', { class: 'btn-row', style: { marginTop: '8px' } },
                    h('button', { type: 'button', class: 'btn primary', 'data-action': 'restore', onclick: async event => {
                        event.target.disabled = true;
                        try {
                            const result = await ctx.actions.restoreCopy(copy);
                            toast(`${result.restored} event${result.restored === 1 ? '' : 's'} put back${result.skipped ? ` (${result.skipped} were there already)` : ''}; they go to the box with the next sync.`, { timeoutMs: 6000 });
                        } catch (err) {
                            toast(`Not put back: ${err.message}`, { kind: 'error' });
                        }
                        refreshKept();
                    } }, 'Put them back'),
                    h('button', { type: 'button', class: 'btn', onclick: () => ctx.actions.downloadCopy(copy) }, '⬇ .ics'),
                    h('button', { type: 'button', class: 'btn quiet', onclick: async () => { await ctx.actions.discardCopy(copy.id); refreshKept(); } }, 'Let them go'))))),
            h('hr', { class: 'divider' }));
    };

    // The parts that change with every sync, updated on their own: drawing the whole panel again
    // would throw away what someone is typing in it.
    const refreshStatus = () => {
        const status = ctx.syncStatus();
        const problems = ctx.problems();
        const line = byId('st-sync-status');
        const list = byId('st-problems');
        if (!line || !list) return;
        line.textContent = `Last synced: ${whenText(status.lastSyncAt, ctx)}. `
            + (status.pending ? `${status.pending} change${status.pending === 1 ? '' : 's'} on this device not yet on the box.` : 'Everything changed here is on the box.');
        clear(list);
        list.append(problems.length
            ? h('div', { class: 'field', style: { gap: '6px' } },
                h('span', { class: 'label' }, 'Recent sync problems'),
                problems.map(p => h('div', { class: 'problem' }, `${whenText(p.at, ctx)}: ${p.summary ? `"${p.summary}": ` : ''}${p.message}`)))
            : h('div', { class: 'hint' }, 'No sync problems.'));
    };

    render();
    openOverlay('settingsOverlay', { onClose: () => ctx.onSettingsClosed && ctx.onSettingsClosed() });
    return { render, refreshStatus, refreshKept };
}

export function closeSettings() {
    closeOverlay('settingsOverlay');
}
