// Wall-clock dates and times: what a clock on the wall shows, with no time zone attached. They are
// counted as if they were UTC (Date.UTC), so adding a day is always 24 hours of clock and never
// meets a daylight-saving change; a time zone is applied only when a wall time becomes an instant.

export const DAY_MS = 86400000;
export const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export const WEEKDAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function daysInYear(year) {
    return isLeapYear(year) ? 366 : 365;
}

export function wall(year, month, day, hour = 0, minute = 0, second = 0) {
    return { year, month, day, hour, minute, second };
}

export function wallNumber(w) {
    const d = new Date(0);
    d.setUTCFullYear(w.year, w.month - 1, w.day);
    d.setUTCHours(w.hour || 0, w.minute || 0, w.second || 0, 0);
    return d.getTime();
}

export function wallFromNumber(n) {
    const d = new Date(n);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds()
    };
}

export function weekdayOf(w) {
    return new Date(wallNumber({ ...w, hour: 0, minute: 0, second: 0 })).getUTCDay();
}

export function addDays(w, days) {
    return wallFromNumber(wallNumber(w) + days * DAY_MS);
}

export function addSeconds(w, seconds) {
    return wallFromNumber(wallNumber(w) + seconds * 1000);
}

export function addMonths(w, months) {
    const total = w.year * 12 + (w.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    return { ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) };
}

export function compareWall(a, b) {
    return wallNumber(a) - wallNumber(b);
}

export function sameDate(a, b) {
    return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function dayOfYear(w) {
    return Math.round((wallNumber({ year: w.year, month: w.month, day: w.day }) - wallNumber({ year: w.year, month: 1, day: 1 })) / DAY_MS) + 1;
}

// 'YYYY-MM-DD', the key the views and all-day events use for a date.
export function dateKey(w) {
    return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function parseDateKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    return m ? { year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 } : null;
}

export function dateOnly(w) {
    return { year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 };
}

// Days between two dates, counted on the calendar (b - a).
export function daysBetween(a, b) {
    return Math.round((wallNumber(dateOnly(b)) - wallNumber(dateOnly(a))) / DAY_MS);
}

// The first day of the week (weekStart 0 = Sunday, 1 = Monday) that holds the date.
export function startOfWeek(w, weekStart = 1) {
    const offset = (weekdayOf(w) - weekStart + 7) % 7;
    return addDays(dateOnly(w), -offset);
}
