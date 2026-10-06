# myAI Build 108

Build 108 fixes the reason a page of recordings would not render, and removes three things that were carrying weight without earning it. Database version 9 to 10, with a migration.

`src/js` is 13305 lines, down from 13364, having absorbed a new store and its migration while losing more than it gained.

## The list could not render because it was loading the audio

The master audio blob was stored inside the recording row. Listing reads six rows a page, so painting the list materialised six complete audio files.

```
WAV  48kHz mono 16-bit:  346 MB per hour
Opus 32 kbps          :   14 MB per hour

One page of six one-hour notes:  WAV 2.1 GB   vs   Opus 86 MB
```

At 86 MB a page this was survivable and merely slow, which is why it read as "the list takes a while". Switching the recording format to WAV multiplied it by twenty-five, and a phone cannot materialise two gigabytes, so the list painted nothing at all.

`calcTotalStorage` was worse and ran first. It walked **every** recording and every fragment, reading each blob only to add up its size. That is the whole database through memory before the list is even attempted, and it is the better explanation for a record button that appeared to hang: the button is re-enabled just before the list repaint, so what froze was the page, not the control.

No data was ever at risk. Nothing on these paths deletes a recording; the failure was entirely in reading. The startup message added in build 107, saying the notes below were safe, was accurate and useless at the same time, because they were safe and also not listed.

### What changed

Audio moved into a store of its own, keyed by recording id. A recording row now carries `audioBytes` and nothing heavier. Every site that only wanted to know whether audio exists, or how large it is, reads that number: the list, retention, the download name, the storage total, the conversion guard. Every site that genuinely needs the bytes fetches them: play, download, convert, transcribe, backup.

The player is the important one. A row renders an empty `<audio>` element that names the recording it would load, and the audio is fetched only when somebody presses play, with the previously attached one released first. **At most one recording is ever held in memory**, regardless of how long the list is or what format it is in.

Storage totals are now summed from recorded sizes, so startup adds up the library without opening any of it. Fragments record their own size when written, for the same reason.

### The migration

The upgrade creates the store. The move happens at boot, before the first paint, walking recording **keys** and moving one recording at a time, each in its own transaction. Walking keys matters: listing rows to find out which ones still hold audio would have read every blob, which is the exact problem being fixed. The page says what it is doing and that nothing is being deleted. The completion flag is only set once the pass finishes, so an interrupted migration resumes rather than being skipped.

Build 105's upgrade-abort fix is what makes a failed migration safe here, which is a pleasant return on a fix that had no visible effect at the time.

### Why no test caught it

Every fixture wrote audio into the row, so every test agreed with the bug. The browser suite now asserts that a page of listed recordings carries no audio at all while every row still reports its size. That assertion was checked against the bug: putting the blob back on the row makes it fail with `listing recordings never reads their audio, which is what made a page of WAV notes unrenderable`.

## Compressed audio is the default

The setting defaulted to WAV and the dropdown said so. Opus is twenty-five times smaller and was always meant to be the normal case, with WAV as the fallback where a browser cannot encode Opus, which is what `resolveRecordingFormat` already did. The default and the label now agree with the design. Existing recordings keep their format.

The WAV lifecycle test used to rely on the old default; it now states which format it exercises, which it should have done from the start.

## The battery estimate is gone

It never worked reliably, and it could not be made to. The reading comes from an API that browsers withhold, differently in each one, and that is being withdrawn rather than extended. A device reporting 64% showed nothing because the browser either does not expose the level or masks it as full and charging, which the code correctly read as "on power, say nothing".

An indicator that is only sometimes right is worse than no indicator in an application whose premise is that what it shows can be trusted, and the operating system already warns about a low battery using real data. Removed entirely: the drain tracking, the estimate, the display, the alert wording and the guide text. `sessionRunway` is now about free space, which is the one limit this application can actually measure and also the one it can do something about.

## The third repetition pass is gone

There were three mechanisms correcting the same class of defect. The live refiner fixes a repeat at a window seam while recording. The pre-save replay drops a suspect live passage and re-derives it from audio as part of gap filling that happens anyway, which is the cheapest possible correction. The third, `reviewTranscriptEchoes`, then re-listened to passages the first two had already policed, at up to six sequential server round-trips.

The attached VTS server settled it. `server.py` builds every response from segments with rounded start and end times and derives its text by joining them; there is no path that returns text without timestamps. Overlap can therefore always be trimmed geometrically, and the third pass was catching nothing. Removed, with the first two kept.

## Backwards compatibility removed

With a full export taken, the compatibility paths go: the legacy fragment store, legacy setting normalisation, the legacy id migration, the pre-103 fallback that read a live transcript off the recording row, the legacy recording-lease key, and the service worker's sweep of caches this application never owned. A transcript is now read only from the store that owns it.

## Contracts

`BATTERY-CONTEXT-001` and `REVIEW-PROGRESS-001` are retired with ten guards. Three contracts replace them:

- `LIST-WITHOUT-AUDIO-001` - listing and totalling never load audio; a recording's audio is read only when played, downloaded or converted, and only one at a time. Suites `static-integrity`, `browser-lifecycle`; guards `MUT-LIST-LOADS-AUDIO`, `MUT-PLAYER-EAGER`, `MUT-PLAYER-KEEPS-EVERY-BLOB`, `MUT-STORAGE-TOTAL-LOADS-AUDIO`.
- `RECORDING-FORMAT-001` - a new install records compressed audio. Suites `static-integrity`, `pure`; guard `MUT-DEFAULT-BACK-TO-WAV`.
- `REVIEW-ONE-PASS-001` - a repeat is corrected where it is cheapest, never by a third pass. Suite `static-integrity`; guard `MUT-THIRD-REVIEW-PASS-BACK`.

Two guards needed rescoping during this build, and both were my error rather than the design's. `MUT-PLAYER-KEEPS-EVERY-BLOB` passed because the assertion searched the whole file for a call that also appears elsewhere; it is now scoped to the function that must make it. `MUT-LIST-LOADS-AUDIO` mutated the recorder while the assertion only inspected the interface, so an assertion about the recorder was added.

## Reported but not fixed here

The attached VTS server's memory growth. `embed_segments` builds one padded batch sized `number_of_clips x longest_clip`, so a single long segment inflates every clip in the batch, bounded only by the 8 MiB body limit: roughly fifty segments padded to four minutes is near 840 MB in a single allocation, before the model's own buffers. Bucketing clips by length, or capping the batch, would fix it. That is a separate codebase and was not touched.

Release gate: 17 suites passed (strict gate), 136 mutation guards, 541 mutation assertions, 65 contracts
