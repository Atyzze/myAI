# myAI Build 99

Build 99 fixes a release-packaging defect that could strand a browser on an old build permanently, and adds a client-side repair for the same class of problem on servers this project does not control.

## The defect

`tools/package_release.py` set `mtime = 0` on every archive member for reproducibility. Extracted and served by an ordinary static server, every build therefore claimed `Last-Modified: Thu, 01 Jan 1970 00:00:00 GMT`, and an nginx-style `ETag` of `"<hex mtime>-<hex size>"` collapsed to `"0-<size>"`.

`sw.js` was 4479 bytes in build 94, 4515 in 95 and 4546 in 96, 97 and 98: builds 94 through 96 each added a module to the shell list, and 96 through 98 changed only a version digit. So from 96 onward two consecutive builds presented byte-identical validators.

A service-worker update check revalidates the worker script conditionally. Against identical validators the server answers `304 Not Modified`, the browser keeps its cached script, the bytes are unchanged, and no update is possible. Not slow: impossible. A private window, having no cache entry, issues an unconditional request and gets the current build immediately, which is the signature this was diagnosed from.

This was a defect in the release tool, not in the application. Build 96's badge was reporting the situation correctly all along.

## Every build now carries its own modification time

`release_mtime(build)` returns `RELEASE_EPOCH + build * 86400`, so each build has a distinct, increasing timestamp that is still a pure function of the build number and keeps the archive reproducible. `Last-Modified` and any mtime-derived `ETag` now differ between any two builds. The archive verifier refuses to publish if any member carries a different mtime than the build's own.

Anyone who has extracted an earlier archive should be aware that those trees all carry 1970 timestamps; deploying build 99 over them replaces the files and the timestamps together.

## The client no longer depends on that being right

A server can still be configured to defeat this, so the update check no longer trusts the HTTP cache at all.

Before asking the registration to update, the app fetches `sw.js` itself with `cache: 'reload'`. That bypasses the HTTP cache and, per the fetch specification, replaces the cached entry with what came back, so a poisoned entry is repaired in passing. The same response is parsed for its `VERSION`, which gives the build the server is actually serving, independently of anything the worker machinery believes.

Three outcomes:

- The server matches the running build: up to date.
- A new worker installs and takes over: the ordinary path from build 96, unchanged.
- The server is ahead but no new worker ever appears: the browser is refusing to replace its worker. The badge shows `v96 › v99` as usual, and the second tap unregisters the service worker and deletes the `myai-shell-*` caches, then reloads. The page then comes from the network and registers the current worker.

Clearing the installed shell touches the service worker and the shell caches only. IndexedDB is not opened, and `version.js` is held to that by a static assertion: recordings, transcripts and settings survive it. This is the "force a refresh without losing site data" that a private window otherwise achieves only by having no data.

Clearing the shell is a reload, so it is refused during a recording like any other.

## Contracts

`RELEASE-BUILD-001` becomes: release identity, build notes and per-build file timestamps move together. Guard `MUT-RELEASE-MTIME-PINNED`, which pins the mtime back to the epoch and requires the static suite to reject it.

`UI-VERSION-002` gains `MUT-STUCK-WORKER-UNNOTICED` and `MUT-WORKER-SCRIPT-FROM-CACHE`.

The stuck-worker path is covered by unit tests over the pure rules and by the platform suite driving the real `appUpdate` against a registration whose `update()` does nothing while the server reports a newer build, asserting that the worker is unregistered exactly once and only outside a recording. It is not covered by the browser suite: poisoning Chromium's HTTP cache on demand is not something that suite can arrange honestly, and a test that pretended to would be worse than none.

Release gate: 16 suites passed (strict gate)
