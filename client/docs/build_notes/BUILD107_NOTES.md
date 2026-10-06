# myAI Build 107

Build 107 fixes a false alarm the capture watchdog raised on every compressed recording, makes two waits visible instead of silent, and changes what the battery line reports. No storage format change; database version stays at 9.

All of it came from one device recording on build 105. None of it was theory.

## The watchdog was crying wolf, and it was my bug

Build 102 added a watchdog so that seeing nothing on screen would mean the recording was definitely capturing sound. On a compressed recording with live transcription off, it said the opposite of the truth, permanently, from four seconds in.

`initAudioStream` attaches the capture worklet in the compressed branch only when live transcription is on:

```js
mr.start(CONFIG.IO_FLUSH_SEC * 1000);
if (AppState.liveScribe) await attachCaptureWorklet();
```

That is correct on its own terms. Compressed recording goes through `MediaRecorder`; the worklet is only a tap for the live transcriber, and running it for nobody costs battery. But the watchdog counted worklet samples, so with no worklet the counter never moved, and after four seconds it declared that no audio was reaching the recorder. It could never recover, because the number it watched could never grow.

Everything the report described follows from that. The recording was fine, because `MediaRecorder` never stopped. The waveform kept moving, because it is drawn from the analyser node, which is in the audio graph and has nothing to do with the worklet; those two indicators are independent, and the waveform was never evidence against the warning. Turning live transcription on cleared it, because that attaches the worklet: what looked like disproving the watchdog was actually repairing the thing it was complaining about.

It also wrote `incompleteAudio: true` to the row. That flag currently only picks a CSS class inside the capture-error branch, so it never rendered, but it was a false claim about the recording sitting in the database.

### The fix

The watchdog now watches whatever is actually feeding the recording. Both paths advance one counter: the worklet adds samples, and compressed fragments add bytes as they arrive. `samplesSeen` is untouched and still means samples, so the honest-duration calculation is unchanged.

The window had to change with it. Compressed blocks arrive every four seconds, which is the cadence this whole application keeps, so judging their arrival on a four-second window would make every normal gap between deliveries read as a fault. `captureStallMs` derives the window from how often the source delivers: continuous audio keeps the four-second window, and a source that delivers every four seconds gets twelve, which is three missed deliveries.

That is a real weakening worth stating plainly rather than hiding. In compressed mode a genuine stall is now reported in about twelve seconds instead of four. It cannot be better: the recorder only learns that sound exists when a block arrives, so it cannot detect silence faster than the cadence at which evidence reaches it. The alternative was running the worklet permanently for every compressed recording, which spends battery continuously to shorten a rare alarm, and this application is built to keep recording on a dying battery.

### Why no test caught it

The browser suite did exercise compressed recording, for 2.6 seconds, which is inside the four-second window where the false alarm had not fired yet. It now records past the stall window with live transcription explicitly off, and asserts that no capture alert is showing, that the row is not marked stalled, and that the saved recording carries no false incomplete flag.

That test was checked against the bug: removing the fragment counter again makes it fail with `a compressed recording with live transcription off is not accused of capturing no audio`. An earlier version of the test used a nine-second recording and passed either way, because the window is now twelve seconds; it was extended rather than kept.

The mutation guards for this point at `static-integrity`, not at the browser suite, because the mutation runner caps each suite at thirty seconds and the browser suite takes minutes. The behavioural proof lives in the browser suite; the guards hold the wiring.

## Two silent waits

**The overlap reviewer** called `onProgress` once, before its loop, then ran up to six server round-trips one after another at a two-minute budget each, with an audio decode per item and nothing further on screen. Against a slow server that is twelve minutes of a frozen message, indistinguishable from a crash. It now reports which passage it is on and how many there are, from inside the loop, and each re-check is bounded by a thirty-second budget, matching the live path. A few seconds of audio does not need two minutes.

**Startup** painted the list without awaiting it and without a `catch`, so a failed first paint was silent and the list did not appear until after migration, recovery and two sweeps had finished. The first paint now gets a clear run at the database before any of that starts, reports its own failure, and cannot block maintenance for more than three seconds. While that work runs, the page says it is checking for interrupted recordings and that the notes below are safe, using an alert that yields to the database guard rather than fighting it for the same element.

## The battery line

The drop needed before a rate is trusted goes from four percent to one, which is the smallest step a battery can actually report, so it is the soonest an honest rate exists.

Below four fifths, the line now shows the level itself as soon as it is known, as `🔋 62% - still measuring how fast it falls`, and upgrades to a time the moment a rate exists. It claims no duration before then. With no measured rate and no figure from the operating system there is no time to state, and inventing one would be the application lying, which is the thing every recent build has been removing. On mains it still says nothing at all, and a nearly full battery with nothing measured stays quiet rather than stating the obvious.

## Rotation

The maximised waveform releases the orientation lock so it turns with the phone; leaving it puts the interface back to portrait. Wrapped in the usual guards, since `screen.orientation.lock` is absent on some browsers and rejects outside fullscreen on others. Where the operating system's own rotation lock is on, the page cannot override it, and no amount of code here changes that.

## Contracts

Five new, ten guards, all confirmed to bite:

- `CAPTURE-TRUTH-002` - the watchdog watches whatever is actually feeding the recording and judges it on that source's cadence. Suites `pure`, `static-integrity`, `browser-lifecycle`; guards `MUT-OPUS-CAPTURE-UNWATCHED`, `MUT-STALL-WINDOW-IGNORES-CADENCE`, `MUT-STALL-WINDOW-TOO-TIGHT`.
- `REVIEW-PROGRESS-001` - work that makes the user wait says how far along it is and is bounded. Suite `static-integrity`; guards `MUT-REVIEW-SILENT`, `MUT-REVIEW-BUDGET-UNBOUNDED`.
- `STARTUP-PAINT-001` - the list is painted before maintenance and never fails silently. Suite `static-integrity`; guard `MUT-FIRST-PAINT-SILENT-FAILURE`.
- `UI-ROTATION-001` - only the maximised waveform turns, and rotation is never left on. Suite `static-integrity`; guard `MUT-ROTATION-LEFT-ON`.
- `BATTERY-CONTEXT-001` - a low battery reports what it is on, states a time only once measured, and says nothing on mains. Suites `pure`, `static-integrity`; guards `MUT-BATTERY-DROP-TOO-COARSE`, `MUT-BATTERY-LEVEL-HIDDEN`, `MUT-BATTERY-INVENTS-TIME`.

`MUT-BATTERY-ON-POWER-SHOWN` needed a refreshed anchor because `describeBatteryRunway` was rewritten; its expectation was widened to the assertions that still constrain it.

## Still open

The audio decode inside the review loop has no timeout of its own. A decode that stalls still stalls, though the loop now says which passage it is on. Bounding it risks discarding a legitimate review, so it is left alone and recorded here rather than fixed quietly.

Release gate: 17 suites passed (strict gate), 140 mutation guards, 557 mutation assertions, 64 contracts
