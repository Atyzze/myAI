// Recurrence rules (RFC 5545 3.3.10 and 3.8.5.3), expanded in wall-clock time.
//
// Each period of the rule's frequency (a year, a month, a week, a day, ...) is taken in turn, starting
// with the one that holds DTSTART and stepping by INTERVAL. Within a period, the BYxxx parts narrow the
// period's days down (which is how a YEARLY rule "expands" BYMONTH: it starts from the whole year), the
// times of day come from BYHOUR, BYMINUTE and BYSECOND (or DTSTART's), and BYSETPOS then picks among
// what is left. DTSTART is always the first occurrence and counts toward COUNT, as RFC 5545 says.

import { WEEKDAY_INDEX, daysInMonth, daysInYear, wallNumber, wallFromNumber, weekdayOf, addDays,
         addMonths, dayOfYear, DAY_MS } from './wall.js';

const MAX_EMPTY_PERIODS = 4000;
const LAST_YEAR = 9999;

function sortedUnique(numbers) {
    return [...new Set(numbers)].sort((a, b) => a - b);
}

// Fills in what RFC 5545 takes from DTSTART when the rule does not say.
export function normalizeRule(rule, dtstart) {
    const r = { ...rule, interval: Math.max(1, rule.interval || 1), wkst: rule.wkst || 'MO' };
    const dayLevel = (r.byweekno && r.byweekno.length) || (r.byyearday && r.byyearday.length)
        || (r.bymonthday && r.bymonthday.length) || (r.byday && r.byday.length);
    if (!dayLevel) {
        if (r.freq === 'YEARLY') {
            if (!r.bymonth || !r.bymonth.length) r.bymonth = [dtstart.month];
            r.bymonthday = [dtstart.day];
        } else if (r.freq === 'MONTHLY') {
            r.bymonthday = [dtstart.day];
        } else if (r.freq === 'WEEKLY') {
            r.byday = [{ n: 0, day: Object.keys(WEEKDAY_INDEX)[weekdayOf(dtstart)] }];
        }
    } else if (r.freq === 'YEARLY' && r.byweekno && r.byweekno.length && !(r.byday && r.byday.length)
               && !(r.bymonthday && r.bymonthday.length) && !(r.byyearday && r.byyearday.length)) {
        r.byday = [{ n: 0, day: Object.keys(WEEKDAY_INDEX)[weekdayOf(dtstart)] }];
    }
    const coarse = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY'];
    if (!(r.byhour && r.byhour.length)) r.byhour = coarse.includes(r.freq) ? [dtstart.hour || 0] : null;
    if (!(r.byminute && r.byminute.length)) r.byminute = (coarse.includes(r.freq) || r.freq === 'HOURLY') ? [dtstart.minute || 0] : null;
    if (!(r.bysecond && r.bysecond.length)) r.bysecond = r.freq === 'SECONDLY' ? null : [dtstart.second || 0];
    return r;
}

// ---- week numbers (RFC 5545 BYWEEKNO: week 1 is the first week with at least four days) --------

function weekOneStart(year, wkst) {
    const jan1 = { year, month: 1, day: 1 };
    const offset = (weekdayOf(jan1) - wkst + 7) % 7;
    const start = addDays(jan1, -offset);
    // The week holding Jan 1 is week 1 when at least four of its days are in the year.
    return (7 - offset) >= 4 ? start : addDays(start, 7);
}

function weeksInYear(year, wkst) {
    const thisStart = wallNumber(weekOneStart(year, wkst));
    const nextStart = wallNumber(weekOneStart(year + 1, wkst));
    return Math.round((nextStart - thisStart) / (7 * DAY_MS));
}

