// The calendar core on its own: iCalendar text, time zones, recurrence, occurrences and edits.
import fs from 'node:fs';
import { suite } from '../helpers/check.mjs';

const ical = await import('../../src/js/icalendar.js');
const tz = await import('../../src/js/tz.js');
const { expandRule } = await import('../../src/js/rrule.js');
const wallLib = await import('../../src/js/wall.js');
const occ = await import('../../src/js/occurrences.js');
const model = await import('../../src/js/event-model.js');

const { ok, eq, finish } = suite('core');
const { wallNumber } = wallLib;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const AMS = tz.ianaZone('Europe/Amsterdam');
const NY = tz.ianaZone('America/New_York');
const lines = text => ical.unfoldLines(text).filter(Boolean);

// ---- iCalendar text -----------------------------------------------------------------------------------
{
    const folded = 'DESCRIPTION:This is a lo\r\n ng description\r\n  that exists on a long line.';
    eq(ical.unfoldLines(folded)[0], 'DESCRIPTION:This is a long description that exists on a long line.',
       'unfold: a fold removes exactly the line break and one space (RFC 5545 3.1)');
    const longAscii = 'SUMMARY:' + 'x'.repeat(200);
    const foldedLong = ical.foldLine(longAscii);
    ok(foldedLong.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75),
       'fold: no physical line is longer than 75 octets');
    eq(ical.unfoldLines(foldedLong)[0], longAscii, 'fold then unfold gives the line back');
    const multi = 'SUMMARY:' + 'Verjaardag 🎂 café é '.repeat(12);
    const foldedMulti = ical.foldLine(multi);
    ok(foldedMulti.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75 && !l.includes('�')),
       'fold: multi-byte characters are never split, and lines stay within 75 octets');
    eq(ical.unfoldLines(foldedMulti)[0], multi, 'fold then unfold keeps emoji and accents intact');

    const prop = ical.parseContentLine('ATTENDEE;CN="Doe, John";ROLE=REQ-PARTICIPANT;X-NOTE="a:b;c":mailto:john@example.org');
    eq(prop && prop.name, 'ATTENDEE', 'content line: the name is read');
    eq(prop.params.map(p => [p.name, p.values]), [['CN', ['Doe, John']], ['ROLE', ['REQ-PARTICIPANT']], ['X-NOTE', ['a:b;c']]],
       'content line: quoted parameter values may hold commas, colons and semicolons');
    eq(prop.value, 'mailto:john@example.org', 'content line: the value starts after the first unquoted colon');
    eq(ical.formatContentLine(prop), 'ATTENDEE;CN="Doe, John";ROLE=REQ-PARTICIPANT;X-NOTE="a:b;c":mailto:john@example.org',
       'content line: written back as it was');
    const caret = ical.parseContentLine('LOCATION;X-ADDRESS=Main St^n1 ^\'A^\':Home');
    eq(caret.params[0].values[0], 'Main St\n1 "A"', 'content line: RFC 6868 caret escapes are decoded');
    eq(ical.formatContentLine(caret), 'LOCATION;X-ADDRESS=Main St^n1 ^\'A^\':Home', 'and encoded again on the way out');

    const text = 'a,b;c\\d\ne';
    eq(ical.unescapeText(ical.escapeText(text)), text, 'TEXT: escaping and unescaping are inverse');
    eq(ical.escapeText(text), 'a\\,b\\;c\\\\d\\ne', 'TEXT: commas, semicolons, backslashes and newlines are escaped');

    eq(ical.parseDateValue('20261008'), { year: 2026, month: 10, day: 8, hour: 0, minute: 0, second: 0, date: true, utc: false }, 'DATE value');
    eq(ical.parseDateValue('20261008T093000Z').utc, true, 'DATE-TIME value in UTC');
    eq(ical.formatDateValue({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5, date: false, utc: false }), '20260102T030405',
       'DATE-TIME written back');
    eq(ical.durationParts(ical.parseDuration('-PT15M')), { days: 0, seconds: -900 }, 'duration: 15 minutes before');
    eq(ical.durationParts(ical.parseDuration('P1W')), { days: 7, seconds: 0 }, 'duration: a week is seven nominal days');
    eq(ical.durationParts(ical.parseDuration('-P1DT15H')), { days: -1, seconds: -54000 }, 'duration: days and hours');
    eq(ical.parseDuration('P'), null, 'duration: P alone is not a duration');
    eq(ical.formatDuration({ days: 0, seconds: -900 }), '-PT15M', 'duration written: -PT15M');
    eq(ical.formatDuration({ days: -1, seconds: -54000 }), '-P1DT15H', 'duration written: -P1DT15H');
    eq(ical.formatDuration({ days: 0, seconds: 0 }), 'PT0S', 'duration written: zero');
    eq(ical.formatDuration({ days: 14, seconds: 0 }), 'P2W', 'duration written: whole weeks');

    const rule = ical.parseRecur('FREQ=MONTHLY;BYDAY=-1FR;COUNT=5;X-CUSTOM=1');
    eq(rule.byday, [{ n: -1, day: 'FR' }], 'RRULE: an ordinal weekday is read');
    eq(ical.formatRecur(rule), 'FREQ=MONTHLY;COUNT=5;BYDAY=-1FR;X-CUSTOM=1', 'RRULE: written back, unknown parts kept');
    eq(ical.parseRecur('FREQ=FORTNIGHTLY'), null, 'RRULE: an unknown frequency is refused');
}

