# myAI Build 120

Five bugs found in a review of Build 119, and two corrections to Build 119 itself. Database version stays at 12.

## Turning on 📝 during an Opus recording shortened the saved recording

Build 102 made a recording claim no more audio than arrived: the heartbeat stores `capturedMs`, counted from the samples the audio worklet delivers, and finalization saves the smaller of that and the wall clock. In Opus mode the worklet is only attached when live transcription is on. Turning 📝 on partway through attached it then, so `capturedMs` counted only the audio since the tap, and a recording with 📝 turned on after an hour was saved as long as the time since. The audio itself was intact; the list, the file name, the WebM duration the player seeks in, and the range the post-stop gap filling covers all used the short figure.

The recording now notes the audio clock (`AudioContext.currentTime`) when it starts. When the worklet is attached to an Opus recording that is already running, the samples the audio graph rendered before the tap are counted first (`samplesBeforeTap`). The audio clock only advances while the graph runs, so a recording whose audio was suspended before the tap is still not given credit for the suspension. WAV recordings, and Opus recordings with 📝 on from the start, attach the worklet before the clock is noted and are unchanged.

## Hiding and showing live transcription mixed up lines

During a recording, 📝 hides and shows live transcription. Showing it again resumed the session: it kept the lines, but restarted the counters line keys are made from (`w0:0`, `b0:0`, `cmd-0`) and threw away the translations, languages and speaker evidence that are looked up by those keys. New lines then reused the keys of old ones. In the translation boxes a line could show another line's translation, including in the saved transcript, the boxes disappeared until the languages were heard again, and with speaker labels on, lines from before the pause changed speaker and the numbering restarted.

Every line key now names the session it came from (`w<epoch>.<index>:<n>`, and the same for backfill and notices), so no key is reused. Live state is one `freshSession()`, used for the initial state and for every start, and a resume carries an explicit list of per-line state across (`RESUME_CARRIES`: the lines, archived lines, coverage, translations, languages, speaker evidence and suggestions). This also removes the second, hand-kept list of fields that every start reset, which new fields had to be added to by hand. A backfill and a translation now belong to the session that started them: one still running when the session is replaced stops instead of writing into the new one, and no longer blocks the new session's backfill.

## Completing the translations after a recording lost its breaker

Build 102 gave `fillTranslations` a breaker: a server that does not answer is not asked once per line, and three unanswered requests in a row stop the fill and say so. The helpers were still imported but no longer called, so with Ollama down a recording's fill sent one request per line, and it could not be cancelled.

The loop is now `fillMissingTranslations` in `transcribe-core.js`, with the translator passed in, so it is tested without a server. A server that answers in the wrong shape is still asked line by line; one that does not answer counts against the breaker and is never asked per line; three in a row stop the fill, and the recording shows "Stopped completing the other languages". The fill is a job, so deleting the recording, or cancelling its AI work, stops it.

## The live header pushed 📋 and ✕ off a phone screen

Every piece of information in the live transcription header kept its full width, and only the status line could shrink. On a phone the speaker and language details pushed 📋 and ✕ past the edge of the screen, where they could not be tapped, and squeezed the status ("📡 reconnecting…") to zero width. The screenshot that started Build 119 shows it: "one voice so far · 8 sam…" and no buttons.

The details now share one line that shortens itself with an ellipsis, 📋 and ✕ keep their size, and the status gets a line of its own under them when it has something to say. Below 480px the title reads "📝 LIVE" and the "hearing you" label, which repeats the level meter, is hidden.

## 📋 copied a different transcript than the one saved

The copy left out lines that had scrolled out of the live view (after roughly an hour of speech) and included notices such as "Not recording sound right now" as if a speaker had said them; the saved transcript did the opposite. Both are now built from one snapshot (`transcriptSnapshot`): every line from the beginning, in time order, without notices, with the translations of lines that scrolled out of view kept. The copy's translation sections also no longer mark lines already in that language as "not translated".

## Correction to Build 119: a translation that ran out of time was treated as a cancel

`translateLines` stopped a slow request by aborting it, which is exactly what a cancelled one looks like, and live translation ignores cancels. So a batch that ran out of time was resent at once, at the same size, forever: no pause, no lines given up, and no word in the box heading. Build 119 made this quieter by counting only successful batches as timing, so the slow-model check could never see it.

Running out of time is now its own error (`TranslationTimeout`), and the time allowed grows with the batch: 20 seconds plus 3 seconds per line, instead of a flat 45. Live translation treats it as a failure (`planTranslationFailure`): the batch is retried at half the size after a pause, its lines count an attempt, the box heading says "AI model too slow" rather than "server not answering", and the batch counts as a timing sample at least that slow, so the check for a model spilling onto the CPU can run.

