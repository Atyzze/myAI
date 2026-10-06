# myAI Build 111

Build 111 is a correctness build. Six defects are fixed, each reproduced in Chromium against Build 110 before it was touched, and each now held by an end-to-end journey that fails on Build 110 and passes here. Database version stays at 11; nothing about the stored layout changes.

## An update could delete every note

Build 109 made schema changes destructive: the upgrade callback deleted every object store and created the current ones. No build has changed the version since, so it never ran, but the next one would have. A copy of Build 110 with only `DB_VERSION` raised to 12 was opened beside a tab holding two recordings. Both were gone, nothing asked first, and the old tab announced "A newer version of this app opened in another tab. Reload this page to carry on. Nothing has been lost."

The recording veto from Build 104 did not change the outcome, it only postponed it. With a recording running, the newer tab waited. But the browser fires `versionchange` once per request, so stopping the recording did not release anything; the newer tab stayed blocked until the recording tab was closed, and then deleted the recording it had just waited for. "Export first" could not be acted on either: the service worker activates a new build on the next open, with no warning beforehand.

The upgrade is now additive. `applySchema` in `db-lifecycle-core.js` walks one declared layout, creates the stores and indexes that are missing, and deletes nothing. It is pure and tested against a fake native database: a new install gets every store and index, an existing database gets exactly what it lacks, and a store this build no longer reads is left alone.

## A waiting version now starts when the recording stops

`idb-min.js` hands the application a `release` function when it keeps a connection for a recording. `db.js` remembers it, and `noteDatabaseIdle()` uses it once the tab is no longer busy; `main.js` checks every second. Busy now means recording, still saving a recording, or holding the recording lock, so a recording that has stopped but is still being finalized is not cut off.

The notices were corrected with it. The tab that is recording used to be told "Another tab is recording", about itself, because it is the only tab that knows a recording is running. It is now told that its recording comes first and that the newer version starts by itself when it stops. "Nothing has been lost" is true again and stays.

## A stale tab went blank

A tab still running an older build than the stored data set its guard to `stale` and painted the notice, and startup maintenance then took the same alert line for "Checking for interrupted recordings" and cleared it. `setGuard` does not repaint an unchanged state, so the tab showed an empty list and no reason. The guard now claims the line with `dataset.owner = 'guard'`, which the startup note already yields to.

## Deleting during a conversion did not stay deleted

`convertRecFormat` wrote the Opus audio and only then asked `conversionStillApplies`, outside the lock the delete paths take. Deleting a recording while it converted left its audio in the store for a recording that no longer existed; it survived Delete All Audio and kept counting in the storage line. Deleting only the audio had the same effect, hidden under "Audio deleted to free space". The pure test for `conversionStillApplies` passed throughout, because the predicate was right and the caller did not consult it in time.

`commitAudio` in `db.js` now reads the row, lets the caller decide, and writes the row and the audio in one transaction over both stores, audio last. Conversion, the download remux and both finalizers use it; no path writes finished audio apart from its row. Startup sweeps audio that no recording owns, which also clears anything an earlier build left behind.

## The storage counter counted every recording twice

`calcTotalStorage` summed `audioBytes` from every row and then added the audio store, which holds the same bytes. One recording read as twice its size and as 50% of all audio. It is now counted once, from the audio store.

## Continue during a recording leaked into the next one

💬 Continue set the pending context and called `startRecording`, which returned at once because a recording was running. Nothing was shown, and the next recording, however unrelated, carried the context to the AI. Continue now refuses during a recording and says why, and its button is disabled while one runs, as Link and 📋 already were.

## The background sweep interrupted an idle tab

The once-a-minute retention sweep in a tab that was not recording hit the lifecycle lock held by a tab that was, and alerted "Another tab is recording or finalizing audio. Try again after it finishes." every minute, about something nobody tried to do. The sweep now waits quietly for the next tick; deletions a person asks for still say why they were refused.

## Smaller

- The listener for the spoken stop command removed in Build 106 is gone, as is `describeClipboardAttachment`, which nothing called.
- The storage line no longer reads "Available: unavailable • unavailable".
- The changelog gains its missing line for Build 109, and the notes for Builds 105 to 108 no longer state their gate result twice.

## Tests

`tests/integration/journeys-integration.mjs` is a new required suite, `user-journeys`. It drives the real page in Chromium and serves a second build from `/next/` on the same origin whose only difference is a raised database version. It covers: the counter equals the bytes stored; a recording or its audio deleted during conversion stays deleted, and an uninterrupted conversion still completes; ownerless audio is swept at startup; Continue during a recording is refused and the next recording carries no context; a background sweep facing another tab's recording is silent; the newer schema waits for a recording, starts when it stops without closing any tab, and keeps every recording and its audio; and a tab left on the older build explains itself. Run against Build 110 with failures reported instead of fatal, fourteen of its sixteen assertions fail; the two that pass are an uninterrupted conversion and a check that is vacuous once the upgrade has deleted everything.

The existing browser suite's upgrade check now also asserts that the waiting version gets through once the recording ends, then removes the database it bumped so the rest of the suite runs on the current version.

## Contracts

- `DB-KEEP-NOTES-001` replaces `DB-CURRENT-SCHEMA-001`: a schema change only adds what is missing, and a version waiting on a recording starts when it stops. Guards `MUT-UPGRADE-DELETES-NOTES`, `MUT-VETO-NEVER-RELEASED`, `MUT-IDLE-NEVER-RELEASES`.
- `AUDIO-OWNED-001`: audio is stored only together with the row that still wants it, and ownerless audio is swept. Guards `MUT-CONVERT-WRITES-BEFORE-CHECK`, `MUT-COMMIT-AUDIO-BEFORE-CHECK`, `MUT-ORPHAN-AUDIO-KEPT`.
- `STORAGE-COUNT-001`: each recording is counted once. Guard `MUT-STORAGE-COUNTS-TWICE`.
- `CONTINUE-WHILE-RECORDING-001`. Guard `MUT-CONTINUE-WHILE-RECORDING`.
- `SWEEP-QUIET-001`. Guard `MUT-SWEEP-ALERTS`.
- `UPGRADE-NOTICE-001`: the guard owns the alert line and the recording tab is told the truth. Guard `MUT-GUARD-NOTICE-UNOWNED`.
- `DB-UPGRADE-001` gains the `user-journeys` suite. `MUT-STORAGE-TOTAL-LOADS-AUDIO` now points at the audio-store sum, the only one left.

## Not done

When a tab steps aside after a recording, work that recording started afterwards in that tab, such as automatic transcription, can fail against the connection it gave up. The recording itself is finalized before the tab counts as idle, and the newer version can transcribe it. Fixed in Build 112.

Release gate: 18 suites passed (strict gate)
