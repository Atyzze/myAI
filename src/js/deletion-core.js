import { fmtBytes } from './config.js';
import { hasLiveTranscript } from './retention-core.js';

export function isFromLiveTranscript(transcript) {
    return !!transcript && (transcript.source === 'L' || !!transcript.fromLive);
}

export function liveTranscriptStillShown(transcripts) {
    return (transcripts || []).some(isFromLiveTranscript);
}

// The live transcript stored beside a recording is kept while a transcript made from it is kept.
// Once none is left, nothing on screen shows it any more, so it goes with the last one instead
// of lingering as a hidden copy that backups would still carry.
export function planTranscriptDeletion(rec, transcriptId) {
    const transcripts = (rec && rec.transcripts) || [];
    const summaries = (rec && rec.summaries) || [];
    const deleted = transcripts.find(item => item.id == transcriptId) || null;
    const keptTranscripts = transcripts.filter(item => item.id != transcriptId);
    const keptSummaries = summaries.filter(item => item.transcriptId != transcriptId);
    return {
        found: !!deleted,
        transcripts: keptTranscripts,
        summaries: keptSummaries,
        replies: summaries.length - keptSummaries.length,
        dropsLiveTranscript: !!deleted && hasLiveTranscript(rec) && !liveTranscriptStillShown(keptTranscripts),
        deletedWasLive: isFromLiveTranscript(deleted)
    };
}

export function describeTranscriptDeletion(plan) {
    const parts = [plan.replies > 0
        ? `${plan.replies} reply/replies written from it are deleted with it.`
        : 'No replies were written from it.'];
    if (plan.dropsLiveTranscript) {
        parts.push(plan.deletedWasLive
            ? 'The live transcript it was made from is deleted too.'
            : 'The live transcript kept from the recording is deleted too, because no transcript that remains was made from it.');
    }
    return parts.join(' ');
}

export function liveTranscriptAfterCleanup(rec, keptTranscripts) {
    return hasLiveTranscript(rec) && !liveTranscriptStillShown(keptTranscripts) ? 'drop' : 'keep';
}

export function backupIncludesLiveTranscript(rec) {
    if (!hasLiveTranscript(rec)) return false;
    const transcripts = (rec && rec.transcripts) || [];
    return transcripts.length === 0 || liveTranscriptStillShown(transcripts);
}

export function describeRecordingDeletion(rec, { savedSoFarBytes = 0, savedSoFarPieces = 0 } = {}) {
    const parts = [];
    const audioBytes = Number(rec && rec.audioBytes) || 0;
    if (audioBytes > 0) {
        parts.push(`${fmtBytes(audioBytes)} of audio`);
    } else if (savedSoFarBytes > 0) {
        parts.push(`${fmtBytes(savedSoFarBytes)} of audio saved so far, in ${savedSoFarPieces} piece(s)`);
    }
    const transcripts = (rec && rec.transcripts) || [];
    const summaries = (rec && rec.summaries) || [];
    const chain = (rec && (rec.contextChain || (rec.context ? [rec.context] : []))) || [];
    if (transcripts.length) parts.push(`${transcripts.length} transcript(s)`);
    if (summaries.length) parts.push(`${summaries.length} reply/replies`);
    if (hasLiveTranscript(rec) && !liveTranscriptStillShown(transcripts)) parts.push('the live transcript');
    if (chain.length) parts.push(`${chain.length} context item(s)`);
    return parts.length ? `This removes ${parts.join(', ')}.` : 'This row holds nothing but its own entry.';
}

export const INTERRUPTED_DELETIONS_KEY = 'myai-deletions-in-progress-v1';

export function parseDeletionIds(stored) {
    try {
        const list = JSON.parse(stored || '[]');
        return Array.isArray(list) ? [...new Set(list.map(Number).filter(Number.isFinite))] : [];
    } catch (_) {
        return [];
    }
}

export function withDeletionId(stored, id, present) {
    const ids = new Set(parseDeletionIds(stored));
    if (present) ids.add(Number(id)); else ids.delete(Number(id));
    return JSON.stringify([...ids].filter(Number.isFinite));
}
