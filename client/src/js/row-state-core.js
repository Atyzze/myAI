// What the row of a recording that is not finished shows, decided from the recording, the beat of
// the tab capturing it, and what this tab is doing with it. gui.js draws the result.
//
// kind: 'recording' (this tab is capturing it), 'capture-error' (this tab's capture stopped after a
// storage error and is saving what it has), 'saving' (being saved, here or in another tab),
// 'other-tab' (another tab is capturing it), 'save-failed' (its save failed), 'recovering' (a tab is
// putting it together from its pieces), or 'interrupted' (the tab that recorded it went away before
// saving it). live: the row is marked as live. actions: the buttons it offers, in order.
export function unfinishedRowState(rec, { liveHere = false, savingHere = false, captureErrorHere = false,
                                          ownedByLiveTab = false, beat = null, finalizerFresh = false } = {}) {
    if (liveHere) {
        return captureErrorHere
            ? { kind: 'capture-error', live: false, here: true, actions: [] }
            : { kind: 'recording', live: true, here: true, actions: [] };
    }
    if (savingHere) return { kind: 'saving', live: false, here: true, actions: [] };
    if (ownedByLiveTab) {
        const saving = (beat && beat.state === 'finalizing') || (rec && rec.captureState === 'finalizing');
        return saving
            ? { kind: 'saving', live: false, here: false, actions: [] }
            : { kind: 'other-tab', live: true, here: false, actions: [] };
    }
    if (rec && rec.captureState === 'finalize-error') {
        // The audio saved before the failure can still be taken away, whatever retrying does.
        return { kind: 'save-failed', live: false, here: false,
                 actions: ['retryFinalizeRec', 'downloadRecoverableRec', 'deleteRec'] };
    }
    if (finalizerFresh) return { kind: 'recovering', live: false, here: false, actions: [] };
    return { kind: 'interrupted', live: false, here: false, actions: ['recoverNowRec', 'deleteRec'] };
}

// A recording whose only reading is its live transcript, while that transcript marks audio it never
// heard, offers to transcribe just those parts (📝 Fill gaps), also in the compact list, which
// otherwise hides 📝 Scribe once a recording has text. A reading made after the recording, filled
// or not, ends the offer: the row shows that reading, and 📝 Scribe in the full list redoes it all.
export function liveHolesToFill(transcripts) {
    const list = Array.isArray(transcripts) ? transcripts : [];
    return list.some(t => t && t.source === 'L' && Number(t.holes) > 0)
        && !list.some(t => t && t.source !== 'L');
}

// Enter or Space activates an element with role="button" only when the key was pressed on that
// element itself. A key pressed on a real control inside it (the 📋 in a preview) belongs to that
// control: taking it over, and stopping its default, would keep Enter and Space from ever pressing it.
export function keyActivates(event, element) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) return false;
    return event.target === element;
}

export const ROW_ACTION_LABELS = Object.freeze({
    retryFinalizeRec: 'Retry finalization',
    downloadRecoverableRec: '⬇️ Audio saved so far',
    recoverNowRec: 'Recover now',
    deleteRec: 'Delete'
});
