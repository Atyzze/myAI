# myAI Calendar Build 1

The calendar: the first part of the suite that keeps data for a person across devices. It is not
kept in a browser, which can clear its storage at any time, but on the box, by a CalDAV server, and
every device (this app on the phone, laptop and desktop, the phone's own calendar app) is a client
of it. The app is static files in the voice app's style: unzipped into a folder, or served by the
box at `/calendar/`.

## What the person sees

- Sign in with the account made on the box (`myai-calendar add NAME`, or `calendar-users.txt` on
  the boot stick). A wrong password says so in plain words; the browser's own login box never pops up.
- Month, week, day and list views. On a phone the month shows dots and the chosen day's events
  below it, and the week shows three days; a sideways swipe goes back and forth. The list searches
  titles, places and notes from a year back to two years ahead, accents and case ignored.
- ＋ New event, or a tap on a time in the week or day view: title, all day, start and end (moving
  the start moves the end), time zone, repeat (every day, week on chosen days, weekdays, month on a
  date or "the second Tuesday", year, every N, until a date or N times), reminders (presets for
  timed and all-day events, or minutes, hours or days before), calendar, place, notes.
- A repeating event changed or deleted asks: only this event, this and the following events, or
  all of them. Deleting can be undone for a few seconds.
- The details: when (with the event's own time when it is kept in another zone), how it repeats,
  the calendar, the place with Google Maps, Apple Maps and OpenStreetMap links (by coordinates when
  the event has them), links in notes, the reminders. Edit, Duplicate, Delete.
- Reminders show in the app while it is open, in every open tab, and as notifications when switched
  on; one missed within 15 minutes is still shown. For reminders with the app closed, Settings →
  Connect your phone explains adding the calendar to the iPhone's or Android's own calendar app.
- Settings: the account; calendars (shown here or not, color, name, new, remove); where new events
  go; their default reminder and length; first day of the week and the clock (both follow the
  device unless chosen); notifications; import and export; sync status and recent sync problems;
  this device's storage.
- The line under ＋ New event says how the sync stands: synced at, syncing, changes waiting, offline
  (the app works on, from this device's copy), or the box no longer accepting the password.
- When many events go from the box at once, a notice says so and the device keeps a copy to put
  back.
- The version under ❓; a new build is offered there and taken on a tap.

## How

The box runs Radicale (3.7.4) on loopback, behind nginx at `/dav/`, with `owner_only` rights and
SHA-512 crypt accounts; each event is a plain `.ics` file in `input/calendar/`, which the box's
backups carry. vobject, which Radicale uses, cuts a non-text value at its first comma, so an
iPhone's saved place (`geo:52.37,4.89`) lost its longitude when the box stored it:
`nix/vobject-keep-values.patch` fixes that (vobject's 49 and Radicale's 375 own tests pass with it).

The app keeps a copy of the account's calendars in IndexedDB and an outbox of its changes; a sync
sends the outbox with ETags, then fetches what changed (sync-collection, multiget). Conflicts: the
later edit wins and the other is noted; an edit beats a delete; a create whose answer was lost is
not sent twice; a change the server refuses is dropped and noted. Expansion of repeats, time
zones and iCalendar writing are the app's own (no libraries), checked against python-dateutil on 450
rules; a series that began years ago costs no more to show than a new one. Editing keeps what other
apps stored in an event. The full account is in `docs/ARCHITECTURE.md`.

The box: `nix/calendar.nix` (Radicale, nginx locations on the LAN and tailnet sites, storage with
ACLs that keep the input group and the drop box out and let the backup in, accounts from the boot
partition, `myai-calendar` on the PATH), the app built and published by the update manager
(`app/calendar`), and the flake check running the calendar's unit tests and its sync tests against
the box's own Radicale build. Checked here: the three box configurations evaluate; the nginx
configuration NixOS generates passes gixy, and run as is in front of Radicale it serves the app,
redirects relatively, passes `/dav/` with its prefix, and keeps accounts apart; the patched vobject
and Radicale build with their test suites. Not checked here: a box booted with it (no VM in this
environment).

## Tests

`core` (100): iCalendar text, zones, recurrence against python-dateutil (450 rules, and 633 late
starting points), occurrences, edits that keep other apps' data. `series-edit` (30): cutting a
series in two, with COUNT, exceptions on both sides, across DST, for UTC and floating events.
`ui-core` (74): view ranges, layouts (overlaps, overnight, the night the clocks go back), words for
dates, the event index, reminders (missed, shown once, dismissed elsewhere), links, settings.
`sync-fake` (27): a server that answers 404 to a PUT on a deleted event, one without sync-collection,
a lost answer, a refused change, copies kept when events vanish. `static` (26): modules, the offline
shell and what the service worker answers, build numbers, the page, the release zip, no long
dashes. `sync-radicale` (40): two devices through a real Radicale. `browser-calendar` (45): the app
in Chromium as a laptop and a phone (sign in, add, change, offline also with the whole site
unreachable, this and following, undo, a reminder, import and export, two tabs, events lost on the
box and put back, sign out). `shell-update` (8): a new build offered, not taken on a reload, taken on
a tap, data kept. `mutation`: 20 guards, each a broken piece of the calendar that the test meant
to catch it has to catch.

9 suites passed (strict gate) in 1 min 28 s; slowest mutation (44 s)
