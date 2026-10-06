# myAI Build 118

A pasted context item can now be 100,000 characters, typed or pasted into a box of the app's own when the clipboard cannot be read, and a paste that large still reaches the AI reply. Database version stays at 12.

## A real box instead of the browser prompt

When the clipboard could not be read, 📋 fell back to `window.prompt()`. That is a single-line field: it flattened line breaks, and some phone browsers truncate what it accepts well before the app's own limit. It also only appeared when reading the clipboard failed outright; an empty clipboard ended in an alert.

Both cases now open a dialog with a multi-line text box, a running character count and Use this text / Cancel. The box sets no length limit of its own, keeps line breaks and indentation, and says how much will be kept. Cancel, Escape or tapping outside start nothing. It works the same during a recording, where the text is added to that recording.

## 100,000 characters

The cap on a pasted context item rises from 20,000 to 100,000 characters. A longer paste is still cut at the cap, and its label says so.

## A paste that large still reaches the AI

The reply prompt has a 32,768-token context with 4,096 kept for the answer. When the prompt was too long, whole context items were dropped, oldest first, until it fitted. Measured with the app's own budgeting, a single pasted item of up to about 80,000 characters fits; at 100,000 it was dropped entirely, and the AI would have seen only the spoken note.

Dropping oldest first is kept while there is more than one item. When a single item is too big on its own, it is now shortened to the room left once the instructions and the transcript are in: its beginning and end are kept, the middle is replaced by the existing "content condensed to fit model context" marker, and the transcript is never cut to make room for it. Only if the transcript leaves less than 512 tokens is the item dropped as before. The reply status says the context was condensed, as it already did when items were dropped.

A context item lives on the recording row, which the three-second heartbeat rewrites during a recording, so a 100,000-character paste adds about that much to each heartbeat write. That is accepted for now; moving context to a store of its own, as Build 103 did for the live transcript, would remove it.

## Tests

`pure` checks the new cap, that a 100,000-character multi-line paste is kept whole, and that a single oversized context item is shortened to fit with its ends and the transcript intact rather than dropped. `user-journeys` makes the clipboard refuse, checks that cancelling the box starts nothing, fills it with 100,000 characters over 5,000 lines, and checks that the recording keeps all of it.

## Contracts

- `PASTE-BOX-100K-001`. Guards `MUT-PASTE-BOX-IS-PROMPT`, `MUT-CLIPBOARD-CAP-20K`, `MUT-BIG-PASTE-DROPPED`.

Release gate: 18 suites passed (strict gate)
