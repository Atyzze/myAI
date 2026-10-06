export const CLIPBOARD_CONTEXT_MAX_CHARS = 100000;

export function normalizeClipboardText(raw) {
    return String(raw == null ? '' : raw)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function buildClipboardContextItem(raw, stamp, maxChars = CLIPBOARD_CONTEXT_MAX_CHARS) {
    const text = normalizeClipboardText(raw);
    if (!text) return null;
    const limit = Math.max(1, Math.floor(Number(maxChars) || CLIPBOARD_CONTEXT_MAX_CHARS));
    const clipped = text.length > limit;
    const kept = clipped ? text.slice(0, limit) : text;
    const when = String(stamp || '').trim();
    return {
        inputText: kept,
        outputText: '',
        text: `[Pasted Note]: ${kept}\n`,
        label: clipped
            ? `Pasted${when ? ': ' + when : ''} (first ${limit.toLocaleString('en')} characters of ${text.length.toLocaleString('en')})`
            : `Pasted${when ? ': ' + when : ''}`,
        srcTimestamp: when,
        sourceRecId: null,
        pasted: true
    };
}

