# myAI Build 114

Build 114 makes the controls around Start Recording symmetric. Database version stays at 12.

## 📝 beside Start Recording

📋 sat to the left of Start Recording at all times, while 📝 appeared on the right only during a recording, so the idle controls looked lopsided. 📝 is now always there, and the three buttons each start a recording:

- 📋 starts one with the clipboard as a context item;
- Start Recording starts a plain one, with live transcription on or off as Settings says;
- 📝 starts one with live transcription on straight away, whatever Settings says.

During a recording 📝 does what it did before, showing or hiding the live transcript, and 📋 steps aside as before. When idle, 📝 carries no on/off state, because there is nothing for it to be on or off for; it says what tapping it will do.

## A plain start no longer inherits live transcription

Whether live transcription ran was decided once and then carried over: turning it on during one recording left it on for the next plain start, invisibly, even with the setting off. Every recording now decides afresh. 📝 asks for it explicitly, and every other start follows the setting, including its one-time confirmation.

## Tests

`user-journeys` now checks that 📝 stays visible on both sides of a recording while 📋 steps aside, that tapping 📝 while idle starts a recording with live transcription already running even with the setting off, that 📝 then returns without a stale on/off state, and that the next plain start does not inherit live transcription. Against Build 113, the first two fail.

## Contracts

- `LIVE-START-BUTTON-001`. Guards `MUT-LIVE-BUTTON-HIDDEN-IDLE`, `MUT-LIVE-BUTTON-NO-START`, `MUT-LIVE-STICKY`.

Release gate: 18 suites passed (strict gate)
