// The event editor: title, when, how it repeats, reminders, calendar, place and notes. It works on
// the plain form of event-model.js; saving (and asking which occurrences a change is for) is the
// app's job, through ctx.actions.save.

import { h, clear, byId, append, openOverlay, closeOverlay, askChoice } from './dom.js';
import { TIMED_ALARM_PRESETS, ALL_DAY_ALARM_PRESETS, describeAlarmSeconds } from './event-model.js';
import { parseDateKey, dateKey, addDays, weekdayOf, daysInMonth, wallNumber, WEEKDAY_CODE } from './wall.js';
import { WEEKDAYS, MONTHS, weekdayNameOf } from './format.js';
import { parseRecur } from './icalendar.js';
import { describeRule } from './rrule.js';

const WEEK_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' };

function nthOfMonth(date) {
    return date.day + 7 > daysInMonth(date.year, date.month) ? -1 : Math.ceil(date.day / 7);
}

function sameList(a, b) {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

// Which of the simple choices a repeat is, or 'custom'.
export function presetOf(repeat, startKey) {
    if (!repeat || !repeat.freq) return 'none';
    const start = parseDateKey(startKey) || today();
    if ((repeat.interval || 1) !== 1) return 'custom';
    if (repeat.freq === 'DAILY') return 'daily';
    if (repeat.freq === 'WEEKLY') {
        const days = repeat.byday && repeat.byday.length ? repeat.byday : [WEEKDAY_CODE[weekdayOf(start)]];
        if (sameList(days, [WEEKDAY_CODE[weekdayOf(start)]])) return 'weekly';
        if (sameList(days, WORKDAYS)) return 'weekdays';
        return 'custom';
    }
    if (repeat.freq === 'MONTHLY') return repeat.monthlyBy === 'weekday' ? 'monthly-weekday' : 'monthly-day';
    if (repeat.freq === 'YEARLY') return 'yearly';
    return 'custom';
}

function today() {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: 0, minute: 0, second: 0 };
}

function presetLabels(startKey) {
    const start = parseDateKey(startKey) || today();
    const weekday = WEEKDAYS[weekdayOf(start)];
    const nth = nthOfMonth(start);
    return {
        none: 'Does not repeat',
        daily: 'Every day',
        weekly: `Every week on ${weekday}`,
        weekdays: 'Every weekday (Monday to Friday)',
        'monthly-day': `Every month on day ${start.day}`,
        'monthly-weekday': `Every month on the ${ORDINALS[nth]} ${weekday}`,
        yearly: `Every year on ${start.day} ${MONTHS[start.month - 1]}`,
        custom: 'Custom…'
    };
}

// The repeat a preset (and the custom controls) stands for.
export function repeatFromPreset(preset, custom, ends, startKey) {
    const start = parseDateKey(startKey) || today();
    const base = { interval: 1, byday: [], monthlyBy: 'monthday', ends: ends.ends, until: ends.until, count: ends.count };
    switch (preset) {
        case 'daily': return { ...base, freq: 'DAILY' };
        case 'weekly': return { ...base, freq: 'WEEKLY', byday: [WEEKDAY_CODE[weekdayOf(start)]] };
        case 'weekdays': return { ...base, freq: 'WEEKLY', byday: [...WORKDAYS] };
        case 'monthly-day': return { ...base, freq: 'MONTHLY' };
        case 'monthly-weekday': return { ...base, freq: 'MONTHLY', monthlyBy: 'weekday' };
        case 'yearly': return { ...base, freq: 'YEARLY' };
        case 'custom': return {
            ...base, freq: custom.freq, interval: Math.max(1, parseInt(custom.interval, 10) || 1),
            byday: custom.freq === 'WEEKLY' ? (custom.byday.length ? [...custom.byday] : [WEEKDAY_CODE[weekdayOf(start)]]) : [],
            monthlyBy: custom.freq === 'MONTHLY' ? custom.monthlyBy : 'monthday'
        };
        default: return null;
    }
}

function minutesBetween(aDate, aTime, bDate, bTime) {
    const a = parseDateKey(aDate);
    const b = parseDateKey(bDate);
    if (!a || !b) return 60;
    const [ah, am] = String(aTime || '00:00').split(':').map(Number);
    const [bh, bm] = String(bTime || '00:00').split(':').map(Number);
    return Math.round((wallNumber({ ...b, hour: bh || 0, minute: bm || 0 }) - wallNumber({ ...a, hour: ah || 0, minute: am || 0 })) / 60000);
}

