# Privacy and data

## Where the calendar is

- **On the box**: every event, as a plain `.ics` file under `input/calendar/`, readable only by the
  calendar server and the backup. Account passwords as SHA-512 crypt hashes, never as text.
- **On each device that signed in**: a copy of that account's calendars (IndexedDB), the changes
  not yet sent, the saved sign-in (the name and password, as the Authorization header the app
  sends), and this device's settings. Signing out removes all of it from the device; the calendar
  stays on the box.
- **Nowhere else.** The app talks only to the site it was opened from (its Content-Security-Policy
  allows nothing else); map links open the map site only when tapped.

## Who sees what

Each account sees only its own calendars (Radicale's `owner_only` rights): another account's
requests get `403`, which the tests check. The box itself is reached over the tailnet (who may
connect is your tailnet's access control) or the local network.

## What can be lost, and what keeps it

| What | Kept by |
|---|---|
| The calendar on the box | The box's dated backups of `input/`; an `.ics` export by hand; and each device's copy (below). |
| A device's copy | Nothing needs to: it is fetched again from the box. Clearing the browser's data, a private window or uninstalling only costs a download. |
| Changes made offline, not yet sent | The device (IndexedDB, persistent storage requested). They are lost only if the browser's data is cleared before the device is back in reach of the box; the sync line says how many are waiting. |
| Events the box loses | Each device keeps a copy of events that disappear from the box in bulk (a disk replaced without its backup, say), and offers to put them back. |

The browser decides about its storage: `navigator.storage.persist()` asks it not to clear the
copy when space runs low, and Settings → Sync says whether it agreed. Installing the app (Add to
Home Screen) makes that more likely.

## Reminders and notifications

Reminders are shown by the app itself (and by the phone's calendar app). System notifications are
used only when switched on in Settings, and come from the page while it is open; nothing is sent
to a push service.
