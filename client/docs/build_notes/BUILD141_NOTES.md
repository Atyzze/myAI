# myAI Build 141

A reply that stopped short read as a whole one: the view said ✅ Complete and the recording showed nothing, whether the model had run out of room, the server had stopped sending, or the request had failed. And the notice on a recording whose microphone input ended could not be closed. Database version stays at 13.

## What was happening

- A reply streams from Ollama and ends with a final object that says why it stopped. When the stream ended without that object (the connection dropped, or the server stopped, which on a long context is often running out of memory), the app saved what had arrived as if it were the whole reply, with no notice of any kind.
- The reply view ended on "✅ Complete" whatever happened: after a cut-off, after a broken stream, after an error appended to the text, after ✕. A reply that stopped in the middle of a list looked finished.
- A thinking model (Qwen3 and the like) reasons before it answers and streams that reasoning in a field of its own, which the app ignored. For the minutes it thought, the view and the recording said only "Waiting for first token…", indistinguishable from a server that was not answering.
- Since Build 140 the reply code had already been changed, without a new build, to ask for the model's real context limit, to keep 10,240 tokens for the reply (thinking included) and to budget the prompt with the model's real token count, and to say when the context window or the reply limit stopped a reply. Those changes kept the build number 140, so a browser that had Build 140 kept using its stored copy and never ran them. This build carries them.
- The notice "Recording stopped because the microphone input ended unexpectedly. Audio captured before the failure was saved successfully." is stored on the recording, so it was drawn again on every repaint and every visit, with no way to remove it.

## What the person sees

- The reply view's status line ends on how the reply ended: "✅ Complete", "✂️ Cut off: context window full", "✂️ Cut off at the reply limit", "⚠️ Interrupted before the end", "⚠️ Failed" or "⏹ Stopped", with the size and model as before. A stored reply opens on the same status.
- A reply whose stream ended without the server saying it was done is kept, with a line at its end: the server stopped sending before the reply was finished, perhaps a dropped connection or a server out of memory on a long context, and removing or shortening context items helps.
- A cut-off or interrupted reply is marked on the recording, in its preview (✂️ Cut off, ⚠️ Interrupted) and in the list of its replies. A reply written from a context that had to be shortened to fit the model shows 🗜️ Context shortened.
- While a thinking model reasons, the recording says "🤔 Thinking… (tap to watch)" and the view "🤔 Thinking - model" with how many thinking tokens have come; the first word of the answer moves both on to streaming.
- The capture-failure notice on a recording has a ✕. A tap removes it from the stored recording, so it stays gone after the app is opened again. The audio and the "(incomplete)" in the name of a recording that lost audio stay as they are. A recording still being saved shows no ✕ and keeps its failure for the save.

Continuing a reply that was cut off is not offered: the prompt is now budgeted to leave the reply its full 10,240 tokens, so a cut-off should be rare, and its notice says what to shorten instead.

## How

- `replyOutcome(finish, { numCtx, numPredict })` turns how the stream ended into `{ state, reason, notice }`: complete, cut off (`context` or `limit`, from `replyCutoffReason`, which `describeReplyCutoff` now shares), or interrupted when no final object arrived. The notice is appended to the reply as before, and a reply that was not whole is stored with `end: { state, reason }`; a reply written from a condensed prompt is stored with `condensed: true`.
- `replyStreamDone(recId, generation, end)` carries the end to every view, and the snapshot a later view replays carries it too. An abort ends `stopped`, a failure `error`. `replyEndLabel` in `live-render` turns it into the status line.
- `createReplyStreamReader` reports `thinking` events, counted, until the first word of the answer; `runSummary` passes them to the view (`replyStreamThinking`) and once to the row as `__thinking__`.
- `dismissCaptureWarning` deletes `captureError` from the stored recording in one `dbUpdate`, refusing a recording that is still processing or being deleted, and repaints.

## Tests

`pure`: a stream with no final object is interrupted, with its notice; a finished reply is complete with none; a length stop is cut off by the context or by the reply limit; reasoning before the answer is reported as thinking, counted, never part of the reply text, and not after the answer has begun. `live-view-unit`: each end state is the status a reply ends on, and only a complete one reads ✅ Complete; a model still reasoning is shown thinking with its count, naming the model again keeps it so, and its first word moves it to streaming; a stored reply that was cut off opens saying so. `app-behaviour` (the real reply code over a fake Ollama, and the real list): a stream cut before its final object is stored as interrupted with what arrived and the notice, the view ends on interrupted, and the recording marks it in its preview and its list of replies; a reply the context window stopped is stored and marked cut off; a thinking model says so once before its first word, its reasoning is not stored, and a whole reply carries no mark; the capture notice offers ✕, a tap removes it from the stored recording and from the row and it stays gone when the list is drawn again from the database, the notice about lost audio goes the same way while the recording stays marked incomplete, and a recording still being saved keeps its failure.

Eight new mutation guards: an interrupted stream taken for complete, an interrupted reply stored without its end, a view that ends every reply on complete, the end not passed to the view, the recording not marking a reply that stopped short, thinking not reported, a dismissal that does not reach the stored recording, and a notice without its ✕.

GATE_RESULT
