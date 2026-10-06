# myAI Build 134

What the live transcript misses is no longer lost without a word, and words a window edge cuts are no longer said twice. A seam is trimmed where a window edge cut a word, and also where a live line with a speaker in front meets a chunk transcribed after the recording; a saved live transcript marks what it never heard, and the recording offers to transcribe just that; a busy transcription server loses no section any more; one segment without text no longer takes its chunk down. Smaller fixes: the service worker answers only the app's own page, Enter and Space press the 📋 inside a preview, the update check cannot hang, long titles wrap on a phone, and the limiter asks for nothing the browser has to clamp. Database version stays at 13.

## Words a window edge cut

A live window hears the last two seconds of the one before it, and the seam trim removes the words both heard. Since Build 110 it forgives one misheard word in every four, but the first and the last word of the seam had to match exactly, and those are the two words a window edge cuts: the window after the seam hears only the end of the word it opens with, the window before it only the start of the word it closes with. When either came out differently ("day" for "today", "yeah" for "year"), nothing was trimmed and the whole overlap was shown twice, and saved twice where the pass after the recording did not replay it.

An edge word now counts as the same word when the two readings agree on the part both windows heard: its end where the seam opens, its start where it closes. That is either a whole fragment of two letters or more ("day" in "today", "after" in "afternoon") or a shared part of three letters or more ("yea" in "yeah" and "year"); digits alone do not count, since 2023 and 2024 are different numbers. A seam of four words or more still forgives one misheard word in every four, and a cut edge word now counts as one of them; a seam of two or three words may have one cut edge word and no other difference. Where the seam closes on a cut word, the next window heard that word whole, so its reading is kept and the clipped one stays where it was: "…for next yeah" followed by "today is the budget for next year and the plan" goes on with "year and the plan". A cut word is no anchor by itself: "…the budget for next year" followed by "get for next week" is left alone, because the seam's closing words differ.

### Measured

The review's live simulation drives the real `live-scribe.js` with a stand-in server that hears utterances by their level, as `saved-transcripts` does, changed only to mishear the word a window edge cut. One-minute sessions, about 125 words each:

- The word cut at the end of a window misheard (8 sessions): Build 133 showed 15 to 25 words twice and 9 to 17 out of order; Build 134 none, and loses no word.
- The word cut at the start of a window misheard (6 sessions): Build 133 showed 8 to 16 words twice; Build 134 none.
- A clean server, one that drops the cut word, and one whose timestamps run 0.2 s early: no word lost, repeated or out of order, in either build.

## A speaker in front of a live line

A saved live line carries its speaker in front of its words ("Speaker 1: the release on friday afternoon"). Where such a line meets a chunk transcribed after the recording, the seam trim compared "speaker 1 the release…" with the end of the chunk, found nothing, and saved "we should ship the release on / Speaker 1: the release on friday afternoon". A saved live line now also carries its speaker on its own (`speakerLabel`); the trim works on the words and the speaker is put back in front of what is kept: "Speaker 1: friday afternoon". Lines saved by older builds carry no `speakerLabel` and are read as before.

## What the live transcript never heard

When the server kept failing on a window while it answered the others, the window was left out with the note "that part is transcribed after the recording"; windows still unsent at Stop and audio dropped while the server fell behind had the same promise. With Auto-transcribe off, which is the default, nothing transcribed them: the saved transcript simply had nothing there, and the compact list hides 📝 Scribe once a recording has text. With Auto-transcribe on, a missing stretch at the end of the recording shorter than a second was never sent, so the last words before Stop could be lost.

- The saved live transcript marks each stretch the live transcript never heard as `[not transcribed live]`, at the time it was, and stores how many there are (`holes`). The reply is told part of the recording is missing, as it is told of a section the server could not do. A live transcript that recorded no coverage marks nothing.
- The row of such a recording offers 📝 Fill gaps, also in the compact list. It transcribes only the marked stretches and saves a reading made of the live lines and them, after which the row offers it no more. A 30-second recording whose live transcript skipped 8 to 12 s and never sent 20 to 30 s gets two requests, of 4 and 10 seconds, where 📝 Scribe would send all 30.
- The live notes say what will happen: with Auto-transcribe on, "that part is transcribed after the recording"; with it off, "that part is marked in the saved transcript for 📝 Fill gaps".
- A stretch at the end of the recording is transcribed after the recording from a fifth of a second, as one at the start already was; between two heard stretches the minimum is still a second.
- A recording recovered after its tab closed has its live transcript only up to the last time it was saved, and the rest is now marked too.

