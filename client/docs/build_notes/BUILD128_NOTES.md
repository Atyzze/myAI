# myAI Build 128

What is saved is what was said, and what is deleted is gone. A saved transcript no longer loses words to the check for repeats, nor moves words spoken after a quiet minute into that minute; live transcription no longer splices old audio onto new after an outage, nor shows a sentence twice where two backfill windows meet; a one-line translation that starts with a time is kept; automatic deletion counts from the end of a recording; deleting a transcript takes its live transcript with it, and a deletion a closed tab left half done is finished. Code comments that say why are allowed again. Database version stays at 13.

## Repeats in a saved transcript

When a transcript was put together, every line was checked against the forty words before it, and whatever it began with that they ended with was cut, whether or not the two lines had heard the same audio. That check exists for the overlap two chunks share, but it ran on every line, and the loose match it allows removed whole sentences. For the Build 124 example, the live transcript showed "Okay. | Okay, so we need to fix the bug. | We need to test the bug. | Yes, I think so. | Yes, I know so. | Let us ship it." and Build 127 saved "Okay. so we need to fix the bug. Yes, I think so. Let us ship it.": Build 124 had fixed the live view, and the saved transcript undid it. Within a single chunk, "I think so. | So what do we ship first? | The app. | The app and the server. | Thanks. | Thanks, everyone." was saved as "I think so. what do we ship first? The app. and the server. Thanks. everyone."

Now a line is trimmed only against words another window heard at the same time, within a quarter of a second, and never against the line before it in its own window. The lines of the live transcript were already reconciled while they were recorded, so they are saved as the live view showed them. Where two chunks both kept a sentence near their boundary, it is still saved once.

## Words spoken after a quiet minute

When the server placed every word of a chunk outside its core, the words it heard in the overlap were saved at the start of the core. After a quiet minute, "See you on Monday then.", said at 2:01, was saved as `[01:00-02:00] See you on Monday then.`, and the copy the next chunk saved at the right time was then cut as a repeat. Now:

- a chunk owns the segments whose middle falls in its core;
- when the server placed every word outside a core that was quiet, those words are the neighbour's, and the minute is saved as no speech;
- when the core had about as much sound as the place the server named, the server's timestamps do not match the audio, and its text is used for the core rather than losing that stretch; a server that gives no usable timestamps has its text used as before;
- the silence verdict listens to the core of a chunk, not to the overlap it shares with its neighbours.

A transcription cancelled while its audio was still being prepared left a rejected promise nothing handled; it no longer does.

## Live transcription

- A live window has only the carry before its core. A sentence that begins in the carry and runs on into the core is kept, and the live seam trim removes the words the previous window already heard, so the end of the sentence is not lost. It runs on when it reaches 0.3 s into the core, or, however briefly it reaches in, when the audio there has sound: "early.", said in the first quarter second of a window that is quiet after it, is kept. A window whose words all lie in the carry, or only touch a quiet core, adds nothing, where Build 127 added the misheard carry as a new line ("Did it to leave early.").
- A window that was heard and held nothing new is no longer treated as a gap, so the line after it gets no "…" mark.
- When the server falls behind and audio is let go, the window after the gap no longer starts with the last two seconds before it. In the unit test, Build 127 sent a six-second window starting with second 6 of a stretch that resumed at second 20; Build 128 sends four seconds starting at second 20.
- Backfill windows overlap by two seconds, and a sentence both of them heard was shown twice. It is now shown once, by the same rule as the saved transcript.

## One-line translations

A single line is asked for without numbering, but its reply was still read as a numbered list, so "10.30 uur komt mij goed uit." was line 10 of 1 and refused, and after three tries the line was marked not translated, blaming the model's format; "1. Mai ist ein Feiertag." lost its date. A single line is now taken as the model wrote it. Where the completion after a recording asks for a single line with its number, a reply with a line that reads as item 1 ("1. …", "**1.** …", "1) …", "1 - …", also after a preamble such as "Here is the translation:") has the number removed and is refused if it goes on to other numbers; a reply without one is kept as it is, and so is a number the translation itself starts with: Build 127 turned "1.5 Kilo reichen." into "5 Kilo reichen." and "1:30 passt mir." into "30 passt mir.".

## Automatic deletion counts from the end

