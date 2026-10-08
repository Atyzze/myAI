# myAI Build 139

A recording can be pinned. 📌 sits on the recording's top row, left of its format (OPUS, WAV or WAV → OPUS). A tap pins it: the countdown under it (⏳ audio, 📝 text) freezes where it stands and nothing in the recording is deleted automatically, however the ages in Settings are changed. Another tap unpins it, and the countdown runs on from where it stood, not from where the wall clock has got to. Browser storage is still the browser's: a pin does not survive clearing site data, only a download does. Database version stays at 13.

## What the person sees

- Every saved recording has 📌 left of its format; one without audio, which has no format, has it at the right end of the row. Unpinned it is a grey pin, pinned it is red in a blue frame. A recording still being recorded or saved has none.
- Pinned, the countdown turns ice blue and reads ❄️ audio 26d, ❄️ text 26d: the same numbers, standing still. It is never shown amber as due soon.
- Unpinning a recording that was pinned for months does not delete it at the next sweep: it has the time it had left when it was pinned. Text written while it was pinned, such as a reply, starts aging when the pin comes off.
- Shortening a window in Settings counts only what it would really delete, so pinned recordings are not in its list. The first-sweep question says a pinned recording is left alone.
- Deleting by hand still deletes. The question for deleting a pinned recording says it is pinned and that a pin only stops automatic deletion; Delete All Audio and Delete All Text say they take pinned recordings too.
- Settings and ❓ explain the pin under Automatic deletion.

## How

- A pinned row carries `pinnedAt`; pins that have ended are kept in `pinnedSpans` as `[from, to]` pairs (`docs/STORAGE.md`). Retention ages everything on the recording's own clock: the time since, less the time it spent pinned since. While a pin holds, that clock stands still, so the countdown is frozen and the plan for the row deletes nothing.
- The tap names the state it asks for (pin or unpin). Asking for the state a row already has changes nothing, so a tab still showing an older state cannot flip the pin the wrong way. A row being saved or deleted is not pinned.
- The automatic sweep already plans every row again inside the write that deletes from it, so a pin that lands while a sweep is running is seen, and the row is left alone.
- At most 32 ended pins are kept per recording. When there would be more, the two oldest are joined, which counts the time between them as pinned too: a recording can only end up younger by it, never older.

## Tests

`pure`: a pinned recording far past both windows loses nothing, its countdowns stand where they were and stay there, five-minute windows still delete nothing and a sweep finds nothing to do; unpinned, the countdown runs on from where it stood, it keeps the days it had left and is deleted once they run out; text written while pinned has not started to age and starts when the pin comes off, text written after a pin ages by the wall clock; pinning a pinned recording again changes nothing; pinned and unpinned over and over, a recording keeps a bounded note that only counts it younger; a sweep and its announcement leave pinned recordings out; the question for deleting a pinned recording says what a pin does not stop. `app-behaviour` (the real list, sweep and database): the row offers 📌 left of the format, a tap pins it and freezes the countdown, a recording still saving has no pin and cannot be pinned, the sweep leaves a pinned recording whole an hour past a five-minute window, pinning it again from a stale tab changes nothing, unpinning lets the countdown run on from the minutes it had left, and once they have run out the sweep deletes it. `user-journeys` (Chromium): at the desktop width and at 360 px 📌 sits just left of the format badge, on its row and as tall; a tap pins and freezes the countdown, a second tap unpins it. Five mutation guards: a pinned recording swept anyway, the pinned clock still running, unpinning resuming from the wall clock, a tap that toggles whatever the row holds, and the pin right of the format. `MUT-TRANSCRIPT-OUTLIVED-BY-REPLY` is re-pointed at the changed code.

22 suites passed; 0 skipped (portable gate) in 11 min 09 s; slowest mutation-guards (6 min 13 s)
