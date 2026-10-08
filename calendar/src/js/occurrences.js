// From calendar objects to what a view draws: every occurrence of every event in a window of time.
//
// A calendar object holds one event (one UID): a master VEVENT, which may repeat (RRULE, RDATE,
// minus EXDATE), and VEVENTs with a RECURRENCE-ID that replace single occurrences. Timed events are
// instants (UTC milliseconds), worked out in their own time zone so a 09:00 meeting stays at 09:00
// across a daylight-saving change; all-day events are dates, the same dates wherever the viewer is.

import { parseCalendar, childComponents, getProp, getProps, getText, readDateProp, parseRecur,
         parseDuration, durationParts, paramValue } from './icalendar.js';
import { resolveZone, vtimezonesOf, wallToUtc, utcToWall, UTC_ZONE } from './tz.js';
import { expandRule } from './rrule.js';
import { wallNumber, wallFromNumber, addDays, dateKey, dateOnly, daysBetween, DAY_MS } from './wall.js';

const MAX_INSTANCES_SCANNED = 200000;

// ---- one calendar object -------------------------------------------------------------------------

export function readSeries(text, meta = {}) {
    const vcalendar = parseCalendar(text);
    if (!vcalendar) return null;
    const events = childComponents(vcalendar, 'VEVENT');
    if (!events.length) return null;
    const master = events.find(e => !getProp(e, 'RECURRENCE-ID')) || null;
    const overrides = events.filter(e => getProp(e, 'RECURRENCE-ID'));
    const uid = getText(master || events[0], 'UID');
    return { ...meta, uid, vcalendar, master, overrides, vtimezones: vtimezonesOf(vcalendar) };
}

// When an event starts and ends, in its own terms. `zone` is the zone its times are read in (the
// viewer's for floating times), or null for an all-day event.
export function eventTiming(vevent, series, viewerZone, inheritFrom = null) {
    const timing = ownTiming(vevent, series, viewerZone);
    // An override that gives no end of its own lasts as long as the series' occurrences do.
    if (timing && inheritFrom && !getProp(vevent, 'DTEND') && !getProp(vevent, 'DURATION')
        && timing.allDay === inheritFrom.allDay) {
        if (timing.allDay) timing.days = inheritFrom.days;
        else { timing.nominal = inheritFrom.nominal; timing.exactMs = inheritFrom.exactMs; timing.wallEnd = inheritFrom.wallEnd; }
    }
    return timing;
}

function ownTiming(vevent, series, viewerZone) {
    const startProp = readDateProp(getProp(vevent, 'DTSTART'));
    if (!startProp) return null;
    const start = startProp.values[0];
    const allDay = !!start.date;
    if (allDay) {
        const startDate = dateOnly(start);
        let days = 1;
        const endProp = readDateProp(getProp(vevent, 'DTEND'));
        const durationProp = getProp(vevent, 'DURATION');
        if (endProp) {
            days = Math.max(1, daysBetween(startDate, dateOnly(endProp.values[0])));
        } else if (durationProp) {
            const parts = durationParts(parseDuration(durationProp.value));
            days = Math.max(1, parts.days + Math.floor(parts.seconds / 86400));
        }
        return { allDay: true, startWall: startDate, zone: null, days, floating: false };
    }
    const zone = start.utc ? UTC_ZONE : resolveZone(startProp.tzid, series.vtimezones, viewerZone);
    const floating = !start.utc && !startProp.tzid;
    const startWall = { year: start.year, month: start.month, day: start.day, hour: start.hour, minute: start.minute, second: start.second };
    let nominal = { days: 0, seconds: 0 };
    let exactMs = null;
    // An end given as a clock time in the same zone (DTEND) is a clock time for every occurrence:
    // 01:30 to 03:30 is until 03:30 also on the night the clocks go back. A DURATION counts its days
    // on the calendar and its hours exactly (RFC 5545 3.3.6).
    let wallEnd = false;
    const endProp = readDateProp(getProp(vevent, 'DTEND'));
    const durationProp = getProp(vevent, 'DURATION');
    if (endProp) {
        const end = endProp.values[0];
        const endZone = end.utc ? UTC_ZONE : (end.date ? zone : resolveZone(endProp.tzid, series.vtimezones, viewerZone));
        if (endZone === zone) {
            const endWall = { year: end.year, month: end.month, day: end.day, hour: end.hour, minute: end.minute, second: end.second };
            const diff = (wallNumber(endWall) - wallNumber(startWall)) / 1000;
            const days = Math.floor(diff / 86400);
            nominal = { days, seconds: diff - days * 86400 };
            wallEnd = true;
        } else {
            exactMs = wallToUtc({ ...end }, endZone) - wallToUtc(startWall, zone);
        }
    } else if (durationProp) {
        nominal = durationParts(parseDuration(durationProp.value));
    }
    return { allDay: false, startWall, zone, nominal, exactMs, floating, wallEnd };
}

