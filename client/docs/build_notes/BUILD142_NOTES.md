# myAI Build 142

Two small changes to reading a reply. A thinking model's reasoning was only counted ("🤔 Thinking - 28 tok"), never shown. And the auto-scroll controls float over the bottom right of an opened text, so its last lines always sat under them, with no way to scroll them clear. Database version stays at 13.

## What the person sees

- While a thinking model reasons, its reasoning appears above the answer as it comes, in a grey block headed "🤔 Thinking · N tok". Once the answer begins, the heading reads "🤔 Thought · N tok" and the reasoning stays there to read.
- A tap on the heading folds the reasoning away, and another tap opens it again. It starts open. This works the same in the in-page view and in a pop-up window.
- A view opened while the model is still reasoning, or after it has started answering, shows the reasoning so far, not only its count.
- The reasoning is never part of the reply: it is not stored, copied or exported with it.
- An opened text with auto-scroll controls has room after its end the height of the controls and a little more, so scrolled to the bottom its last line sits above them. The room follows the controls when the window or the footer changes size and goes when they do. A text opened at its end still shows its end, so ▶ there still starts again from the top.

## How

- `createReplyStreamReader` passes each piece of reasoning on with its text; `runSummary` hands it to `replyStreamThinking(recId, count, generation, text)`, which keeps it (`thinkingText`) so the snapshot a later view replays carries the reasoning so far, before the answer.
- `createReplyRenderer` puts the reasoning in a `<details class="reply-thinking">` inserted before the reply text, written once a frame like the answer and without its opening line break. A `<details>` folds with no script, which a pop-up page does not have. A reset removes it.
- `attachAutoScroll` adds bottom padding to the scrolling element: what it already had, plus the distance from the controls' top to the element's bottom, plus 12 px (72 px when there is no layout yet). It is measured again on resize, a view that was at its end is kept at its end, and the padding is given back when the controls are removed.

## Tests

`pure`: each piece of reasoning carries its text. `live-view-unit`: a reply with no reasoning shows no block; reasoning is shown as it comes, above the answer, in a `<details>` that starts open, without its opening line break, never in the answer text; the heading moves from thinking to thought when the answer begins; a reset clears it; a view opened later is replayed the reasoning so far before the answer. `app-behaviour`: the reasoning from a fake thinking model reaches the reply view. `browser-lifecycle`: in a real pop-up, scrolled to the end, the last line of a long saved reply sits above the auto-scroll controls, and a text opened at its end still starts again from the top.

Three new mutation guards: reasoning passed on without its text, the reasoning block starting folded, and a later view not replayed the reasoning.

GATE_RESULT
