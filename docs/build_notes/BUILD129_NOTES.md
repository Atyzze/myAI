# myAI Build 129

A new build waits until you reload into it, so an open tab never runs files of two builds, and an install that fails says so instead of showing "Installing" for good. Pop-up views run no script and receive no messages. Audio is converted to 16 kHz through a proper low-pass filter, in a worker. Twenty-nine checks that only read source text now run the code instead, their number can only go down from here, and none of the remaining ones depends on indentation. Database version stays at 13.

## Updates

In Build 128 a new service worker took over the moment it had installed (`skipWaiting` and `clients.claim`), including in tabs that were already open. Those tabs went on running the old modules while the new build served them, and every pop-up view they opened loaded `live-view.js` from the server, which after a deploy is the new build's. And an install that failed left the version badge on "Installing v129..." with its button disabled until the page was reloaded, because nothing listened for the new worker becoming redundant.

- A new build installs next to the one serving and waits. The badge offers it ("v129 › v130", "Reload into v130"); tapping asks the waiting worker to take over, waits for it, and reloads. Other open tabs are not reloaded under their user: they are served by the new build from then on and offer to reload into it.
- The page follows an install to its outcome, also after the check that found it has ended, and also one the browser starts by itself: installed and waiting, taken over, or failed. A failed install shows "v129 ⚠" and "Try installing v130 again", which tries again.
- The shell is installed whole or not at all: every file is fetched, its body read at once into a response of its own, and only then stored. Reading the bodies at once matters: in Chromium, a first version of this that held every response until all were fetched stalled after three files and never finished installing, because a response left unread holds its connection. The copy also drops a redirect: where the server sends `index.html` on to `./`, Build 128 stored the redirected response, and the browser refused it for every later navigation, so the app did not load at all.
- A worker that replaces one of a build before 129 still takes over by itself, because the pages of those builds cannot ask it to. The real Build 128 page updates to this build as it always did: its tabs show "v128 › v129" and reload into it.
- A tab loaded past the worker (a hard reload) runs the newest build from the network. It is no longer offered "Reload into" the older build still serving, and its own build, waiting, takes over, so the next ordinary reload of any tab does not land on the older one.
- Taking over deletes only the shells of older builds, not one a newer build is installing at that moment.
- A tab loads nothing after it has started. Its resampling worker (below) starts with the page, so its script comes through the service worker that served the page; one started on first use came from the new build once that had taken over, into a tab still running the old one.
- `src/js/live-view.js` stays on the server, out of the shell: the pop-ups of Build 128 tabs still open when this build is deployed load it from the network, and would otherwise fail to start. Nothing of this build loads it; it can go once no Build 128 tab can be open.

## Pop-up views

A live transcript or reply opened in a window of its own was a page that loaded a script, and the tab that opened it posted every line to it with `postMessage(..., '*')`, to whatever page the window showed. Now the window's page has no script and a policy that allows none; the opening tab draws into it with the same renderer as the in-page view, on the window's own animation frames, and posts it nothing. A window navigated to another site is let go at the next line, and one closed before its page loaded is let go without an error. Where the opening tab may not read the window at all, the window is closed and the view opens in the page instead.

## Audio at 16 kHz

PCM audio (live windows, WAV recordings, one chunk of a WAV) was converted to 16 kHz by playing it through an AudioBufferSourceNode into a 16 kHz OfflineAudioContext. Measured in Chromium, that conversion filters nothing: tones at 9, 12, 15 and 20 kHz in 48 kHz audio came out at 7, 4, 1 and 4 kHz at full level (0 dB), and from 44.1 kHz between 1.2 and 6.3 dB down. Everything between 8 and 24 kHz in a recording (sibilants, breath, fan and keyboard noise) folded back into the band the transcription server listens to.

`resample-core.js` low-passes just below 8 kHz with a Kaiser-windowed sinc and reads each output sample through a polyphase table: 0 to 6 kHz come through within 0.1 dB, 6.8 kHz is 1.4 dB down, and those same tones are held 79 to 104 dB down; between 8 and 9 kHz the filter is still closing (8.1 kHz is 50 dB down). A WAV recording is converted a chunk at a time as it is transcribed, each chunk read with the frames around it so its edges are filtered like the rest of it. Converting a minute of 48 kHz audio takes about a fifth of a second, which on the page would block it for that long per chunk, and several times as long on a phone; it runs in `resample-worker.js`, and in Chromium converting a minute leaves no main-thread task over 50 ms. Where no worker starts, the page does it a second of audio at a time. Compressed recordings are still decoded by `decodeAudioData` on a 16 kHz context, which already resamples through the browser's own band-limited resampler (12 kHz is 79 dB down there).

