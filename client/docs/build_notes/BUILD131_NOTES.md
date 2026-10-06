# myAI Build 131

Speaker numbers show up as soon as two voices have each said two lines. Build 130 could count five voice groups in the live header while not one line had a number. Database version stays at 13.

## Numbers that match the header

Reported from Build 130 on a phone: a film playing into the room, 73 seconds in, the header read "🗣️ 5 groups · 12 samples", and no line of the transcript had a speaker number.

Build 130 moved the confidence bar to the clustering's same-speaker boundary, but numbers still waited for that confidence: two groups with at least two lines and about four seconds each whose voiceprints were further apart than 0.35. Short lines ("Thanks.", "Bay 13?") give noisy voiceprints. The clustering splits them into many small groups, so few groups had the seconds. Voices that share one soundtrack, one loudspeaker and one room also tend to sit close together. The header counted every group; the lines waited for the confidence.

Numbers now follow the groups the clustering keeps. They appear, on every line and earlier ones included, once two voices have each said at least two lines (`labelsEarned`). The clustering already decides what counts as a different voice: a line starts a group of its own below 0.35, and groups merge from 0.40. The confidence is still worked out, and the header shows it as how sure the app is that the voices are different people: "🗣️ 2 speakers · 34% sure".

A line alone in its group is not a voice yet. It carries the number of the line before it, as a line without a voiceprint always has. Once its group says a second line, both lines get that group's number. A stray line in a monologue therefore numbers nothing, and a burst of short lines does not scatter new numbers through the transcript. The header counts them apart: "🗣️ 2 speakers · 34% sure · 3 stray lines", or "🗣️ one voice so far · 3 stray lines · 13 samples".

Voices are counted by the identity they are shown under. Two groups confirmed as one person count once. A voice whose lines have all been retired from the clustering window still counts, so numbers no longer disappear from a long session when one of two speakers has been quiet for a while.

The note that a second speaker was detected, and the speaker list in the header, follow the same rule. The note no longer repeats one confidence figure after every name.

## Measured

Simulated with the real `diarize-core.js` of both builds. A voiceprint is a speaker part, a part shared by everyone in the room, and noise that grows as lines get shorter (0.8 to 4 seconds). There were 300 sessions per case.

- A monologue was numbered in 0 to 3% of sessions, against 0 to 2% before. Over 30 lines it was never numbered.
- Two voices, 12 lines, with the shared part at 0.8 of the speaker part: 89% of sessions numbered, against 66%. With the shared part as large as the speaker part: 35%, against 10%.
- Three voices, 12 lines, with the shared part as large as the speaker part: 71%, against 45%.
- Over 30 lines with the shared part as large as the speaker part, two voices were numbered in 9% (1% before) and three in 16% (5% before). In the rest, the clustering merges the voices because their voiceprints converge. The header then says "one voice so far", and no rule for showing numbers can help: the voice model on the transcription server does not tell those voices apart.
- Where numbers were shown, lines carried their voice's main number as often as before or more often (91% against 86% for three close voices), because stray lines no longer bring numbers of their own.

The trade-off: a voice split in two by the clustering, with both halves between 0.35 and 0.40 apart and two lines each, is now numbered as two people. Build 130 hid it. The header's "% sure" stays low when that happens.

## Tests

- `pure`: two voices in one room scoring 0.375 against each other (between the two boundaries, short of 60%) are numbered on every line, each voice with its own number. The header says "2 speakers · …% sure". A stray line carries the number before it and gets its own once its group has a second line. The header counts stray lines apart. A monologue with three stray lines is never numbered, and its header says "one voice so far · 3 stray lines". Two groups confirmed as one person are one voice. A voice with only retired lines still counts. Two single lines are "no voice with two lines yet".
- `live-scribe-unit`: with two voices the live header reads "2 speakers · …% sure (Speaker 1, Speaker 2)" and is marked found.

## Contracts

- `DIARIZE-NUMBERS-SHOWN-001`. Guards `MUT-NUMBERS-WAIT-FOR-CONFIDENCE`, `MUT-STRAY-LINE-NUMBERED`, `MUT-ONE-LINE-IS-A-VOICE`, `MUT-RETIRED-VOICE-FORGOTTEN`, `MUT-CONFIRMED-PAIR-COUNTS-TWICE`.
- `DIARIZE-SAME-ROOM-001` is now about the confidence figure, which no longer decides whether numbers are shown. `MUT-SAME-ROOM-VOICE-HIDDEN` is caught by the separation checks.

143 contracts and 399 mutation guards in all; 102 guards are caught only by reading source text.

22 suites passed (strict gate) in 8 min 40 s; slowest mutation-guards (4 min 08 s)