## Correction to Build 119: long recordings still reloaded the model

Build 119 said only a reply too large for 16,384 tokens, "such as a very large pasted context item", would ask for 32,768. In fact the reply to any English recording over about 41 minutes did. The estimate counted every character, spaces included, at three characters per token, while real tokenizers read English at about five. The same estimate undercounted numbers, logs, encoded text and scripts such as Greek, and a prompt sent into too small a context is shortened silently by Ollama from the start, which is where the AI instructions and context are.

`estimateTokens` now counts by kind of character: spaces are free, Latin letters count 3.3 to a token, digits, symbols and new lines one each, runs of 16 or more characters mixing letters and digits (hashes, base64) one per character, Cyrillic half a token, Arabic and Hebrew 0.6, and other scripts one per character. Measured on sample text, English comes out at about 3.7 characters per token, where real tokenizers read about 5, Dutch at about 3.8, where the Qwen tokenizer reads about 3.6 (the 4,096 tokens kept for the answer absorb the difference), and tables and encoded text at about one. The reply to a recording keeps the shared 16,384-token context up to about 50 minutes of English speech, and a 100,000-character pasted table is now condensed to fit instead of being cut by the server.

A reply that truly needs 32,768 still asks for it and reloads the model once; the next live translation's warm-up loads it back in its first seconds.

## Tests

- `pure`: the tap counts the audio before it; a resume carries the per-line state and nothing else; the snapshot starts at the beginning, in time order, without notices, and keeps baked translations; the fill loop asks a dead server exactly three times, retries a misaligned server line by line, and stops at once when cancelled; timeouts grow with the batch, are not cancels, and plan a smaller batch after a pause; the estimate for English, Dutch, tables, encoded text, Greek and emoji, and the context chosen for a 45-minute English recording.
- `translate-request`: a request that runs out of time throws `TranslationTimeout`, and a real cancel is still an `AbortError`.
- `live-scribe-unit`: with speaker labels on, every line from before a hide and show keeps its speaker; after an hour's worth of text, 📋 copies every saved line and no notice.
- `static-integrity`: the fill goes through the loop and is a job; failed live batches go through the failure plan; stale translations cannot touch a new session; the copy and the saved transcript share the snapshot; every line key names its session; the header layout; the tap is counted for Opus.
- `user-journeys`: an Opus recording with 📝 turned on after 3 seconds is saved at its whole length; at 360px wide with a long speaker line, 📋 and ✕ are on screen and the status has a line of its own; after a hide and show during live translation, every saved line carries its own translation and 📋 copies every saved line. Against Build 119 all of these fail: the recording was saved as 2.5 seconds, ✕ sat at x=1175 on a 360px screen, and a Dutch line carried the translation of an English one from the other session.

## Contracts

- `REC-DURATION-LIVE-TAP-001`. Guards `MUT-TAP-COUNTS-NOTHING`, `MUT-TAP-FORGETS-EARLIER-AUDIO`.
- `LIVE-RESUME-KEEPS-LINES-001`. Guards `MUT-RESUME-FORGETS-SPEAKERS`, `MUT-RESUME-DROPS-TRANSLATIONS`, `MUT-RESUME-REUSES-KEYS`.
- `FILL-BREAKER-WIRED-001`. Guards `MUT-FILL-NEVER-GIVES-UP`, `MUT-FILL-NOT-A-JOB`.
- `LIVE-HEAD-FITS-PHONE-001`. Guards `MUT-HEAD-SQUEEZES-STATUS`, `MUT-HEAD-DETAILS-PUSH`.
- `LIVE-COPY-MATCHES-SAVED-001`. Guards `MUT-COPY-SKIPS-ARCHIVE`, `MUT-COPY-KEEPS-NOTICES`.
- `TOKEN-ESTIMATE-BY-CLASS-001`. Guards `MUT-SPACES-COUNTED`, `MUT-CODE-RUNS-AS-WORDS`, `MUT-DIGITS-CHEAP`.
- `TRANSLATE-TIMEOUT-001`. Guards `MUT-TIMEOUT-READ-AS-CANCEL`, `MUT-TIMEOUT-NOT-SLOWER`, `MUT-TIMEOUT-FLAT`, `MUT-STALE-TRANSLATION-FINALLY`.

`MUT-PANEL-SILENT-ABOUT-WHY` is re-pointed at the heading line that now also names a slow model.

Release gate: 18 suites passed (strict gate)