const APPLE_EVENT = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.0//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'DTSTART:19810329T020000',
    'TZNAME:CEST', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'DTSTART:19961027T030000',
    'TZNAME:CET', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'CREATED:20261001T080000Z', 'UID:apple-1@example.org', 'DTEND;TZID=Europe/Amsterdam:20261012T103000',
    'TRANSP:OPAQUE', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'SUMMARY:Tandarts',
    'LAST-MODIFIED:20261001T080000Z', 'DTSTAMP:20261001T080000Z',
    'DTSTART;TZID=Europe/Amsterdam:20261012T093000', 'LOCATION:Dam 1\\nAmsterdam',
    'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Dam 1\\nAmsterdam;X-APPLE-RADIUS=70;X-TITLE=Dam 1:geo:52.373,4.893',
    'ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED:mailto:jane@example.org',
    'SEQUENCE:0',
    'BEGIN:VALARM', 'X-WR-ALARMUID:A1', 'UID:A1', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
    'BEGIN:VALARM', 'UID:A2', 'TRIGGER;RELATED=END:PT0S', 'ACTION:AUDIO', 'ATTACH;VALUE=URI:Chord', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

{
    const tree = ical.parseCalendar(APPLE_EVENT);
    eq(lines(ical.serializeComponent(tree)), lines(APPLE_EVENT), 'round trip: an Apple event is written back line for line (long lines folded)');
    const vevent = ical.childComponents(tree, 'VEVENT')[0];
    eq(ical.getText(vevent, 'LOCATION'), 'Dam 1\nAmsterdam', 'a text property is unescaped for reading');
    const damaged = ical.parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:no end');
    ok(damaged.length === 1 && damaged[0].components[0] && ical.getText(damaged[0].components[0], 'SUMMARY') === 'no end',
       'a file cut off before its END lines still yields what it has');
}

