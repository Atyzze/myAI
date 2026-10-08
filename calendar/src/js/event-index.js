// The calendar objects of this device's copy, read once and kept ready for the views: each object
// is parsed when first needed, and knows the span of time it can have occurrences in, so a view only
// expands the events that can show up in it. What a view asked for is remembered until the next
// change, so moving back and forth costs nothing.

import { readSeries, expandSeries, eventTiming } from './occurrences.js';
import { getProps, readDateProp, parseRecur } from './icalendar.js';
import { wallToUtc } from './tz.js';
import { wallNumber, DAY_MS } from './wall.js';

const MARGIN_MS = 2 * DAY_MS;
const RANGES_REMEMBERED = 24;

// The earliest and latest instant an object can have an occurrence in, two days wider than needed
// (all-day and floating events move with the viewer's zone). A rule that goes on forever, or one
// with COUNT, is open-ended; expanding those stops at the end of the window anyway.
export function seriesBounds(series, viewerZone) {
    let min = Infinity;
    let max = -Infinity;
    let span = 0;
    for (const vevent of [series.master, ...series.overrides]) {
        if (!vevent) continue;
        const timing = eventTiming(vevent, series, viewerZone);
        if (!timing) continue;
        const start = timing.allDay ? wallToUtc(timing.startWall, viewerZone) : wallToUtc(timing.startWall, timing.zone);
        const length = timing.allDay ? timing.days * DAY_MS
            : (timing.exactMs != null ? timing.exactMs : timing.nominal.days * DAY_MS + timing.nominal.seconds * 1000);
        span = Math.max(span, length);
        min = Math.min(min, start);
        max = Math.max(max, start + Math.max(0, length));
    }
    if (series.master) {
        for (const prop of getProps(series.master, 'RRULE')) {
            const rule = parseRecur(prop.value);
            if (!rule) continue;
            if (rule.count != null || !rule.until) { max = Infinity; break; }
            max = Math.max(max, wallNumber(rule.until) + span + DAY_MS);
        }
        for (const prop of getProps(series.master, 'RDATE')) {
            const parsed = readDateProp(prop);
            if (!parsed) continue;
            for (const value of parsed.values) {
                const at = wallNumber(value);
                min = Math.min(min, at - DAY_MS);
                max = Math.max(max, at + span + DAY_MS);
            }
        }
    }
    if (min === Infinity) return { min: -Infinity, max: Infinity };
    return { min: min - MARGIN_MS, max: max + MARGIN_MS };
}

export class EventIndex {
    constructor() {
        this.entries = new Map();
        this.version = 0;
        this.ranges = new Map();
    }

    changed() {
        this.version++;
        this.ranges.clear();
    }

    replaceAll(records) {
        const before = this.entries;
        this.entries = new Map();
        for (const record of records) {
            const old = before.get(record.href);
            // An object whose text did not change keeps what was worked out from it.
            if (old && old.record.data === record.data && old.record.calendar === record.calendar) {
                this.entries.set(record.href, { ...old, record });
            } else {
                this.entries.set(record.href, { record });
            }
        }
        this.changed();
    }

    put(record) {
        const old = this.entries.get(record.href);
        if (old && old.record.data === record.data && old.record.calendar === record.calendar) {
            old.record = record;
        } else {
            this.entries.set(record.href, { record });
        }
        this.changed();
    }

    remove(href) {
        if (this.entries.delete(href)) this.changed();
    }

    get(href) {
        const entry = this.entries.get(href);
        return entry ? entry.record : null;
    }

    get size() {
        return this.entries.size;
    }

    records() {
        return [...this.entries.values()].map(e => e.record);
    }

    series(href) {
        const entry = this.entries.get(href);
        return entry ? this.seriesOf(entry) : null;
    }

    seriesOf(entry) {
        if (entry.series === undefined) {
            try {
                entry.series = readSeries(entry.record.data, { href: entry.record.href, calendar: entry.record.calendar });
            } catch (_) {
                entry.series = null;
            }
        }
        return entry.series;
    }

    boundsOf(entry, zone) {
        if (!entry.bounds || entry.boundsZone !== zone.id) {
            const series = this.seriesOf(entry);
            try {
                entry.bounds = series ? seriesBounds(series, zone) : { min: Infinity, max: -Infinity };
            } catch (_) {
                entry.bounds = { min: -Infinity, max: Infinity };
            }
            entry.boundsZone = zone.id;
        }
        return entry.bounds;
    }

    // Every occurrence in [fromUtc, toUtc) of the objects in `calendars` (a Set of calendar
    // addresses; null for all), in order. An object that cannot be read is left out, not fatal.
    occurrences(fromUtc, toUtc, zone, calendars = null) {
        const key = `${fromUtc}|${toUtc}|${zone.id}|${calendars ? [...calendars].sort().join(' ') : '*'}`;
        const remembered = this.ranges.get(key);
        if (remembered) return remembered;
        const out = [];
        for (const entry of this.entries.values()) {
            if (calendars && !calendars.has(entry.record.calendar)) continue;
            const bounds = this.boundsOf(entry, zone);
            if (bounds.max < fromUtc || bounds.min > toUtc) continue;
            const series = this.seriesOf(entry);
            if (!series) continue;
            try {
                for (const occ of expandSeries(series, fromUtc, toUtc, zone)) out.push(occ);
            } catch (_) {
                // One broken event must not take the whole calendar down with it.
            }
        }
        out.sort((a, b) => a.startUtc - b.startUtc || (b.allDay - a.allDay) || String(a.summary).localeCompare(String(b.summary)));
        if (this.ranges.size >= RANGES_REMEMBERED) this.ranges.delete(this.ranges.keys().next().value);
        this.ranges.set(key, out);
        return out;
    }

    // The objects of one calendar by UID, so an import can update what an earlier import brought in.
    uidsIn(calendarHref) {
        const map = new Map();
        for (const entry of this.entries.values()) {
            if (entry.record.calendar !== calendarHref) continue;
            const series = this.seriesOf(entry);
            if (series && series.uid) map.set(series.uid, entry.record.href);
        }
        return map;
    }

    countIn(calendarHref) {
        let n = 0;
        for (const entry of this.entries.values()) if (entry.record.calendar === calendarHref) n++;
        return n;
    }
}
