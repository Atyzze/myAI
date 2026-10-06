const MINUTE = 60 * 1000;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

export const RETENTION_OPTIONS = Object.freeze([
    { value: '5m',  ms: 5 * MINUTE,   label: '5 minutes' },
    { value: '15m', ms: 15 * MINUTE,  label: '15 minutes' },
    { value: '1h',  ms: HOUR,         label: '1 hour' },
    { value: '4h',  ms: 4 * HOUR,     label: '4 hours' },
    { value: '1d',  ms: DAY,          label: '1 day' },
    { value: '7d',  ms: 7 * DAY,      label: '7 days' },
    { value: '1M',  ms: 30 * DAY,     label: '1 month (30 days)' },
    { value: '3M',  ms: 90 * DAY,     label: '3 months (90 days)' },
    { value: '1y',  ms: 365 * DAY,    label: '1 year (365 days)' }
]);

export const DEFAULT_RETENTION = '1M';

const BY_VALUE = new Map(RETENTION_OPTIONS.map(option => [option.value, option]));

export function retentionMs(value) {
    const option = BY_VALUE.get(String(value ?? ''));
    return (option || BY_VALUE.get(DEFAULT_RETENTION)).ms;
}

export function retentionLabel(value) {
    const option = BY_VALUE.get(String(value ?? ''));
    return (option || BY_VALUE.get(DEFAULT_RETENTION)).label;
}

export function isShorterRetention(next, previous) {
    return retentionMs(next) < retentionMs(previous);
}

export function retentionAckToken({ audio = '', text = '' } = {}) {
    return `audio=${String(audio)};text=${String(text)}`;
}

export function parseRetentionAck(token) {
    const match = /^audio=([^;]*);text=(.*)$/.exec(String(token || ''));
    return match ? { audio: match[1], text: match[2] } : null;
}

export function retentionAckCovers(token, policy) {
    const agreed = parseRetentionAck(token);
    if (!agreed || !policy) return false;
    return retentionMs(policy.audio) >= retentionMs(agreed.audio)
        && retentionMs(policy.text) >= retentionMs(agreed.text);
}

export function retentionScanCutoff({ now = Date.now(), audioMs = 0, textMs = 0 } = {}) {
    return now - Math.min(audioMs, textMs);
}

export function fmtRetentionRemaining(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return 'now';
    if (value >= DAY)    return `${Math.floor(value / DAY)}d`;
    if (value >= HOUR)   return `${Math.floor(value / HOUR)}h`;
    if (value >= MINUTE) return `${Math.floor(value / MINUTE)}m`;
    return '< 1m';
}

// A recording is as old as the time since it ended. Counted from its start, a meeting longer
// than the audio window would be past it the moment Stop was pressed. A recording saved by this
// build knows when it ended; an older one ends at its start plus its length.
export function recordingEndedAt(rec) {
    const startedAt = Number(rec && rec.timestamp) || 0;
    if (startedAt <= 0) return 0;
    return Math.max(Number(rec.endedAt) || 0, startedAt + Math.max(0, Number(rec.durationMs) || 0));
}

export function planRecordRetention(rec, { now = Date.now(), audioMs = 0, textMs = 0 } = {}) {
    const empty = {
        dropAudio: false, dropTranscriptIds: [], dropSummaryIds: [],
        dropContext: false, dropLive: false, dropRow: false,
        audioExpiresInMs: null, textExpiresInMs: null
    };
    if (!rec) return empty;

    if (rec.processing || rec.deleting) return empty;

    const recordedAt = recordingEndedAt(rec);
    const audioCutoff = now - audioMs;
    const textCutoff  = now - textMs;

    const transcripts = Array.isArray(rec.transcripts) ? rec.transcripts : [];
    const summaries   = Array.isArray(rec.summaries) ? rec.summaries : [];
    const chain = Array.isArray(rec.contextChain)
        ? rec.contextChain
        : (rec.context ? [rec.context] : []);

    const itemTime = item => Number(item && item.time) || recordedAt;

    const answeredLater = new Set(summaries
        .filter(item => itemTime(item) > textCutoff && item.transcriptId != null)
        .map(item => String(item.transcriptId)));
    const dropTranscriptIds = transcripts
        .filter(item => itemTime(item) <= textCutoff && !answeredLater.has(String(item.id)))
        .map(item => item.id);
    const dropSummaryIds = summaries
        .filter(item => itemTime(item) <= textCutoff)
        .map(item => item.id);

    const dropAudio = Number(rec.audioBytes) > 0 && recordedAt > 0 && recordedAt <= audioCutoff;
    const dropContext = chain.length > 0 && recordedAt > 0 && recordedAt <= textCutoff;
    const hasLive = hasLiveTranscript(rec);
    const dropLive = hasLive && recordedAt > 0 && recordedAt <= textCutoff;

    const keepsAudio = Number(rec.audioBytes) > 0 && !dropAudio;
    const keepsText  = (transcripts.length - dropTranscriptIds.length) > 0
                    || (summaries.length - dropSummaryIds.length) > 0
                    || (chain.length > 0 && !dropContext)
                    || (hasLive && !dropLive);

    const dropRow = !keepsAudio && !keepsText;

    return {
        dropAudio,
        dropTranscriptIds,
        dropSummaryIds,
        dropContext,
        dropLive,
        dropRow,
        audioExpiresInMs: Number(rec.audioBytes) > 0 && recordedAt > 0 ? (recordedAt + audioMs) - now : null,
        textExpiresInMs: newestTextExpiry(transcripts, summaries, chain, hasLive, recordedAt, textMs, now, itemTime)
    };
}