// The end of one occurrence that starts at startUtc (wall time startWall in the event's zone).
function timedEnd(timing, startWall, startUtc) {
    if (timing.exactMs != null) return startUtc + Math.max(0, timing.exactMs);
    if (timing.wallEnd) {
        const endWall = wallFromNumber(wallNumber(startWall) + (timing.nominal.days * DAY_MS + timing.nominal.seconds * 1000));
        return Math.max(startUtc, wallToUtc(endWall, timing.zone));
    }
    const endWall = addDays(startWall, timing.nominal.days);
    const end = wallToUtc(endWall, timing.zone) + timing.nominal.seconds * 1000;
    return Math.max(startUtc, end);
}

// The key that names one occurrence: its original start, as an instant for timed events and as a
// date for all-day ones. RECURRENCE-ID and EXDATE values are turned into the same keys to match.
export function instanceKey(value, tzid, series, timing, viewerZone) {
    if (timing.allDay || value.date) return dateKey(value).replace(/-/g, '');
    const zone = value.utc ? UTC_ZONE : (tzid ? resolveZone(tzid, series.vtimezones, viewerZone) : timing.zone);
    return String(wallToUtc({ ...value }, zone));
}

function keysOfDateProps(vevent, name, series, timing, viewerZone) {
    const keys = new Set();
    for (const prop of getProps(vevent, name)) {
        const parsed = readDateProp(prop);
        if (!parsed) continue;
        for (const value of parsed.values) {
            keys.add(instanceKey(value, parsed.tzid, series, timing, viewerZone));
            // An all-day series whose EXDATE was written as a date-time still means that date.
            if (timing.allDay && !value.date) keys.add(dateKey(value).replace(/-/g, ''));
        }
    }
    return keys;
}

function textOf(vevent, name) {
    return getText(vevent, name);
}

function alarmsOf(vevent) {
    return childComponents(vevent, 'VALARM').map(alarm => {
        const trigger = getProp(alarm, 'TRIGGER');
        if (!trigger) return null;
        const action = ((getProp(alarm, 'ACTION') || {}).value || 'DISPLAY').toUpperCase();
        // RFC 9074: when the alarm was dismissed, on whichever device (Apple's calendars write it).
        const ackProp = readDateProp(getProp(alarm, 'ACKNOWLEDGED'));
        const acknowledged = ackProp && ackProp.values[0].utc ? wallNumber(ackProp.values[0]) : null;
        const valueType = (paramValue(trigger, 'VALUE') || '').toUpperCase();
        if (valueType === 'DATE-TIME' || /^\d{8}T\d{6}Z?$/.test(trigger.value)) {
            const parsed = readDateProp(trigger);
            if (!parsed) return null;
            return { action, absoluteUtc: wallNumber(parsed.values[0]), description: getText(alarm, 'DESCRIPTION'), acknowledged };
        }
        const duration = parseDuration(trigger.value);
        if (!duration) return null;
        const related = (paramValue(trigger, 'RELATED') || 'START').toUpperCase();
        return { action, related, offset: durationParts(duration), description: getText(alarm, 'DESCRIPTION'), acknowledged };
    }).filter(Boolean);
}

