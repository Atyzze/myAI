// What each view shows: which days, under which title, and where the events go on them. Pure, so
// the layouts are tested in Node; the DOM side only draws what this works out.

import { addDays, addMonths, dateKey, parseDateKey, startOfWeek, daysInMonth, wallNumber } from './wall.js';
import { utcToWall, wallToUtc } from './tz.js';
import { monthTitle, rangeTitle, dayLong } from './format.js';

export const MINUTES_PER_DAY = 1440;

// The days a view shows around its focus date. Month: whole weeks covering the month. Week: seven
// days from the first day of the week, or three days from the focus on a phone. Day: the focus.
// List: `listDays` days from the focus.
export function viewRange(view, focusKey, { weekStart = 1, narrow = false, listDays = 30 } = {}) {
    const focus = parseDateKey(focusKey);
    let first;
    let count;
    let title;
    if (view === 'month') {
        first = startOfWeek({ ...focus, day: 1 }, weekStart);
        const lastOfMonth = { ...focus, day: daysInMonth(focus.year, focus.month) };
        const end = addDays(startOfWeek(lastOfMonth, weekStart), 7);
        count = Math.round((wallNumber(end) - wallNumber(first)) / 86400000);
        title = monthTitle(focus.year, focus.month);
    } else if (view === 'week') {
        first = narrow ? focus : startOfWeek(focus, weekStart);
        count = narrow ? 3 : 7;
    } else if (view === 'day') {
        first = focus;
        count = 1;
    } else {
        first = focus;
        count = Math.max(1, listDays);
    }
    const days = Array.from({ length: count }, (_, i) => dateKey(addDays(first, i)));
    if (!title) title = view === 'day' ? dayLong(days[0]) : rangeTitle(days[0], days[days.length - 1]);
    return { view, days, from: days[0], to: dateKey(addDays(first, count)), title, month: focus.month, year: focus.year };
}

// The focus date one step back (-1) or forward (+1).
export function stepFocus(view, focusKey, direction, { narrow = false, listDays = 30 } = {}) {
    const focus = parseDateKey(focusKey);
    if (view === 'month') return dateKey(addMonths(focus, direction));
    if (view === 'week') return dateKey(addDays(focus, direction * (narrow ? 3 : 7)));
    if (view === 'day') return dateKey(addDays(focus, direction));
    return dateKey(addDays(focus, direction * listDays));
}

export function dayBounds(key, zone) {
    const day = parseDateKey(key);
    return { start: wallToUtc(day, zone), end: wallToUtc(addDays(day, 1), zone) };
}

export function rangeBounds(range, zone) {
    return { start: wallToUtc(parseDateKey(range.from), zone), end: wallToUtc(parseDateKey(range.to), zone) };
}

function byDisplayOrder(a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay && a.days !== b.days) return b.days - a.days;
    return a.startUtc - b.startUtc || (b.endUtc - b.startUtc) - (a.endUtc - a.startUtc)
        || String(a.summary).localeCompare(String(b.summary));
}

// The occurrences on each day of a range: an all-day event on every date it covers, a timed one on
// every day it overlaps. Each day's list has the all-day ones first, then by start.
export function occurrencesByDay(occurrences, days, zone) {
    const map = new Map(days.map(key => [key, []]));
    const bounds = days.map(key => ({ key, ...dayBounds(key, zone) }));
    for (const occ of occurrences) {
        if (occ.allDay) {
            for (const b of bounds) if (b.key >= occ.startDate && b.key < occ.endDate) map.get(b.key).push(occ);
            continue;
        }
        for (const b of bounds) {
            const instant = occ.endUtc === occ.startUtc;
            const hit = instant ? occ.startUtc >= b.start && occ.startUtc < b.end : occ.startUtc < b.end && occ.endUtc > b.start;
            if (hit) map.get(b.key).push(occ);
        }
    }
    for (const list of map.values()) list.sort(byDisplayOrder);
    return map;
}

function minutesOf(utcMs, zone) {
    const w = utcToWall(utcMs, zone);
    return w.hour * 60 + w.minute;
}

// Where the timed occurrences of one day go in a day column: top and bottom in minutes from the
// day's 00:00 on its clock, and, where events overlap, side by side in `cols` columns.
export function layoutDay(occurrences, dayKey, zone, { minMinutes = 20 } = {}) {
    const { start: dayStart, end: dayEnd } = dayBounds(dayKey, zone);
    const items = [];
    for (const occ of occurrences) {
        if (occ.allDay) continue;
        const instant = occ.endUtc === occ.startUtc;
        const inDay = instant ? occ.startUtc >= dayStart && occ.startUtc < dayEnd : occ.startUtc < dayEnd && occ.endUtc > dayStart;
        if (!inDay) continue;
        let top = occ.startUtc <= dayStart ? 0 : minutesOf(occ.startUtc, zone);
        let bottom = occ.endUtc >= dayEnd ? MINUTES_PER_DAY : minutesOf(occ.endUtc, zone);
        if (bottom < top + minMinutes) bottom = top + minMinutes;
        if (bottom > MINUTES_PER_DAY) {
            bottom = MINUTES_PER_DAY;
            top = Math.min(top, MINUTES_PER_DAY - minMinutes);
        }
        items.push({ occ, top, bottom, startsBefore: occ.startUtc < dayStart, endsAfter: occ.endUtc > dayEnd, col: 0, cols: 1 });
    }
    items.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    const out = [];
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
        const columnEnds = [];
        for (const item of cluster) {
            let col = columnEnds.findIndex(end => end <= item.top);
            if (col < 0) { col = columnEnds.length; columnEnds.push(item.bottom); } else columnEnds[col] = item.bottom;
            item.col = col;
        }
        for (const item of cluster) item.cols = columnEnds.length;
        out.push(...cluster);
        cluster = [];
        clusterEnd = -1;
    };
    for (const item of items) {
        if (cluster.length && item.top >= clusterEnd) flush();
        cluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.bottom);
    }
    if (cluster.length) flush();
    return out;
}

// Where the red "now" line goes in a day column, in minutes, or null when now is not that day.
export function nowMinutes(dayKey, nowMs, zone) {
    const { start, end } = dayBounds(dayKey, zone);
    if (nowMs < start || nowMs >= end) return null;
    return minutesOf(nowMs, zone);
}

// The minute a tap at `fraction` (0..1) of a day column stands for, rounded to `step` minutes.
export function minuteAt(fraction, step = 30) {
    const minute = Math.floor((Math.max(0, Math.min(0.9999, fraction)) * MINUTES_PER_DAY) / step) * step;
    return Math.min(MINUTES_PER_DAY - step, minute);
}

// The days of a list that have something on them.
export function agendaDays(occurrences, days, zone) {
    const map = occurrencesByDay(occurrences, days, zone);
    return days.filter(key => map.get(key).length).map(key => ({ key, items: map.get(key) }));
}

function normalizeText(text) {
    return String(text || '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Whether an occurrence matches a search: every word of the query is in its title, place or notes.
export function matchesSearch(occ, query) {
    const words = normalizeText(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = normalizeText(`${occ.summary}\n${occ.location}\n${occ.description}`);
    return words.every(w => hay.includes(w));
}

// The month cell's chips: as many as fit, and how many more there are.
export function chipsFor(list, max) {
    if (list.length <= max) return { shown: list, more: 0 };
    return { shown: list.slice(0, Math.max(0, max - 1)), more: list.length - Math.max(0, max - 1) };
}

export { addMonths };
