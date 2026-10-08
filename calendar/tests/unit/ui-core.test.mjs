// What the views, reminders and panels work out before anything is drawn: dates and times in words,
// which days a view shows and where events go on them, the device's index of events, which reminders
// are due, links, and this device's settings.
import { suite } from '../helpers/check.mjs';

const fmt = await import('../../src/js/format.js');
const views = await import('../../src/js/views-core.js');
const { EventIndex, seriesBounds } = await import('../../src/js/event-index.js');
const rem = await import('../../src/js/reminders-core.js');
const links = await import('../../src/js/links-core.js');
const prefs = await import('../../src/js/prefs-core.js');
const occ = await import('../../src/js/occurrences.js');
const tz = await import('../../src/js/tz.js');
const ical = await import('../../src/js/icalendar.js');

const { ok, eq, finish } = suite('ui-core');
const AMS = tz.ianaZone('Europe/Amsterdam');
const NY = tz.ianaZone('America/New_York');
const PARIS = tz.ianaZone('Europe/Paris');
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test', ...body, 'END:VCALENDAR', ''].join('\r\n');
const event = (uid, ...lines) => cal('BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT');
const expand = (text, from, to, zone = AMS) => occ.expandSeries(occ.readSeries(text, { href: `/dav/a/p/${Math.random()}.ics`, calendar: '/dav/a/p/' }), from, to, zone);

