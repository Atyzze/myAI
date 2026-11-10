# myAI Build 144

Two things. A thinking model's reasoning was shown while its reply streamed, then gone for good: it was never stored, so reopening the reply showed only the answer. And Settings had grown long, with dropdowns for settings that are only ever on or off. Database version stays at 13, and no stored setting changes its value or its key.

## What the person sees

- A reply from a thinking model keeps its reasoning. Opened again from the list, in the in-page view or a pop-up, the reasoning sits above the answer, folded, under "🤔 Thought · N tok"; a tap opens it. While a reply streams it still starts open, as in Build 142.
- The reasoning is still never part of the reply: it is not copied, not used as context for the next conversation, and not in the reply's preview.
- Settings:
  - Every setting with two values is an on/off switch instead of a dropdown: live transcription at the start, uncompressed WAV, compact GUI, auto-transcribe, auto-reply, speaker labels, and suggesting speakers' names.
  - It is grouped under Recording, After a recording, Speakers and translation, AI replies, Your data, Automatic deletion and Server.
  - Long explanations are folded under "More".
  - Auto-reply shows only while auto-transcribe is on, the Opus quality only while recording Opus, and how speakers are named and how many are told apart only while speakers are labelled; each keeps its value while hidden.
  - Nothing was removed: every setting, every choice and every warning is still there.

## How

- `runSummary` gathers the reasoning pieces as they stream and stores them on the reply as `thinking` and `thinkingTokens`, only when there were any. `viewSummaryById` passes them to `openSavedReplyView`, whose finished entry replays them as a thinking message with `folded: true`; `createReplyRenderer` then creates the `<details>` block without `open`. A reset forgets the folding, so the next live reasoning starts open again.
- A switch is `<input type="checkbox" role="switch" class="settings-switch">` with `data-on` and `data-off`, the two values its dropdown stored. `settings.js` reads and sets every control through `controlValue` and `showControlValue`, so storage, defaults and every `getSetting` caller are unchanged. A row with `data-shown-when="set-x=value"` is hidden by `paintDependentRows` whenever that control has another value, on opening Settings and after every change.

## Tests

`app-behaviour`: a fake thinking model's reasoning is stored with its reply and its length, and a switch shows a stored value and stores it back as that value. `live-view-unit`: reasoning replayed with `folded` starts folded, under its heading, out of the answer; a reset makes the next live reasoning start open; a saved reply opens with its reasoning folded, and one without shows no block. `browser-lifecycle`: in a real pop-up, a saved reply opened from the list shows its reasoning folded above the answer. `static-integrity`: every stored setting still has exactly one control, and each switch's default is one of its two positions. `user-journeys`: in Chromium, no setting is a two-value dropdown and seven are switches, a switch stores what its dropdown did, auto-reply, the Opus quality and the speaker settings show only when they apply, and Settings reopened shows each switch as stored.

Four new mutation guards: the reasoning not stored, a saved reply's reasoning starting open, the saved view dropping the reasoning, and a switch storing its checkbox value instead of the setting's. Three guards follow lines this build moved (the Auto waveform label, the open reasoning block, the replayed reasoning).

The `browser-lifecycle` check that a full disk at Stop offers the audio held in memory now waits for that offer. Stop puts the record button back before its last repaint and makes the offer after it, so under the gate's parallel load the check could look in between and fail; it asserts the same thing.

22 suites passed (strict gate) in 11 min 18 s; slowest mutation-guards (6 min 16 s)
