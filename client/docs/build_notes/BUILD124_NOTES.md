# myAI Build 124

Fixes for the ways a note could lose something without a warning: the last words of the live transcript, real sentences removed where two live windows meet, live text thrown away by a failed replay, recovered Opus recordings, a full disk at Stop, deletions after a backup that was never saved, Settings writing back old values, and automatic deletion taking a fresh reply. Database version stays at 13.

## The last seconds of the live transcript

Stop waited for the live windows being sent to the server, but not for the last window while it was still being prepared (resampled to 16 kHz for the server). So the words said in the last few seconds before Stop were often missing from the saved live transcript, and came back only with a transcription afterwards. Stop now waits for a window being prepared as well, for up to 2.5 seconds in all instead of 1.2. In the unit test Build 123 saved only "the first window of speech"; Build 124 also saves "the last thing said before stopping".

With Opus, the audio tap that feeds the live transcript stayed connected after Stop, so silence kept arriving while the live transcript was being finished. It now hands over its last samples and is detached first, for Opus as for WAV. A branch in `stopLiveScribe` that was meant to keep the sentence still being spoken could never run, and is removed.

## Repeated words where two live windows meet

Live windows are 4 seconds long and each overlaps the one before it by 2 seconds, so the start of a window can repeat words the previous window already produced. Build 123 checked every line of every window against the text before it, including a loose match, so a real sentence that only resembled the one before it was cut short or removed: after "Yes, I think so.", "Yes, I know so." was dropped, and after "Okay, so we need to fix the bug.", "We need to test the bug." was dropped. Now only a line that starts inside the overlap, with half a second of tolerance, is checked. The first window after 📝 is shown again overlaps nothing and is never trimmed.

A sentence split across two windows could also be saved with its halves swapped: the rest of the sentence kept the start time the server gave its whole segment, which can be a little earlier than the beginning already saved. The rest of a sentence now never starts before its beginning.

In the unit test with three windows, Build 123 saved "Okay. | so we need to fix the bug. | Yes, I think so. | Let us ship it. | go to the park. | I think we should". Build 124 saves "Okay. | Okay, so we need to fix the bug. | We need to test the bug. | Yes, I think so. | Yes, I know so. | Let us ship it. | I think we should | go to the park.".

## Hiding and showing 📝

A window that was still being prepared when 📝 was hidden joined the next session when 📝 was shown again. It appeared among the new lines, and it took the place of the new session's window with the same number, which was then transcribed but never shown. It is now dropped with the rest of the old session's unsent audio. In the unit test, Build 123 showed three windows from before the pause instead of two, and three of the four windows after it.

## The replay before a transcript is saved

When a recording is transcribed after it ends, live lines that overlap each other are set aside and their passage is sent to the server again, so it can be heard once. Build 123 removed those live lines before the replay. When the replay failed, the saved transcript had a hole there ("[transcription unavailable]"); when the server heard nothing, the passage was gone. The live lines are now removed only when the replay of their passage heard words, and otherwise saved as they were. A replay that only partly succeeded does not repeat them, and a failed chunk that also covered audio nobody transcribed still says so. In the browser test with a server that hears nothing, Build 123 saved one of the three live lines, "then we move on to the next item"; Build 124 saves all three.

## Recovered Opus recordings

Chrome's Opus recorder hands over its audio in 4-second pieces, and each piece ends with the first byte of the next block. When a tab is closed during a recording, the pieces it saved therefore end one byte into a block that was never finished. Recovery then failed to give the file a duration and a seek index ("Truncated WebM element ID."): the player showed no length and could not seek, every download tried the repair again and failed, and transcription left out the last Cluster, about 4 seconds. The file now ends at its last complete block: a block or a Cluster that was cut short is left out, and every complete block before it is kept.

A recovered recording's length came from its last saved length, which is written once a minute. Every Opus recording is now as long as the time of the last block in its file. This also fixes recordings whose audio engine was suspended for a while: Chrome's file keeps the time that passed, but the samples counted do not, so a 15-second recording was saved as 11 seconds. A file length longer than the time since the recording began, plus a minute, is not believed; when the file cannot be read, the length still never exceeds the audio that arrived.

In the journey test, a recording recovered from the pieces of a real recording had, on Build 123, a length of 3,000 ms, no seek index and no length in the player (Infinity). On Build 124 it is 11,999 ms long, the audio its pieces hold, it is seekable, and the player reads 11.999 seconds.

## A full disk at Stop

When storage filled during a recording, Stop treated the failure to note the stop on the recording as fatal and never saved the recording, which then stayed on "Recovering". It also deleted the small heartbeat record either way, so after a reload the recording was saved with a length up to a minute old, without the storage error and without the "incomplete" mark. Now:

