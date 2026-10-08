# Connecting a phone's own calendar app

The myAI calendar app shows reminders while it is open. A phone's own calendar app keeps the alarms
on the phone and rings for them on time, with the app closed, with no connection, and with the box
switched off. So on a phone, use both: this app to look and edit (or the phone's app, as you like),
and the phone's calendar for the reminders. They are the same calendar: what changes in one shows
in the other.

Use the box's https address (the tailnet one, `https://<box>.<tailnet>.ts.net`): it has a real
certificate and works from anywhere. The LAN address works too, after accepting its self-signed
certificate. The name and password are the calendar account's, the same as in the app. The app's
Settings → Connect your phone shows these steps with the exact addresses to copy.

## iPhone and iPad

1. Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add CalDAV Account.
   (Older iOS: Settings → Calendar → Accounts.)
2. Server: the box's address without `https://`, for example `myai.tail1234.ts.net`.
3. User name and password: the calendar account. Description: myAI.
4. If it cannot verify the account: Advanced Settings → Account URL
   `https://<box>/dav/<name>/`.
5. In the Calendar app, under Calendars, tick the myAI ones.

The iPhone's Reminders app can use the "Personal" calendar for to-dos too; this app shows events
only and leaves to-dos alone.

## Android

Android's calendar apps need a small sync app for CalDAV:

1. Install DAVx⁵ (free on F-Droid; also on Google Play).
2. ＋ → Login with URL and user name. Base URL `https://<box>/dav/`, the account's name and password.
3. Create the account, tick the calendars to sync, and let DAVx⁵ run in the background when Android
   asks (otherwise it syncs only now and then).
4. The calendars now show in the phone's calendar app (Google Calendar, Etar, ...), which rings for
   the reminders.

## Computers

- **macOS Calendar**: Settings → Accounts → ＋ → Other CalDAV Account → Manual; server
  `https://<box>`, path `/dav/`.
- **Thunderbird**: New Calendar → On the Network → location `https://<box>/dav/`; it finds the
  calendars by itself.
- **Anything else** that speaks CalDAV: `https://<box>/dav/` and the account.

## What carries over between apps

Everything the iCalendar format holds: times and zones, repeats and their exceptions, alarms,
places (an iPhone's saved place keeps its coordinates on the box), notes, attendees. This app
keeps what it does not show (attendees, other apps' own fields, alarms set up in ways its editor
cannot show) when it saves an event.
