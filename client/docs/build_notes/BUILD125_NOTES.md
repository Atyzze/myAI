# myAI Build 125

Fixes for the things that could get stuck or show the wrong state: a live window the server keeps failing on, translation boxes after an outage, languages guessed from silence, the work after a recording when it is cancelled, the translation fill queued behind a reply, a tab's own save, recordings left by a closed tab, and list repaints that stopped playback, dropped a half-typed title or left a button on "Working…". Database version stays at 13.

## A live window the server keeps failing on

Live lines are released in window order. When the server failed on one window every time (an HTTP 500 on that audio, say) while it answered the others, that window was retried for the rest of the recording and every line after it waited behind it, so the live transcript stopped for good; the lines held back also kept their audio in memory. A window now gets a strike each time it fails while other windows are being answered, and after two it is let go: the next line gets a gap mark, the transcript says "the server kept failing on 0:20-0:24 while it answered the rest; that part is transcribed after the recording", and the transcription after the recording fills it. A failure while no window is answered is an outage, not the window's fault, and costs it nothing: it waits in order as before.

The gap mark also lands where it belongs now. A window dropped from the view marked the next window created, which could be several windows later; it now marks the next line released. After a gap, the repeated-words check no longer compares the windows on either side of it.

In the review's five-minute simulation with one window always failing, Build 124 showed 5 lines after 44 seconds and still 5 after 300, with 181 requests for that one window; Build 125 shows 74 lines, the window tried 7 times. In the unit test, Build 124 saved only the line before the failing window; Build 125 saves the seven others.

## Translation boxes after an outage or behind a slow model

Three things combined to strand lines in the translation boxes:

- The boxes only looked at the newest 80 lines for work, but counted every line as waiting, so after a long outage the older lines said "waiting" forever.
- Every failed request counted as an attempt against every line in it, network errors included, and a line is given up after three, so even a 32-second outage marked a line "not translated" for good.
- The wait between failed requests grew to a minute, and was not reset when the connection came back, so translation resumed 40 to 50 seconds after the server was back.

Now the boxes take the newest lines still to translate first and then work back through older ones, however far up they scrolled. Only the model's own answer counts against a line: an empty or reasoning-only reply, or a single line it cannot finish in time. A server that is down, refuses or times out on a batch costs the lines nothing. The wait between failures is at most 15 seconds, and is cleared when the browser comes back online.

In the review's simulation, a 32-second outage left a line "not translated" on Build 124 and none on Build 125, which caught up within 12 seconds of the server's return. A 400-second outage left 17 and 16 lines waiting in the two boxes forever and 34 lines without a translation in the saved result on Build 124; none on Build 125. In the unit test with a one-minute outage, Build 124 gave a line up and caught up 24 seconds after the server returned; Build 125 gives none up and catches up after 8.

## Languages from silence

The server tags every window with a language, also a window with nothing said in it, and the first language heard got a box without any evidence. A silent first window tagged English in a Dutch meeting therefore opened an English box, and every Dutch line was sent to the model to be translated into English. A window with no words is now no evidence of its language, and the first language needs the same evidence as the others: about a sentence, in two stretches of speech. Other languages are named in the first established language, not in whatever was tagged first. On Build 124 that meeting showed "EN · NL", two boxes and 8 translation requests; on Build 125 it shows "NL", no boxes and no requests.

Lines transcribed from the audio before 📝 was turned on now carry the language they were spoken in. Before, they had none, so no box translated them, they were not counted as waiting, and the copied transcript showed them untranslated in every language section. They also count as evidence of their language.

## Cancelling the work after a recording

A stopped recording runs its automatic transcription and reply, then the cleanup pass. The automatic pipeline swallowed a cancel, so pressing ✕ on its progress bar, or deleting the recording, stopped the transcription and then started the cleanup pass, which transcribed the whole recording again, with no progress bar and no ✕ of its own. A cancel now ends the chain. The cleanup pass does not start on a recording being deleted, and shows its progress with a ✕ like any transcription.