## A busy transcription server

A server with more work than it can take answers 503 (or 429). The transcription after a recording kept sending as many chunks at once as before, and a refused chunk was asked again after 1.5 s and 5 s and then given up on, while the server was still working on the chunks it had taken. Now:

- a busy answer halves how many chunks go at once, as a timeout does;
- a chunk turned away while another chunk of the same transcription is at the server waits for that one to come back, then asks again, and this costs it none of its tries: the server is alive, and busy with this transcription's own work. An answer wakes a waiting chunk, another refusal does not unless it was the last of the transcription's chunks at the server, and a chunk stops waiting after twenty turns;
- a busy answer with none of this transcription's chunks at the server means something else is using it, and the chunk is retried after the usual pauses.

### Measured

A 20-minute recording, a stand-in server that takes 4 s a chunk and answers 503 to any chunk beyond what it can take:

- Taking two at a time: Build 133 marked 8 of the 20 minutes as unavailable after 30 refusals; Build 134 transcribes all 20, with 9 refusals, in 41 s, about the 40 s of work the server had.
- Taking one at a time: Build 133 lost 13 minutes after 41 refusals; Build 134 transcribes all 20, with 19 refusals, in 80 s, the server's own 80 s of work.

With a server that takes 0.4 s a chunk, neither build loses anything; Build 134 is done in 8 s where Build 133 took 10, since a refused chunk goes again as soon as there is room instead of after a pause.

## A segment without text

A segment the server sent with `text: null` threw where the line was put together, after its chunk had been counted as done, so the whole chunk was saved as "[transcription unavailable for this section]", counted a second time, so that progress went past 100%, and counted towards the five failures in a row that stop a transcription. Every segment now has text when it arrives, if only an empty one.

## Smaller fixes

- The service worker answered every navigation in its scope with the app. Opening another page of the same origin, such as `docs/PRIVACY.md` or a service under the same host, showed a copy of the app that looked for its modules under that address and found none. A navigation is now answered from the cache only for the app's own page; any other is left to the network.
- Enter and Space on the 📋 inside a transcript or reply preview did nothing: the preview took the key, stopped it, and then ignored it because it was meant for the 📋. A preview now takes a key only when it is pressed on the preview itself.
- The update check fetched the new worker script without a time limit, so a server that took the request and never answered left the check, and its button, on "Checking…" for good. The fetch is now given up on after 20 seconds, like the other steps of the check, and cancelled.
- A title with no spaces, such as a pasted address, made the page wider than a phone screen: at 360 px, 1,069 px wide, with Settings and the live panel laid out against that width. Titles, and the text of warnings and errors, now wrap inside the row.
- The limiter asked for a ratio of 30. A compressor takes at most 20, so every browser used 20 anyway and wrote "DynamicsCompressor.ratio.value 30 outside nominal range [1, 20]; value will be clamped." to the console on every recording. Its settings now lie inside the ranges Web Audio accepts; what the recording sounds like is unchanged.

## Tests

- `pure`: seams whose opening or closing word a window edge cut, as a fragment or misheard, long and short; a cut word with nothing else matching, a short seam whose both edge words are cut, two short words a letter apart and two years, none of which is a seam; the closing word kept as the next window heard it. A tail under a second; holes, their marks and their place between the lines; a live line's speaker kept apart from its words where it meets a chunk; the live notes with Auto-transcribe on and off; a busy answer halving the pool, the wait for the transcription's own chunk, what wakes it, its bound and its cancel; when a row offers 📝 Fill gaps; which keys a preview takes; the limiter's settings against the ranges Web Audio accepts.
- `saved-transcripts`: a server that takes one chunk at a time, for longer than the pauses between tries, with time running twenty times faster in the test: every minute of an eight-minute recording is transcribed, and fewer chunks are turned away than are answered. A server that sends one segment without text.
- `app-behaviour`: a live transcript with a skipped window and an unsent tail is saved with both marked and counted; the compact row offers 📝 Fill gaps; pressing it sends 4 and 10 seconds of audio, not 30, and saves a reading with the live lines and the filled parts, after which the row stops offering it.
- `live-scribe-unit`: with Auto-transcribe off, the note on a skipped window promises it to 📝 Fill gaps.
- `platform-unit`: an update check against a server that never answers ends, and cancels its request; the worker script is fetched past the HTTP cache.
- `service-worker`: a navigation to another page of the origin is left to the network; the app page itself, by its own name and with a query, is still answered from the shell. The check that a lookalike path was answered with the app is replaced by this.
- `user-journeys`, in Chromium: Enter and Space on the focused 📋 copy the transcript; a pasted address as a title wraps on a 360 px screen; a recording writes no clamping warning. These three have no mutation guard, since a guard may run for 30 seconds and the journeys take more than two minutes; each was run once with its fix taken out and failed with "Enter and Space on the focused 📋 copy the transcript… ([])", "…wraps inside its row on a 360px screen (page 1069px on a 360px screen, title text 997px in a 307px box)" and "…nothing is clamped behind its back (DynamicsCompressor.ratio.value 30 outside nominal range [1, 20]; value will be clamped.)".
- `static-integrity`: the check on how a transcription adapts to the server follows the new call.
- `user-journeys`, the next schema version: the tab that stepped aside says a newer version opened, and once anything of its own has tried the database since, a minute sweep say, that it is older than the stored data. Both are true and both say nothing was lost, but the check accepted only the first, so it passed or failed on where the minute fell; the three journeys added before it moved the minute, and it failed. It now accepts either, and says which one it met.