function occurrenceOf(vevent, series, timing, { startWall, startUtc, key, recurring, override }, viewerZone) {
    const status = ((getProp(vevent, 'STATUS') || {}).value || '').toUpperCase();
    const base = {
        href: series.href || null,
        calendar: series.calendar || null,
        uid: series.uid,
        key: `${series.href || series.uid}#${key}`,
        recurrenceKey: recurring ? key : '',
        recurring,
        override: !!override,
        summary: textOf(vevent, 'SUMMARY'),
        location: textOf(vevent, 'LOCATION'),
        description: textOf(vevent, 'DESCRIPTION'),
        url: (getProp(vevent, 'URL') || {}).value || '',
        status,
        cancelled: status === 'CANCELLED',
        alarms: alarmsOf(vevent),
        vevent
    };
    if (timing.allDay) {
        const endWall = addDays(startWall, timing.days);
        return {
            ...base,
            allDay: true,
            startDate: dateKey(startWall),
            endDate: dateKey(endWall),
            days: timing.days,
            startUtc: wallToUtc(startWall, viewerZone),
            endUtc: wallToUtc(endWall, viewerZone),
            zoneId: null,
            zone: viewerZone
        };
    }
    const endUtc = timedEnd(timing, startWall, startUtc);
    return {
        ...base,
        allDay: false,
        startUtc,
        endUtc,
        zoneId: timing.floating ? null : timing.zone.id,
        zone: timing.zone,
        startWallInZone: startWall
    };
}

// A relative alarm: whole days on the calendar of the event's zone (RFC 5545 3.3.6), the rest exact.
function alarmInstant(occ, alarm) {
    if (alarm.absoluteUtc != null) return alarm.absoluteUtc;
    const base = alarm.related === 'END' ? occ.endUtc : occ.startUtc;
    let at = base;
    if (alarm.offset.days && occ.zone) at = wallToUtc(addDays(utcToWall(base, occ.zone), alarm.offset.days), occ.zone);
    else at = base + alarm.offset.days * DAY_MS;
    return at + alarm.offset.seconds * 1000;
}