A transcription or reply only existed as a job once its recording had been read and, for a reply, its model looked up, so a ✕ pressed in that moment was ignored. Both are jobs from their first moment now.

In the browser test, Build 124 (with the same chain exposed) ran the cleanup pass after the ✕ and stored its transcript; Build 125 stores nothing.

## The translation fill and the reply

After a recording with translation boxes, the fill completes the lines the boxes did not translate. It started together with the automatic reply, and both use the one AI model: on a server that answers one request at a time, a fill request queued behind a long reply ran out of time, and was counted missing. In the review's simulation, a 200-second reply cost 48 of 150 lines; a 300-second one tripped the fill's stop ("the reply server did not answer 3 requests in a row") with 126 lines left, and its message was then wiped by the reply, which clears a failed automatic step.

The fill now waits while any reply is running, tries a batch the server did not answer once more at the end, and reports a stop in a notice of its own on the recording, which the next transcription or reply does not wipe. In the same simulation all 150 lines are translated with either reply. In the browser test, Build 124 sent 2 translation requests while a reply was running; Build 125 sends none, and translates both lines once the reply has finished.

## A tab's own save, and a closed tab's recording

While Stop saved a recording, the list in that same tab showed it as "LIVE · OTHER TAB ... Stop it in the tab that owns the microphone", and the record button, still disabled, read "Start Recording". The row now says "💾 Saving…", a recording another tab is saving says "Saving in another tab…", and the button keeps saying the recording is being saved until it is.

A recording whose tab was closed or crashed was only recovered when a page was loaded, so a tab that stayed open showed it as "Recovering recording..." forever, with no buttons. A tab that stays open now recovers it: soon after the other tab's recording disappears, and every minute. Until then the row says "Interrupted, waiting to be recovered", with **Recover now** and **Delete**. A recording whose save failed is still retried only at startup or with its own Retry button. In the journey test, Build 124 showed the interrupted recording as "Recovering recording..." without buttons and did not recover it; Build 125 does.

## List repaints

The list is repainted when something about a recording changes, sometimes while it is in use:

- A repaint rebuilt the player and let go of its audio, so a recording being played stopped, and one that was paused started from 0:00 again. A repaint while audio plays waited for the pause, which is exactly when the place in the recording was lost. The audio element now moves into the rebuilt row, so playback goes on and a paused recording keeps its place.
- A title being typed disappeared with its row. The input now moves into the rebuilt row too, still focused, with the text typed so far.
- A repaint during a transcription or reply built a new row whose button showed the job as running. When the job failed, or a reply finished, only the old button was reset, so the button on screen stayed on "Working…". The row on screen is now repainted when such a job ends.

In the journey test, Build 124 stopped playback at a repaint (paused, at 0:00), lost the half-typed title, and left the Scribe button on "📝 Working…" after a failed transcription; Build 125 keeps all three.

## Keyboard

Enter on a transcript preview or a context title was handled twice, so it opened two views. Shift+Tab from an opened Settings or Help panel, where focus starts, left the dialog for the page behind it, and the paste box had no Tab trap at all. Each key is now handled once, and Tab and Shift+Tab stay inside an open dialog, the paste box included. On Build 124 Enter opened 2 views, Shift+Tab went to the version label and Tab left the paste box for the page.

## Tests