// ---- time zones -------------------------------------------------------------------------------------------
{
    eq(tz.wallToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, AMS), utc(2026, 3, 29, 1, 30),
       'a time skipped by spring forward is read with the offset before the change (RFC 5545), so 02:30 is 03:30');
    eq(tz.wallToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, AMS), utc(2026, 10, 25, 0, 30),
       'a time that happens twice at fall back is the first of the two');
    eq(tz.wallToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, AMS), utc(2026, 7, 1, 7),
       'summer time in Amsterdam is UTC+2');
    eq(tz.wallToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 0, second: 0 }, AMS), utc(2026, 12, 1, 8),
       'winter time in Amsterdam is UTC+1');
    const lordHowe = tz.ianaZone('Australia/Lord_Howe');
    eq(lordHowe.offsetAt(utc(2026, 1, 15)) - lordHowe.offsetAt(utc(2026, 7, 15)), 30 * 60000,
       'Lord Howe Island moves its clocks by half an hour');
    eq(tz.ianaZone('Asia/Kolkata').offsetAt(utc(2026, 1, 1)), 5.5 * HOUR, 'India is UTC+5:30');
    eq(tz.ianaZone('Pacific/Chatham').offsetAt(utc(2026, 7, 1)), 12.75 * HOUR, 'Chatham is UTC+12:45 in its winter');

    let roundTrips = 0;
    let broken = [];
    for (const id of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kolkata', 'America/Sao_Paulo', 'Pacific/Chatham']) {
        const zone = tz.ianaZone(id);
        for (let t = utc(2018, 1, 1); t < utc(2034, 1, 1); t += 97 * HOUR + 13 * 60000) {
            const back = tz.wallToUtc(tz.utcToWall(t, zone), zone);
            roundTrips++;
            if (back !== t && !(zone.offsetAt(t) !== zone.offsetAt(t - 2 * HOUR))) broken.push(`${id} ${new Date(t).toISOString()}`);
        }
    }
    eq(broken.slice(0, 3), [], `instant → wall time → instant gives the same instant (${roundTrips} samples in 7 zones)`);

    eq(tz.knownZoneName('W. Europe Standard Time'), 'Europe/Berlin', 'an Outlook zone name is mapped to its IANA zone');
    eq(tz.knownZoneName('/mozilla.org/20050126_1/Europe/Amsterdam'), 'Europe/Amsterdam', 'an old Thunderbird TZID is read by its tail');
    eq(tz.knownZoneName('Europe/Amsterdam'), 'Europe/Amsterdam', 'an IANA name is itself');
    eq([tz.knownZoneName('UTC'), tz.knownZoneName('Etc/UTC'), tz.knownZoneName('GMT')], ['UTC', 'UTC', 'UTC'], 'the names of UTC are UTC');
    eq(tz.knownZoneName('Atlantis Standard Time'), null, 'a name nobody knows is not guessed');

    const outlook = ical.parseCalendar([
        'BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Custom Berlin',
        'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
        'END:VTIMEZONE', 'END:VCALENDAR'].join('\r\n'));
    const custom = tz.zoneFromVtimezone(ical.childComponents(outlook, 'VTIMEZONE')[0]);
    const berlin = tz.ianaZone('Europe/Berlin');
    let same = true;
    for (let t = utc(2025, 1, 1); t < utc(2028, 1, 1); t += 3 * HOUR) if (custom.offsetAt(t) !== berlin.offsetAt(t)) { same = false; break; }
    ok(same, 'a VTIMEZONE with yearly rules from 1601, as Outlook writes them, gives Berlin\'s offsets at every hour');

    const zones = ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Sao_Paulo',
                   'Asia/Tehran', 'Africa/Casablanca', 'Europe/Dublin', 'Pacific/Chatham', 'Asia/Kolkata', 'America/Santiago'];
    const wrong = [];
    for (const id of zones) {
        const vtz = tz.buildVtimezone(id, 2026);
        const text = ical.serializeComponent(vtz);
        const reread = tz.zoneFromVtimezone(ical.parseComponents(text)[0]);
        const zone = tz.ianaZone(id);
        for (let t = utc(2025, 1, 1); t < utc(2045, 1, 1); t += 6 * HOUR) {
            if (reread.offsetAt(t) !== zone.offsetAt(t)) { wrong.push(`${id} at ${new Date(t).toISOString()}`); break; }
        }
    }
    eq(wrong, [], 'the VTIMEZONE written for a zone gives the browser\'s own offsets for twenty years (11 zones, incl. half-hour and irregular ones)');
    const ams = ical.serializeComponent(tz.buildVtimezone('Europe/Amsterdam', 2026));
    ok(/BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/.test(ams) && /BEGIN:STANDARD[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/.test(ams),
       'Amsterdam is written as two yearly rules, last Sunday of March and of October');
}

// ---- recurrence against an independent implementation ------------------------------------------------------
{
    const data = JSON.parse(fs.readFileSync(new URL('../fixtures/rrule-oracle.json', import.meta.url), 'utf8'));
    const mismatches = [];
    for (const c of data.cases) {
        const rule = ical.parseRecur(c.rrule);
        const start = ical.parseDateValue(c.dtstart);
        const got = [];
        for (const w of expandRule(rule, start, { isAfterUntil: rule.until ? (w => wallNumber(w) > wallNumber(rule.until)) : null })) {
            got.push(ical.formatDateValue({ ...w, date: false, utc: false }));
            if (got.length >= data.take) break;
        }
        if (JSON.stringify(got) !== JSON.stringify(c.expected)) mismatches.push(`${c.name}: ${c.rrule}`);
    }
    eq(mismatches.slice(0, 5), [], `recurrence: ${data.cases.length} rules (every RFC 5545 example and ${data.cases.length - 50} random ones) expand exactly as python-dateutil does`);

    // Passing over the early years (skipBefore) gives the same occurrences from that point on.
    const skipMismatches = [];
    let skipChecked = 0;
    for (const c of data.cases) {
        const rule = ical.parseRecur(c.rrule);
        if (rule.count != null || c.expected.length < 4) continue;
        const start = ical.parseDateValue(c.dtstart);
        for (const at of [1, Math.floor(c.expected.length / 2), c.expected.length - 1]) {
            const from = ical.parseDateValue(c.expected[at]);
            const last = wallNumber(ical.parseDateValue(c.expected[c.expected.length - 1]));
            const want = c.expected.filter(v => wallNumber(ical.parseDateValue(v)) >= wallNumber(from));
            const got = [];
            for (const w of expandRule(rule, start, {
                isAfterUntil: rule.until ? (x => wallNumber(x) > wallNumber(rule.until)) : null,
                skipBefore: from,
                stopAfter: x => wallNumber(x) > last
            })) {
                if (wallNumber(w) >= wallNumber(from)) got.push(ical.formatDateValue({ ...w, date: false, utc: false }));
            }
            skipChecked++;
            if (JSON.stringify(got) !== JSON.stringify(want)) skipMismatches.push(`${c.name}: ${c.rrule} from ${c.expected[at]}`);
        }
    }
    eq(skipMismatches.slice(0, 5), [], `recurrence: starting late (${skipChecked} starting points in the rules without COUNT) gives exactly the occurrences a full expansion gives from there`);
    const weird = [...expandRule(ical.parseRecur('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'), { year: 2026, month: 1, day: 1, hour: 9, minute: 0, second: 0 })];
    eq(weird.length, 1, 'a rule that can never happen ends instead of searching forever (only DTSTART remains)');
}