- the stop is noted if it can be, the recording is saved anyway, and the error it met is saved with it in the same step;
- the heartbeat record carries the storage error and whether audio is missing, and is kept until the recording is saved or marked as failed, so recovery after a reload knows its length and that it is incomplete;
- once one piece of audio cannot be stored, the later pieces wait in memory instead of being stored after a missing one, so the stored audio never has a hole in the middle;
- the audio still in memory is offered for download, as before, and now also after any other failure to save.

In the browser test the disk stays full through Stop. Build 123 deleted the heartbeat record. Build 124 keeps it, with the storage error and the incomplete mark, and once there is room again the recording is recovered with its audio, named "(incomplete)", with the storage error it met.

## A recording whose save failed

A recording whose save failed offered only Retry and Delete: its audio could not be played, downloaded or backed up. It now has **⬇️ Audio saved so far**, which puts the stored pieces together into a file, and the backup includes that audio too, marked as saved so far.

## Backup first

Before deleting all audio or all text, or shortening automatic deletion, the app offers a backup first. Build 123 took the backup as done as soon as its download had started and deleted right away, so a download that was cancelled or failed left nothing. Once the download has started, the app now asks to check that the ZIP was saved before anything is deleted; Cancel deletes nothing. In the journey test, with that question answered Cancel, Build 123 deleted the audio of all 16 recordings anyway; Build 124 keeps it.

The backup also names only the audio it really holds. A recording whose audio cannot be read is listed in `transcripts.json` without an audio file and marked as missing, the manifest counts them, and an alert says how many; before, the index named a file that was not in the ZIP. `transcripts.json` is now written last, after the audio, so it can say so. No automatic deletion runs in the tab while a backup is being made.

## Settings

Closing Settings, or leaving the page while it was open, wrote every setting shown back to storage. A tab with Settings open therefore put back values another tab had changed in the meantime, retention included, and the earlier confirmation then covered it, so the next sweep deleted without asking. It also saved the AI model the list had only fallen back to, and wrote every default into storage, so a later change to a default never reached that browser. Only the settings edited in the tab are now written back. In the journey test, Build 123 put the retention another tab had set to 1 year back to 1 month, and saved a bitrate of 32 that had only been looked at; Build 124 leaves both alone.

A retention setting is saved only through its confirmation, as the value that was confirmed. Closing Settings while a shorter retention was still being checked used to save it even when the confirmation was then cancelled, and a second change during the check could be saved by the first confirmation. The choice is now locked while it is being checked.

## Automatic deletion and replies

A transcript's age counts from when it was made, and the replies written from it are deleted with it. So a fresh reply to an old transcript was deleted along with the transcript, earlier than the row's countdown said, and the confirmation listed only the transcript. A transcript is now kept while a reply written from it is still inside the text window, and goes with its replies once they expire.

## Deleting one transcript or reply

Deleting one transcript or reply cancelled every job of that recording: a transcription running at the time stopped without a word, and the translation fill that runs once after a recording stopped for good. They are now left running. In the browser test, Build 123 aborted the running transcription (AbortError); Build 124 finishes it and saves its transcript.

## The cleanup pass

With **Cleanup pass** set to keep only the cleaned-up reading, the live reading was removed after the pass even when a reply had been written from it; that reply could then no longer be shown, and a reply still being written was thrown away. With automatic transcription on, its copy of the live text stayed behind as a second reading. The pass now removes the live reading and the automatic copy of it, keeps any reading a reply was written from, and changes nothing while a reply is being written.

## Updates

Tapping a ready update only checked whether a recording was going, so it could reload the page while a recording was being saved, or during a transcription, a reply or a backup. It now waits for all of these, and says so: "Something is still running in this tab (a recording, its save, a transcription, a reply or a backup)". The help says the same, and the Settings hints now mention the saved-file question and that a transcript stays as long as its replies.

## Tests

