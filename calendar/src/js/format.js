// What the screen says about dates and times: English words, the person's own clock (24-hour or
// 12-hour) and first day of the week. No DOM here, so all of it is tested in Node.

import { parseDateKey, weekdayOf, addDays, dateKey, daysBetween } from './wall.js';
import { utcToWall } from './tz.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                       'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map(m => m.slice(0, 3));

const pad = n => String(n).padStart(2, '0');

// ---- what the device is set to ---------------------------------------------------------------------------

// The language and region the device formats dates in (its own setting, as Intl sees it).
export function deviceLocale() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().locale || 'en-GB';
    } catch (_) {
        return 'en-GB';
    }
}

export function localeClock(locale) {
    try {
        const cycle = new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
        return cycle === 'h11' || cycle === 'h12' ? '12' : '24';
    } catch (_) {
        return '24';
    }
}

// 0 = Sunday, 1 = Monday, 6 = Saturday.
export function localeWeekStart(locale) {
    try {
        const loc = new Intl.Locale(locale || 'en-GB');
        const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
        if (info && info.firstDay) return info.firstDay % 7;
    } catch (_) {}
    return 1;
}

// ---- clock times -------------------------------------------------------------------------------------------

export function formatClock(hour, minute, clock = '24') {
    if (clock === '12') {
        const h = hour % 12 === 0 ? 12 : hour % 12;
        return `${h}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
    }
    return `${pad(hour)}:${pad(minute)}`;
}

// The short label of an hour line in the week and day views.
export function hourLabel(hour, clock = '24') {
    if (clock === '12') {
        const h = hour % 12 === 0 ? 12 : hour % 12;
        return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
    }
    return `${pad(hour)}:00`;
}

export function timeAt(utcMs, zone, clock = '24') {
    const w = utcToWall(utcMs, zone);
    return formatClock(w.hour, w.minute, clock);
}

// ---- dates ----------------------------------------------------------------------------------------------------

export function dayShort(key) {
    const d = parseDateKey(key);
    return `${WEEKDAYS_SHORT[weekdayOf(d)]} ${d.day} ${MONTHS_SHORT[d.month - 1]}`;
}

export function dayMedium(key) {
    const d = parseDateKey(key);
    return `${WEEKDAYS_SHORT[weekdayOf(d)]} ${d.day} ${MONTHS_SHORT[d.month - 1]} ${d.year}`;
}

export function dayLong(key) {
    const d = parseDateKey(key);
    return `${WEEKDAYS[weekdayOf(d)]} ${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

export function monthTitle(year, month) {
    return `${MONTHS[month - 1]} ${year}`;
}

// "5 - 11 October 2026", "28 Sep - 4 Oct 2026", "29 Dec 2025 - 4 Jan 2026".
export function rangeTitle(firstKey, lastKey) {
    const a = parseDateKey(firstKey);
    const b = parseDateKey(lastKey);
    if (firstKey === lastKey) return dayLong(firstKey);
    if (a.year === b.year && a.month === b.month) return `${a.day} - ${b.day} ${MONTHS[a.month - 1]} ${a.year}`;
    if (a.year === b.year) return `${a.day} ${MONTHS_SHORT[a.month - 1]} - ${b.day} ${MONTHS_SHORT[b.month - 1]} ${a.year}`;
    return `${a.day} ${MONTHS_SHORT[a.month - 1]} ${a.year} - ${b.day} ${MONTHS_SHORT[b.month - 1]} ${b.year}`;
}

export function relativeDay(key, todayKey) {
    const diff = daysBetween(parseDateKey(todayKey), parseDateKey(key));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return null;
}

// ---- spans of time -------------------------------------------------------------------------------------------

export function durationText(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return `${h} hour${h === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

// "now", "in 15 minutes", "in 2 hours", "in 3 days", "5 minutes ago".
export function relativeText(deltaMs) {
    const abs = Math.abs(deltaMs);
    if (abs < 60000) return 'now';
    const minutes = Math.round(abs / 60000);
    let text;
    if (minutes < 60) text = `${minutes} minute${minutes === 1 ? '' : 's'}`;
    else if (minutes < 1440) {
        const hours = Math.round(minutes / 60);
        text = `${hours} hour${hours === 1 ? '' : 's'}`;
    } else {
        const days = Math.round(minutes / 1440);
        text = `${days} day${days === 1 ? '' : 's'}`;
    }
    return deltaMs > 0 ? `in ${text}` : `${text} ago`;
}

// ---- an occurrence -----------------------------------------------------------------------------------------------

function lastDayKey(occ) {
    return dateKey(addDays(parseDateKey(occ.endDate), -1));
}

// When an occurrence happens, for its details: the viewer's own time, and, for an event kept in
// another zone that is not at the same offset right now, its time there as well.
export function describeWhen(occ, viewerZone, clock = '24') {
    if (occ.allDay) {
        const last = lastDayKey(occ);
        return { main: last === occ.startDate ? dayLong(occ.startDate) : `${dayMedium(occ.startDate)} - ${dayMedium(last)}`, zoneNote: '' };
    }
    const start = utcToWall(occ.startUtc, viewerZone);
    const end = utcToWall(occ.endUtc, viewerZone);
    const startKey = dateKey(start);
    const endKey = dateKey(end);
    const startText = formatClock(start.hour, start.minute, clock);
    const endText = formatClock(end.hour, end.minute, clock);
    let main;
    const endsAtMidnight = end.hour === 0 && end.minute === 0 && daysBetween(start, end) === 1;
    if (occ.endUtc === occ.startUtc) main = `${dayLong(startKey)}, ${startText}`;
    else if (startKey === endKey || endsAtMidnight) main = `${dayLong(startKey)}, ${startText} - ${endText}`;
    else main = `${dayMedium(startKey)}, ${startText} - ${dayMedium(endKey)}, ${endText}`;
    let zoneNote = '';
    const zone = occ.zone;
    if (zone && occ.zoneId && zone.id !== viewerZone.id && zone.offsetAt(occ.startUtc) !== viewerZone.offsetAt(occ.startUtc)) {
        const s = utcToWall(occ.startUtc, zone);
        const e = utcToWall(occ.endUtc, zone);
        const there = occ.endUtc === occ.startUtc
            ? formatClock(s.hour, s.minute, clock)
            : `${formatClock(s.hour, s.minute, clock)} - ${formatClock(e.hour, e.minute, clock)}`;
        zoneNote = `${dayShort(dateKey(s))}, ${there} in ${zone.id.replace(/_/g, ' ')}`;
    }
    return { main, zoneNote };
}

// What an occurrence shows on one day of a list: its times that day, or how it runs through it.
export function timeOnDay(occ, dayKey, dayStartUtc, dayEndUtc, zone, clock = '24') {
    if (occ.allDay) {
        if (occ.days > 1) {
            const n = daysBetween(parseDateKey(occ.startDate), parseDateKey(dayKey)) + 1;
            return `All day, ${n} of ${occ.days}`;
        }
        return 'All day';
    }
    const startsToday = occ.startUtc >= dayStartUtc;
    const endsToday = occ.endUtc <= dayEndUtc;
    const s = timeAt(occ.startUtc, zone, clock);
    const e = timeAt(occ.endUtc, zone, clock);
    if (startsToday && endsToday) return occ.endUtc === occ.startUtc ? s : `${s} - ${e}`;
    if (startsToday) return `from ${s}`;
    if (endsToday) return `until ${e}`;
    return 'all day';
}

export function weekdayNameOf(code) {
    return { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }[code] || code;
}

export { dateKey };
