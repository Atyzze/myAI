# myAI Build 138

A new build is never put in use by itself any more. It is downloaded and offered on the version badge (`v138 › v139`), as before, and only a tap on that badge switches to it. Until Build 137 there was one way around the tap: once every tab of the app had been closed, the browser let the waiting new build take over, and the next start ran it. That is gone. No new dialog was added; the badge and the update button under ❓ are the confirmation, as they were. Database version stays at 13.

## What the person sees

- While the app is open it asks for a newer build every 30 minutes, and when it comes back on screen after longer than that. One that exists is downloaded in the background and offered on the badge. Nothing else changes: the page keeps running its build.
- Tapping the badge, or the update button under ❓, puts the new build in use and reloads, as before. It is refused while a recording or other work is running in the tab, as before.
- Closing every tab and opening the app again starts the build in use, not the new one; the badge still offers the new one. An ordinary reload does the same.
- A hard reload, which makes the browser load the app straight from the server past its installed copy, runs whatever the server has. That build becomes the one in use, so the next ordinary reload does not step back. This is the only way in which the browser itself goes around the installed copy.

## How

- The service worker records the build in use (accepted) in a cache of its own, `myai-accepted`. A worker that takes over without a tap (every tab closed) keeps serving the shell of the accepted build: the page, its modules, and also files the newer build no longer has. The accepted shell is never deleted while it is accepted.
- A tap accepts the offered build. A build that waits is asked to take over (`activate-now`, as before) and is accepted by that. A newer build that already serves, because it took over while every tab was closed, is told it is accepted (`accept`), and the reload that follows lands on it. When both exist the badge offers, and a tap loads, the newer of the two.
- Asked for its version, the worker also says which build it serves the shell of (`accepted`), so a page can tell a hard reload into the serving build from an ordinary load.
- First install: the build installed is accepted. A worker whose accepted shell is gone (cleared site data) accepts itself rather than serving nothing.
- Builds 129 to 137 cannot accept a worker that already serves, only one that waits. A worker replacing one of them that takes over because every tab was closed is therefore accepted, as it would have been before: this happens once, on the way to Build 138, and never again after it.

## Tests

`service-worker`: a first install accepts itself; a newer build that took over keeps serving the accepted shell (page, module, and a file only the older build has) and keeps that shell; it reports both builds; an `accept` puts it in use; a waiting build asked by a tap takes over, is used, and the old shell goes; replacing a build from before acceptance, the new one is used, as before; a missing accepted shell does not leave the app without one. `platform-unit`: a newer serving build is offered without being accepted, a tap accepts it before reloading, a hard reload into the serving build accepts it, an ordinary load accepts nothing, and the half-hourly check asks the browser for a newer build without changing the badge and stops when set up without it. `shell-update` (Chromium, real service worker): with a new build offered, closing the only tab lets the new worker take over, yet the reopened app is still the old build and offers the new one; an ordinary reload does not switch; a tap does, and the new build stays in use. Three mutation guards: a worker accepting itself when it takes over, the accepted shell being deleted, and a tap that does not accept.

22 suites passed; 0 skipped (portable gate) in 10 min 34 s; slowest mutation-guards (5 min 45 s)
