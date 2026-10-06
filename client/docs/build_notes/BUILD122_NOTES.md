# myAI Build 122

A frame-rate setting for the recording waveform, and a release gate that takes a little over half as long and checks more of itself. Database version stays at 13.

## The waveform's frame rate

Settings has a new **Recording waveform** choice: off, 10, 15, 30 (the default) or 60 frames a second. A change applies at once, also to a recording in progress. Off hides the waveform and the dark bar around it and draws nothing; the frame counter, when debugging is on, counts what is actually drawn.

Build 121 drew a frame when at least 29 ms had passed since the last one, and asked the browser for every display refresh to find out. The waveform now keeps the time its next frame is due at the chosen rate, draws when a refresh comes within 4 ms of it, and moves the due time on by one frame, so it draws the chosen number of frames on a 60, 90, 120 or 144 Hz screen (a screen slower than the setting gets a frame on every refresh). After a pause, such as the page being in the background, it draws once and carries on at its rate instead of catching up with a burst of frames.

Between frames the page now sleeps: when the next frame is more than 20 ms away it waits on a timer and asks for one display frame when that is due, instead of being woken for every display refresh only to skip it. On a 120 Hz phone at 10 frames a second the page is woken about 20 times a second instead of 120; at 30 frames a second, about 60 instead of 120. Measured in headless Chromium during a recording: 20 frames drawn in 2 seconds at 10 a second, none when off, and 59 after switching to 30 in the middle of the same recording.

Three style rules for a `waveform-hidden` class that nothing ever set are removed; one of them would have made the live panel cover the whole screen, Stop Recording included.

## Two slow spots inside suites

`platform-unit` took 20.7 seconds, 20 of them waiting. The update check raced the browser's update against a 20-second limit and never cleared the timer, so a finished check left it running, and Node waited for it before it could exit. Two shorter limits in the same file had the same leak. They are now cleared when the check finishes: the suite takes 0.7 seconds. In the app this was a timer left running after every tap on the version, now gone too.

`pure` took about 2.1 seconds, half of it in one test: four hours of live lines, where every line that scrolled out of view searched all of the translations for its own. A line that scrolls out now looks up its translation into each language heard directly, by its key, instead of searching them all. In the app the search was already bounded, because the translations of lines that scrolled out are let go, but it is simpler and does not grow. The suite takes 0.6 seconds.

## The gate

Build 121's gate ran its 18 suites one after another and took 478.7 seconds on the 2-core machine the releases are built on: the mutation guards 245.8, `user-journeys` 114.2, `browser-lifecycle` 83.7 and `platform-unit` 20.7.

The gate now plans its suites by the number of cores (`MYAI_TEST_JOBS` overrides it). The quick suites (unit, contract and static) run side by side, one per core. The browser suites run one after another, and then the mutation guards on every core. With four cores or more the browser suites and the guards run side by side, the guards leaving three cores to the browser suites. A suite that fails stops the gate from starting any more; the ones already running finish. Each suite's output is printed in one piece when it finishes, and the gate ends with every suite's time, slowest first. The report in `artifacts/` records the plan, each suite's time and the gate's; the line in the build notes gives the gate's time and its slowest suite. On the same 2-core machine the whole gate took 4 minutes 34 seconds. A stress run with `MYAI_TEST_JOBS=4` on the same two cores also passed, in 2 minutes 11 seconds, which suggests the browser suites mostly wait rather than compute; the default still keeps them apart below four cores.

The mutation guards ran one at a time in a single copy of the tree and stopped at the first problem, and an anchor that had drifted was only found when its turn came. The guards now live in `tests/mutation/guards.mjs`. Before any guard runs, the whole table is checked and every problem is reported at once: an anchor that is missing or occurs more than once, a transform that changes nothing or throws, a guard listed twice, and guards and contracts that disagree either way. The guards then run in parallel, each worker on its own copy of the tree (`MYAI_MUTATION_WORKERS` overrides the number), and every failure is collected and printed with the end of its suite's output, in the order of the table. A suite that hangs is now reported as a timeout; before, it was reported as failing for the wrong reason. On two cores the 244 guards take about 63 seconds.

`pure` collects its failures and prints them at the end, so a crash later in the suite used to hide them, and a mutation guard reading that output reported the wrong reason. The collected failures are now printed however the suite ends.

## Contracts that had drifted

`baseline-contract` now checks that every test file in `tests/unit` and `tests/integration` runs in the gate, that every guard runs a suite of the gate and that the contract listing the guard names that suite, and that the contract's strict and portable commands are the ones `package.json` runs. Two contracts had drifted and are corrected: `TEST-HARNESS-001` now names `static-integrity`, which is where `MUT-SHELL-OMIT-MODULE` is caught, and `PERF-LONG-001` names `pure`, which catches `MUT-LIVE-PREVIEW-POLL`.

## Chromium

