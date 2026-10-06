# myAI Build 103

Build 103 moves the live transcript out of the recording row. Storage format change: database version 9 adds a `live_transcripts` store. Nothing else changes.

## The cost this removes

`dbUpdate` is a read-modify-write of a whole record: get, mutate, put. The recording heartbeat runs every three seconds and always returns the row, so every field on that row was structured-cloned out and back in twenty times a minute. Once `rec.liveTranscript` was on the row, that included the entire live transcript, which grows for the whole session.

Measured for the four-hour session the project states as its limit, with two translation panels:

```
before:  ~1649 MB of read and write churn, ~234 KB/s sustained at the end
after:   ~84 MB,                           ~11.7 KB/s
```

Twenty times less, and it is the shape that matters more than the constant: the old cost grew with the square of the recording length, because each of the 4800 beats carried a payload proportional to how far in it was. It now grows linearly, because only the sixty-second snapshot carries the transcript and the three-second heartbeat carries a number.

This was not only a performance question. That churn competed for IO with the fragment writes that are the recording, and its transient on-disk footprint ate the headroom `ensureFinalizationHeadroom` needs to assemble the master blob. The likeliest way it would have shown itself was a storage failure at the end of a long live-transcribed session, which is exactly when a recording is least replaceable.

## Where the transcript lives now

A store of its own, `live_transcripts`, keyed by recording id, reached only through four functions in `db.js`: `readLiveTranscript`, `writeLiveTranscript`, `updateLiveTranscript`, `deleteLiveTranscript`. Every reader and writer in the application goes through them, so the storage location is one decision in one file rather than fourteen call sites.

The recording row keeps `liveTranscriptLines`, a count. `planRecordRetention` is a pure function over a row and has to decide whether a row still holds text without reading a second store, so the count is what it reads. `hasLiveTranscript` accepts either the count or a legacy inline transcript.

## Nothing written by an older build is lost

There is no data migration in the upgrade transaction. A `versionchange` upgrade that throws is swallowed and committed at the new version, so a migration that failed would never get a second attempt; the safe design is not to have one.

Instead `readLiveTranscript` looks in the new store and, finding nothing, falls back to `rec.liveTranscript` on the row. Rows written by build 102 and earlier keep working untouched, and since only an in-progress recording is heartbeated, and an in-progress recording is always a new row, those old rows never pay the cost that was the point of the change.

## Write ordering

Within a snapshot the transcript is written to its store first and the row is updated second. The two writes are separate transactions, so one can succeed without the other, and the order decides which way that failure falls:

- store first: a failed row update leaves the transcript in both places. Harmless; the reader prefers the store.
- row first: a failed store write leaves a row that says it has text, with the text deleted and never stored.

The row is only allowed to drop its copy once the store write has reported success.

## Deletion and orphans

Every path that removes a recording now removes its transcript: deleting one recording, Delete All Text for both the rows it empties and the rows it removes, Delete All Audio for rows it judges empty, and the retention sweep for both the text clock and the whole row. `cleanupOrphanLiveTranscripts` runs on start beside the existing fragment sweep, so a transcript whose recording disappeared some other way does not accumulate.

The backup reads through the same accessor, so it carries the transcript whichever place it is stored in.

## Contracts

`LIVE-TEXT-STORE-001` is new: the live transcript is stored beside the recording rather than inside the row the heartbeat rewrites, and survives the upgrade that moved it. Suites `static-integrity`, `browser-lifecycle`; guards `MUT-HEARTBEAT-CARRIES-TRANSCRIPT`, `MUT-LIVE-TEXT-LOST-ON-UPGRADE`, `MUT-SNAPSHOT-NEVER-STORED`.

The browser suite writes a row in the old shape and reads it back through the new accessor, writes one in the new shape and confirms the row does not carry the text, deletes a recording and confirms the sweep removes what it left. The existing live-transcription test, which records for real and waits for spoken text to be persisted mid-recording, now reads through the accessor and additionally asserts that the row the heartbeat rewrites holds only a count.

Release gate: 16 suites passed (strict gate)