A recording's age was counted from when it started, so with audio kept for an hour, a 74-minute meeting was past its window the moment it was stopped; with no transcript yet, the sweep a minute later deleted the whole recording without asking. A recording now remembers when it stopped (`endedAt`, its last heartbeat when it was stopped or recovered) and ages from then; an older recording ends at its start plus its length. A two-hour recording that saved only twenty minutes of audio ages from when it stopped, not from its start plus twenty minutes. The settings text and the automatic-deletion question say "after the recording ended".

## Deleting

- Deleting a transcript made from the live transcript left the live transcript stored, unseen, and every backup carried it. Deleting the last transcript made from it now deletes it too, and the question says so; a cleanup pass that replaces the live reading does the same. A backup leaves out a live transcript that no transcript shows, unless it is the recording's only text.
- Deleting a recording whose save failed, or one waiting to be recovered, asked whether to delete a row that "holds nothing but its own entry" while it held all its audio. The question now names the audio saved so far and in how many pieces, the live transcript and the context items.
- A deletion is noted from before it marks the recording until it ends. A tab that closed half way through left the recording marked, skipped by recovery and by automatic deletion for good; at startup and in the minute sweep, a tab that holds the recording lock now finishes every noted recording, and every one it saw in the list, that is still marked, unless another tab is still capturing it. A deletion that could not even mark its recording leaves no note behind.

## A Stop that meets a full disk

Once the recording's own state was torn down, the heartbeat written while it was being saved no longer carried the capture error and the missing audio. If the save then failed and could not be marked, the only record of the failure was gone, and a later recovery saved the recording as complete. The heartbeat now keeps what the stop found until the recording is settled, and a recovery that meets the same full disk keeps the beat.

## Default model

The code's default AI model is `qwen3.8:27b`. Build 100's notes and the changelog say `gemma4:31b` replaced it; that was undone later without a note, and this build keeps `qwen3.8:27b`. The README now names the default, and the static suite checks that it names the one the code uses.

## Comments

Build 127 removed every comment and had the static suite reject new ones. That rule is dropped: what the code does is still said by its names, and why it does it, when that is not obvious from the code, is said in a short comment next to the line it explains. The comment scanner, `CODE-HAS-NO-COMMENTS-001` and its three guards are removed, and the fixes in this build carry their reasons.

## Tests

