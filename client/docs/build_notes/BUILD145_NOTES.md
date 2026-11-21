# myAI Build 145

Brave on Android crashed again at Stop, and the system log from Build 143 showed where. On 21 November the browser died 0.2 s after Stop logged "saving (putting the recording together)" for recording 52, and then died four more times at startup, each time within a moment of recovery beginning to save that same recording, before the fifth try saved it. The page was using 10 MB of memory each time. Android's "Brave closed because this app has a bug" means Brave's own browser process crashed, not the page: on Android that process also runs IndexedDB and the store of files a page builds (blobs). The crash itself cannot be seen from the page, but this build changes what the app asks the browser to do at that moment, stops a recording from crashing the browser at every launch, and logs each step of a save and of a transcription so the next crash, if any, shows its step. It also shows a thinking model's speed while it thinks. Database version stays at 13.

## What the person sees

- Nothing changes when saving works, which is almost always.
- A recording whose save took the browser down is saved again at the next launch, the plainest way. Its file is indexed for seeking when it is downloaded instead of when it is saved.
- If saving the same recording takes the browser down twice, the app stops trying it by itself, so it cannot crash the browser at every launch. Its row says so and offers Retry finalization, ⬇️ Audio saved so far and Delete. Its pieces are all kept. Retry always goes ahead, the plainest way.
- ❓ → 🧾 Open system logs now shows each step of a save (reading the pieces, joining them, measuring, indexing for seeking, writing the recording, removing the pieces, saved) and a transcription's progress, the lines its log view shows.
- While a thinking model reasons, the reply view shows its speed next to its token count ("120 thinking tok · 18.4 tok/s"), not only once the answer begins.

## How

- Saving used to join the 4-second pieces into one file made of the stored pieces themselves, and write that file back into the same database, so the browser read from the database while it wrote to it. Now the pieces are read into memory and joined there, and every audio write (`commitAudio`) stores a plain in-memory copy (`blobWithOwnBytes` in `db.js`). That covers a save after Stop, a recovery, a Retry, and the remux when a recording is downloaded. The copy is read 4 MB at a time (`AUDIO_COPY_SLICE_BYTES`), each slice a blob of its own at once, so the page never holds more than one slice and there is no size above which a recording is written the old way.
- A save is counted on the recording's row before it begins (`saveAttempts`, `beginSave` in `finalize-core.js`), and the count goes when the save ends, saved or failed. A count left on a row is a save the browser died during. Recovery saves such a recording without indexing it for seeking (`plain`). At `SAVE_CRASH_LIMIT` (2) an automatic save does not begin: `markSaveHalted` marks the row `saveHalted` and `finalize-error` with the reason, and lets go of it. Startup recovery skips such a row even though it retries failed saves. A Retry by hand is counted too, so if it also takes the browser down, the next launch still leaves the recording alone. A count that cannot be written (a full disk) does not hold a save up.
- Each step of a save is logged and on disk, for at most 400 ms, before it begins (`savingStep` in `recorder.js`). A transcription is on disk before it reads the audio and before it sends its first chunk, and every line of a transcription's live log goes to the system log.
- `replyStreamThinking` times the reasoning from its first piece and sends `elapsedMs` with each piece and with the snapshot a view opened later receives. `createReplyRenderer` shows tokens per second from the second thinking token on.

## Tests

`storage-paths`:
- Stop counts its save before it begins, and the count goes once it is saved.
- The log holds each step of saving a WAV recording and an Opus recording, in order. The Opus pieces are joined in memory, and each step is on disk before the step begins.
- A recording whose save crashed once is saved again by itself, unindexed, and its count goes.
- A recording whose save crashed twice is not saved by itself. It keeps its pieces, is let go, says why, and offers Retry, the audio saved so far and Delete. The next launch leaves it alone too. A Retry by hand saves it the plainest way and makes it an ordinary recording again.
- Audio is read into memory before it is written, with the same bytes. A recording longer than a slice is copied too, a slice at a time, in order.
- A recovery whose count meets a full disk still goes ahead, as before.

`pure`: the count, its limit, a save by hand, and a count that goes with every save that ends.

`saved-transcripts`: a transcription's progress is in the log in order, and its first steps are on disk before the first chunk is sent.

`live-view-unit`:
- A thinking model's footer shows its tokens per second.
- Each piece of reasoning carries how long the model has been reasoning, and so does the snapshot for a view opened later.

Sixteen new mutation guards cover:
- the count: not taken, not removed, and its limit, halt, startup skip and plain saves after a crash or on Retry;
- the in-memory copy: skipped, read whole, and capped at a size;
- the save steps: not logged, and not on disk before they begin;
- the transcription log: missing, and not on disk before the first chunk;
- the thinking speed: hidden, and not timed.

One guard follows a line this build moved: the reply stream's initial state.

GATE_RESULT
