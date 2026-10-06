# myAI Build 102

Build 102 makes a recording prove it is recording. No storage format or protocol change; recording rows gain a `capturedMs` field.

## The screen could say "recording" while nothing was being captured

A `MediaStreamTrack` has two ways to stop supplying audio. It can **end**, which is permanent and fires `ended`, or it can **mute**, which is temporary, fires `mute`, and leaves the track live. The recorder listened for `ended` only. `muted` is specified as "the track is temporarily unable to provide data", and it is the ordinary signal on every platform when something else takes the microphone: another app claiming audio focus, a call, a system privacy switch.

Nothing else filled the gap. Every counter on screen and in the record was wall-clock: the button from `Date.now() - startTime`, the heartbeat's `durationMs` from the same subtraction, and the waveform from an `AnalyserNode` on the same graph, which draws a flat line indistinguishable from a quiet room. Not one of them consulted `pcmLength`, `recordedBytes` or `audioCtx.state`. So a capture path that stopped delivering samples produced a screen that carried on exactly as before, and a file that was quietly short.

## What it does now

Every buffer the worklet delivers increments `AppState.samplesSeen`, for both WAV and Opus, since the worklet runs in both. The existing GUI tick compares that count against the clock.

- Four seconds with no new samples, or a track that reports itself muted, raises a red line above the list naming what happened, marks the recording incomplete so the filename says so, and writes the same note into the live transcript.
- A suspended `AudioContext` gets exactly one `resume()` attempt, not a loop.
- Sound returning clears the warning and records how long the gap was.
- **The warning never stops the recording.** A false positive can therefore only produce a message that clears itself, which is the whole reason it is safe to be this sensitive. Being wrong in the loud direction costs a notification; being wrong in the quiet direction costs the recording.

Four seconds is the same cadence as `IO_FLUSH_SEC`, so the window of uncertainty is the same as the window of unsaved audio: at most one flush.

The threshold survives background-tab timer throttling. A throttled tick sees both the elapsed time and the sample count jump together, so it reports late rather than falsely; a stall is detected on the following tick.

## A file no longer claims audio it does not have

The WAV path already recomputed its duration from the bytes written. The Opus path took `Math.max(durationMs, rec0.durationMs)`, both wall-clock, and wrote that into the WebM Duration element, so a truncated recording advertised its full intended length and seeking was meaningless. The heartbeat now records `capturedMs` from the sample count, and `finalizeOpus` takes the lesser of the clock and what was actually captured. Because it goes through the heartbeat it survives a crash and is available to the recovery path.

## The backfilled prefix is bounded

`state.backfillLines` had no cap, unlike `state.lines`, and every repaint rebuilt the whole of it. Turning live transcription on three hours into a recording backfilled thousands of lines and then re-rendered all of them on every settled window, which competes for the main thread with the loop that cuts the windows. It is now capped by characters, with the overflow archived exactly as the live lines are, so the saved transcript is unchanged and only the on-screen prefix is shortened. Backfilled lines also now count as live when translations are pruned; they were being treated as dead and losing their translations on the first overflow.

## A reply server that will not answer is given up on

`fillTranslations` had no breaker. A batch failure was logged and then escalated to one request per line, so a dead or hanging server turned a few hundred batch requests into tens of thousands of single ones, serially, with nothing on screen. Two changes: a transport failure no longer escalates to per-line requests, because that multiplies one failure by the batch size, and three unanswered requests in a row stop the fill and say so. A server that answers with a misaligned batch is still retried line by line, which is what that path is for.

## Deferred, with a measurement

The three-second heartbeat is a whole-row read-modify-write, so once `rec.liveTranscript` is on the row it is cloned out and back in on every beat. For a four-hour session with two translation panels that is about 350 KB per beat by the end, roughly 1.6 GB of read and write churn across the session and about 234 KB/s sustained at the end, competing for IO with the fragment writes that are the recording, and eating the headroom `ensureFinalizationHeadroom` needs at the end.

The correct fix is to move the live transcript into its own object store, which is a schema bump and a rewiring of the six paths that build 100 just taught about that field. It is deliberately not being bolted onto this build. It is build 103.

## Contracts

`CAPTURE-HEALTH-001` is new: a recording that has stopped hearing anything says so on screen, keeps running, and never claims audio it did not capture. Suites `pure`, `static-integrity`, `browser-lifecycle`; guards `MUT-CAPTURE-STALL-UNNOTICED`, `MUT-CAPTURE-MUTE-IGNORED`, `MUT-CAPTURE-STALL-STOPS-RECORDING`, `MUT-DURATION-OVERCLAIMS`.

`LIVE-SCRIBE-001` gains `MUT-BACKFILL-UNBOUNDED`; `LANG-PANELS-001` gains `MUT-FILL-HAMMERS-DEAD-SERVER`.

The browser suite starts a real recording, suspends the real `AudioContext`, and asserts that the warning appears, that the row is marked, that the recording is still running, and that the warning clears on resume. That was confirmed to fail with the watchdog removed. A suspended context is not the only way capture can stall, but it is the one that can be produced honestly in a test; the `mute` path is covered by the pure rules, and the two share the same response.

Release gate: 16 suites passed (strict gate)