export function hasLiveTranscript(rec) {
    return Number(rec && rec.liveTranscriptLines) > 0;
}

function newestTextExpiry(transcripts, summaries, chain, hasLive, recordedAt, textMs, now, itemTime) {
    let newest = null;
    for (const item of [...transcripts, ...summaries]) {
        const at = itemTime(item);
        if (newest == null || at > newest) newest = at;
    }
    if (newest == null && (chain.length > 0 || hasLive) && recordedAt > 0) newest = recordedAt;
    if (newest == null) return null;
    return (newest + textMs) - now;
}

export function retentionPlanTouchesAnything(plan) {
    if (!plan) return false;
    return plan.dropAudio || plan.dropRow || plan.dropContext || plan.dropLive
        || plan.dropTranscriptIds.length > 0 || plan.dropSummaryIds.length > 0;
}

export function describeRetentionChange(counts, {
    clock = 'audio', fromLabel = '', toLabel = '', oldestAt = null, formatBytes = String, formatDate = String
} = {}) {
    const what = clock === 'text' ? 'Text' : 'Audio';
    const lines = [];
    if (counts.audioRecordings > 0) {
        lines.push(`• audio from ${counts.audioRecordings} recording(s) (${formatBytes(counts.audioBytes)})`);
    }
    if (counts.transcripts > 0) lines.push(`• ${counts.transcripts} transcript(s)`);
    if (counts.summaries > 0) lines.push(`• ${counts.summaries} reply/replies`);
    if (counts.rows > 0) lines.push(`• ${counts.rows} recording(s) with nothing left in them`);
    return `${what} kept for ${toLabel} instead of ${fromLabel}.\n\n`
        + `This is not only a rule for the future. Everything already older than ${toLabel} is overdue `
        + `the moment you confirm, and the next sweep deletes it`
        + (oldestAt ? `, going back to ${formatDate(oldestAt)}` : '') + `:\n\n`
        + `${lines.join('\n')}\n\n`
        + `This cannot be undone, and browser storage has no undelete. `
        + `Choose Cancel to leave the setting as it was.`;
}

export function planRetentionSweep(records, { now = Date.now(), audioMs = 0, textMs = 0 } = {}) {
    const actions = [];
    let audioRecordings = 0;
    let audioBytes = 0;
    let transcripts = 0;
    let summaries = 0;
    let rows = 0;
    let oldestAt = null;

    for (const rec of (records || [])) {
        const plan = planRecordRetention(rec, { now, audioMs, textMs });
        if (!retentionPlanTouchesAnything(plan)) continue;
        actions.push({ id: rec.id, plan });
        const at = recordingEndedAt(rec);
        if (at > 0 && (oldestAt === null || at < oldestAt)) oldestAt = at;
        if (plan.dropAudio) {
            audioRecordings++;
            audioBytes += Number(rec.audioBytes) || 0;
        }
        transcripts += plan.dropTranscriptIds.length;
        summaries += plan.dropSummaryIds.length;
        if (plan.dropRow) rows++;
    }

    return {
        actions,
        empty: actions.length === 0,
        counts: { audioRecordings, audioBytes, transcripts, summaries, rows, oldestAt }
    };
}

export function planDeleteAllText(rows) {
    const deleteIds = [];
    const clearIds = [];
    for (const row of rows || []) {
        if (!row) continue;
        if (!(Number(row.audioBytes) > 0) && !row.processing) deleteIds.push(row.id);
        else clearIds.push(row.id);
    }
    return { deleteIds, clearIds };
}
