# myAI Build 121

Phone speed and battery: the waveform, the preview requests, the live transcript's repainting after an hour, and the three-second heartbeat. Database version 13, which adds one small store and changes nothing already stored.

## The waveform

The recording waveform was drawn on every display frame, which is 60, 90 or 120 times a second on a phone, looked its canvas and drawing context up again each time, and rewrote the text of a frame counter on every frame. The counter ("60 FPS") was shown on every recording and forced visible in fullscreen, although it is debug output. Measured in headless Chromium during a real recording, the counter alone was about half of the drawing loop's cost, and drawing at 30 frames a second without it removed about three quarters of the loop's overhead.

The waveform is now drawn at most about 30 times a second (a frame less than 29 ms after the last one is skipped), with its canvas and context kept for the recording and the device pixel ratio capped at 2. The frame counter is shown only when debugging is switched on (`localStorage.setItem('myai-debug', '1')`, see `docs/OPERATIONS.md`), and then updates twice a second; fullscreen moves it with a class instead of forcing it visible.

With the live panel open, the 160px waveform sat on top of the panel and covered the recording's own row in the list: on a 393px-wide phone the row's clock and play button were under the canvas. While the panel is open the waveform is now a 44px strip, still tappable for fullscreen, and the page can scroll clear of the strip and the panel.

## Previews nobody saw

Live transcription sends a 4-second window every 4 seconds and, in between, previews of the words still being spoken. Measured on a virtual clock, previews were 60 of the 75 requests a minute and made the transcription server listen to 3.9 seconds of audio for every second recorded, on the same GPU that translates. With translation boxes on, previews are never displayed at all.

A preview is now requested only when it can be seen (no translation boxes), the app is in the foreground, someone has spoken since the last preview (the level meter's speech detection), and no window that settles the same words is about to be sent (4 seconds of audio less 0.6 seconds, with a request slot free). When the server is behind and no slot is free, previews carry on, because then the words are not settling. A preview that comes back unchanged no longer repaints the transcript. In the translation journey, 9 windows with boxes on took 17 requests on Build 120 and take at most 10 now.

## Repainting after an hour

With translation boxes on, the rows of each box were matched to the transcript by position. Once the 60,000-character cap starts dropping the oldest line, after roughly an hour of speech, every position mismatched and every row of every box was recreated on every window. Measured at the cap with two boxes, at 4× CPU slowdown: 700 to 811 ms per window and 2,360 elements created on Build 120; 101 to 189 ms and 12 elements now. Rows that are no longer wanted are removed first, so the rest keep their place, and a row's HTML is remembered in a `WeakMap` instead of a `data-html` attribute, which halves the size of the live view.

Without boxes, the transcript was rebuilt from one HTML string on every paint, previews included. It is now kept as the same keyed rows, with the preview in a node of its own. Measured at the cap at 4× slowdown: 40 to 127 ms per window before, 10 to 21 ms now.

## The heartbeat

Every 3 seconds a recording read and rewrote its whole row to say it was still alive. The row carries the recording's context items: a pasted item is stored twice, and typographic characters double its size again. With a 100,000-character paste that was measured at 115 to 180 MB of file writes an hour, 8 to 13 times the audio itself, and more for a long Continue chain.

The three-second heartbeat now writes one small record in a new store, `capture_beats`: owner tab, session, time, length so far and captured length. The row is rewritten when the recording's state changes, once a minute together with the live transcript snapshot, before finalizing (so it is finalized with its final length), and on every beat if the beat cannot be written.

Every check of whether a recording is still live reads the row and its beat together: the list's "live in another tab", deleting audio, text or a recording, the retention sweep, and recovery. A beat counts only for the recording, tab and session that own the row, so a leftover beat cannot keep a finished or recovered recording alive. Recovery takes the length and captured length from the beat, which can be up to a minute newer than the row, before it finalizes. A recording's beat is removed once it is saved, and startup removes beats whose recording is gone, finished or no longer owned.

The schema change is additive, like every one before it: a tab still recording on an older build keeps the database until it stops, and the new version then starts by itself.

## Tests

- `pure`: the preview gates; the row is written on a change of state, after a minute, when forced or after a snapshot, and not on an ordinary beat; schema 13 creates `capture_beats` on a new install and on an upgrade.
- `recording-lock-unit`: a row written a while ago is live while its beat is fresh; a beat from another tab, session or recording, or for a row nobody owns, is not.
- `live-scribe-unit`: when the oldest line scrolls out and a new one arrives, one row is created and the rest are the same nodes; a line removed from the middle is removed alone; without boxes a new window adds its row without rebuilding the others. The test's stand-in DOM now inserts, removes and serializes children like a browser.
- `static-integrity`: the frame cap, the debug-only counter, the thin strip, the preview gates, the rows without boxes, the beat written before the row, the forced last beat, and every liveness check reading the beat.
- `user-journeys`: with boxes on, 9 windows take at most 10 requests; on a 393px phone with the live panel open the waveform is at most 60px tall and the live row's clock can be tapped; during a recording carrying a 100,000-character paste, 9.5 seconds bring at least three beats and no rewrite of the recording, the recording is still seen as live, the frame counter is hidden, and the beat is gone once the recording is saved; a recording whose row is a minute old but whose beat is fresh is not recovered, and once its beat goes quiet it is recovered with the length its beat recorded. Against Build 120 all of these fail: 17 requests for 9 windows, a 160px waveform over the row's clock, three rewrites of the recording, and a visible counter.

## Contracts

- `WAVEFORM-LIGHT-001`. Guards `MUT-FPS-ALWAYS-ON`, `MUT-WAVE-EVERY-FRAME`, `MUT-WAVE-COVERS-ROW`.
- `PREVIEW-ONLY-WHEN-SEEN-001`. Guards `MUT-PREVIEW-FOR-BOXES`, `MUT-PREVIEW-IN-SILENCE`, `MUT-PREVIEW-BEFORE-WINDOW`.
- `LIVE-ROWS-KEYED-001`. Guards `MUT-ROWS-REBUILT`, `MUT-SINGLE-INNERHTML`.
- `HEARTBEAT-BEAT-STORE-001`. Guards `MUT-HEARTBEAT-ROW-EVERY-BEAT`, `MUT-BEAT-IGNORED-BY-RECOVERY`, `MUT-BEAT-FROM-ANY-TAB`, `MUT-ROW-DUE-NEVER-REFRESHES`, `MUT-DELETE-IGNORES-BEAT`.

Release gate: 18 suites passed (strict gate)
