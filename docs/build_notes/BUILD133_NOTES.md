# myAI Build 133

Speaker numbers count 1, 2, 3 in the order people come in. Build 132 could show the first person as Speaker 2, the second as Speaker 3 and a third as Speaker 5, with no Speaker 1 anywhere. Database version stays at 13.

## Numbers that skipped

Reported from Build 132: three people, and the right three at the end, but the header read "3 speakers · 100% sure · 1 stray line (Speaker 2, Speaker 3, Speaker 5)". The first person was Speaker 2 from their first number on, there was never a Speaker 1, and the third person came in as Speaker 5.

The numbers on screen were the identities the clustering keeps. A group of lines takes an identity as soon as it forms, before anyone knows whether it is a voice, and identities are never reused. A line heard once before anyone else, a short noisy line that briefly stood alone, or a group that formed and dissolved in a regrouping each took the next identity, so the voices that stayed were numbered after them. Simulated over sessions where people come in one after another, Build 132 skipped a number at some point in 31 to 82% of the sessions it numbered.

## The numbers on screen

- The numbers on screen are kept apart from the identities. They are handed out when numbers first appear: the first two voices take 1 and 2 in the order they first spoke, and each later voice takes the next number when it becomes a voice.
- A number already on screen never changes for a newcomer, also when one of the newcomer's lines came earlier.
- When two voices become one, the joined voice keeps the lower number and the voices after it move up one, so the numbers on screen never skip one. The next new voice takes the number after the last.
- The header lists the speakers in the order of their numbers.
- What the app says about speakers uses the same numbers: the receipt of a name or a merge, the note that a voice may not be new, the inference panel and its suggestions. Two voices that introduce themselves with the same name are suggested as one under the lower number.
- "confirm speaker N" confirms the suggestion that was announced for Speaker N, also when the numbers have moved up since.

Identities are unchanged, and so is the grouping: which lines belong together is exactly what Build 132 decided.

## Measured

The simulation of Build 132 (a voiceprint is a speaker part, a part shared by everyone in the room, and noise that grows as lines get shorter), now with people coming in one after another: the second at the tenth line, a third at the thirtieth and a fourth at the fiftieth. 150 sessions each:

- Two people, shared part 0.8 of the speaker part: numbers started at Speaker 1 and Speaker 2 in 100% of the numbered sessions (Build 132: 69%) and never skipped one (Build 132 skipped in 31%).
- Two people, shared part as large as the speaker part, more noise: 100% (23%), never skipped (77%).
- Three people: 100% (72% and 27%), never skipped (39% and 82%). Four people: 100% (76%), never skipped (49%).
- Where the grouping told everyone apart, they carried 1, 2, 3 in the order they came in, in every session (Build 132: 13 to 69%). Where it did not, two people share a number, as before: that is the voice model on the transcription server, not the numbering.
- The grouping is unchanged: numbered, lost and changed lines are the same as in Build 132. A new line still costs 2.4 to 2.8 ms at a full window of 192-value voiceprints and about 6 ms at 512; labelling 480 lines takes about 1 ms.

## Tests

- `pure`: the reported case, with somebody heard once before anyone else and once between the second and the third speaker, so the voices' identities skip: line by line the numbers on screen never skip one, the three people are Speaker 1, 2 and 3 in the order they came in, and the header lists them that way. Joining the second into the first reads "Speaker 2 → Speaker 1", the third becomes Speaker 2, and the next new voice is Speaker 3. Two voices numbered at once take their numbers in the order they first spoke, whatever their identities; the one whose first line comes first is Speaker 1 even when the other was a voice earlier. A newcomer whose first line came before the second voice spoke is Speaker 3, and the others keep theirs. A voice whose lines have all left the window keeps its place in the header. A state built before Build 133 shows identities as it always did. The inference panel, the "still me" note and the receipt of a name use the numbers on screen, and a merge suggestion joins the later number into the earlier. A suggestion names the speaker by the number on screen, and "confirm speaker N" finds the suggestion announced for Speaker N after the numbers moved up, or the latest of two announced with one number.
- `live-scribe-unit`: with a passer-by heard first, three people are "Speaker 1", "Speaker 2" and "Speaker 3" in the transcript and in the header, a suggestion for the second person asks to "confirm speaker 2", and saying it names that person.

## Contracts

- `DIARIZE-NUMBERS-IN-ORDER-001`. Guards `MUT-NUMBERS-ARE-IDENTITIES`, `MUT-NUMBERS-SKIP-AFTER-JOIN`, `MUT-NUMBERS-RESORTED`, `MUT-FIRST-TWO-BY-IDENTITY`, `MUT-NUMBERED-BEFORE-SHOWN`, `MUT-HEADER-OUT-OF-ORDER`, `MUT-RECEIPT-SAYS-IDENTITY`, `MUT-PANEL-SAYS-IDENTITY`, `MUT-MERGE-INTO-LOWER-IDENTITY`, `MUT-PROPOSAL-SHOWS-IDENTITY`, `MUT-ANNOUNCED-NUMBER-FORGOTTEN`, `MUT-CONFIRM-BY-IDENTITY`.
- `MUT-CONFIRM-APPLIES-ANYTHING` now mutates the new confirm step.

145 contracts and 419 mutation guards in all; 102 guards are caught only by reading source text.

22 suites passed (strict gate) in 9 min 30 s; slowest mutation-guards (4 min 58 s)
