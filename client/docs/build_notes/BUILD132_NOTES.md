# myAI Build 132

Speaker numbers stay once they are on screen, and a voice stays a voice. Build 131 could show two speakers for a minute, then merge them back into one and take every number away. Database version stays at 13.

## Numbers that went away again

Reported from Build 131 with a podcast of two people playing into the room: the live transcript numbered both speakers, then "along the way" went back to one voice and stopped showing numbers. The saved transcript had no numbers at all, because it takes them from the grouping at Stop.

Every new line regrouped every line of the window from scratch: first by order, then two rounds of moving lines to the nearest group, then merging groups whose voiceprints scored 0.40 against each other. As lines accumulate, the centroids of two people sharing a room, a microphone and a language drift towards each other, and a regrouping merged them. Numbers were all or nothing, so with one voice left they all went away, earlier lines included.

With the test fixture of two people in one room taking turns of three lines (0.9 of the room in every voiceprint), Build 131 numbered both from the fifth line and merged them back at the 24th; from there on no line had a number. Simulated over whole sessions of two or three voices, Build 131 took the numbers away again in 29 to 95% of sessions.

## A voice stays a voice

- A group becomes a voice once it has said three lines, or two lines that sound like each other clearly more than like any other group (by 0.10). Without that margin, two noisy lines of one speaker that happen to group would give a monologue a second speaker for the rest of the session: in simulation, 25% of the noisiest monologues against 2% with it.
- Every regrouping starts from the lines that are already a voice's own. The other lines are grouped as before.
- A line of a voice moves to another voice only when it sounds clearly more like that one (by 0.15) than like the rest of its own voice. A line given to the wrong voice early on still moves once the right voice is known.
- Two voices become one only on strong evidence: every line of the smaller sounds more like the other voice than like the rest of its own, or both have said five lines and their voiceprints score 0.70 against each other. When that happens a named voice outlives an unnamed one, so its name stays on the lines of both, and two voices named differently are never joined.
- The speaker ceiling in Settings still holds. Past it a stray group joins the group it is most like, and only when every group is a voice are the two most alike made one.
- Once two voices have spoken, numbers stay on screen for the rest of the session, also if two voices later become one.

## Measured

The same simulation as Build 131: a voiceprint is a speaker part, a part shared by everyone in the room, and noise that grows as lines get shorter. Sessions of 40 lines, 150 each:

- Two voices, shared part 0.8 of the speaker part: numbered at the end in 95% of sessions (Build 131: 74%). Numbers went away in no session (29%).
- Two voices, shared part as large as the speaker part: 53% (6%) and 77% (15%) for less and more noise; three voices: 85% (9%). Build 131 took the numbers away again in 61 to 90% of these sessions.
- On average, 2.17 of three voices had a number of their own at the end (0.15), and 1.55 of two (0.29).
- Monologues: numbered in 0 to 2% of sessions, where Build 131 flashed numbers in 1 to 25% and took them away again.
- Over 120 lines, and over 150 lines through a 60-line window where old lines retire, no session lost its numbers. With retiring lines, two voices changed the number of a line already shown 0.1 times per session (57.9 in Build 131).
- A new line costs the same as before: 2.7 ms at a full window of 192-value voiceprints and 6.5 ms at 512.

The margin for two-line voices is a trade-off. At 0.05, sessions of two or three close voices are numbered 2 to 6 points more often, and up to 7% of noisy monologues keep a second speaker; at 0.10, up to 2%.

What this still cannot do: voices the grouping never tells apart. When the voice model on the transcription server gives two people nearly the same voiceprint, their lines join one group from the start, and the header says "one voice so far".

## Tests

- `pure`: the fixture of two people taking turns is numbered within their first turns. From then on, the number of speakers shown never goes down over forty lines, and each keeps a number of their own on every line. A monologue from a voice model so noisy that two lines of one person score 0.23 on average is never taken for two voices. A voice made of two lines of another voice becomes that voice, and the numbers stay on screen. When one of the two is named, the named one goes on and its name stays on the lines of both. Two differently named voices are never joined. A line given to the wrong voice moves to the one it clearly sounds like.
- `static-integrity`: the running sum per group is now kept by `joinGroup` and `leaveGroup`.

## Contracts

- `DIARIZE-VOICES-STAY-001`. Guards `MUT-VOICES-REGROUPED-FROM-SCRATCH`, `MUT-NUMBERS-NOT-LATCHED`, `MUT-VOICES-JOINED-EASILY`, `MUT-VOICES-NEVER-JOINED`, `MUT-NAMED-VOICE-LOST`, `MUT-DIFFERENT-NAMES-JOINED`, `MUT-VOICE-LINE-STUCK`, `MUT-NEW-VOICE-WITHOUT-MARGIN`.
- `MUT-CENTROID-RESUMMED` now mutates `joinGroup`; `MUT-STRAY-LINE-NUMBERED` follows the new stray rule.

144 contracts and 407 mutation guards in all; 102 guards are caught only by reading source text.

22 suites passed (strict gate) in 8 min 53 s; slowest mutation-guards (4 min 24 s)
