# myAI Build 130

A second speaker in the same room is labelled again when only one language is spoken, and the automatic gain no longer turns every pause up to its cap. Database version stays at 13.

## Speaker labels with one language

Reported from a live session in Dutch: labels only appeared once a second language was heard. Playing an English podcast into the room made "Speaker 1" and "Speaker 3" appear; a second voice speaking Dutch never got a label, which it used to.

Nothing in the app looks at the language when it labels speakers. Labels are all or nothing: they stay hidden until `secondSpeakerProbability` reaches 60%, which needs two voice groups that have each spoken at least two lines and about four seconds, and a separation between their voiceprints. Build 129 scored that separation as `(0.35 - similarity) / 0.25`, so the bar was only met at a similarity of 0.20 or less. The clustering itself treats anything under 0.35 as a different voice and only merges groups from 0.40 up, so two groups between 0.20 and 0.40 were two voices to the clustering and hidden on screen.

Two people who share a room, a microphone and a language share part of their voiceprint as well, and land in exactly that band. Simulated with the real `diarize-core.js` and voiceprints made of a speaker part, a shared room-and-language part and per-line noise: when the shared part is about two thirds of the speaker part, a second Dutch voice forms its own group at 0.33 and scores 7%, so it is never labelled, while the English podcast, which shares nothing, scores 100% after its second line. That is the pattern that was reported. The "Speaker 3" with no "Speaker 2" fits it too: a group that forms and dissolves again keeps its number, and numbers are never reused.

`voiceSeparation` now scores the separation between the clustering's own two boundaries: nothing at 0.40, where the groups would be merged, 60% at 0.35, where a single line stops counting as the other group's voice, and all of it from about 0.32. In the same simulation the second Dutch voice is labelled after its second line, eight seconds after it starts. Over twelve combinations of line noise and shared part, 40 sessions each: a monologue is never labelled, before or after; two voices in the room are labelled in 93 to 100% of sessions where Build 129 managed 10 to 18% (shared part two thirds of the speaker part), and in 30 to 45% where it managed none (shared part 0.8, where the clustering itself merges the rest). A split of one voice that the clustering would still let a line join (above 0.35) stays unlabelled.

What this cannot fix: if the voice model on the server gives two people speaking the same language voiceprints closer than 0.40, the clustering merges them into one group and there is nothing to label. The live header says which case a session is in: "🗣️ one voice so far" means the voice model does not tell them apart; "🗣️ 2 speakers" means they are labelled; "🗣️ 2 groups · … closest 0.37 · …% (need 60%)" means the clustering keeps two groups that are still too close, or too new, to label. The trade-off runs the other way as well: a voice model that turns one person speaking another language into a new voice (the speaker-labelling dialog warns about it) now gets that person labelled as a second speaker a little sooner.

## Automatic gain in pauses

The automatic gain measured its meter with `getByteTimeDomainData`. The Web Audio spec rounds those bytes down (`floor(128 * (1 + x))`), so every slightly negative sample reads as -1/128 and any real noise measures about 0.0055 RMS. The hold for near-silence (`rms < 0.0005`) could therefore never fire. Measured in Chromium with the Build 129 loop: room noise at -90 and at -70 dBFS both took the gain from 0.8 to its cap of 24 (+28 dB) within a second. When speech started after two seconds of -70 dBFS noise, the limiter was taking 16.6 dB off the first words and still 8 dB 0.45 seconds later. That is the audio that was recorded, sent for transcription and turned into voiceprints: every pause carried amplified room noise and every word after a pause was squashed.

`meterLevel` in `capture-health-core.js` reads the meter as floats and `nextAutoGain` holds the gain below the hold level; the recorder uses both. With the same loop and the same noise, the gain stays at 0.8 through the pause and the limiter does nothing. At speech levels the same rule steers the gain as before; it now reads a whole meter window (1,024 samples) rather than the first half of one. A room louder than about -66 dBFS is still turned up in pauses, as it always was.

## Tests

- `pure`: `voiceSeparation` is 0 at the merge boundary, 60% at the same-speaker boundary, below the bar just above it and 100% at 0.3. Two people in one room (voiceprints at about 0.32 against each other, between the old bar and the boundary) are two groups, every line is labelled and each keeps a label of their own; one person talking in that room is one group and never labelled. The auto-gain meter reads -70 dBFS noise below the hold level, where a byte reading of the same noise gives more than 0.005, and fifty ticks of it leave the gain at 0.8; soft speech is brought up, loud speech and a peak near full scale are brought down, and the gain stays within its floor and cap.
- `browser-lifecycle`: the first recording listens to -70 dBFS noise read the way the spec reads it, and after five seconds the recorder's gain is still at most 1. With the Build 129 recorder it is 24.

## Contracts

- `DIARIZE-SAME-ROOM-001`. Guards `MUT-SAME-ROOM-VOICE-HIDDEN`, `MUT-SPLIT-LABELLED-AS-TWO`.
- `CAPTURE-AUTO-GAIN-001`. Guards `MUT-AGC-BYTE-METER`, `MUT-AGC-NO-HOLD`.

142 contracts and 394 mutation guards in all; 102 guards are caught only by reading source text.

22 suites passed (strict gate) in 8 min 39 s; slowest mutation-guards (4 min 07 s)
