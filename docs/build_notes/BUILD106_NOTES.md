# myAI Build 106

Build 106 removes the numeric spoken-command system and replaces the one part of it worth keeping with a rule the rest of the app already follows: the app never asserts something it only guessed. No storage format change; database version stays at 9.

`src/js` is 13364 lines, down from 13779. One module gone, one smaller one added.

## What was actually there

Fifteen numbered commands, reached by saying "system z" and a code. Of those, three did nothing at all: `system z 3` echoed "preferred language noted" and set nothing, `system z 4` replied that it was deliberately unassigned, and `system z 2` listed a menu that only existed because the other commands did. Five duplicated a settings dropdown. Seven did something with no other route to it.

Build 94 removed the spoken-commands section from the help overlay, which left the feature live but undocumented. That turned out to be untrue in an unhelpful way: the settings hint under "How speakers are named" still taught four of the codes, so the app was instructing people in a language its own guide no longer mentioned. Twenty-three user-facing strings across four files taught the old grammar.

The help text was also wrong. It promised that a rename could be said as "just speaker 2 Elisabeth". Tested against the parser, that phrasing never matched; every rename needed the trigger. The simple form the text advertised did not exist.

## Suggest, then confirm

Inference used to apply a name as soon as its evidence crossed a threshold, then offer an undo. Since "I'm Mark" scored exactly that threshold, one loose self-introduction silently renamed a speaker.

It now proposes. The suggestion appears in the transcript as a question, saying what would change and what to say to accept it, and the speaker keeps their number until somebody says so out loud. Merges work the same way, which is why there is no longer an undo: nothing was done.

The promotion rule has three parts, and a candidate must satisfy all of them:

- **score at least 1.0**, which is either one outright statement ("my name is Mark") or a loose one that got corroborated ("I'm Mark" at 0.6 plus two people using the name at 0.25 each)
- **half a point clear of the runner-up name**, up from a quarter, so a speaker with two plausible names stays a number
- **some of the evidence must be self-given**. A name only ever heard addressed to somebody is a guess about a third party, and never proposes on its own however often it is repeated.

A merge is a different claim and gets a different rule: the stronger side must reach 1.0, the weaker side must still reach 0.6, and **both** must have claimed the name of themselves, up from either one. The acoustic similarity gate is unchanged.

Below the bar nothing is offered, but the panel keeps showing how far the evidence has got, now as a share of what a suggestion needs rather than of what an automatic rename used to need. A suggestion nobody answers expires after ten minutes.

## One command, bounded at both ends

`speaker 2 confirm` or `confirm speaker 2`, in either order, in English or Dutch, with digits or a spoken number. A bare `confirm` is accepted only when exactly one suggestion is standing; with two it asks which rather than choosing.

The instruction must be a whole sentence. That rule is what makes it safe without a trigger word: "can you confirm speaker 2 is joining?" contains the command as a substring and is correctly ignored, and so is "I will confirm later".

There is no free-form rename. It was the source of every hard problem in the old parser, and it turned out not to be needed: if nobody says a name aloud, saying the name aloud is itself evidence, and attribution places it. That is the same mechanism, with a human check in front of it.

Confirming marks the name as confirmed rather than inferred, so it is locked and will not be guessed at again. Confirming a speaker with nothing standing applies nothing and says so.

## Where the guarantee is held

The central claim is that no speaker name is ever applied without a person confirming it. That is held in three places, and it is worth being precise about which is which:

- **behavioural**, in the new `live-scribe-unit` suite: an outright introduction produces a suggestion on screen, phrased as a question; saying "confirm speaker 1" through the real live audio path applies it and reports it as confirmed; and confirming a speaker with no suggestion standing applies nothing and says so.
- **behavioural**, in `pure`: the promotion rule, the ledger, expiry, and every accepted and rejected phrasing of the command.
- **static**, for the one-line decision itself: `inferSpeakerNames` must contain no call that applies a command, and `confirmSpeaker` must be the only path that does, and only to a proposal that was actually standing.

The static one is there because the alternative was a vacuous test. An earlier draft asserted that the speaker label had not changed on screen, which passed whether or not the name was applied, because a label only renders once two voices are clustered. Reverting the fix did not fail it. It was replaced rather than kept.

## Contracts

`SYSTEM-Z-001` is retired with its twelve guards. Two contracts replace it:

- `SPEAKER-CONFIRM-001` - a name worked out from the conversation is only ever suggested; nothing is applied until a person confirms it out loud. Suites `pure`, `live-scribe-unit`, `static-integrity`; guards `MUT-INFERRED-NAME-APPLIED`, `MUT-CONFIRMED-NAME-LEFT-OPEN`, `MUT-CONFIRM-APPLIES-ANYTHING`, `MUT-CONFIRM-MATCHES-SUBSTRING`, `MUT-CONFIRM-BARE-GUESSES`.
- `SPEAKER-PROPOSE-002` - a suggestion is withheld until the evidence is strong, self-given and unambiguous, and expires if nobody answers. Suites `pure`, `static-integrity`; guards `MUT-PROPOSE-BAR-TOO-LOW`, `MUT-PROPOSE-WITHOUT-SELF-EVIDENCE`, `MUT-PROPOSE-IGNORES-RUNNER-UP`, `MUT-PROPOSAL-NEVER-EXPIRES`.

`MUT-INFER-HEARSAY` stopped biting during this build and needed a new expectation. The reason is worth recording: it raises the weight of being addressed by name, and the self-evidence requirement now makes the outcome independent of that weight. The design became robust to the thing that guard was protecting, so the guard was re-pointed at the assertion that still constrains it rather than deleted.

## The browser suite

Two end-to-end checks were driven through commands that no longer exist, including using `system z 1` to stop a recording by voice. Stopping by voice is gone with the rest, so that step now clicks the button, and the spoken-instruction check became a stray `confirm speaker 2` with nothing standing, which is answered rather than acted on. The suite still proves that a reply to an instruction is never saved as speech.

## Not carried over

Restart and stop by voice, the language and unassigned placeholders, the spoken menu, panel open and close by voice, waveform show and hide by voice, manual merge and separate, and forget-names. The settings equivalents for speaker naming and panel count are unchanged, and the settings hint now describes suggest-and-confirm instead of the codes.

Release gate: 17 suites passed (strict gate), 130 mutation guards, 517 mutation assertions, 59 contracts
