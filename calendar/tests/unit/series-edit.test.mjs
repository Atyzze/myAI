// Cutting a repeating event in two ("this and following"): the part before keeps the past, the new
// event carries on from the chosen occurrence, and together they are what the series was.
import { suite } from '../helpers/check.mjs';

const ical = await import('../../src/js/icalendar.js');
const tz = await import('../../src/js/tz.js');
const occ = await import('../../src/js/occurrences.js');
const model = await import('../../src/js/event-model.js');

const { ok, eq, finish } = suite('series-edit');
const AMS = tz.ianaZone('Europe/Amsterdam');
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test', ...body, 'END:VCALENDAR', ''].join('\r\n');
const series = (text, href = '/dav/u/cal/x.ics') => occ.readSeries(text, { href, calendar: '/dav/u/cal/' });
const expand = (text, from, to) => occ.expandSeries(series(text), from, to, AMS);
const iso = list => list.map(o => (o.allDay ? o.startDate : new Date(o.startUtc).toISOString().slice(0, 16)));
// The lines of one property of the series itself (not of its time zones or changed occurrences).
const prop = (text, name) => ical.getProps(occ.readSeries(text).master, name).map(p => ical.formatContentLine(p));
const NOW = utc(2026, 10, 8, 12);

// ---- a weekly meeting with COUNT, cut at its 4th time ----------------------------------------------------------
{
    const weekly = cal('BEGIN:VEVENT', 'UID:standup', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:2', 'SUMMARY:Standup',
        'DTSTART;TZID=Europe/Amsterdam:20261005T090000', 'DTEND;TZID=Europe/Amsterdam:20261005T091500',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'X-CUSTOM:kept', 'ATTENDEE;CN=Anna:mailto:anna@example.org',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT');
    const all = expand(weekly, utc(2026, 9, 1), utc(2027, 3, 1));
    eq(all.length, 10, 'the series has its 10 occurrences');
    const fourth = all[3];
    eq(iso([fourth]), ['2026-10-26T08:00'], 'the 4th is Monday 26 October, 09:00 in Amsterdam (after summer time ended)');

    const cut = model.endSeriesBefore(weekly, fourth, { nowMs: NOW, viewerZone: AMS });
    ok(cut.text, 'the part before the cut remains');
    eq(prop(cut.text, 'RRULE'), ['RRULE:FREQ=WEEKLY;UNTIL=20261026T075959Z;BYDAY=MO'],
       'it ends one second before the 4th (UNTIL in UTC, as RFC 5545 asks with a TZID start), COUNT gone');
    eq(iso(expand(cut.text, utc(2026, 9, 1), utc(2027, 3, 1))), ['2026-10-05T07:00', '2026-10-12T07:00', '2026-10-19T07:00'],
       'and keeps the first three');
    eq(prop(cut.text, 'SEQUENCE'), ['SEQUENCE:3'], 'its SEQUENCE goes up, so other apps take the change');

    const form = model.formFromOccurrence(weekly, fourth, AMS);
    const rest = model.startSeriesFrom(weekly, fourth, form, { uid: 'standup-2', nowMs: NOW, viewerZone: AMS });
    eq(prop(rest.text, 'UID'), ['UID:standup-2'], 'the rest is a new event with its own UID');
    eq(prop(rest.text, 'DTSTART'), ['DTSTART;TZID=Europe/Amsterdam:20261026T090000'], 'starting at the 4th occurrence');
    eq(prop(rest.text, 'RRULE'), ['RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=MO'], 'with what is left of COUNT (10 - 3 = 7)');
    ok(prop(rest.text, 'X-CUSTOM').length === 1 && prop(rest.text, 'ATTENDEE').length === 1 && /TRIGGER:-PT10M/.test(rest.text),
       'what the series carried (its own properties, attendees, alarm) comes along');
    const together = [...expand(cut.text, utc(2026, 9, 1), utc(2027, 3, 1)), ...expand(rest.text, utc(2026, 9, 1), utc(2027, 3, 1))];
    eq(iso(together), iso(all), 'together the two give exactly the occurrences the series had');

    const later = { ...form, startTime: '10:00', endTime: '10:30' };
    const moved = model.startSeriesFrom(weekly, fourth, later, { uid: 'standup-3', nowMs: NOW, viewerZone: AMS });
    eq(iso(expand(moved.text, utc(2026, 9, 1), utc(2027, 3, 1))).slice(0, 3), ['2026-10-26T09:00', '2026-11-02T09:00', '2026-11-09T09:00'],
       'changing the time from the 4th on moves the rest to 10:00 and leaves the first three at 09:00');
    eq(expand(moved.text, utc(2026, 9, 1), utc(2027, 3, 1)).length, 7, 'still 7 of them');

    const first = model.endSeriesBefore(weekly, all[0], { nowMs: NOW, viewerZone: AMS });
    eq(first.text, null, 'cut at the first occurrence, nothing is left before it');
}

// ---- an all-day series with exceptions on both sides of the cut ---------------------------------------------------
{
    const daily = cal('BEGIN:VEVENT', 'UID:water', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Water the plants',
        'DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002', 'RRULE:FREQ=DAILY;UNTIL=20261020',
        'EXDATE;VALUE=DATE:20261003,20261012', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:water', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Water the plants (early)',
        'RECURRENCE-ID;VALUE=DATE:20261004', 'DTSTART;VALUE=DATE:20261004', 'DTEND;VALUE=DATE:20261005', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:water', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Water the plants (big ones)',
        'RECURRENCE-ID;VALUE=DATE:20261015', 'DTSTART;VALUE=DATE:20261015', 'DTEND;VALUE=DATE:20261016', 'END:VEVENT');
    const all = expand(daily, utc(2026, 9, 20), utc(2026, 11, 1));
    eq(all.length, 18, '20 days less two exceptions');
    const at = all.find(o => o.startDate === '2026-10-10');
    const cut = model.endSeriesBefore(daily, at, { nowMs: NOW, viewerZone: AMS });
    eq(prop(cut.text, 'RRULE'), ['RRULE:FREQ=DAILY;UNTIL=20261009'], 'an all-day series ends on the day before, as a date');
    eq(prop(cut.text, 'EXDATE'), ['EXDATE;VALUE=DATE:20261003'], 'its exceptions after the cut go');
    eq(cut.droppedOverrides, 1, 'and so does the single changed occurrence after it (counted)');
    ok(/early/.test(cut.text) && !/big ones/.test(cut.text), 'the one before the cut stays');

    const form = model.formFromOccurrence(daily, at, AMS);
    const rest = model.startSeriesFrom(daily, at, form, { uid: 'water-2', nowMs: NOW, viewerZone: AMS });
    eq(prop(rest.text, 'DTSTART'), ['DTSTART;VALUE=DATE:20261010'], 'the rest starts on the chosen day');
    eq(prop(rest.text, 'EXDATE'), ['EXDATE;VALUE=DATE:20261012'], 'and takes along the exceptions after it');
    ok(/big ones/.test(rest.text) && !/early/.test(rest.text) && !/UID:water\r\n/.test(rest.text),
       'and the changed occurrence after it, under the new UID');
    const together = [...expand(cut.text, utc(2026, 9, 20), utc(2026, 11, 1)), ...expand(rest.text, utc(2026, 9, 20), utc(2026, 11, 1))];
    eq(iso(together), iso(all), 'together they are the series as it was, exceptions and all');
    eq(together.map(o => o.summary), all.map(o => o.summary), 'with the same titles on the same days');
}

// ---- a repeat written in a way the editor cannot show, with COUNT --------------------------------------------------
{
    const custom = cal('BEGIN:VEVENT', 'UID:c1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Board',
        'DTSTART:20260105T150000Z', 'DTEND:20260105T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1;COUNT=6', 'END:VEVENT');
    const all = expand(custom, utc(2025, 12, 1), utc(2027, 1, 1));
    eq(all.length, 6, 'six first-Monday-or-Tuesdays');
    const form = model.formFromOccurrence(custom, all[2], AMS);
    ok(form.repeat === null && /BYSETPOS/.test(form.repeatCustom), 'the editor keeps the rule as it is');
    const rest = model.startSeriesFrom(custom, all[2], form, { uid: 'c2', nowMs: NOW, viewerZone: AMS });
    eq(prop(rest.text, 'RRULE'), ['RRULE:FREQ=MONTHLY;COUNT=4;BYDAY=MO,TU;BYSETPOS=1'], 'its COUNT counts on (6 - 2 = 4)');
    const cut = model.endSeriesBefore(custom, all[2], { nowMs: NOW, viewerZone: AMS });
    eq(iso([...expand(cut.text, utc(2025, 12, 1), utc(2027, 1, 1)), ...expand(rest.text, utc(2025, 12, 1), utc(2027, 1, 1))]), iso(all),
       'a UTC series cut in two still has its six occurrences');
}

// ---- the same repeat written differently keeps the exceptions -----------------------------------------------------
{
    const plain = cal('BEGIN:VEVENT', 'UID:p1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Gym',
        'DTSTART;TZID=Europe/Amsterdam:20261005T190000', 'DTEND;TZID=Europe/Amsterdam:20261005T200000',
        'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Amsterdam:20261019T190000', 'END:VEVENT');
    const form = model.formFromOccurrence(plain, null, AMS);
    const saved = model.updateEvent(plain, { ...form, repeat: { ...form.repeat, ends: 'count', count: 8 } }, { nowMs: NOW, viewerZone: AMS });
    eq(prop(saved, 'RRULE'), ['RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO'], 'adding an end writes the rule with its weekday');
    eq(prop(saved, 'EXDATE').length, 1, 'and the skipped week stays skipped: FREQ=WEEKLY and FREQ=WEEKLY;BYDAY=MO repeat the same way');
}

finish();
