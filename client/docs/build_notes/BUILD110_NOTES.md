# myAI Build 110

Build 110 is a correctness build. Four defects are fixed, transcript gaps stop presenting silence as a fault, and a recording can start from the clipboard.

## The tail of an interrupted recording was being discarded

`prepareWebmChunkSource` gave the last Cluster of a truncated container an `endSec` equal to its own `startSec`, and set the source duration to that same value. `makeWebmDecodeChunk` clamps its range to that duration and selects Clusters with `cluster.startSec < end`, so the final Cluster could never be selected. Build 109 asserted this on purpose, under the name "the final, possibly incomplete Cluster overlaps no decode window".

The premise was wrong. `parseBlobTopLevel` admits a Cluster only after it has read that Cluster whole and checked that it ends inside the segment; anything it could not read that far sets `truncatedAt` and is dropped without being admitted. Every Cluster in the index is therefore complete, and the truncation is always past the last one. The old rule was not protecting against a half-read Cluster, it was throwing away the newest audio of every interrupted or still-running Opus recording, which is exactly the audio the tail review exists to re-listen to.

Build 110 estimates the final Cluster's span from the median of the observed Cluster cadence, so the duration always reaches past the last Cluster start and the tail stays decodable. A median is used rather than the last gap so one abnormal spacing cannot drag the estimate. `estimateTruncatedDurationSec` is a separate pure function with its own tests and `MUT-WEBM-TRUNCATED-TAIL-LOST`.

## A window could answer into the session that replaced it

`send()` decremented `state.inFlight` in a `finally` that ran for every request, including requests belonging to a session that had already stopped. `stopLiveScribe` resets that counter to zero, so up to two late arrivals drove it negative and `planUpload`'s `inFlight >= maxInFlight` gate let the next session over-send until the count climbed back.

The success path was guarded only by `state.recId !== recId`, which does not separate two sessions of the same recording. Pausing and resuming live transcription keeps the recording id, so a window still in flight at the pause could place its text into the resumed transcript.

Live transcription sessions are now stamped. `state.epoch` advances on every stop, each request captures the stamp it was sent under, and a request whose stamp has expired adjusts nothing: not the in-flight count, not the pending map, not the retry queue. `transcribe.js` and `reply.js` already had this discipline through `jobs.js`; the live transcriber now has its own equivalent.

## One misheard word defeated the whole seam

`seamTrim` required every word of an overlap to match exactly. A single substitution at a window boundary, which is where audio is most likely to be clipped, failed every candidate length and the entire overlapping phrase was emitted twice.

A tolerant second pass now runs only after the exact pass finds nothing. It requires at least four words, requires both the opening and closing word of the run to match, and allows no more than a quarter of the run to differ. The closing-word requirement is what stops a line that merely opens like its predecessor from being swallowed; `MUT-SEAM-TOLERANCE-UNANCHORED` holds that specific guarantee, because without it a line sharing seven opening words loses all of them.

## A screen lock could outlive its recording

`acquire()` checked `_sentinel` before awaiting the request, so two overlapping calls both requested a lock and the loser was orphaned with nothing holding a reference to release it. Each sentinel's `release` listener then cleared the shared reference without checking which sentinel had fired, so a stale sentinel could clear the lock that replaced it and `disableWakeLock()` would find nothing to release.

Requests are now single-flighted, a lock that arrives while one is already held releases itself, and a sentinel clears the shared reference only when it is still the one being held. Build 105's fix for a lock granted after the switch was turned off is unchanged and still tested.

## Silence is not a failure

A transcript read afterwards showed `[⚠️ transcription unavailable for this section]` once for every 60-second chunk. Three separate things were wrong with that.

A chunk was written off after a single refusal. Chunks are now retried on a bounded schedule before they are recorded as a hole, and a cancelled transcription is never mistaken for a failure worth retrying.

A section that produced nothing was described as unavailable whatever the reason. The client already holds the 16 kHz audio it sent, so it now measures it: a chunk whose peak and RMS are both below the silence thresholds is reported as `[no speech detected]`, and one that carried sound and still failed keeps `[transcription unavailable for this section]`. A quiet recording is a transcript that says it was quiet, not a failed job, so a run of silent chunks no longer trips the "no chunks could be processed" error.

An unbroken run of either kind is now reported once, over the span it actually covers, instead of once per chunk. Twenty quiet minutes read as one line rather than twenty.

The warning icon is gone from the gap marker. A hole in a transcript is a statement about the recording; it is not an alert, and it should not make the reader go looking for a fault that is not there.

## Starting a recording from the clipboard

A 📋 button beside Start Recording begins a recording that remembers whatever is on the clipboard. The pasted text becomes an ordinary `contextChain` item, so it is displayed in the note's context block, fed to the AI with the recording, exported, retained and deleted on exactly the same terms as context carried over by Continue or Link. There is no second store and no new row shape.

`clipboard-core.js` is pure and decides only what a paste becomes: it normalises line endings, leaves indentation alone so pasted code survives, caps an oversized paste and says in the label that it did, and refuses to build an item at all from an empty clipboard. Reading the clipboard stays in `main.js`, with a typed fallback where the browser will not hand it over.

## Contracts

- `OPUS-TRUNCATED-TAIL-001`: every Cluster that indexed cleanly stays reachable, including the last one.
- `LIVE-SESSION-EPOCH-001`: a request outliving its session cannot alter the session that replaced it, even at an unchanged recording id.
- `SEAM-TOLERANCE-001`: a seam survives one misheard word and is never trimmed on a coincidental alignment.
- `TRANSCRIPT-SILENCE-001`: failures are retried, silence is reported as silence, and a run of either is reported once.
- `CLIPBOARD-CONTEXT-001`: clipboard text is a bounded ordinary context item owning no storage.
- `WAKELOCK-RACE-001` gains `MUT-WAKELOCK-DOUBLE-ACQUIRE` and `MUT-WAKELOCK-STALE-CLEARS-CURRENT`.

Eleven mutation guards were added, bringing the catalogue to 148.

Release gate: 17 suites passed (strict gate)