// ---- words for dates and times ------------------------------------------------------------------------------
{
    eq([fmt.formatClock(9, 5, '24'), fmt.formatClock(0, 0, '12'), fmt.formatClock(12, 30, '12'), fmt.formatClock(23, 59, '12')],
       ['09:05', '12:00 AM', '12:30 PM', '11:59 PM'], 'clock times in 24-hour and 12-hour form');
    eq([fmt.hourLabel(0, '12'), fmt.hourLabel(13, '12'), fmt.hourLabel(7, '24')], ['12 AM', '1 PM', '07:00'], 'hour lines');
    eq(fmt.dayLong('2026-10-08'), 'Thursday 8 October 2026', 'a long date');
    eq(fmt.dayMedium('2026-10-08'), 'Thu 8 Oct 2026', 'a medium date');
    eq([fmt.rangeTitle('2026-10-05', '2026-10-11'), fmt.rangeTitle('2026-09-28', '2026-10-04'), fmt.rangeTitle('2025-12-29', '2026-01-04')],
       ['5 - 11 October 2026', '28 Sep - 4 Oct 2026', '29 Dec 2025 - 4 Jan 2026'], 'a week in one month, across two, across a new year (a plain hyphen, no long dash)');
    eq([fmt.relativeDay('2026-10-08', '2026-10-08'), fmt.relativeDay('2026-10-09', '2026-10-08'), fmt.relativeDay('2026-10-07', '2026-10-08'), fmt.relativeDay('2026-10-10', '2026-10-08')],
       ['Today', 'Tomorrow', 'Yesterday', null], 'today, tomorrow and yesterday by name');
    eq([fmt.relativeText(15 * MIN), fmt.relativeText(-5 * MIN), fmt.relativeText(30000), fmt.relativeText(2 * HOUR), fmt.relativeText(3 * DAY), fmt.relativeText(MIN)],
       ['in 15 minutes', '5 minutes ago', 'now', 'in 2 hours', 'in 3 days', 'in 1 minute'], 'how far away something is');
    eq([fmt.durationText(45), fmt.durationText(90), fmt.durationText(60), fmt.durationText(1440), fmt.durationText(2880)],
       ['45 minutes', '1 hour 30 minutes', '1 hour', '1 day', '2 days'], 'how long something lasts');
    eq([fmt.localeClock('en-US'), fmt.localeClock('nl-NL'), fmt.localeWeekStart('en-US'), fmt.localeWeekStart('nl-NL')],
       ['12', '24', 0, 1], 'the device\'s clock and first day of the week follow its language and region');

    const meeting = expand(event('m', 'SUMMARY:Call', 'DTSTART;TZID=America/New_York:20261009T090000', 'DTEND;TZID=America/New_York:20261009T100000'), utc(2026, 10, 1), utc(2026, 11, 1))[0];
    const when = fmt.describeWhen(meeting, AMS, '24');
    eq(when.main, 'Friday 9 October 2026, 15:00 - 16:00', 'an event kept in New York, seen in Amsterdam, in Amsterdam time');
    eq(when.zoneNote, 'Fri 9 Oct, 09:00 - 10:00 in America/New York', 'with its own time where it is kept');
    const paris = expand(event('p', 'SUMMARY:Paris', 'DTSTART;TZID=Europe/Paris:20261009T090000', 'DTEND;TZID=Europe/Paris:20261009T100000'), utc(2026, 10, 1), utc(2026, 11, 1))[0];
    eq(fmt.describeWhen(paris, AMS, '24').zoneNote, '', 'no note for a zone at the same offset');
    const trip = expand(event('t', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261016', 'DTEND;VALUE=DATE:20261019'), utc(2026, 10, 1), utc(2026, 11, 1))[0];
    eq(fmt.describeWhen(trip, AMS).main, 'Fri 16 Oct 2026 - Sun 18 Oct 2026', 'an all-day trip names its first and last day (DTEND is the day after)');
    const night = expand(event('n', 'SUMMARY:Night train', 'DTSTART;TZID=Europe/Amsterdam:20261022T220000', 'DTEND;TZID=Europe/Amsterdam:20261023T063000'), utc(2026, 10, 1), utc(2026, 11, 1))[0];
    eq(fmt.describeWhen(night, AMS, '24').main, 'Thu 22 Oct 2026, 22:00 - Fri 23 Oct 2026, 06:30', 'an overnight event names both days');
    const d1 = views.dayBounds('2026-10-22', AMS);
    const d2 = views.dayBounds('2026-10-23', AMS);
    eq([fmt.timeOnDay(night, '2026-10-22', d1.start, d1.end, AMS, '24'), fmt.timeOnDay(night, '2026-10-23', d2.start, d2.end, AMS, '24')],
       ['from 22:00', 'until 06:30'], 'in a list it is "from" on the first day and "until" on the second');
    const t2 = views.dayBounds('2026-10-17', AMS);
    eq(fmt.timeOnDay(trip, '2026-10-17', t2.start, t2.end, AMS), 'All day, 2 of 3', 'a three-day event on its second day');
}

// ---- which days a view shows -----------------------------------------------------------------------------------
{
    const oct = views.viewRange('month', '2026-10-08', { weekStart: 1 });
    eq([oct.days.length, oct.from, oct.days[oct.days.length - 1], oct.to, oct.title], [35, '2026-09-28', '2026-11-01', '2026-11-02', 'October 2026'],
       'October 2026 from Monday: five weeks, from 28 September to 1 November');
    const octSun = views.viewRange('month', '2026-10-08', { weekStart: 0 });
    eq([octSun.from, octSun.days[octSun.days.length - 1]], ['2026-09-27', '2026-10-31'], 'from Sunday: 27 September to 31 October');
    eq(views.viewRange('month', '2026-08-15', { weekStart: 1 }).days.length, 42, 'August 2026 (starting on a Saturday) needs six weeks');
    eq(views.viewRange('month', '2027-02-10', { weekStart: 1 }).days.length, 28, 'February 2027 (starting on a Monday) fills exactly four weeks');
    const week = views.viewRange('week', '2026-10-08', { weekStart: 1 });
    eq([week.from, week.days.length, week.title], ['2026-10-05', 7, '5 - 11 October 2026'], 'a week from its Monday');
    const phone = views.viewRange('week', '2026-10-08', { weekStart: 1, narrow: true });
    eq([phone.from, phone.days.length, phone.title], ['2026-10-08', 3, '8 - 10 October 2026'], 'on a phone, three days from the chosen one');
    eq(views.viewRange('day', '2026-10-08').title, 'Thursday 8 October 2026', 'a day');
    eq(views.viewRange('list', '2026-10-08', { listDays: 30 }).days.length, 30, 'a list of thirty days');
    eq([views.stepFocus('month', '2026-01-31', 1), views.stepFocus('week', '2026-10-08', -1), views.stepFocus('week', '2026-10-08', 1, { narrow: true }),
        views.stepFocus('day', '2026-12-31', 1), views.stepFocus('list', '2026-10-08', 1, { listDays: 30 })],
       ['2026-02-28', '2026-10-01', '2026-10-11', '2027-01-01', '2026-11-07'], 'stepping: a month (31 January to 28 February), a week, three days, a day, a list');
}

// ---- where events go ---------------------------------------------------------------------------------------------
{
    const texts = [
        event('a', 'SUMMARY:A', 'DTSTART;TZID=Europe/Amsterdam:20261008T090000', 'DTEND;TZID=Europe/Amsterdam:20261008T103000'),
        event('b', 'SUMMARY:B', 'DTSTART;TZID=Europe/Amsterdam:20261008T100000', 'DTEND;TZID=Europe/Amsterdam:20261008T110000'),
        event('c', 'SUMMARY:C', 'DTSTART;TZID=Europe/Amsterdam:20261008T120000', 'DTEND;TZID=Europe/Amsterdam:20261008T130000'),
        event('d', 'SUMMARY:Overnight', 'DTSTART;TZID=Europe/Amsterdam:20261008T220000', 'DTEND;TZID=Europe/Amsterdam:20261009T063000'),
        event('e', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261008', 'DTEND;VALUE=DATE:20261011'),
        event('f', 'SUMMARY:Midnight', 'DTSTART;TZID=Europe/Amsterdam:20261010T000000', 'DTEND;TZID=Europe/Amsterdam:20261010T000000')
    ];
    const all = texts.flatMap(t => expand(t, utc(2026, 10, 1), utc(2026, 11, 1)));
    const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const byDay = views.occurrencesByDay(all, days, AMS);
    eq(days.map(d => byDay.get(d).map(o => o.summary)),
       [['Trip', 'A', 'B', 'C', 'Overnight'], ['Trip', 'Overnight'], ['Trip', 'Midnight'], []],
       'each day lists the all-day events first, then by start; a three-day event on its three dates (not the day after), an overnight one on both days, an instant at midnight on its own day');
    const layout = views.layoutDay(all, '2026-10-08', AMS);
    const pos = Object.fromEntries(layout.map(i => [i.occ.summary, [i.top, i.bottom, i.col, i.cols]]));
    eq(pos, { A: [540, 630, 0, 2], B: [600, 660, 1, 2], C: [720, 780, 0, 1], Overnight: [1320, 1440, 0, 1] },
       'two overlapping events side by side, the rest full width, an overnight event to the bottom of its first day');
    const next = views.layoutDay(all, '2026-10-09', AMS);
    eq(next.map(i => [i.occ.summary, i.top, i.bottom, i.startsBefore]), [['Overnight', 0, 390, true]], 'and from the top on the next day');

    const fallBack = expand(event('g', 'SUMMARY:Night shift', 'DTSTART;TZID=Europe/Amsterdam:20261025T013000', 'DTEND;TZID=Europe/Amsterdam:20261025T033000'), utc(2026, 10, 1), utc(2026, 11, 1));
    eq(views.layoutDay(fallBack, '2026-10-25', AMS).map(i => [i.top, i.bottom]), [[90, 210]],
       'on the night the clocks go back, an event sits by its clock times (01:30 to 03:30)');
    const shift = expand(event('w', 'SUMMARY:Weekend shift', 'DTSTART;TZID=Europe/Amsterdam:20261017T220000', 'DTEND;TZID=Europe/Amsterdam:20261018T060000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
        utc(2026, 10, 1), utc(2026, 11, 30));
    eq(shift.map(o => (o.endUtc - o.startUtc) / HOUR), [8, 9, 8], 'a weekly night shift until 06:00 ends at 06:00 also the night the clocks go back (nine hours that night)');
    eq([views.minuteAt(0), views.minuteAt(0.5), views.minuteAt(0.99), views.minuteAt(1.5)], [0, 720, 1410, 1410], 'a tap in a day column rounds down to the half hour');
    eq(views.nowMinutes('2026-10-08', utc(2026, 10, 8, 12, 15), AMS), 14 * 60 + 15, 'the now line at 14:15 in Amsterdam (12:15 UTC)');
    eq(views.nowMinutes('2026-10-09', utc(2026, 10, 8, 12, 15), AMS), null, 'and not on another day');

    const lunch = { summary: 'Lunch with Sam', location: 'Café de Jaren, Amsterdam', description: '' };
    ok(views.matchesSearch(lunch, 'cafe jaren') && views.matchesSearch(lunch, 'SAM lunch') && !views.matchesSearch(lunch, 'sam dinner'),
       'search: every word must be there, in any order, ignoring case and accents');
    const chips = views.chipsFor([1, 2, 3, 4, 5], 3);
    eq([chips.shown, chips.more], [[1, 2], 3], 'a full month cell shows two and "+3 more" rather than three and "+2"');
}

// ---- the index of this device's events -----------------------------------------------------------------------------
{
    const single = occ.readSeries(event('s', 'DTSTART;TZID=Europe/Amsterdam:20200105T100000', 'DTEND;TZID=Europe/Amsterdam:20200105T110000'));
    const b = seriesBounds(single, AMS);
    ok(b.min <= utc(2020, 1, 5, 9) && b.max >= utc(2020, 1, 5, 10) && b.max < utc(2020, 1, 10), 'a single event spans its own time (and a margin)');
    eq(seriesBounds(occ.readSeries(event('r', 'DTSTART:20200105T100000Z', 'RRULE:FREQ=DAILY')), AMS).max, Infinity, 'a rule without end is open-ended');
    eq(seriesBounds(occ.readSeries(event('r', 'DTSTART:20200105T100000Z', 'RRULE:FREQ=DAILY;COUNT=3')), AMS).max, Infinity, 'one with COUNT too (it stops by itself)');
    const until = seriesBounds(occ.readSeries(event('u', 'DTSTART:20200105T100000Z', 'DTEND:20200105T110000Z', 'RRULE:FREQ=DAILY;UNTIL=20200301T000000Z')), AMS);
    ok(until.max >= utc(2020, 3, 1) && until.max < utc(2020, 3, 10), 'one with UNTIL ends there');
    const rdate = seriesBounds(occ.readSeries(event('x', 'DTSTART:20200105T100000Z', 'RDATE:20250105T100000Z')), AMS);
    ok(rdate.max >= utc(2025, 1, 5, 10), 'an extra date (RDATE) widens the span');

    const index = new EventIndex();
    const rec = (href, calendar, data) => ({ href, calendar, etag: '"1"', data, pending: false });
    index.replaceAll([
        rec('/dav/a/p/1.ics', '/dav/a/p/', event('one', 'SUMMARY:One', 'DTSTART;TZID=Europe/Amsterdam:20261008T090000', 'DTEND;TZID=Europe/Amsterdam:20261008T100000')),
        rec('/dav/a/w/2.ics', '/dav/a/w/', event('two', 'SUMMARY:Two', 'DTSTART;TZID=Europe/Amsterdam:20261008T110000', 'DTEND;TZID=Europe/Amsterdam:20261008T120000')),
        rec('/dav/a/p/3.ics', '/dav/a/p/', 'this is not a calendar'),
        rec('/dav/a/p/4.ics', '/dav/a/p/', event('old', 'SUMMARY:Long ago', 'DTSTART:20100105T100000Z', 'DTEND:20100105T110000Z'))
    ]);
    const window = [utc(2026, 10, 1), utc(2026, 11, 1)];
    eq(index.occurrences(...window, AMS).map(o => o.summary), ['One', 'Two'], 'occurrences of every calendar, in order; an object that cannot be read is left out without breaking the rest');
    eq(index.occurrences(...window, AMS, new Set(['/dav/a/w/'])).map(o => o.summary), ['Two'], 'or of the calendars shown');
    ok(index.occurrences(...window, AMS) === index.occurrences(...window, AMS), 'asking twice for the same window answers from memory');
    const entry = index.entries.get('/dav/a/p/1.ics');
    const parsed = entry.series;
    index.put({ ...index.get('/dav/a/p/1.ics'), etag: '"2"', pending: true });
    ok(index.entries.get('/dav/a/p/1.ics').series === parsed, 'an object whose text did not change keeps what was worked out from it');
    ok(index.entries.get('/dav/a/p/4.ics').bounds.max < window[0], 'an event far outside the window is passed over by its span, not expanded');
    eq([...index.uidsIn('/dav/a/p/').keys()].sort(), ['old', 'one'], 'the UIDs of a calendar, for imports');
    index.remove('/dav/a/w/2.ics');
    eq(index.occurrences(...window, AMS).map(o => o.summary), ['One'], 'a removed object is gone from the next answer');
}

// ---- reminders ------------------------------------------------------------------------------------------------------
{
    const text = event('r', 'SUMMARY:Dentist', 'LOCATION:Damrak 1', 'DTSTART;TZID=Europe/Amsterdam:20261008T090000', 'DTEND;TZID=Europe/Amsterdam:20261008T093000',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-P1D', 'END:VALARM');
    const list = expand(text, utc(2026, 10, 1), utc(2026, 11, 1));
    const alarms = rem.alarmsIn(list, utc(2026, 10, 1), utc(2026, 11, 1));
    eq(alarms.map(a => new Date(a.at).toISOString().slice(0, 16)), ['2026-10-07T07:00', '2026-10-08T06:45'],
       'a day before and 15 minutes before 09:00 Amsterdam (07:00 UTC)');
    ok(alarms.every(a => a.id.includes('@')), 'each alarm id names its time, so a moved event reminds again');
    const at = alarms[1].at;

    let r = rem.dueReminders(alarms, { now: at + 5 * MIN, lastCheck: null, shown: {} });
    eq(r.due.map(a => a.at), [at], 'opened five minutes after a reminder went off: it is shown (missed while closed)');
    r = rem.dueReminders(alarms, { now: at + 6 * MIN, lastCheck: r.lastCheck, shown: r.shown });
    eq(r.due.length, 0, 'and only once');
    eq(rem.dueReminders(alarms, { now: at + 20 * MIN, lastCheck: null, shown: {} }).due.length, 0, 'not when the app was opened twenty minutes later');
    eq(rem.dueReminders(alarms, { now: at + 2 * MIN, lastCheck: at + 9 * HOUR, shown: {} }).due.length, 1, 'a last look "in the future" (the clock was set back) is not trusted');
    eq(rem.dueReminders(alarms, { now: at, lastCheck: at - 30000, shown: {} }).due.map(a => a.at), [at], 'shown at the moment it goes off');
    const pruned = rem.dueReminders([], { now: at + 4 * DAY, lastCheck: at, shown: { old: at, fresh: at + 3.5 * DAY } }).shown;
    eq(Object.keys(pruned), ['fresh'], 'what was shown is forgotten after three days');
    eq(rem.nextAlarmAt(alarms, alarms[0].at + 1), at, 'the next alarm to wait for');

    const acked = event('k', 'SUMMARY:Acked', 'DTSTART;TZID=Europe/Amsterdam:20261008T090000', 'DTEND;TZID=Europe/Amsterdam:20261008T093000',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'ACKNOWLEDGED:20261008T064700Z', 'END:VALARM');
    eq(rem.alarmsIn(expand(acked, utc(2026, 10, 1), utc(2026, 11, 1)), utc(2026, 10, 1), utc(2026, 11, 1)).length, 0,
       'an alarm dismissed on another device (ACKNOWLEDGED) is not shown here');

    const words = rem.reminderText(alarms[1], at, AMS, '24');
    eq(words, { title: 'Dentist', body: 'Starts in 15 minutes (09:00), Damrak 1' }, 'a reminder says what, when and where');
    ok(/missed/.test(rem.reminderText(alarms[1], at + 5 * MIN, AMS, '24').body), 'and that it was missed, when it was');
}

// ---- links ---------------------------------------------------------------------------------------------------------------
{
    eq(links.linkify('Tickets: https://example.org/a?b=1, and www.foo.com. Done'),
       [{ text: 'Tickets: ' }, { text: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1' }, { text: ', and ' },
        { text: 'www.foo.com', href: 'https://www.foo.com/' }, { text: '. Done' }],
       'web addresses in notes become links, without the punctuation after them');
    eq(links.linkify('(see https://en.wikipedia.org/wiki/Foo_(bar))').filter(p => p.href).map(p => p.href),
       ['https://en.wikipedia.org/wiki/Foo_(bar)'], 'a closing parenthesis that belongs to the address stays in it');
    eq([links.linkify('javascript:alert(1) data:text/html,x').filter(p => p.href).length,
        links.safeHttpUrl('javascript:alert(1)'), links.safeHttpUrl('data:text/html,<b>x</b>'), links.safeHttpUrl(' https://a.example/x ')],
       [0, null, null, 'https://a.example/x'], 'nothing but http and https becomes a link (an event\'s URL or place included)');
    const maps = links.mapLinks('Damrak 1, Amsterdam');
    eq(maps.map(m => m.label), ['Google Maps', 'Apple Maps', 'OpenStreetMap'], 'a place opens in Google Maps, Apple Maps or OpenStreetMap');
    ok(maps[0].href.endsWith('query=Damrak%201%2C%20Amsterdam'), 'by its text');
    const apple = ical.parseCalendar(event('g', 'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Café de Jaren:geo:52.36766,4.89536')).components[0];
    eq(links.geoOf(apple), { lat: 52.36766, lon: 4.89536 }, 'the coordinates of an iPhone\'s place');
    eq(links.appleLocationTitle(apple), 'Café de Jaren', 'and its name');
    ok(links.mapLinks('Café de Jaren', links.geoOf(apple))[2].href.includes('mlat=52.36766'), 'maps then open on the coordinates');
    const geo = ical.parseCalendar(event('h', 'GEO:37.386013;-122.082932')).components[0];
    eq(links.geoOf(geo), { lat: 37.386013, lon: -122.082932 }, 'GEO coordinates');
    eq(links.mapLinks('https://meet.example.org/abc').length, 0, 'an online meeting address is a link, not a place');
}

// ---- this device's settings ------------------------------------------------------------------------------------------
{
    eq(prefs.normalizePrefs({ view: 'year', weekStart: 3, durationMinutes: 61, hidden: 'x', notify: 'yes', alarmSeconds: 'soon', listDays: 2 }),
       { ...prefs.PREF_DEFAULTS, hidden: [] }, 'settings that make no sense fall back to the defaults');
    const chosen = prefs.normalizePrefs({ view: 'week', weekStart: 0, clock: '12', durationMinutes: 30, alarmSeconds: 'none', allDayAlarmSeconds: -54000, hidden: ['/a/'], notify: true });
    eq([chosen.view, chosen.weekStart, chosen.clock, chosen.durationMinutes, chosen.alarmSeconds, chosen.allDayAlarmSeconds, chosen.hidden, chosen.notify],
       ['week', 0, '12', 30, null, -54000, ['/a/'], true], 'and sensible ones are kept, "no reminder" included');
    const calendars = [{ href: '/r/', readOnly: true }, { href: '/p/' }, { href: '/w/' }, { href: '/t/', components: ['VTODO'] }];
    eq(prefs.pickDefaultCalendar(calendars, { defaultCalendar: '/w/' }).href, '/w/', 'new events go to the chosen calendar');
    eq(prefs.pickDefaultCalendar(calendars, { defaultCalendar: '/gone/' }).href, '/p/', 'or the first that can take events when it is gone');
    eq(prefs.pickDefaultCalendar(calendars, { defaultCalendar: '/r/' }).href, '/p/', 'never a read-only one');
}

finish();
