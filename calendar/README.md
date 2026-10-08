# myAI Calendar

Your own calendar, on your own box, the same on your phone, laptop and desktop. The box keeps it
(a CalDAV server, Radicale, with every event a plain `.ics` file in `input/calendar/`); this app
shows and edits it on every device, keeps a copy so it opens at once and works offline, and sends
what you change as soon as it can. Your phone's own calendar app connects to the same box, so its
reminders go off on time even with this app closed or the phone offline.

Its parts in this repository:

```
calendar/             the app (static files: index.html, sw.js, src/js, assets). Build 1.
box/myai_calendar.py  the accounts tool (myai-calendar on a box)
nix/calendar.nix      Radicale, nginx at /dav/ and /calendar/, storage, accounts from the boot stick
```

## On a box

Nothing to install: the box serves the app at `https://<box>/calendar/` and the calendar server
at `https://<box>/dav/`. Make an account for each person:

```bash
sudo myai-calendar add anna            # asks for a password twice
sudo myai-calendar users               # who has an account
sudo myai-calendar passwd anna         # a new password
```

or, before the first boot, put `calendar-users.txt` (lines of `name password`) in the `myai`
folder on the stick's boot partition; the accounts are made at boot and the file is removed.
Each account starts with one calendar, "Personal". Details: [docs/SERVER.md](docs/SERVER.md).

Then open `https://<box>/calendar/` on each device and sign in. On a phone, also add the calendar to
the phone's own calendar app (Settings → Connect your phone in the app; [docs/PHONES.md](docs/PHONES.md)):
that is what makes reminders reliable.

## Anywhere else

A release is one zip of exactly the files a web server serves. Unzip it into a new folder:

```bash
unzip myAI-calendar1.zip -d /var/www/html/calendar/
```

The app talks only to its own site, at `/dav/` by default (the sign-in screen's Server field takes
another path on the same site), so the web server must also pass a CalDAV server on at that path.
[docs/SERVER.md](docs/SERVER.md) has an nginx example for Radicale.

## What it does

- Month, week (three days on a phone), day and list views; search across two years.
- Timed and all-day events, over several days, in any time zone (a 09:00 meeting stays at 09:00
  across daylight saving changes).
- Repeating events: every day, week (on chosen weekdays), month (on a date or "the second
  Tuesday"), year, every N of those, until a date or a number of times. Changing or deleting one
  occurrence, this and the following ones, or all of them. Rules made by other apps that the editor
  cannot show are kept as they are.
- Several reminders per event, also custom ones; shown in the app while it is open (and as
  notifications when switched on), rung by the phone's own calendar app always.
- A place that opens in Google Maps, Apple Maps or OpenStreetMap (by coordinates when the event has
  them, as an iPhone's saved places do); notes with clickable links.
- Calendars with colors, shown or hidden per device; new calendars, renamed, removed.
- Import an `.ics` export from Google, Apple or Outlook (importing it again updates instead of
  doubling); export any calendar as one `.ics` file.
- Works offline: changes wait on the device and go when the box is reachable; two devices that
  changed the same event offline are settled by the later change, and the other is listed in
  Settings → Recent sync problems. An event changed on one device and deleted on another is kept.
- If many events disappear from the box at once (removed elsewhere, or lost on the box), each
  device keeps a copy and offers to put them back.
- Updates like the voice app: a new build downloads in the background and is offered under ❓,
  taken when tapped.

## Data and privacy

The calendar is on the box. A device holds a copy (IndexedDB) and its changes not yet sent; a
browser clearing its storage loses nothing but those unsent changes, and the app asks the browser
to keep its data. Every event is a plain `.ics` file on the box, so the box's backups carry the
calendars like everything else. Each account sees only its own calendars. More:
[docs/PRIVACY.md](docs/PRIVACY.md), how it works inside: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Develop

```bash
npm run serve                  # the app at http://127.0.0.1:8090/calendar/ with a real Radicale
                               # (MYAI_RADICALE_PYTHON=<a python with radicale>); alice / alice-secret-1
npm run test:unit              # no outside tools needed
npm test                       # the full gate: also Radicale, Chromium and the mutation guards
npm run release                # the next build as a verified zip (docs/RELEASING.md)
```

The app has no dependencies and no build step: what is in `src/js/` is what the browser runs.