// Every occurrence of one calendar object that overlaps [fromUtc, toUtc).
export function expandSeries(series, fromUtc, toUtc, viewerZone) {
    const out = [];
    const masterTiming = series.master ? eventTiming(series.master, series, viewerZone) : null;
    const overrideKeys = new Map();
    for (const ov of series.overrides) {
        const rid = readDateProp(getProp(ov, 'RECURRENCE-ID'));
        const timing = eventTiming(ov, series, viewerZone, masterTiming);
        if (!rid || !timing) continue;
        const keyTiming = masterTiming || timing;
        overrideKeys.set(instanceKey(rid.values[0], rid.tzid, series, keyTiming, viewerZone), { ov, timing });
    }

    const overlaps = occ => occ.endUtc > fromUtc && occ.startUtc < toUtc
        || (occ.startUtc === occ.endUtc && occ.startUtc >= fromUtc && occ.startUtc < toUtc);

    if (series.master && masterTiming) {
        const timing = masterTiming;
        const ruleProps = getProps(series.master, 'RRULE');
        const rules = ruleProps.map(p => parseRecur(p.value)).filter(Boolean);
        const recurring = rules.length > 0 || getProps(series.master, 'RDATE').length > 0;
        const exdates = keysOfDateProps(series.master, 'EXDATE', series, timing, viewerZone);
        const zone = timing.allDay ? viewerZone : timing.zone;
        const toUtcOf = w => (timing.allDay ? wallToUtc(dateOnly(w), viewerZone) : wallToUtc(w, timing.zone));
        // An occurrence that started before the window may still be running in it.
        const spanMs = timing.allDay ? timing.days * DAY_MS + DAY_MS
            : (timing.exactMs != null ? timing.exactMs : (timing.nominal.days + 1) * DAY_MS + timing.nominal.seconds * 1000);
        const earliestStart = fromUtc - Math.max(0, spanMs);
        // The window as wall-clock times in the event's zone, two days wider on each side than any
        // UTC offset can move it: a series that began years ago passes over its early occurrences
        // without working out the instant each one stands for.
        const earliestWall = wallNumber(utcToWall(earliestStart, zone)) - 2 * DAY_MS;
        const latestWall = wallNumber(utcToWall(toUtc, zone)) + 2 * DAY_MS;
        const seen = new Set();

        const emit = (startWall) => {
            if (wallNumber(startWall) < earliestWall) return;
            const startUtc = toUtcOf(startWall);
            const key = timing.allDay ? dateKey(startWall).replace(/-/g, '') : String(startUtc);
            if (seen.has(key)) return;
            seen.add(key);
            if (exdates.has(key) || overrideKeys.has(key)) return;
            if (startUtc < earliestStart) return;
            const occ = occurrenceOf(series.master, series, timing, { startWall, startUtc, key, recurring, override: false }, viewerZone);
            if (overlaps(occ)) out.push(occ);
        };

        if (!rules.length) {
            emit(timing.startWall);
        } else {
            for (const rule of rules) {
                const until = rule.until;
                let isAfterUntil = null;
                if (until) {
                    if (timing.allDay || until.date) {
                        const untilNumber = wallNumber(dateOnly(until));
                        isAfterUntil = w => wallNumber(dateOnly(w)) > untilNumber;
                    } else if (until.utc && !timing.floating) {
                        const untilUtc = wallNumber(until);
                        const untilWall = wallNumber(utcToWall(untilUtc, zone));
                        isAfterUntil = w => {
                            const n = wallNumber(w);
                            if (n < untilWall - 2 * DAY_MS) return false;
                            if (n > untilWall + 2 * DAY_MS) return true;
                            return wallToUtc(w, zone) > untilUtc;
                        };
                    } else {
                        const untilNumber = wallNumber(until);
                        isAfterUntil = w => wallNumber(w) > untilNumber;
                    }
                }
                let scanned = 0;
                for (const w of expandRule(rule, timing.startWall, {
                    isAfterUntil,
                    skipBefore: wallFromNumber(earliestWall),
                    stopAfter: cand => (wallNumber(cand) > latestWall && toUtcOf(cand) >= toUtc) || ++scanned > MAX_INSTANCES_SCANNED
                })) emit(w);
            }
        }
        for (const prop of getProps(series.master, 'RDATE')) {
            const parsed = readDateProp(prop);
            if (!parsed) continue;
            for (const value of parsed.values) {
                if (timing.allDay || value.date) { emit(dateOnly(value)); continue; }
                const rdZone = value.utc ? UTC_ZONE : (parsed.tzid ? resolveZone(parsed.tzid, series.vtimezones, viewerZone) : timing.zone);
                const utc = wallToUtc({ ...value }, rdZone);
                emit(timing.floating ? { ...value } : utcToWall(utc, timing.zone));
            }
        }
    }

    for (const [key, { ov, timing }] of overrideKeys) {
        let startUtc;
        let startWall = timing.startWall;
        if (timing.allDay) startUtc = wallToUtc(startWall, viewerZone);
        else startUtc = wallToUtc(startWall, timing.zone);
        const occ = occurrenceOf(ov, series, timing, { startWall, startUtc, key, recurring: true, override: true }, viewerZone);
        if (occ.cancelled) continue;
        if (overlaps(occ)) out.push(occ);
    }
    out.sort((a, b) => a.startUtc - b.startUtc || (b.allDay - a.allDay) || a.summary.localeCompare(b.summary));
    return out;
}

// Every alarm that goes off in [fromUtc, toUtc) for the given occurrences.
export function alarmsBetween(occurrences, fromUtc, toUtc) {
    const fired = [];
    for (const occ of occurrences) {
        if (occ.cancelled) continue;
        for (const alarm of occ.alarms || []) {
            const at = alarmInstant(occ, alarm);
            if (at >= fromUtc && at < toUtc) {
                fired.push({ at, occurrence: occ, alarm, id: `${occ.key}|${alarm.absoluteUtc ?? `${alarm.related}${alarm.offset.days}d${alarm.offset.seconds}s`}` });
            }
        }
    }
    return fired.sort((a, b) => a.at - b.at);
}

export function utcDayRange(dateKeyText, zone) {
    const [y, m, d] = dateKeyText.split('-').map(Number);
    const start = wallToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, zone);
    const end = wallToUtc(addDays({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, 1), zone);
    return { start, end };
}

export { wallFromNumber };