- `pure`: a transcript is kept while a reply written from it is kept, and goes once its replies expire; only a line starting in the overlap is trimmed, lines that resemble earlier ones are kept, a window with no overlap is never trimmed, and the rest of a split sentence never starts before its beginning; replay settlement keeps the live lines when the replay fails or hears nothing, does not repeat them after a partial replay, lets a replay that heard the passage replace them, and still marks a real gap; the Opus length follows the file, also after a suspension and on recovery, falls back to the audio that arrived, and ignores an impossible file length; the cleanup pass keeps a reading with a reply and removes the automatic copy; the blocked-update message.
- `live-scribe-unit`: the words said in the last seconds before Stop are saved; three windows with resembling sentences and a split sentence are saved whole and in spoken order; after hiding and showing 📝 during a window's preparation, all four windows after the pause are shown and the stale one is dropped.
- `webm-remux-unit`: a Chrome-style stream that ends one byte into the next block, or with the first byte of a new Cluster, becomes a seekable file with every Cluster indexed and its last complete block kept; a block cut in the middle is left out and the result equals the stream without it; a Cluster only just begun is left out; transcription reads the last Cluster; the length comes from the last block, also with a non-default TimestampScale.
- `static-integrity`: the stop path saves the recording after a failed note, keeps the beat until the row is settled and puts the failure in it; later pieces wait in memory after a failed one; the ⬇️ Audio saved so far button and the backup of failed saves; the Opus length is read from the file; backup-first asks after the download starts; the backup's missing-audio list and its sweep guard; Settings writes only its own edits and retention only through the confirmation, locked while checked; deleting one item cancels nothing; the cleanup pass wiring; the update busy check; replay settlement before the transcribed-anything check; the audio tap detached before the live transcript is finished.
- `browser-lifecycle`: a full disk through Stop keeps the beat with the storage error and the incomplete mark and offers the audio, and recovery then saves the recording marked incomplete; a replay the server hears nothing on keeps the live words; deleting an old reply during a transcription leaves it running.
- `user-journeys`: an Opus recording recovered from the pieces a real recording saved gets its length, seek index and a finite length in the player; backup first deletes nothing when the saved-file question is cancelled; closing Settings leaves a retention set by another tab and an untouched bitrate alone, and saves an edited instruction.

Against Build 123, every suite named here fails on its new tests; the results are given in the sections above.

## Contracts

- `LIVE-TAIL-AND-SEAMS-001`. Guards `MUT-STOP-FORGETS-PREPARING-WINDOW`, `MUT-SEAM-TRIMS-WHOLE-WINDOW`, `MUT-SEAM-LIMIT-NOT-PASSED`, `MUT-SPLIT-SENTENCE-REORDERED`, `MUT-STALE-WINDOW-JOINS-NEW-SESSION`, `MUT-OPUS-TAP-LEFT-CONNECTED`.
- `REPLAY-KEEPS-LIVE-001`. Guards `MUT-REPLAY-FAILURE-DROPS-LIVE`, `MUT-REPLAY-SILENCE-COUNTS-AS-HEARD`, `MUT-REPLAY-DOUBLES-PARTIAL`, `MUT-REPLAY-HIDES-REAL-GAP`, `MUT-REPLAY-SETTLEMENT-UNUSED`.
- `OPUS-RECOVERY-WHOLE-001`. Guards `MUT-RECOVERY-TAIL-THROWS`, `MUT-RECOVERY-BEGUN-CLUSTER-REFUSED`, `MUT-RECOVERY-LAST-BLOCK-IGNORED`, `MUT-OPUS-LENGTH-FROM-COUNTED-SAMPLES`, `MUT-OPUS-LENGTH-NOT-FROM-FILE`.
- `STOP-SURVIVES-FULL-DISK-001`. Guards `MUT-STOP-NOTE-FATAL`, `MUT-BEAT-DROPPED-UNSETTLED`, `MUT-BEAT-FORGETS-FAILURE`, `MUT-HOLE-AFTER-FAILED-PIECE`, `MUT-FAILED-SAVE-UNREACHABLE`.
- `BACKUP-BEFORE-DELETE-001`. Guards `MUT-BACKUP-NOT-AWAITED`, `MUT-BACKUP-HIDES-MISSING-AUDIO`.
- `SETTINGS-WRITE-OWN-EDITS-001`. Guards `MUT-SETTINGS-WRITE-ALL`, `MUT-RETENTION-WRITTEN-ON-CLOSE`, `MUT-RETENTION-SAVES-LIVE-ELEMENT`, `MUT-RETENTION-UNLOCKED`.
- `RETENTION-KEEPS-ANSWERED-001`. Guard `MUT-TRANSCRIPT-OUTLIVED-BY-REPLY`.
- `DELETE-ONE-KEEPS-WORK-001`. Guards `MUT-DELETE-REPLY-CANCELS-ALL`, `MUT-CLEANUP-DROPS-ANSWERED`, `MUT-CLEANUP-KEEPS-AUTO-COPY`.
- `UPDATE-WAITS-FOR-WORK-001`. Guard `MUT-UPDATE-DURING-WORK`.
- `MUT-LIVE-SCRIBE-GAP-TRIM` (`LIVE-SCRIBE-001`) and `MUT-WINDOW-INDEX-STRANDED` (`LIVE-REUSE-001`) are re-pointed at the new seam and window code.

118 contracts and 281 mutation guards in all.

18 suites passed (strict gate) in 5 min 16 s; slowest user-journeys (2 min 05 s)
