# myAI Build 113

Build 113 changes how a context item is read and copied, and tidies six smaller things. The database moves from version 11 to 12, the first schema change since upgrades became additive: one index is added and every stored note is kept.

## Tap the text to read it, tap 📋 to copy it

A context item, such as a pasted note or the transcript carried over by 💬 Continue, showed a short preview with a 👁️ button beside it that opened the full text. The preview itself did nothing when tapped. Now the preview is what opens the full text, as the transcript and reply previews already did, and the 👁️ button is replaced by 📋, which puts the whole text on the clipboard, not the shortened preview. It shows ✓ when the copy worked and ✗ when the browser refused it.

The copy is started inside the tap itself, handing the clipboard a text that is still being read from the database, so browsers that only allow clipboard writes during a tap accept it. Where that form is not supported, the text is read first and then written.

## A recording that failed to start kept its context

When a recording could not start, for example because the microphone was refused, the recorder put the context it had been given back as pending: a pasted note, or what 💬 Continue or 🔗 Link carried. Nothing on screen showed it, and the next plain Start Recording took it to the AI. This is the case Build 111 fixed for Continue during a recording, reached from another direction. A failed start now drops the context; the button that supplied it can simply be tapped again.

## Silence notes stay out of the text for the AI

The plain transcript, which replies and context chains send to the AI, included "[no speech detected]" as though it had been said. It now carries only what was said. The timestamped transcript still marks where it was quiet. "[transcription unavailable for this section]" deliberately stays in the plain text, as Build 110 intended, because the AI should know that words are missing there.

## Free space under a gigabyte

The storage line rounded free space to whole gigabytes, so anything under half a gigabyte read as "Available: 0 GB". It now shows megabytes below one gigabyte, one decimal up to ten, and whole gigabytes above that.

## Startup and jumps no longer read every recording

Recovering interrupted recordings at startup read every recording, transcripts and replies included, to find the few still marked as processing. Jumping to a note from a context item read every recording again to work out its page.

Version 12 adds a `by-state` index on `captureState`. A recording is still being made or saved exactly when its state is starting, recording, finalizing or finalize-error, and startup now asks the index for those. A jump reads the one recording and counts the newer ones through the date index. The journey wraps IndexedDB's `getAll` and finds no whole-table read in either path; Build 112 made two.

The upgrade to 12 goes through `applySchema`, which creates the missing index on the existing store and deletes nothing. The `user-journeys` suite exercises exactly this: its second build raises the version by one over whatever the tree declares, so it now opens a version 13 beside this one.

## Buttons beside Start Recording follow the recording

📋 and 📝 were repainted by two timers every half second. The recorder now announces when recording starts or ends, and both buttons are repainted then, so they change at once and nothing polls while the app sits idle. The one-second check for a waiting upgrade stays, since it follows several kinds of work and returns at once when nothing is waiting.

## A warning that suggested confirming a speaker

Every error line in the live transcript carried the hint "say "confirm speaker N" to accept a suggested name", a default left over from the speaker commands. With translation panels on, a capture stall or a low-space warning showed it. A system line now carries a hint only when one is given, and the failed speaker confirmation gives it explicitly.

## A flaky test

The browser suite's update check expected a new service worker to be active within a fixed budget, and failed once under load during the Build 112 release. It now accepts that the build may still be installing when the check returns and waits for the worker itself to arrive.

## Tests

`user-journeys` gains: a failed start leaves no context and the next recording starts clean; 📋 and 📝 swap as soon as a recording starts and stops; a recording that is quiet at both ends is transcribed with silence marked in the timestamped text and absent from the text for the AI (the fake transcription server now answers silent audio with nothing, like a real one); startup recovery and a jump both work without a whole-table read; a context item has no view button, tapping its text opens it, and 📋 puts the whole text on the clipboard. Against Build 112, every one of these fails.

## Contracts

- `CONTEXT-NO-LEFTOVER-001`. Guard `MUT-FAILED-START-KEEPS-CONTEXT`.
- `MODEL-TEXT-SPEECH-001`. Guard `MUT-SILENCE-TO-MODEL`.
- `FREE-SPACE-UNITS-001`. Guard `MUT-FREE-SPACE-ZERO-GB`.
- `INDEXED-LOOKUPS-001`. Guards `MUT-RECOVERY-READS-ALL`, `MUT-STATE-INDEX-MISSING`, `MUT-JUMP-READS-ALL`.
- `STATE-DRIVEN-PAINT-001`. Guards `MUT-BUTTONS-POLLED`, `MUT-STATE-NOT-ANNOUNCED`.
- `SYSTEM-HINT-001`. Guard `MUT-HINT-ON-EVERY-ERROR`.
- `CONTEXT-ROW-ACTIONS-001`. Guards `MUT-CONTEXT-TEXT-NOT-TAPPABLE`, `MUT-CONTEXT-COPY-MISSING`.

Release gate: 18 suites passed (strict gate)
