# myAI Build 94

Build 94 is a wording, reporting and navigation build. No storage format or backend protocol change, and the reply and transcription transports are untouched.

## The overlap reviewer no longer calls anything suspicious

The pass that checks for a phrase transcribed twice where two audio windows overlap described its candidates as "suspicious". Read without knowing what the pass does, that sounds like the application is flagging the content or the speaker; it only ever meant "suspected duplicate". The progress line is now `Re-checking N repeated passage(s) against the audio...` and the transcript log says which windows overlapped. The behaviour is unchanged: a repeat is replaced only when the wider second listen clearly hears it once.

## The recording line reports two estimates, not two deadlines

While recording, the line under the storage counter used to read `about 72 h before this can still be saved as one file, 154 h before capture stops`. Both figures were true and they measure different things: the first is when the free space stops being able to hold the fragments and the assembled copy at the same time, the second is when there is no room to write another byte at all. Side by side and unlabelled they read as one deadline contradicting itself.

The line now carries one space figure and one battery figure, which are genuinely independent limits:

```
💾 about 72 h of space · 🔋 about 5.2 h of battery
```

The space figure is the saveable one, the number that decides whether this note survives as a file. The capture-stops figure is no longer shown; nothing about how it is computed has changed, and `storageRunway` still returns it for the alert logic.

The battery figure uses the drain trend the recorder was already sampling and never displayed. It prefers the platform's own discharge estimate and falls back to a smoothed measurement of how fast the level is actually falling. A charging device reads `🔌 on power`; a device still gathering its first sample reads `🔋 battery: measuring`, rather than the figure silently appearing and disappearing. A device with no battery interface says nothing about one.

The warning thresholds are unchanged and still fire on whichever limit is nearest, and the warning itself still explains what is about to be lost.

The line also appears sooner. It needs a measured write rate, so it used to stay blank for up to fifteen seconds; while there is nothing yet to report it is now re-sampled every three seconds instead.

## The recording line is cleared when the recording stops

`updateRunway` returned early once `AppState.startTime` was cleared, and the teardown never blanked the element, so the last estimate painted stayed on screen after the recording had finished and been saved. Tearing down a recording now blanks it, and a sample that lands after the recording ended blanks it too. The browser lifecycle suite asserts the element is empty and hidden once the record button reads `Start Recording` again.

## Page controls at both ends of the list

Paging forward from the bottom of a long list left the controls behind: scrolling back up reached the top of the page with no way to go back. The same two buttons and the same page counter now also sit above the list, on every page after the first. The first page keeps the controls at the bottom only, since there is nowhere to go back to and the list keeps its full height.

The rule is `src/js/pagination-core.js`; `renderPagination` drives both bars from the same description, so neither can drift from the other.

## Shorter help

The `🗣️ Spoken commands` section has been removed from the guide overlay. That part of the design is still moving, the text had already drifted from what the code accepts, and documenting it in the overlay advertised behaviour that is not settled. The spoken-instruction system itself is unchanged, and `README.md` still describes it for anyone working on the source.

## Contracts

- `RUNWAY-001` now states that a recording reports two independent estimates and stops reporting when it stops. Suites: `pure`, `static-integrity`, `browser-lifecycle`. New guards `MUT-RUNWAY-CAPTURE-AS-SPACE`, `MUT-RUNWAY-BATTERY-DROPPED`, `MUT-RUNWAY-LINGERS-AFTER-STOP`.
- `UI-PAGING-001` is new: page controls are reachable from both ends of a list once there is somewhere to go back to. Guard `MUT-PAGE-TOP-ON-FIRST-PAGE`.
- `UI-HELP-001` now also covers what the overlay documents. Guard `MUT-HELP-RESTATES-SPOKEN-SYNTAX`.

Release gate: 16 suites passed (strict gate)
