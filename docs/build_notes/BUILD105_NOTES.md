# myAI Build 105

Build 105 is a correctness pass over five defects found by reading the tree rather than by hitting them. No storage format change; database version stays at 9. One of the five could have cost data; the rest cost correctness, work or memory.

It also adds the first unit suite for `live-scribe.js`, which was the largest module in the tree with no suite of its own.

## A failed schema upgrade no longer commits

`idb-min.js` caught an exception thrown by the `upgrade` callback and rejected the open. It never aborted the version-change transaction. IndexedDB therefore committed whatever the upgrade had managed to do *and* wrote the new version number. The next open would see `oldVersion === newVersion`, skip the upgrade entirely, and the half-built schema would be permanent: no retry, no repair, and every later read against a store that was never finished.

The upgrade transaction is now aborted before the rejection, so a failed upgrade leaves the stored version where it was and the next open runs the whole migration again. The first rejection wins, so the caller still sees the real error rather than the abort.

Nothing in the tree currently has an upgrade that can throw. That is exactly why this was worth fixing now rather than after one could.

## Pausing live transcription keeps the transcript

`pauseLiveScribe` calls `stopLiveScribe({ keepText: true })`, and `stopLiveScribe` set `state.recId = null` whether or not the text was kept. `startLiveScribe` decides whether it is resuming by comparing `state.recId` to the recording it is starting, so that comparison could never be true. Six lines written to carry the lines, backfill, archive, coverage map and tail across a pause were unreachable, and the line immediately after them cleared the text for real.

Visible consequence: turning live transcription off and on during a recording blanked the panel and re-transcribed the entire recording so far, because an empty coverage map means the backfill sees the whole prefix as a gap. On a long recording that is a large amount of pointless work sent to the server, and every line the user had already read disappears.

`stopLiveScribe` now keeps `recId` when it keeps the text, and clears it when it clears the text. Every other reader of `state.recId` is already gated on `state.active`, which `stopLiveScribe` clears first, so a retained id cannot restart anything by itself.

`closeLiveScribe` is unchanged and still discards both.

## A wake lock granted after it was switched off is released

`acquire()` awaits `navigator.wakeLock.request`. If `disableWakeLock()` ran during that await, `_sentinel` was still null, so there was nothing to release; the await then resolved and stored a live sentinel while `_wantLock` was already false. The screen stayed awake with nothing left in the program that could ever release it.

The sentinel is now checked against the current intent after the await, and released immediately if the user has switched the lock off in the meantime.

## A live view closed early stops being tracked

`pumpToWindow` registers the pending window under a fresh random signature, and `pump()` returned without removing that entry when the window was found closed. Every popup the user closed before it reported ready left one entry, holding a reference to the dead window, in a map that nothing ever swept. The signature is random per open, so this grew without bound across a session.

The closed-window and timed-out paths now drop the entry by its own signature.

## An attribute is escaped for attribute position

`live-scribe.js` built `data-lang="..."` with `escapeHtml`, which deliberately escapes only `&`, `<` and `>`. `escapeAttr`, which also escapes quotes, is the next function along in `config.js`.

The value is a language code from a fixed list, so this could not be reached today. It is fixed because the next value put there may not be from a fixed list, and because the wrong escaper in attribute position reads as a mistake to anyone auditing the file. A sweep confirmed this was the only attribute in `src/js` built from a free-text value; the rest interpolate record ids, byte counts and booleans.

## A unit suite for the live transcriber

`live-scribe.js` is 1621 lines, the largest module in the tree, and the three worst defects fixed in builds 100 to 102 all lived in it. Each of those is held by a static assertion, which catches a deleted line but not a rewritten function.

`tests/unit/live-scribe.test.mjs` is new: a small DOM harness plus a stub transcription server, driving the real module. It starts a session, backfills real lines through `transcribeChunkServer`, pauses, resumes, and asserts that the lines and the coverage map both survive and that the resume sends no further audio to the server. It also asserts that a different recording never inherits the previous one's transcript, and that closing discards where pausing keeps.

Fifteen assertions. It was confirmed to fail on the unfixed tree with `resuming the same recording keeps the transcript instead of blanking the panel`.

This is a start on that module, not coverage of it. The suite is registered as required, so it grows with the module.

## Contracts

Five new contracts, six new guards, all confirmed to bite:

- `DB-UPGRADE-ATOMIC-001` - a failed upgrade leaves the stored version untouched. Suites `platform-unit`, `static-integrity`; guard `MUT-FAILED-UPGRADE-COMMITS`.
- `LIVE-PAUSE-001` - pausing keeps the transcript and coverage map, and resuming re-sends nothing. Suites `live-scribe-unit`, `static-integrity`; guards `MUT-PAUSE-FORGETS-RECORDING`, `MUT-CLOSE-KEEPS-RECORDING`.
- `WAKELOCK-RACE-001` - a lock granted after it was switched off is released at once. Suite `platform-unit`; guard `MUT-WAKELOCK-LATE-SENTINEL-KEPT`.
- `LIVE-VIEW-LEAK-001` - a view closed before it reports ready stops being tracked. Suites `static-integrity`, `live-view-unit`; guard `MUT-POPUP-CLOSED-STILL-TRACKED`.
- `MARKUP-ESCAPING-001` - attribute values are escaped for attribute position. Suite `static-integrity`; guard `MUT-ATTRIBUTE-TEXT-ESCAPER`.

Two of the five are held by static assertions rather than behavioural tests. The popup leak has no runtime signal at all, being purely memory, and the escaper cannot currently be reached with a value that would show the difference. That is what static assertions are for, and it is worth saying which ones they are.

## Build notes stop being deleted

`docs/build_notes/README.md` told whoever released the next build to delete the previous build's notes after adding a CHANGELOG line. That rule was followed every build, which is why only one notes file was ever present. Notes now accumulate; pruning them is a human decision, not a build step.

The notes for builds 94 to 104 were recovered from the released archives, each of which is self-contained, and are back in `docs/build_notes/`.

## Not fixed, deliberately

`ensureMediaRecorderStopped` resolves after 1500 ms whether or not the recorder's `stop` event fired, which could in principle drop the last Opus segment. It has not been reproduced, and raising the cap trades a rare truncation for a rare hang. Left alone until it is seen.

Release gate: 17 suites passed (strict gate), 133 mutation guards, 530 mutation assertions, 58 contracts
