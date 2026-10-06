# myAI Build 100

Build 100 closes four independent ways to lose recorded text or audio, found by a review of the whole source tree. It also changes the default reply model. No storage format change; `rec.liveTranscript` gains a lifecycle it did not have.

## The live transcript was invisible to everything that manages data

`rec.liveTranscript` is durable user text. The recorder snapshots it into the recording row every sixty seconds during capture and again at stop. Before this build, `grep -rl liveTranscript src/js/` returned two files: the recorder that writes it and the transcriber that reads it. Four systems did not know it existed.

**Retention.** `keepsText` in `planRecordRetention` counted transcripts, summaries and context chains. A row whose only text was the live one was therefore judged empty, and the sweep deleted the whole row when the **audio** window expired, regardless of the text window. Forty minutes of transcribed speech could be destroyed on a one-hour audio clock while the text setting said one year. The plan now carries `dropLive`, `keepsText` counts it, `retentionPlanTouchesAnything` reports it, `textExpiresInMs` accounts for it, and the sweep deletes it on the text clock like every other piece of text.

**Delete ALL transcripts, replies and context chains.** It cleared `transcripts`, `summaries` and the context chain and left the live transcript in place. Since `transcribeChunked` reuses live lines by default, the next automatic transcription rebuilt a transcript out of the text the dialog said had gone. It is now deleted.

**Backups.** The index the ZIP carries listed transcripts, summaries and context chains. The one text the app pushes hardest at the user to preserve was not in it. It is now.

**Delete ALL saved audio.** Its inline "does this row still have text" check counted only transcripts and summaries, so it deleted whole rows holding a context chain or a live transcript, while its dialog said transcripts and replies are kept. It now agrees with `retention-core`.

**Why a row reaches that state at all.** `recoverIncompleteRecordings` finalized a recording and stopped there; only the normal stop path promoted the live transcript into `rec.transcripts`. Any recording whose tab died before Stop therefore came back with audio, no transcript, and every spoken word in a field nothing rendered. Recovery and retried finalization now promote it, so it is visible, exportable and on the right clock. `storeLiveTranscript` already refused to overwrite an existing transcript, so running it on more paths is safe.

## Audio dropped from the live buffer was claimed as transcribed

`dropFromBuffer` discards buffered audio when the transcription server falls far enough behind. It advanced `droppedSec`, which was used only to build a status string, and did not advance `consumedSec`, which is the clock that stamps every line and, decisively, writes `coverage`.

The dropped span was therefore inside the coverage the live session reported. `invertCoverage` found no gap, the pass after recording never transcribed it, and the speech was lost for good. Everything after the drop was stamped early by the dropped duration, so the tail of the recording was transcribed twice and the reassembled timeline was out of order.

`dropFromBuffer` now advances `consumedSec` by the same amount. The span becomes a real hole in the coverage, the pass after recording fills it, and the timestamps stay honest. The status line now says what actually happens: `Ns skipped here, transcribed after recording`.

## One failed resample ended live transcription for the session

`enqueueWindow` took its sequence number before awaiting `resamplePcmTo16k`. A rejection there consumed the number and never placed anything in `state.pending`, and `releaseInOrder` releases strictly in order, so the release pointer stopped at that number for the rest of the recording. No further line appeared, coverage stopped growing, and `state.pending` grew one entry per window, each pinning a window of 16 kHz samples.

A window that cannot be prepared now claims its number with an empty, gap-marked entry, exactly as the retry-queue overflow path already did. The queue drains past it, and because the entry carries no `coverage`, the audio is transcribed after the recording instead of being written off.

## A backup that failed no longer clears the way for the deletion

`downloadBackup` returned normally both when the archive would exceed the 4 GB a ZIP can describe and when building it threw. `offerBackupFirst` awaited it and told nobody. So a user with more than 4 GB of audio could choose Delete All Audio, accept the offer of a backup, read an alert saying the backup could not be made and that they should download some recordings individually first, and have every blob deleted before they could act on it.

`downloadBackup` now reports whether a file was actually produced. `offerBackupFirst` returns whether it is safe to continue, and a failed or declined backup asks once more, naming what is about to be destroyed, defaulting to stopping. Every caller reads the answer: Delete All Audio, Delete All Text, and shortening a retention window, which also puts the setting back.

## Default reply model

`gemma4:31b` replaces `qwen3.8:27b`. A model already saved in this browser still wins over the default, including one the app saved for itself when an earlier default was not installed, so a device that has used the app keeps its saved model until `gemma4:31b` is picked under Settings, Reply model. If the server does not have it, the existing fallback applies.

## Contracts

- `DATA-RETENTION-001` now states that every kind of text is on the text clock. New guards `MUT-LIVE-TEXT-ON-AUDIO-CLOCK`, `MUT-LIVE-TEXT-OUTLIVES-DELETE`.
- `BACKUP-001` now states that a backup which failed stops the deletion it was offered for. New guard `MUT-DELETE-AFTER-FAILED-BACKUP`.
- `LIVE-REUSE-001` now states that the live pass never counts audio it did not hear as heard. New guards `MUT-DROPPED-AUDIO-CLAIMED-COVERED`, `MUT-WINDOW-INDEX-STRANDED`.

The two live-scribe fixes sit in orchestration code that has no unit coverage, so they are held by a pure test of the consequence (a dropped span must appear as a gap; a missing sequence number must strand the queue) plus a static assertion on the shape of the two functions. That is weaker than a behavioural test and is called out here so it is not mistaken for one.

Release gate: 16 suites passed (strict gate)