- `pure`: a window failing while nothing is answered keeps its place for 50 failures; one failing while others are answered is given up after two strikes. Older lines are queued once the newest are translated. A refused, unreachable or timed-out batch does not count against its lines; a single line that times out, or an answer without a translation, does. The wait between failures is at most 15 seconds. A window with no words is no evidence; a mislabelled short reply does not become the first language. A cancelled step ends the chain after a recording and is not reported as a failure; jobs of one kind are found across recordings. The fill tries an unanswered batch again at the end, and sends nothing while held back.
- `live-scribe-unit`: with the server failing one window, the seven other windows are shown, the failing one is tried at most six times, left out of the coverage, noted in the transcript and marked on the next line. On a virtual clock with two translation boxes, a one-minute outage of the AI server marks no line "not translated" and the boxes catch up within 20 seconds. A silent first window tagged English opens no box in a Dutch meeting. Backfilled lines carry their language.
- `static-integrity`: the recovery and repaint wiring; the chain; jobs that begin before their first wait; the cleanup pass's delete check and progress bar; the fill waiting for replies and its own notice; the saving label and the button; recovery in an open tab; audio and title edits carried across a repaint; the repaint after a job; Enter handled once; the dialog Tab traps; the online reset of the translation wait.
- `browser-lifecycle`: ✕ during the automatic transcription of a stopped recording stops the cleanup pass; the fill sends nothing while a reply runs and then completes both lines.
- `user-journeys`: the saving label and button during Stop; an interrupted recording offered for recovery and recovered in the open tab; playback, a paused position and a half-typed title kept across repaints, and Enter saving the title; the Scribe button usable after a failed transcription; Enter opening a preview once; Shift+Tab in Settings and Tab in the paste box staying inside.

Against Build 124, every suite named here fails on its new tests; the results are given in the sections above.

## Contracts

- `LIVE-POISON-WINDOW-001`. Guards `MUT-POISON-WINDOW-RETRIED-FOREVER`, `MUT-OUTAGE-STRIKES-WINDOWS`, `MUT-SKIPPED-GAP-ON-LATER-LINE`.
- `TRANSLATE-NEVER-STRANDED-001`. Guards `MUT-TRANSLATE-RECENT-WINDOW-ONLY`, `MUT-OUTAGE-BLAMES-LINES`, `MUT-TIMEOUT-BATCH-BLAMED`, `MUT-TRANSLATE-BACKOFF-MINUTE`, `MUT-ONLINE-KEEPS-TRANSLATE-BACKOFF`, `MUT-SILENCE-IS-LANGUAGE`, `MUT-FIRST-LANGUAGE-FREE`, `MUT-BACKFILL-NO-LANGUAGE`.
- `AFTER-RECORDING-CANCEL-001`. Guards `MUT-CANCEL-DOES-NOT-STOP-CHAIN`, `MUT-AUTO-SWALLOWS-CANCEL`, `MUT-EARLY-CANCEL-IGNORED`, `MUT-REPLY-EARLY-CANCEL-IGNORED`, `MUT-CLEANUP-ON-DELETED`.
- `FILL-WAITS-FOR-REPLY-001`. Guards `MUT-FILL-COMPETES-WITH-REPLY`, `MUT-FILL-UNANSWERED-LOST`, `MUT-FILL-NOTE-AS-PIPELINE-ERROR`.
- `SAVING-AND-RECOVERY-SHOWN-001`. Guards `MUT-OWN-SAVE-SHOWN-AS-OTHER-TAB`, `MUT-START-LABEL-WHILE-SAVING`, `MUT-NO-OPEN-TAB-RECOVERY`, `MUT-INTERRUPTED-WITHOUT-ACTIONS`.
- `LIST-REPAINT-KEEPS-STATE-001`. Guards `MUT-REPAINT-STOPS-PLAYBACK`, `MUT-REPAINT-DROPS-TITLE-EDIT`, `MUT-BUTTON-STUCK-AFTER-REBUILD`, `MUT-ENTER-OPENS-TWICE`, `MUT-DIALOG-TAB-ESCAPES`.
- Re-pointed at the changed code: `MUT-SEAM-LIMIT-NOT-PASSED`, `MUT-LIVE-STALE-WINDOW-LANDS`, `MUT-TRANSLATE-OLDEST-FIRST`, `MUT-AFTER-RECORDING-PARALLEL`, `MUT-RECOVERY-READS-ALL`, `MUT-STATE-NOT-ANNOUNCED`.

124 contracts and 309 mutation guards in all.

Release gate: 18 suites passed (strict gate) in 6 min 13 s; slowest user-journeys (2 min 27 s)
