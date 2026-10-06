# myAI Build 98

Build 98 stamps the build into the document itself, so a page can no longer be wrong about which build it is running. No storage format or protocol change.

## Why this was still possible

Build 96 made the badge report the build serving the page rather than the build of whichever worker happened to be in charge. It did that by asking the controlling service worker its version on first read, before any handover, and treating later answers as an update waiting.

That inference is right in every normal case, but it is still an inference, and it cannot be made by code that predates it. A page running build 95 or earlier has the old label, which simply prints whatever the current controller says. On such a page a freshly activated build 96 worker paints `v96` over a page that is still running 95, and the badge is inert: before 96 the version was a `div` with `pointer-events: none`, so tapping it could never do anything. The two symptoms together, a version that will not move and a control that does nothing, are the old behaviour seen from the wrong side of the upgrade.

## The document says what it is

`index.html` now carries `<meta name="myai-build" content="N">`, and `tools/package_release.py` keeps it synchronized with `BUILD_NUMBER` exactly as it already does for `package.json` and the service-worker `VERSION`. `validate_identity` now refuses to package when any of the four disagree.

The badge reads that stamp synchronously on first paint. It is not a guess about which worker answered: it is the build of the HTML currently in the document, and the service worker serves that HTML from its own cache, so it cannot be anything else.

Consequences:

- The badge is correct on the very first paint, with no round trip to a worker, and no moment of `dev` before the answer arrives.
- A page served with no service worker at all, over plain HTTP in development or in a browser that declines to register one, now reports its real build instead of `dev`.
- A worker newer than the document is recognised as an update on the first paint, without waiting for a `controllerchange` that may already have happened before the listener existed.
- The stamp travels inside the cached shell, so it is exactly as old as the code around it.

`version.js` still hardcodes no version, and `update-core.js` is held to the same rule. `BUILD_NUMBER` remains the single source; the stamp is a fourth mirror of it, alongside `package.json`, `sw.js` and the archive name.

## Telling which build a page is running, from the outside

Without opening a console: open ❓. From build 96 on, the guide overlay carries an update row at the top with a **Check for update** button. A guide overlay without that row is build 95 or earlier, whatever the badge says.

## Contracts

`UI-VERSION-001` becomes: the build is declared once and stamped into every artefact that can report it. Guard `MUT-BUILD-STAMP-DRIFTS`, which drifts the stamp away from `BUILD_NUMBER` and requires the static suite to reject it.

`UI-VERSION-002` gains `MUT-VERSION-IGNORES-DOCUMENT-STAMP`, which removes the seeding of the label from the stamp and requires the platform suite to reject it.

The browser suite's simulated deploy now rewrites the document stamp along with the worker version, because a deploy that changed one without the other would not be a deploy.

Release gate: 16 suites passed (strict gate)