function addMinutes(dateText, timeText, minutes) {
    const d = parseDateKey(dateText);
    const [hh, mm] = String(timeText || '00:00').split(':').map(Number);
    const t = new Date(wallNumber({ ...d, hour: hh || 0, minute: mm || 0 }) + minutes * 60000);
    const pad = n => String(n).padStart(2, '0');
    return {
        date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
        time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`
    };
}

function zoneList(current) {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = []; }
    if (!zones.length) zones = ['UTC', 'Europe/Amsterdam', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
    if (current && !zones.includes(current)) zones = [current, ...zones];
    return zones;
}

// Opens the editor. `spec`: { mode: 'new' | 'edit', form, occurrence, record, heading }.
export function openEditor(ctx, spec) {
    const panel = byId('editorPanel');
    clear(panel);
    const original = JSON.stringify(spec.form);
    const f = JSON.parse(original);
    const calendars = ctx.writableCalendars();
    if (!f.calendar || !calendars.some(c => c.href === f.calendar)) f.calendar = (ctx.defaultCalendar() || {}).href || null;
    let preset = f.repeatCustom ? 'keep' : presetOf(f.repeat, f.startDate);
    const custom = {
        freq: (f.repeat && f.repeat.freq) || 'WEEKLY',
        interval: (f.repeat && f.repeat.interval) || 1,
        byday: (f.repeat && f.repeat.byday && f.repeat.byday.length) ? [...f.repeat.byday] : [],
        monthlyBy: (f.repeat && f.repeat.monthlyBy) || 'monthday'
    };
    const ends = {
        ends: (f.repeat && f.repeat.ends) || 'never',
        until: (f.repeat && f.repeat.until) || '',
        count: (f.repeat && f.repeat.count) || 10
    };
    let saving = false;

    const field = (label, control, id) => h('div', { class: 'field' }, h('label', id ? { for: id } : null, label), control);

    // ---- title ----
    const title = h('input', { class: 'input', id: 'ed-summary', value: f.summary, placeholder: 'What is it?', autocomplete: 'off', maxlength: '500' });

    // ---- when ----
    const allDay = h('input', { type: 'checkbox', id: 'ed-allday', checked: f.allDay });
    const startDate = h('input', { class: 'input', type: 'date', id: 'ed-start-date', value: f.startDate, required: true });
    const startTime = h('input', { class: 'input', type: 'time', id: 'ed-start-time', value: f.startTime, step: '300' });
    const endDate = h('input', { class: 'input', type: 'date', id: 'ed-end-date', value: f.endDate });
    const endTime = h('input', { class: 'input', type: 'time', id: 'ed-end-time', value: f.endTime, step: '300' });
    const whenError = h('div', { class: 'err-box', hidden: true });
    const zoneSelect = h('select', { class: 'select', id: 'ed-zone' },
        f.zoneId === null && spec.mode === 'edit' && !f.allDay ? h('option', { value: '' }, 'Floating: the same clock time everywhere') : null,
        zoneList(f.zoneId || ctx.zoneId).map(z => h('option', { value: z, selected: z === (f.zoneId || (spec.mode === 'edit' && !f.allDay ? '' : ctx.zoneId)) }, z.replace(/_/g, ' '))));
    if (f.zoneId === null && spec.mode === 'edit' && !f.allDay) zoneSelect.value = '';
    const zoneSummary = h('summary', null);
    const zoneBox = h('details', { class: 'hint' }, zoneSummary,
        h('div', { class: 'field', style: { marginTop: '6px' } }, zoneSelect,
            h('span', null, 'The times above are clock times in this zone. Seen from elsewhere, the event moves with it.')));

    const timeRow = (dateInput, timeInput) => h('div', { class: 'row' }, dateInput, timeInput);
    let lastStart = { date: f.startDate, time: f.startTime };

    function paintWhen() {
        const isAllDay = allDay.checked;
        startTime.hidden = isAllDay;
        endTime.hidden = isAllDay;
        zoneBox.hidden = isAllDay;
        const zone = zoneSelect.value;
        zoneSummary.textContent = `Time zone: ${zone ? zone.replace(/_/g, ' ') : 'floating'}${zone && zone !== ctx.zoneId ? ' (not this device\'s)' : ''}`;
        whenError.hidden = true;
        const minutes = minutesBetween(startDate.value, isAllDay ? '00:00' : startTime.value, endDate.value || startDate.value, isAllDay ? '00:00' : endTime.value);
        if (minutes < 0) {
            whenError.hidden = false;
            whenError.textContent = 'It ends before it starts.';
        }
    }

    startDate.addEventListener('change', () => {
        // Moving the start moves the end with it, so the length stays.
        if (!startDate.value) return;
        const length = minutesBetween(lastStart.date, lastStart.time, endDate.value || lastStart.date, endTime.value || lastStart.time);
        const moved = addMinutes(startDate.value, startTime.value, Math.max(0, length));
        endDate.value = moved.date;
        if (!allDay.checked) endTime.value = moved.time;
        lastStart = { date: startDate.value, time: startTime.value };
        paintRepeat();
        paintWhen();
    });
    startTime.addEventListener('change', () => {
        if (!startTime.value) return;
        const length = minutesBetween(lastStart.date, lastStart.time, endDate.value || lastStart.date, endTime.value || lastStart.time);
        const moved = addMinutes(startDate.value, startTime.value, Math.max(0, length));
        endDate.value = moved.date;
        endTime.value = moved.time;
        lastStart = { date: startDate.value, time: startTime.value };
        paintWhen();
    });
    endDate.addEventListener('change', paintWhen);
    endTime.addEventListener('change', paintWhen);
    zoneSelect.addEventListener('change', paintWhen);
    allDay.addEventListener('change', () => {
        // Reminders that were this device's default for the other kind of event become the default
        // for this kind; ones chosen by hand stay.
        const before = allDay.checked ? ctx.prefs.alarmSeconds : ctx.prefs.allDayAlarmSeconds;
        const after = allDay.checked ? ctx.prefs.allDayAlarmSeconds : ctx.prefs.alarmSeconds;
        const isDefault = f.alarms.length === 0 || (f.alarms.length === 1 && f.alarms[0] === before);
        if (isDefault) f.alarms = after == null ? [] : [after];
        if (!allDay.checked && (!startTime.value || !endTime.value)) {
            startTime.value = startTime.value || '09:00';
            const moved = addMinutes(startDate.value, startTime.value, ctx.prefs.durationMinutes);
            endTime.value = moved.time;
            if (endDate.value < startDate.value) endDate.value = startDate.value;
        }
        paintWhen();
        paintAlarms();
    });

    // ---- repeat ----
    const repeatSelect = h('select', { class: 'select', id: 'ed-repeat' });
    const customBox = h('div', { class: 'field', style: { gap: '8px' } });
    const endsBox = h('div', { class: 'field', style: { gap: '6px' } });
    const keepNote = h('div', { class: 'hint' });

    const intervalInput = h('input', { class: 'input', id: 'ed-interval', type: 'number', min: '1', max: '999', value: String(custom.interval), style: { width: '80px' }, 'aria-label': 'Every how many' });
    const unitSelect = h('select', { class: 'select', id: 'ed-unit', style: { flex: '1' }, 'aria-label': 'Unit' },
        [['DAILY', 'days'], ['WEEKLY', 'weeks'], ['MONTHLY', 'months'], ['YEARLY', 'years']]
            .map(([v, label]) => h('option', { value: v, selected: v === custom.freq }, label)));
    const weekdayChips = h('div', { class: 'weekday-chips', role: 'group', 'aria-label': 'On these days' });
    const monthlySelect = h('select', { class: 'select', id: 'ed-monthly', 'aria-label': 'Which day of the month' });
    const endsSelect = h('select', { class: 'select', id: 'ed-ends', 'aria-label': 'Ends', style: { flex: '1' } },
        h('option', { value: 'never' }, 'Never ends'), h('option', { value: 'until' }, 'Ends on a date'), h('option', { value: 'count' }, 'Ends after a number of times'));
    endsSelect.value = ends.ends;
    const untilInput = h('input', { class: 'input', id: 'ed-until', type: 'date', value: ends.until, 'aria-label': 'Last day', style: { flex: '1' } });
    const countInput = h('input', { class: 'input', id: 'ed-count', type: 'number', min: '1', max: '9999', value: String(ends.count), 'aria-label': 'Number of times', style: { width: '90px' } });
    const repeatError = h('div', { class: 'err-box', hidden: true });

    function paintRepeat() {
        const labels = presetLabels(startDate.value);
        const options = ['none', 'daily', 'weekly', 'weekdays', 'monthly-day', 'monthly-weekday', 'yearly', 'custom'];
        clear(repeatSelect);
        if (f.repeatCustom) repeatSelect.append(h('option', { value: 'keep' }, 'As it was set up elsewhere (kept)'));
        for (const key of options) repeatSelect.append(h('option', { value: key }, labels[key]));
        repeatSelect.value = preset;
        keepNote.hidden = preset !== 'keep';
        if (preset === 'keep') {
            const rule = parseRecur(f.repeatCustom);
            keepNote.textContent = `Repeats: ${rule ? describeRule(rule, { weekdayName: weekdayNameOf }) : f.repeatCustom}. Changing it here replaces that rule.`;
        }
        customBox.hidden = preset !== 'custom';
        endsBox.hidden = preset === 'none' || preset === 'keep';
        const start = parseDateKey(startDate.value) || parseDateKey(f.startDate) || today();
        clear(weekdayChips);
        const order = [...WEEK_CODES.slice((ctx.weekStart + 6) % 7), ...WEEK_CODES.slice(0, (ctx.weekStart + 6) % 7)];
        for (const code of order) {
            const pressed = custom.byday.length ? custom.byday.includes(code) : code === WEEKDAY_CODE[weekdayOf(start)];
            weekdayChips.append(h('button', {
                type: 'button', 'aria-pressed': pressed ? 'true' : 'false', 'data-day': code,
                onclick: () => {
                    const current = custom.byday.length ? custom.byday : [WEEKDAY_CODE[weekdayOf(start)]];
                    custom.byday = current.includes(code) ? current.filter(c => c !== code) : [...current, code];
                    paintRepeat();
                }
            }, weekdayNameOf(code).slice(0, 2)));
        }
        weekdayChips.hidden = unitSelect.value !== 'WEEKLY';
        clear(monthlySelect);
        monthlySelect.append(h('option', { value: 'monthday' }, `On day ${start.day}`),
            h('option', { value: 'weekday' }, `On the ${ORDINALS[nthOfMonth(start)]} ${WEEKDAYS[weekdayOf(start)]}`));
        monthlySelect.value = custom.monthlyBy;
        monthlySelect.hidden = unitSelect.value !== 'MONTHLY';
        untilInput.hidden = endsSelect.value !== 'until';
        countInput.hidden = endsSelect.value !== 'count';
        if (endsSelect.value === 'until' && !untilInput.value) untilInput.value = dateKey(addDays(start, 30));
    }

    repeatSelect.addEventListener('change', () => { preset = repeatSelect.value; paintRepeat(); });
    unitSelect.addEventListener('change', () => { custom.freq = unitSelect.value; paintRepeat(); });
    intervalInput.addEventListener('change', () => { custom.interval = intervalInput.value; });
    monthlySelect.addEventListener('change', () => { custom.monthlyBy = monthlySelect.value; });
    endsSelect.addEventListener('change', paintRepeat);

    append(customBox, [
        h('div', { class: 'row' }, h('span', { class: 'label' }, 'Every'), intervalInput, unitSelect),
        weekdayChips, monthlySelect
    ]);
    append(endsBox, [h('div', { class: 'row' }, endsSelect, untilInput, countInput), repeatError]);

    // ---- reminders ----
    const alarmChips = h('div', { class: 'alarm-chips' });
    const addAlarm = h('select', { class: 'select', id: 'ed-add-alarm', 'aria-label': 'Add a reminder' });
    const otherAmount = h('input', { class: 'input', type: 'number', min: '0', max: '999', value: '30', style: { width: '80px' }, 'aria-label': 'How long before' });
    const otherUnit = h('select', { class: 'select', style: { flex: '1' }, 'aria-label': 'Unit' },
        h('option', { value: '60' }, 'minutes before'), h('option', { value: '3600' }, 'hours before'), h('option', { value: '86400' }, 'days before'));
    const otherBox = h('div', { class: 'row', hidden: true }, otherAmount, otherUnit,
        h('button', { type: 'button', class: 'btn', onclick: () => {
            const seconds = -Math.max(0, parseInt(otherAmount.value, 10) || 0) * Number(otherUnit.value);
            if (!f.alarms.includes(seconds)) f.alarms.push(seconds);
            otherBox.hidden = true;
            paintAlarms();
        } }, 'Add'));

    function paintAlarms() {
        clear(alarmChips);
        const isAllDay = allDay.checked;
        f.alarms.sort((a, b) => b - a);
        for (const seconds of f.alarms) {
            alarmChips.append(h('span', { class: 'alarm-chip', 'data-seconds': String(seconds) }, `🔔 ${describeAlarmSeconds(seconds, isAllDay)}`,
                h('button', { type: 'button', 'aria-label': 'Remove this reminder', onclick: () => { f.alarms = f.alarms.filter(s => s !== seconds); paintAlarms(); } }, '✕')));
        }
        for (const custom of f.customAlarms) {
            alarmChips.append(h('span', { class: 'alarm-chip custom', title: 'Set up in another app; kept as it is' }, `🔔 ${custom.label}`,
                h('button', { type: 'button', 'aria-label': 'Remove this reminder', onclick: () => { f.customAlarms = f.customAlarms.filter(c => c !== custom); paintAlarms(); } }, '✕')));
        }
        if (!f.alarms.length && !f.customAlarms.length) alarmChips.append(h('span', { class: 'hint' }, 'No reminders.'));
        clear(addAlarm);
        addAlarm.append(h('option', { value: '' }, '＋ Add a reminder…'));
        for (const p of (isAllDay ? ALL_DAY_ALARM_PRESETS : TIMED_ALARM_PRESETS)) {
            if (!f.alarms.includes(p.seconds)) addAlarm.append(h('option', { value: String(p.seconds) }, p.label));
        }
        if (!isAllDay) addAlarm.append(h('option', { value: 'other' }, 'Other…'));
        addAlarm.value = '';
    }
    addAlarm.addEventListener('change', () => {
        if (addAlarm.value === 'other') { otherBox.hidden = false; addAlarm.value = ''; return; }
        if (addAlarm.value !== '') {
            const seconds = Number(addAlarm.value);
            if (!f.alarms.includes(seconds)) f.alarms.push(seconds);
        }
        paintAlarms();
    });

    // ---- calendar, place, notes ----
    const calendarSelect = h('select', { class: 'select', id: 'ed-calendar' },
        calendars.map(c => h('option', { value: c.href, selected: c.href === f.calendar }, c.name)));
    const calendarDot = h('span', { class: 'cal-dot' });
    const paintCalendarDot = () => {
        const cal = calendars.find(c => c.href === calendarSelect.value);
        calendarDot.style.setProperty('--c', (cal && cal.color) || '#4caf50');
    };
    calendarSelect.addEventListener('change', paintCalendarDot);
    const location = h('input', { class: 'input', id: 'ed-location', value: f.location, placeholder: 'Address or place', autocomplete: 'off' });
    const notes = h('textarea', { class: 'textarea', id: 'ed-notes', placeholder: 'Notes, links, phone numbers…' });
    notes.value = f.description;

    // ---- reading the form back ----
    function collect() {
        const out = {
            ...f,
            summary: title.value.trim(),
            allDay: allDay.checked,
            startDate: startDate.value,
            startTime: startTime.value || '09:00',
            endDate: endDate.value || startDate.value,
            endTime: endTime.value || startTime.value || '10:00',
            zoneId: allDay.checked ? null : (zoneSelect.value || null),
            location: location.value.trim(),
            description: notes.value.replace(/\s+$/, ''),
            calendar: calendarSelect.value || f.calendar,
            alarms: [...f.alarms],
            customAlarms: [...f.customAlarms]
        };
        if (preset === 'keep') { out.repeat = null; out.repeatCustom = f.repeatCustom; }
        else if (preset === 'none') { out.repeat = null; out.repeatCustom = null; }
        else {
            custom.freq = unitSelect.value;
            custom.interval = intervalInput.value;
            out.repeat = repeatFromPreset(preset, custom,
                { ends: endsSelect.value, until: untilInput.value, count: parseInt(countInput.value, 10) || 1 }, startDate.value);
            out.repeatCustom = null;
        }
        return out;
    }

    function problems(form) {
        const list = [];
        if (!parseDateKey(form.startDate)) list.push('Choose the day it starts.');
        const minutes = minutesBetween(form.startDate, form.allDay ? '00:00' : form.startTime, form.endDate, form.allDay ? '00:00' : form.endTime);
        if (minutes < 0) list.push('It ends before it starts.');
        if (form.repeat && form.repeat.ends === 'until' && (!parseDateKey(form.repeat.until) || form.repeat.until < form.startDate)) {
            list.push('The repeat ends before the event starts.');
        }
        return list;
    }

    // Whether anything was touched, so a stray tap outside or Escape asks before throwing it away.
    let changedByHand = false;
    panel.addEventListener('input', () => { changedByHand = true; });
    panel.addEventListener('change', () => { changedByHand = true; });

    const errorBox = h('div', { class: 'err-box', id: 'ed-error', hidden: true, role: 'alert' });
    const saveButton = h('button', { class: 'btn primary', type: 'button', id: 'ed-save' }, spec.mode === 'new' ? 'Add event' : 'Save');

    async function save() {
        if (saving) return;
        const form = collect();
        const list = problems(form);
        if (list.length) {
            errorBox.hidden = false;
            errorBox.textContent = list.join(' ');
            return;
        }
        errorBox.hidden = true;
        saving = true;
        saveButton.disabled = true;
        try {
            const done = await ctx.actions.save({ ...spec, form, originalForm: JSON.parse(original) });
            if (done) closeOverlay('editorOverlay', { force: true });
        } catch (err) {
            errorBox.hidden = false;
            errorBox.textContent = `Not saved: ${err && err.message ? err.message : err}`;
        } finally {
            saving = false;
            saveButton.disabled = false;
        }
    }
    saveButton.addEventListener('click', save);
    panel.onkeydown = event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
        else if (event.key === 'Enter' && event.target === title) { event.preventDefault(); save(); }
    };

    append(panel, [
        h('div', { class: 'panel-head' },
            h('h2', { id: 'ed-title' }, spec.heading || (spec.mode === 'new' ? 'New event' : 'Edit event')),
            h('button', { class: 'close-btn', type: 'button', 'data-close': 'editorOverlay' }, '✕')),
        field('Title', title, 'ed-summary'),
        h('label', { class: 'check', for: 'ed-allday' }, allDay, 'All day'),
        field('Starts', timeRow(startDate, startTime)),
        field('Ends', timeRow(endDate, endTime)),
        whenError,
        zoneBox,
        h('hr', { class: 'divider' }),
        field('Repeat', repeatSelect, 'ed-repeat'),
        keepNote, customBox, endsBox,
        h('hr', { class: 'divider' }),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Reminders'), alarmChips, addAlarm, otherBox,
            h('span', { class: 'hint' }, 'Reminders are part of the event: your phone\'s calendar app rings for them too.')),
        h('hr', { class: 'divider' }),
        calendars.length > 1 ? field('Calendar', h('div', { class: 'row' }, calendarDot, calendarSelect), 'ed-calendar') : null,
        field('Where', location, 'ed-location'),
        field('Notes', notes, 'ed-notes'),
        errorBox,
        h('div', { class: 'btn-row' },
            saveButton,
            h('button', { class: 'btn quiet', type: 'button', 'data-close': 'editorOverlay' }, 'Cancel'),
            spec.mode === 'edit' && spec.occurrence ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
                const deleted = await ctx.actions.remove(spec.occurrence);
                if (deleted) closeOverlay('editorOverlay', { force: true });
            } }, '🗑 Delete') : null)
    ]);
    paintWhen();
    paintRepeat();
    paintAlarms();
    paintCalendarDot();
    openOverlay('editorOverlay', {
        onRequestClose: () => {
            if (!changedByHand || saving) return true;
            // An editor with changes is not closed by a stray tap or Escape without asking.
            askChoice({
                title: 'Discard the changes?',
                choices: [
                    { value: 'discard', label: 'Discard them', kind: 'danger' },
                    { value: 'keep', label: 'Keep editing', kind: 'primary' }
                ]
            }).then(answer => { if (answer === 'discard') closeOverlay('editorOverlay', { force: true }); });
            return false;
        }
    });
    requestAnimationFrame(() => { if (spec.mode === 'new') title.focus(); });
    return { collect };
}
