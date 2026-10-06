# myAI Build 101

Build 101 fixes four places where the interface said something that was not true. No storage format or protocol change.

## Tapping the waveform could trap the page mid-recording

`toggleFullscreen` asked `document.fullscreenElement` whether the page was fullscreen, and then called `enterFsUI()` unconditionally, whether or not the fullscreen request existed or was granted.

Where `requestFullscreen` is not available on `documentElement`, which includes iPhone Safari, or where it is denied by policy, the result was a canvas fixed over the whole viewport at `z-index: 500`, the settings button hidden, scrolling locked, and `fullscreenchange` never firing because nothing changed. The record button sits in normal flow, so it was painted underneath and could not be tapped. Tapping the canvas again re-entered. The only way out was to reload the page, during a recording the user could no longer stop.

The toggle now tracks the state it actually applied and exits on that, so a second tap always leaves, whatever the browser did with the request. The fullscreen-change handlers clear the same flag, so leaving by Escape or by the system gesture is still handled. The browser suite removes both fullscreen APIs, taps the canvas twice and asserts the page comes back with the settings button visible.

## "View full transcript" was deleting words

A saved transcript was replayed into the live viewer as a single chunk flagged as segmented, which put every line through `seamTrim`, the overlap trimmer that exists to remove the duplicated seam between two live audio windows. Applied to a transcript that is already finished and already deduplicated, it removes the first words of any line that opens on a word the previous line closed on:

```
"Know what? You were there."  ->  "what? You were there."
"The plan is fine by me."     ->  "is fine by me."
"Yes, exactly."               ->  "exactly."
```

Natural speech does this constantly. The 📋 button copies the stored text, so the viewer and the clipboard disagreed about what had been said.

A replayed transcript is now marked as finished and rendered word for word. The timestamp split is also anchored now: it was `indexOf('] ')`, which found the first `] ` anywhere in a line, so `The [redacted] part was fine.` was broken into a grey pseudo-timestamp and a body. It now matches only a leading bracket containing a time range.

## A running job looked idle, and tapping it destroyed the work

Scribe and Reply recorded that they were busy on the DOM node itself, and the progress bar lived inside the row. `_renderListNow` replaces every row, and `buildRecordingItem` never asked whether a job was running, so any repaint left a fresh, enabled `📝 Scribe` button and no progress bar. Closing Settings is a repaint. So is a retention sweep, a format conversion, and a cross-tab lease change.

The user would reasonably conclude nothing had happened and tap again, which begins a new job, and `beginJob` aborts the previous one. A forty-minute transcription would restart from the first chunk, and the aborted run's handler then repainted again, wiping the second run's state too.

`jobs.js` already knew the truth. A rebuilt row now asks `hasJob`, marks the button busy, and restores the progress bar with its cancel control. Tapping a busy button opens the live view, which is what it was always meant to do. The scribe button also resets its label on success, which it did not before, so a deferred repaint no longer leaves a stale progress string on an enabled button.

## "Empty the box to restore the default" now does

`persistControl` refused to write an empty value, to stop a model dropdown being blanked while its options load. The AI-instructions textarea is on the same path, and the guide tells the user to empty it to restore the default. Emptying it wrote nothing, so the old instruction stayed in storage and kept being sent to the reply server on every request, while the user believed they had removed it.

The guard now applies only to dropdowns. `getSetting` already falls back to the default for an empty stored value, so the documented reset works as described.

## Contracts

`UI-TRUTH-001` is new: what the interface shows is what is actually true, a control that appears to work does, and a view shows what is stored. Suites `live-view-unit`, `static-integrity`, `browser-lifecycle`; guards `MUT-FULLSCREEN-TRAP`, `MUT-SAVED-TRANSCRIPT-RETRIMMED`, `MUT-BUSY-ROW-LOOKS-IDLE`, `MUT-EMPTY-BOX-CANNOT-RESET`.

The fullscreen trap and the busy row are covered behaviourally in the browser suite; both were confirmed to fail there with the fix removed. The transcript viewer is covered in the live-view suite against the real renderer.

Release gate: 16 suites passed (strict gate)
