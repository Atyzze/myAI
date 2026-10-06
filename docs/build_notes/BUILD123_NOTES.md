# myAI Build 123

Auto for the recording waveform, and the waveform's fullscreen view no longer outlives the recording. Database version stays at 13.

## Auto

**Recording waveform** in Settings has a new last choice, **Auto**. The waveform is then drawn on every refresh of the screen the app is on, whatever its rate: 60 Hz on most phones and monitors, 90 or 120 Hz on fast phones, 144, 165 or 240 Hz on gaming monitors. Nothing is fixed in advance: the browser calls the page once for each refresh of the screen its window is on, and Auto draws on each of those calls. So it follows a window dragged to another monitor, and a phone that lowers its refresh rate to save battery.

When Settings opens, the page times two dozen refreshes and labels Auto with the rate it measured, for example "Auto - every refresh of this screen (144 Hz)". The measurement keeps only the intervals close to the typical one, so a dropped frame or a pause does not lower it. It averages them, so timestamps that the browser rounds to a tenth of a millisecond still give 144 rather than 143 or 145, and it names the nearest common rate within 2%, so a 59.94 Hz screen is called 60 Hz.

The default stays 30 frames a second, because Auto on a 120 Hz phone draws four times as often. The setting is kept per browser, so Auto can be chosen on a desktop and 30 kept on the phone. The 60 choice is no longer labelled "smoothest", since Auto can be smoother.

Measured in headless Chromium, which refreshes at 60 Hz: 119 frames drawn for 119 refreshes in 2 seconds, and the label read "(60 Hz)".

## Stopping in fullscreen

Tapping the waveform makes it fullscreen and hides ⚙️. If the recording stopped while the waveform was fullscreen, because the microphone was lost (a phone call, say), storage filled or it was stopped from the keyboard, the waveform disappeared but its fullscreen view stayed. The browser stayed in fullscreen, the list could not scroll and ⚙️ stayed hidden until Back or Esc was pressed; where the browser has no fullscreen, until the next recording. Hiding the waveform, for whatever reason, now leaves its fullscreen view.

## Tests

- `pure`: Auto has no cap of its own, and draws a frame on every refresh of a 60, 90, 120, 144, 165 or 240 Hz screen and nothing in between. The refresh rate is measured as 144 Hz from timestamps rounded to 0.1 ms, still 144 with three dropped frames and a pause, 60 for a 59.94 Hz screen, 90, 30 for a phone saving battery, 110 for an unusual rate, and not at all from too few frames. The label names the rate, or no rate when none was measured.
- `static-integrity`: the choices include auto; Settings labels Auto with the rate measured when it opens; hiding the waveform announces it, and the fullscreen view is left when it does.
- `user-journeys`: during a recording, Auto draws on every refresh (at least 1.5 times as many frames as at 30, and at least 80% of the refreshes), Settings names the measured rate, and stopping the recording while the waveform is fullscreen leaves fullscreen, with ⚙️ back and the page scrollable. On Build 122 the same stop left the waveform's fullscreen class, the hidden overflow and the hidden ⚙️ in place.

## Contracts

- `WAVEFORM-AUTO-RATE-001`. Guards `MUT-WAVE-AUTO-CAPPED`, `MUT-REFRESH-COUNTS-DROPPED-FRAMES`, `MUT-AUTO-LABEL-NOT-MEASURED`.
- `FULLSCREEN-ENDS-WITH-WAVEFORM-001`. Guards `MUT-FULLSCREEN-OUTLIVES-WAVEFORM`, `MUT-FULLSCREEN-HIDDEN-IGNORED`.
- `WAVEFORM-RATE-SETTING-001` now lists auto among the choices.

Release gate: 18 suites passed (strict gate) in 5 min 17 s; slowest user-journeys (2 min 05 s)
