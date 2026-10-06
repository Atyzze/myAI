# myAI Build 126

Long recordings stay fast: fewer and smaller writes while recording, an offline queue that holds what it says, cheaper speaker labelling, a transcription pool that adapts to the server, and viewers that no longer redo all their work for every chunk or token. Database version stays at 13.

## Saving the live transcript while recording

The live transcript was saved whole every minute, every line from the beginning with its translations, so the writes grew with the square of the recording's length: over 100 MB in four hours with two translation boxes, twice the audio. It is now saved when it has changed and either five minutes have passed, or a minute has passed and it grew by a quarter, or by 4,000 characters, since the last save. Stop still saves it whole, and a recording recovered after a crash is at most five minutes behind in its live transcript; the transcription after the recording fills what the saved coverage does not include. For four hours of transcript growing 2,700 characters a minute, the saves go from 78 million characters in 240 writes to 16 million in 52.

At startup, the sweep for live transcripts that no recording owns read every live transcript in full, megabytes each, to learn which recordings they belong to. It now reads only their keys.

## The offline queue

A live window waiting to be sent held the WAV it would send and its 16 kHz samples for the repeated-words review, twice the size of the WAV, but only the WAV was counted against the queue's 96 MB cap, so a long outage filled about three times that. The newest windows keep their samples; windows waiting behind them keep only the WAV, and every window counts what it holds, so the cap is the memory the queue uses. At the cap it still holds over 400 windows, about half an hour of speech.

## Speaker labelling

With speaker detection on, every new line was clustered again with up to 450 earlier ones, and each step added up every member of a speaker again, so the cost grew with the square of the points kept. Each speaker now keeps a running sum, which gives the same speakers, and the lines of one live window are clustered together, once. Measured on the build machine per line at a full window: 16.7, 21.4 and 50.6 ms for embeddings of 192, 256 and 512 values on Build 125, 2.2, 3.0 and 5.2 ms on Build 126, before the saving from clustering once per window. A phone is several times slower than the build machine, so this is the difference between a stutter on every live window and none.

## How many chunks go to the server at once

The transcription after a recording sent ten chunks at once, each allowed 120 seconds, and the time a chunk spent queued at the server counted against its own limit. Against a server that takes one request at a time and needs 13 seconds for a 66-second chunk, most chunks timed out while queued and were sent again, and a 40-minute recording came back with most of it marked unavailable. Now two chunks go at once to start, one more after each quick answer up to ten, one fewer after an answer slow enough to show requests are queuing, and half as many after a timeout. A chunk that timed out is sent again only after 20 seconds, then 45, since the server is usually still working on it. A fast server still gets ten at once after a few answers.

In a simulation with 40 chunks and a one-at-a-time server, ten at once let 31 chunks time out at 13 seconds a chunk and 34 at 20 seconds; the adaptive pool lets none time out, and takes 8.7 and 13.3 minutes, the time the server needs. In the review's harness with the real transcription code, the same 40-minute recording got 15 of 40 chunks transcribed at 13 seconds a chunk and 6 at 20 seconds on Build 125, and all 40 on Build 126.

## The viewers

The transcription log viewer rebuilt the whole transcript, every chunk from the start, for every chunk it received, and opening it replays every chunk received so far. Each chunk is now rendered once, trimmed against the text before it, and when a chunk arrives before one it follows, only the chunk after it is rendered again. Measured in Chromium at a quarter of the CPU speed: opening the viewer on 180 chunks, three hours of recording, took 36.7 seconds on Build 125 and takes 0.23 seconds; a new chunk took 385 ms and takes 1 ms.

The reply viewer appended each token by rewriting the whole answer and measured the layout for every token. Tokens are now gathered and written once per frame into a few text nodes that grow, with one layout read per frame; a window that gets no frames, like a popup behind the app, is written on a timer instead. 3,800 tokens arriving at once took 28.8 seconds on Build 125 and take 40 ms.

Showing 📝 again during a recording cleared the live transcript on screen and built every row again; the rows already on screen are now kept.

## A reply that needs a longer context

A reply whose transcript needs a larger context than the model is normally loaded with makes the server reload the model inside that request, and a long prompt takes longer to read. Its first word was allowed the usual 45 seconds; it now gets 3 minutes before the reply is given up.

## Tests

- `pure`: the live transcript saves: four hours write at most a quarter of what saving it every minute did, never more than five minutes apart while it changes, nothing when unchanged. The queue counts both the WAV and the review samples, windows waiting behind the newest let their samples go, and the queue at its cap holds no more than 96 MB and over 400 windows. A window's lines added together are clustered as when added one by one. The pool's growth, shrinking, halving and floor, the wait before resending a timed-out chunk, the simulated one-at-a-time server with ten at once and adaptive, and the pool's limit and stop. The first word's wait for a usual and a larger context.
- `live-view-unit`: sixty chunks in order are each rendered once, 779 elements for 360 lines, where Build 125 created 23,730; any order gives the same transcript, rendering again only the chunk after; a chunk arriving first trims the words the next one already has. A thousand tokens within one frame are written in one go, into at most two text nodes with at most two layout reads, and a frame asked for before a reset writes nothing.
- `live-scribe-unit`: showing 📝 again keeps the same five row elements.
- `static-integrity`: the snapshot plan in the heartbeat, the keys-only sweep, the queue's byte count and lightening, the running sum and one clustering per window, the adaptive pool's wiring, the first-word wait, and the viewers' timer fallback.
- `user-journeys`: the startup sweep of live transcripts reads no transcript in full and still removes one no recording owns.

Against Build 125, every suite named here fails on its new tests.

## Contracts

- `LONG-RECORDING-BOUNDED-001`. Guards `MUT-SNAPSHOT-EVERY-MINUTE`, `MUT-SNAPSHOT-IGNORES-GROWTH`, `MUT-SNAPSHOT-UNCHANGED-REWRITTEN`, `MUT-LIVE-SWEEP-READS-ALL`, `MUT-QUEUE-UNDERCOUNTS-AUDIO`, `MUT-QUEUE-KEEPS-REVIEW-AUDIO`, `MUT-CENTROID-RESUMMED`, `MUT-SPEAKERS-PER-LINE`.
- `TRANSCRIBE-POOL-ADAPTS-001`. Guards `MUT-POOL-FIXED-TEN`, `MUT-POOL-KEEPS-SIZE-ON-TIMEOUT`, `MUT-POOL-NEVER-SHRINKS`, `MUT-POOL-IGNORES-LIMIT`, `MUT-TIMEOUT-RESENT-AT-ONCE`.
- `VIEWERS-STAY-FAST-001`. Guards `MUT-LOG-CASCADES-TO-END`, `MUT-LOG-REBUILDS-EVERYTHING`, `MUT-REPLY-WRITES-PER-TOKEN`, `MUT-FIRST-BYTE-FIXED`, `MUT-FIRST-BYTE-SHORT-FOR-LONG-CONTEXT`, `MUT-RESUME-REBUILDS-ROWS`, `MUT-VIEWER-WAITS-FOR-FRAMES`.
- `MUT-SAVED-TRANSCRIPT-RETRIMMED` is re-pointed at the new log renderer.

127 contracts and 329 mutation guards in all.

Release gate: 18 suites passed (strict gate) in 6 min 38 s; slowest user-journeys (2 min 26 s)