## Checks that run the code

The static-integrity suite reads source text, and 131 mutation guards were caught by nothing else. Twenty-nine of them now fail a suite that runs the code:

- `app-behaviour` (new): the real `db.js`, `settings.js`, `jobs.js`, `transcribe.js`, `reply.js` and `gui.js` over the in-memory IndexedDB. The database connection given up to a newer version, after which the tab knows it is older than the database, or kept while the tab is busy; the storage total; audio only a willing row takes; the startup sweep reading keys only; deleting everything with a backup offered first, when no backup was made and when the person has not confirmed it was saved; the backup naming audio it could not read; the background sweep never alerting, and not running during a backup; deleting a transcript or reply leaving other work running, and deleting a recording stopping its translation fill; the translation fill waiting for a reply; a reply making the model ready first, at the context replies share, and waiting for its first word as long as a larger context needs; the rows the list draws for a recording whose save failed and for one whose tab went away, with the actions they offer.
- `saved-transcripts`: a transcription cancelled before its audio was read does nothing more; two chunks at a time to start; a chunk the server fails once is retried.
- `storage-paths`: a compressed recording whose tab closed is saved from its pieces, with its audio in the audio store and not on the row; the cleanup pass skipping a recording being deleted; recovery looking unfinished recordings up by their state, and leaving alone one another tab still captures or saves again.
- `pure`: the state of an unfinished recording's row (below), and `live-view-unit`: the pop-up view.

`tests/baseline-contract.json` now records how many guards may be caught only by reading source text (`staticOnlyGuardCeiling`, 102), and the contract suite fails when there are more, or fewer without the ceiling lowered with them. The static checks find a function by its braces (`tests/helpers/source-blocks.mjs`) instead of by the indentation of its closing line, match a line break as `\n\s*`, and check themselves for any pattern that pins indentation.

The in-memory IndexedDB of the node harness gained a newer version opened by another tab (after which opening the old one fails, as in a browser), connections that it asks to close and that may refuse while busy, and a log of every request, with the index it walks.

## Code moved out of the UI

- `row-state-core.js`: what the row of an unfinished recording shows (recording, saving here or in another tab, capturing in another tab, save failed, being recovered, interrupted) and the actions it offers, decided from the recording, its beat and what this tab is doing. `gui.js` draws it.
- `finalize-core.js`: how a recording's row changes when it is saved or its save fails, from `recorder.js`.
- `update-core.js` gained the waiting and failed-install states; `resample-core.js` is new.

## Review

An independent review of this build, in Chromium, found four problems, all fixed above: Build 128 tabs losing their pop-ups once `live-view.js` was gone from the server; a hard-reloaded tab offering to reload into the older build; a newer build's shell deleted by an activation that happened while it installed; and the resampler running as long tasks on the main thread (236 ms for a 66-second chunk). It confirmed the real Build 128 page updates to this build, that two tabs tapping reload at once both land on the new build, and that nothing still resamples through an AudioBufferSourceNode.

A second review of the fixes and of the moved checks found: the resampling worker, started on first use, loading the new build's script into an old tab (it now starts with the page, and `shell-update` checks it); a mutation guard whose test now failed earlier than its expected message; one static check whose block the brace finder took too wide, and four patterns that still needed a closing brace at the start of a line (the self-check now looks for those too, and the static suite passes with the live-scribe functions it reads indented by four spaces); the in-memory IndexedDB letting a tab reopen at the old version after a newer one was opened (it now fails, as in a browser, and the test asserts the tab learns it is out of date); the buttons of a failed save's row no longer checked anywhere once the check moved to `row-state-core.js` (now checked on the row the list draws); and claims in these notes and the docs, corrected here. It found no change in behaviour in the two refactors: every combination of row states draws the same row as before, and the row changes on saving are a verbatim move.

## Tests

- New suite `shell-update`: Chromium with the real service worker, each scenario on an origin of its own: a new build waiting while another tab keeps its files and then taking over when asked, without reloading that tab, whose resampling worker stays its own build's; an install that fails and is tried again; a server that redirects `index.html`; a worker replacing one of a build before 129. With Build 128's `sw.js`, `version.js` and `update-core.js` the first three fail: the new build took over by itself, the failed install stayed "installing", and with the redirect the app did not load at all.
- `browser-lifecycle`: the pop-up pages have no script and a policy that allows none, and are posted nothing; a minute of 48 kHz audio reaches 16 kHz with no alias of a 12 kHz tone, in a worker, leaving no main-thread task over 120 ms.
- `service-worker`, `platform-unit`, `pure`: the install, the takeover, the redirect and the newer shells kept; following an install to its outcome, the reload that asks first, the waiting build at startup, a hard-reloaded page; the waiting and failed states; the resampler's pass band, alias rejection, lengths, odd rates and seams, and the conversion of live windows, WAV chunks and whole WAV files.
- `live-view-unit`: rewritten around what the pop-up shows instead of what it was posted.

