// Creating and changing events. The editor works on a plain form; saving writes the form into the
// event's own iCalendar tree, touching only the properties the form is about, so whatever another
// app stored in the event (attendees, an Apple structured location, its own X- properties, alarms it
// set up) is still there afterwards. Times are edited in the event's own time zone.

import { parseCalendar, serializeComponent, component, property, getProp, getProps, setProp,
         removeProps, setText, getText, childComponents, readDateProp, parseRecur, formatRecur,
         formatDateValue, formatDuration, paramValue, parseDuration, durationParts, parseDateValue } from './icalendar.js';
import { buildVtimezone, ianaZone, wallToUtc, utcToWall, UTC_ZONE, knownZoneName, resolveZone } from './tz.js';
import { readSeries, eventTiming, instanceKey } from './occurrences.js';
import { expandRule, normalizeRule } from './rrule.js';
import { wallNumber, wallFromNumber, addDays, dateKey, parseDateKey, dateOnly, daysBetween, weekdayOf,
         daysInMonth, WEEKDAY_CODE, compareWall } from './wall.js';

export const PRODID = '-//myAI//Calendar//EN';

export const TIMED_ALARM_PRESETS = [
    { seconds: 0, label: 'At start' },
    { seconds: -5 * 60, label: '5 minutes before' },
    { seconds: -10 * 60, label: '10 minutes before' },
    { seconds: -15 * 60, label: '15 minutes before' },
    { seconds: -30 * 60, label: '30 minutes before' },
    { seconds: -3600, label: '1 hour before' },
    { seconds: -2 * 3600, label: '2 hours before' },
    { seconds: -86400, label: '1 day before' },
    { seconds: -2 * 86400, label: '2 days before' },
    { seconds: -7 * 86400, label: '1 week before' }
];

// All-day alarms count from the start of the day, as Apple Calendar writes them: 09:00 that day is
// PT9H, 09:00 the day before is -PT15H.
export const ALL_DAY_ALARM_PRESETS = [
    { seconds: 9 * 3600, label: 'On the day, 09:00' },
    { seconds: -15 * 3600, label: '1 day before, 09:00' },
    { seconds: -39 * 3600, label: '2 days before, 09:00' },
    { seconds: -159 * 3600, label: '1 week before, 09:00' }
];

export function describeAlarmSeconds(seconds, allDay) {
    const preset = (allDay ? ALL_DAY_ALARM_PRESETS : TIMED_ALARM_PRESETS).find(p => p.seconds === seconds);
    if (preset) return preset.label;
    const abs = Math.abs(seconds);
    const when = seconds <= 0 ? 'before' : 'after';
    if (abs % 86400 === 0) return `${abs / 86400} day${abs === 86400 ? '' : 's'} ${when}`;
    if (abs % 3600 === 0) return `${abs / 3600} hour${abs === 3600 ? '' : 's'} ${when}`;
    return `${Math.round(abs / 60)} minutes ${when}`;
}

export function newUid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const pad = n => String(n).padStart(2, '0');
const timeText = w => `${pad(w.hour)}:${pad(w.minute)}`;

function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(text || ''));
    return m ? { hour: Math.min(23, +m[1]), minute: Math.min(59, +m[2]) } : { hour: 9, minute: 0 };
}

function utcStamp(nowMs) {
    const w = utcToWall(nowMs, UTC_ZONE);
    return formatDateValue({ ...w, date: false, utc: true });
}

// ---- repeat rules the editor can show ------------------------------------------------------------------

function nthOfMonth(w) {
    const last = daysInMonth(w.year, w.month);
    if (w.day + 7 > last) return -1;
    return Math.ceil(w.day / 7);
}

// The simple form of a rule, or null when the rule says more than the editor's choices can (it is
// then kept exactly as it is unless someone picks a new repeat).
export function repeatFromRule(rule, startWall, untilDateKey = null) {
    if (!rule) return null;
    const has = list => list && list.length;
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return null;
    if (has(rule.bysetpos) || has(rule.byhour) || has(rule.byminute) || has(rule.bysecond)
        || has(rule.byyearday) || has(rule.byweekno) || has(rule.extra)) return null;
    const repeat = { freq: rule.freq, interval: rule.interval || 1, byday: [], monthlyBy: 'monthday',
                     ends: 'never', until: '', count: 10 };
    if (rule.count != null) { repeat.ends = 'count'; repeat.count = rule.count; }
    else if (rule.until) { repeat.ends = 'until'; repeat.until = untilDateKey || dateKey(rule.until); }
    const startCode = WEEKDAY_CODE[weekdayOf(startWall)];
    if (rule.freq === 'DAILY') {
        if (has(rule.byday) || has(rule.bymonthday) || has(rule.bymonth)) return null;
    } else if (rule.freq === 'WEEKLY') {
        if (has(rule.bymonthday) || has(rule.bymonth)) return null;
        if (has(rule.byday) && rule.byday.some(d => d.n)) return null;
        repeat.byday = has(rule.byday) ? rule.byday.map(d => d.day) : [startCode];
    } else if (rule.freq === 'MONTHLY') {
        if (has(rule.bymonth)) return null;
        if (has(rule.byday)) {
            if (rule.byday.length !== 1 || has(rule.bymonthday)) return null;
            const d = rule.byday[0];
            const matchesStart = d.n && d.day === startCode
                && (d.n === nthOfMonth(startWall) || d.n === Math.ceil(startWall.day / 7));
            if (!matchesStart) return null;
            repeat.monthlyBy = 'weekday';
        } else if (has(rule.bymonthday) && !(rule.bymonthday.length === 1 && rule.bymonthday[0] === startWall.day)) {
            return null;
        }
    } else if (rule.freq === 'YEARLY') {
        if (has(rule.byday)) return null;
        if (has(rule.bymonth) && !(rule.bymonth.length === 1 && rule.bymonth[0] === startWall.month)) return null;
        if (has(rule.bymonthday) && !(rule.bymonthday.length === 1 && rule.bymonthday[0] === startWall.day)) return null;
    }
    return repeat;
}