The two browser suites each had their own list of places to look for Chromium, and it did not include Playwright's, so on a machine with only Playwright's Chromium `CHROME_BIN` had to be set by hand. They now share one lookup: `CHROME_BIN` when it is set, then the newest Chromium Playwright installed (`PLAYWRIGHT_BROWSERS_PATH`, `~/.cache/ms-playwright`, `/opt/pw-browsers`), then the `PATH` and the usual install locations, including snap and macOS.

## Releasing

The release tool built the archive in the system's temporary folder, moved it into the output folder and then wrote its checksum. The move fails when the two are on different disks, as with a temporary folder in memory, and a failure writing the checksum left the archive behind with no checksum; the next release then refused to run ("build output already exists") until it was deleted by hand. The archive and its checksum are now staged in a hidden folder inside the output folder and moved in together, and if the second move fails the first is taken back. Stopping a release with Ctrl-C restores the tree, as any failure does, and says "release interrupted; nothing was published" and which build the tree is at, instead of printing a traceback.

## Tests

- `pure`: the frame rates offered, and that an empty or unknown setting means 30 rather than off; on 60, 90, 120 and 144 Hz screens the waveform draws as many frames a second as chosen, a slower screen gets every refresh, and off draws nothing; 10 frames a second on a 120 Hz screen wakes the page about 20 times a second; after a pause it draws once and does not catch up with a burst. A line that scrolls out keeps its translation into every language heard, and only its own.
- `platform-unit`: a finished update check leaves no timer running. Against Build 121 it fails: one check left four.
- `baseline-runner-unit`: every suite runs exactly once whatever the number of cores; two cores run the quick suites two at a time and the browser suites one after another; eight run the browser suites and the guards side by side on five guard workers; one runs everything in turn. A mutation table with nine different problems reports all nine. The worker count, the verdict for a guard that survives, hangs, fails for another reason or cannot start. Chromium is found without `CHROME_BIN`, the newest Playwright build first, never the headless shell.
- `baseline-contract`: every test file runs in the gate, every guard is caught by a suite its contract names, and the commands match `package.json`. With either of the two corrections undone it fails, naming the guard, the suite that catches it and the contract.
- `static-integrity`: the waveform is painted only on the frames its rate allows and sleeps on a timer in between; the setting, its default and its choices; a change applies at once; both places that archive lines pass every language heard; the release is staged in the output folder, published together or taken back, and Ctrl-C and the gate line.
- `user-journeys`: at 10 frames a second, 12 to 28 frames are drawn in 2 seconds and at most 40 display frames are requested; switching to off during the recording hides the waveform and its bar and stops drawing; switching to 30 brings it back at once, drawing at least one and a half times as many as at 10. Against Build 121 the setting does not exist, and the waveform draws about 60 frames in those 2 seconds.

## Contracts

- `WAVEFORM-RATE-SETTING-001`. Guards `MUT-WAVE-RATE-IGNORED`, `MUT-WAVE-SETTING-NOT-LIVE`, `MUT-WAVE-WAKES-EVERY-FRAME`, `MUT-WAVE-CATCH-UP-BURST`, `MUT-WAVE-OFF-DRAWS`.
- `WAVEFORM-LIGHT-001` now says the waveform is drawn at most at its chosen rate; `MUT-WAVE-EVERY-FRAME` and `MUT-FPS-ALWAYS-ON` are re-pointed at the new drawing code.
- `ARCHIVE-EVERY-LANGUAGE-001`. Guards `MUT-ARCHIVE-FIRST-LANGUAGE-ONLY`, `MUT-ARCHIVE-ONE-LANGUAGE`.
- `UPDATE-CHECK-NO-STRAY-TIMER-001`. Guard `MUT-UPDATE-TIMER-LEFT`.
- `GATE-RUNNER-001`. Guards `MUT-TABLE-FIRST-PROBLEM-ONLY`, `MUT-GUARD-TIMEOUT-AS-DETECTION`, `MUT-WORKERS-UNBOUNDED`, `MUT-PLAN-DROPS-SUITE`, `MUT-PLAN-BROWSERS-TOGETHER-ON-TWO`.
- `CONTRACT-DRIFT-001`. Guards `MUT-UNREGISTERED-TEST-FILE`, `MUT-GUARD-SUITE-UNCLAIMED`, `MUT-STRICT-COMMAND-DRIFT`.
- `CHROMIUM-FOUND-001`. Guard `MUT-CHROMIUM-IGNORES-PLAYWRIGHT`.
- `RELEASE-PUBLISH-WHOLE-001`. Guards `MUT-RELEASE-STAGED-ON-OTHER-DISK`, `MUT-RELEASE-CHECKSUM-AFTER-PUBLISH`, `MUT-RELEASE-HALF-PUBLISHED`, `MUT-RELEASE-CTRL-C-TRACEBACK`.

Release gate: 18 suites passed (strict gate) in 4 min 35 s; slowest user-journeys (2 min 00 s)