## Contracts

- `UPDATE-WAITS-TO-BE-ASKED-001`. Guards `MUT-WORKER-TAKES-OVER-BY-ITSELF`, `MUT-OLD-PAGES-LEFT-WAITING`, `MUT-ACTIVATE-MESSAGE-IGNORED`, `MUT-WAITING-NOT-ASKED`, `MUT-RELOAD-BEFORE-TAKEOVER`, `MUT-WAITING-BUILD-FORGOTTEN`, `MUT-UPDATEFOUND-IGNORED`, `MUT-ACTIVATE-DELETES-NEWER-SHELL`, `MUT-UPDATE-OFFERS-DOWNGRADE`, `MUT-HARD-RELOAD-LEAVES-OWN-BUILD-WAITING`.
- `UPDATE-INSTALL-FAILS-001`. Guards `MUT-INSTALL-FAILURE-IGNORED`, `MUT-FAILED-INSTALL-OFFERS-FORCE`, `MUT-SHELL-PARTIAL-INSTALL`.
- `SHELL-REDIRECT-001`. Guard `MUT-SHELL-REDIRECT-KEPT`.
- `LIVE-VIEW-NO-MESSAGES-001`. Guards `MUT-POPUP-POSTED-TO`, `MUT-POPUP-FOLLOWS-NAVIGATION`.
- `AUDIO-RESAMPLE-001`. Guards `MUT-PCM-RESAMPLED-WITHOUT-FILTER`, `MUT-RESAMPLE-CUTOFF-AT-SOURCE`, `MUT-RESAMPLE-SEAMS`.
- `LIVE-VIEW-MOBILE-001` gains `MUT-POPUP-UNREADABLE-LEFT-EMPTY` and loses `MUT-POPUP-READY-MESSAGE`, whose handshake is gone; `CONTRACT-DRIFT-001` gains `MUT-STATIC-CEILING-RAISED`; `SAVING-AND-RECOVERY-SHOWN-001` gains `MUT-FAILED-ROW-BUTTONS-DROPPED` and `MUT-INTERRUPTED-ROW-BUTTONS-DROPPED`.
- Moved from `static-integrity` to suites that run the code: `MUT-CLOSED-CONNECTION-BRICKS-TAB`, `MUT-RECORDING-NOT-BUSY`, `MUT-STORAGE-COUNTS-TWICE`, `MUT-COMMIT-AUDIO-BEFORE-CHECK`, `MUT-LIVE-SWEEP-READS-ALL`, `MUT-LIVE-TEXT-OUTLIVES-DELETE`, `MUT-DELETE-AFTER-FAILED-BACKUP`, `MUT-BACKUP-NOT-AWAITED`, `MUT-BACKUP-HIDES-MISSING-AUDIO`, `MUT-SWEEP-ALERTS`, `MUT-DELETE-REPLY-CANCELS-ALL`, `MUT-FILL-NOT-A-JOB`, `MUT-FILL-COMPETES-WITH-REPLY`, `MUT-MODEL-PREFLIGHT-UNWIRED`, `MUT-REPLY-OWN-CONTEXT`, `MUT-FIRST-BYTE-FIXED` (`app-behaviour`); `MUT-EARLY-CANCEL-IGNORED`, `MUT-POOL-FIXED-TEN`, `MUT-CHUNK-RETRY-REMOVED` (`saved-transcripts`); `MUT-LIST-LOADS-AUDIO`, `MUT-CLEANUP-ON-DELETED`, `MUT-RECOVERY-READS-ALL`, `MUT-BEAT-IGNORED-BY-RECOVERY`, `MUT-STOP-NOTE-FATAL` (`storage-paths`); `MUT-OWN-SAVE-SHOWN-AS-OTHER-TAB`, `MUT-INTERRUPTED-WITHOUT-ACTIONS`, `MUT-FAILED-SAVE-UNREACHABLE` (`pure`); `MUT-POPUP-INLINE-SCRIPT`, `MUT-POPUP-CLOSED-STILL-TRACKED` (`live-view-unit`).

140 contracts and 390 mutation guards in all; 102 guards are caught only by reading source text, down from 131.

22 suites passed (strict gate) in 8 min 50 s; slowest mutation-guards (4 min 20 s)