function daysOfWeekNumber(year, weekno, wkst) {
    const total = weeksInYear(year, wkst);
    const n = weekno < 0 ? total + weekno + 1 : weekno;
    if (n < 1 || n > total) return [];
    const start = addDays(weekOneStart(year, wkst), (n - 1) * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// ---- day filters -------------------------------------------------------------------------------------

function nthWeekdayMatches(day, wd, n, scopeDays) {
    // scopeDays: every day of the month or year the "nth" counts within, in order.
    const same = scopeDays.filter(d => weekdayOf(d) === wd);
    const index = n > 0 ? n - 1 : same.length + n;
    const target = same[index];
    return !!target && target.year === day.year && target.month === day.month && target.day === day.day;
}

function monthDays(year, month) {
    return Array.from({ length: daysInMonth(year, month) }, (_, i) => ({ year, month, day: i + 1 }));
}

const yearDaysCache = new Map();
function yearDays(year) {
    if (!yearDaysCache.has(year)) {
        const days = [];
        for (let m = 1; m <= 12; m++) days.push(...monthDays(year, m));
        if (yearDaysCache.size > 64) yearDaysCache.clear();
        yearDaysCache.set(year, days);
    }
    return yearDaysCache.get(year);
}

function dayPasses(day, r, periodYear) {
    if (r.bymonth && r.bymonth.length && !r.bymonth.includes(day.month)) return false;
    if (r.byyearday && r.byyearday.length) {
        const doy = dayOfYear(day);
        const total = daysInYear(day.year);
        if (!r.byyearday.some(n => (n > 0 ? n : total + n + 1) === doy)) return false;
    }
    if (r.bymonthday && r.bymonthday.length) {
        const total = daysInMonth(day.year, day.month);
        if (!r.bymonthday.some(n => (n > 0 ? n : total + n + 1) === day.day)) return false;
    }
    if (r.byday && r.byday.length) {
        const wd = weekdayOf(day);
        const ok = r.byday.some(({ n, day: code }) => {
            const target = WEEKDAY_INDEX[code];
            if (target !== wd) return false;
            if (!n) return true;
            if (r.freq === 'MONTHLY' || (r.freq === 'YEARLY' && r.bymonth && r.bymonth.length)) {
                return nthWeekdayMatches(day, wd, n, monthDays(day.year, day.month));
            }
            if (r.freq === 'YEARLY' && !(r.byweekno && r.byweekno.length)) {
                return nthWeekdayMatches(day, wd, n, yearDays(periodYear));
            }
            return true;
        });
        if (!ok) return false;
    }
    return true;
}

function periodDays(r, index, dtstart) {
    const step = index * r.interval;
    if (r.freq === 'YEARLY') {
        const year = dtstart.year + step;
        if (r.byweekno && r.byweekno.length) {
            const wkst = WEEKDAY_INDEX[r.wkst];
            const seen = new Set();
            const days = [];
            for (const weekno of r.byweekno) {
                for (const day of daysOfWeekNumber(year, weekno, wkst)) {
                    const key = wallNumber(day);
                    if (!seen.has(key)) { seen.add(key); days.push(day); }
                }
            }
            days.sort((a, b) => wallNumber(a) - wallNumber(b));
            return { year, days };
        }
        return { year, days: yearDays(year) };
    }
    if (r.freq === 'MONTHLY') {
        const first = addMonths({ year: dtstart.year, month: dtstart.month, day: 1 }, step);
        return { year: first.year, days: monthDays(first.year, first.month) };
    }
    if (r.freq === 'WEEKLY') {
        const wkst = WEEKDAY_INDEX[r.wkst];
        const offset = (weekdayOf(dtstart) - wkst + 7) % 7;
        const start = addDays({ year: dtstart.year, month: dtstart.month, day: dtstart.day }, step * 7 - offset);
        return { year: start.year, days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
    }
    // DAILY and finer: one day per period for DAILY; the sub-daily frequencies are handled apart.
    const day = addDays({ year: dtstart.year, month: dtstart.month, day: dtstart.day }, step);
    return { year: day.year, days: [day] };
}

function timesOfDay(r) {
    const times = [];
    for (const h of sortedUnique(r.byhour)) {
        for (const m of sortedUnique(r.byminute)) {
            for (const s of sortedUnique(r.bysecond)) times.push([h, m, s]);
        }
    }
    return times;
}

function applySetPos(list, setpos) {
    if (!setpos || !setpos.length) return list;
    const picked = [];
    for (const pos of setpos) {
        const item = pos > 0 ? list[pos - 1] : list[list.length + pos];
        if (item && !picked.includes(item)) picked.push(item);
    }
    return picked.sort((a, b) => wallNumber(a) - wallNumber(b));
}

function* subDailyCandidates(r, index, dtstart) {
    const unitSeconds = r.freq === 'HOURLY' ? 3600 : r.freq === 'MINUTELY' ? 60 : 1;
    const base = wallFromNumber(wallNumber(dtstart) + index * r.interval * unitSeconds * 1000);
    if (!dayPasses(base, r, base.year)) return;
    if (r.byhour && r.byhour.length && !r.byhour.includes(base.hour)) return;
    if (r.freq === 'HOURLY') {
        const minutes = r.byminute ? sortedUnique(r.byminute) : [dtstart.minute];
        const seconds = r.bysecond ? sortedUnique(r.bysecond) : [dtstart.second];
        const list = [];
        for (const mi of minutes) for (const s of seconds) list.push({ ...base, minute: mi, second: s });
        yield* applySetPos(list, r.bysetpos);
        return;
    }
    if (r.byminute && r.byminute.length && !r.byminute.includes(base.minute)) return;
    if (r.freq === 'MINUTELY') {
        const seconds = r.bysecond ? sortedUnique(r.bysecond) : [dtstart.second];
        yield* applySetPos(seconds.map(s => ({ ...base, second: s })), r.bysetpos);
        return;
    }
    if (r.bysecond && r.bysecond.length && !r.bysecond.includes(base.second)) return;
    yield base;
}

// The first period worth expanding for a caller that only wants occurrences from `skipBefore` on:
// two periods before the one that holds it, so nothing from it on is missed. A rule with COUNT is
// always expanded from its start, as every earlier occurrence counts toward COUNT.
function firstPeriodIndex(r, dtstart, skipBefore) {
    if (!skipBefore || r.count != null) return 0;
    const target = wallNumber(skipBefore);
    const startNumber = wallNumber(dtstart);
    if (target <= startNumber) return 0;
    const days = Math.floor((target - wallNumber({ year: dtstart.year, month: dtstart.month, day: dtstart.day })) / DAY_MS);
    let periods = 0;
    if (r.freq === 'DAILY') periods = Math.floor(days / r.interval);
    else if (r.freq === 'WEEKLY') periods = Math.floor(days / (7 * r.interval));
    else if (r.freq === 'MONTHLY') periods = Math.floor(((skipBefore.year - dtstart.year) * 12 + (skipBefore.month - dtstart.month)) / r.interval);
    else if (r.freq === 'YEARLY') periods = Math.floor((skipBefore.year - dtstart.year) / r.interval);
    else {
        const unit = r.freq === 'HOURLY' ? 3600000 : r.freq === 'MINUTELY' ? 60000 : 1000;
        periods = Math.floor((target - startNumber) / (unit * r.interval));
    }
    return Math.max(0, periods - 2);
}

// Yields the rule's occurrences as wall-clock times, in order, beginning with DTSTART.
// isAfterUntil(wall) says whether a candidate lies past UNTIL (the caller knows the time zone);
// stopAfter(wall), when given, ends the expansion once the caller has seen enough; skipBefore
// (a wall time) lets a rule without COUNT pass over the years before it unexpanded, so a series
// that began long ago costs no more to show than a new one. DTSTART is yielded either way.
export function* expandRule(rule, dtstart, { isAfterUntil = null, stopAfter = null, skipBefore = null } = {}) {
    if (!rule || !rule.freq) { yield { ...dtstart }; return; }
    const r = normalizeRule(rule, dtstart);
    const startNumber = wallNumber(dtstart);
    let emitted = 0;
    const limit = r.count != null ? r.count : Infinity;
    if (limit <= 0) return;

    yield { ...dtstart };
    emitted++;
    if (emitted >= limit) return;

    const subDaily = ['HOURLY', 'MINUTELY', 'SECONDLY'].includes(r.freq);
    let emptyPeriods = 0;
    for (let index = firstPeriodIndex(r, dtstart, skipBefore); ; index++) {
        let candidates;
        if (subDaily) {
            candidates = [...subDailyCandidates(r, index, dtstart)];
            const probe = wallFromNumber(startNumber + index * r.interval * 1000
                * (r.freq === 'HOURLY' ? 3600 : r.freq === 'MINUTELY' ? 60 : 1));
            if (probe.year > LAST_YEAR) return;
            if (stopAfter && stopAfter(probe) && !candidates.length) return;
        } else {
            const { year, days } = periodDays(r, index, dtstart);
            if (year > LAST_YEAR) return;
            const times = timesOfDay(r);
            const list = [];
            for (const day of days) {
                if (!dayPasses(day, r, year)) continue;
                for (const [hour, minute, second] of times) list.push({ year: day.year, month: day.month, day: day.day, hour, minute, second });
            }
            list.sort((a, b) => wallNumber(a) - wallNumber(b));
            candidates = applySetPos(list, r.bysetpos);
            if (!candidates.length && stopAfter && days.length && stopAfter(days[days.length - 1])) return;
        }
        if (!candidates.length) {
            if (++emptyPeriods > MAX_EMPTY_PERIODS) return;
            continue;
        }
        emptyPeriods = 0;
        for (const candidate of candidates) {
            if (wallNumber(candidate) <= startNumber) continue;
            if (isAfterUntil && isAfterUntil(candidate)) return;
            if (stopAfter && stopAfter(candidate)) return;
            yield candidate;
            emitted++;
            if (emitted >= limit) return;
        }
    }
}

// A short description for the screen: "Every week on Monday and Wednesday, until 1 Dec 2026".
export function describeRule(rule, { untilText = null, weekdayName = code => code } = {}) {
    if (!rule) return '';
    const n = rule.interval && rule.interval > 1 ? rule.interval : 1;
    const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year', HOURLY: 'hour', MINUTELY: 'minute', SECONDLY: 'second' }[rule.freq];
    let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
    const ordinal = k => (k === -1 ? 'last' : k === 1 ? 'first' : k === 2 ? 'second' : k === 3 ? 'third' : k === 4 ? 'fourth' : k === -2 ? 'second-to-last' : `${k}th`);
    if (rule.byday && rule.byday.length) {
        const days = rule.byday.map(d => (d.n ? `${ordinal(d.n)} ${weekdayName(d.day)}` : weekdayName(d.day)));
        const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'];
        if (rule.freq === 'WEEKLY' && n === 1 && rule.byday.length === 5 && rule.byday.every(d => !d.n && weekdays.includes(d.day))) {
            text = 'Every weekday';
        } else {
            text += ` on ${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0]}`;
        }
    } else if (rule.bymonthday && rule.bymonthday.length && rule.freq === 'MONTHLY') {
        text += ` on day ${rule.bymonthday.map(d => (d === -1 ? 'last' : d)).join(', ')}`;
    }
    if (rule.count) text += `, ${rule.count} times`;
    else if (untilText) text += `, until ${untilText}`;
    return text;
}
