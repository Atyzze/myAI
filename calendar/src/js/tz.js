// Time zones. An instant is a UTC millisecond count; what a person sees is a wall-clock time in a
// zone. Zones the browser knows (IANA names, through Intl) are used directly; a TZID it does not know
// (an Outlook "W. Europe Standard Time", a Thunderbird "/mozilla.org/.../Europe/Berlin") is mapped to
// one it does, and otherwise read from the VTIMEZONE the calendar object carries.

import { wallNumber, wallFromNumber, weekdayOf, daysInMonth, WEEKDAY_CODE, DAY_MS } from './wall.js';
import { expandRule } from './rrule.js';
import { component, property, getProp, getProps, childComponents, parseRecur, readDateProp,
         formatDateValue } from './icalendar.js';

const MINUTE = 60000;

export const UTC_ZONE = Object.freeze({ id: 'UTC', utc: true, offsetAt: () => 0 });

// ---- zones the browser knows -------------------------------------------------------------------------

const validity = new Map();
export function isKnownZone(id) {
    if (!id) return false;
    if (validity.has(id)) return validity.get(id);
    let ok = false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: id }); ok = true; } catch (_) { ok = false; }
    validity.set(id, ok);
    return ok;
}

const formatters = new Map();
function formatterFor(id) {
    let f = formatters.get(id);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: id, hourCycle: 'h23', era: 'short',
            year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
        });
        formatters.set(id, f);
    }
    return f;
}