// ---- occurrences ----------------------------------------------------------------------------------------------
const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test', ...body, 'END:VCALENDAR', ''].join('\r\n');
const series = (text, href = '/dav/u/cal/x.ics') => occ.readSeries(text, { href, calendar: '/dav/u/cal/' });
const range = (s, from, to, zone = AMS) => occ.expandSeries(series(s), from, to, zone);

{
    const meeting = cal('BEGIN:VEVENT', 'UID:w1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Standup',
        'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T091500',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'END:VEVENT');
    const list = range(meeting, utc(2026, 10, 1), utc(2026, 12, 1));
    eq(list.map(o => new Date(o.startUtc).toISOString().slice(0, 16)), ['2026-10-19T07:00', '2026-10-26T08:00', '2026-11-02T08:00', '2026-11-09T08:00'],
       'a weekly 09:00 meeting stays at 09:00 in Amsterdam across the end of summer time (07:00 then 08:00 UTC)');
    eq(list.map(o => (o.endUtc - o.startUtc) / 60000), [15, 15, 15, 15], 'and lasts 15 minutes each time');
    const fromNY = occ.expandSeries(series(meeting), utc(2026, 10, 1), utc(2026, 12, 1), NY);
    eq(fromNY.map(o => o.startUtc), list.map(o => o.startUtc), 'seen from New York it is the same instants');

    const birthday = cal('BEGIN:VEVENT', 'UID:b1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Verjaardag Anna',
        'DTSTART;VALUE=DATE:19900312', 'DTEND;VALUE=DATE:19900313', 'RRULE:FREQ=YEARLY', 'END:VEVENT');
    const b = range(birthday, utc(2026, 1, 1), utc(2028, 1, 1));
    eq(b.map(o => o.startDate), ['2026-03-12', '2027-03-12'], 'a yearly all-day birthday since 1990 shows once a year');
    eq(occ.expandSeries(series(birthday), utc(2026, 1, 1), utc(2027, 1, 1), tz.ianaZone('Pacific/Auckland')).map(o => o.startDate), ['2026-03-12'],
       'an all-day event is on the same date wherever the viewer is');

    const withExceptions = cal('BEGIN:VEVENT', 'UID:x1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Gym',
        'DTSTART;TZID=Europe/Amsterdam:20261005T190000', 'DTEND;TZID=Europe/Amsterdam:20261005T200000',
        'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Amsterdam:20261012T190000', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:x1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Gym (moved)',
        'RECURRENCE-ID;TZID=Europe/Amsterdam:20261019T190000',
        'DTSTART;TZID=Europe/Amsterdam:20261020T180000', 'DTEND;TZID=Europe/Amsterdam:20261020T190000', 'END:VEVENT');
    const g = range(withExceptions, utc(2026, 10, 1), utc(2026, 10, 31));
    const local = t => { const w = tz.utcToWall(t, AMS); return `${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}T${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`; };
    eq(g.map(o => `${local(o.startUtc)} ${o.summary}`),
       ['10-05T19:00 Gym', '10-20T18:00 Gym (moved)', '10-26T19:00 Gym'],
       'an EXDATE removes its occurrence and a RECURRENCE-ID moves its own (both in the same zone notation)');
    const moved = range(withExceptions, utc(2026, 10, 20), utc(2026, 10, 21));
    ok(moved.length === 1 && moved[0].override, 'a moved occurrence is found on the day it moved to');
    eq(range(withExceptions, utc(2026, 10, 19), utc(2026, 10, 20)).length, 0, 'and not on the day it moved from');

    const untilUtc = cal('BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Course',
        'DTSTART;TZID=Europe/Amsterdam:20261001T200000', 'DTEND;TZID=Europe/Amsterdam:20261001T210000',
        'RRULE:FREQ=DAILY;UNTIL=20261003T180000Z', 'END:VEVENT');
    eq(range(untilUtc, utc(2026, 9, 1), utc(2026, 11, 1)).length, 3, 'UNTIL in UTC includes the occurrence that starts exactly then');

    const multi = cal('BEGIN:VEVENT', 'UID:m1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20261228', 'DTEND;VALUE=DATE:20270104', 'END:VEVENT');
    const h = range(multi, utc(2027, 1, 1), utc(2027, 1, 2));
    ok(h.length === 1 && h[0].days === 7 && h[0].endDate === '2027-01-04', 'a week-long all-day event still running on 1 January is found there');

    const floating = cal('BEGIN:VEVENT', 'UID:f1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Wake up',
        'DTSTART:20261008T070000', 'DURATION:PT30M', 'END:VEVENT');
    eq(occ.expandSeries(series(floating), utc(2026, 10, 7), utc(2026, 10, 9), NY)[0].startUtc, utc(2026, 10, 8, 11),
       'a floating time is the viewer\'s own clock (07:00 in New York)');
    eq((range(floating, utc(2026, 10, 7), utc(2026, 10, 9))[0].endUtc - range(floating, utc(2026, 10, 7), utc(2026, 10, 9))[0].startUtc) / 60000, 30,
       'DURATION gives the length when there is no DTEND');

    const cancelled = cal('BEGIN:VEVENT', 'UID:c1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Class',
        'DTSTART;TZID=Europe/Amsterdam:20261005T100000', 'DTEND;TZID=Europe/Amsterdam:20261005T110000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:c1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Class', 'STATUS:CANCELLED',
        'RECURRENCE-ID;TZID=Europe/Amsterdam:20261006T100000',
        'DTSTART;TZID=Europe/Amsterdam:20261006T100000', 'DTEND;TZID=Europe/Amsterdam:20261006T110000', 'END:VEVENT');
    eq(range(cancelled, utc(2026, 10, 1), utc(2026, 10, 31)).length, 2, 'a cancelled occurrence of a series is not shown');

    const apple = range(APPLE_EVENT, utc(2026, 10, 12), utc(2026, 10, 13));
    const alarms = occ.alarmsBetween(apple, utc(2026, 10, 12), utc(2026, 10, 13));
    eq(alarms.map(a => new Date(a.at).toISOString().slice(11, 16)), ['06:30', '08:30'],
       'alarms: one hour before the start, and one at the end (RELATED=END)');
    const allDayAlarm = cal('BEGIN:VEVENT', 'UID:a2', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Bins out',
        'DTSTART;VALUE=DATE:20261027', 'DTEND;VALUE=DATE:20261028',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15H', 'DESCRIPTION:x', 'END:VALARM', 'END:VEVENT');
    const binAlarms = occ.alarmsBetween(range(allDayAlarm, utc(2026, 10, 27), utc(2026, 10, 28)), utc(2026, 10, 25), utc(2026, 10, 28));
    eq(binAlarms.map(a => new Date(a.at).toISOString().slice(0, 16)), ['2026-10-26T08:00'],
       'an all-day alarm of -PT15H goes off at 09:00 the day before, local time');
    const dayBefore = cal('BEGIN:VEVENT', 'UID:a3', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Flight',
        'DTSTART;TZID=Europe/Amsterdam:20261026T100000', 'DTEND;TZID=Europe/Amsterdam:20261026T120000',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'DESCRIPTION:x', 'END:VALARM', 'END:VEVENT');
    const flight = occ.alarmsBetween(range(dayBefore, utc(2026, 10, 26), utc(2026, 10, 27)), utc(2026, 10, 24), utc(2026, 10, 27));
    eq(flight.map(a => new Date(a.at).toISOString().slice(0, 16)), ['2026-10-25T09:00'],
       'a one-day-before alarm across the end of summer time is at the same clock time the day before (11:00 CEST... 10:00 CET)');
}

// ---- editing ---------------------------------------------------------------------------------------------------
{
    const now = utc(2026, 10, 8, 12);
    const form = model.blankForm({ date: '2026-10-20', hour: 14, zoneId: 'Europe/Amsterdam', defaults: { durationMinutes: 45, alarmSeconds: -900 } });
    form.summary = 'Kapper; with, punctuation';
    form.location = 'Kalverstraat 1, Amsterdam';
    const created = model.createEvent(form, { uid: 'new-1', nowMs: now, viewerZone: AMS });
    ok(/DTSTART;TZID=Europe\/Amsterdam:20261020T140000/.test(created.text) && /DTEND;TZID=Europe\/Amsterdam:20261020T144500/.test(created.text),
       'a new event is written in its own zone, with the default length');
    ok(/BEGIN:VTIMEZONE[\s\S]*TZID:Europe\/Amsterdam/.test(created.text), 'with the VTIMEZONE its TZID refers to');
    ok(/TRIGGER:-PT15M/.test(created.text) && /SUMMARY:Kapper\\; with\\, punctuation/.test(created.text),
       'with the default reminder, and its title escaped');
    const c = range(created.text, utc(2026, 10, 20), utc(2026, 10, 21));
    eq([c.length, c[0] && c[0].startUtc, c[0] && c[0].summary], [1, utc(2026, 10, 20, 12), 'Kapper; with, punctuation'],
       'and reads back as the same event');

    const allDay = model.blankForm({ date: '2026-12-24', zoneId: 'Europe/Amsterdam' });
    Object.assign(allDay, { allDay: true, summary: 'Kerst', startDate: '2026-12-24', endDate: '2026-12-26', alarms: [9 * 3600] });
    const xmas = model.createEvent(allDay, { uid: 'xmas', nowMs: now, viewerZone: AMS });
    ok(/DTSTART;VALUE=DATE:20261224/.test(xmas.text) && /DTEND;VALUE=DATE:20261227/.test(xmas.text) && !/VTIMEZONE/.test(xmas.text),
       'an all-day event from the 24th to the 26th ends (exclusive) on the 27th and needs no VTIMEZONE');

    // Edits keep what the event already had.
    const appleOcc = range(APPLE_EVENT, utc(2026, 10, 12), utc(2026, 10, 13))[0];
    const appleForm = model.formFromOccurrence(APPLE_EVENT, appleOcc, AMS);
    eq([appleForm.summary, appleForm.startTime, appleForm.endTime, appleForm.zoneId, appleForm.alarms, appleForm.customAlarms.length],
       ['Tandarts', '09:30', '10:30', 'Europe/Amsterdam', [-3600], 1], 'the form shows the event in its own terms, and the alarm it cannot edit apart');
    appleForm.summary = 'Tandarts (controle)';
    const edited = model.updateEvent(APPLE_EVENT, appleForm, { occurrence: appleOcc, nowMs: now, viewerZone: AMS });
    const before = new Set(lines(APPLE_EVENT));
    const after = new Set(lines(edited));
    const dropped = [...before].filter(l => !after.has(l) && !/^(SUMMARY|DTSTAMP|LAST-MODIFIED|SEQUENCE)/.test(l));
    eq(dropped, [], 'changing the title keeps every other line: structured location, attendee, both alarms, Apple X- properties, the VTIMEZONE');
    ok(after.has('SUMMARY:Tandarts (controle)') && after.has('SEQUENCE:1') && after.has('DTSTART;TZID=Europe/Amsterdam:20261012T093000'),
       'and writes the new title, a higher SEQUENCE, and leaves the start exactly as it was');

    const windows = cal('BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
        'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
        'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT', 'END:VTIMEZONE',
        'BEGIN:VEVENT', 'UID:outlook-1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Review',
        'DTSTART;TZID="W. Europe Standard Time":20261014T150000', 'DTEND;TZID="W. Europe Standard Time":20261014T160000', 'END:VEVENT');
    const wOcc = range(windows, utc(2026, 10, 14), utc(2026, 10, 15));
    eq(wOcc.map(o => o.startUtc), [utc(2026, 10, 14, 13)], 'an Outlook event in "W. Europe Standard Time" is at 15:00 Amsterdam time');
    const wForm = model.formFromOccurrence(windows, wOcc[0], AMS);
    wForm.location = 'Room 4';
    const wEdited = model.updateEvent(windows, wForm, { occurrence: wOcc[0], nowMs: now, viewerZone: AMS });
    ok(wEdited.includes('DTSTART;TZID="W. Europe Standard Time":20261014T150000') && wEdited.includes('LOCATION:Room 4'),
       'adding a location to it leaves its Outlook time zone notation alone');

    // A repeating event, saved as a whole from a later occurrence.
    const weekly = cal('BEGIN:VEVENT', 'UID:r1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Choir',
        'DTSTART;TZID=Europe/Amsterdam:20261007T200000', 'DTEND;TZID=Europe/Amsterdam:20261007T220000',
        'RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=Europe/Amsterdam:20261021T200000', 'END:VEVENT');
    const third = range(weekly, utc(2026, 10, 28), utc(2026, 10, 29))[0];
    const wf = model.formFromOccurrence(weekly, third, AMS);
    eq([wf.startDate, wf.startTime, wf.repeat && wf.repeat.freq, wf.repeat && wf.repeat.byday], ['2026-10-28', '20:00', 'WEEKLY', ['WE']],
       'the form for the fourth Wednesday shows that Wednesday and the weekly rule');
    wf.startTime = '19:30'; wf.endTime = '21:30';
    const moved = model.updateEvent(weekly, wf, { occurrence: third, scope: 'all', nowMs: now, viewerZone: AMS });
    ok(moved.includes('DTSTART;TZID=Europe/Amsterdam:20261007T193000') && moved.includes('RRULE:FREQ=WEEKLY;BYDAY=WE'),
       'saving all occurrences from a later one moves the series to 19:30 and keeps it starting on 7 October');
    ok(moved.includes('EXDATE;TZID=Europe/Amsterdam:20261021T193000'), 'and its skipped Wednesday moves with it, so it stays skipped');
    eq(range(moved, utc(2026, 10, 1), utc(2026, 11, 5)).map(o => new Date(o.startUtc).toISOString().slice(5, 16)),
       ['10-07T17:30', '10-14T17:30', '10-28T18:30', '11-04T18:30'], 'every remaining Wednesday is at 19:30');

    const single = model.formFromOccurrence(weekly, third, AMS);
    single.summary = 'Choir (concert)'; single.startTime = '19:00'; single.endTime = '22:30';
    const once = model.updateEvent(weekly, single, { occurrence: third, scope: 'one', nowMs: now, viewerZone: AMS });
    const onceList = range(once, utc(2026, 10, 1), utc(2026, 11, 5));
    eq(onceList.map(o => `${new Date(o.startUtc).toISOString().slice(5, 16)} ${o.summary}`),
       ['10-07T18:00 Choir', '10-14T18:00 Choir', '10-28T18:00 Choir (concert)', '11-04T19:00 Choir'],
       'saving only this occurrence changes that Wednesday and no other');
    ok(/RECURRENCE-ID;TZID=Europe\/Amsterdam:20261028T200000/.test(once), 'through an override named by the occurrence it replaces');
    const onceAgain = model.updateEvent(once, { ...model.formFromOccurrence(once, onceList[2], AMS), location: 'Concertgebouw' },
                                        { occurrence: onceList[2], scope: 'one', nowMs: now, viewerZone: AMS });
    eq((onceAgain.match(/RECURRENCE-ID/g) || []).length, 1, 'editing that occurrence again changes the same override, not a second one');

    const removed = model.removeOccurrence(weekly, range(weekly, utc(2026, 10, 14), utc(2026, 10, 15))[0], { nowMs: now, viewerZone: AMS });
    ok(removed.includes('EXDATE;TZID=Europe/Amsterdam:20261014T200000'), 'deleting one occurrence adds an EXDATE written as DTSTART is');
    eq(range(removed, utc(2026, 10, 1), utc(2026, 10, 31)).length, 2, 'and leaves the other Wednesdays in October');
    const overriddenGone = model.removeOccurrence(once, range(once, utc(2026, 10, 28), utc(2026, 10, 29))[0], { nowMs: now, viewerZone: AMS });
    ok(!/RECURRENCE-ID/.test(overriddenGone) && range(overriddenGone, utc(2026, 10, 28), utc(2026, 10, 29)).length === 0,
       'deleting a changed occurrence removes its override and does not bring the original back');
    eq(model.removeOccurrence(APPLE_EVENT, appleOcc, { nowMs: now, viewerZone: AMS }), null,
       'deleting the occurrence of a one-off event is deleting the event');

    const unchanged = model.updateEvent(weekly, model.formFromOccurrence(weekly, third, AMS), { occurrence: third, scope: 'all', nowMs: now, viewerZone: AMS });
    ok(unchanged.includes('RRULE:FREQ=WEEKLY;BYDAY=WE') && unchanged.includes('EXDATE;TZID=Europe/Amsterdam:20261021T200000')
       && unchanged.includes('DTSTART;TZID=Europe/Amsterdam:20261007T200000'), 'saving without changes keeps the rule, its exceptions and the start');
    const daily = model.formFromOccurrence(weekly, third, AMS);
    daily.repeat = { ...daily.repeat, freq: 'DAILY' };
    const toDaily = model.updateEvent(once, daily, { occurrence: third, scope: 'all', nowMs: now, viewerZone: AMS });
    ok(/RRULE:FREQ=DAILY/.test(toDaily) && !/EXDATE/.test(toDaily) && !/RECURRENCE-ID/.test(toDaily),
       'a different repeat drops the old exceptions, which belonged to the old pattern');
    const ending = model.formFromOccurrence(weekly, third, AMS);
    ending.repeat = { ...ending.repeat, ends: 'count', count: 6 };
    const counted = model.updateEvent(once, ending, { occurrence: third, scope: 'all', nowMs: now, viewerZone: AMS });
    ok(/RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=WE/.test(counted) && /RECURRENCE-ID/.test(counted) && /EXDATE/.test(counted),
       'only ending a series (6 times) keeps its exceptions');
    const until = model.formFromOccurrence(weekly, third, AMS);
    until.repeat = { ...until.repeat, ends: 'until', until: '2026-11-25' };
    const untilText = model.updateEvent(weekly, until, { occurrence: third, scope: 'all', nowMs: now, viewerZone: AMS });
    ok(/UNTIL=20261125T225959Z/.test(untilText), 'ending on a date ends at the last second of that day there, written in UTC');
    eq(range(untilText, utc(2026, 11, 1), utc(2027, 1, 1)).map(o => new Date(o.startUtc).toISOString().slice(5, 10)),
       ['11-04', '11-11', '11-18', '11-25'], 'so the occurrence on that day is the last one');

    const custom = cal('BEGIN:VEVENT', 'UID:p1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Payday',
        'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261031', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'END:VEVENT');
    const pf = model.formFromOccurrence(custom, range(custom, utc(2026, 10, 30), utc(2026, 10, 31))[0], AMS);
    eq([pf.repeat, pf.repeatCustom], [null, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'], 'a rule the editor cannot show is kept as a custom rule');
    pf.summary = 'Payday!';
    ok(model.updateEvent(custom, pf, { nowMs: now, viewerZone: AMS }).includes('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),
       'and written back unchanged when the event is edited');

    // Alarms: the one kept is the same component, the one removed is gone, a new one is added.
    const af = model.formFromOccurrence(APPLE_EVENT, appleOcc, AMS);
    af.alarms = [-3600, -86400];
    af.customAlarms = [];
    const alarmed = model.updateEvent(APPLE_EVENT, af, { occurrence: appleOcc, nowMs: now, viewerZone: AMS });
    ok(alarmed.includes('X-WR-ALARMUID:A1') && !alarmed.includes('UID:A2') && /TRIGGER:-P1D/.test(alarmed),
       'reminders: the unchanged one keeps its identity, the removed one goes, the new one is added');
}

// ---- import and export -------------------------------------------------------------------------------------------
{
    const transfer = await import('../../src/js/transfer.js');
    const google = [
        'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'X-WR-CALNAME:Privé',
        'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
        'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
        'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
        'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Amsterdam:20261005T190000', 'DTEND;TZID=Europe/Amsterdam:20261005T200000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Amsterdam:20261012T190000', 'UID:abc123@google.com', 'SUMMARY:Yoga', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Amsterdam:20261020T180000', 'DTEND;TZID=Europe/Amsterdam:20261020T190000',
        'RECURRENCE-ID;TZID=Europe/Amsterdam:20261019T190000', 'UID:abc123@google.com', 'SUMMARY:Yoga (Tuesday)', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261225', 'UID:xmas@google.com', 'SUMMARY:Kerstavond', 'END:VEVENT',
        'BEGIN:VEVENT', 'DTSTART:20261101T100000Z', 'SUMMARY:No uid at all', 'END:VEVENT',
        'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:Buy milk', 'END:VTODO',
        'END:VCALENDAR', ''].join('\r\n');
    const split = transfer.splitCalendarFile(google);
    eq([split.objects.length, split.skipped], [3, 1], 'import: a Google export becomes one object per event; the to-do is counted and left out');
    const yoga = split.objects.find(o => o.uid === 'abc123@google.com');
    ok(yoga && (yoga.text.match(/BEGIN:VEVENT/g) || []).length === 2 && /TZID:Europe\/Amsterdam/.test(yoga.text) && !/America\/New_York/.test(yoga.text),
       'import: a repeating event keeps its changed occurrence, with only the VTIMEZONE it uses');
    eq(range(yoga.text, utc(2026, 10, 1), utc(2026, 10, 31)).map(o => o.summary),
       ['Yoga', 'Yoga (Tuesday)', 'Yoga'], 'import: and reads back with its exception and its moved occurrence');
    ok(split.objects.some(o => /^[0-9a-f-]{36}$/.test(o.uid) && /SUMMARY:No uid at all/.test(o.text)), 'import: an event without a UID gets one');
    const exported = transfer.exportCalendar(split.objects.map(o => o.text), { name: 'Privé' });
    eq([(exported.match(/BEGIN:VEVENT/g) || []).length, (exported.match(/BEGIN:VTIMEZONE/g) || []).length, /X-WR-CALNAME:Privé/.test(exported)],
       [4, 1, true], 'export: every event in one file, each time zone once, under the calendar\'s name');
    eq(transfer.splitCalendarFile(exported).objects.length, 3, 'export then import gives the same three events');
}

finish();
