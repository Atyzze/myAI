# myAI Build 116

📋 beside Start Recording now stays during a recording and adds to it. Database version stays at 12.

## Adding clipboard context during a recording

📋 disappeared the moment a recording started, so the only way to give a recording clipboard context was to have it ready before pressing record. Something found halfway through, a link, a message, a note, meant stopping the recording to get the button back.

📋 now stays beside Start Recording throughout. During a recording, tapping it reads the clipboard and adds the text to that recording as one more ordinary context item, exactly the shape a paste at the start produces: bounded in size, shown in the note's context block, sent with the AI reply, exported, retained and deleted on the same terms. It does not start anything. The button flashes ✓ when the item was added, its label says what it will do, and the live row shows how many context items the recording carries.

The item is appended through `addContextToRecording`, a single read-modify-write transaction on the recording row, so it cannot race the heartbeat or finalization, which update the same row the same way. Context only matters when the AI reply is generated, and replies read the row at that moment, so an item added during the recording, or while it is being saved, is included.

## Tests

`user-journeys` now checks that both side buttons stay visible before, during and after a recording, that 📋's label follows the recording, and that a recording started with 📋 and given a second paste halfway through ends up with both items, without a second recording being started and with the live row counting them. Against Build 115, these fail.

## Contracts

- `CLIPBOARD-DURING-RECORDING-001`. Guards `MUT-PASTE-HIDDEN-WHILE-RECORDING`, `MUT-PASTE-DURING-RECORDING-LOST`.

Release gate: 18 suites passed (strict gate)