function intlOffset(id, utcMs) {
    const parts = formatterFor(id).formatToParts(new Date(utcMs));
    const get = type => { const p = parts.find(x => x.type === type); return p ? parseInt(p.value, 10) : 0; };
    let year = get('year');
    const era = (parts.find(p => p.type === 'era') || {}).value;
    if (era === 'BC' || era === 'B') year = 1 - year;
    let hour = get('hour');
    if (hour === 24) hour = 0;
    const asWall = wallNumber({ year, month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') });
    return asWall - Math.floor(utcMs / 1000) * 1000;
}

const SECOND = 1000;
const DAYS_REMEMBERED = 60000;

// The offsets of one UTC day: clocks change at most once a day, so the offsets at its first and its
// last second settle the whole day, and when they differ the change itself is found to the second.
// A repeating event that began years ago asks about every day since; each is worked out once.
function dayOffsets(name, dayNumber) {
    const start = dayNumber * DAY_MS;
    const first = intlOffset(name, start);
    const last = intlOffset(name, start + DAY_MS - SECOND);
    if (first === last) return { at: Infinity, before: first, after: first };
    let lo = start;
    let hi = start + DAY_MS - SECOND;
    while (hi - lo > SECOND) {
        const mid = lo + Math.floor((hi - lo) / (2 * SECOND)) * SECOND;
        if (intlOffset(name, mid) === first) lo = mid; else hi = mid;
    }
    return { at: hi, before: first, after: intlOffset(name, hi) };
}

const ianaZones = new Map();
export function ianaZone(id) {
    const name = canonicalUtc(id) ? 'UTC' : id;
    if (name === 'UTC') return UTC_ZONE;
    let zone = ianaZones.get(name);
    if (!zone) {
        const days = new Map();
        zone = {
            id: name,
            utc: false,
            offsetAt(utcMs) {
                const dayNumber = Math.floor(utcMs / DAY_MS);
                let day = days.get(dayNumber);
                if (day === undefined) {
                    day = dayOffsets(name, dayNumber);
                    if (days.size > DAYS_REMEMBERED) days.clear();
                    days.set(dayNumber, day);
                }
                return utcMs < day.at ? day.before : day.after;
            }
        };
        ianaZones.set(name, zone);
    }
    return zone;
}

function canonicalUtc(id) {
    return /^(utc|gmt|z|etc\/utc|etc\/gmt|etc\/universal|etc\/zulu|universal|zulu|etc\/gmt[+-]0|gmt[+-]0|utc[+-]0)$/i.test(String(id || '').trim());
}

export function deviceZoneId() {
    try {
        const id = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return isKnownZone(id) ? id : 'UTC';
    } catch (_) {
        return 'UTC';
    }
}

// ---- wall time and instants ------------------------------------------------------------------------------

export function utcToWall(utcMs, zone) {
    return wallFromNumber(utcMs + zone.offsetAt(utcMs));
}

// The instant a wall-clock time in a zone stands for. A time skipped when the clocks go forward is
// read with the offset from before the change (RFC 5545 3.3.5), so 02:30 on a spring-forward night
// is 03:30; a time that happens twice when they go back is the first of the two.
export function wallToUtc(w, zone) {
    if (zone.utc) return wallNumber(w);
    const local = wallNumber(w);
    const before = zone.offsetAt(local - DAY_MS);
    const after = zone.offsetAt(local + DAY_MS);
    if (before === after) {
        const guess = local - before;
        if (zone.offsetAt(guess) === before) return guess;
    }
    const candidates = [...new Set([before, after, zone.offsetAt(local - before), zone.offsetAt(local - after)])]
        .map(offset => local - offset)
        .filter(utc => utc + zone.offsetAt(utc) === local)
        .sort((a, b) => a - b);
    if (candidates.length) return candidates[0];
    return local - before;
}

// ---- Windows and legacy names --------------------------------------------------------------------------

// Windows time zone names (CLDR windowsZones, territory 001) as Outlook and Exchange write them.
export const WINDOWS_ZONES = {
    'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Aleutian Standard Time': 'America/Adak',
    'Hawaiian Standard Time': 'Pacific/Honolulu', 'Marquesas Standard Time': 'Pacific/Marquesas',
    'Alaskan Standard Time': 'America/Anchorage', 'UTC-09': 'Etc/GMT+9', 'Pacific Standard Time (Mexico)': 'America/Tijuana',
    'UTC-08': 'Etc/GMT+8', 'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix',
    'Mountain Standard Time (Mexico)': 'America/Mazatlan', 'Mountain Standard Time': 'America/Denver',
    'Yukon Standard Time': 'America/Whitehorse', 'Central America Standard Time': 'America/Guatemala',
    'Central Standard Time': 'America/Chicago', 'Easter Island Standard Time': 'Pacific/Easter',
    'Central Standard Time (Mexico)': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina',
    'SA Pacific Standard Time': 'America/Bogota', 'Eastern Standard Time (Mexico)': 'America/Cancun',
    'Eastern Standard Time': 'America/New_York', 'Haiti Standard Time': 'America/Port-au-Prince',
    'Cuba Standard Time': 'America/Havana', 'US Eastern Standard Time': 'America/Indianapolis',
    'Turks And Caicos Standard Time': 'America/Grand_Turk', 'Paraguay Standard Time': 'America/Asuncion',
    'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
    'Central Brazilian Standard Time': 'America/Cuiaba', 'SA Western Standard Time': 'America/La_Paz',
    'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
    'Tocantins Standard Time': 'America/Araguaina', 'E. South America Standard Time': 'America/Sao_Paulo',
    'SA Eastern Standard Time': 'America/Cayenne', 'Argentina Standard Time': 'America/Buenos_Aires',
    'Greenland Standard Time': 'America/Godthab', 'Montevideo Standard Time': 'America/Montevideo',
    'Magallanes Standard Time': 'America/Punta_Arenas', 'Saint Pierre Standard Time': 'America/Miquelon',
    'Bahia Standard Time': 'America/Bahia', 'UTC-02': 'Etc/GMT+2', 'Azores Standard Time': 'Atlantic/Azores',
    'Cape Verde Standard Time': 'Atlantic/Cape_Verde', 'UTC': 'Etc/UTC', 'GMT Standard Time': 'Europe/London',
    'Greenwich Standard Time': 'Atlantic/Reykjavik', 'Sao Tome Standard Time': 'Africa/Sao_Tome',
    'Morocco Standard Time': 'Africa/Casablanca', 'W. Europe Standard Time': 'Europe/Berlin',
    'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
    'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos',
    'Jordan Standard Time': 'Asia/Amman', 'GTB Standard Time': 'Europe/Bucharest',
    'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
    'E. Europe Standard Time': 'Europe/Chisinau', 'Syria Standard Time': 'Asia/Damascus',
    'West Bank Standard Time': 'Asia/Hebron', 'South Africa Standard Time': 'Africa/Johannesburg',
    'FLE Standard Time': 'Europe/Kiev', 'Israel Standard Time': 'Asia/Jerusalem',
    'South Sudan Standard Time': 'Africa/Juba', 'Kaliningrad Standard Time': 'Europe/Kaliningrad',
    'Sudan Standard Time': 'Africa/Khartoum', 'Libya Standard Time': 'Africa/Tripoli',
    'Namibia Standard Time': 'Africa/Windhoek', 'Arabic Standard Time': 'Asia/Baghdad',
    'Turkey Standard Time': 'Europe/Istanbul', 'Arab Standard Time': 'Asia/Riyadh',
    'Belarus Standard Time': 'Europe/Minsk', 'Russian Standard Time': 'Europe/Moscow',
    'E. Africa Standard Time': 'Africa/Nairobi', 'Volgograd Standard Time': 'Europe/Volgograd',
    'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
    'Astrakhan Standard Time': 'Europe/Astrakhan', 'Azerbaijan Standard Time': 'Asia/Baku',
    'Russia Time Zone 3': 'Europe/Samara', 'Mauritius Standard Time': 'Indian/Mauritius',
    'Saratov Standard Time': 'Europe/Saratov', 'Georgian Standard Time': 'Asia/Tbilisi',
    'Caucasus Standard Time': 'Asia/Yerevan', 'Afghanistan Standard Time': 'Asia/Kabul',
    'West Asia Standard Time': 'Asia/Tashkent', 'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
    'Pakistan Standard Time': 'Asia/Karachi', 'Qyzylorda Standard Time': 'Asia/Qyzylorda',
    'India Standard Time': 'Asia/Calcutta', 'Sri Lanka Standard Time': 'Asia/Colombo',
    'Nepal Standard Time': 'Asia/Katmandu', 'Central Asia Standard Time': 'Asia/Almaty',
    'Bangladesh Standard Time': 'Asia/Dhaka', 'Omsk Standard Time': 'Asia/Omsk',
    'Myanmar Standard Time': 'Asia/Rangoon', 'SE Asia Standard Time': 'Asia/Bangkok',
    'Altai Standard Time': 'Asia/Barnaul', 'W. Mongolia Standard Time': 'Asia/Hovd',
    'North Asia Standard Time': 'Asia/Krasnoyarsk', 'N. Central Asia Standard Time': 'Asia/Novosibirsk',
    'Tomsk Standard Time': 'Asia/Tomsk', 'China Standard Time': 'Asia/Shanghai',
    'North Asia East Standard Time': 'Asia/Irkutsk', 'Singapore Standard Time': 'Asia/Singapore',
    'W. Australia Standard Time': 'Australia/Perth', 'Taipei Standard Time': 'Asia/Taipei',
    'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar', 'Aus Central W. Standard Time': 'Australia/Eucla',
    'Transbaikal Standard Time': 'Asia/Chita', 'Tokyo Standard Time': 'Asia/Tokyo',
    'North Korea Standard Time': 'Asia/Pyongyang', 'Korea Standard Time': 'Asia/Seoul',
    'Yakutsk Standard Time': 'Asia/Yakutsk', 'Cen. Australia Standard Time': 'Australia/Adelaide',
    'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'West Pacific Standard Time': 'Pacific/Port_Moresby',
    'Tasmania Standard Time': 'Australia/Hobart', 'Vladivostok Standard Time': 'Asia/Vladivostok',
    'Lord Howe Standard Time': 'Australia/Lord_Howe', 'Bougainville Standard Time': 'Pacific/Bougainville',
    'Russia Time Zone 10': 'Asia/Srednekolymsk', 'Magadan Standard Time': 'Asia/Magadan',
    'Norfolk Standard Time': 'Pacific/Norfolk', 'Sakhalin Standard Time': 'Asia/Sakhalin',
    'Central Pacific Standard Time': 'Pacific/Guadalcanal', 'Russia Time Zone 11': 'Asia/Kamchatka',
    'New Zealand Standard Time': 'Pacific/Auckland', 'UTC+12': 'Etc/GMT-12', 'Fiji Standard Time': 'Pacific/Fiji',
    'Chatham Islands Standard Time': 'Pacific/Chatham', 'UTC+13': 'Etc/GMT-13', 'Tonga Standard Time': 'Pacific/Tongatapu',
    'Samoa Standard Time': 'Pacific/Apia', 'Line Islands Standard Time': 'Pacific/Kiritimati'
};

// The name a TZID stands for, if it is one the browser knows: as given, a Windows name, or the
// "Area/City" tail of a legacy prefixed name.
export function knownZoneName(tzid) {
    const id = String(tzid || '').trim().replace(/^"|"$/g, '');
    if (!id) return null;
    if (canonicalUtc(id)) return 'UTC';
    if (isKnownZone(id) && id.includes('/')) return id;
    if (WINDOWS_ZONES[id] && isKnownZone(WINDOWS_ZONES[id])) return WINDOWS_ZONES[id];
    const segments = id.split('/').filter(Boolean);
    for (let take = Math.min(3, segments.length); take >= 2; take--) {
        const tail = segments.slice(-take).join('/');
        if (isKnownZone(tail)) return tail;
    }
    if (isKnownZone(id)) return id;
    return null;
}

// ---- zones defined by a VTIMEZONE ----------------------------------------------------------------------

function parseOffset(text) {
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(text || '').trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * ((+m[2]) * 3600 + (+m[3]) * 60 + (+(m[4] || 0))) * 1000;
}

const LAST_ONSET_YEAR = 2200;
const customZones = new Map();

// The same VTIMEZONE arrives with every event of a calendar; it is worked out once.
export function zoneFromVtimezone(vtz) {
    const key = JSON.stringify(vtz);
    let zone = customZones.get(key);
    if (!zone) {
        zone = buildCustomZone(vtz);
        if (customZones.size > 200) customZones.clear();
        customZones.set(key, zone);
    }
    return zone;
}

function buildCustomZone(vtz) {
    const tzid = (getProp(vtz, 'TZID') || {}).value || 'custom';
    const onsets = [];
    let earliest = null;
    for (const obs of vtz.components.filter(c => c.name === 'STANDARD' || c.name === 'DAYLIGHT')) {
        const from = parseOffset((getProp(obs, 'TZOFFSETFROM') || {}).value);
        const to = parseOffset((getProp(obs, 'TZOFFSETTO') || {}).value);
        const start = readDateProp(getProp(obs, 'DTSTART'));
        if (from == null || to == null || !start) continue;
        const dtstart = start.values[0];
        const push = w => onsets.push({ utc: wallNumber(w) - from, to });
        const ruleProp = getProp(obs, 'RRULE');
        const rule = ruleProp ? parseRecur(ruleProp.value) : null;
        if (rule) {
            const untilUtc = rule.until ? (rule.until.utc ? wallNumber(rule.until) : wallNumber(rule.until) - from) : null;
            for (const w of expandRule(rule, dtstart, {
                isAfterUntil: untilUtc == null ? null : cand => wallNumber(cand) - from > untilUtc,
                stopAfter: cand => cand.year > LAST_ONSET_YEAR
            })) push(w);
        } else {
            push(dtstart);
        }
        for (const rdate of getProps(obs, 'RDATE')) {
            const parsed = readDateProp(rdate);
            if (parsed) parsed.values.forEach(push);
        }
        const firstUtc = wallNumber(dtstart) - from;
        if (!earliest || firstUtc < earliest.utc) earliest = { utc: firstUtc, from };
    }
    onsets.sort((a, b) => a.utc - b.utc);
    const before = earliest ? earliest.from : 0;
    return {
        id: tzid,
        utc: false,
        custom: true,
        offsetAt(utcMs) {
            let lo = 0, hi = onsets.length - 1, found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (onsets[mid].utc <= utcMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
            }
            return found >= 0 ? onsets[found].to : before;
        }
    };
}

// The zone a TZID refers to, inside one calendar object (whose VTIMEZONEs are given by TZID).
// Unknown and undefined TZIDs fall back to the viewer's zone, as floating times do.
export function resolveZone(tzid, vtimezones, fallbackZone) {
    if (!tzid) return fallbackZone;
    const name = knownZoneName(tzid);
    if (name) return ianaZone(name);
    const vtz = vtimezones && (vtimezones.get ? vtimezones.get(tzid) : vtimezones[tzid]);
    if (vtz) return zoneFromVtimezone(vtz);
    return fallbackZone;
}

export function vtimezonesOf(vcalendar) {
    const map = new Map();
    for (const vtz of childComponents(vcalendar, 'VTIMEZONE')) {
        const id = (getProp(vtz, 'TZID') || {}).value;
        if (id) map.set(id, vtz);
    }
    return map;
}

// ---- writing a VTIMEZONE -----------------------------------------------------------------------------------

function formatOffset(ms) {
    const sign = ms < 0 ? '-' : '+';
    const total = Math.abs(Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${sign}${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${s ? String(s).padStart(2, '0') : ''}`;
}

// Every change of UTC offset between two instants, found day by day and then to the minute.
export function transitionsBetween(zone, fromUtc, toUtc) {
    const out = [];
    let t = fromUtc;
    let offset = zone.offsetAt(t);
    while (t < toUtc) {
        const next = Math.min(t + DAY_MS, toUtc);
        const nextOffset = zone.offsetAt(next);
        if (nextOffset !== offset) {
            // lo and hi stay whole minutes apart, so the midpoint is always strictly between them.
            let lo = t, hi = next;
            while (hi - lo > MINUTE) {
                const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
                if (zone.offsetAt(mid) === offset) lo = mid; else hi = mid;
            }
            out.push({ utc: hi, from: offset, to: zone.offsetAt(hi) });
            offset = zone.offsetAt(hi);
        }
        t = next;
    }
    return out;
}

function yearlyRuleFor(w) {
    const last = daysInMonth(w.year, w.month);
    const n = w.day + 7 > last ? -1 : Math.ceil(w.day / 7);
    return { freq: 'YEARLY', interval: 1, bymonth: [w.month], byday: [{ n, day: WEEKDAY_CODE[weekdayOf(w)] }] };
}

// A VTIMEZONE for a zone the browser knows, accurate from the year before `year` on. Zones that
// change their clocks by a "nth weekday of a month" rule get one STANDARD and one DAYLIGHT with an
// RRULE (checked against the browser for twenty years); others get their changes listed one by one.
export function buildVtimezone(zoneId, year) {
    const zone = ianaZone(zoneId);
    if (zone.utc) return null;
    const startUtc = wallNumber({ year: year - 1, month: 1, day: 1 });
    const endUtc = wallNumber({ year: year + 20, month: 1, day: 1 });
    const changes = transitionsBetween(zone, startUtc, endUtc);
    const props = [property('TZID', zoneId)];
    if (!changes.length) {
        const offset = formatOffset(zone.offsetAt(startUtc));
        return component('VTIMEZONE', props, [component('STANDARD', [
            property('DTSTART', '19700101T000000'),
            property('TZOFFSETFROM', offset), property('TZOFFSETTO', offset)
        ])]);
    }
    const firstYear = changes.filter(c => wallFromNumber(c.utc + c.from).year === year - 1);
    const kinds = [];
    if (firstYear.length === 2) {
        for (const change of firstYear) {
            const local = wallFromNumber(change.utc + change.from);
            const rule = yearlyRuleFor(local);
            const expected = changes.filter(c => c.to === change.to && c.from === change.from);
            const generated = [];
            for (const w of expandRule(rule, local, { stopAfter: cand => cand.year >= year + 20 })) {
                generated.push(wallNumber(w) - change.from);
            }
            const matches = generated.length === expected.length
                && generated.every((utc, i) => Math.abs(utc - expected[i].utc) < MINUTE);
            kinds.push({ change, local, rule, matches });
        }
    }
    const observance = (change, local, rule) => {
        const daylight = change.to > change.from;
        const obsProps = [
            property('DTSTART', formatDateValue({ ...local, date: false, utc: false })),
            property('TZOFFSETFROM', formatOffset(change.from)),
            property('TZOFFSETTO', formatOffset(change.to))
        ];
        if (rule) {
            const ruleText = `FREQ=YEARLY;BYMONTH=${rule.bymonth[0]};BYDAY=${rule.byday[0].n}${rule.byday[0].day}`;
            obsProps.push(property('RRULE', ruleText));
        }
        return component(daylight ? 'DAYLIGHT' : 'STANDARD', obsProps);
    };
    if (kinds.length === 2 && kinds.every(k => k.matches)) {
        return component('VTIMEZONE', props, kinds.map(k => observance(k.change, k.local, k.rule)));
    }
    return component('VTIMEZONE', props, changes.map(change =>
        observance(change, wallFromNumber(change.utc + change.from), null)));
}

export function offsetLabel(zone, utcMs) {
    const offset = zone.offsetAt(utcMs);
    const sign = offset < 0 ? '-' : '+';
    const total = Math.abs(offset) / MINUTE;
    const h = Math.floor(total / 60), m = total % 60;
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
