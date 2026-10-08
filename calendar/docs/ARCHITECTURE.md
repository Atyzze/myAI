# How the calendar works

## The shape of it

```
 phone app ─┐                                  ┌─ input/calendar/collection-root/<name>/<calendar>/<uid>.ics
 laptop app ┼─ https /dav/ ─ nginx ─ Radicale ─┤   one plain iCalendar file per event
 iPhone ────┘   (CalDAV)                       └─ users: stateDir/calendar/users (SHA-512 crypt)

 this app, in each browser:
   IndexedDB  ─ calendars, events (as the server had them), the outbox (changes not yet sent), settings
   sw.js      ─ the app's own files, for opening offline; never the calendar
```

The server is the calendar. Every device is a client of it: the app in a browser, the phone's own
calendar app over CalDAV, Thunderbird, anything. No device holds the only copy of anything except
its own changes that it has not been able to send yet.

## Modules (src/js)

No framework, no build step. The pure modules have no DOM and are tested in Node.

| Module | What it does |
|---|---|
| `wall.js` | Wall-clock dates and times without a zone; adding days never meets a DST change. |
| `tz.js` | Zones: IANA (through Intl), Windows and legacy names mapped, VTIMEZONE read and written. Offsets are worked out per UTC day and remembered. |
| `icalendar.js` | iCalendar text: unfolding, parsing, writing; a property nobody changed is written back byte for byte. |
| `rrule.js` | Recurrence rules expanded in wall time; checked against python-dateutil on 450 rules. A rule without COUNT can start late (`skipBefore`), so a daily event from 2012 costs no more than a new one. |
| `occurrences.js` | From calendar objects to occurrences in a window: masters, overrides, EXDATE, RDATE, alarms. |
| `event-model.js` | The editor's form, and writing it back into the event touching only what the form is about. Cutting a series in two ("this and following"). |
| `transfer.js` | Import (one object per UID, with its VTIMEZONEs) and export. |
| `xml.js`, `caldav.js` | WebDAV/CalDAV over fetch: discovery, sync-collection, multiget, PUT/DELETE with ETags, MKCALENDAR, PROPPATCH. |
| `store.js` | The device's copy in IndexedDB (and in memory, for tests). |
| `sync.js` | The sync engine (below). |
| `event-index.js` | The events kept parsed for the views, each with the span of time it can occur in; windows asked for are remembered until the next change. |
| `views-core.js`, `format.js`, `prefs-core.js`, `reminders-core.js`, `links-core.js` | What the views show, in words; settings; due reminders; map links and links in notes. |
| `app.js`, `ui-*.js`, `dom.js`, `reminders.js`, `update.js` | The page: sign in, views, editor, details, settings, reminders, the version badge. |

## Sync

A change made on the device is written to its copy at once and queued in the outbox. A sync:

1. **Sends the outbox**, each change only on top of the version it was made to: `PUT` with
   `If-Match` (or `If-None-Match: *` for a new event), `DELETE` with `If-Match`.
2. **Lists the calendars** (a calendar gone from the server goes from the device too).
3. **Asks each calendar what changed** since the last sync (`sync-collection` with the stored
   token; a full listing when the token expired or the server has no sync-collection), and fetches
   just that with `calendar-multiget`, 40 at a time. Events with a change still in the outbox are
   left alone until it is sent.

One sync runs at a time in a tab, and one tab syncs at a time (Web Locks); tabs tell each other
what changed (BroadcastChannel). The app syncs on start, a moment after every change, every minute
while visible, every five minutes while hidden, when the connection returns, and on "sync". After
a failure it waits 15 s, then twice as long each time, up to 5 minutes.

### When two changes meet

- **The same event changed on two devices**: the second to arrive gets `412`. The engine fetches
  the server's version and compares its `LAST-MODIFIED` with the time of the local edit: the later
  one wins, on both devices. The one that lost is listed under Settings → Recent sync problems,
  by its title.
- **Changed here, deleted elsewhere**: the change is kept, the event is created again (whether the
  server answers `404` or `412`).
- **Deleted here, changed elsewhere later**: the change is kept.
- **A create whose answer was lost** (the connection dropped after the server stored it): the next
  sync finds the same event there and takes it as sent, without writing it again.
- **A change the server refuses** (bad data, a read-only calendar): dropped, noted, and the
  server's version fetched again. The sync goes on.
- **Many events gone at once** (3 or more from a small calendar, a quarter of a bigger one, 10 in
  any case, or a whole calendar): the device keeps a copy before following the server, and offers
  to put them back. This is the guard against a box that lost data (a disk replaced without its
  backup): without it, every device would faithfully mirror the loss.

## Time

An instant is a UTC millisecond count; what a person sees is a wall-clock time in a zone. Timed
events are expanded in their own zone, so a weekly 09:00 meeting in Amsterdam is at 09:00 both
sides of a DST change, and shows in the viewer's zone (with the event's own time beside it when the
zones differ). An end given as `DTEND` is a clock time for every occurrence (a night shift until
06:00 ends at 06:00 also the night the clocks go back); a `DURATION` counts days on the calendar
and hours exactly, as RFC 5545 says. All-day events are dates, the same wherever the viewer is.
New events are written in the device's zone with a VTIMEZONE (two yearly rules when the zone has
them, checked against the browser for twenty years).

## Editing without losing what other apps stored

Saving writes the form into the event's own iCalendar tree and touches only what the form is about:
title, place, notes, times, the repeat (only when it changed), and the simple alarms. Attendees,
an iPhone's structured location, other apps' X- properties, alarms the editor cannot show: all
stay. Lines nobody changed are written back exactly as they came.

The box's Radicale runs with `nix/vobject-keep-values.patch`: vobject 0.9.9 cuts a property value
that is not text at its first comma, so `geo:52.37,4.89` (an iPhone's saved place) would lose its
longitude the first time the box stored the event. vobject's and Radicale's own test suites pass
with the patch; `tests/integration/sync-radicale.mjs` shows the place surviving a round trip.

## Reminders

Reminders are the events' own alarms (VALARM), the same ones the phone's calendar app rings for.
While the app is open, it looks at the next two weeks every minute (and exactly when the next alarm
is due), shows each due reminder once as a toast in every open tab and, when switched on, as a
system notification. One opened within 15 minutes of a reminder shows it as missed; older ones are
not shown. An alarm dismissed on another device (RFC 9074 `ACKNOWLEDGED`) is not shown again.
With the app closed, the phone's own calendar app does the reminding; reminders from this app while
it is closed (Web Push from the box) are on the roadmap.

## The offline shell and updates

`sw.js` keeps the app's own files under `myai-calendar-shell-v<build>`, fetched all at once so a
shell is complete or not there. It answers the app's page and files only, never `/dav/`. A new build
installs in the background and waits; the version under ❓ offers it (`v1 › v2`), and a tap
switches. Otherwise it takes over the next time the app is started with every tab closed.