// The rule a simple repeat stands for. UNTIL is the end of the chosen day: a date for all-day
// events, the last second of that day in the event's zone (as UTC) for timed ones.
export function ruleFromRepeat(repeat, startWall, { allDay, zone, floating }) {
    if (!repeat || !repeat.freq) return null;
    const rule = { freq: repeat.freq, interval: Math.max(1, parseInt(repeat.interval, 10) || 1) };
    if (repeat.freq === 'WEEKLY') {
        const days = (repeat.byday && repeat.byday.length ? repeat.byday : [WEEKDAY_CODE[weekdayOf(startWall)]]);
        const order = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
        rule.byday = [...new Set(days)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(day => ({ n: 0, day }));
    } else if (repeat.freq === 'MONTHLY' && repeat.monthlyBy === 'weekday') {
        rule.byday = [{ n: nthOfMonth(startWall), day: WEEKDAY_CODE[weekdayOf(startWall)] }];
    }
    if (repeat.ends === 'count') {
        rule.count = Math.max(1, parseInt(repeat.count, 10) || 1);
    } else if (repeat.ends === 'until' && parseDateKey(repeat.until)) {
        const day = parseDateKey(repeat.until);
        if (allDay) rule.until = { ...day, date: true, utc: false };
        else {
            const lastSecond = { ...day, hour: 23, minute: 59, second: 59 };
            if (floating) rule.until = { ...lastSecond, date: false, utc: false };
            else rule.until = { ...utcToWall(wallToUtc(lastSecond, zone), UTC_ZONE), date: false, utc: true };
        }
    }
    return rule;
}

// Whether two rules repeat the same way (how often, on which days), however each is written and
// whenever each ends: then the series' exceptions still mean what they meant.
const DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
function ruleShape(rule, startWall) {
    const r = normalizeRule({ ...rule, count: undefined, until: undefined }, startWall);
    const sortNumbers = list => (list ? [...new Set(list)].sort((x, y) => x - y) : list);
    return formatRecur({
        ...r, count: undefined, until: undefined,
        byday: r.byday ? [...r.byday].sort((x, y) => (x.n || 0) - (y.n || 0) || DAY_ORDER.indexOf(x.day) - DAY_ORDER.indexOf(y.day)) : r.byday,
        bymonth: sortNumbers(r.bymonth), bymonthday: sortNumbers(r.bymonthday), byyearday: sortNumbers(r.byyearday),
        byweekno: sortNumbers(r.byweekno), bysetpos: sortNumbers(r.bysetpos), byhour: sortNumbers(r.byhour),
        byminute: sortNumbers(r.byminute), bysecond: sortNumbers(r.bysecond)
    });
}

function sameRuleShape(a, b, startWall) {
    if (!a || !b) return false;
    return ruleShape(a, startWall) === ruleShape(b, startWall);
}

// ---- the form ---------------------------------------------------------------------------------------------

export function blankForm({ date, hour = null, zoneId, defaults = {} }) {
    const day = parseDateKey(date) || parseDateKey(dateKey(utcToWall(Date.now(), ianaZone(zoneId))));
    const startHour = hour == null ? 9 : hour;
    const durationMin = Math.max(5, parseInt(defaults.durationMinutes, 10) || 60);
    const start = { ...day, hour: startHour, minute: 0, second: 0 };
    const end = new Date(wallNumber(start) + durationMin * 60000);
    const endWall = { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate(), hour: end.getUTCHours(), minute: end.getUTCMinutes(), second: 0 };
    return {
        summary: '', location: '', description: '',
        allDay: false,
        startDate: dateKey(start), startTime: timeText(start),
        endDate: dateKey(endWall), endTime: timeText(endWall),
        zoneId,
        repeat: null,
        repeatCustom: null,
        alarms: defaults.alarmSeconds != null && defaults.alarmSeconds !== '' ? [Number(defaults.alarmSeconds)] : [],
        customAlarms: [],
        calendar: defaults.calendar || null
    };
}

function simpleAlarmSeconds(valarm) {
    const trigger = getProp(valarm, 'TRIGGER');
    if (!trigger) return null;
    if ((paramValue(trigger, 'VALUE') || '').toUpperCase() === 'DATE-TIME') return null;
    if ((paramValue(trigger, 'RELATED') || 'START').toUpperCase() !== 'START') return null;
    const action = ((getProp(valarm, 'ACTION') || {}).value || 'DISPLAY').toUpperCase();
    if (action !== 'DISPLAY' && action !== 'AUDIO') return null;
    const duration = parseDuration(trigger.value);
    if (!duration) return null;
    const parts = durationParts(duration);
    return parts.days * 86400 + parts.seconds;
}

// The form for one occurrence: the series' own values, or the override's for an occurrence that has one.
export function formFromOccurrence(text, occurrence, viewerZone) {
    const series = readSeries(text);
    const vevent = occurrence && occurrence.override ? occurrence.vevent : (series.master || series.overrides[0]);
    const timing = eventTiming(vevent, series, viewerZone);
    const form = {
        summary: getText(vevent, 'SUMMARY'),
        location: getText(vevent, 'LOCATION'),
        description: getText(vevent, 'DESCRIPTION'),
        allDay: timing.allDay,
        zoneId: timing.allDay ? null : (timing.floating ? null : timing.zone.id),
        repeat: null, repeatCustom: null,
        alarms: [], customAlarms: []
    };
    // The times of this occurrence, in the event's zone.
    if (timing.allDay) {
        const start = occurrence && occurrence.startDate ? parseDateKey(occurrence.startDate) : timing.startWall;
        form.startDate = dateKey(start);
        form.endDate = dateKey(addDays(start, Math.max(1, timing.days) - 1));
        form.startTime = '09:00';
        form.endTime = '10:00';
    } else {
        const zone = timing.zone;
        const startUtc = occurrence ? occurrence.startUtc : wallToUtc(timing.startWall, zone);
        const endUtc = occurrence ? occurrence.endUtc : startUtc;
        const s = utcToWall(startUtc, zone);
        const e = utcToWall(endUtc, zone);
        form.startDate = dateKey(s); form.startTime = timeText(s);
        form.endDate = dateKey(e); form.endTime = timeText(e);
    }
    const ruleProp = series.master && !(occurrence && occurrence.override) ? getProp(series.master, 'RRULE') : null;
    if (ruleProp) {
        const rule = parseRecur(ruleProp.value);
        let untilKey = null;
        if (rule && rule.until && !timing.allDay && rule.until.utc && !timing.floating) {
            untilKey = dateKey(utcToWall(wallNumber(rule.until), timing.zone));
        }
        const repeat = rule ? repeatFromRule(rule, timing.startWall, untilKey) : null;
        if (repeat) form.repeat = repeat;
        else form.repeatCustom = ruleProp.value;
    }
    childComponents(vevent, 'VALARM').forEach((valarm, index) => {
        const seconds = simpleAlarmSeconds(valarm);
        if (seconds == null) form.customAlarms.push({ index, label: describeCustomAlarm(valarm) });
        else if (!form.alarms.includes(seconds)) form.alarms.push(seconds);
    });
    form.alarms.sort((a, b) => b - a);
    return form;
}

function describeCustomAlarm(valarm) {
    const trigger = getProp(valarm, 'TRIGGER');
    const action = ((getProp(valarm, 'ACTION') || {}).value || 'DISPLAY').toLowerCase();
    if (!trigger) return `${action} alarm`;
    if ((paramValue(trigger, 'VALUE') || '').toUpperCase() === 'DATE-TIME') return `${action} at a set time`;
    return `${action}, ${trigger.value}${(paramValue(trigger, 'RELATED') || '').toUpperCase() === 'END' ? ' from the end' : ''}`;
}

// ---- writing times ----------------------------------------------------------------------------------------------

function formZone(form, viewerZone, vtimezones) {
    if (!form.zoneId) return viewerZone;
    if (knownZoneName(form.zoneId)) return ianaZone(knownZoneName(form.zoneId));
    return resolveZone(form.zoneId, vtimezones || new Map(), viewerZone);
}

function formTimes(form, viewerZone, vtimezones = null) {
    if (form.allDay) {
        const start = parseDateKey(form.startDate);
        let last = parseDateKey(form.endDate) || start;
        if (compareWall(last, start) < 0) last = start;
        return { allDay: true, start, endExclusive: addDays(last, 1) };
    }
    const zone = formZone(form, viewerZone, vtimezones);
    const start = { ...parseDateKey(form.startDate), ...parseTime(form.startTime), second: 0 };
    let end = { ...(parseDateKey(form.endDate) || parseDateKey(form.startDate)), ...parseTime(form.endTime), second: 0 };
    if (wallToUtc(end, zone) < wallToUtc(start, zone)) end = { ...start };
    return { allDay: false, start, end, zone, floating: !form.zoneId };
}

function writeDate(vevent, name, value, { allDay, zoneId, floating }) {
    if (allDay) return setProp(vevent, name, formatDateValue({ ...value, date: true }), { VALUE: 'DATE' });
    if (!floating && zoneId === 'UTC') {
        return setProp(vevent, name, formatDateValue({ ...value, date: false, utc: true }), {});
    }
    if (floating) return setProp(vevent, name, formatDateValue({ ...value, date: false, utc: false }), {});
    return setProp(vevent, name, formatDateValue({ ...value, date: false, utc: false }), { TZID: zoneId });
}

function ensureVtimezone(vcalendar, zoneId, year) {
    if (!zoneId || zoneId === 'UTC') return;
    const present = childComponents(vcalendar, 'VTIMEZONE').some(vtz => (getProp(vtz, 'TZID') || {}).value === zoneId);
    if (present || knownZoneName(zoneId) !== zoneId) return;
    const vtz = buildVtimezone(zoneId, year);
    if (!vtz) return;
    const firstEvent = vcalendar.components.findIndex(c => c.name !== 'VTIMEZONE');
    if (firstEvent < 0) vcalendar.components.push(vtz);
    else vcalendar.components.splice(firstEvent, 0, vtz);
}

// Writes the form's start and end into the event, unless they are what it already says.
//
// `anchor` is the original start of the occurrence the form was opened on, when the whole of a
// repeating series is saved from one of its later occurrences: the series then moves by as much as
// that occurrence was moved, instead of jumping to the occurrence's date.
function applyTimes(vcalendar, vevent, form, series, viewerZone, anchor = null) {
    const before = eventTiming(vevent, series, viewerZone);
    const times = formTimes(form, viewerZone, series.vtimezones);
    const zoneId = times.allDay ? null : (times.floating ? null : times.zone.id);
    let start = times.start;
    let end = times.end;
    let endExclusive = times.endExclusive;
    if (anchor && before) {
        if (before.allDay === times.allDay) {
            const shiftMs = wallNumber(times.start) - wallNumber(anchor);
            const moved = wallFromNumber(wallNumber(before.startWall) + shiftMs);
            if (times.allDay) {
                start = dateOnly(moved);
                endExclusive = addDays(start, daysBetween(times.start, times.endExclusive));
            } else {
                start = moved;
                end = wallFromNumber(wallNumber(moved) + (wallNumber(times.end) - wallNumber(times.start)));
            }
        } else if (times.allDay) {
            start = dateOnly(before.startWall);
            endExclusive = addDays(start, daysBetween(times.start, times.endExclusive));
        } else {
            start = { ...dateOnly(before.startWall), hour: times.start.hour, minute: times.start.minute, second: 0 };
            end = wallFromNumber(wallNumber(start) + (wallNumber(times.end) - wallNumber(times.start)));
        }
    }
    const sameZone = before && (times.allDay ? before.allDay
        : (!before.allDay && (before.floating ? !zoneId : before.zone.id === zoneId)));
    const startChanged = !(sameZone && wallNumber(before.startWall) === wallNumber(start));
    const delta = startChanged && sameZone
        ? { days: daysBetween(before.startWall, start), seconds: (wallNumber(start) - wallNumber(before.startWall)) / 1000 }
        : null;
    if (startChanged) writeDate(vevent, 'DTSTART', start, { allDay: times.allDay, zoneId, floating: times.floating });

    let endChanged = true;
    if (before && !startChanged && before.allDay === times.allDay) {
        if (times.allDay) endChanged = before.days !== daysBetween(start, endExclusive);
        else if (before.exactMs == null) {
            const endWall = addDays(before.startWall, before.nominal.days);
            const endNumber = wallNumber(endWall) + before.nominal.seconds * 1000;
            endChanged = endNumber !== wallNumber(end);
        }
    }
    if (endChanged) {
        removeProps(vevent, 'DURATION');
        if (times.allDay) writeDate(vevent, 'DTEND', endExclusive, { allDay: true });
        else writeDate(vevent, 'DTEND', end, { allDay: false, zoneId, floating: times.floating });
    }
    if (zoneId) ensureVtimezone(vcalendar, zoneId, start.year);
    return { startChanged, delta, times: { ...times, start }, zoneId, before };
}

// ---- alarms ----------------------------------------------------------------------------------------------------

function applyAlarms(vevent, form, summary) {
    const wanted = [...new Set((form.alarms || []).map(Number).filter(Number.isFinite))];
    const keepCustom = new Set((form.customAlarms || []).map(a => a.index));
    const kept = [];
    let alarmIndex = -1;
    for (const child of vevent.components) {
        if (child.name !== 'VALARM') { kept.push(child); continue; }
        alarmIndex++;
        const seconds = simpleAlarmSeconds(child);
        if (seconds == null) {
            if (keepCustom.has(alarmIndex)) kept.push(child);
            continue;
        }
        const at = wanted.indexOf(seconds);
        if (at >= 0) { kept.push(child); wanted.splice(at, 1); }
    }
    for (const seconds of wanted) {
        const days = Math.trunc(seconds / 86400);
        const id = newUid().toUpperCase();
        kept.push(component('VALARM', [
            property('ACTION', 'DISPLAY'),
            property('DESCRIPTION', 'Reminder'),
            property('TRIGGER', formatDuration({ days, seconds: seconds - days * 86400 })),
            property('UID', id),
            property('X-WR-ALARMUID', id)
        ]));
    }
    vevent.components = kept;
}

function touch(vevent, nowMs) {
    const stamp = utcStamp(nowMs);
    setProp(vevent, 'DTSTAMP', stamp, {});
    setProp(vevent, 'LAST-MODIFIED', stamp, {});
    const seq = parseInt((getProp(vevent, 'SEQUENCE') || {}).value, 10);
    setProp(vevent, 'SEQUENCE', String(Number.isFinite(seq) ? seq + 1 : 1), {});
}

function applyTexts(vevent, form) {
    setText(vevent, 'SUMMARY', form.summary);
    setText(vevent, 'LOCATION', form.location);
    setText(vevent, 'DESCRIPTION', form.description);
}

// ---- new events ----------------------------------------------------------------------------------------------------

export function createEvent(form, { uid = newUid(), nowMs = Date.now(), viewerZone }) {
    const vcalendar = component('VCALENDAR', [
        property('VERSION', '2.0'),
        property('PRODID', PRODID),
        property('CALSCALE', 'GREGORIAN')
    ]);
    const stamp = utcStamp(nowMs);
    const vevent = component('VEVENT', [
        property('UID', uid),
        property('DTSTAMP', stamp),
        property('CREATED', stamp),
        property('LAST-MODIFIED', stamp),
        property('SEQUENCE', '0')
    ]);
    vcalendar.components.push(vevent);
    applyTexts(vevent, form);
    const times = formTimes(form, viewerZone);
    const zoneId = times.allDay ? null : (times.floating ? null : times.zone.id);
    writeDate(vevent, 'DTSTART', times.start, { allDay: times.allDay, zoneId, floating: times.floating });
    if (times.allDay) writeDate(vevent, 'DTEND', times.endExclusive, { allDay: true });
    else writeDate(vevent, 'DTEND', times.end, { allDay: false, zoneId, floating: times.floating });
    if (zoneId) ensureVtimezone(vcalendar, zoneId, times.start.year);
    if (form.repeat && form.repeat.freq) {
        const rule = ruleFromRepeat(form.repeat, times.start, { allDay: times.allDay, zone: times.zone, floating: times.floating });
        if (rule) setProp(vevent, 'RRULE', formatRecur(rule), {});
    } else if (form.repeatCustom) {
        setProp(vevent, 'RRULE', form.repeatCustom, {});
    }
    applyAlarms(vevent, form, form.summary);
    return { uid, text: serializeComponent(vcalendar) };
}

// ---- changing events ---------------------------------------------------------------------------------------------------

function findOverride(series, key, viewerZone) {
    const masterTiming = series.master ? eventTiming(series.master, series, viewerZone) : null;
    return series.overrides.find(ov => {
        const rid = readDateProp(getProp(ov, 'RECURRENCE-ID'));
        if (!rid) return false;
        const timing = masterTiming || eventTiming(ov, series, viewerZone);
        return instanceKey(rid.values[0], rid.tzid, series, timing, viewerZone) === key;
    }) || null;
}

function shiftDateProps(vevent, name, delta, timing) {
    for (const prop of getProps(vevent, name)) {
        const parsed = readDateProp(prop);
        if (!parsed) continue;
        prop.value = parsed.values.map(v => {
            const moved = v.date ? addDays(v, delta.days) : new Date(wallNumber(v) + delta.seconds * 1000);
            const w = v.date ? moved : { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate(), hour: moved.getUTCHours(), minute: moved.getUTCMinutes(), second: moved.getUTCSeconds() };
            return formatDateValue({ ...w, date: v.date, utc: v.utc });
        }).join(',');
    }
    void timing;
}

// The value that names an occurrence in RECURRENCE-ID and EXDATE: written as the series' DTSTART is.
function occurrenceIdValue(series, occurrence, viewerZone) {
    const timing = eventTiming(series.master, series, viewerZone);
    if (timing.allDay) return { value: formatDateValue({ ...parseDateKey(occurrence.startDate), date: true }), params: { VALUE: 'DATE' } };
    const startProp = readDateProp(getProp(series.master, 'DTSTART'));
    if (startProp.values[0].utc) {
        return { value: formatDateValue({ ...utcToWall(occurrence.startUtc, UTC_ZONE), date: false, utc: true }), params: {} };
    }
    const wallInZone = utcToWall(occurrence.startUtc, timing.zone);
    const value = formatDateValue({ ...wallInZone, date: false, utc: false });
    return { value, params: startProp.tzid ? { TZID: startProp.tzid } : {} };
}

// Saves the form into an existing event. scope 'all' changes the whole series (or the only event);
// scope 'one' changes just this occurrence of a repeating event, through a RECURRENCE-ID override.
export function updateEvent(text, form, { occurrence = null, scope = 'all', nowMs = Date.now(), viewerZone }) {
    const series = readSeries(text);
    if (!series) throw new Error('This event could not be read.');
    const vcalendar = series.vcalendar;
    let target;
    if (occurrence && occurrence.override) {
        target = occurrence.vevent && vcalendar.components.includes(occurrence.vevent)
            ? occurrence.vevent : findOverride(series, occurrence.recurrenceKey, viewerZone);
    } else if (scope === 'one' && occurrence && occurrence.recurring && series.master) {
        target = findOverride(series, occurrence.recurrenceKey, viewerZone);
        if (!target) {
            const master = series.master;
            target = JSON.parse(JSON.stringify(master));
            removeProps(target, 'RRULE'); removeProps(target, 'RDATE'); removeProps(target, 'EXDATE');
            removeProps(target, 'EXRULE');
            const id = occurrenceIdValue(series, occurrence, viewerZone);
            setProp(target, 'RECURRENCE-ID', id.value, id.params);
            // The override starts as this occurrence, then takes the form's changes.
            const timing = eventTiming(master, series, viewerZone);
            if (timing.allDay) {
                const start = parseDateKey(occurrence.startDate);
                writeDate(target, 'DTSTART', start, { allDay: true });
                removeProps(target, 'DURATION');
                writeDate(target, 'DTEND', addDays(start, timing.days), { allDay: true });
            } else {
                const zoneId = timing.floating ? null : timing.zone.id;
                const s = utcToWall(occurrence.startUtc, timing.zone);
                const e = utcToWall(occurrence.endUtc, timing.zone);
                const startProp = readDateProp(getProp(master, 'DTSTART'));
                const tzid = startProp.values[0].utc ? 'UTC' : (startProp.tzid || null);
                writeDate(target, 'DTSTART', s, { allDay: false, zoneId: tzid === 'UTC' ? 'UTC' : (tzid || zoneId), floating: timing.floating });
                removeProps(target, 'DURATION');
                writeDate(target, 'DTEND', e, { allDay: false, zoneId: tzid === 'UTC' ? 'UTC' : (tzid || zoneId), floating: timing.floating });
            }
            const at = vcalendar.components.indexOf(master);
            vcalendar.components.splice(at + 1, 0, target);
        }
    } else {
        target = series.master || series.overrides[0];
    }
    if (!target) throw new Error('This occurrence could not be found in the event.');

    applyTexts(target, form);
    const isMasterScope = target === series.master;
    let anchor = null;
    if (isMasterScope && occurrence && occurrence.recurring && !occurrence.override) {
        const timing = eventTiming(series.master, series, viewerZone);
        anchor = timing.allDay ? parseDateKey(occurrence.startDate) : utcToWall(occurrence.startUtc, timing.zone);
    }
    const { startChanged, delta, times, before } = applyTimes(vcalendar, target, form, series, viewerZone, anchor);

    if (isMasterScope) {
        const oldRuleProp = getProp(target, 'RRULE');
        const oldRule = oldRuleProp ? parseRecur(oldRuleProp.value) : null;
        let newRuleText = null;
        if (form.repeat && form.repeat.freq) {
            const rule = ruleFromRepeat(form.repeat, times.start, { allDay: times.allDay, zone: times.zone, floating: times.floating });
            newRuleText = rule ? formatRecur(rule) : null;
        } else if (form.repeatCustom) {
            newRuleText = oldRuleProp && oldRuleProp.value === form.repeatCustom ? oldRuleProp.value : form.repeatCustom;
        }
        const dropExceptions = () => {
            removeProps(target, 'EXDATE');
            vcalendar.components = vcalendar.components.filter(c => !(c.name === 'VEVENT' && c !== target && getProp(c, 'RECURRENCE-ID')));
        };
        if (!newRuleText) {
            if (oldRuleProp || getProps(target, 'RDATE').length) {
                removeProps(target, 'RRULE'); removeProps(target, 'RDATE');
                dropExceptions();
            }
        } else if (!oldRuleProp || oldRuleProp.value !== newRuleText) {
            const newRule = parseRecur(newRuleText);
            removeProps(target, 'RRULE');
            setProp(target, 'RRULE', newRuleText, {});
            if (!oldRule || !sameRuleShape(oldRule, newRule, times.start)) dropExceptions();
        }
        if (startChanged && getProp(target, 'RRULE')) {
            if (delta && before) {
                // The series moved: its exceptions move with it, as they were relative to it.
                shiftDateProps(target, 'EXDATE', delta, before);
                for (const ov of vcalendar.components.filter(c => c.name === 'VEVENT' && c !== target && getProp(c, 'RECURRENCE-ID'))) {
                    shiftDateProps(ov, 'RECURRENCE-ID', delta, before);
                }
            } else {
                dropExceptions();
            }
        }
    }
    applyAlarms(target, form, form.summary);
    touch(target, nowMs);
    if (target !== series.master && series.master) {
        // Clients compare SEQUENCE across the object; the master records that the series changed too.
        setProp(series.master, 'DTSTAMP', utcStamp(nowMs), {});
    }
    return serializeComponent(vcalendar);
}

// Removes one occurrence of a repeating event (an EXDATE, and its override if it had one). Returns
// null when nothing would be left of the event, so the caller deletes the whole object.
export function removeOccurrence(text, occurrence, { nowMs = Date.now(), viewerZone }) {
    const series = readSeries(text);
    if (!series) return null;
    const vcalendar = series.vcalendar;
    if (!occurrence || !occurrence.recurring) return null;
    const override = occurrence.override
        ? (vcalendar.components.includes(occurrence.vevent) ? occurrence.vevent : findOverride(series, occurrence.recurrenceKey, viewerZone))
        : findOverride(series, occurrence.recurrenceKey, viewerZone);
    if (override) vcalendar.components = vcalendar.components.filter(c => c !== override);
    if (!series.master) {
        return vcalendar.components.some(c => c.name === 'VEVENT') ? serializeComponent(vcalendar) : null;
    }
    const id = occurrenceIdValueForKey(series, occurrence, override, viewerZone);
    const exdate = property('EXDATE', id.value, id.params);
    const lastExdate = series.master.props.map(p => p.name).lastIndexOf('EXDATE');
    if (lastExdate >= 0) series.master.props.splice(lastExdate + 1, 0, exdate);
    else series.master.props.push(exdate);
    touch(series.master, nowMs);
    return serializeComponent(vcalendar);
}

function occurrenceIdValueForKey(series, occurrence, override, viewerZone) {
    if (override) {
        const rid = getProp(override, 'RECURRENCE-ID');
        const params = {};
        for (const p of rid.params) if (p.name === 'TZID' || p.name === 'VALUE') params[p.name] = p.values[0];
        return { value: rid.value, params };
    }
    return occurrenceIdValue(series, occurrence, viewerZone);
}

// A copy of the event as a new, separate event (new UID), for "Duplicate".
export function formForCopy(form) {
    return { ...form, repeat: null, repeatCustom: null, customAlarms: [] };
}

// ---- "this and following" ---------------------------------------------------------------------------------------

// Where a series is cut: the original start of the occurrence (an override's RECURRENCE-ID, not
// where it was moved to), as the instance key the occurrence carries.
function splitPoint(series, occurrence, timing) {
    if (timing.allDay) {
        const key = occurrence.recurrenceKey || occurrence.startDate.replace(/-/g, '');
        const date = { year: +key.slice(0, 4), month: +key.slice(4, 6), day: +key.slice(6, 8), hour: 0, minute: 0, second: 0 };
        return { allDay: true, key: key, date };
    }
    const utc = Number(occurrence.recurrenceKey || occurrence.startUtc);
    return { allDay: false, utc, key: String(utc), wall: utcToWall(utc, timing.zone) };
}

function keyAtOrAfter(key, split) {
    return split.allDay ? key >= split.key : Number(key) >= split.utc;
}

// The values of an EXDATE or RDATE property on one side of the cut; null when none are left.
function keepDateValues(prop, series, timing, viewerZone, split, wantAfter) {
    const parsed = readDateProp(prop);
    if (!parsed) return prop;
    const kept = String(prop.value).split(',').filter(part => {
        const value = parseDateValue(part.trim().split('/')[0]);
        if (!value) return true;
        let key = instanceKey(value, parsed.tzid, series, timing, viewerZone);
        if (timing.allDay && !value.date) key = dateKey(value).replace(/-/g, '');
        return keyAtOrAfter(key, split) === wantAfter;
    });
    if (!kept.length) return null;
    prop.value = kept.join(',');
    return prop;
}

function overrideKey(ov, series, timing, viewerZone) {
    const rid = readDateProp(getProp(ov, 'RECURRENCE-ID'));
    return rid ? instanceKey(rid.values[0], rid.tzid, series, timing, viewerZone) : null;
}

// Ends a repeating event just before one of its occurrences: its rules get an UNTIL (and lose
// COUNT), and its extra dates and changed single occurrences from there on go. Returns null when
// nothing would be left (the occurrence is the first), and how many changed occurrences went.
export function endSeriesBefore(text, occurrence, { nowMs = Date.now(), viewerZone }) {
    const series = readSeries(text);
    if (!series || !series.master) return { text: null, droppedOverrides: 0 };
    const master = series.master;
    const timing = eventTiming(master, series, viewerZone);
    const split = splitPoint(series, occurrence, timing);
    const firstKey = timing.allDay ? dateKey(timing.startWall).replace(/-/g, '')
        : String(wallToUtc(timing.startWall, timing.zone));
    if (keyAtOrAfter(firstKey, split)) return { text: null, droppedOverrides: series.overrides.length };

    let until;
    if (timing.allDay) until = { ...addDays(split.date, -1), date: true, utc: false };
    else if (timing.floating) until = { ...wallFromNumber(wallNumber(split.wall) - 1000), date: false, utc: false };
    else until = { ...utcToWall(split.utc - 1000, UTC_ZONE), date: false, utc: true };
    for (const prop of getProps(master, 'RRULE')) {
        const rule = parseRecur(prop.value);
        if (!rule) continue;
        delete rule.count;
        if (!rule.until || wallNumber(rule.until) > wallNumber(until)) rule.until = until;
        prop.value = formatRecur(rule);
    }
    master.props = master.props
        .map(p => (p.name === 'RDATE' || p.name === 'EXDATE' ? keepDateValues(p, series, timing, viewerZone, split, false) : p))
        .filter(Boolean);
    let droppedOverrides = 0;
    series.vcalendar.components = series.vcalendar.components.filter(c => {
        if (c.name !== 'VEVENT' || c === master || !getProp(c, 'RECURRENCE-ID')) return true;
        const key = overrideKey(c, series, timing, viewerZone);
        if (key != null && keyAtOrAfter(key, split)) { droppedOverrides++; return false; }
        return true;
    });
    touch(master, nowMs);
    return { text: serializeComponent(series.vcalendar), droppedOverrides };
}

// How many times the rule came up before the cut, which counts toward its COUNT.
function ruleInstancesBefore(rule, timing, split) {
    const limit = split.allDay ? wallNumber(split.date) : wallNumber(split.wall);
    let n = 0;
    for (const w of expandRule(rule, timing.startWall, { stopAfter: c => wallNumber(c) >= limit })) {
        if (wallNumber(w) >= limit) break;
        n++;
    }
    return n;
}

// The rest of a repeating event from one occurrence on, as a new event (new UID) with the form's
// changes: what the series carried along (its other properties, the changed single occurrences
// and exceptions from there on) comes with it, and a COUNT the form did not change counts on from
// where the series was cut.
export function startSeriesFrom(text, occurrence, form, { uid = newUid(), nowMs = Date.now(), viewerZone }) {
    const series = readSeries(text);
    if (!series || !series.master) throw new Error('This event does not repeat.');
    const timing = eventTiming(series.master, series, viewerZone);
    const split = splitPoint(series, occurrence, timing);
    // A second reading of the same text is the copy, changed apart from the original.
    const original = readSeries(text);
    const copy = original.master;
    original.vcalendar.components = original.vcalendar.components.filter(c => {
        if (c.name !== 'VEVENT' || c === copy || !getProp(c, 'RECURRENCE-ID')) return true;
        const key = overrideKey(c, original, timing, viewerZone);
        return key != null && keyAtOrAfter(key, split);
    });
    copy.props = copy.props
        .map(p => (p.name === 'RDATE' || p.name === 'EXDATE' ? keepDateValues(p, original, timing, viewerZone, split, true) : p))
        .filter(Boolean);
    for (const ev of childComponents(original.vcalendar, 'VEVENT')) setProp(ev, 'UID', uid, {});
    setProp(copy, 'CREATED', utcStamp(nowMs), {});

    // The copy starts at this occurrence's original start (its length as before), so the form's
    // times are applied to it as to any single event.
    const startWall = split.allDay ? split.date : split.wall;
    const delta = {
        days: daysBetween(timing.startWall, startWall),
        seconds: (wallNumber(startWall) - wallNumber(timing.startWall)) / 1000
    };
    shiftDateProps(copy, 'DTSTART', delta, timing);
    if (getProp(copy, 'DTEND')) shiftDateProps(copy, 'DTEND', delta, timing);

    const adjusted = { ...form };
    const ruleProp = getProp(series.master, 'RRULE');
    const oldRule = ruleProp ? parseRecur(ruleProp.value) : null;
    if (oldRule && oldRule.count != null) {
        const before = ruleInstancesBefore(oldRule, timing, split);
        const left = Math.max(1, oldRule.count - before);
        if (form.repeat && form.repeat.ends === 'count' && Number(form.repeat.count) === oldRule.count) {
            adjusted.repeat = { ...form.repeat, count: left };
        } else if (!form.repeat && form.repeatCustom && form.repeatCustom === ruleProp.value) {
            adjusted.repeatCustom = formatRecur({ ...oldRule, count: left });
        }
    }
    const copyText = serializeComponent(original.vcalendar);
    return { uid, text: updateEvent(copyText, adjusted, { occurrence: null, scope: 'all', nowMs, viewerZone }) };
}

export { knownZoneName, getProp };
