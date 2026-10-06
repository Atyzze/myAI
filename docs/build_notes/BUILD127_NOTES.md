# myAI Build 127

No code comments. The 125 comments in the application, its tests and its tools are gone: what a comment said about the code is now said by the names in it, and what it said about why is in `docs/ARCHITECTURE.md`. The static suite scans every file, so none come back. Going through the comments turned up one bug in the transcription log viewer, which is fixed. Database version stays at 13; the app behaves as in Build 126 apart from that fix.

## Comments became names

Where a comment explained a value or a step, the name now says it:

- The chain after a recording is `runInOrderUntilCancelled`, whose second argument is `reportFailedStep`.
- The live transcript save uses `LIVE_SNAPSHOT_MIN_INTERVAL_MS`, `LIVE_SNAPSHOT_MAX_INTERVAL_MS` and `LIVE_SNAPSHOT_MIN_GROWTH_SHARE`, and the heartbeat asks `liveTranscriptSizeAndSignature()`.
- The offline queue calls `releaseReviewAudioOfWaitingWindows(queue, keepNewest)`.
- A window's strike comes from `othersAnsweredSinceLastFailure`.
- Speaker clustering adds each line with `addToRunningCentroid`, which keeps a `runningSum`.
- The transcription pool shrinks when `requestsAreQueuing`, beyond `POOL_ANSWER_SHOWS_QUEUING_MS`, re-reads `limitNow()` as chunks finish, and waits `CHUNK_RETRY_DELAYS_AFTER_TIMEOUT_MS` before resending a chunk that timed out.
- The translation fill takes `waitBeforeEachRequest`, which the app sets to `waitWhileAnyReplyRuns`, and keeps `unansweredBatchesToRetryAtEnd`.
- Translation boxes queue at most `TRANSLATE_QUEUE_MAX_LINES` at once, and a failure `countsAgainstLines` only when it is the model's own answer.
- A window with `nothingSaid` is no evidence of a language.
- A reply's first word gets `FIRST_BYTE_WAIT_WHEN_MODEL_RELOADS_MS` when `modelReloadsForLargerContext`.
- The list repaint uses `audioToKeepAcrossRepaint`, `moveKeptAudioIntoRebuiltRow`, `titleEditToKeepAcrossRepaint`, `moveTitleEditIntoRebuiltRow` and `refocusMovedTitleEdit`. A job that ends calls `repaintIfRowRebuiltDuringJob`, and the player paints with `paintPlayerHoldingThisAudio`.
- The page's key handler ignores a key already `handledCloserToElement`, and an open dialog moves the focus back inside when it is `focusOutsideControls`.
- The record button stays on its saving label while `stopStillSaving`.
- An open tab runs `scheduleRecoveryOfClosedTabRecordings`.
- Showing 📝 again stops the old session with `keepRowsOnScreen: true`.
- The viewers use `oncePerFrameScheduler` with `FRAME_FALLBACK_TIMER_MS`. The log viewer uses `rerenderFrom` and stops once `laterChunksUnaffected`. The reply viewer keeps `gatheredTokens`, writes them with `writeGatheredTokensOnNextFrame` and `appendToGrowingTextNode`, and caps each node at `REPLY_TEXT_NODE_MAX_CHARS`.

The empty `catch (_) {}` blocks no longer carry the double space where a comment used to be.

`docs/ARCHITECTURE.md` now also says the rest:

- how a closed tab's recording is recovered;
- when the live transcript is saved while recording;
- what a queued live window holds;
- how the viewers use frames;
- why a long-context reply waits longer for its first word;
- what a repaint of the list keeps;
- how the journeys suite serves a second build and fakes Ollama.

A new section says there are no code comments and how that is checked.

## The log viewer lost a chunk that moved later

When the transcription log viewer received a chunk again with a later start, it rendered the log again from the top, but stopped at the first chunk whose last 40 words were unchanged. With chunks longer than 40 words, which is any minute of speech, that was before the moved chunk's new place, so the chunk vanished from the view. This can happen when a recording is transcribed again with a different chunk plan while the viewer is open, such as a transcription that fills gaps after one of the whole recording. A moved chunk now renders the log whole once; every other chunk still renders only itself and what follows until nothing changes.

## Tests

- `static-integrity`: no file under `src/`, `tests/` or `tools/`, nor `sw.js` or `index.html`, has a comment. The scanner, `tests/helpers/comment-scan.mjs`, tells comments apart from URLs, strings and regular expressions, and looks inside the browser code the tests send as text. Before the scan runs, the suite checks the scanner finds line, block, template, Python and HTML comments and passes over a URL, a string and a regular expression. On Build 126 it finds all 125 comments.
- `live-view-unit`: a chunk sent again with a later start is shown once, at its new place, among chunks of 50 words. This fails on Build 126.
- `user-journeys`: each journey is named with `journey(...)`, and a failure says which journey it was in.
- The comments in the tests also became names:
  - `simulateOneAtATimeServerOnVirtualClock`, with `SERVER_MS_PER_CHUNK` and `REQUEST_LIMIT_INCLUDING_QUEUE_MS`;
  - `advanceVirtualClock`;
  - `CountingNode` and `countingDocument`;
  - `isTranslationBoxMarkup`;
  - `recordOnDiskThatStaysFullExceptHeartbeat`;
  - `copyPiecesIntoAbandonedRecording`;
  - `NEXT_SCHEMA_BUILD_PREFIX` with `withDatabaseVersionRaised`;
  - the fake Ollama's `loadedCtx`, `reloadInProgress` and `CTX_A_LONG_REPLY_LEFT_LOADED`.

## Contracts

- `CODE-HAS-NO-COMMENTS-001`. Guards `MUT-CODE-COMMENT-ADDED`, `MUT-TEST-COMMENT-ADDED` (a comment inside browser code sent as text) and `MUT-TOOL-COMMENT-ADDED` (a Python comment in the release tool).
- `LOG-VIEWER-MOVED-CHUNK-001`. Guard `MUT-LOG-LOSES-MOVED-CHUNK`.
- 31 existing guards are re-pointed at the renamed code.

129 contracts and 333 mutation guards in all.

Release gate: 18 suites passed (strict gate) in 6 min 38 s; slowest user-journeys (2 min 26 s)
