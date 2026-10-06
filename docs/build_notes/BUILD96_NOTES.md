# myAI Build 96

Build 96 makes the version under ❓ tell the truth and makes it the control that updates the app. No storage format or protocol change, and the service worker's caching behaviour is unchanged.

## What was wrong

The badge reported the version of the service worker *controlling* the page, which is not the same thing as the version of the code the page is *running*.

On a reload after a deploy the old worker answers the navigation from its own cache, so the document and every module come from the old build. Meanwhile the new worker installs, calls `skipWaiting()` and then `clients.claim()`, which hands control of the already-loaded page to the new worker. `controllerchange` fires, the badge asks the new controller its version, and writes the new number over the old one. The page is still running the old build. The badge led the code by a reload, which is why the honest way to land on a new build was to reload, wait, and reload again, and why the number changing was not proof of anything.

## What the badge means now

The first version read is remembered as the build that served this document, and later reports never overwrite it. So:

- `v96` on its own always means the page is running v96. That is the guarantee, and it is what removes the second refresh.
- `v96 › v97` means v97 is installed and is now the worker serving this origin, while this page is still v96. Tapping reloads into v97, and after the reload the badge reads `v97` on its own.
- `v96 ⟳` means a check is running or a new build is still downloading. This state is never offered as something to reload into, because reloading mid-install lands on the old build again, which is exactly the trap the old behaviour fell into.
- `v96 ✓` and `v96 ⚠` are the outcome of a check that found nothing newer, or could not reach the server. Both fade back to the plain version after four seconds.

## Tapping it

The version is now a button under ❓.

- With nothing waiting, tapping calls `registration.update()` and reports what came back.
- If a new worker is found, the app waits for it to become the worker actually serving the origin before offering the reload, up to thirty seconds. Until then the button reads `Installing v97...` and does nothing.
- With a build ready, tapping reloads.
- Nothing ever reloads by itself, and a reload is refused outright while a recording is running: the badge says to stop the recording first and tap again. The recording is worth more than the update.

Opening ❓ runs the same check in the background, so the guide overlay is current when it opens. The overlay carries the state in words and the same control as a labelled button, which is easier to hit than a nine-pixel badge, and it has a short Updates section explaining what the two-part version means.

## How this is held

`src/js/update-core.js` holds the rules as pure functions over one state value, and is unit tested on its own. `src/js/version.js` supplies the service-worker facts to it and paints. The browser suite now runs the whole thing for real: it serves a service worker whose version it can change, tells the page to check, asserts the badge reads `<current> › v99991` and not `v99991`, taps again, waits for the reload, and asserts the badge then reads `v99991` alone. That last assertion is the guarantee this build exists for.

`readShellVersion` no longer falls back to an installing or waiting worker when deciding what is running; a worker that has not activated cannot have served this page. It is read separately, as an incoming build.

## Contracts

`UI-VERSION-002` is new: a version shown on its own is the build the page is running, and an update is offered only once reloading would land on it. Suites `pure`, `platform-unit`, `static-integrity`, `browser-lifecycle`; guards `MUT-UPDATE-ADOPTS-NEW-WORKER`, `MUT-UPDATE-INSTALLING-CALLED-READY`, `MUT-UPDATE-RELOADS-MID-RECORDING`, `MUT-UPDATE-BADGE-NOT-TAPPABLE`.

`UI-VERSION-001` keeps its meaning: the version is declared once, in the service worker, and nothing else hardcodes it. `update-core.js` is now held to that rule too.

## Getting onto this build

Build 96 is the first build whose badge behaves this way, so reaching it still takes the old dance once: reload, wait for the number to change, reload again. From 96 onward the badge does it.

Release gate: 16 suites passed (strict gate)
