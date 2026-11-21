# myAI Build 146

A recording's text could only leave the app one piece at a time: the transcript, a reply, or one context item with its own 📋. To ask a bigger AI the same thing and compare its answer, the whole of it had to be pasted together by hand. A fourth button under a recording, 📑, now takes all of it in one go. Database version stays at 13; nothing stored changes.

## What the person sees

- 📑 sits fourth at the bottom of a recording, after 🗑️ Delete, 💬 Continue and 🔗 Link, on every recording that has a transcript or carries context.
- A tap on it does nothing to the clipboard yet. It opens three choices, each saying what it takes and how big it is:
  - **📋 Copy everything**: every context item (continued, linked and pasted, each whole), the transcript the recording shows, and the AI replies to that transcript, oldest first, each named with its model.
  - **🎤 Copy without AI replies**: the context items and the transcript only. This is exactly the prompt 🧠 Reply sends, AI instructions included, except that it is never shortened to fit the local model.
  - **📦 Download .zip**: a ZIP holding `recording.json`, with every context item, every transcript and every reply of the recording, structured.
- The AI's thinking is in none of them, neither the reasoning stored beside a reply nor reasoning a model wrote into its answer between `<think>` tags. The audio is not included.
- After a choice the box closes and 📑 shows ✓, or ✗ if the browser refused. Cancel, Escape or a tap beside the box closes it without doing anything.

## How

- `export-core.js` builds all three from the stored recording and nothing else. `buildRecordingCopy` starts from `composeFullPrompt` in `reply-core.js`, the prompt `buildBudgetedPrompt` begins with before it shortens anything, so the copy without replies is the reply's prompt by construction. With replies, each follows as `[AI REPLY · model]:`; a recording without context labels its transcript `[AUDIO TRANSCRIPT]:` so a reply after it cannot be read as part of it. `buildRecordingExport` makes the JSON (`format: "myai-recording"`, `version: 1`).
- `zipFiles` in `backup-core.js` writes a stored ZIP of small in-memory files with the same headers and checksum as the backup.
- `recording-export.js` opens the box. Both texts are built when it opens, so a choice writes the clipboard from its own tap; Safari refuses a clipboard write that first waits for the database.
- The copies use the transcript the row shows, the one 🧠 Reply and 💬 Continue use. The box counts context items as the row does.

## Tests

`pure`:
- The copy without replies equals the prompt 🧠 Reply sends, and carries every kind of context item and the AI instructions.
- Copy everything adds the replies to the shown transcript, oldest first, with their models, and nothing from another transcript.
- Neither copy nor the JSON holds the thinking, stored or inline.
- Context too long for the local model is copied whole.
- The JSON's fields, and a ZIP whose one entry holds it whole with its checksum.

`app-behaviour`:
- The row has four bottom buttons, 📑 the fourth; a recording with only context has 📑; one with no text has none.
- The first tap copies nothing. Each choice does what it says, and Cancel nothing. The downloaded ZIP holds `recording.json`.
- A tap through the app's own click handling opens the choices.

`user-journeys`: in Chromium, 📑 shows three choices and leaves the clipboard alone, Escape closes them, and Copy everything puts every context item, the transcript and the reply on the real clipboard, without the thinking.

Eleven new mutation guards cover the thinking copied (stored or inline) or exported, replies in the copy without replies, context dropped, the copy shortened, the wrong transcript, a ZIP without its checksum, the button missing, a copy on the first tap, and the button not wired.

22 suites passed (strict gate) in 12 min 07 s; slowest mutation-guards (7 min 02 s)