## Contracts

- `SEAM-CUT-WORDS-001`. Guards `MUT-SEAM-CUT-OPENING-WORD`, `MUT-SEAM-CUT-CLOSING-WORD`, `MUT-SEAM-CUT-DIGITS`, `MUT-SEAM-SHORT-RUN-DROPPED`, `MUT-SEAM-SHORT-RUN-TWO-CUTS`, `MUT-SEAM-CLIPPED-WORD-KEPT`.
- `SEAM-SPEAKER-LABEL-001`. Guards `MUT-SPEAKER-LABEL-BLOCKS-SEAM`, `MUT-SPEAKER-LABEL-DROPPED`.
- `LIVE-HOLES-MARKED-001`. Guards `MUT-HOLES-NOT-MARKED`, `MUT-HOLES-WITHOUT-COVERAGE`, `MUT-HOLES-NOT-STORED`, `MUT-HOLES-NOT-COUNTED`, `MUT-FILL-GAPS-HIDDEN`, `MUT-FILL-GAPS-SENDS-ALL`, `MUT-FILL-GAPS-AFTER-FILLING`, `MUT-LIVE-NOTES-PROMISE-AUTO`, `MUT-SKIP-NOTE-PROMISES-AUTO`.
- `SEGMENT-TEXT-001`. Guard `MUT-NULL-SEGMENT-TEXT`.
- `KEYS-INNER-CONTROL-001`. Guard `MUT-KEY-ON-INNER-CONTROL-TAKEN`.
- `UPDATE-CHECK-BOUNDED-001`. Guard `MUT-UPDATE-CHECK-HANGS`.
- `LIMITER-RANGE-001`. Guard `MUT-LIMITER-CLAMPED`.
- `LONG-TITLE-WRAPS-001`, checked by `user-journeys` only.
- `TRANSCRIBE-POOL-ADAPTS-001` gains `MUT-BUSY-KEEPS-POOL`, `MUT-BUSY-NOT-RECOGNISED`, `MUT-BUSY-NOT-PASSED`, `MUT-BUSY-CHUNK-GIVEN-UP`, `MUT-BUSY-WAKES-ON-REFUSAL`, `MUT-BUSY-WAITS-FOR-NOTHING`, `MUT-BUSY-WAITS-WITHOUT-OWN-CHUNK` and `MUT-BUSY-WAITS-FOREVER`; `LIVE-REUSE-001` gains `MUT-TAIL-GAP-DISCARDED`.
- `SW-ROUTE-002` now also says a navigation is answered only for the app's own page, guarded by `MUT-SW-ANSWERS-EVERY-PAGE`. `MUT-SW-ROUTE-EXACT` is retired: with navigations answered only for the app's page, whether `/transcribe` itself counts as a service route no longer decides anything, and the guard could not fail.
- `MUT-SEAM-EXACT-MATCH-ONLY` and `MUT-SEAM-TOLERANCE-UNANCHORED` follow the code they mutate. `MUT-WORKER-SCRIPT-FROM-CACHE` moves from `static-integrity` to `platform-unit`, which runs the code, and the ceiling of guards caught only by reading source text goes from 102 to 101.

153 contracts and 449 mutation guards in all; 101 guards are caught only by reading source text.

22 suites passed (strict gate) in 9 min 55 s; slowest mutation-guards (5 min 18 s)
