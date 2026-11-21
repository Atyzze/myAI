import { composeFullPrompt } from './reply-core.js';
import { displayTitle, sanitizeFilename } from './naming.js';

// 📑 on a recording takes all of its text elsewhere, to ask another AI the same thing (Build 146).
// Two copies and one download, all built here from the stored recording:
//   everything        context, transcript and the AI replies to it;
//   without replies   context and transcript: the prompt 🧠 Reply sends, whole, never shortened;
//   .zip              the recording as structured JSON (RECORDING_EXPORT_FORMAT).
// The AI's thinking is never part of any of them.

export const RECORDING_EXPORT_FORMAT = 'myai-recording';
export const RECORDING_EXPORT_VERSION = 1;
export const RECORDING_EXPORT_JSON_NAME = 'recording.json';

export function recordingChain(rec) {
    if (!rec) return [];
    return rec.contextChain ? rec.contextChain : (rec.context ? [rec.context] : []);
}

// The transcript the row shows, which is the one 🧠 Reply and 💬 Continue use.
export function shownTranscript(rec, transcriptId = null) {
    const all = (rec && rec.transcripts) || [];
    return all.find(item => item.id == transcriptId) || all[0] || null;
}

function transcriptWords(t) {
    return t ? String(t.plain || t.text || '') : '';
}

// A model that writes its reasoning into the answer itself puts it in <think> tags.
export function withoutThinking(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

// The replies written from one transcript, oldest first, with any reasoning left out.
export function repliesTo(rec, transcriptId) {
    return ((rec && rec.summaries) || [])
        .filter(s => s.transcriptId == transcriptId)
        .map(s => ({ ...s, text: withoutThinking(s.text) }))
        .filter(s => s.text)
        .reverse();
}

function replyHeading(reply, index, count) {
    const model = reply.model ? ` · ${reply.model}` : '';
    return count > 1 ? `[AI REPLY ${index + 1} OF ${count}${model}]:` : `[AI REPLY${model}]:`;
}

export function buildRecordingCopy(rec, { instructions = '', transcriptId = null, withReplies = true } = {}) {
    const shown = shownTranscript(rec, transcriptId);
    const chain = recordingChain(rec);
    const replies = withReplies && shown ? repliesTo(rec, shown.id) : [];
    let transcript = transcriptWords(shown);
    // With no context the prompt is the bare transcript; a reply after it needs it named.
    if (replies.length && !chain.length) transcript = `[AUDIO TRANSCRIPT]:\n${transcript}`;
    const parts = [composeFullPrompt({ instructions, chain, transcript })];
    replies.forEach((reply, index) => parts.push(`${replyHeading(reply, index, replies.length)}\n${reply.text}`));
    return parts.filter(part => part.trim()).join('\n\n');
}

function iso(ms) {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function contextKind(item) {
    if (item.pasted) return 'pasted';
    const label = String(item.label || '');
    if (/^Linked from:/.test(label)) return 'linked';
    if (/^Continued from:/.test(label)) return 'continued';
    return 'context';
}

function contextInput(item) {
    if (item.inputText) return item.inputText;
    return item.text && !item.outputText ? item.text : '';
}

export function buildRecordingExport(rec, { instructions = '', transcriptId = null, exportedAt = Date.now(), build = null } = {}) {
    const shown = shownTranscript(rec, transcriptId);
    const transcripts = ((rec && rec.transcripts) || []).slice().reverse();
    const replies = transcripts.flatMap(t => repliesTo(rec, t.id));
    return {
        format: RECORDING_EXPORT_FORMAT,
        version: RECORDING_EXPORT_VERSION,
        exportedAt: iso(exportedAt),
        app: { name: 'myAI', build: build == null || build === '' ? null : String(build) },
        recording: {
            id: rec && rec.id != null ? rec.id : null,
            title: displayTitle(rec),
            recordedAt: iso(rec && rec.timestamp),
            durationMs: Number(rec && rec.durationMs) || 0
        },
        aiInstructions: String(instructions || '').trim(),
        context: recordingChain(rec).map((item, index) => ({
            index: index + 1,
            kind: contextKind(item),
            label: String(item.label || ''),
            sourceRecordingId: item.sourceRecId != null ? item.sourceRecId : null,
            sourceTimestamp: item.srcTimestamp || null,
            userInput: String(contextInput(item) || ''),
            aiReply: String(item.outputText || '')
        })),
        transcripts: transcripts.map(t => ({
            id: t.id,
            source: t.source || null,
            createdAt: iso(t.time),
            shown: !!shown && t.id === shown.id,
            text: transcriptWords(t),
            timestampedText: String(t.text || '')
        })),
        replies: replies.map(s => ({
            id: s.id,
            transcriptId: s.transcriptId,
            model: s.model || null,
            createdAt: iso(s.time),
            ended: s.end && s.end.state ? s.end.state : 'complete',
            contextShortened: !!s.condensed,
            text: s.text
        }))
    };
}

export function recordingExportName(rec) {
    return `${sanitizeFilename(displayTitle(rec))}.zip`;
}