- New suite `saved-transcripts`: the real `transcribeChunked` on a stored recording, against a stand-in transcription server that hears the audio it is sent (each utterance is a run of samples at its own level, so the server knows which utterances a chunk holds, where, and which ones the chunk's edge cut short). Repeats within a chunk; sentences around two chunk boundaries, one heard by both chunks and a real repeat right after a boundary; a quiet minute and a noisy wordless minute before speech; a server that puts its words at the start of every chunk, or gives no usable timestamps; the live transcript kept as the recording's transcript, and reused after it; a gap transcribed after the recording meeting the live lines; a cancel while the audio is prepared. Against Build 127 it fails where the sections above say.
- New suite `storage-paths`: the real `settings.js`, `recorder.js` and `db.js` under node. Automatic deletion of a long meeting and of the live transcript on the text clock; deleting a transcript, with and without another one made from the live transcript; the cleanup pass in replace mode; the backup's live transcripts; the question before deleting a failed save; interrupted deletions, noted and seen, and a noted recording that is not marked; a deletion that cannot mark its recording; every deletion path, including deleting a recording's audio, leaving alone a recording another tab is still capturing, also when that tab takes it up while the question is open; a Stop that meets a full disk through a slow save, a recovery that meets it too, and the recovery once there is room; a Stop whose first notes of the stop fail, and the end time it records.
- The node harness: `tests/helpers/app-harness.mjs` gives the modules a page that records its dialogs and downloads and one tab's Web Locks, and a module hook swaps `idb-min.js` for `tests/fixtures/memory-idb.mjs`, an in-memory IndexedDB with key paths, indexes, key ranges, cursors, whole-or-nothing transactions that run one after another where they overlap, and injected failures and delays.
- `live-scribe-unit`: a window whose words lie in the carry, followed by quiet; a sentence that runs on from the carry into the core, also by only a quarter of a second, and one that only touches a quiet core; the window after dropped audio; backfill windows that overlap.
- `pure`: the seam rule, the segments a window owns, the core of a chunk, one-line translations (with a preamble, in five numbering styles, and starting with a number of their own), the end of a recording, deletion planning, and the beat written while saving.
- `user-journeys`: deletions a closed tab left half done are finished when the app starts, and by the recovery sweep of a tab that is already open.
- `static-integrity`: four checks that matched the source text of code this build changed are replaced by the behavioural tests above; the comment scanner is removed; the README must name the default model.

On Build 127, eight of the `saved-transcripts` assertions and five of the new `live-scribe-unit` ones fail, with the results quoted above. The others pass on Build 127 and are there so that this build cannot lose what it got right: the end of a sentence that runs on from the carry, also by only a quarter of a second, a server whose timestamps do not match the audio, a gap meeting the live lines, and no gap mark after a quiet window. `storage-paths` needs this build's modules to run; each behaviour it checks is guarded by a mutation that puts the Build 127 behaviour back.

## Contracts

- `SAVED-TRANSCRIPT-WHOLE-001`. Guards `MUT-SEAM-TRIMS-OWN-WINDOW`, `MUT-SEAM-IGNORES-TIME`, `MUT-SEAM-NO-COVERAGE`, `MUT-LIVE-TRANSCRIPT-RETRIMMED`, `MUT-OVERLAP-SPEECH-AT-CORE`, `MUT-NOISY-CORE-TAKES-OVERLAP`, `MUT-CORE-SOUND-IGNORED`, `MUT-SILENCE-OVER-WHOLE-CHUNK`, `MUT-CANCEL-REJECTION-UNHANDLED`.
- `LIVE-WINDOWS-HEAR-ONCE-001`. Guards `MUT-LIVE-OVERLAP-SPEECH-AT-CORE`, `MUT-LIVE-RUN-ON-DROPPED`, `MUT-LIVE-SHORT-RUN-ON-DROPPED`, `MUT-LIVE-QUIET-CORE-TOUCH-KEPT`, `MUT-EMPTY-WINDOW-IS-GAP`, `MUT-DROP-KEEPS-CARRY`, `MUT-BACKFILL-SEAMLESS`.
- `TRANSLATE-ONE-LINE-001`. Guards `MUT-SINGLE-LINE-NUMBERED`, `MUT-SINGLE-LINE-NO-FALLBACK`, `MUT-SINGLE-LINE-PREAMBLE-TAKEN`, `MUT-SINGLE-LINE-OWN-NUMBER-CUT`.
- `RETENTION-FROM-END-001`. Guards `MUT-RETENTION-FROM-START`, `MUT-ENDED-AT-NOT-NOTED`, `MUT-ENDED-AT-IGNORED`.
- `DELETE-LEAVES-NOTHING-HIDDEN-001`. Guards `MUT-DELETE-TRANSCRIPT-KEEPS-LIVE`, `MUT-CLEANUP-KEEPS-LIVE`, `MUT-BACKUP-CARRIES-ORPHAN-LIVE`, `MUT-DELETE-PROMPT-IGNORES-SAVED-SO-FAR`.
- `INTERRUPTED-DELETE-FINISHED-001`. Guards `MUT-INTERRUPTED-DELETE-LEFT`, `MUT-INTERRUPTED-DELETE-NOT-NOTED`, `MUT-INTERRUPTED-DELETE-IGNORES-OWNER`, `MUT-INTERRUPTED-DELETE-IGNORES-MARK`, `MUT-FAILED-MARK-KEEPS-NOTE`.
- `DEFAULT-MODEL-DOCUMENTED-001`. Guard `MUT-DEFAULT-MODEL-UNDOCUMENTED`.
- `STOP-SURVIVES-FULL-DISK-001` gains `MUT-BEAT-FLAGS-DROPPED-AFTER-CLEANUP`, `MUT-FINAL-BEAT-NOT-FORCED` and `MUT-RECOVERY-DROPS-UNSETTLED-BEAT`; `HEARTBEAT-BEAT-STORE-001` gains `MUT-DELETE-AUDIO-IGNORES-OWNER` and `MUT-DELETE-AUDIO-RACE`.
- Re-pointed from `static-integrity` to `storage-paths`: `MUT-RETENTION-LOSES-LIVE-DECISION`, `MUT-BEAT-DROPPED-UNSETTLED`, `MUT-BEAT-FORGETS-FAILURE`, `MUT-DELETE-IGNORES-BEAT`.
- Removed: `CODE-HAS-NO-COMMENTS-001` with `MUT-CODE-COMMENT-ADDED`, `MUT-TEST-COMMENT-ADDED` and `MUT-TOOL-COMMENT-ADDED`.

135 contracts and 368 mutation guards in all; 131 guards are still checked only against `static-integrity`, down from 137.

20 suites passed (strict gate) in 7 min 21 s; slowest mutation-guards (3 min 02 s)
