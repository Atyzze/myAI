# myAI Build 112

Build 112 closes the gap Build 111 left in its own handover. Database version stays at 11; nothing about the stored layout changes.

## A tab handed over while its work was still running

Build 111 let a tab that kept its database for a recording give it up once it was no longer busy, so a waiting newer version starts without anyone closing a tab. "Busy" meant recording, saving the recording, or holding the recording lock. It did not include the work a stopped recording starts afterwards: automatic transcription and reply, the cleanup pass, and completing the translation columns. Those run after the save, so the tab counted as idle while they were still going, handed the database over within a second, and their results had nowhere to be stored. With automatic transcription on, the recording reached the newer version with its audio but without its transcript, and the failure could not even be written down.

The same was true, before Build 111 as well, of a transcription, reply or conversion started by hand in a tab that was not recording: a newer version opening elsewhere closed that tab's connection at once, and the result was lost when it finished.

The recorder now counts the work a stopped recording starts while it runs (`trackFollowUp`), `jobs.js` reports whether any transcription or reply job is running (`hasAnyJob`), and `gui.js` reports a running conversion (`isConverting`). A tab keeps its connection while any of these, a recording, its saving or the recording lock is active, and hands it over by itself once all of them are finished.

## The notice names what it is waiting for

The database guard now knows whether the tab is recording or only still working. A tab that is recording is told its recording comes first, as in Build 111. A tab whose recording has stopped but whose work is still running is told the newer version starts once the work running here finishes, instead of being asked to stop a recording that is no longer running. The notice is refreshed while the tab waits, so it changes from one to the other when the recording stops.

## Tests

The upgrade journey in `user-journeys` now runs with automatic transcription on and the transcription server holding each request for three seconds. It asserts that after the recording stops the newer version keeps waiting and the old tab says why, that the newer version then starts by itself, and that the transcript the old tab was producing is stored. Against Build 111, the transcript is missing and the old tab gives no reason for the wait.

## Contracts

- `HANDOVER-WAITS-001`: a tab hands the database over only when nothing it started is still writing. Guards `MUT-HANDOVER-DURING-FOLLOWUP`, `MUT-FOLLOWUP-UNCOUNTED`, `MUT-JOB-HANDOVER`, `MUT-BUSY-NOTICE-BLAMES-RECORDING`.

## Scope

Importing backups is deliberately not part of this application. The notes for Build 111 no longer list it as open work.

Release gate: 18 suites passed (strict gate)
