# myAI Build 140

Stopping a recording while its translation boxes were still working through a backlog left the AI server busy for a long time afterwards with nothing on screen, and the translations it made went where the row did not show them. That work is now in sight on the recording, can be stopped on its own, is kept as it goes, and lands in the transcript the row shows. Database version stays at 13.

## What was happening

- At Stop the translation boxes close. Since Build 125 the lines they had not translated yet are completed after the recording (the fill), beside the automatic transcription and reply, and the fill waits while any reply runs so that the reply is not slowed. After a long recording that can be hundreds of lines per language, one request of 24 lines at a time, so the AI server kept working for many minutes after the reply had finished.
- Nothing showed it: no status line, no progress, and no way to stop it short of deleting the recording.
- Its answers were written only when it had finished, and only into the live reading ('L'). With Auto-transcribe on, the row shows the reading made after the recording ('S') instead, and the compact list, on by default, hides the others, so the translations appeared nowhere the person looked. A tab closed before the end lost all of them.
- Between the moment Stop took the live transcript and the moment the boxes closed, the boxes could still start new batches, whose answers could no longer reach what was saved.
- When the fill ended, the live reading was put together again without its `[not transcribed live]` marks.

## What the person sees

- While the rest is translated, the recording shows a 🌐 line: "🌐 The rest follows the reply: English 0 of 520 lines" while a reply is being written, then "🌐 Translating the rest: English 48 of 520 lines". It wraps on a phone instead of being cut off, and a repaint of the list puts it back as it was.
- Its ✕ stops only the translations, not a transcription or reply of the same recording. What was translated by then is kept, without a warning on the recording.
- The translations are in the transcript the row shows, also the one made after the recording from the live lines, in a section per language after the lines as spoken, and they appear as they come: a transcript opened halfway shows what is done so far, and a section's heading says how many of its lines are not translated (yet). Closing the tab halfway keeps what was done.
- The reply still comes first. It is written from the words as spoken, which never carry translations, so it does not need them; the translations follow it.
- The refused update tap names finishing translations among the work it waits for.

## How

- The fill hands over every answer as it arrives, from a batch, line by line, or a batch tried again at the end. Each is written into the live transcript, and every reading made from it is put together again: the live reading as it was first stored, holes marked, and a reading made after the recording from the live lines, which keeps its own lines as spoken and gets new language sections. `plain`, which replies use, is never touched.
- `updateLiveTranscript` reads and writes in one transaction. Before, a live transcript deleted between its read and its write (its last transcript deleted by hand, say) was written back as a copy nothing showed. The fill ends by itself once the live transcript is gone.
- A reading made after the recording from the live lines is stored with the translations the live transcript has at that moment.
- The status line comes from the fill's progress (`describeFillProgress`), and `live-tabs` remembers the text of each status line that is up, so a repaint restores it.
- Once Stop is finishing the last live windows, the boxes send nothing new to be translated.
- A section's heading counts its untranslated lines as "not translated" instead of "could not be rendered in this language", since the count is now also shown while translations are still coming.

## Tests

`pure`: every answer of the fill is handed over as it comes, from a batch, line by line and a batch tried again at the end, one hand-over per answer; before each request it says which language and how many lines are done; the status line's wording while waiting for a reply, translating, trying a batch again and before the start; a reading puts the lines as spoken first and a section per language after, says how many lines are not translated, gives its lines as spoken back, and put together again with newer translations has its sections replaced, not added to. `app-behaviour` (the real recorder, transcription, jobs and database): a recording stopped mid-backlog says its translations wait for the reply and how many there are, goes on once the reply is done, keeps each answer as it comes in the live transcript, in the transcript the row shows and in the live reading, which keeps its hole mark, says how far it is, and a tap on the real ✕ stops only the translations, not a reply on the same recording, keeping what was done and leaving no warning or status line; a live transcript deleted while an answer was on its way stays deleted and the fill ends; a change to the live transcript that overlaps its deletion does not bring it back; 📝 Fill gaps and a reading made after the recording from fully heard live lines carry the boxes' translations outside the words replies use. `static-integrity`: the status line and its ✕ in the recorder and in a repaint, and no new translation once Stop is finishing.

Eight new mutation guards: answers kept only at the end, a fill that shows nothing, a ✕ that cancels everything on the recording, a fill that goes on after its live transcript was deleted, the live transcript read and written in two transactions, a reading made after the recording without translations (with and without gaps), and the refresh skipping the reading the row shows. Re-pointed at the changed code: `MUT-FILL-COMPETES-WITH-REPLY`, `MUT-CLEANUP-KEEPS-AUTO-COPY`, `MUT-HOLES-NOT-STORED`, `MUT-HOLES-NOT-COUNTED`.

22 suites passed; 0 skipped (portable gate) in 10 min 59 s; slowest mutation-guards (6 min 09 s)
