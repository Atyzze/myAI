# myAI Build 117

The controls around Start Recording stay on one line on a phone during a recording. Database version stays at 12.

## The running timer left the big button

During a recording the big button read "Stop Recording (00:22)", wider than "Start Recording" and growing again past an hour. On a phone around 360px wide that pushed 📝 onto a second line under the button, so the row that was symmetric when idle came apart the moment it mattered.

The button now says "Stop Recording" and nothing else, so its width does not change while recording. The running time was already shown in the live recording row, and that is now the only place it appears.

## A shorter live title

A recording in progress was titled with its date and time followed by " - Recording...", which wrapped over three lines in the live row beside the timer and the LIVE badge. It is now titled by its date and time alone; the LIVE badge and the running clock already say that it is recording. Once saved, a recording is renamed to its date, time and length as before.

## The row never wraps

The row that holds 📋, the big button and 📝 was allowed to wrap below 420px. It no longer does: the side buttons keep their size, the big button may shrink, and below 420px its text scales down gently, 17px at 320px wide and the full 20px from about 375px. Measured in Chromium at 320, 360, 375, 412, 430 and 768px, "Start Recording", "Stop Recording" and "Finalizing..." each fit on one line in the button with all three buttons on one row. The longer error labels, such as "Microphone disconnected", may take two lines inside the button, but the row itself stays intact.

## Tests

`user-journeys` records at 360px wide and checks that the three buttons share one line, that the big button reads exactly "Stop Recording", and that the live row shows a date-and-time title with the running time beside it. Against Build 116, all three fail.

## Contracts

- `RECORD-ROW-ONE-LINE-001`. Guards `MUT-TIMER-IN-BUTTON`, `MUT-LIVE-TITLE-SUFFIX`, `MUT-ROW-WRAPS`.

Release gate: 18 suites passed (strict gate)
